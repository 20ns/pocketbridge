package dev.pocketbridge

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class TranscriptSyncTest {
    @Test fun `deltas update earlier replies append late results and replace live metadata`() {
        val old = JSONObject("""{"messages":[{"id":"tool","text":"Shell"},{"id":"reply","text":"Partial"},{"id":"steer","text":"Next"}],"thinking":"Working"}""")
        val delta = JSONObject("""{"full":false,"cursor":"next","messages":[{"id":"reply","text":"Complete"},{"id":"tool:result","text":"Done"}],"thinking":null,"approvals":[]}""")
        val result = mergeTranscript(old, delta)
        assertEquals(listOf("tool", "reply", "steer", "tool:result"), result.getJSONArray("messages").objects().map { it.getString("id") })
        assertEquals("Complete", result.getJSONArray("messages").getJSONObject(1).getString("text"))
        assertTrue(result.isNull("thinking"))
        assertEquals("next", result.getString("cursor"))
        assertEquals("Partial", old.getJSONArray("messages").getJSONObject(1).getString("text"))
        // The saved full snapshot is a valid baseline after process recreation.
        val restored = JSONObject(result.toString())
        assertEquals(4, mergeTranscript(restored, JSONObject("""{"full":false,"messages":[]}""")).getJSONArray("messages").length())
    }

    @Test fun `full snapshots replace removed rows and older servers need no cursor`() {
        val old = JSONObject("""{"messages":[{"id":"removed"}]}""")
        val full = JSONObject("""{"full":true,"messages":[]}""")
        assertSame(full, mergeTranscript(old, full))
        val legacy = JSONObject("""{"messages":[{"id":"legacy"}]}""")
        assertSame(legacy, mergeTranscript(null, legacy))
        assertThrows(IllegalArgumentException::class.java) { mergeTranscript(null, JSONObject("""{"full":false,"messages":[]}""")) }
    }
}
