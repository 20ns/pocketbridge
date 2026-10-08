package dev.pocketbridge

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class BackgroundAlertsTest {
    private fun status(id: String, status: String) = ChatStatus(id, "Chat $id", status)
    private fun kinds(events: List<AlertEvent>) = events.map { (when (it) { is NeedsAnswer -> "needs:"; is Ended -> "ended:"; is Answered -> "answered:" }) + it.chat.id }

    @Test fun `a scheduled prompt that ran and ended before the first look still finished`() {
        val scheduled = mapOf("a" to SCHEDULED)
        // Still waiting for its time, or cancelled: nothing proves a turn ran.
        assertTrue(alertEvents(scheduled, listOf(status("a", "idle")), "").isEmpty())
        assertEquals(listOf("ended:a"), kinds(alertEvents(scheduled, listOf(status("a", "idle")), "", delivered = setOf("a"))))
        assertEquals(listOf("ended:a"), kinds(alertEvents(scheduled, listOf(status("a", "error")), "", delivered = setOf("a"))))
        assertEquals(listOf("needs:a"), kinds(alertEvents(scheduled, listOf(status("a", "waiting")), "")))
        assertTrue(alertEvents(scheduled, listOf(status("a", "running")), "", delivered = setOf("a")).isEmpty())
        assertTrue(alertEvents(scheduled, listOf(status("a", "idle")), "a", delivered = setOf("a")).isEmpty())
    }

    @Test fun `a cached status can ask but never finish`() {
        val unknown = mapOf("a" to UNKNOWN)
        for (ended in listOf("idle", "error", "interrupted")) assertTrue(alertEvents(unknown, listOf(status("a", ended)), "", delivered = setOf("a")).isEmpty())
        assertEquals(listOf("needs:a"), kinds(alertEvents(unknown, listOf(status("a", "waiting")), "")))
        assertTrue(alertEvents(unknown, listOf(status("a", "running")), "").isEmpty())
        assertTrue(mayWork(UNKNOWN))
        assertFalse(mayWork("idle"))
    }

    @Test fun `scheduled marks never hide work already seen`() {
        val merged = withScheduled(mapOf("a" to "running", "b" to "idle", "d" to "waiting"), setOf("a", "b", "c", "d"))
        assertEquals(mapOf("a" to "running", "b" to SCHEDULED, "c" to SCHEDULED, "d" to "waiting"), merged)
    }

    @Test fun `baselines keep only work that may still end or ask, and survive a round trip`() {
        val statuses = mapOf("a" to "running", "b" to "idle", "c" to "waiting", "d" to "error", "e" to "stopping", "f" to "sending", "g" to UNKNOWN, "h" to "interrupted")
        val kept = watchedStatuses(statuses)
        assertEquals(setOf("a", "c", "e", "f", "g"), kept.keys)
        assertEquals(kept, decodeStatuses(encodeStatuses(kept)))
        assertTrue(decodeStatuses("").isEmpty())
        assertTrue(decodeStatuses("not json").isEmpty())
        val prompts = mapOf("a" to ScheduledPrompt("p1", 1_700_000_000_000), "b" to ScheduledPrompt("p2", 0))
        assertEquals(prompts, decodeScheduled(encodeScheduled(prompts)))
        assertTrue(decodeScheduled("").isEmpty())
        assertTrue(decodeScheduled("""{"a":"broken"}""").isEmpty())
    }

    @Test fun `the outage clock counts only time with a network`() {
        val minute = 60_000L
        val outage = OutageTimer(15 * minute)
        assertFalse(outage.failed(0, network = true))
        // Ten minutes in airplane mode don't count.
        assertFalse(outage.failed(10 * minute, network = false))
        assertFalse(outage.failed(20 * minute, network = true))
        assertFalse(outage.failed(25 * minute, network = true))
        assertTrue(outage.failed(26 * minute, network = true))
        // A stream that opened starts it over.
        outage.reset()
        assertFalse(outage.failed(100 * minute, network = true))
        assertFalse(outage.failed(110 * minute, network = true))
        assertTrue(outage.failed(116 * minute, network = true))
    }

    @Test fun `the catch-up job looks soon after a scheduled prompt goes, or later for unwatched work`() {
        val now = 1_000_000L
        val hour = 3_600_000L
        assertNull(catchUpDelay(now, emptyList(), unwatched = false))
        assertEquals(CATCH_UP_RETRY_MILLIS, catchUpDelay(now, emptyList(), unwatched = true))
        assertEquals(hour + SCHEDULED_LOOK_MILLIS, catchUpDelay(now, listOf(now + 2 * hour, now + hour), unwatched = false))
        assertEquals(CATCH_UP_RETRY_MILLIS, catchUpDelay(now, listOf(now + hour), unwatched = true))
        assertEquals(5 * 60_000L + SCHEDULED_LOOK_MILLIS, catchUpDelay(now, listOf(now + 5 * 60_000L), unwatched = true))
        // Overdue (a sleeping Mac): a minute from now, not a tight loop.
        assertEquals(SCHEDULED_LOOK_MILLIS, catchUpDelay(now, listOf(now - hour), unwatched = false))
    }

    @Test fun `chat rows name their scheduled prompt, and stream resets and pending requests are read`() {
        val state = JSONObject("""{"projects":[],"chats":[{"id":"a","status":"idle","scheduled":{"id":"p","notBefore":5}},{"id":"b","status":"running"}]}""")
        assertEquals(listOf("p", null), chatStatuses(state).map { it.scheduled })
        assertTrue(streamReset("""{"type":"state","seq":10001,"reset":true}"""))
        assertFalse(streamReset("""{"type":"state","seq":3}"""))
        assertFalse(streamReset("garbage"))
        val messages = JSONObject("""{"approvals":[{"id":"x","status":"pending"},{"id":"y","status":"allow"},{"id":"z","status":"pending"},{"id":"w","status":"deny"}]}""")
        assertEquals("z", pendingApproval(messages)?.optString("id"))
        assertNull(pendingApproval(JSONObject("""{"approvals":[{"id":"y","status":"allow"}]}""")))
        assertNull(pendingApproval(null))
    }
}
