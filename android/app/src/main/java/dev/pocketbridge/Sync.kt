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
    val mine = selected.isNotEmpty() && event.optString("chatId") == selected
    return when (event.optString("type")) {
        "message" -> if (mine) SYNC_MESSAGES else 0
        else -> SYNC_STATE or if (mine) SYNC_MESSAGES else 0
    }
}

/** One sentence for a failed request, naming what to check. */
fun failureReason(failure: Throwable) = when (failure) {
    is ApiError -> failure.message?.takeIf { it.isNotBlank() } ?: "Your Mac rejected the request."
    is SocketTimeoutException -> "Your Mac took too long to answer. Check Tailscale on both devices."
    is UnknownHostException, is ConnectException, is NoRouteToHostException -> "Can't reach your Mac. Check that Tailscale is on and the Mac is awake."
    is java.io.IOException -> "The connection to your Mac was interrupted. Check Tailscale on both devices."
    else -> failure.message?.takeIf { it.isNotBlank() } ?: "Something went wrong. Try again."
}
