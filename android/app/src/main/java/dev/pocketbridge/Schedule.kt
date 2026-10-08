package dev.pocketbridge

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.format.TextStyle
import java.util.Locale
import org.json.JSONObject

/** A prompt the Mac sends by itself once the agent's plan limit resets. */
const val SCHEDULE_RESET = "reset"
/** The message kind of a prompt still waiting for its time. */
const val SCHEDULED = "scheduled"
/** The Mac runs a scheduled prompt this long after the reset its CLI reported. */
const val RESET_MARGIN_MILLIS = 2 * 60_000L

/** When a prompt scheduled for the reset would run, and whether a limit that applies is used up now. */
data class ResetTime(val at: Long, val reached: Boolean)

/**
 * The Mac's rule for "reset": the latest reset among used-up limits (each must reset first), otherwise the fullest
 * limit's reset, the sooner on a tie, plus the margin. A model's own weekly limit ("weekly_scoped:Fable") counts only
 * for that model. Null when no future reset is known. The Mac's answer is what the transcript shows.
 */
fun resetTime(limits: List<UsageLimit>, now: Long, modelName: String = ""): ResetTime? {
    fun applies(limit: UsageLimit): Boolean {
        val scope = limit.id.substringAfter(':', "").trim().lowercase()
        return scope.isEmpty() || scope in modelName.lowercase()
    }
    val known = limits.filter { applies(it) && it.resetsAt > now }
    val used = known.filter { it.percent >= 100 }
    val pick = used.maxByOrNull { it.resetsAt } ?: known.minWithOrNull(compareByDescending<UsageLimit> { it.percent }.thenBy { it.resetsAt }) ?: return null
    return ResetTime(pick.resetsAt + RESET_MARGIN_MILLIS, used.isNotEmpty())
}

/** The CLI's own words when a turn stopped on a plan limit. */
fun limitError(text: String?) = text != null && Regex("usage limit|rate limit|limit reached|hit your [\\w\\s-]*limit|limit will reset", RegexOption.IGNORE_CASE).containsMatchIn(text)

/** "Send at <time>" in the composer: [prominent] when the agent is at its limit, so Send itself becomes it. */
data class ScheduleOffer(val at: Long, val prominent: Boolean)

/**
 * Whether to offer sending at the reset. Needs a Mac that schedules, a known reset, and a chat that isn't already
 * waiting for one. Prominent when a limit is used up, or when the chat's last turn failed on its limit.
 */
fun scheduleOffer(canSchedule: Boolean, limits: List<UsageLimit>, now: Long, modelName: String, status: String?, error: String?, alreadyScheduled: Boolean): ScheduleOffer? {
    if (!canSchedule || alreadyScheduled) return null
    val reset = resetTime(limits, now, modelName) ?: return null
    return ScheduleOffer(reset.at, reset.reached || (status == "error" && limitError(error)))
}

/**
 * What the composer holds after cancelling a scheduled prompt: its text when the box is free, so cancel is also edit.
 * Free means no typed text, pasted blocks or images, so the text never joins an unrelated draft.
 */
fun draftAfterCancel(current: String, pastes: List<Paste>, attached: Boolean, pending: Boolean, cancelled: String): String? =
    cancelled.takeIf { !pending && current.isBlank() && pastes.isEmpty() && !attached && it.isNotBlank() }

/** Unconfirmed prompts background alerts should wait for: a scheduled one starts no turn now, so it has nothing to report. */
fun watchedDeliveries(pending: Map<String, PendingPrompt>) = pending.filterValues { it.schedule == null }

/** The prompt a chat is waiting to send, from the Mac's chat row: its id to when it goes. */
fun chatScheduled(chat: JSONObject?): Pair<String, Long>? = chat?.optJSONObject("scheduled")?.let { scheduled ->
    scheduled.textOrNull("id")?.let { id -> id to scheduled.optLong("notBefore") }
}

/** Prompts waiting for their time, from a transcript's metadata: id to when each goes. */
fun scheduledPrompts(transcript: JSONObject?): Map<String, Long> = transcript?.optJSONArray("scheduled")?.objects().orEmpty()
    .mapNotNull { item -> item.textOrNull("id")?.let { it to item.optLong("notBefore") } }.toMap()

/** "2:02 AM" today, "Thu 2:02 AM" within the week, "Oct 12, 2:02 AM" further out. */
fun scheduleLabel(at: Long, now: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
    val time = Instant.ofEpochMilli(at).atZone(zone)
    val clock = time.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale))
    val days = java.time.temporal.ChronoUnit.DAYS.between(Instant.ofEpochMilli(now).atZone(zone).toLocalDate(), time.toLocalDate())
    return when {
        days == 0L -> clock
        days in 1..5 -> time.dayOfWeek.getDisplayName(TextStyle.SHORT, locale) + " " + clock
        else -> time.month.getDisplayName(TextStyle.SHORT, locale) + " " + time.dayOfMonth + ", " + clock
    }
}

/** Under a scheduled prompt: when it goes, then Send now and Cancel. */
@Composable fun ScheduledFooter(at: Long?, enabled: Boolean, onSendNow: () -> Unit, onCancel: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(PocketIcons.Schedule, null, Modifier.size(Sizes.tinyIcon), tint = colors.primary)
        Spacer(Modifier.width(Spacing.xs))
        Text(at?.let { "Sends at " + scheduleLabel(it, System.currentTimeMillis()) } ?: "Scheduled", style = MaterialTheme.typography.labelMedium, color = colors.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        TextButton(onClick = onSendNow, enabled = enabled) { Text("Send now") }
        TextButton(onClick = onCancel, enabled = enabled) { Text("Cancel") }
    }
}

/** A chat row's supporting line while its prompt waits: "Scheduled · 2:02 AM". */
@Composable fun ScheduledLine(at: Long, now: Long) {
    val tint = MaterialTheme.colorScheme.primary
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(PocketIcons.Schedule, null, Modifier.size(Sizes.tinyIcon), tint = tint)
        Spacer(Modifier.width(Spacing.xs + Spacing.xxs))
        Text("Scheduled · " + scheduleLabel(at, now), color = tint, maxLines = 1, style = MaterialTheme.typography.labelLarge)
    }
}
