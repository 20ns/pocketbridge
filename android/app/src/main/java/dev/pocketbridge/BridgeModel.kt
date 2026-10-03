package dev.pocketbridge

import android.app.Application
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.util.UUID
import kotlinx.coroutines.*
import androidx.compose.runtime.snapshotFlow
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.sample
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.channels.BufferOverflow
import org.json.JSONArray
import org.json.JSONObject

fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }

@OptIn(FlowPreview::class)
class BridgeModel(application: Application) : AndroidViewModel(application) {
    private val store = Store(application)
    private var api: Api? = null
    private var session: Job? = null
    private var actionJob: Job? = null
    private val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    private val cursor = EventCursor()
    private val syncMutex = Mutex()
    var paired by mutableStateOf(false); private set
    var online by mutableStateOf(false); private set
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf(""); private set
    /** Why the live connection is down; separate from one-off action errors so it can stay visible. */
    var connectionIssue by mutableStateOf(""); private set
    var revoked by mutableStateOf(false); private set
    var refreshing by mutableStateOf(false); private set
    var projects by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var chats by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var messages by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var approvals by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var modes by mutableStateOf(listOf("bypassPermissions")); private set
    var claudeAvailable by mutableStateOf(true); private set
    var selected by mutableStateOf(store.get("selected")); private set
    var draft by mutableStateOf(store.get("draft:$selected")); private set
    var pending by mutableStateOf(loadPending(selected)); private set
    var pairUrl by mutableStateOf(store.get("base"))
    var pairCode by mutableStateOf("")
    var mode by mutableStateOf("bypassPermissions")
    var foreground = false
        private set
    val chat get() = chats.find { it.optString("id") == selected }
    var lastProject: String
        get() = store.get("lastProject")
        set(value) = store.put("lastProject", value)
    init {
        runCatching {
            val token = store.token()
            if (token.isNotEmpty()) { api = Api(normalizeServer(store.get("base")), token); paired = true }
            store.get("state").takeIf { it.isNotEmpty() }?.let { runCatching { applyState(JSONObject(it)) } }
            mode = pending?.mode ?: chat?.optString("mode", "bypassPermissions") ?: "bypassPermissions"
            loadMessages(selected)
        }.onFailure { error = "Saved pairing could not be read. Pair with your Mac again." }
    }
    private fun loadPending(id: String) = store.get("pending:$id").takeIf { it.isNotEmpty() }?.let {
        runCatching { PendingPrompt.parse(it) }.onFailure { error = "Saved delivery state could not be read. Check this chat on your Mac before sending again." }.getOrNull()
    }
    private fun applyState(state: JSONObject) {
        projects = state.getJSONArray("projects").objects()
        chats = state.getJSONArray("chats").objects().sortedByDescending { it.optLong("updatedAt") }
        modes = state.optJSONObject("capabilities")?.optJSONArray("modes")?.let { (0 until it.length()).map(it::getString) } ?: listOf("bypassPermissions")
        claudeAvailable = state.optJSONObject("server")?.optBoolean("claudeAvailable", true) ?: true
    }
    private fun loadMessages(id: String) {
        messages = emptyList(); approvals = emptyList()
        store.get("messages:$id").takeIf { it.isNotEmpty() }?.let {
            runCatching { JSONObject(it).let { saved -> messages = saved.getJSONArray("messages").objects(); approvals = saved.optJSONArray("approvals")?.objects().orEmpty() } }
        }
    }
    fun open(id: String) {
        selected = id; store.put("selected", id)
        draft = store.get("draft:$id"); pending = loadPending(id); mode = pending?.mode ?: chat?.optString("mode", "bypassPermissions") ?: "bypassPermissions"; loadMessages(id)
        refresh()
    }
    fun editDraft(text: String) { draft = text; store.put("draft:$selected", text) }
    fun handleLink(uri: Uri?) {
        if (uri?.scheme != "pocketbridge" || uri.host != "pair") return
        if (paired) { error = "Already paired. Disconnect in Settings before changing Macs."; return }
        pairUrl = uri.getQueryParameter("url").orEmpty(); pairCode = uri.getQueryParameter("code").orEmpty()
    }
    fun pair() = action {
        require(!paired) { "Disconnect before changing Macs." }
        val base = normalizeServer(pairUrl)
        require(pairCode.isNotBlank()) { "Enter the pairing code shown on your Mac." }
        val code = pairCode.trim()
        val pairingSession = store.session()
        val token = withContext(Dispatchers.IO) {
            Api(base).request("/api/pair", JSONObject().put("code", code)).getString("token").also { store.savePair(base, it, pairingSession) }
        }
        api = Api(base, token); paired = true; pairCode = ""; cursor.committed = 0; connectionIssue = ""; revoked = false
        projects = emptyList(); chats = emptyList(); messages = emptyList(); approvals = emptyList(); selected = ""; draft = ""; pending = null
        if (foreground) start()
    }
    fun disconnect() {
        actionJob?.cancel(); stopConnection(); store.clear(); api = null; paired = false; online = false; selected = ""; messages = emptyList(); chats = emptyList(); projects = emptyList(); draft = ""; pending = null; error = ""; connectionIssue = ""; revoked = false
    }
    fun foreground(active: Boolean) { foreground = active; if (active && paired) start() else if (!active) stopConnection() }
    private fun stopConnection() { session?.cancel(); session = null; online = false }
    private fun start() {
        if (session?.isActive == true) return
        session = viewModelScope.launch {
            launch { changes.sample(250).collect { runCatching { sync() }.onFailure { fail(it) } } }
            var backoff = 1000L
            while (isActive && paired) {
                try {
                    sync()
                    val currentApi = api ?: break
                    backoff = 1000L
                    currentApi.watch(cursor.committed) { line ->
                        cursor.observe(line)
                        if (line.startsWith("data:")) changes.tryEmit(Unit)
                    }
                    throw java.io.IOException("The connection to your Mac closed. Reconnecting.")
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) { fail(failure, reconnect = false) }
                online = false
                delay(backoff); backoff = (backoff * 2).coerceAtMost(15000)
            }
        }
    }
    private suspend fun sync() = syncMutex.withLock {
        val currentApi = api ?: return@withLock
        val id = selected
        val (state, stateCache) = withContext(Dispatchers.IO) { currentApi.request("/api/state").let { it to it.toString() } }
        if (api !== currentApi) return@withLock
        val previousMode = chat?.optString("mode")
        val followMode = pending == null && (previousMode == null || mode == previousMode)
        applyState(state); store.put("state", stateCache)
        if (followMode) chat?.optString("mode")?.let { mode = it }
        if (id.isNotEmpty() && chats.any { it.optString("id") == id }) {
            val (result, messageCache) = withContext(Dispatchers.IO) { currentApi.request("/api/chats/$id/messages").let { it to it.toString() } }
            if (api !== currentApi) return@withLock
            store.put("messages:$id", messageCache)
            if (selected == id) { messages = result.getJSONArray("messages").objects(); approvals = result.optJSONArray("approvals")?.objects().orEmpty() }
        }
        cursor.commit(state.optLong("lastSeq")); online = foreground; connectionIssue = ""; revoked = false
    }
    fun refresh() { if (paired) viewModelScope.launch { runCatching { sync() }.onFailure { fail(it) } } }
    /** User-initiated: sync now, or restart the connection loop instead of waiting out its backoff. */
    fun retry() {
        if (!paired || refreshing) return
        refreshing = true
        viewModelScope.launch {
            try {
                if (online) sync()
                else { stopConnection(); if (foreground) start(); withTimeoutOrNull(8000) { snapshotFlow { online }.first { it } } }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { fail(failure) }
            finally { refreshing = false }
        }
    }
    private fun fail(failure: Throwable, reconnect: Boolean = true) {
        if (failure is CancellationException) return
        online = false
        if (failure is ApiError && failure.status == 401) { revoked = true; connectionIssue = "This phone's pairing was removed on the Mac. Disconnect, then pair again." }
        else connectionIssue = reason(failure)
        if (reconnect && foreground && paired) { stopConnection(); start() }
    }
    private fun reason(failure: Throwable) = when (failure) {
        is ApiError -> failure.message?.takeIf { it.isNotBlank() } ?: "Your Mac rejected the request."
        is SocketTimeoutException -> "Your Mac took too long to answer. Check Tailscale on both devices."
        is UnknownHostException, is ConnectException, is NoRouteToHostException -> "Can't reach your Mac. Check that Tailscale is on and the Mac is awake."
        is java.io.IOException -> "The connection to your Mac was interrupted. Check Tailscale on both devices."
        else -> failure.message?.takeIf { it.isNotBlank() } ?: "Something went wrong. Try again."
    }
    private fun action(block: suspend () -> Unit) {
        if (busy) return
        busy = true; error = ""
        actionJob = viewModelScope.launch {
            try { block() } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                error = reason(failure)
                if (failure is java.io.IOException && failure !is ApiError) fail(failure)
            }
            finally { busy = false }
        }
    }
    fun newChat(projectId: String, selectedMode: String) = action {
        val currentApi = api ?: return@action
        val result = withContext(Dispatchers.IO) { currentApi.request("/api/chats", JSONObject().put("projectId", projectId).put("mode", selectedMode)) }
        if (api !== currentApi) return@action
        sync(); open(result.getString("id"))
    }
    fun send() = action {
        val currentApi = api ?: return@action
        val id = selected
        require(id.isNotEmpty()) { "Open a chat first." }
        require(pending != null || store.get("pending:$id").isEmpty()) { "Saved delivery state could not be read. Check this chat on your Mac before sending again." }
        val deliverySession = store.session()
        val prompt = pending ?: PendingPrompt(UUID.randomUUID().toString(), draft.trim(), mode)
        require(prompt.text.isNotEmpty()) { "Write a prompt first." }
        if (selected == id) pending = prompt
        withContext(Dispatchers.IO) { store.commit("pending:$id", prompt.json().toString(), deliverySession) }
        if (api !== currentApi) return@action
        if (selected == id) pending = prompt
        try {
            withContext(Dispatchers.IO) {
                val result = currentApi.request("/api/chats/$id/prompts", prompt.json())
                check(result.optBoolean("accepted")) { "The Mac did not confirm delivery. Retry with the same prompt ID." }
                store.completePrompt(id, prompt, deliverySession, accepted = true)
            }
            if (api !== currentApi) return@action
            if (selected == id) { pending = null; draft = store.get("draft:$id") }
        } catch (failure: ApiError) {
            // Timeouts and server failures may follow execution. Keep their delivery IDs.
            if (api !== currentApi) return@action
            if (failure.definitiveRejection) {
                withContext(Dispatchers.IO) { store.completePrompt(id, prompt, deliverySession, accepted = false) }
                if (selected == id) pending = null
            }
            throw failure
        }
        sync()
    }
    fun stop() = action {
        val currentApi = api ?: return@action
        val id = selected
        withContext(Dispatchers.IO) { currentApi.request("/api/chats/$id/stop", JSONObject()) }; sync()
    }
    fun decide(id: String, allow: Boolean, answers: JSONObject) = action {
        val currentApi = api ?: return@action
        withContext(Dispatchers.IO) { currentApi.request("/api/approvals/$id", JSONObject().put("decision", if (allow) "allow" else "deny").apply { if (answers.length() > 0) put("answers", answers) }) }; sync()
    }
    fun clearError() { error = "" }
}
