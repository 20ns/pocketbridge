package dev.pocketbridge

import java.io.IOException
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LiveUpdateTest {
    private fun chat(id: String, status: String, activity: String = "") = ChatStatus(id, "Chat $id", status, activity = activity, project = "site")

    @Test fun `one running chat gets the whole live notification with its folder, timer, step and Stop`() {
        val notice = liveNotice(listOf(chat("a", "running")), mapOf("a" to 1000L), mapOf("a" to "Bash ./gradlew test"))
        assertEquals(LiveNotice("Chat a", "Bash ./gradlew test", "site", "a", 1000L, stoppable = true, promoted = true), notice)
        // The chip shows the timer: no short text competes with it.
        assertNull(notice.chip)
        assertEquals("General", chatStatuses(JSONObject("""{"projects":[{"id":"g","name":"General","general":true}],"chats":[{"id":"c","projectId":"g","status":"running"}]}""")).single().project)
    }

    @Test fun `a failed step lookup is skipped, but a cancelled one ends before it can post again`() = runBlocking {
        assertNull(orNull<String> { throw IOException("offline") })
        var posted = false
        val look = launch { orNull { delay(10_000) }; posted = true }
        yield(); look.cancelAndJoin()
        assertFalse(posted)
    }

    @Test fun `the step line prefers the agent's own summary, then the tool running now`() {
        assertEquals("Reading the alert service", stepLine(chat("a", "running", "Reading the alert service\nmore"), "Read Alerts.kt"))
        assertEquals("Read Alerts.kt", stepLine(chat("a", "running"), "Read Alerts.kt"))
        assertEquals("Working", stepLine(chat("a", "running"), null))
        assertEquals("Stopping", stepLine(chat("a", "stopping", "Reading"), "Read Alerts.kt"))
        assertEquals("Waiting for your answer", stepLine(chat("a", "waiting"), null))
        assertEquals("Sending", stepLine(chat("a", "sending"), null))
    }

    @Test fun `only running work is promoted and only a running chat offers Stop`() {
        // A question has its own alert; the ongoing notification stays plain and keeps no timer.
        val waiting = liveNotice(listOf(chat("a", "waiting")), emptyMap(), emptyMap())
        assertFalse(waiting.promoted); assertFalse(waiting.stoppable); assertNull(waiting.since)
        val stopping = liveNotice(listOf(chat("a", "stopping")), mapOf("a" to 5L), emptyMap())
        assertTrue(stopping.promoted); assertFalse(stopping.stoppable)
        // A prompt still on its way has nothing on the Mac to stop yet.
        val sending = liveNotice(listOf(chat("a", "sending")), emptyMap(), emptyMap())
        assertTrue(sending.promoted); assertFalse(sending.stoppable)
        assertEquals(LiveNotice("Felva", "Checking your Mac"), liveNotice(emptyList(), emptyMap(), emptyMap()))
    }

    @Test fun `several chats share one notification, counted, with a line each and no single Stop`() {
        val notice = liveNotice(listOf(chat("a", "running"), chat("b", "waiting")), mapOf("a" to 1L), mapOf("a" to "Edit Api.kt"))
        assertEquals("2 chats active", notice.title)
        assertEquals("Chat a · Chat b", notice.text)
        assertEquals(listOf("Chat a: Edit Api.kt", "Chat b: Waiting for your answer"), notice.lines)
        assertEquals("2 chats", notice.chip)
        assertNull(notice.chatId); assertNull(notice.since); assertFalse(notice.stoppable); assertTrue(notice.promoted)
        assertFalse(liveNotice(listOf(chat("a", "waiting"), chat("b", "waiting")), emptyMap(), emptyMap()).promoted)
    }

    @Test fun `an ended turn takes its live notification down and leaves the rest`() {
        // The service drops a chat from what works once it ends; the notice follows what's left.
        val both = liveNotice(listOf(chat("a", "running"), chat("b", "running")), mapOf("a" to 1L, "b" to 2L), emptyMap())
        val after = liveNotice(listOf(chat("b", "running")), mapOf("b" to 2L), emptyMap())
        assertNotEquals(both, after)
        assertEquals("b", after.chatId); assertEquals(2L, after.since)
        // The same snapshot again changes nothing, so nothing is reposted.
        assertEquals(after, liveNotice(listOf(chat("b", "running")), mapOf("b" to 2L), emptyMap()))
    }

    @Test fun `step looks are throttled to one per interval, at once when the last was long ago`() {
        assertEquals(0L, stepLookDelay(0, 50_000))
        assertEquals(0L, stepLookDelay(10_000, 20_000))
        assertEquals(7_000L, stepLookDelay(10_000, 13_000))
        // A clock that went back never waits longer than one interval.
        assertEquals(STEP_LOOK_MILLIS, stepLookDelay(50_000, 10_000))
    }

    @Test fun `step hints name their chat and nothing else counts as one`() {
        assertEquals("c1", stepChat("""{"seq":9,"chatId":"c1","type":"step"}"""))
        assertNull(stepChat("""{"seq":9,"chatId":"c1","type":"state"}"""))
        assertNull(stepChat("""{"seq":9,"chatId":null,"type":"step"}"""))
        assertNull(stepChat("garbage"))
    }

    private fun message(id: String, role: String, text: String) = JSONObject().put("id", id).put("role", role).put("text", text)

    @Test fun `the step comes from the newest messages, merged by cursor and kept short`() {
        val call = message("t1", "activity", "Bash\n{\"command\":\"./gradlew test\"}")
        val first = stepTail(null, JSONObject().put("messages", JSONArray(listOf(message("u", "user", "go"), call))).put("cursor", "c1").put("full", true))
        assertEquals("c1", first.getString("cursor"))
        assertEquals("Bash ./gradlew test", runningStep(first))
        // Its result arrives: nothing runs until the next call.
        val done = stepTail(first, JSONObject().put("messages", JSONArray(listOf(message("t1:result", "activity", "Tool result\nok")))).put("cursor", "c2").put("full", false))
        assertNull(runningStep(done))
        val next = stepTail(done, JSONObject().put("messages", JSONArray(listOf(message("t2", "activity", "Read\n{\"file_path\":\"/x/Alerts.kt\"}")))).put("cursor", "c3").put("full", false))
        assertEquals("Read Alerts.kt", runningStep(next))
        assertEquals("c3", next.getString("cursor"))
        // A reply after the call means the agent moved on to writing.
        assertNull(runningStep(stepTail(next, JSONObject().put("messages", JSONArray(listOf(message("r", "assistant", "Done")))).put("cursor", "c4").put("full", false))))
        val long = stepTail(null, JSONObject().put("messages", JSONArray((1..100).map { message("m$it", "assistant", "$it") })).put("cursor", "c"), keep = 60)
        assertEquals(60, long.getJSONArray("messages").length())
        assertEquals("m100", long.getJSONArray("messages").getJSONObject(59).getString("id"))
    }

    @Test fun `Stop from the notification is judged by the Mac's state after a lost reply`() {
        fun state(status: String?) = JSONObject().put("chats", JSONArray(listOfNotNull(status?.let { JSONObject().put("id", "c").put("status", it) })))
        assertTrue(stopSettled(state("stopping"), "c"))
        assertTrue(stopSettled(state("interrupted"), "c"))
        assertTrue(stopSettled(state("idle"), "c"))
        // A deleted chat has nothing left to stop.
        assertTrue(stopSettled(state(null), "c"))
        assertFalse(stopSettled(state("running"), "c"))
        assertFalse(stopSettled(state("waiting"), "c"))
        assertFalse(stopSettled(null, "c"))
        assertEquals("Not stopped. Couldn't reach your Mac.", notStopped(java.io.IOException("reset")))
        assertEquals("Not stopped. Chat not found", notStopped(ApiError(404, "Chat not found")))
    }
}
