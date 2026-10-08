package dev.pocketbridge

import java.time.ZoneId
import java.time.ZoneOffset
import java.util.Locale
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ScheduleTest {
    private val hour = 3_600_000L
    private val now = 1_791_000_000_000L
    private fun limit(id: String, percent: Int, resetsIn: Long) = UsageLimit(id, id, percent, now + resetsIn, "normal")

    @Test fun `a scheduled prompt keeps its schedule with the delivery id, and Retry sends it unchanged`() {
        val prompt = PendingPrompt("delivery", "finish the refactor", agent = CODEX, delivery = null, schedule = SCHEDULE_RESET)
        val json = prompt.json()
        assertEquals("reset", json.getString("schedule"))
        assertFalse(json.has("delivery"))
        assertEquals(prompt, PendingPrompt.parse(json.toString()))
        val timed = PendingPrompt("timed", "later", schedule = "1791000000000")
        assertEquals(1_791_000_000_000L, timed.json().getLong("schedule"))
        assertEquals(timed, PendingPrompt.parse(timed.json().toString()))
        // Prompts saved before scheduling existed, or with a value this app never writes, send now.
        assertNull(PendingPrompt.parse(JSONObject().put("id", "old").put("text", "hi").toString()).schedule)
        assertNull(PendingPrompt.parse(JSONObject().put("id", "odd").put("text", "hi").put("schedule", "tomorrow").toString()).schedule)
        assertFalse(PendingPrompt("plain", "now").json().has("schedule"))
    }

    @Test fun `the reset to wait for is the latest used-up limit, else the fullest, and a model's own limit counts only for it`() {
        val session = limit("session", 100, 3 * hour)
        val weekly = limit("weekly_all", 40, 72 * hour)
        assertEquals(ResetTime(session.resetsAt + RESET_MARGIN_MILLIS, true), resetTime(listOf(session, weekly), now))
        assertEquals(now + 72 * hour + RESET_MARGIN_MILLIS, resetTime(listOf(session, weekly.copy(percent = 100)), now)?.at)
        assertEquals(ResetTime(session.resetsAt + RESET_MARGIN_MILLIS, false), resetTime(listOf(session.copy(percent = 92), weekly), now))
        assertEquals(session.resetsAt + RESET_MARGIN_MILLIS, resetTime(listOf(session.copy(percent = 40), weekly), now)?.at)
        val fable = limit("weekly_scoped:Fable", 100, 100 * hour)
        assertEquals(false, resetTime(listOf(session.copy(percent = 10), fable), now, "Opus 5")?.reached)
        assertEquals(true, resetTime(listOf(session.copy(percent = 10), fable), now, "Fable 2")?.reached)
        assertNull(resetTime(listOf(session.copy(resetsAt = now - 1), weekly.copy(resetsAt = 0)), now))
        assertNull(resetTime(emptyList(), now))
    }

    @Test fun `Send becomes Send at reset once a limit is used up or the turn failed on its limit`() {
        val used = listOf(limit("session", 100, 3 * hour), limit("weekly_all", 40, 72 * hour))
        val fine = listOf(limit("session", 30, 3 * hour), limit("weekly_all", 40, 72 * hour))
        assertEquals(ScheduleOffer(now + 3 * hour + RESET_MARGIN_MILLIS, true), scheduleOffer(true, used, now, "Opus", "idle", null, false))
        // Known but not reached: offered on a long press only.
        assertEquals(false, scheduleOffer(true, fine, now, "Opus", "idle", null, false)?.prominent)
        assertEquals(true, scheduleOffer(true, fine, now, "Opus", "error", "Claude AI usage limit reached|1791010800", false)?.prominent)
        assertEquals(true, scheduleOffer(true, fine, now, "GPT", "error", "You've hit your usage limit. Try again at 2:00 AM.", false)?.prominent)
        assertEquals(false, scheduleOffer(true, fine, now, "Opus", "error", "Prompt is too long", false)?.prominent)
        assertEquals(false, scheduleOffer(true, fine, now, "Opus", "interrupted", "usage limit reached", false)?.prominent)
        // An older Mac, a chat already waiting, or no known reset: nothing to offer.
        assertNull(scheduleOffer(false, used, now, "Opus", "idle", null, false))
        assertNull(scheduleOffer(true, used, now, "Opus", "idle", null, true))
        assertNull(scheduleOffer(true, emptyList(), now, "Opus", "error", "usage limit reached", false))
    }

    @Test fun `scheduled prompts are read from chat rows and transcript metadata`() {
        val chat = JSONObject().put("id", "c").put("scheduled", JSONObject().put("id", "p").put("notBefore", now))
        assertEquals("p" to now, chatScheduled(chat))
        assertNull(chatScheduled(JSONObject().put("id", "c")))
        assertNull(chatScheduled(null))
        val transcript = JSONObject("""{"messages":[],"scheduled":[{"id":"p","notBefore":$now},{"id":"q","notBefore":${now + hour}}]}""")
        assertEquals(mapOf("p" to now, "q" to now + hour), scheduledPrompts(transcript))
        assertEquals(emptyMap<String, Long>(), scheduledPrompts(JSONObject("""{"messages":[]}""")))
        assertEquals(SCHEDULED, said(JSONObject().put("id", "p").put("role", "user").put("text", "later").put("kind", "scheduled")).kind)
    }

    @Test fun `cancel puts the text back only into an empty, unlocked composer`() {
        assertEquals("finish the refactor", draftAfterCancel("", emptyList(), false, false, "finish the refactor"))
        assertEquals("finish the refactor", draftAfterCancel("  ", emptyList(), false, false, "finish the refactor"))
        assertNull(draftAfterCancel("something new", emptyList(), false, false, "finish the refactor"))
        assertNull(draftAfterCancel("", emptyList(), false, true, "finish the refactor"))
        assertNull(draftAfterCancel("", emptyList(), false, false, ""))
        // A pasted block or an image is a draft too: the cancelled text would be sent along with it.
        assertNull(draftAfterCancel("", listOf(Paste("k", "a log")), false, false, "finish the refactor"))
        assertNull(draftAfterCancel("", emptyList(), true, false, "finish the refactor"))
    }

    @Test fun `background alerts never wait on a scheduled prompt`() {
        val now = PendingPrompt("a", "now")
        val later = PendingPrompt("b", "later", schedule = SCHEDULE_RESET)
        assertEquals(mapOf("chat-a" to now), watchedDeliveries(mapOf("chat-a" to now, "chat-b" to later)))
    }

    @Test fun `schedule times read as a clock today, a weekday this week, else a date`() {
        val zone: ZoneId = ZoneOffset.UTC
        val base = java.time.LocalDateTime.of(2026, 10, 8, 23, 0).toInstant(ZoneOffset.UTC).toEpochMilli()
        val tonight = base + 30 * 60_000
        val tomorrow = base + 3 * hour + 2 * 60_000
        // Newer JDKs put a narrow no-break space before AM and PM.
        fun label(at: Long) = scheduleLabel(at, base, zone, Locale.US).replace('\u202F', ' ')
        assertEquals("11:30 PM", label(tonight))
        assertEquals("Fri 2:02 AM", label(tomorrow))
        assertEquals("Oct 16, 11:00 PM", label(base + 8 * 24 * hour))
    }
}
