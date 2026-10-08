package dev.pocketbridge

import android.app.Application
import android.net.Uri
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.*
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.sample
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import org.json.JSONObject

private const val PROJECT_ATTEMPT = "newProject"
private const val DELETIONS = "deletions"
private const val PAIR_ATTEMPT = "pairAttempt"

/**
 * The phone's view of the Mac: pairing, the live connection, chats and delivery. Usage, app updates and per-project
 * details live in their own models, reached through [usage], [updates] and [details].
 */
@OptIn(FlowPreview::class)
class BridgeModel(application: Application) : AndroidViewModel(application) {
    private val store = Store(application)
    private val transcripts = TranscriptCache(File(application.filesDir, "transcripts"))
    private var api: Api? = null
    private var session: Job? = null
    private var actionJob: Job? = null
    private var refreshJob: Job? = null
    private var cachedMessagesJob: Job? = null
    private var transcript: JSONObject? = null
    private var transcriptWriteJob: Job? = null
    private var transcriptClearJob: Job? = null
    private val transcriptWrites = ConcurrentHashMap<String, Pair<Api, JSONObject>>()
    private val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    private val pendingSync = AtomicInteger(0)
    /** Cuts the reconnect loop's wait short: a network change, Retry, or a read that reached the Mac. */
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private val backoff = Backoff(1000, 15000)
    private val proof = StreamProof()
    /** Failed connection attempts in a row, and the current attempt with the network it started on. */
    private var failures = 0
    private var failingSince = 0L
    private var attempt: Job? = null
    private var attemptNetwork: android.net.Network? = null
    private var reconcileJob: Job? = null
    private var answerJob: Job? = null
    private var cancelCheck: Job? = null
    /** Cancels whose answer was lost, prompt id to its chat and text: once the Mac says it was cancelled, the text comes back. */
    private val uncertainCancels = mutableMapOf<String, Pair<String, String>>()
    /** The Mac answers GET /api/chats/:id/prompts/:promptId. */
    private var promptStatus = false
    private val syncMutex = Mutex()
    /** State requests started, and per chat the count when its prompt was accepted, so an older snapshot can't close it. */
    private val syncStarts = AtomicLong()
    private val acceptedAt = ConcurrentHashMap<String, Long>()
    var paired by mutableStateOf(false); private set
    /** The live stream is open; reads alone don't make the app online. */
    var online by mutableStateOf(false); private set
    /** The stream was open earlier in this visit, so a gap is a reconnect, not a first connection. */
    var wasOnline by mutableStateOf(false); private set
    var busy by mutableStateOf(false); private set
    /** A Stop or an approval answer on its way; these never wait behind a send or another action. */
    var answering by mutableStateOf(false); private set
    /** Chats whose prompt is on its way to the Mac right now. */
    var sending by mutableStateOf<Set<String>>(emptySet()); private set
    val isSending get() = selected in sending
    var error by mutableStateOf(""); private set
    /** A short confirmation for an action whose result shows up elsewhere, like on the Mac. */
    var notice by mutableStateOf(""); private set
    /** Why the live connection is down; separate from one-off action errors so it can stay visible. */
    var connectionIssue by mutableStateOf(""); private set
    var revoked by mutableStateOf(false); private set
    var refreshing by mutableStateOf(false); private set
    val updates = UpdateModel(application, viewModelScope)
    val usage = UsageModel(store, viewModelScope, { api })
    val details = ProjectDetails(viewModelScope, { api }, IconCache(File(application.cacheDir, "icons")))
    private var transcriptsPrunedAt = 0L
    var projects by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var chats by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var messages by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var messageEntries by mutableStateOf<List<Entry>>(emptyList()); private set
    var approvals by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var agents by mutableStateOf<List<AgentInfo>>(emptyList()); private set
    /** The open chat's turn timing, sub-agents and the agent's own line about what it's doing now. */
    var turns by mutableStateOf<List<Turn>>(emptyList()); private set
    var subagents by mutableStateOf<List<Subagent>>(emptyList()); private set
    var activity by mutableStateOf(""); private set
    var thinking by mutableStateOf(""); private set
    /** The open chat's prompts waiting for their time: prompt id to when each sends. */
    var scheduled by mutableStateOf<Map<String, Long>>(emptyMap()); private set
    /** The Mac can keep a prompt and send it at a plan limit reset. */
    var canSchedule by mutableStateOf(false); private set
    /** The chat whose messages are on screen, from the cache or the Mac; until then an empty transcript means nothing yet. */
    private var loadedChat by mutableStateOf("")
    val transcriptReady get() = loadedChat == selected || chats.none { it.optString("id") == selected }
    /** Images in the open chat's composer. */
    var attachments by mutableStateOf<List<Attachment>>(emptyList()); private set
    private val attachmentLists = mutableMapOf<String, List<Attachment>>()
    private val outbox = File(application.filesDir, "outbox")
    val images = ImageCache(File(application.cacheDir, "images"))
    /** Images shared into PocketBridge, prepared and waiting for a chat to go to. */
    var shared by mutableStateOf<List<String>>(emptyList()); private set
    var sharing by mutableStateOf(false); private set
    private var shareJob: Job? = null
    /** Something outside the app (a notification, a share) asked to show the open chat; cleared once shown. */
    var showChat by mutableStateOf(false); private set
    /** True once a first send should ask for notification permission. */
    var askAlerts by mutableStateOf(false); private set
    var alertsOn by mutableStateOf(store.get("alerts") != "off"); private set
    var claudeAvailable by mutableStateOf(true); private set
    /** Where New project creates folders on the Mac, as the owner sees it ("~/Desktop/experiments"); blank when it can't. */
    var experiments by mutableStateOf(""); private set
    /** Whether this Mac offers Lock, and whether its screen is locked. */
    var mac by mutableStateOf(MacScreen()); private set
    var creatingProject by mutableStateOf(false); private set
    /** Why the last New project attempt failed, shown under its name field. */
    var projectError by mutableStateOf(""); private set
    /** A deleted chat still inside its Undo window: hidden here, deleted on the Mac when the window closes. */
    var deleting by mutableStateOf<Pair<String, String>?>(null); private set
    /** Chats deleted here and not yet confirmed by the Mac, saved so they stay hidden and get sent after a restart. */
    var deletions by mutableStateOf(decodeDeletions(store.get(DELETIONS))); private set
    /** Agent switches on their way to the Mac, shown at once so a tap never waits on the round trip. */
    private var agentSwitching by mutableStateOf<Map<String, Boolean>>(emptyMap())
    /** The launcher's New chat shortcut asked for the panel; cleared once shown, so a rotation can't show it again. */
    var newChatRequested by mutableStateOf(false); private set
    var selected by mutableStateOf(store.get("selected")); private set
    var draft by mutableStateOf(store.get("draft:$selected")); private set
    /** Large pastes in the open chat's composer, held as blocks and sent inside the prompt text. */
    var pastes by mutableStateOf(store.pastes(selected)); private set
    private var draftSave: Job? = null
    var pending by mutableStateOf(loadPending(selected)); private set
    var pairUrl by mutableStateOf(store.get("base"))
    var pairCode by mutableStateOf("")
    /** Options for the open chat's next prompt. */
    var options by mutableStateOf(ChatOptions("bypassPermissions")); private set
    var localDraftIds by mutableStateOf(store.localDraftIds()); private set
    var foreground = false
        private set
    val chat get() = chats.find { it.optString("id") == selected } ?: draftChat(selected)?.json()
    fun agent(id: String?) = agents.find { it.id == (id?.ifBlank { null } ?: CLAUDE) }
    /** Only a chat that hasn't reached the Mac can still move between Claude and Codex. */
    val canSwitchAgent get() = selected.isNotEmpty() && pending == null && chats.none { it.optString("id") == selected }
    init {
        runCatching {
            val token = store.token()
            if (token.isNotEmpty()) {
                paired = true
                runCatching { Api(store.get("base"), token) }.onSuccess { api = it }.onFailure {
                    connectionIssue = "Update your Mac's HTTPS address in Settings. Your pairing and drafts are saved."
                }
            }
            // Transcripts moved to files in 0.5; rewriting them inside preferences made every streamed token expensive.
            store.removePrefixed("messages:")
            store.get("state").takeIf { it.isNotEmpty() }?.let { runCatching { applyState(JSONObject(it)) } }
            applyOptionsFromSelection()
            loadMessages(selected)
            attachments = attachmentsOf(selected)
            Alerts.viewing = selected
            // Prepared images no composer kept, from a share or a crash mid-pick.
            cleanOutbox()
        }.onFailure { error = "Saved pairing could not be read. Pair with your Mac again." }
    }
    private fun loadPending(id: String) = store.get("pending:$id").takeIf { it.isNotEmpty() }?.let {
        runCatching { PendingPrompt.parse(it) }.onFailure { error = "Saved delivery state could not be read. Check this chat on your Mac before sending again." }.getOrNull()
    }
    private fun applyState(state: JSONObject) {
        val wasWorking = chats.filter { isWorking(it.optString("status")) }.map { it.optString("id") }.toSet()
        projects = state.getJSONArray("projects").objects()
        chats = state.getJSONArray("chats").objects().sortedByDescending { it.optLong("updatedAt") }
        // A finished turn used some of the plan; the next look at usage asks again.
        if (chats.any { it.optString("id") in wasWorking && !isWorking(it.optString("status")) }) usage.stale()
        // The open chat's turn ended: its edits change the branch's counts.
        chats.find { it.optString("id") == selected && it.optString("id") in wasWorking && !isWorking(it.optString("status")) }?.let { details.refreshGit(it.optString("projectId"), force = true) }
        details.projectsChanged(projects.mapNotNull { project -> project.textOrNull("icon")?.let { project.optString("id") to it } }.toMap())
        agents = parseAgents(state.optJSONObject("capabilities")).map { agent -> agentSwitching[agent.id]?.let { agent.copy(enabled = it) } ?: agent }
        claudeAvailable = state.optJSONObject("server")?.optBoolean("claudeAvailable", true) ?: true
        canSchedule = state.optJSONObject("capabilities")?.optBoolean("scheduledPrompts") == true
        promptStatus = state.optJSONObject("capabilities")?.optBoolean("promptStatus") == true
        // The open chat stopped on an error, maybe its plan limit: usage says when that resets.
        if (chats.any { it.optString("id") == selected && it.optString("id") in wasWorking && it.optString("status") == "error" }) usage.refresh()
        experiments = state.optJSONObject("server")?.textOrNull("experiments").orEmpty()
        mac = parseMacScreen(state)
        val pendingId = pending?.id
        if (pendingId != null && pendingId !in Alerts.inFlight && store.get("pending:$selected").isEmpty()) {
            attachmentLists.remove(selected)
            pending = null; loadDraft(selected); attachments = attachmentsOf(selected); applyOptionsFromSelection()
            cleanOutbox()
        }
    }
    private fun draftChat(id: String) = store.get("draftChat:$id").takeIf { it.isNotEmpty() }?.let {
        runCatching { DraftChat.parse(id, it) }.onFailure { store.remove("draftChat:$id") }.getOrNull()
    }
    private fun optionOverride(id: String) = store.get("options:$id").takeIf { it.isNotEmpty() }?.let {
        runCatching { ChatOptions.parse(it) }.onFailure { store.remove("options:$id") }.getOrNull()
    }
    private fun lastOptions(agent: String) = store.get("lastOptions:$agent").takeIf { it.isNotEmpty() }?.let { runCatching { ChatOptions.parse(it) }.getOrNull() }
    /** New chats start from the last model, effort and mode used with that agent. */
    private fun rememberOptions(next: ChatOptions) { store.put("lastOptions:${next.agent}", next.store()); store.put("lastAgent", next.agent) }
    private fun optionsFrom(chat: JSONObject?) = chat?.let(::chatOptions)
    private fun applyOptionsFromSelection() {
        // An unconfirmed prompt keeps exactly what it was sent with; anything else drops an effort the model lacks.
        options = pending?.options
            ?: (draftChat(selected)?.options ?: optionOverride(selected) ?: optionsFrom(chat))?.let { supportedOptions(agent(it.agent), it) }
            ?: ChatOptions("bypassPermissions")
    }
    private fun refreshDraftIds() { localDraftIds = store.localDraftIds() }
    private fun discardEmptyDraft(id: String) {
        if (id.isNotEmpty() && draftChat(id) != null && loadPending(id) == null && store.get("draft:$id").isBlank() && store.get("pastes:$id").isEmpty() && attachmentsOf(id).isEmpty()) {
            store.removeChat(id)
            refreshDraftIds()
        }
    }
    private fun loadMessages(id: String) {
        cachedMessagesJob?.cancel()
        transcript = null
        messages = emptyList(); messageEntries = emptyList(); approvals = emptyList(); turns = emptyList(); subagents = emptyList(); activity = ""; thinking = ""; scheduled = emptyMap(); loadedChat = ""
        if (id.isEmpty()) return
        val cacheSession = store.session()
        val latest = transcriptWrites[id]?.takeIf { api === it.first }?.second
        cachedMessagesJob = viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                val snapshot = latest ?: transcripts.read(id).takeIf { it.isNotEmpty() }?.let { saved ->
                    runCatching { JSONObject(saved) }.getOrNull()
                }
                snapshot?.let {
                    runCatching {
                        snapshot to transcript(snapshot.getJSONArray("messages").objects().map(::said))
                    }.getOrNull()
                }
            }
            if (result != null && selected == id && store.session() == cacheSession) {
                runCatching { applyMessages(result.first, result.second); loadedChat = id }
            }
        }
    }
    private fun applyMessages(result: JSONObject, entries: List<Entry>) {
        transcript = result
        messageEntries = entries
        messages = result.getJSONArray("messages").objects(); approvals = result.optJSONArray("approvals")?.objects().orEmpty()
        turns = parseTurns(result); subagents = parseSubagents(result)
        activity = if (result.isNull("activity")) "" else result.optString("activity")
        thinking = if (result.isNull("thinking")) "" else result.optString("thinking")
        scheduled = scheduledPrompts(result)
    }
    /** A saved cursor always travels with its full transcript. Streaming snapshots coalesce; final replies flush now. */
    private fun cacheTranscript(id: String, result: JSONObject, flush: Boolean = false) {
        val currentApi = api ?: return
        transcriptWrites[id] = currentApi to result
        writeTranscripts(flush)
    }
    private fun writeTranscripts(flush: Boolean) {
        if (flush) transcriptWriteJob?.cancel()
        else if (transcriptWriteJob?.isActive == true) return
        transcriptWriteJob = viewModelScope.launch {
            if (!flush) delay(5000)
            withContext(Dispatchers.IO) {
                transcriptClearJob?.join()
                transcriptWrites.entries.toList().forEach { (id, snapshot) ->
                    ensureActive()
                    if (api === snapshot.first && transcriptWrites[id] === snapshot) {
                        transcripts.write(id, snapshot.second.toString()) { api === snapshot.first && transcriptWrites[id] === snapshot }
                    }
                    transcriptWrites.remove(id, snapshot)
                }
            }
        }
    }
    fun open(id: String) {
        if (id != selected) writeTranscripts(flush = true)
        flushDraft()
        if (id != selected) discardEmptyDraft(selected)
        selected = id; store.put("selected", id); Alerts.viewing = id
        if (attachmentLists[id].orEmpty().none { it.preparing || it.state == UploadState.Uploading }) attachmentLists.remove(id)
        loadDraft(id); pending = loadPending(id); applyOptionsFromSelection(); loadMessages(id); attachments = attachmentsOf(id)
        if (id.isNotEmpty()) { Alerts.dismiss(getApplication(), id); usage.refresh() }
        refresh()
    }
    private fun loadDraft(id: String) { draft = store.get("draft:$id"); pastes = store.pastes(id) }
    /** Typing shows at once and saves a moment later, so a long draft isn't rewritten to disk on every key. */
    fun editDraft(text: String) { draft = text; saveDraftSoon() }
    fun addPaste(text: String) { if (pending == null && selected.isNotEmpty()) { pastes = pastes + Paste(UUID.randomUUID().toString(), text); saveDraftSoon() } }
    fun editPaste(key: String, text: String) { if (pending == null && pastes.any { it.key == key }) { pastes = pastes.map { if (it.key == key) it.copy(text = text) else it }; saveDraftSoon() } }
    fun removePaste(key: String) { if (pending == null && pastes.any { it.key == key }) { pastes = pastes.filter { it.key != key }; saveDraftSoon() } }
    private fun saveDraftSoon() {
        val id = selected; val text = draft; val blocks = pastes; val session = store.session()
        draftSave?.cancel()
        draftSave = viewModelScope.launch { delay(400); if (store.session() == session) store.saveDraft(id, text, blocks) }
    }
    /** Writes a draft still waiting for its save now: before switching chats, sending or leaving the app. */
    private fun flushDraft() {
        if (draftSave?.isActive != true) return
        draftSave?.cancel()
        if (selected.isNotEmpty()) store.saveDraft(selected, draft, pastes)
    }
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
        // One attempt id per Mac and code, saved before asking: if the answer is lost, asking again (now, by tapping
        // Pair, or after the app was killed) gets the same token instead of finding the one-time code used.
        // Pairing clears every preference, this one too.
        val attempt = pairAttemptId(store.get(PAIR_ATTEMPT), base, code) ?: UUID.randomUUID().toString()
        val request = JSONObject().put("code", code).put("attempt", attempt)
        val token = withContext(Dispatchers.IO) {
            store.commit(PAIR_ATTEMPT, pairAttemptValue(base, code, attempt), pairingSession)
            val answer = try { Api(base).request("/api/pair", request) }
            catch (lost: java.io.IOException) { if (lost is ApiError) throw lost; delay(1500); Api(base).request("/api/pair", request) }
            answer.getString("token").also { store.savePair(base, it, pairingSession) }
        }
        api = Api(base, token); paired = true; pairCode = ""; connectionIssue = ""; revoked = false
        projects = emptyList(); chats = emptyList(); messages = emptyList(); approvals = emptyList(); selected = ""; draft = ""; pastes = emptyList(); pending = null; localDraftIds = emptyList(); options = ChatOptions("bypassPermissions")
        forgetPairingData()
        if (foreground) start()
    }
    fun disconnect() {
        // The client goes first so a sync already on the IO thread can't write this pairing's transcript again.
        api = null; actionJob?.cancel(); answerJob?.cancel(); refreshJob?.cancel(); cachedMessagesJob?.cancel(); stopConnection(); store.clear()
        transcriptClearJob = viewModelScope.launch(Dispatchers.IO) { syncMutex.withLock { transcripts.clear() } }
        paired = false; online = false; usage.clear(); selected = ""; messages = emptyList(); chats = emptyList(); projects = emptyList(); draft = ""; pastes = emptyList(); pending = null; localDraftIds = emptyList(); error = ""; connectionIssue = ""; revoked = false
        forgetPairingData()
        Alerts.stop(getApplication()); Alerts.clear(getApplication())
    }
    /** Repair this Mac's address without discarding pairing, drafts or uncertain delivery IDs. */
    fun updateAddress(address: String) = action {
        require(paired) { "Pair with your Mac first." }
        val addressSession = store.session()
        val next = Api(normalizeServer(address), store.token())
        withContext(Dispatchers.IO) {
            try { next.request("/api/state").also { it.getJSONArray("projects"); it.getJSONArray("chats") } }
            catch (failure: java.io.IOException) { throw IllegalArgumentException(failureReason(failure), failure) }
            store.commit("base", next.base, addressSession)
        }
        refreshJob?.cancel(); stopConnection(); Alerts.stop(getApplication())
        api = next; pairUrl = next.base; connectionIssue = ""; revoked = false
        if (foreground) start() else startAlerts()
    }
    /** Mac-specific caches belong to one pairing. */
    private fun forgetPairingData() {
        draftSave?.cancel(); transcriptWriteJob?.cancel(); transcriptWriteJob = null; transcriptWrites.clear(); messageEntries = emptyList()
        transcript = null; loadedChat = ""
        cancelShare()
        Alerts.deliveries.clear(); Alerts.inFlight.clear()
        turns = emptyList(); subagents = emptyList(); activity = ""; thinking = ""; scheduled = emptyMap(); canSchedule = false; attachments = emptyList(); attachmentLists.clear(); shared = emptyList()
        details.clear(); acceptedAt.clear(); alertsOn = true; uncertainCancels.clear(); sending = emptySet()
        deleting = null; deletions = emptyMap(); agentSwitching = emptyMap(); experiments = ""; mac = MacScreen(); projectError = ""; newChatRequested = false; showChat = false
        viewModelScope.launch(Dispatchers.IO) { outbox.deleteRecursively(); images.clear() }
    }
    fun foreground(active: Boolean) {
        if (!active) { writeTranscripts(flush = true); flushDraft() }
        foreground = active; Alerts.foreground = active
        if (active) freshState = false
        if (active && paired) start() else if (!active) stopConnection()
    }
    private fun stopConnection() { session?.cancel(); session = null; attempt = null; online = false; wasOnline = false }
    private fun start() {
        if (api == null || session?.isActive == true) return
        backoff.reset(); failures = 0
        session = viewModelScope.launch {
            launch {
                changes.sample(250).collect {
                    val kinds = pendingSync.getAndSet(0)
                    if (kinds != 0) runCatching { sync(kinds and SYNC_STATE != 0, kinds and SYNC_MESSAGES != 0) }.onFailure {
                        // Still owed: the next change or keepalive reads it again, and so does the next connection.
                        pendingSync.getAndUpdate { owed -> owed or kinds }
                        fail(it)
                    }
                }
            }
            launch { networkChanges(getApplication()).collect { networkChanged() } }
            while (isActive && paired) {
                val currentApi = api ?: break
                if (!hasNetwork(getApplication())) {
                    // Nothing to try until Android has a network again; its callback (or Retry) wakes this loop.
                    online = false; connectionIssue = NO_NETWORK
                    if (failures == 0) { failures = 1; failingSince = System.currentTimeMillis() }
                    wake.receive()
                    continue
                }
                wake.tryReceive()
                attemptNetwork = activeNetwork(getApplication())
                var failure: Exception? = null
                attempt = launch {
                    try { connect(currentApi) } catch (cancelled: CancellationException) { throw cancelled } catch (problem: Exception) { failure = problem }
                }.also { it.join() }
                online = false
                // Only a stream that stayed up starts the count and backoff over; a proxy dropping it at once doesn't.
                if (proof.take(android.os.SystemClock.elapsedRealtime())) { failures = 0; backoff.reset() }
                // No failure: the attempt was dropped for a new network or Retry, so the next one starts now.
                val problem = failure ?: continue
                if (failures++ == 0) failingSince = System.currentTimeMillis()
                connectionIssue(problem, failures, System.currentTimeMillis() - failingSince, hasNetwork(getApplication())).let { connectionIssue = it; revoked = it == REVOKED }
                wake.waitOr(backoff.take())
            }
        }
    }
    /**
     * One connection: state first, then the stream. The open chat's transcript is read over the sync path once the
     * stream is open, so a long one on a slow network can't keep the stream from opening.
     */
    private suspend fun connect(currentApi: Api): Unit = coroutineScope {
        val seq = sync(fetchMessages = false)
        if (api !== currentApi || seq < 0) return@coroutineScope
        val opened = CompletableDeferred<Unit>()
        val onOpen = launch { opened.await(); streamOpened(currentApi) }
        try {
            currentApi.watch(seq, onOpen = { opened.complete(Unit) }) { line ->
                proof.line(line)
                if (line.startsWith("data:")) { pendingSync.getAndUpdate { it or syncKind(line.removePrefix("data:").trim(), selected) }; changes.tryEmit(Unit) }
                // A keepalive retries reads still owed from a failure.
                else if (line.startsWith(":") && pendingSync.get() != 0) changes.tryEmit(Unit)
            }
        } finally { onOpen.cancel() }
        throw java.io.IOException("The connection to your Mac closed.")
    }
    private fun streamOpened(currentApi: Api) {
        if (api !== currentApi) return
        online = true; wasOnline = true; connectionIssue = ""; revoked = false
        proof.opened(android.os.SystemClock.elapsedRealtime())
        // The stream starts at the state snapshot's sequence. Messages are read now and owed until that read succeeds,
        // so no change before that sequence is missed (the transcript's own cursor carries the rest).
        pendingSync.getAndUpdate { it or SYNC_MESSAGES }; changes.tryEmit(Unit)
        // A lookup stalled on the old network could outlive its stream and leave a prompt unsent: this one starts afresh.
        val stale = reconcileJob
        reconcileJob = viewModelScope.launch { stale?.cancelAndJoin(); reconcilePrompts(currentApi) }
        retryFailedUploads()
    }
    /** Pooled sockets belong to the old network; an attempt on a network that went can only time out, so it restarts. */
    private fun networkChanged() {
        api?.evictConnections()
        if (activeNetwork(getApplication()) != attemptNetwork) restartStream()
        else if (!online) wake.trySend(Unit)
    }
    private fun restartStream() { attempt?.cancel(); wake.trySend(Unit) }
    /**
     * Reconciles with the Mac. While a reply streams, only the open chat's messages are fetched. Answers the state's
     * event sequence, or -1 without a state read (or when the pairing changed meanwhile).
     */
    private suspend fun sync(fetchState: Boolean = true, fetchMessages: Boolean = true): Long = syncMutex.withLock {
        val currentApi = api ?: return@withLock -1L
        val id = selected
        val deliverySession = store.session()
        var lastSeq = -1L
        if (fetchState) {
            val generation = syncStarts.incrementAndGet()
            val (state, stateCache) = withContext(Dispatchers.IO) { currentApi.request("/api/state").let { it to it.toString() } }
            if (api !== currentApi) return@withLock -1L
            lastSeq = state.optLong("lastSeq")
            val previous = chat
            val followOptions = pending == null && draftChat(id) == null && optionOverride(id) == null && (previous == null || options == optionsFrom(previous)?.let { supportedOptions(agent(it.agent), it) })
            applyState(state); settleAlertDeliveries(generation); store.put("state", stateCache)
            freshState = true
            // Transcripts of chats deleted from another client go too, checked every ten minutes at most.
            if (System.currentTimeMillis() - transcriptsPrunedAt > 10 * 60_000) {
                transcriptsPrunedAt = System.currentTimeMillis()
                val listed = chats.map { it.optString("id") }.toSet()
                transcriptWrites.keys.retainAll(listed)
                withContext(Dispatchers.IO) { transcripts.keepOnly(listed) }
            }
            val server = chats.find { it.optString("id") == id }
            if (pending == null && optionOverride(id) != null && optionOverride(id) == optionsFrom(server)) store.remove("options:$id")
            // Only the chat this sync looked for closes, and only when the snapshot is newer than its first prompt.
            if (id.isNotEmpty() && selected == id && pending == null && chatGone(chats.any { it.optString("id") == id }, draftChat(id) != null, generation, acceptedAt[id])) {
                open("")
                return@withLock lastSeq
            }
            if (followOptions && server != null) applyOptionsFromSelection()
        }
        if (fetchMessages && id.isNotEmpty() && chats.any { it.optString("id") == id }) {
            val previous = transcript.takeIf { loadedChat == id }
            val previousEntries = messageEntries
            val since = previous?.textOrNull("cursor")?.let { "?since=" + java.net.URLEncoder.encode(it, "UTF-8") }.orEmpty()
            val (result, entries) = withContext(Dispatchers.IO) {
                val response = currentApi.request("/api/chats/$id/messages$since")
                val unchanged = previous != null && !response.optBoolean("full", true) && response.getJSONArray("messages").length() == 0
                val merged = mergeTranscript(previous, response)
                merged to if (unchanged) previousEntries else transcript(merged.getJSONArray("messages").objects().map(::said))
            }
            if (api !== currentApi) return@withLock -1L
            val lastTurn = parseTurns(result).lastOrNull()
            val ended = lastTurn?.endedAt != null && lastTurn != previous?.let(::parseTurns)?.lastOrNull()
            cacheTranscript(id, result, flush = selected != id || !isWorking(chats.find { it.optString("id") == id }?.optString("status")) || ended)
            if (selected == id) {
                cachedMessagesJob?.cancel()
                applyMessages(result, entries); loadedChat = id
                // Accepted, but the answer to its POST was lost: settle it exactly as a confirmed send would, never resend.
                pending?.takeIf { deliveredPrompt(messages, it.id) }?.let { prompt -> completeAccepted(id, prompt, deliverySession) }
            }
        }
        // A read proves the pairing; the banner otherwise clears only once the stream opens, so it can't flicker.
        if (revoked) { revoked = false; connectionIssue = "" }
        if (fetchState && deletions.isNotEmpty()) sendLeftoverDeletions()
        if (fetchState && uncertainCancels.isNotEmpty() && cancelCheck?.isActive != true) cancelCheck = viewModelScope.launch { checkCancels(currentApi) }
        lastSeq
    }
    fun refresh() {
        if (!paired) return
        // Navigation replaces the previous refresh instead of queuing redundant full transcripts behind live sync.
        refreshJob?.cancel()
        refreshJob = viewModelScope.launch {
            try {
                sync()
                // The Mac answered: the reconnect loop needn't sit out its backoff.
                if (!online) wake.trySend(Unit)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { pendingSync.getAndUpdate { it or SYNC_STATE or SYNC_MESSAGES }; fail(failure) }
        }
    }
    /** User-initiated: sync now, or start the next connection attempt at once instead of waiting out the backoff. */
    fun retry() {
        if (!paired || refreshing) return
        refreshing = true
        viewModelScope.launch {
            try {
                if (online) sync()
                else { if (session?.isActive == true) restartStream() else if (foreground) start(); withTimeoutOrNull(8000) { snapshotFlow { online }.first { it } } }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { error = failureReason(failure) }
            finally { refreshing = false }
        }
    }
    /**
     * A read beside the stream failed. The stream watches itself (keepalives, pings), so a healthy one stays and the
     * read stays owed; the reconnect loop reports a lost connection. A revoked pairing goes through the loop to say so.
     */
    private fun fail(failure: Throwable) {
        if (failure is CancellationException) return
        if (failure !is ApiError) return
        if (failure.status == 401) restartStream()
        else if (online && failure.status != 404) error = failureReason(failure)
    }
    private fun action(block: suspend () -> Unit) {
        if (busy) return
        busy = true; error = ""
        actionJob = viewModelScope.launch {
            try { block() } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { report(failure) }
            finally { busy = false }
        }
    }
    /** Stop and approval answers go at once, even while a send or another action still waits on the Mac. */
    private fun answer(block: suspend () -> Unit) {
        if (answering) return
        answering = true; error = ""
        answerJob = viewModelScope.launch {
            try { block() } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { report(failure) }
            finally { answering = false }
        }
    }
    /** An action's failure is its own error. A lost connection only nudges the reconnect loop; a healthy stream stays. */
    private fun report(failure: Exception) {
        error = failureReason(failure)
        if (failure is java.io.IOException && failure !is ApiError && !online) wake.trySend(Unit)
    }
    fun visibleDrafts() = listedDrafts(localDraftIds.mapNotNull { id ->
        val saved = store.get("draftChat:$id")
        if (saved.isEmpty()) return@mapNotNull null
        val draft = runCatching { DraftChat.parse(id, saved) }.getOrNull() ?: return@mapNotNull null
        val pendingRaw = store.get("pending:$id")
        val typed = store.get("draft:$id").ifBlank { store.pastes(id).firstOrNull()?.text.orEmpty() }
        val text = typed.ifBlank { pendingRaw.takeIf { it.isNotEmpty() }?.let { runCatching { PendingPrompt.parse(it).text }.getOrNull() }.orEmpty() }
        ListedDraft(draft.id, draft.projectId, text, pendingRaw.isNotEmpty(), draft.createdAt, draft.agent, attachmentsOf(id).size)
    })
    fun discardDraft(id: String) {
        if (store.get("pending:$id").isNotEmpty() || draftChat(id) == null || chats.any { it.optString("id") == id }) return
        removeDraft(id)
    }
    private fun removeDraft(id: String) {
        if (selected == id) draftSave?.cancel()
        Alerts.deliveries.remove(id)
        store.removeChat(id)
        attachmentLists.remove(id)
        refreshDraftIds()
        if (selected == id) open("")
        cleanOutbox()
    }
    fun newChat(projectId: String) {
        val id = UUID.randomUUID().toString()
        val agentId = newChatAgent(agents, store.get("lastAgent")) ?: return
        val start = agent(agentId)?.let { resolveOptions(it, lastOptions(agentId)) } ?: lastOptions(agentId) ?: ChatOptions("bypassPermissions")
        store.put("draftChat:$id", DraftChat.of(id, projectId, start, System.currentTimeMillis()).store())
        refreshDraftIds()
        open(id)
    }
    /** Applies to the next prompt; while Claude works it waits for that turn to end. Saved chats keep their agent. */
    fun updateOptions(next: ChatOptions) {
        if (pending != null || busy || selected.isEmpty()) return
        val local = draftChat(selected)
        val server = chats.find { it.optString("id") == selected }
        if (local == null && server != null && next.agent != (server.optString("agent").ifBlank { CLAUDE })) return
        options = next
        if (local != null) store.put("draftChat:$selected", DraftChat.of(selected, local.projectId, next, local.createdAt).store())
        else if (server != null) { if (next == optionsFrom(server)) store.remove("options:$selected") else store.put("options:$selected", next.store()) }
        rememberOptions(next)
    }
    /** "Send at <time>" for the open chat's next prompt, when its agent's limit reset is known. */
    val scheduleOffer: ScheduleOffer? get() {
        val chat = chat
        return scheduleOffer(
            canSchedule, usage.agents.find { it.id == options.agent }?.limits.orEmpty(), System.currentTimeMillis(), modelName(agent(options.agent), options.model),
            chat?.optString("status"), chat?.textOrNull("error"), chatScheduled(chat) != null,
        )
    }
    /**
     * Sends the draft and its images, or retries the unconfirmed prompt exactly as saved. While a turn runs, [delivery]
     * steers it (the default) or interrupts it. [schedule] ("reset") has the Mac send it later instead. Both are saved
     * with the delivery id.
     */
    fun send(delivery: String? = null, schedule: String? = null) {
        val currentApi = api ?: return
        val id = selected
        if (id in sending) return
        error = ""
        val prompt = try { nextPrompt(id, delivery, schedule) } catch (problem: IllegalArgumentException) { error = problem.message.orEmpty(); return }
        askForAlerts()
        val deliverySession = store.session()
        // Its own job, not an action: Stop, approvals and the rest stay usable while the Mac takes its time to answer.
        viewModelScope.launch {
            try { deliver(currentApi, id, prompt, deliverySession, save = true); refresh() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { if (api === currentApi) report(failure) }
        }
    }
    /** The open chat's unconfirmed prompt as saved, or a new one from the composer. */
    private fun nextPrompt(id: String, delivery: String?, schedule: String?): PendingPrompt {
        require(id.isNotEmpty()) { "Open a chat first." }
        require(pending != null || store.get("pending:$id").isEmpty()) { "Saved delivery state could not be read. Check this chat on your Mac before sending again." }
        // The saved draft must match what goes out, so acceptance can clear exactly that from the composer.
        flushDraft()
        val chosen = options
        val images = attachmentsOf(id)
        if (pending == null) require(images.all { it.state == UploadState.Ready }) { "Wait for the images to upload, or remove the ones that failed." }
        val working = isWorking(chats.find { it.optString("id") == id }?.optString("status"))
        // A chosen delivery goes as chosen: the Mac runs it as a normal turn if the chat turns out idle.
        val prompt = pending ?: PendingPrompt(
            UUID.randomUUID().toString(), promptText(draft, pastes), chosen.mode, chosen.model, chosen.effort, draftChat(id)?.projectId.orEmpty(), chosen.agent,
            images.map { it.upload }, if (schedule != null) null else delivery ?: if (working) STEER else null, chosen.speed, schedule,
        )
        require(prompt.text.isNotEmpty() || prompt.attachments.isNotEmpty()) { "Write a prompt first." }
        return prompt
    }
    /**
     * Posts [prompt] under its delivery id and settles the answer: Send and Retry ([save] commits a new one first), and
     * the resend after a reconnect. Timeouts and proxy failures may follow execution, so they keep the id for Retry.
     * Runs up to its first suspension at once, so the composer shows the prompt as sending before the next tap.
     */
    private suspend fun deliver(currentApi: Api, id: String, prompt: PendingPrompt, deliverySession: Int, save: Boolean) {
        if (!Alerts.inFlight.add(prompt.id)) return
        acceptedAt.remove(id)
        val watch = DeliveryWatch(prompt.id, System.currentTimeMillis() + DELIVERY_WATCH_MILLIS)
        // A scheduled prompt starts no turn now, so background alerts have nothing to wait for.
        if (prompt.schedule == null) Alerts.deliveries[id] = watch
        sending = sending + id
        // A resend shows in the composer only while the store still holds it, so a settled or deleted prompt stays gone.
        if (selected == id && (save || savedPromptId(id) == prompt.id)) pending = prompt
        try {
            if (save) withContext(Dispatchers.IO) { store.savePrompt(id, prompt, watch.until, deliverySession) }
            if (api !== currentApi) return
            withContext(Dispatchers.IO) {
                val result = currentApi.request("/api/chats/$id/prompts", prompt.json())
                check(result.optBoolean("accepted")) { "The Mac did not confirm delivery. Retry with the same prompt ID." }
            }
            if (api !== currentApi) return
            completeAccepted(id, prompt, deliverySession)
        } catch (failure: ApiError) {
            if (api !== currentApi) return
            if (failure.definitiveRejection) {
                notAccepted(id, prompt, deliverySession, chatDeleted = failure.status == 410)
                // The Mac lost an image this prompt named: upload the local copies again so the next send has them.
                if (lostUpload(failure)) {
                    attachmentsOf(id).filter { it.upload in prompt.attachments }.forEach { upload(id, it.key) }
                    throw ApiError(failure.status, "An image was no longer on your Mac. It's uploading again; send once it's ready.")
                }
            } else if (failure.status >= 500 && failure.fromMac) {
                // The service itself refused (not installed, shutting down): its ledger says whether it kept the prompt.
                val status = orNull { withContext(Dispatchers.IO) { deliveryStatus(currentApi, id, prompt.id, promptStatus) } }
                if (status != null && api === currentApi && !settle(id, prompt, deliverySession, status)) notAccepted(id, prompt, deliverySession, chatDeleted = false)
                if (status?.optBoolean("accepted") == true) return
            }
            throw failure
        } finally {
            Alerts.inFlight.remove(prompt.id)
            sending = sending - id
            if (store.get("pending:$id").isEmpty() && acceptedAt[id] == null) Alerts.deliveries.remove(id, watch)
        }
    }
    /** Settles [prompt] by the Mac's ledger. Answers false when the Mac never recorded it and the chat still exists. */
    private suspend fun settle(id: String, prompt: PendingPrompt, deliverySession: Int, status: JSONObject) = when {
        status.optBoolean("accepted") -> { completeAccepted(id, prompt, deliverySession); true }
        status.optBoolean("deleted") -> { notAccepted(id, prompt, deliverySession, chatDeleted = true); true }
        else -> false
    }
    private suspend fun completeAccepted(id: String, prompt: PendingPrompt, deliverySession: Int) {
        withContext(Dispatchers.IO) { store.completePrompt(id, prompt, deliverySession, accepted = true) }
        // Settled here or already elsewhere (the alerts service); a newer prompt saved since keeps its place.
        if (store.get("pending:$id").isEmpty()) accepted(id, prompt)
    }
    /** The Mac refused [prompt] for good: its text returns to the composer. A deleted chat's unsent draft goes too, so a retry can't recreate it. */
    private suspend fun notAccepted(id: String, prompt: PendingPrompt, deliverySession: Int, chatDeleted: Boolean) {
        Alerts.deliveries[id]?.takeIf { it.promptId == prompt.id }?.let { Alerts.deliveries.remove(id, it) }
        withContext(Dispatchers.IO) { store.completePrompt(id, prompt, deliverySession, accepted = false) }
        if (selected == id && pending?.id == prompt.id) pending = null
        if (chatDeleted && draftChat(id) != null) {
            store.remove("draftChat:$id")
            if (selected == id) open("")
        }
    }
    /**
     * After a reconnect: settles every saved prompt, in any chat, by the Mac's ledger, and sends a recent one it never
     * recorded once more under the same id. The Mac checks that id before and after any wait, so it runs at most once.
     */
    private suspend fun reconcilePrompts(currentApi: Api) {
        if (!promptStatus) return
        val deliverySession = store.session()
        for ((id, prompt) in withContext(Dispatchers.IO) { store.pendingPrompts() }) {
            if (prompt.id in Alerts.inFlight || id in deletions) continue
            val status = orNull { withContext(Dispatchers.IO) { deliveryStatus(currentApi, id, prompt.id, true) } } ?: continue
            if (api !== currentApi) return
            if (prompt.id in Alerts.inFlight || settle(id, prompt, deliverySession, status)) continue
            if (!resendable(prompt, store.get("watch:$id").toLongOrNull(), System.currentTimeMillis())) continue
            // The lookup took time: a deletion, a Retry or a settled prompt since then wins over this resend.
            if (id in deletions || id in sending || prompt.id in Alerts.inFlight || savedPromptId(id) != prompt.id) continue
            try { deliver(currentApi, id, prompt, deliverySession, save = false) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { if (selected == id && api === currentApi) error = failureReason(failure) }
        }
    }
    private fun savedPromptId(id: String) = runCatching { PendingPrompt.parse(store.get("pending:$id")).id }.getOrNull()
    /** Cancels whose answer was lost: a prompt the Mac did cancel puts its text back, as a confirmed cancel would. */
    private suspend fun checkCancels(currentApi: Api) {
        for ((promptId, target) in uncertainCancels.toList()) {
            val (id, text) = target
            val status = orNull { withContext(Dispatchers.IO) { currentApi.request("/api/chats/$id/prompts/$promptId") } } ?: continue
            if (api !== currentApi) return
            uncertainCancels.remove(promptId)
            if (status.optJSONObject("schedule")?.optString("state") == "cancelled") restoreCancelled(id, text)
        }
    }
    /** A cancelled prompt's text goes back into the open chat's composer while it's empty; long text as a pasted block. */
    private fun restoreCancelled(id: String, text: String) {
        if (selected == id) draftAfterCancel(draft, pastes, attachments.isNotEmpty(), pending != null, text)?.let { if (isLargePaste(it)) addPaste(it) else editDraft(it) }
    }
    /** After the Mac accepted [prompt], by its answer or by the transcript: the composer lets go of it. */
    private fun accepted(id: String, prompt: PendingPrompt) {
        acceptedAt[id] = syncStarts.get()
        rememberOptions(prompt.options)
        attachmentLists.remove(id)
        if (selected == id && (pending == null || pending?.id == prompt.id)) { pending = null; loadDraft(id); attachments = attachmentsOf(id) }
        cleanOutbox()
    }
    /** A state request begun after acceptance can safely hand this chat back to its reported status. */
    private fun settleAlertDeliveries(generation: Long) {
        if (foreground) acceptedAt.forEach { (id, accepted) -> if (generation > accepted) Alerts.deliveries.remove(id) }
    }
    /**
     * Turns an agent CLI on or off on the Mac for every client. Off stops its probes, discovery and new turns. The
     * switch moves at once; a refusal puts it back with the reason.
     */
    fun setAgentEnabled(id: String, on: Boolean) {
        val currentApi = api ?: return
        if (id in agentSwitching) return
        agentSwitching = agentSwitching + (id to on)
        agents = agents.map { if (it.id == id) it.copy(enabled = on) else it }
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { currentApi.request("/api/agents/$id", JSONObject().put("enabled", on)) }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                // Put the switch back now; the state fetch below may fail too.
                if (api === currentApi) { agents = agents.map { if (it.id == id) it.copy(enabled = !on) else it }; error = failureReason(failure) }
            }
            finally {
                agentSwitching = agentSwitching - id
                if (api === currentApi) { usage.stale(); runCatching { sync() }; usage.refresh(force = true) }
            }
        }
    }

    /**
     * Creates an empty folder in the Mac's experiments folder and opens a new chat in it. The attempt's id is saved
     * before sending and reused by a retry of the same name, so a lost answer never makes a second folder.
     */
    fun createProject(name: String) {
        val currentApi = api ?: return
        if (creatingProject) return
        val problem = projectNameProblem(name)
        if (problem != null) { projectError = problem; return }
        val session = store.session()
        creatingProject = true; projectError = ""
        viewModelScope.launch {
            val attempt = projectAttempt(store.get(PROJECT_ATTEMPT), name.trim())
            try {
                val project = withContext(Dispatchers.IO) {
                    store.commit(PROJECT_ATTEMPT, attempt.store(), session)
                    currentApi.request("/api/projects/new", JSONObject().put("id", attempt.id).put("name", attempt.name))
                }
                store.removeIfSame(PROJECT_ATTEMPT, attempt.store(), session)
                if (api !== currentApi) return@launch
                runCatching { sync() }
                newChat(project.getString("id"))
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                // A refusal (bad name, folder exists, no experiments folder) is final; anything else may have made it.
                if (failure is ApiError && failure.definitiveRejection) store.removeIfSame(PROJECT_ATTEMPT, attempt.store(), session)
                if (api === currentApi) projectError = failureReason(failure)
            } finally { creatingProject = false }
        }
    }
    fun clearProjectError() { projectError = "" }

    /** The launcher's New chat shortcut: Projects with its new chat panel open. */
    fun requestNewChat() { if (paired) { if (selected.isNotEmpty()) open(""); newChatRequested = true } }
    fun newChatShown() { newChatRequested = false }
    fun chatShown() { showChat = false }
    /** The open chat is on screen: its finished or question notification has done its job. */
    fun chatSeen() { if (selected.isNotEmpty()) Alerts.dismiss(getApplication(), selected) }

    /** Settings for this phone's lists (filters, sorts, the open project); they go with the pairing. */
    fun uiSetting(key: String) = store.get("ui:$key")
    fun saveUiSetting(key: String, value: String) { if (store.get("ui:$key") != value) store.put("ui:$key", value) }

    /**
     * Hides the chat now and offers Undo; the Mac deletes it when the window closes. The deletion is saved first, so
     * process death inside the window still deletes it at the next launch. One Undo window at a time.
     */
    fun deleteWithUndo(id: String, title: String) {
        commitDeletion()
        saveDeletions(deletions + (id to title))
        if (selected == id) open("")
        deleting = id to title
    }
    fun undoDelete() {
        val (id, _) = deleting ?: return
        deleting = null
        saveDeletions(deletions - id)
    }
    /** The Undo window closed, or the app really left the screen: delete for real, waiting out any action in flight. */
    fun commitDeletion() {
        val (id, _) = deleting ?: return
        deleting = null
        sendDeletion(id)
    }
    /** The app left the screen for real (not a rotation): an open Undo window ends now. */
    fun leaving() = commitDeletion()
    private val sendingDeletions = mutableSetOf<String>()
    private fun sendDeletion(id: String) {
        if (!sendingDeletions.add(id)) return
        viewModelScope.launch {
            try {
                snapshotFlow { busy || id in sending }.first { !it }
                if (chats.any { it.optString("id") == id }) delete(id) else deleteUnlisted(id)
            } finally { sendingDeletions -= id }
        }
    }
    /**
     * A chat the last state read didn't list: a local draft, or one whose first prompt was accepted since. Deleting
     * it on the Mac leaves a tombstone, so a first prompt still on its way can't create it afterwards. A Mac before
     * tombstones answers 404 and its prompt ledger decides. Unreachable, it stays hidden and goes at the next state read.
     */
    private suspend fun deleteUnlisted(id: String) {
        val currentApi = api ?: return
        val removalSession = store.session()
        try { withContext(Dispatchers.IO) { currentApi.request("/api/chats/$id/delete", JSONObject()) } }
        catch (failure: ApiError) {
            if (api !== currentApi) return
            if (failure.status == 404) { if (store.get("pending:$id").isNotEmpty()) orNull { settleDeletedDraft(id) } else { discardDraft(id); forgetDeletion(id) } }
            // Its first prompt already runs there: the chat comes back with the reason, as for any working chat.
            else if (deletionSettled(failure)) { forgetDeletion(id); error = failureReason(failure); refresh() }
            return
        }
        catch (lost: java.io.IOException) { return }
        if (api !== currentApi) return
        // A state read meanwhile may have listed it (its first prompt landed): that row and its cache go too.
        orNull { withContext(Dispatchers.IO) { store.commitChatRemoval(id, removalSession) } }
        chats = chats.filter { it.optString("id") != id }
        removeDraft(id); forgetDeletion(id)
    }
    /**
     * A deleted local chat whose first prompt may have reached the Mac. It stays in [deletions], so it's never resent,
     * until the Mac's ledger says: accepted, the new chat is deleted there too; never recorded, it's dropped here.
     */
    private suspend fun settleDeletedDraft(id: String) {
        val currentApi = api ?: return
        val session = store.session()
        val prompt = runCatching { PendingPrompt.parse(store.get("pending:$id")) }.getOrNull() ?: return
        val status = orNull { withContext(Dispatchers.IO) { deliveryStatus(currentApi, id, prompt.id, promptStatus) } } ?: return
        if (api !== currentApi || id !in deletions || id in sending) return
        if (!status.optBoolean("accepted")) { removeDraft(id); forgetDeletion(id); return }
        completeAccepted(id, prompt, session)
        snapshotFlow { busy }.first { !it }
        delete(id)
    }
    /** Deletions saved before a restart (or a lost connection) go to the Mac once it answers again. */
    private fun sendLeftoverDeletions() {
        deletions.keys.filter { it != deleting?.first }.forEach(::sendDeletion)
    }
    private fun forgetDeletion(id: String) { if (id in deletions) saveDeletions(deletions - id) }
    private fun saveDeletions(next: Map<String, String>) {
        deletions = next
        if (next.isEmpty()) store.remove(DELETIONS) else store.put(DELETIONS, encodeDeletions(next))
    }
    /**
     * Cancels a prompt still waiting for its time. Its text comes back to an empty composer, so editing one is cancel,
     * change, send; long text comes back as a pasted block. Safe to repeat: the Mac answers a cancelled prompt the same way.
     */
    fun cancelScheduled(promptId: String, text: String) = action {
        val currentApi = api ?: return@action
        val id = selected
        try { withContext(Dispatchers.IO) { currentApi.request("/api/chats/$id/prompts/$promptId/cancel", JSONObject()) } }
        catch (failure: java.io.IOException) {
            // The Mac may have cancelled it and lost only the answer: the next state read asks, so the text isn't lost.
            if (failure !is ApiError) uncertainCancels[promptId] = id to text
            throw failure
        }
        if (api !== currentApi) return@action
        restoreCancelled(id, text)
        refresh()
    }
    /** Sends a scheduled prompt now, or right after the turn running in its chat. */
    fun sendScheduledNow(promptId: String) = action {
        val currentApi = api ?: return@action
        withContext(Dispatchers.IO) { currentApi.request("/api/chats/$selected/prompts/$promptId/send-now", JSONObject()) }
        refresh()
    }
    fun stop() = answer {
        val currentApi = api ?: return@answer
        val id = selected
        withContext(Dispatchers.IO) { currentApi.request("/api/chats/$id/stop", JSONObject()) }
        refresh()
    }
    fun decide(id: String, allow: Boolean, answers: JSONObject) = answer {
        val currentApi = api ?: return@answer
        try { withContext(Dispatchers.IO) { currentApi.request("/api/approvals/$id", JSONObject().put("decision", if (allow) "allow" else "deny").apply { if (answers.length() > 0) put("answers", answers) }) } }
        // No longer pending: answered already, perhaps by this phone's earlier try whose reply was lost. Settled either way.
        catch (failure: ApiError) { if (failure.status != 409) throw failure }
        refresh()
    }
    /** Hands a Claude chat to Claude Desktop on the Mac, the way the CLI's /desktop does. */
    fun openInDesktop(id: String) = action {
        val currentApi = api ?: return@action
        withContext(Dispatchers.IO) { currentApi.request("/api/chats/$id/desktop", JSONObject()) }
        notice = "Opened in Claude Desktop on your Mac"
    }
    /** Locks the Mac's screen at once, for when it was left unlocked. Work on the Mac keeps running. */
    fun lockMac() = action {
        val currentApi = api ?: return@action
        val locked = withContext(Dispatchers.IO) { currentApi.request("/api/mac/lock", JSONObject()) }.lockedOrNull()
        mac = mac.copy(locked = locked)
        notice = if (locked == true) "Mac locked" else "Lock sent to your Mac"
    }
    fun rename(id: String, title: String) = action {
        val currentApi = api ?: return@action
        require(title.trim().isNotEmpty()) { "Name the chat first." }
        withContext(Dispatchers.IO) { currentApi.request("/api/chats/$id/rename", JSONObject().put("title", title.trim())) }
        refresh()
    }
    fun delete(id: String) = action {
        val currentApi = api ?: return@action
        val chat = chats.find { it.optString("id") == id }
        if (isWorking(chat?.optString("status"))) { forgetDeletion(id); error("Stop this chat before deleting it.") }
        val removalSession = store.session()
        try {
            syncMutex.withLock {
                withContext(Dispatchers.IO) {
                    currentApi.request("/api/chats/$id/delete", JSONObject())
                    store.commitChatRemoval(id, removalSession)
                    transcriptWrites.remove(id)
                    transcripts.remove(id)
                }
                chats = chats.filter { it.optString("id") != id }
                attachmentLists.remove(id)
                if (selected == id) open("")
            }
        } catch (failure: Exception) {
            // Refused: the chat comes back with the reason. Unreachable: it stays hidden and goes at the next connection.
            if (deletionSettled(failure)) forgetDeletion(id)
            throw failure
        }
        forgetDeletion(id)
        refresh()
    }
    fun clearError() { error = "" }
    fun clearNotice() { notice = "" }

    // Images in the composer. Every change saves the list for its chat, so a picked screenshot survives process death.
    private fun attachmentsOf(id: String): List<Attachment> = if (id.isEmpty()) emptyList() else attachmentLists.getOrPut(id) { decodeAttachments(store.get("attachments:$id")) }
    private fun setAttachments(id: String, list: List<Attachment>) {
        attachmentLists[id] = list
        if (list.isEmpty()) store.remove("attachments:$id") else store.put("attachments:$id", encodeAttachments(list))
        if (id == selected) attachments = list
    }
    private fun updateAttachment(id: String, key: String, change: (Attachment) -> Attachment) {
        val list = attachmentsOf(id)
        if (list.any { it.key == key }) setAttachments(id, list.map { if (it.key == key) change(it) else it })
    }
    /** Picked images: each is downscaled on an IO thread, shown at once and uploaded as soon as it's ready. */
    fun attach(uris: List<Uri>) {
        val id = selected
        if (id.isEmpty() || pending != null || uris.isEmpty()) return
        val room = MAX_ATTACHMENTS - attachmentsOf(id).size
        if (room <= 0) { error = "Up to $MAX_ATTACHMENTS images per message."; return }
        if (uris.size > room) error = "Added $room. Up to $MAX_ATTACHMENTS images per message."
        val resolver = getApplication<Application>().contentResolver
        val preparationApi = api
        uris.take(room).forEach { uri ->
            val key = UUID.randomUUID().toString()
            val file = File(outbox, "$key.jpg")
            setAttachments(id, attachmentsOf(id) + Attachment(key, file.path, state = UploadState.Uploading, preparing = true))
            viewModelScope.launch {
                val prepared = prepareImages(listOf(file)) { _, out -> prepareImage(resolver, uri, out) }
                if (api !== preparationApi) { withContext(Dispatchers.IO) { file.delete() }; return@launch }
                if (prepared.isNotEmpty()) { updateAttachment(id, key) { it.copy(preparing = false) }; upload(id, key) }
                else { setAttachments(id, attachmentsOf(id).filter { it.key != key }); error = "That image couldn't be read." }
            }
        }
    }
    private fun attachPrepared(id: String, files: List<String>) {
        val room = MAX_ATTACHMENTS - attachmentsOf(id).size
        if (files.size > room) error = if (room > 0) "Added $room. Up to $MAX_ATTACHMENTS images per message." else "Up to $MAX_ATTACHMENTS images per message."
        files.take(room.coerceAtLeast(0)).forEach { path ->
            val key = File(path).nameWithoutExtension
            setAttachments(id, attachmentsOf(id) + Attachment(key, path, state = UploadState.Uploading))
            upload(id, key)
        }
    }
    private fun upload(chatId: String, key: String) {
        val currentApi = api
        val file = attachmentsOf(chatId).find { it.key == key }?.file
        if (currentApi == null || file == null) { updateAttachment(chatId, key) { it.copy(state = UploadState.Failed) }; return }
        // The old id is dropped first and saved so: a restart mid-upload finds Retry, not an id the Mac may not have.
        updateAttachment(chatId, key) { it.copy(upload = "", state = UploadState.Uploading) }
        viewModelScope.launch {
            try {
                val (uploaded, bytes) = withContext(Dispatchers.IO) {
                    val bytes = File(file).readBytes()
                    currentApi.upload(bytes, "image/jpeg").getString("id") to bytes
                }
                if (api !== currentApi) return@launch
                // The transcript shows this image straight from disk once it's sent.
                withContext(Dispatchers.IO) { images.put(uploaded, bytes) }
                updateAttachment(chatId, key) { it.copy(upload = uploaded, state = UploadState.Ready) }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                updateAttachment(chatId, key) { it.copy(state = UploadState.Failed) }
                // Offline already has its banner; the tile shows Retry either way.
                if (chatId == selected && online) error = "An image didn't upload. " + failureReason(failure)
            }
        }
    }
    fun retryAttachment(key: String) { if (pending == null) upload(selected, key) }
    /** Images that failed while the Mac was out of reach go again once the stream is back. */
    private fun retryFailedUploads() {
        for ((id, list) in attachmentLists.toMap()) {
            if (store.get("pending:$id").isNotEmpty()) continue
            list.filter { it.state == UploadState.Failed && !it.preparing }.forEach { upload(id, it.key) }
        }
    }
    fun removeAttachment(key: String) {
        val id = selected
        if (pending != null) return
        setAttachments(id, attachmentsOf(id).filter { it.key != key })
        cleanOutbox()
    }
    /** Prepared files no composer or share holds any more. */
    private fun cleanOutbox() {
        val keep = shared.toSet()
        viewModelScope.launch(Dispatchers.IO) {
            val used = store.attachmentFiles() + keep
            outbox.listFiles().orEmpty().filter { it.path !in used && System.currentTimeMillis() - it.lastModified() > 60_000 }.forEach { it.delete() }
        }
    }
    /** Bytes of an upload, on disk once fetched. Null when the Mac can't send it. */
    suspend fun uploadFile(id: String): File? {
        val cached = images.file(id)
        if (cached.isFile) return cached
        val currentApi = api ?: return null
        return runCatching {
            withContext(Dispatchers.IO) { images.put(id, currentApi.bytes("/api/uploads/$id")) }
            cached.takeIf { it.isFile }
        }.getOrNull()
    }

    // Sharing images into PocketBridge from another app.
    fun receiveShare(uris: List<Uri>) {
        if (!paired || uris.isEmpty() || sharing) return
        sharing = true
        val resolver = getApplication<Application>().contentResolver
        val preparationApi = api
        val files = uris.take(MAX_ATTACHMENTS).map { File(outbox, UUID.randomUUID().toString() + ".jpg") }
        shareJob = viewModelScope.launch {
            try {
                val prepared = prepareImages(files) { index, out -> prepareImage(resolver, uris[index], out) }
                if (api !== preparationApi) return@launch
                if (prepared.isEmpty()) error = "Those images couldn't be read."
                if (uris.size > MAX_ATTACHMENTS) error = "Shared the first $MAX_ATTACHMENTS images."
                shared = prepared
            } finally {
                val keep = shared.toSet()
                withContext(NonCancellable + Dispatchers.IO) { files.filter { it.path !in keep }.forEach { it.delete(); File(it.path + ".tmp").delete() } }
                if (shareJob == currentCoroutineContext()[Job]) sharing = false
            }
        }
    }
    /** Opens [chatId], or a new chat in [projectId], with the shared images attached and uploading. */
    fun shareTo(chatId: String?, projectId: String) {
        val files = shared
        if (files.isEmpty()) return
        if (chatId != null && store.get("pending:$chatId").isNotEmpty()) { error = "This chat is waiting for your Mac to confirm. Try again once it has."; return }
        if (chatId == null) {
            val before = selected
            newChat(projectId)
            if (selected == before) { error = "Claude and Codex are both off. Turn one on in Settings."; return }
        } else open(chatId)
        if (selected.isEmpty() || pending != null) { error = "This chat is waiting for your Mac to confirm. Try again once it has."; return }
        attachPrepared(selected, files)
        shared = emptyList()
        cleanOutbox()
        showChat = true
    }
    fun cancelShare() { shareJob?.cancel(); shareJob = null; sharing = false; shared = emptyList(); cleanOutbox() }

    /** A tapped notification: show that chat. */
    fun openFromAlert(chatId: String) {
        if (!paired || chatId.isEmpty()) return
        if (chatId != selected) open(chatId) else Alerts.dismiss(getApplication(), chatId)
        showChat = true
    }

    // Background alerts.
    private fun notificationsAllowed() = Alerts.allowed(getApplication())
    /** First send on Android 13+: ask once, so alerts can work when the app closes. */
    private fun askForAlerts() {
        if (Build.VERSION.SDK_INT >= 33 && store.get("alertsAsked").isEmpty() && store.get("alerts") != "off" && !notificationsAllowed()) askAlerts = true
    }
    fun alertsAsked(granted: Boolean) {
        askAlerts = false
        store.put("alertsAsked", "1")
        if (granted) setAlerts(true)
    }
    fun setAlerts(on: Boolean) {
        alertsOn = on
        store.put("alerts", if (on) "on" else "off")
        // Allow and Deny on a notification left behind would still answer for this phone.
        if (!on) { Alerts.stop(getApplication()); Alerts.clear(getApplication()) }
    }
    val alertsActive get() = alertsOn && notificationsAllowed()
    /** Android refused to start the alerts service the last time the app was left. */
    fun alertsBlocked() = store.alertsBlocked() != null
    /** The chat list came from the Mac since the app last came back, not only from the cache. */
    private var freshState = false
    /** Leaving the app with work running hands the watch to the alerts service, with what each chat was doing. */
    fun startAlerts() {
        if (!paired || !alertsActive) return
        // A question the owner wasn't looking at when leaving still gets its notification; the one on screen was seen.
        // A cached list may be out of date, so its work may be over already: that can't be announced as finished.
        val baseline = chats.filter { isWorking(it.optString("status")) }.associate { chat ->
            val id = chat.optString("id")
            id to chat.optString("status").let { if (!freshState) UNKNOWN else if (it == "waiting" && id != selected) "running" else it }
        }.toMutableMap()
        // A chat deleted here is never watched, even with a send still unsettled.
        Alerts.deliveries.keys.removeAll(deletions.keys)
        // A prompt still on its way will start a turn the Mac hasn't reported yet.
        watchedDeliveries(store.pendingPrompts().filterKeys { it !in deletions }).forEach { (id, prompt) -> Alerts.deliveries.putIfAbsent(id, DeliveryWatch(prompt.id, store.get("watch:$id").toLongOrNull() ?: 0)) }
        Alerts.deliveries.keys.forEach { baseline.putIfAbsent(it, "sending") }
        // A prompt the Mac holds for the reset gets a look soon after it goes, so its turn still alerts.
        Alerts.watchScheduled(getApplication(), chats.mapNotNull { chat -> chatScheduled(chat)?.let { (prompt, at) -> chat.optString("id") to ScheduledPrompt(prompt, at) } }.toMap())
        if (baseline.isNotEmpty()) Alerts.start(getApplication(), baseline)
    }

    /** Forks a Mac session into a new chat and opens it; the original session keeps its history. */
    fun continueSession(projectId: String, session: MacSession) = action {
        val currentApi = api ?: return@action
        val chat = withContext(Dispatchers.IO) { currentApi.request("/api/chats/continue", JSONObject().put("projectId", projectId).put("agent", session.agent).put("sessionId", session.id)) }
        if (api !== currentApi) return@action
        // Opening refreshes; a failing read there says so without calling this fork a failure.
        open(chat.getString("id"))
        details.forgetSession(projectId, session.id)
    }
}
