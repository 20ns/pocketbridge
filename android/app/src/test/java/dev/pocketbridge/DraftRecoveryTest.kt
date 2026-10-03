package dev.pocketbridge

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DraftRecoveryTest {
    @Test fun `recent list keeps typed and unconfirmed drafts and skips blanks`() {
        val server = listOf(JSONObject().put("id", "kept").put("projectId", "app").put("title", "Saved").put("updatedAt", 3))
        val locals = listedDrafts(listOf(
            ListedDraft("one", "app", "A".repeat(90), pending = false, updatedAt = 1),
            ListedDraft("two", "app", "second prompt", pending = false, updatedAt = 2),
            ListedDraft("blank", "app", "  ", pending = false, updatedAt = 9),
            ListedDraft("waiting", "app", "", pending = true, updatedAt = 4),
            ListedDraft("other", "web", "elsewhere", pending = false, updatedAt = 8),
            ListedDraft("kept", "app", "already on the mac", pending = true, updatedAt = 7),
        ))
        val rows = projectChats(server, "app", locals)
        assertEquals(listOf("kept", "one", "two", "waiting"), rows.map { it.getString("id") })
        assertEquals("Saved", rows.first().getString("title"))
        assertFalse(rows.first().optBoolean("local"))
        assertEquals(listOf("A".repeat(80), "second prompt"), rows.filter { it.optString("status") == "draft" }.map { it.getString("title") })
        assertEquals("draft", rows.first { it.getString("id") == "one" }.getString("status"))
        assertEquals("draft", rows.first { it.getString("id") == "two" }.getString("status"))
        assertEquals("unconfirmed", rows.first { it.getString("id") == "waiting" }.getString("status"))
        assertEquals("Draft", statusLabel("draft"))
        assertEquals("Not confirmed", statusLabel("unconfirmed"))
        assertTrue(projectChats(emptyList(), "web", locals).map { it.getString("id") }.contains("other"))
    }
}
