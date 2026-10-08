package dev.pocketbridge

import org.json.JSONArray
import org.json.JSONObject

/**
 * What the ongoing notification shows while the alerts service watches. One chat gets all of it: title, folder, the
 * step it's on and a timer from its turn's start, with Stop while it runs. Several share it, counted, a line each.
 * [promoted] asks Android 16 for a Live Update: only running work earns one, since a question has its own alert.
 */
data class LiveNotice(
    val title: String, val text: String, val folder: String = "", val chatId: String? = null, val since: Long? = null,
    val lines: List<String> = emptyList(), val chip: String? = null, val stoppable: Boolean = false, val promoted: Boolean = false,
)

/** Running, stopping, or a prompt still on its way ("sending"): work the owner started and is waiting on. */
private fun underway(status: String) = status == "running" || status == "stopping" || status == "sending"

/** The step line as the conversation's working line reads it: the agent's own summary, else the tool running now. */
fun stepLine(chat: ChatStatus, step: String?) = when {
    chat.status == "stopping" -> "Stopping"
    chat.status == "sending" -> "Sending"
    chat.status == "waiting" -> "Waiting for your answer"
    chat.activity.isNotBlank() -> firstLine(chat.activity, 160)
    !step.isNullOrBlank() -> step
    else -> "Working"
}

/** [started] holds each running chat's turn start, [steps] the tool step each is on, when known. */
fun liveNotice(active: List<ChatStatus>, started: Map<String, Long>, steps: Map<String, String>): LiveNotice {
    val single = active.singleOrNull()
    return when {
        single != null -> LiveNotice(
            single.title, stepLine(single, steps[single.id]), single.project, single.id, started[single.id],
            stoppable = single.status == "running", promoted = underway(single.status),
        )
        active.isNotEmpty() -> LiveNotice(
            "${plural(active.size, "chat")} active", active.joinToString(" · ") { it.title },
            lines = active.map { "${it.title}: ${stepLine(it, steps[it.id])}" },
            chip = plural(active.size, "chat"), promoted = active.any { underway(it.status) },
        )
        else -> LiveNotice("PocketBridge", "Checking your Mac")
    }
}

/** At most one look at running chats' new steps per this long, whatever the number of hints. */
const val STEP_LOOK_MILLIS = 10_000L
private const val STEP_TAIL = 60

/** How long the next step look waits: not at all once [interval] has passed since the last, else the rest of it. */
fun stepLookDelay(lastLook: Long, now: Long, interval: Long = STEP_LOOK_MILLIS) = (lastLook + interval - now).coerceIn(0, interval)

/** The chat a status-stream line says has a new tool step or notice. */
fun stepChat(data: String): String? = runCatching { JSONObject(data) }.getOrNull()?.takeIf { it.optString("type") == "step" }?.optString("chatId")?.ifBlank { null }

/**
 * A running chat's newest messages with what [response] adds, and the cursor for the next look. Only the last few
 * are kept: enough to find the step running now without holding a long transcript in the background.
 */
fun stepTail(previous: JSONObject?, response: JSONObject, keep: Int = STEP_TAIL): JSONObject {
    val merged = mergeTranscript(previous, response)
    return JSONObject().put("messages", JSONArray(merged.getJSONArray("messages").objects().takeLast(keep))).put("cursor", merged.optString("cursor"))
}

/** "Bash ./gradlew test": the tool call still running at the end of [tail], as the conversation shows it. */
fun runningStep(tail: JSONObject): String? =
    liveStep(transcript(tail.optJSONArray("messages")?.objects().orEmpty().map(::said)))?.let { "${it.tool} ${it.summary}".trim() }

/** Why Stop from the notification didn't take: the Mac's refusal, else that it couldn't be reached. */
fun notStopped(failure: Exception) = "Not stopped. " + if (failure is ApiError) failureReason(failure) else "Couldn't reach your Mac."

/** Whether [state] shows a Stop sent from the notification took hold, or nothing is left to stop. False when unknown. */
fun stopSettled(state: JSONObject?, chatId: String): Boolean {
    val chats = state?.optJSONArray("chats")?.objects() ?: return false
    return chats.find { it.optString("id") == chatId }?.optString("status") !in listOf("running", "waiting")
}
