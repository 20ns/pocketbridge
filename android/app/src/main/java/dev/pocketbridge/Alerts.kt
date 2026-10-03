package dev.pocketbridge

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import org.json.JSONObject

/** A chat as the alerts service sees it in /api/state. */
data class ChatStatus(val id: String, val title: String, val status: String, val agent: String = CLAUDE, val preview: String = "", val error: String = "", val activity: String = "")

fun chatStatus(chat: JSONObject) = ChatStatus(
    chat.optString("id"), chat.optString("title").ifBlank { "New chat" }, chat.optString("status"), chat.optString("agent").ifBlank { CLAUDE },
    chat.optString("preview"), chat.optString("error"), chat.optString("activity"),
)

sealed interface AlertEvent { val chat: ChatStatus }
/** Entered waiting: a question, plan or permission needs the owner. */
data class NeedsAnswer(override val chat: ChatStatus) : AlertEvent
/** A chat that was working finished, failed or stopped. */
data class Ended(override val chat: ChatStatus) : AlertEvent
/** Left waiting without ending (answered elsewhere): its question notification goes. */
data class Answered(override val chat: ChatStatus) : AlertEvent

/**
 * What changed worth telling the owner between two looks at the Mac. [previous] holds the last known status per chat;
 * a chat it doesn't know can still need an answer but can't have "finished". The chat on screen is never announced.
 */
fun alertEvents(previous: Map<String, String>, current: List<ChatStatus>, viewing: String): List<AlertEvent> = current.mapNotNull { chat ->
    val before = previous[chat.id]
    when {
        chat.id == viewing -> null
        chat.status == "waiting" && before != "waiting" -> NeedsAnswer(chat)
        before != null && isWorking(before) && chat.status in listOf("idle", "error", "interrupted") -> Ended(chat)
        before == "waiting" && chat.status != "waiting" -> Answered(chat)
        else -> null
    }
}

/** The ongoing notification's title and text: one chat by name and what it's doing, several by count. */
fun workingSummary(chats: List<ChatStatus>): Pair<String, String> {
    val running = chats.filter { it.status == "running" || it.status == "stopping" }
    val waiting = chats.filter { it.status == "waiting" }
    return when {
        running.size == 1 && waiting.isEmpty() -> running[0].title to running[0].activity.ifBlank { if (running[0].status == "stopping") "Stopping" else "Working" }
        running.isNotEmpty() -> "${plural(running.size + waiting.size, "chat")} active" to (running + waiting).joinToString(" · ") { it.title }
        waiting.isNotEmpty() -> "Waiting for your answer" to waiting.joinToString(" · ") { it.title }
        else -> "PocketBridge" to "Checking your Mac"
    }
}

/** The chat an event-stream line says has a new or answered request, so its approvals are read again. */
fun approvalChat(data: String): String? = runCatching { JSONObject(data) }.getOrNull()?.takeIf { it.optString("type") == "approval" }?.optString("chatId")?.ifBlank { null }

/**
 * What became of [approval] after its answer from a notification got no reply, from the chat's messages: null while it
 * still waits or nothing could be read (the actions come back), "" once it's gone, else the line to show.
 */
fun approvalOutcome(messages: JSONObject?, approval: String): String? {
    val list = messages?.optJSONArray("approvals")?.objects() ?: return null
    return when (list.find { it.optString("id") == approval }?.optString("status")) {
        null -> ""
        "allow" -> "Allowed"
        "deny" -> "Denied"
        else -> null
    }
}

fun endedLabel(status: String) = when (status) { "error" -> "Failed"; "interrupted" -> "Stopped"; else -> "Done" }

object Alerts {
    private const val NEEDS = "needs"
    private const val FINISHED = "finished"
    private const val WORKING = "working"
    const val WORKING_ID = 1
    private const val CHAT_ID = 2
    const val ACTION_OPEN = "dev.pocketbridge.OPEN_CHAT"
    const val EXTRA_CHAT = "chat"
    private const val ACTION_ALLOW = "dev.pocketbridge.ALLOW"
    private const val ACTION_DENY = "dev.pocketbridge.DENY"
    private const val EXTRA_APPROVAL = "approval"
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_TEXT = "text"
    private const val EXTRA_BODY = "body"
    // Android 16 reads this extra as a request for a promoted (Live Update) ongoing notification.
    private const val EXTRA_PROMOTED = "android.requestPromotedOngoing"

    /** Process-wide: whether the app is on screen and which chat it shows. */
    @Volatile var foreground = false
    @Volatile var viewing = ""

    fun allowed(context: Context) = context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()

    fun channels(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannels(listOf(
            NotificationChannel(NEEDS, "Needs you", NotificationManager.IMPORTANCE_HIGH).apply { description = "Questions, plans and permission requests" },
            NotificationChannel(FINISHED, "Finished", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "Chats that finish, fail or stop" },
            NotificationChannel(WORKING, "Working", NotificationManager.IMPORTANCE_LOW).apply { description = "Chats working on your Mac while PocketBridge is closed"; setShowBadge(false) },
        ))
    }

    /** Called as the app leaves the screen, which Android 12+ still counts as foreground for starting the service. */
    fun start(context: Context, baseline: Map<String, String>) {
        runCatching { context.startForegroundService(Intent(context, AlertService::class.java).putExtra("baseline", JSONObject(baseline).toString())) }
    }
    // stopService matches the service by component, so a fresh Intent stops the running one.
    @SuppressLint("ImplicitSamInstance")
    fun stop(context: Context) { context.stopService(Intent(context, AlertService::class.java)) }
    fun dismiss(context: Context, chatId: String) { context.getSystemService(NotificationManager::class.java).cancel(chatId, CHAT_ID) }
    /** Every PocketBridge notification, for when alerts go off or the pairing does. */
    fun clear(context: Context) { context.getSystemService(NotificationManager::class.java).cancelAll() }
    /** Allow and Deny only answer while alerts are on and this phone is still paired. */
    fun answerable(store: Store) = store.get("alerts") != "off" && store.get("token").isNotEmpty()

    fun openIntent(context: Context, chatId: String?): PendingIntent = PendingIntent.getActivity(
        context, chatId?.hashCode() ?: 0,
        Intent(context, MainActivity::class.java).setAction(ACTION_OPEN).apply { chatId?.let { putExtra(EXTRA_CHAT, it) } }.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun builder(context: Context, channel: String, chat: ChatStatus) = Notification.Builder(context, channel)
        .setSmallIcon(R.drawable.ic_notification).setColor(context.getColor(R.color.brand_teal))
        .setContentTitle(chat.title).setContentIntent(openIntent(context, chat.id)).setAutoCancel(true).setShowWhen(true)

    fun ended(context: Context, chat: ChatStatus) {
        val body = (if (chat.status == "error") chat.error.ifBlank { chat.preview } else chat.preview).ifBlank { endedLabel(chat.status) }
        notify(context, chat.id, builder(context, FINISHED, chat).setSubText(endedLabel(chat.status)).setContentText(body).setStyle(Notification.BigTextStyle().bigText(body)).build())
    }

    /** A question or plan opens the chat; a permission request can be answered from the notification. [quiet] updates one already shown. */
    fun needsAnswer(context: Context, chat: ChatStatus, approval: JSONObject?, quiet: Boolean = false) {
        val agent = if (chat.agent == CODEX) "Codex" else "Claude"
        val tool = approval?.optString("tool").orEmpty()
        val input = approval?.optJSONObject("input") ?: JSONObject()
        val question = tool == "AskUserQuestion" || input.optJSONArray("questions")?.length()?.let { it > 0 } == true
        val permission = approval != null && !question && tool != "ExitPlanMode"
        val detail = input.optString("command").ifBlank { input.optString("description") }
        val text = when {
            approval == null -> "Needs your answer"
            question -> "$agent has a question"
            tool == "ExitPlanMode" -> "Plan ready to review"
            else -> "Allow $tool?" + if (detail.isNotBlank()) " " + firstLine(detail, 120) else ""
        }
        val body = if (permission && detail.isNotBlank()) "Allow $tool?\n$detail" else text
        if (permission) permission(context, chat, approval!!.optString("id"), text, body, quiet)
        else notify(context, chat.id, builder(context, NEEDS, chat).setSubText("Needs your answer").setContentText(text).setCategory(Notification.CATEGORY_REMINDER)
            .setStyle(Notification.BigTextStyle().bigText(body)).setOnlyAlertOnce(quiet).build())
    }

    /** A permission request with Deny and Allow. [problem] says why the last answer from here didn't reach the Mac. */
    private fun permission(context: Context, chat: ChatStatus, approval: String, text: String, body: String, quiet: Boolean, problem: String = "") {
        val builder = builder(context, NEEDS, chat).setSubText("Needs your answer").setContentText(problem.ifEmpty { text }).setCategory(Notification.CATEGORY_REMINDER)
            .setStyle(Notification.BigTextStyle().bigText(if (problem.isEmpty()) body else "$problem\n$body")).setOnlyAlertOnce(quiet)
            .addAction(action(context, "Deny", ACTION_DENY, approval, chat, text, body)).addAction(action(context, "Allow", ACTION_ALLOW, approval, chat, text, body))
        notify(context, chat.id, builder.build())
    }

    private fun action(context: Context, label: String, decision: String, approval: String, chat: ChatStatus, text: String, body: String): Notification.Action {
        val intent = Intent(context, AlertActionReceiver::class.java).setAction(decision).putExtra(EXTRA_APPROVAL, approval).putExtra(EXTRA_CHAT, chat.id)
            .putExtra(EXTRA_TITLE, chat.title).putExtra(EXTRA_TEXT, text).putExtra(EXTRA_BODY, body)
        val pending = PendingIntent.getBroadcast(context, (approval + decision).hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Action.Builder(null, label, pending).build()
    }

    /** After Allow or Deny: a quiet line that clears itself. */
    internal fun answered(context: Context, chatId: String, title: String, text: String) {
        notify(context, chatId, builder(context, NEEDS, ChatStatus(chatId, title, "waiting")).setContentText(text).setOnlyAlertOnce(true).setTimeoutAfter(5000).build())
    }

    /** The answer from [intent] didn't arrive: the same request again, quietly, with the reason and its actions for another try. */
    internal fun unanswered(context: Context, intent: Intent, problem: String) {
        val (approval, chat) = answer(intent)
        val text = intent.getStringExtra(EXTRA_TEXT).orEmpty().ifBlank { "Needs your answer" }
        permission(context, ChatStatus(chat, title(intent), "waiting"), approval, text, intent.getStringExtra(EXTRA_BODY).orEmpty().ifBlank { text }, quiet = true, problem)
    }

    fun answer(intent: Intent) = Triple(intent.getStringExtra(EXTRA_APPROVAL).orEmpty(), intent.getStringExtra(EXTRA_CHAT).orEmpty(), intent.action == ACTION_ALLOW)
    fun title(intent: Intent) = intent.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { "Chat" }

    /** The ongoing notification the service holds while anything works. One running chat shows its elapsed time. */
    fun working(context: Context, chats: List<ChatStatus>, since: Long?): Notification {
        val (title, text) = workingSummary(chats)
        val single = chats.singleOrNull()?.id
        return Notification.Builder(context, WORKING).setSmallIcon(R.drawable.ic_notification).setColor(context.getColor(R.color.brand_teal))
            .setContentTitle(title).setContentText(text).setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_PROGRESS)
            .setContentIntent(openIntent(context, single)).setStyle(Notification.BigTextStyle().bigText(text))
            .apply {
                if (since != null) { setWhen(since); setUsesChronometer(true); setShowWhen(true) } else setShowWhen(false)
                if (Build.VERSION.SDK_INT >= 36) { setShortCriticalText("Working"); addExtras(android.os.Bundle().apply { putBoolean(EXTRA_PROMOTED, true) }) }
            }.build()
    }

    private fun notify(context: Context, chatId: String, notification: Notification) {
        if (allowed(context)) context.getSystemService(NotificationManager::class.java).notify(chatId, CHAT_ID, notification)
    }
}

/**
 * Watches the Mac while PocketBridge is closed and a chat works: one status-only event stream, a state fetch per
 * burst of changes, backoff on failure. It stops as soon as nothing is running or waiting, alerts go off, or the
 * pairing is gone, so it never sits idle.
 */
class AlertService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var watcher: Job? = null
    private var statuses = mutableMapOf<String, String>()
    private val started = mutableMapOf<String, Long>()
    private var lastSummary: Pair<List<ChatStatus>, Long?>? = null
    /** Waiting chats announced without their approvals (the fetch failed): asked again until Allow and Deny can be added. */
    private val unfetched = mutableSetOf<String>()
    /** Per waiting chat, the request its notification shows; and chats whose requests changed since the last look. */
    private val notified = mutableMapOf<String, String>()
    private val approvalsChanged = ConcurrentHashMap.newKeySet<String>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Alerts.channels(this)
        // Android needs the service in the foreground within seconds of starting it.
        val promoted = runCatching {
            val notification = Alerts.working(this, emptyList(), null)
            if (Build.VERSION.SDK_INT >= 34) startForeground(Alerts.WORKING_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            else startForeground(Alerts.WORKING_ID, notification)
        }.isSuccess
        if (!promoted) { stopSelf(); return START_NOT_STICKY }
        intent?.getStringExtra("baseline")?.let { raw -> runCatching { JSONObject(raw).let { json -> json.keys().forEach { statuses.putIfAbsent(it, json.getString(it)) } } } }
        if (watcher?.isActive != true) watcher = scope.launch { watch() }
        return START_NOT_STICKY
    }

    override fun onDestroy() { scope.cancel(); super.onDestroy() }

    private fun finish(clear: Boolean = false) {
        stopForeground(STOP_FOREGROUND_REMOVE)
        if (clear) Alerts.clear(this)
        stopSelf()
        scope.cancel()
    }

    private fun api(): Api? {
        val store = Store(this)
        if (store.get("alerts") == "off" || !Alerts.allowed(this)) return null
        return runCatching { store.token().takeIf { it.isNotEmpty() }?.let { Api(normalizeServer(store.get("base")), it) } }.getOrNull()
    }

    private suspend fun watch() {
        val api = api() ?: return finish(clear = true)
        var backoff = 2000L
        var failingSince = 0L
        while (currentCoroutineContext().isActive) {
            try {
                val seq = refresh(api) ?: return
                backoff = 2000L; failingSince = 0L
                val changes = Channel<Unit>(Channel.CONFLATED)
                coroutineScope {
                    // Bursts of changes become one state fetch a second. A question still missing its actions asks again a little later.
                    val fetcher = launch {
                        if (unfetched.isNotEmpty()) changes.trySend(Unit)
                        for (change in changes) { delay(if (unfetched.isEmpty()) 1000 else 5000); if (refresh(api) == null) return@launch; if (unfetched.isNotEmpty()) changes.trySend(Unit) }
                    }
                    api.watch(seq, "status") { line ->
                        if (line.startsWith("data:")) { approvalChat(line.removePrefix("data:").trim())?.let(approvalsChanged::add); changes.trySend(Unit) }
                    }
                    fetcher.cancel()
                }
                throw IOException("The event stream closed.")
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                if (failure is ApiError && failure.status == 401) return finish(clear = true)
                val now = System.currentTimeMillis()
                if (failingSince == 0L) failingSince = now
                // A Mac out of reach for a quarter of an hour isn't worth a radio kept awake.
                if (now - failingSince > 15 * 60_000) return finish()
                delay(backoff); backoff = (backoff * 2).coerceAtMost(60_000)
            }
        }
    }

    /** One look at the Mac: posts what changed and updates the ongoing summary. Null once the service has stopped. */
    private suspend fun refresh(api: Api): Long? {
        if (!Alerts.answerable(Store(this))) { finish(clear = true); return null }
        val state = withContext(Dispatchers.IO) { api.request("/api/state") }
        // Alerts may have gone off while that was on its way.
        if (!Alerts.answerable(Store(this))) { finish(clear = true); return null }
        val chats = state.optJSONArray("chats")?.objects().orEmpty().map(::chatStatus)
        val viewing = if (Alerts.foreground) Alerts.viewing else ""
        val events = alertEvents(statuses, chats, viewing)
        for (event in events) when (event) {
            is NeedsAnswer -> announce(api, event.chat, fresh = true)
            is Ended -> Alerts.ended(this, event.chat)
            is Answered -> Alerts.dismiss(this, event.chat.id)
        }
        val waiting = chats.filter { it.status == "waiting" && it.id != viewing }.map { it.id }.toSet()
        unfetched.retainAll(waiting); notified.keys.retainAll(waiting)
        // Still waiting, but on another request (one answered, the next asked between two looks), or still missing its actions.
        val changed = approvalsChanged.toSet().also { approvalsChanged.removeAll(it) }
        for (chat in chats.filter { it.id in waiting && (it.id in unfetched || it.id in changed) && events.none { event -> event.chat.id == it.id } }) announce(api, chat, fresh = false)
        statuses = chats.associate { it.id to it.status }.toMutableMap()
        val active = chats.filter { isWorking(it.status) }
        if (active.isEmpty()) { finish(); return null }
        started.keys.retainAll(active.filter { it.status != "waiting" }.map { it.id }.toSet())
        for (chat in active.filter { it.status == "running" && it.id !in started }) started[chat.id] = turnStart(api, chat.id) ?: System.currentTimeMillis()
        val since = active.singleOrNull()?.let { started[it.id] }
        if (lastSummary != active to since) {
            lastSummary = active to since
            getSystemService(NotificationManager::class.java).notify(Alerts.WORKING_ID, Alerts.working(this, active, since))
        }
        return state.optLong("lastSeq")
    }

    private suspend fun messages(api: Api, chatId: String) = runCatching { withContext(Dispatchers.IO) { api.request("/api/chats/$chatId/messages") } }.getOrNull()
    private suspend fun turnStart(api: Api, chatId: String) = messages(api, chatId)?.let { runningSince(parseTurns(it), null) }
    /**
     * Posts the chat's pending request with its permission actions, once per request. A failed fetch posts a [fresh]
     * one plainly and tries again. A request answered meanwhile takes its notification with it.
     */
    private suspend fun announce(api: Api, chat: ChatStatus, fresh: Boolean) {
        val standIn = chat.id in unfetched
        val messages = messages(api, chat.id)
        if (!Alerts.answerable(Store(this))) return
        if (messages == null) { unfetched += chat.id; if (fresh) Alerts.needsAnswer(this, chat, null); return }
        unfetched -= chat.id
        val approval = messages.optJSONArray("approvals")?.objects()?.lastOrNull { it.optString("status") == "pending" }
        val key = approval?.optString("id").orEmpty()
        if (!fresh && key.isEmpty()) { if (!notified[chat.id].isNullOrEmpty()) { Alerts.dismiss(this, chat.id); notified.remove(chat.id) }; return }
        if (!fresh && notified[chat.id] == key) return
        notified[chat.id] = key
        // A plain notice already stood in for this request: it gains its actions without a second alert.
        Alerts.needsAnswer(this, chat, approval, quiet = !fresh && standIn)
    }
}

/** Allow or Deny from a permission notification, sent straight to the Mac. */
class AlertActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val (approval, chat, allow) = Alerts.answer(intent)
        if (approval.isEmpty() || chat.isEmpty()) return
        val title = Alerts.title(intent)
        val app = context.applicationContext
        val result = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            val token = Store(app).get("token")
            // Alerts off or the pairing changed, now or while the answer was on its way: nothing is put back.
            fun current() = Store(app).let { Alerts.answerable(it) && it.get("token") == token }
            try {
                if (!current()) { Alerts.dismiss(app, chat); return@launch }
                val store = Store(app)
                val api = Api(normalizeServer(store.get("base")), store.token())
                val outcome = try {
                    withTimeout(6000) { api.request("/api/approvals/$approval", JSONObject().put("decision", if (allow) "allow" else "deny")) }
                    if (allow) "Allowed" else "Denied"
                } catch (failure: Exception) {
                    // Answered on another device, or here with only the reply lost: say so rather than ask again.
                    if (failure is ApiError && failure.status == 409) "Already answered"
                    else approvalOutcome(runCatching { withTimeout(3000) { api.request("/api/chats/$chat/messages") } }.getOrNull(), approval)
                }
                when {
                    !current() -> Alerts.dismiss(app, chat)
                    outcome == null -> Alerts.unanswered(app, intent, "Couldn't reach your Mac. Try again.")
                    outcome.isEmpty() -> Alerts.dismiss(app, chat)
                    else -> Alerts.answered(app, chat, title, outcome)
                }
            } catch (failure: Exception) {
                if (current()) Alerts.unanswered(app, intent, "Couldn't reach your Mac. Try again.")
            } finally { result.finish() }
        }
    }
}
