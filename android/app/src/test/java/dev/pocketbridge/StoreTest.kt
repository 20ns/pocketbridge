package dev.pocketbridge

import android.content.SharedPreferences
import java.lang.reflect.Proxy
import java.util.concurrent.CancellationException
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
    }

    private class Preferences(private val commitSucceeds: Boolean = true) {
        private val values = mutableMapOf<String, String>()
        val commits = mutableListOf<Map<String, String>>()
        val value = proxy<SharedPreferences> { name, args -> when (name) {
            "getString" -> values[args[0]] ?: args[1]
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
                    if (name == "commit") commits.add(values.toMap())
                    commitSucceeds
                }
                else -> error("Unexpected editor call: $name")
            } }
            return edit
        }
        private inline fun <reified T> proxy(crossinline block: (String, Array<out Any?>) -> Any?): T =
            Proxy.newProxyInstance(T::class.java.classLoader, arrayOf(T::class.java)) { _, method, args -> block(method.name, args.orEmpty()) } as T
    }
}
