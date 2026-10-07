package dev.pocketbridge

import android.app.Application
import android.content.Context
import android.content.ContextWrapper
import android.test.InstrumentationTestCase
import androidx.lifecycle.viewModelScope
import java.io.File
import java.util.UUID
import kotlinx.coroutines.cancel
import org.json.JSONObject

@Suppress("DEPRECATION")
class ConnectionStateTest : InstrumentationTestCase() {
    fun testFreshStateWithoutPendingDeliveryDoesNotFailTheConnection() {
        val context = instrumentation.targetContext
        val preferences = context.getSharedPreferences("connection-state-test-pocketbridge", Context.MODE_PRIVATE)
        val directory = File(context.cacheDir, "connection-state-test")
        val application = object : Application() {
            init { attachBaseContext(object : ContextWrapper(context) {
                override fun getSharedPreferences(name: String, mode: Int) = context.getSharedPreferences("connection-state-test-$name", mode)
                override fun getFilesDir() = File(directory, "files").apply { mkdirs() }
                override fun getCacheDir() = File(directory, "cache").apply { mkdirs() }
            }) }
        }
        preferences.edit().clear().commit()
        val prompt = PendingPrompt(UUID.randomUUID().toString(), "check")
        var model: BridgeModel? = null
        var failure: Throwable? = null
        try {
            instrumentation.runOnMainSync {
                try {
                    val fresh = BridgeModel(application).also { model = it }
                    assertNull(fresh.pending)
                    val apply = BridgeModel::class.java.getDeclaredMethod("applyState", JSONObject::class.java).apply { isAccessible = true }
                    apply.invoke(fresh, JSONObject("""{"projects":[],"chats":[],"server":{"claudeAvailable":false,"experiments":"~/Desktop/experiments"}}"""))
                    assertFalse(fresh.claudeAvailable)
                    assertEquals("~/Desktop/experiments", fresh.experiments)
                    assertEquals("", fresh.connectionIssue)
                    assertEquals("", fresh.error)
                    val setPending = BridgeModel::class.java.getDeclaredMethod("setPending", PendingPrompt::class.java).apply { isAccessible = true }
                    setPending.invoke(fresh, prompt)
                    val state = JSONObject("""{"projects":[],"chats":[]}""")
                    // A foreground POST owns clearing its pending delivery even if the background service proved it.
                    Alerts.inFlight.add(prompt.id)
                    apply.invoke(fresh, state)
                    assertEquals(prompt, fresh.pending)
                    Alerts.inFlight.remove(prompt.id)
                    preferences.edit().putString("pending:", prompt.json().toString()).commit()
                    apply.invoke(fresh, state)
                    assertEquals(prompt, fresh.pending)
                    // Once the saved delivery is reconciled, the next state clears the composer exactly once.
                    preferences.edit().remove("pending:").commit()
                    apply.invoke(fresh, state)
                    assertNull(fresh.pending)
                    apply.invoke(fresh, state)
                    assertNull(fresh.pending)
                } catch (problem: Throwable) { failure = problem }
            }
            failure?.let { throw it }
        } finally {
            Alerts.inFlight.remove(prompt.id)
            instrumentation.runOnMainSync { model?.viewModelScope?.cancel() }
            preferences.edit().clear().commit()
            context.getSharedPreferences("connection-state-test-updates", Context.MODE_PRIVATE).edit().clear().commit()
            directory.deleteRecursively()
        }
    }
}
