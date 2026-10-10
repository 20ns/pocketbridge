package dev.pocketbridge

import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.Dispatcher
import okhttp3.Callback
import okhttp3.Response
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONArray
import org.json.JSONObject

/** [fromMac]: the PocketBridge service wrote the error itself, so its handling of the request is over (a proxy's bare 502 says nothing of that). */
class ApiError(val status: Int, message: String, val fromMac: Boolean = false) : IOException(message) {
    val definitiveRejection get() = status in 400..499 && status != 408
}

/** The error a non-2xx answer carries: the Mac's own words, or what a bare proxy status means. */
internal fun rejection(status: Int, error: String?, fallback: String) = ApiError(status, error?.takeIf { it.isNotBlank() } ?: when (status) {
    // Tailscale answers for the Mac when the service behind it is down or restarting.
    502, 503, 504 -> "Your Mac is reachable, but Felva isn't answering on it. It restarts on its own; check the Mac if this lasts."
    else -> fallback
}, fromMac = !error.isNullOrBlank())

fun normalizeServer(input: String, allowLocalHttp: Boolean = BuildConfig.DEBUG): String {
    val uri = URI(input.trim())
    val scheme = uri.scheme?.lowercase()
    val host = uri.host?.lowercase()
    require(scheme in listOf("https", "http") && !host.isNullOrBlank() && uri.userInfo == null && uri.rawQuery == null && uri.fragment == null) { "Enter a complete HTTPS Mac address." }
    require(uri.path.isNullOrEmpty() || uri.path == "/") { "Use the Mac address without a path." }
    // Only debug builds can reach a local development server without TLS.
    require(scheme == "https" || allowLocalHttp && (host == "localhost" || host == "10.0.2.2" || isLoopbackIp(host))) { "Use the Mac's HTTPS address. HTTP connections are not allowed." }
    return input.trim().trimEnd('/')
}
private fun isLoopbackIp(host: String): Boolean {
    val parts = host.split('.').map { it.toIntOrNull() ?: return false }
    return parts.size == 4 && parts[0] == 127 && parts.all { it in 0..255 }
}
class Api(base: String, val token: String = "") {
    val base = normalizeServer(base)
    // HTTP/2 pings (Tailscale speaks it) find a dead pooled connection before a request waits out its timeout.
    private val readClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(true).callTimeout(30, TimeUnit.SECONDS).connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).pingInterval(15, TimeUnit.SECONDS).build()
    // Mutations use fresh connections so expired server keepalives cannot lose an action.
    private val client = readClient.newBuilder().retryOnConnectionFailure(false).connectionPool(ConnectionPool(0, 5, TimeUnit.MINUTES)).build()
    // Stop and answers must not queue behind the stream, slow reads, sends or screenshot uploads.
    private val controlClient = client.newBuilder().dispatcher(Dispatcher()).build()
    private val controlReadClient = readClient.newBuilder().dispatcher(controlClient.dispatcher).build()
    // The Mac sends a keepalive every 15 seconds: two missed ones mean the stream is dead (a network handover, a sleeping Mac).
    private val streamClient = readClient.newBuilder().callTimeout(0, TimeUnit.SECONDS).readTimeout(35, TimeUnit.SECONDS).build()
    /** Drops pooled connections after a network change: they belong to the old network and would only time out. */
    fun evictConnections() { readClient.connectionPool.evictAll() }
    suspend fun request(path: String, body: JSONObject? = null, control: Boolean = false): JSONObject {
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
        val urgent = control || body != null && (path.startsWith("/api/approvals/") || path.endsWith("/stop"))
        val transport = if (body == null) { if (urgent) controlReadClient else readClient } else if (urgent) controlClient else client
        return transport.newCall(request.build()).consume { response ->
            val text = response.body?.string().orEmpty()
            val result = runCatching { JSONObject(text) }.getOrNull()
            if (!response.isSuccessful) throw rejection(response.code, result?.optString("error"), "The Mac rejected the request (${response.code}).")
            result ?: throw IOException("The Mac returned an unreadable response.")
        }
    }
    /** A lost Stop answer is settled by the Mac's state, without repeating the mutation. */
    suspend fun stopChat(chatId: String) {
        try { request("/api/chats/$chatId/stop", JSONObject()) }
        catch (failure: IOException) {
            if (failure is ApiError && failure.definitiveRejection) throw failure
            val state = kotlinx.coroutines.withTimeoutOrNull(5000) { orNull { request("/api/state", control = true) } }
            if (!stopSettled(state, chatId)) throw failure
        }
    }
    /** One image as raw bytes. Single attempt like every mutation; an unowned upload left behind is harmless. */
    suspend fun upload(bytes: ByteArray, type: String): JSONObject {
        val request = Request.Builder().url("$base/api/uploads").header("Authorization", "Bearer $token").post(bytes.toRequestBody(type.toMediaType())).build()
        return client.newCall(request).consume { response ->
            val result = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrNull()
            if (!response.isSuccessful) throw rejection(response.code, result?.optString("error"), "The Mac rejected the image (${response.code}).")
            result?.takeIf { it.optString("id").isNotBlank() } ?: throw IOException("The Mac returned an unreadable response.")
        }
    }
    /** Raw bytes of a GET, refused past [limit] so a wrong answer can't fill memory. */
    suspend fun bytes(path: String, limit: Long = 12L * 1024 * 1024): ByteArray = readClient.newCall(Request.Builder().url(base + path).header("Authorization", "Bearer $token").build()).consume { response ->
        if (!response.isSuccessful) throw ApiError(response.code, "The Mac couldn't send that image (${response.code}).")
        val body = response.body ?: throw IOException("The Mac returned an empty image.")
        if (body.contentLength() > limit) throw IOException("The image is too large.")
        val source = body.source()
        if (source.request(limit + 1)) throw IOException("The image is too large.")
        source.buffer.readByteArray()
    }
    /** Streams change hints until the stream ends. [onOpen] runs once the Mac has accepted the stream. */
    suspend fun watch(after: Long, scope: String = "", onOpen: () -> Unit = {}, onLine: (String) -> Unit) = events(after, scope).consume { response ->
        if (!response.isSuccessful) throw rejection(response.code, null, "Cannot stream changes (${response.code}).")
        val source = response.body?.source() ?: throw IOException("The Mac returned an empty stream.")
        onOpen()
        while (!source.exhausted()) onLine(source.readUtf8Line() ?: break)
    }
    /** [scope] "status" leaves streaming text out, for the background alerts connection. */
    fun events(after: Long, scope: String = "") = streamClient.newCall(Request.Builder().url("$base/api/events?after=$after" + if (scope.isEmpty()) "" else "&scope=$scope").header("Authorization", "Bearer $token").header("Accept", "text/event-stream").build())
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
    val agent: String = CLAUDE,
    /** Upload ids, recorded with the delivery id so Retry sends exactly these images again. */
    val attachments: List<String> = emptyList(),
    /** "steer" or "interrupt" when written while a turn ran; null starts a turn. Retry keeps it. */
    val delivery: String? = null,
    /** A speed id from the model's catalog, or null for standard. Always sent, so a retry can't pick up the chat's later choice. */
    val speed: String? = null,
    /** "reset" or an epoch time in ms: the Mac keeps it and sends it then. Part of the delivery, so Retry keeps it. */
    val schedule: String? = null,
) {
    val options get() = ChatOptions(mode, model, effort, agent, speed)
    fun json() = JSONObject().put("id", id).put("text", text).put("agent", agent).put("mode", mode).put("model", model).put("effort", effort).put("speed", speed ?: JSONObject.NULL).apply {
        if (projectId.isNotBlank()) put("projectId", projectId)
        if (attachments.isNotEmpty()) put("attachments", JSONArray(attachments))
        if (delivery != null) put("delivery", delivery)
        if (schedule != null) put("schedule", schedule.toLongOrNull() ?: schedule)
    }
    companion object {
        fun parse(value: String) = JSONObject(value).let {
            PendingPrompt(
                it.getString("id"),
                it.getString("text"),
                it.optString("mode", "bypassPermissions"),
                it.optString("model", "default"),
                it.optString("effort", "default"),
                it.optString("projectId"),
                it.optString("agent", CLAUDE),
                it.optJSONArray("attachments").strings(),
                it.optString("delivery").takeIf { delivery -> delivery == STEER || delivery == INTERRUPT },
                it.textOrNull("speed"),
                when (val schedule = it.opt("schedule")) { SCHEDULE_RESET -> SCHEDULE_RESET; is Number -> schedule.toLong().toString(); else -> null },
            )
        }
    }
}

const val STEER = "steer"
const val INTERRUPT = "interrupt"
