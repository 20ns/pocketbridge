package dev.pocketbridge

import android.app.Application
import android.content.Context
import android.content.ContextWrapper
import android.security.NetworkSecurityPolicy
import android.test.InstrumentationTestCase
import androidx.lifecycle.viewModelScope
import java.io.File
import java.util.UUID
import kotlinx.coroutines.cancel

/** Exercises the installed build's policy and real encrypted pairing storage without touching its user data. */
@Suppress("DEPRECATION")
class HttpsConnectionTest : InstrumentationTestCase() {
    fun testInstalledApiAndPlatformEnforceHttps() {
        assertEquals("https://100.64.0.1", Api("https://100.64.0.1/").base)
        listOf("http://100.64.0.1", "http://192.168.1.10", "http://mac.example.com").forEach(::rejectsHttp)
        listOf("http://localhost:8787", "http://127.0.0.1:8787", "http://127.1.2.3:8787", "http://10.0.2.2:8787").forEach { address ->
            if (BuildConfig.DEBUG) assertEquals(address, Api(address).base) else rejectsHttp(address)
        }
        val policy = NetworkSecurityPolicy.getInstance()
        if (!BuildConfig.DEBUG) {
            assertFalse(policy.isCleartextTrafficPermitted)
            listOf("127.0.0.1", "10.0.2.2", "100.64.0.1").forEach { host -> assertFalse(host, policy.isCleartextTrafficPermitted(host)) }
        }
    }

    private fun rejectsHttp(address: String) {
        assertTrue(address, runCatching { Api(address) }.exceptionOrNull() is IllegalArgumentException)
    }

    fun testLegacyHttpPairingIsBlockedWithoutLosingDraftOrDelivery() {
        val context = instrumentation.targetContext
        val prefix = "https-test-${UUID.randomUUID()}-"
        val directory = File(context.cacheDir, prefix)
        val application = object : Application() {
            init { attachBaseContext(object : ContextWrapper(context) {
                override fun getSharedPreferences(name: String, mode: Int) = context.getSharedPreferences(prefix + name, mode)
                override fun getFilesDir() = File(directory, "files").apply { mkdirs() }
                override fun getCacheDir() = File(directory, "cache").apply { mkdirs() }
            }) }
        }
        val store = Store(application)
        val chatId = UUID.randomUUID().toString()
        val prompt = PendingPrompt(UUID.randomUUID().toString(), "Keep this prompt", projectId = "project")
        var model: BridgeModel? = null
        var failure: Throwable? = null
        val viewing = Alerts.viewing
        try {
            val token = "instrumentation-only-${UUID.randomUUID()}"
            store.savePair("http://100.64.0.1", token, store.session())
            val encrypted = store.get("token")
            store.put("selected", chatId)
            store.put("draft:$chatId", prompt.text)
            store.put("pending:$chatId", prompt.json().toString())
            store.put("draftChat:$chatId", DraftChat.of(chatId, "project", prompt.options, 1).store())
            instrumentation.runOnMainSync {
                try {
                    val blocked = BridgeModel(application).also { model = it }
                    assertTrue(blocked.paired)
                    assertFalse(blocked.online)
                    assertTrue(blocked.connectionIssue, blocked.connectionIssue.contains("HTTPS"))
                    assertEquals(chatId, blocked.selected)
                    assertEquals(prompt.text, blocked.draft)
                    assertEquals(prompt, blocked.pending)
                    assertTrue(chatId in blocked.localDraftIds)
                    val api = BridgeModel::class.java.getDeclaredField("api").apply { isAccessible = true }
                    assertNull(api.get(blocked))
                    val originalIssue = blocked.connectionIssue
                    blocked.updateAddress("http://100.64.0.2")
                    assertTrue(blocked.error, blocked.error.contains("HTTPS"))
                    assertEquals(originalIssue, blocked.connectionIssue)
                    assertEquals(prompt, blocked.pending)
                    assertEquals(prompt.text, blocked.draft)
                    assertFalse(blocked.busy)
                    assertNull(api.get(blocked))
                } catch (problem: Throwable) { failure = problem }
            }
            failure?.let { throw it }
            assertEquals("http://100.64.0.1", store.get("base"))
            assertEquals(encrypted, store.get("token"))
            assertEquals(token, store.token())
            assertEquals(prompt.json().toString(), store.get("pending:$chatId"))
            assertEquals(prompt.text, store.get("draft:$chatId"))
        } finally {
            instrumentation.runOnMainSync { model?.viewModelScope?.cancel(); Alerts.viewing = viewing }
            context.getSharedPreferences(prefix + "pocketbridge", Context.MODE_PRIVATE).edit().clear().commit()
            context.getSharedPreferences(prefix + "updates", Context.MODE_PRIVATE).edit().clear().commit()
            directory.deleteRecursively()
        }
    }
}
