package dev.pocketbridge

import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.Callback
import okhttp3.Response
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject

class ApiError(val status: Int, message: String) : IOException(message) {
    val definitiveRejection get() = status in 400..499 && status != 408
}

fun normalizeServer(input: String): String {
    val uri = URI(input.trim())
    require(uri.scheme in listOf("https", "http") && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.rawQuery == null && uri.fragment == null) { "Enter a complete HTTP or HTTPS Mac address." }
    require(uri.path.isNullOrEmpty() || uri.path == "/") { "Use the Mac address without a path." }
    // Plain HTTP is for local development or the encrypted Tailscale network only.
    require(uri.scheme == "https" || uri.host == "localhost" || uri.host == "10.0.2.2" || isLoopbackIp(uri.host) || uri.host.endsWith(".ts.net") || isTailnetIp(uri.host)) { "Use HTTPS, or a private Tailscale address." }
    return input.trim().trimEnd('/')
}
private fun isLoopbackIp(host: String): Boolean {
    val parts = host.split('.').map { it.toIntOrNull() ?: return false }
    return parts.size == 4 && parts[0] == 127 && parts.all { it in 0..255 }
}
private fun isTailnetIp(host: String): Boolean {
    val parts = host.split('.').map { it.toIntOrNull() ?: return false }
    return parts.size == 4 && parts[0] == 100 && parts[1] in 64..127 && parts.all { it in 0..255 }
}

class Api(val base: String, val token: String = "") {
    private val readClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(true).callTimeout(30, TimeUnit.SECONDS).connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build()
    // Mutations use fresh connections so expired server keepalives cannot lose an action.
    private val client = readClient.newBuilder().retryOnConnectionFailure(false).connectionPool(ConnectionPool(0, 5, TimeUnit.MINUTES)).build()
    private val streamClient = readClient.newBuilder().callTimeout(0, TimeUnit.SECONDS).readTimeout(45, TimeUnit.SECONDS).build()
    suspend fun request(path: String, body: JSONObject? = null): JSONObject {
        val request = Request.Builder().url(base + path).header("Authorization", "Bearer $token")
        if (body != null) {
            val payload = body.toString().toRequestBody("application/json".toMediaType())
            // OkHttp may replay Retry-After responses even with connection retries disabled.
            request.post(object : RequestBody() {
                override fun contentType() = payload.contentType()
                override fun contentLength() = payload.contentLength()
                override fun writeTo(sink: BufferedSink) = payload.writeTo(sink)
                override fun isOneShot() = true
            })
        }
        // Only reads may transparently recover a stale pooled connection.
        return (if (body == null) readClient else client).newCall(request.build()).consume { response ->
            val text = response.body?.string().orEmpty()
            val result = runCatching { JSONObject(text) }.getOrNull()
            if (!response.isSuccessful) throw ApiError(response.code, result?.optString("error")?.takeIf { it.isNotBlank() } ?: "The Mac rejected the request (${response.code}).")
            result ?: throw IOException("The Mac returned an unreadable response.")
        }
    }
    suspend fun watch(after: Long, onLine: (String) -> Unit) = events(after).consume { response ->
        if (!response.isSuccessful) throw ApiError(response.code, "Cannot stream changes (${response.code}).")
        val source = response.body?.source() ?: throw IOException("The Mac returned an empty stream.")
        while (!source.exhausted()) onLine(source.readUtf8Line() ?: break)
    }
    fun events(after: Long) = streamClient.newCall(Request.Builder().url("$base/api/events?after=$after").header("Authorization", "Bearer $token").header("Accept", "text/event-stream").build())
}

/** Cancellation closes both ordinary requests and the long-lived SSE response. */
internal suspend fun <T> Call.consume(block: (Response) -> T): T = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) { continuation.resumeWith(Result.failure(e)) }
        override fun onResponse(call: Call, response: Response) {
            continuation.resumeWith(runCatching { response.use(block) })
        }
    })
}

data class PendingPrompt(
    val id: String,
    val text: String,
    val mode: String = "bypassPermissions",
    val model: String = "default",
    val effort: String = "default",
    val projectId: String = "",
) {
    fun json() = JSONObject().put("id", id).put("text", text).put("mode", mode).put("model", model).put("effort", effort).apply { if (projectId.isNotBlank()) put("projectId", projectId) }
    companion object {
        fun parse(value: String) = JSONObject(value).let {
            PendingPrompt(
                it.getString("id"),
                it.getString("text"),
                it.optString("mode", "bypassPermissions"),
                it.optString("model", "default"),
                it.optString("effort", "default"),
                it.optString("projectId"),
            )
        }
    }
}

/** SSE IDs are only committed after the snapshot has been successfully reconciled. */
class EventCursor(var committed: Long = 0) {
    var observed: Long = committed
        private set
    fun observe(line: String) { if (line.startsWith("id:")) line.drop(3).trim().toLongOrNull()?.let { observed = maxOf(observed, it) } }
    fun commit(snapshotSequence: Long) { committed = maxOf(committed, snapshotSequence) }
}
