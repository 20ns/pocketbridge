package dev.pocketbridge

import android.view.HapticFeedbackConstants
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NewProjectTest {
    @Test fun `project names follow the Mac's folder rules before anything is sent`() {
        assertNull(projectNameProblem("Garden sensors"))
        assertNull(projectNameProblem("api-v2_test.1"))
        assertNull(projectNameProblem("Café 2"))
        assertNull(projectNameProblem("  padded  "))
        assertEquals("Name the project.", projectNameProblem("   "))
        assertEquals("Start with a letter or number.", projectNameProblem(".hidden"))
        assertEquals("Start with a letter or number.", projectNameProblem("-x"))
        assertEquals("Don't end with a dot.", projectNameProblem("site."))
        assertNotNull(projectNameProblem("a/b"))
        assertNotNull(projectNameProblem("../up"))
        assertNotNull(projectNameProblem("x".repeat(65)))
        assertNull(projectNameProblem("x".repeat(64)))
        // Unicode letters and numbers the Mac accepts, judged by code point: outside the basic plane, letter numbers.
        assertNull(projectNameProblem("\uD801\uDC00-demo"))
        assertNull(projectNameProblem("Ⅳ demo"))
        assertNull(projectNameProblem("²nd draft"))
        assertNull(projectNameProblem("日本語 notes"))
        assertEquals("Start with a letter or number.", projectNameProblem("\uD83D\uDE00 smile"))
        assertNotNull(projectNameProblem("ok \uD83D\uDE00"))
        assertNotNull(projectNameProblem("tab\there"))
    }

    @Test fun `deletions not yet on the Mac are saved, read back and settled only by a refusal`() {
        val saved = mapOf("a" to "Fix login", "b" to "Quote \"x\"")
        assertEquals(saved, decodeDeletions(encodeDeletions(saved)))
        assertTrue(decodeDeletions("").isEmpty())
        assertTrue(decodeDeletions("{broken").isEmpty())
        // Refused (gone, running): the record goes. Unreachable or a server error: it stays for the next connection.
        assertTrue(deletionSettled(ApiError(409, "Stop this chat")))
        assertTrue(deletionSettled(ApiError(404, "Not found")))
        assertFalse(deletionSettled(ApiError(503, "Busy")))
        assertFalse(deletionSettled(java.io.IOException("offline")))
    }

    @Test fun `a retry of the same name reuses its id, another name gets a new one`() {
        var minted = 0
        val first = projectAttempt("", "Site") { "id-${++minted}" }
        assertEquals(ProjectAttempt("id-1", "Site"), first)
        assertEquals(first, projectAttempt(first.store(), "Site") { "id-${++minted}" })
        assertEquals(ProjectAttempt("id-2", "Other"), projectAttempt(first.store(), "Other") { "id-${++minted}" })
        assertEquals("id-3", projectAttempt("{broken", "Site") { "id-${++minted}" }.id)
        assertEquals(first, ProjectAttempt.parse(first.store()))
    }

    @Test fun `the new chat panel lists projects most recently used first and searches name and folder`() {
        val projects = listOf(
            JSONObject("""{"id":"a","name":"Alpha","path":"/Users/n/a","lastUsedAt":100}"""),
            JSONObject("""{"id":"b","name":"Beta","path":"/Users/n/work/b","lastUsedAt":300}"""),
            JSONObject("""{"id":"c","name":"Gamma","path":"/Users/n/c","lastUsedAt":0}"""),
        )
        // A chat newer than any folder use counts as activity.
        val chats = listOf(JSONObject("""{"id":"x","projectId":"c","updatedAt":500}"""))
        assertEquals(listOf("c", "b", "a"), projectsByActivity(projects, chats).map { it.optString("id") })
        assertEquals(listOf("b"), projectsByActivity(projects, chats, "work").map { it.optString("id") })
        assertTrue(projectsByActivity(projects, chats, "zzz").isEmpty())
    }

    @Test fun `list positions survive saving, skip lists at the top and stay bounded`() {
        val positions = mapOf("projects" to (12 to 40), "chats:a" to (0 to 0), "chats:b" to (3 to 0))
        val decoded = ListPositions.decode(ListPositions.encode(positions))
        assertEquals(mapOf("projects" to (12 to 40), "chats:b" to (3 to 0)), decoded)
        assertEquals(ListPositions.LIMIT, ListPositions.decode(ListPositions.encode((1..40).associate { "chats:$it" to (it to 0) })).size)
        assertTrue(ListPositions.decode("not json").isEmpty())
        val restored = ListPositions(decoded)
        assertEquals(12, restored.of("projects").firstVisibleItemIndex)
        assertEquals(0, restored.of("chats:new").firstVisibleItemIndex)
    }

    @Test fun `haptics use the platform's own constants, with older fallbacks`() {
        assertEquals(HapticFeedbackConstants.CONFIRM, hapticConstant(Haptic.Confirm, 36))
        assertEquals(HapticFeedbackConstants.REJECT, hapticConstant(Haptic.Reject, 36))
        assertEquals(HapticFeedbackConstants.TOGGLE_ON, hapticConstant(Haptic.ToggleOn, 34))
        assertEquals(HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE, hapticConstant(Haptic.Threshold, 36))
        // Android 8 has none of those; it gets the nearest it has.
        assertEquals(HapticFeedbackConstants.VIRTUAL_KEY, hapticConstant(Haptic.Confirm, 26))
        assertEquals(HapticFeedbackConstants.CLOCK_TICK, hapticConstant(Haptic.ToggleOff, 30))
        assertEquals(HapticFeedbackConstants.LONG_PRESS, hapticConstant(Haptic.LongPress, 26))
    }

    @Test fun `General has its own entry and option, never a row among the folders`() {
        val general = JSONObject("""{"id":"g","name":"General","path":"/Users/n","lastUsedAt":900,"general":true}""")
        val site = JSONObject("""{"id":"s","name":"Site","path":"/Users/n/site","lastUsedAt":100}""")
        val projects = listOf(site, general)
        assertTrue(isGeneral(general))
        assertFalse(isGeneral(site))
        assertFalse(isGeneral(null))
        assertEquals("g", generalProject(projects)?.optString("id"))
        assertEquals(listOf("s"), folderProjects(projects).map { it.optString("id") })
        // The + panel lists folders only, even though General was used more recently.
        assertEquals(listOf("s"), projectsByActivity(projects, emptyList()).map { it.optString("id") })
        assertTrue(projectsByActivity(projects, emptyList(), "General").isEmpty())
        // An older Mac has no General: nothing to offer.
        assertNull(generalProject(listOf(site)))
        assertNull(generalProject(listOf(JSONObject("""{"id":"x","general":false}"""))))
    }
}
