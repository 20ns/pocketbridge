package dev.pocketbridge

import android.content.SharedPreferences
import java.lang.reflect.Proxy
import java.util.concurrent.CancellationException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class StoreTest {
    @Test fun `acknowledgement clears delivery ID and matching draft in one durable write`() {
        val prefs = Preferences()
        val store = Store(prefs.value)
        val prompt = PendingPrompt("delivery", "hello")
        store.put("draft:chat", " hello ")
        store.put("draftChat:chat", DraftChat("chat", "project", "auto").store())
        store.put("options:chat", ChatOptions("auto", "sonnet", "high").store())
        store.commit("pending:chat", prompt.json().toString(), store.session())
        store.completePrompt("chat", prompt, store.session(), accepted = true)
        assertEquals(2, prefs.commits.size)
        assertFalse(prefs.commits.last().containsKey("pending:chat"))
        assertFalse(prefs.commits.last().containsKey("draft:chat"))
        assertFalse(prefs.commits.last().containsKey("draftChat:chat"))
        assertFalse(prefs.commits.last().containsKey("options:chat"))
    }

    @Test fun `acknowledgement preserves edits and rejection preserves the original draft`() {
        val store = Store(Preferences().value)
        val prompt = PendingPrompt("delivery", "hello")
        store.put("draft:chat", "next prompt")
        store.completePrompt("chat", prompt, store.session(), accepted = true)
        assertEquals("next prompt", store.get("draft:chat"))
        store.put("draft:chat", "hello")
        store.put("options:chat", ChatOptions("auto", "sonnet", "high").store())
        store.completePrompt("chat", prompt, store.session(), accepted = false)
        assertEquals("hello", store.get("draft:chat"))
        assertNotEquals("", store.get("options:chat"))
    }

    @Test fun `old requests cannot write delivery state after disconnect`() {
        val store = Store(Preferences().value)
        val session = store.session()
        store.clear()
        store.put("draft:chat", "new pairing draft")
        assertTrue(runCatching { store.commit("pending:chat", "old prompt", session) }.exceptionOrNull() is CancellationException)
        assertTrue(runCatching { store.completePrompt("chat", PendingPrompt("delivery", "new pairing draft"), session, accepted = true) }.exceptionOrNull() is CancellationException)
        assertEquals("", store.get("pending:chat"))
        assertEquals("new pairing draft", store.get("draft:chat"))
    }

    @Test fun `late pairing response cannot restore credentials after disconnect`() {
        val store = Store(Preferences().value)
        val session = store.session()
        store.clear()
        assertTrue(runCatching { store.savePair("https://mac.ts.net", "old-token", session) }.exceptionOrNull() is CancellationException)
        assertEquals("", store.get("base"))
        assertEquals("", store.get("token"))
    }

    @Test fun `failed durable write stops delivery`() {
        val prefs = Preferences(commitSucceeds = false)
        val store = Store(prefs.value)
        assertTrue(runCatching { store.commit("pending:chat", "prompt", store.session()) }.isFailure)
        assertEquals("prompt", store.get("pending:chat"))
        assertTrue(prefs.commits.isEmpty())
    }

    @Test fun `confirmed deletion commits cache and pending removal`() {
        val prefs = Preferences()
        val store = Store(prefs.value)
        store.put("pending:chat", "prompt")
        store.put("draft:chat", "hello")
        store.put("messages:chat", "{}")
        store.put("draftChat:chat", DraftChat("chat", "app", "auto").store())
        store.put("options:chat", ChatOptions("auto").store())
        val before = prefs.commits.size
        store.commitChatRemoval("chat", store.session())
        assertEquals(before + 1, prefs.commits.size)
        assertEquals("", store.get("pending:chat"))
        assertEquals("", store.get("draft:chat"))
        assertEquals("", store.get("messages:chat"))
        assertEquals("", store.get("draftChat:chat"))
        assertEquals("", store.get("options:chat"))
        assertFalse(prefs.commits.last().containsKey("pending:chat"))
        store.put("draft:blank", " ")
        store.removeChat("blank")
        assertEquals(before + 1, prefs.commits.size)
        assertEquals("", store.get("draft:blank"))
    }

    @Test fun `one deletion commit drops the cached row and selected and keeps the sibling`() {
        val prefs = Preferences()
        val store = Store(prefs.value)
        store.put("state", snapshot("gone" to "Gone", "stay" to "Stay"))
        store.put("selected", "gone")
        store.put("pending:gone", "prompt")
        store.put("messages:gone", "{}")
        store.put("messages:stay", "kept-messages")
        store.put("pending:stay", "sibling")
        val before = prefs.commits.size
        store.commitChatRemoval("gone", store.session())
        assertEquals(before + 1, prefs.commits.size)
        val committed = prefs.commits.last()
        assertFalse(committed.containsKey("pending:gone"))
        assertFalse(committed.containsKey("messages:gone"))
        assertFalse(committed.containsKey("selected"))
        assertEquals("kept-messages", committed["messages:stay"])
        assertEquals("sibling", committed["pending:stay"])
        assertEquals(listOf("stay"), chatIds(committed.getValue("state")))
        val state = JSONObject(committed.getValue("state"))
        assertEquals("app", state.getJSONArray("projects").getJSONObject(0).getString("id"))
        assertEquals(9, state.getInt("lastSeq"))
        assertTrue(state.getJSONObject("server").getBoolean("claudeAvailable"))
        val reloaded = Store(prefs.value)
        assertEquals(listOf("stay"), chatIds(reloaded.get("state")))
        assertEquals("", reloaded.get("selected"))
        assertEquals("", reloaded.get("pending:gone"))
        assertEquals("sibling", reloaded.get("pending:stay"))
    }

    @Test fun `deleting an unselected sibling keeps selected and drops a bad snapshot`() {
        val store = Store(Preferences().value)
        store.put("state", snapshot("gone" to "Gone", "stay" to "Stay"))
        store.put("selected", "stay")
        store.put("pending:gone", "prompt")
        store.commitChatRemoval("gone", store.session())
        assertEquals("stay", store.get("selected"))
        assertEquals(listOf("stay"), chatIds(store.get("state")))
        assertEquals("", store.get("pending:gone"))
        store.put("state", "{")
        store.put("pending:other", "prompt")
        store.put("selected", "stay")
        store.commitChatRemoval("other", store.session())
        assertEquals("", store.get("state"))
        assertEquals("", store.get("pending:other"))
        assertEquals("stay", store.get("selected"))
    }

    @Test fun `saved draft ids stay readable across keys`() {
        val store = Store(Preferences().value)
        store.put("draftChat:one", DraftChat("one", "app", "auto").store())
        store.put("draftChat:two", DraftChat("two", "app", "auto").store())
        store.put("draft:blank", "x")
        store.put("token", "secret")
        assertEquals(setOf("one", "two"), store.localDraftIds().toSet())
    }

    @Test fun `failed deletion is reported and a stale session leaves preferences`() {
        val prefs = Preferences(commitSucceeds = false)
        val store = Store(prefs.value)
        store.put("state", snapshot("chat" to "Chat", "stay" to "Stay"))
        store.put("selected", "chat")
        store.put("pending:chat", "prompt")
        store.put("draft:chat", "hello")
        assertTrue(runCatching { store.commitChatRemoval("chat", store.session()) }.isFailure)
        assertEquals("", store.get("pending:chat"))
        assertEquals("", store.get("selected"))
        assertEquals(listOf("stay"), chatIds(store.get("state")))
        assertTrue(prefs.commits.isEmpty())
        val session = store.session()
        store.clear()
        store.put("state", snapshot("chat" to "Chat"))
        store.put("selected", "chat")
        store.put("pending:chat", "new pairing")
        store.put("draft:chat", "kept")
        assertTrue(runCatching { store.commitChatRemoval("chat", session) }.exceptionOrNull() is CancellationException)
        assertEquals("new pairing", store.get("pending:chat"))
        assertEquals("kept", store.get("draft:chat"))
        assertEquals("chat", store.get("selected"))
        assertEquals(listOf("chat"), chatIds(store.get("state")))
    }

    private fun snapshot(vararg chats: Pair<String, String>) = JSONObject()
        .put("projects", JSONArray().put(JSONObject().put("id", "app").put("name", "App")))
        .put("chats", JSONArray().apply { chats.forEach { put(JSONObject().put("id", it.first).put("title", it.second)) } })
        .put("lastSeq", 9)
        .put("server", JSONObject().put("claudeAvailable", true))
        .toString()

    private fun chatIds(state: String) = JSONObject(state).getJSONArray("chats").objects().map { it.getString("id") }

    private class Preferences(private val commitSucceeds: Boolean = true) {
        private val values = mutableMapOf<String, String>()
        val commits = mutableListOf<Map<String, String>>()
        val value = proxy<SharedPreferences> { name, args -> when (name) {
            "getString" -> values[args[0]] ?: args[1]
            "getAll" -> HashMap(values)
            "edit" -> editor()
            else -> error("Unexpected preferences call: $name")
        } }
        private fun editor(): SharedPreferences.Editor {
            val changes = mutableMapOf<String, String?>()
            var clear = false
            lateinit var edit: SharedPreferences.Editor
            edit = proxy { name, args -> when (name) {
                "putString" -> edit.also { changes[args[0] as String] = args[1] as String? }
                "remove" -> edit.also { changes[args[0] as String] = null }
                "clear" -> edit.also { clear = true }
                "commit", "apply" -> {
                    if (clear) values.clear()
                    changes.forEach { (key, value) -> if (value == null) values.remove(key) else values[key] = value }
                    val durable = name == "commit" && commitSucceeds
                    if (durable) commits.add(values.toMap())
                    name != "commit" || commitSucceeds
                }
                else -> error("Unexpected editor call: $name")
            } }
            return edit
        }
        private inline fun <reified T> proxy(crossinline block: (String, Array<out Any?>) -> Any?): T =
            Proxy.newProxyInstance(T::class.java.classLoader, arrayOf(T::class.java)) { _, method, args -> block(method.name, args.orEmpty()) } as T
    }
}
