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

data class DraftChat(val id: String, val projectId: String, val mode: String, val model: String = "default", val effort: String = "default", val createdAt: Long = 0) {
    fun json() = JSONObject().put("id", id).put("projectId", projectId).put("mode", mode).put("model", model).put("effort", effort).put("title", "New chat").put("status", "idle").put("updatedAt", createdAt)
    fun store() = JSONObject().put("projectId", projectId).put("mode", mode).put("model", model).put("effort", effort).put("createdAt", createdAt).toString()
    companion object {
        fun parse(id: String, value: String) = JSONObject(value).let { DraftChat(id, it.getString("projectId"), it.optString("mode", "bypassPermissions"), it.optString("model", "default"), it.optString("effort", "default"), it.optLong("createdAt")) }
    }
}

/** A local chat row. Blank and unsent drafts stay out of the list; a saved delivery id stays in. */
data class ListedDraft(val id: String, val projectId: String, val text: String, val pending: Boolean, val updatedAt: Long = 0)

fun listedDrafts(drafts: List<ListedDraft>) = drafts.mapNotNull { draft ->
    if (draft.text.isBlank() && !draft.pending) null
    else JSONObject().put("id", draft.id).put("projectId", draft.projectId).put("title", draft.text.trim().take(80).ifBlank { "New chat" }).put("local", true)
        .put("status", if (draft.pending) "unconfirmed" else "draft").put("updatedAt", draft.updatedAt)
}

/** Server rows stay in their reconciled order. A local id already on the server is not listed twice. */
fun projectChats(server: List<JSONObject>, projectId: String, locals: List<JSONObject>): List<JSONObject> {
    val known = server.map { it.optString("id") }.toSet()
    return server.filter { it.optString("projectId") == projectId } + locals.filter { it.optString("projectId") == projectId && it.optString("id") !in known }
}

data class ChatOptions(val mode: String, val model: String = "default", val effort: String = "default") {
    fun store() = JSONObject().put("mode", mode).put("model", model).put("effort", effort).toString()
    companion object {
        fun parse(value: String) = JSONObject(value).let { chatOptions(it.optString("mode", "bypassPermissions"), it.optString("model", "default"), it.optString("effort", "default")) }
    }
}
fun supportsEffort(model: String) = model != "haiku"
fun effortForModel(model: String, effort: String) = if (supportsEffort(model)) effort else "default"
fun chatOptions(mode: String, model: String, effort: String) = ChatOptions(mode, model, effortForModel(model, effort))

@OptIn(FlowPreview::class)
class BridgeModel(application: Application) : AndroidViewModel(application) {
    private val store = Store(application)
    private val updater = Updater(application)
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
    var updateBusy by mutableStateOf(false); private set
    var updateStatus by mutableStateOf(UpdateStatus()); private set
    var projects by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var chats by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var messages by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var approvals by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var modes by mutableStateOf(listOf("bypassPermissions")); private set
    var models by mutableStateOf(listOf("default")); private set
    var efforts by mutableStateOf(listOf("default")); private set
    var claudeAvailable by mutableStateOf(true); private set
    var selected by mutableStateOf(store.get("selected")); private set
    var draft by mutableStateOf(store.get("draft:$selected")); private set
    var pending by mutableStateOf(loadPending(selected)); private set
    var pairUrl by mutableStateOf(store.get("base"))
    var pairCode by mutableStateOf("")
    var mode by mutableStateOf("bypassPermissions")
    var model by mutableStateOf("default")
    var effort by mutableStateOf("default")
    var localDraftIds by mutableStateOf(store.localDraftIds()); private set
    var foreground = false
        private set
    val chat get() = chats.find { it.optString("id") == selected } ?: draftChat(selected)?.json()
    var lastProject: String
        get() = store.get("lastProject")
        set(value) = store.put("lastProject", value)
    init {
        runCatching {
            val token = store.token()
            if (token.isNotEmpty()) { api = Api(normalizeServer(store.get("base")), token); paired = true }
            store.get("state").takeIf { it.isNotEmpty() }?.let { runCatching { applyState(JSONObject(it)) } }
            applyOptionsFromSelection()
            loadMessages(selected)
        }.onFailure { error = "Saved pairing could not be read. Pair with your Mac again." }
    }
    private fun loadPending(id: String) = store.get("pending:$id").takeIf { it.isNotEmpty() }?.let {
        runCatching { PendingPrompt.parse(it) }.onFailure { error = "Saved delivery state could not be read. Check this chat on your Mac before sending again." }.getOrNull()
    }
    private fun applyState(state: JSONObject) {
        projects = state.getJSONArray("projects").objects()
        chats = state.getJSONArray("chats").objects().sortedByDescending { it.optLong("updatedAt") }
        val capabilities = state.optJSONObject("capabilities")
        modes = capabilities?.optJSONArray("modes")?.let { (0 until it.length()).map(it::getString) } ?: listOf("bypassPermissions")
        models = capabilities?.optJSONArray("models")?.let { (0 until it.length()).map(it::getString) } ?: listOf("default")
        efforts = capabilities?.optJSONArray("efforts")?.let { (0 until it.length()).map(it::getString) } ?: listOf("default")
        claudeAvailable = state.optJSONObject("server")?.optBoolean("claudeAvailable", true) ?: true
    }
    private fun draftChat(id: String) = store.get("draftChat:$id").takeIf { it.isNotEmpty() }?.let {
        runCatching { DraftChat.parse(id, it) }.onFailure { store.remove("draftChat:$id") }.getOrNull()
    }
    private fun optionOverride(id: String) = store.get("options:$id").takeIf { it.isNotEmpty() }?.let {
        runCatching { ChatOptions.parse(it) }.onFailure { store.remove("options:$id") }.getOrNull()
    }
    private fun optionsFrom(chat: JSONObject?) = chat?.let { chatOptions(it.optString("mode", "bypassPermissions"), it.optString("model", "default"), it.optString("effort", "default")) }
    private fun setOptions(options: ChatOptions) { mode = options.mode; model = options.model; effort = options.effort }
    private fun currentOptions() = chatOptions(mode, model, effort)
    private fun applyOptionsFromSelection() {
        val local = draftChat(selected)
        val options = pending?.let { ChatOptions(it.mode, it.model, it.effort) }
            ?: local?.let { chatOptions(it.mode, it.model, it.effort) }
            ?: optionOverride(selected)
            ?: optionsFrom(chat)
            ?: ChatOptions("bypassPermissions")
        setOptions(options)
    }
    private fun refreshDraftIds() { localDraftIds = store.localDraftIds() }
    private fun discardEmptyDraft(id: String) {
        if (id.isNotEmpty() && draftChat(id) != null && loadPending(id) == null && store.get("draft:$id").isBlank()) {
            store.removeChat(id)
            refreshDraftIds()
        }
    }
    private fun loadMessages(id: String) {
        messages = emptyList(); approvals = emptyList()
        store.get("messages:$id").takeIf { it.isNotEmpty() }?.let {
            runCatching { JSONObject(it).let { saved -> messages = saved.getJSONArray("messages").objects(); approvals = saved.optJSONArray("approvals")?.objects().orEmpty() } }
        }
    }
    fun open(id: String) {
        if (id != selected) discardEmptyDraft(selected)
        selected = id; store.put("selected", id)
        draft = store.get("draft:$id"); pending = loadPending(id); applyOptionsFromSelection(); loadMessages(id)
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
        projects = emptyList(); chats = emptyList(); messages = emptyList(); approvals = emptyList(); selected = ""; draft = ""; pending = null; localDraftIds = emptyList(); model = "default"; effort = "default"
        if (foreground) start()
    }
    fun disconnect() {
        actionJob?.cancel(); stopConnection(); store.clear(); api = null; paired = false; online = false; selected = ""; messages = emptyList(); chats = emptyList(); projects = emptyList(); draft = ""; pending = null; localDraftIds = emptyList(); error = ""; connectionIssue = ""; revoked = false
    }
    fun checkUpdate() = updateAction { updateStatus = withContext(Dispatchers.IO) { updater.check() } }
    fun downloadUpdate() = updateAction {
        val release = updateStatus.release ?: error("Check for an update first.")
        updateStatus = withContext(Dispatchers.IO) { updater.download(release) }
    }
    fun installUpdate() = updateAction { updateStatus = updater.install(updateStatus) }
    fun resumeUpdateInstall() {
        if (updateStatus.waitingForPermission && !updateBusy && getApplication<Application>().packageManager.canRequestPackageInstalls()) installUpdate()
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
        val previous = chat
        val followOptions = pending == null && draftChat(id) == null && optionOverride(id) == null && (previous == null || currentOptions() == optionsFrom(previous))
        applyState(state); store.put("state", stateCache)
        val server = chats.find { it.optString("id") == id }
        if (pending == null && optionOverride(id) != null && optionOverride(id) == optionsFrom(server)) store.remove("options:$id")
        if (id.isNotEmpty() && chats.none { it.optString("id") == id } && draftChat(id) == null && pending == null) {
            open("")
            return@withLock
        }
        if (followOptions) applyOptionsFromSelection()
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
    private fun updateAction(block: suspend () -> Unit) {
        if (updateBusy) return
        updateBusy = true
        viewModelScope.launch {
            try { block() } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { updateStatus = updateStatus.copy(message = reason(failure)) }
            finally { updateBusy = false }
        }
    }
    fun visibleDrafts() = listedDrafts(localDraftIds.mapNotNull { id ->
        val saved = store.get("draftChat:$id")
        if (saved.isEmpty()) return@mapNotNull null
        val draft = runCatching { DraftChat.parse(id, saved) }.getOrNull() ?: return@mapNotNull null
        val pendingRaw = store.get("pending:$id")
        val typed = store.get("draft:$id")
        val text = typed.ifBlank { pendingRaw.takeIf { it.isNotEmpty() }?.let { runCatching { PendingPrompt.parse(it).text }.getOrNull() }.orEmpty() }
        ListedDraft(draft.id, draft.projectId, text, pendingRaw.isNotEmpty(), draft.createdAt)
    })
    fun discardDraft(id: String) {
        if (store.get("pending:$id").isNotEmpty() || draftChat(id) == null || chats.any { it.optString("id") == id }) return
        store.removeChat(id)
        refreshDraftIds()
        if (selected == id) open("")
    }
    fun newChat(projectId: String, selectedMode: String, selectedModel: String = "default", selectedEffort: String = "default") {
        val id = UUID.randomUUID().toString()
        val options = chatOptions(selectedMode, selectedModel, selectedEffort)
        store.put("draftChat:$id", DraftChat(id, projectId, options.mode, options.model, options.effort, System.currentTimeMillis()).store())
        refreshDraftIds()
        lastProject = projectId
        open(id)
    }
    fun updateOptions(nextMode: String, nextModel: String, nextEffort: String) {
        if (pending != null || isWorking(chat?.optString("status")) || busy) return
        val next = chatOptions(nextMode, nextModel, nextEffort)
        setOptions(next)
        val local = draftChat(selected)
        if (local != null) store.put("draftChat:$selected", local.copy(mode = next.mode, model = next.model, effort = next.effort).store())
        else if (selected.isNotEmpty() && chat != null) {
            if (next == optionsFrom(chat)) store.remove("options:$selected") else store.put("options:$selected", next.store())
        }
    }
    fun send() = action {
        val currentApi = api ?: return@action
        val id = selected
        require(id.isNotEmpty()) { "Open a chat first." }
        require(pending != null || store.get("pending:$id").isEmpty()) { "Saved delivery state could not be read. Check this chat on your Mac before sending again." }
        val deliverySession = store.session()
        val local = draftChat(id)
        val prompt = pending ?: PendingPrompt(UUID.randomUUID().toString(), draft.trim(), mode, model, effort, local?.projectId.orEmpty())
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
                if (failure.status == 410 && local != null) {
                    store.remove("draftChat:$id")
                    if (selected == id) open("")
                }
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
    fun rename(id: String, title: String) = action {
        val currentApi = api ?: return@action
        require(title.trim().isNotEmpty()) { "Name the chat first." }
        withContext(Dispatchers.IO) { currentApi.request("/api/chats/$id/rename", JSONObject().put("title", title.trim())) }
        sync()
    }
    fun delete(id: String) = action {
        val currentApi = api ?: return@action
        val chat = chats.find { it.optString("id") == id }
        require(!isWorking(chat?.optString("status"))) { "Stop this chat before deleting it." }
        val removalSession = store.session()
        syncMutex.withLock {
            withContext(Dispatchers.IO) {
                currentApi.request("/api/chats/$id/delete", JSONObject())
                store.commitChatRemoval(id, removalSession)
            }
            chats = chats.filter { it.optString("id") != id }
            if (selected == id) open("")
        }
        sync()
    }
    fun clearError() { error = "" }
}
