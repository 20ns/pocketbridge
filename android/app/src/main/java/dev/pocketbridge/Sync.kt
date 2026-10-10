package dev.pocketbridge

import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import org.json.JSONArray
import org.json.JSONObject

fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }

data class DraftChat(
    val id: String, val projectId: String, val mode: String, val model: String = "default", val effort: String = "default", val createdAt: Long = 0,
    val agent: String = CLAUDE, val speed: String? = null,
) {
    val options get() = ChatOptions(mode, model, effort, agent, speed)
    fun json() = JSONObject().put("id", id).put("projectId", projectId).put("agent", agent).put("mode", mode).put("model", model).put("effort", effort)
        .put("speed", speed ?: JSONObject.NULL).put("title", "New chat").put("status", "idle").put("updatedAt", createdAt)
    fun store() = JSONObject().put("projectId", projectId).put("agent", agent).put("mode", mode).put("model", model).put("effort", effort)
        .put("speed", speed ?: JSONObject.NULL).put("createdAt", createdAt).toString()
    companion object {
        fun parse(id: String, value: String) = JSONObject(value).let {
            DraftChat(id, it.getString("projectId"), it.optString("mode", "bypassPermissions"), it.optString("model", "default"), it.optString("effort", "default"), it.optLong("createdAt"), it.optString("agent", CLAUDE), it.textOrNull("speed"))
        }
        fun of(id: String, projectId: String, options: ChatOptions, createdAt: Long) = DraftChat(id, projectId, options.mode, options.model, options.effort, createdAt, options.agent, options.speed)
    }
}

/** The options a saved chat runs with, as the Mac reports them. */
fun chatOptions(chat: JSONObject) = ChatOptions(
    chat.optString("mode", "bypassPermissions"), chat.optString("model", "default"), chat.optString("effort", "default"), chat.optString("agent").ifBlank { CLAUDE }, chat.textOrNull("speed"),
)

/** A local chat row. Blank and unsent drafts stay out of the list; a saved delivery id or a picked image stays in. */
data class ListedDraft(val id: String, val projectId: String, val text: String, val pending: Boolean, val updatedAt: Long = 0, val agent: String = CLAUDE, val images: Int = 0)

fun listedDrafts(drafts: List<ListedDraft>) = drafts.mapNotNull { draft ->
    if (draft.text.isBlank() && !draft.pending && draft.images == 0) null
    else JSONObject().put("id", draft.id).put("projectId", draft.projectId).put("agent", draft.agent).put("title", draft.text.trim().take(80).ifBlank { "New chat" }).put("local", true)
        .put("status", if (draft.pending) "unconfirmed" else "draft").put("updatedAt", draft.updatedAt)
}

/** Server rows stay in their reconciled order. A local id already on the server is not listed twice. */
fun projectChats(server: List<JSONObject>, projectId: String, locals: List<JSONObject>): List<JSONObject> {
    val known = server.map { it.optString("id") }.toSet()
    return server.filter { it.optString("projectId") == projectId } + locals.filter { it.optString("projectId") == projectId && it.optString("id") !in known }
}

/** The Mac saved this prompt under its delivery id: its POST answer may be lost, but it was accepted. */
fun deliveredPrompt(messages: List<JSONObject>, promptId: String) = messages.any { it.optString("role") == "user" && it.optString("id") == promptId }

/** A delta replaces rows in place; late tool results keep their original insertion order. Missing flags mean an older Mac's full response. */
fun mergeTranscript(previous: JSONObject?, response: JSONObject): JSONObject {
    if (response.optBoolean("full", true)) return response
    require(previous != null) { "Transcript delta has no starting snapshot" }
    val rows = previous.getJSONArray("messages").objects().associateByTo(linkedMapOf()) { it.getString("id") }
    response.getJSONArray("messages").objects().forEach { rows[it.getString("id")] = it }
    return response.put("messages", JSONArray(rows.values.toList())).put("full", true)
}

/**
 * Whether a state snapshot shows the open chat is gone. A snapshot asked for ([generation]) before the chat's first
 * prompt was accepted ([acceptedAt]) predates it, so it can't say the chat was deleted.
 */
fun chatGone(listed: Boolean, local: Boolean, generation: Long, acceptedAt: Long?) = !listed && !local && generation > (acceptedAt ?: 0)

/** The Mac no longer has an image a prompt named. Its local copy can be uploaded again. */
fun lostUpload(failure: ApiError) = failure.status == 400 && failure.message == "Attachment not found"

const val SYNC_STATE = 1
const val SYNC_MESSAGES = 2

/** What an SSE change needs refetched. Streaming text for another chat needs nothing until its state changes. */
fun syncKind(data: String, selected: String): Int {
    val event = runCatching { JSONObject(data) }.getOrNull() ?: return SYNC_STATE or SYNC_MESSAGES
    if (event.optBoolean("reset")) return SYNC_STATE or SYNC_MESSAGES
    val mine = selected.isNotEmpty() && event.optString("chatId") == selected
    return when (event.optString("type")) {
        "message" -> if (mine) SYNC_MESSAGES else 0
        else -> SYNC_STATE or if (mine) SYNC_MESSAGES else 0
    }
}

/** One sentence for a failed request, naming what to check. */
fun failureReason(failure: Throwable) = when (failure) {
    is ApiError -> failure.message?.takeIf { it.isNotBlank() } ?: "Your Mac rejected the request."
    // Only a failed handshake is about the certificate; other TLS errors are a connection dropping mid-read.
    is javax.net.ssl.SSLHandshakeException, is javax.net.ssl.SSLPeerUnverifiedException -> "Secure connection could not be verified. Check your Mac's HTTPS address and certificate."
    is SocketTimeoutException -> if (failure.message.orEmpty().contains("connect", ignoreCase = true)) "Can't reach your Mac. It may be asleep, or Tailscale is off on it."
        else "Your Mac took too long to answer. Check that it's awake and online."
    is UnknownHostException, is ConnectException, is NoRouteToHostException -> "Can't reach your Mac. Check that it's awake and Tailscale is on."
    is java.io.IOException -> "The connection to your Mac was interrupted. Check that it's awake and online."
    else -> failure.message?.takeIf { it.isNotBlank() } ?: "Something went wrong. Try again."
}

const val NO_NETWORK = "This phone has no internet connection."
const val REVOKED = "This phone's pairing was removed on the Mac. Disconnect, then pair again."

/**
 * What the connection banner says after [failures] failed attempts in a row over [failingFor] ms; blank keeps it to a
 * quiet Reconnecting. A drop is usually a blip (a network handover, the Mac service restarting in a second or two), so
 * only a repeat that has lasted a few seconds names a cause.
 */
fun connectionIssue(failure: Throwable, failures: Int, failingFor: Long, network: Boolean) = when {
    failure is ApiError && failure.status == 401 -> REVOKED
    !network -> NO_NETWORK
    failures < 2 || failingFor < QUIET_MILLIS -> ""
    else -> failureReason(failure)
}
const val QUIET_MILLIS = 3000L

const val RESEND_WINDOW_MILLIS = 10 * 60_000L

/**
 * Whether a saved prompt the Mac never recorded goes again by itself after a reconnect, under its same id (the Mac
 * runs an id at most once). [watchUntil] is its saved delivery watch, two minutes past the save. Only a normal turn
 * (scheduled or not) goes: a late steer could land in a different turn and an interrupt would cut into whatever runs
 * by then, and an older prompt may no longer be wanted. Those wait for Retry.
 */
fun resendable(prompt: PendingPrompt, watchUntil: Long?, now: Long) =
    prompt.delivery == null && watchUntil != null && now - (watchUntil - DELIVERY_WATCH_MILLIS) in 0..RESEND_WINDOW_MILLIS

/**
 * Chats deleted on this phone whose deletion hasn't reached the Mac yet, id to title. Saved before a chat is hidden,
 * so a chat said to be deleted never comes back after a restart: leftovers are sent at the next connection.
 */
fun encodeDeletions(deletions: Map<String, String>): String = JSONObject().apply { deletions.forEach { (id, title) -> put(id, title) } }.toString()
fun decodeDeletions(value: String): Map<String, String> = if (value.isBlank()) emptyMap() else runCatching {
    JSONObject(value).let { json -> json.keys().asSequence().associateWith { json.optString(it) } }
}.getOrDefault(emptyMap())

/** Whether a failed deletion is settled for good (the Mac refused it), rather than worth sending again later. */
fun deletionSettled(failure: Throwable) = failure is ApiError && failure.definitiveRejection && failure.status != 429

/** A pairing attempt as saved before its POST: the Mac and code it was for, and its id. */
fun pairAttemptValue(base: String, code: String, attempt: String) = "$base $code|$attempt"
/** The saved attempt's id when it was for this Mac and code, so a retry reuses it; null otherwise. */
fun pairAttemptId(saved: String, base: String, code: String): String? =
    saved.substringAfterLast('|', "").takeIf { it.isNotBlank() && saved.substringBeforeLast('|') == "$base $code" }
