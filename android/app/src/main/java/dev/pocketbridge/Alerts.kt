package dev.pocketbridge

import android.annotation.SuppressLint
import android.app.ForegroundServiceStartNotAllowedException
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import java.io.File
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import org.json.JSONObject

/** A chat as the alerts service sees it in /api/state. [project] is its project's name ("General" for General); [scheduled] the prompt it holds for later. */
data class ChatStatus(
    val id: String, val title: String, val status: String, val agent: String = CLAUDE, val preview: String = "", val error: String = "", val activity: String = "",
    val project: String = "", val scheduled: String? = null,
)

fun chatStatus(chat: JSONObject, projects: Map<String, String> = emptyMap()) = ChatStatus(
    chat.optString("id"), chat.optString("title").ifBlank { "New chat" }, chat.optString("status"), chat.optString("agent").ifBlank { CLAUDE },
    chat.optString("preview"), chat.optString("error"), chat.optString("activity"), projects[chat.optString("projectId")].orEmpty(),
    chat.optJSONObject("scheduled")?.textOrNull("id"),
)

fun chatStatuses(state: JSONObject): List<ChatStatus> {
    val projects = state.optJSONArray("projects")?.objects().orEmpty().associate { it.optString("id") to it.optString("name") }
    return state.optJSONArray("chats")?.objects().orEmpty().map { chatStatus(it, projects) }
}

sealed interface AlertEvent { val chat: ChatStatus }
/** Entered waiting: a question, plan or permission needs the owner. */
data class NeedsAnswer(override val chat: ChatStatus) : AlertEvent
/** A chat that was working finished, failed or stopped. */
data class Ended(override val chat: ChatStatus) : AlertEvent
/** Left waiting without ending (answered elsewhere): its question notification goes. */
data class Answered(override val chat: ChatStatus) : AlertEvent

/**
 * What changed worth telling the owner between two looks at the Mac. [previous] holds the last known status per chat;
 * a chat it doesn't know (or knows as [UNKNOWN]) can still need an answer but can't have "finished". A prompt on its
 * way ("sending") or held for later ([SCHEDULED]) counts as a turn once [delivered] proves it started, so one that
 * ended before the first look still finished. The chat on screen is never announced.
 */
fun alertEvents(previous: Map<String, String>, current: List<ChatStatus>, viewing: String, delivered: Set<String> = emptySet()): List<AlertEvent> = current.mapNotNull { chat ->
    val before = previous[chat.id].let { if ((it == "sending" || it == SCHEDULED) && chat.id in delivered) "running" else it }
    when {
        chat.id == viewing -> null
        chat.status == "waiting" && before != "waiting" -> NeedsAnswer(chat)
        before != null && isWorking(before) && chat.status in listOf("idle", "error", "interrupted") -> Ended(chat)
        before == "waiting" && chat.status != "waiting" -> Answered(chat)
        else -> null
    }
}

/** The chat an event-stream line says has a new or answered request, so its approvals are read again. */
fun approvalChat(data: String): String? = runCatching { JSONObject(data) }.getOrNull()?.takeIf { it.optString("type") == "approval" }?.optString("chatId")?.ifBlank { null }

/** An event-stream line saying the cursor was too old: changes in between are gone, so everything is read again. */
fun streamReset(data: String) = runCatching { JSONObject(data).optBoolean("reset") }.getOrDefault(false)

/** The newest request still waiting in a chat's messages. */
fun pendingApproval(messages: JSONObject?): JSONObject? = messages?.optJSONArray("approvals")?.objects()?.lastOrNull { it.optString("status") == "pending" }

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

fun endedLabel(status: String) = when (status) { "error" -> "Failed"; "interrupted" -> "Interrupted"; else -> "Done" }

/** A grace period for late acceptance, never a new execution attempt. Saved pending IDs remain available for Retry. */
data class DeliveryWatch(val promptId: String, val until: Long)
const val DELIVERY_WATCH_MILLIS = 120_000L
fun awaitingDelivery(watch: DeliveryWatch, inFlight: Boolean, now: Long) = inFlight || now < watch.until

/** A background read that fails to null, except when its coroutine is cancelled: that still ends the caller. */
internal suspend fun <T> orNull(read: suspend () -> T): T? =
    try { read() } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { null }

/** New Macs answer from the ledger; old Macs need one transcript lookup. This read never resends a prompt. */
internal suspend fun deliveryStatus(api: Api, chatId: String, promptId: String, supportsStatus: Boolean): JSONObject {
    if (supportsStatus) return api.request("/api/chats/$chatId/prompts/$promptId")
    return try {
        val snapshot = api.request("/api/chats/$chatId/messages")
        JSONObject().put("accepted", deliveredPrompt(snapshot.getJSONArray("messages").objects(), promptId))
    } catch (failure: ApiError) {
        if (failure.status != 404) throw failure
        JSONObject().put("accepted", false)
    }
}

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
    const val ACTION_STOP = "dev.pocketbridge.STOP"
    const val ACTION_LIVE_DISMISSED = "dev.pocketbridge.LIVE_DISMISSED"
    private const val EXTRA_APPROVAL = "approval"
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_TEXT = "text"
    private const val EXTRA_BODY = "body"
    // Android 16 reads this extra as a request for a promoted (Live Update) ongoing notification.
    private const val EXTRA_PROMOTED = "android.requestPromotedOngoing"

    /** Process-wide: whether the app is on screen and which chat it shows. */
    @Volatile var foreground = false
    @Volatile var viewing = ""
    /** The owner swiped the working notification away: it isn't put back until the service starts again. */
    @Volatile var liveDismissed = false
    /** The alerts service is running in this process; the catch-up job leaves the watching to it. */
    @Volatile var watching = false
    /** Prompts sent from any chat, kept through ambiguous delivery and acceptance before the next state snapshot. */
    val deliveries = ConcurrentHashMap<String, DeliveryWatch>()
    val inFlight = ConcurrentHashMap.newKeySet<String>()

    fun allowed(context: Context) = context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()
    /** Android 16 and later: Live Updates are off for PocketBridge, so work shows as a plain ongoing notification. */
    fun liveUpdatesOff(context: Context) = Build.VERSION.SDK_INT >= 36 && !context.getSystemService(NotificationManager::class.java).canPostPromotedNotifications()

    fun channels(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannels(listOf(
            NotificationChannel(NEEDS, "Needs you", NotificationManager.IMPORTANCE_HIGH).apply { description = "Questions, plans and permission requests" },
            NotificationChannel(FINISHED, "Finished", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "Chats that finish, fail or stop" },
            NotificationChannel(WORKING, "Working", NotificationManager.IMPORTANCE_LOW).apply { description = "Chats working on your Mac while PocketBridge is closed"; setShowBadge(false) },
        ))
    }

    /**
     * Called as the app leaves the screen, which Android 12+ still counts as foreground for starting the service. A
     * refusal from there (battery restrictions) is saved for Settings; the catch-up job ([fromApp] false) expects them.
     */
    fun start(context: Context, baseline: Map<String, String>, fromApp: Boolean = true): Boolean = try {
        context.startForegroundService(Intent(context, AlertService::class.java).putExtra("baseline", encodeStatuses(baseline)))
        true
    } catch (failure: Exception) {
        if (fromApp) {
            val store = Store(context)
            if (Build.VERSION.SDK_INT >= 31 && failure is ForegroundServiceStartNotAllowedException) store.markAlertsBlocked(true)
            // Unwatched, the work still gets the catch-up job's slower looks.
            store.saveAlertBaseline(baseline)
            planCatchUp(context, unwatched = true)
        }
        false
    }
    /** The app is back on screen, or alerts or the pairing went: the service stops and nothing waits to look later. */
    // stopService matches the service by component, so a fresh Intent stops the running one.
    @SuppressLint("ImplicitSamInstance")
    fun stop(context: Context) { context.stopService(Intent(context, AlertService::class.java)); forgetBackground(context) }
    /** Prompts the Mac holds for later, from the chats as the app left them: a job looks soon after each goes. */
    fun watchScheduled(context: Context, prompts: Map<String, ScheduledPrompt>) {
        Store(context).saveScheduledAlerts(prompts)
        planCatchUp(context, unwatched = false)
    }
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

    /**
     * A question or plan opens the chat; a permission request can be answered from the notification. [quiet] updates
     * one already shown, as does a request whose notification is still up (leaving the app again doesn't buzz).
     */
    fun needsAnswer(context: Context, chat: ChatStatus, approval: JSONObject?, quiet: Boolean = false) {
        val key = approval?.optString("id").orEmpty()
        val showing = asking(context, chat.id)
        val silent = quiet || showing != null && (approval == null || showing == key)
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
        if (permission) permission(context, chat, key, text, body, silent)
        else notify(context, chat.id, builder(context, NEEDS, chat).setSubText("Needs your answer").setContentText(text).setCategory(Notification.CATEGORY_REMINDER)
            .setStyle(Notification.BigTextStyle().bigText(body)).setOnlyAlertOnce(silent).addExtras(Bundle().apply { putString(EXTRA_APPROVAL, key) }).build())
    }

    /** The request a chat's "Needs your answer" notification still shows ("" for one without its request), or null when none is up. */
    internal fun asking(context: Context, chatId: String): String? = runCatching {
        context.getSystemService(NotificationManager::class.java).activeNotifications.find {
            it.tag == chatId && it.id == CHAT_ID && it.notification.channelId == NEEDS && it.notification.category == Notification.CATEGORY_REMINDER
        }?.notification?.extras?.getString(EXTRA_APPROVAL, "")
    }.getOrNull()

    /**
     * A chat still waiting, read again: if its request isn't the one its notification shows (answered, and the next
     * asked), the notification follows, so Allow and Deny never answer an old one. A stand-in without actions gains them quietly.
     */
    fun requestChanged(context: Context, chat: ChatStatus, approval: JSONObject?) {
        val showing = asking(context, chat.id) ?: return
        val key = approval?.optString("id").orEmpty()
        if (key == showing) return
        if (key.isEmpty()) dismiss(context, chat.id) else needsAnswer(context, chat, approval, quiet = showing.isEmpty())
    }

    /** A permission request with Deny and Allow. [problem] says why the last answer from here didn't reach the Mac. */
    private fun permission(context: Context, chat: ChatStatus, approval: String, text: String, body: String, quiet: Boolean, problem: String = "") {
        val builder = builder(context, NEEDS, chat).setSubText("Needs your answer").setContentText(problem.ifEmpty { text }).setCategory(Notification.CATEGORY_REMINDER)
            .setStyle(Notification.BigTextStyle().bigText(if (problem.isEmpty()) body else "$problem\n$body")).setOnlyAlertOnce(quiet)
            .addExtras(Bundle().apply { putString(EXTRA_APPROVAL, approval) })
            .addAction(action(context, "Deny", ACTION_DENY, approval, chat, text, body)).addAction(action(context, "Allow", ACTION_ALLOW, approval, chat, text, body))
        notify(context, chat.id, builder.build())
    }

    private fun action(context: Context, label: String, decision: String, approval: String, chat: ChatStatus, text: String, body: String): Notification.Action {
        val intent = Intent(context, AlertActionReceiver::class.java).setAction(decision).putExtra(EXTRA_APPROVAL, approval).putExtra(EXTRA_CHAT, chat.id)
            .putExtra(EXTRA_TITLE, chat.title).putExtra(EXTRA_TEXT, text).putExtra(EXTRA_BODY, body)
        return Notification.Action.Builder(null, label, broadcast(context, intent, (approval + decision).hashCode())).build()
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

    /**
     * The ongoing notification the service holds while anything works. The timer is a chronometer from the turn's start,
     * so it ticks without reposting. On Android 16 running work asks to be a Live Update (lock screen, top of the shade
     * and a status bar chip showing the timer, or the count for several chats); elsewhere it's a plain ongoing one.
     */
    fun working(context: Context, notice: LiveNotice): Notification {
        val details = notice.lines.joinToString("\n").ifEmpty { notice.text }
        return Notification.Builder(context, WORKING).setSmallIcon(R.drawable.ic_notification).setColor(context.getColor(R.color.brand_teal))
            .setContentTitle(notice.title).setContentText(notice.text).setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_PROGRESS)
            .setContentIntent(openIntent(context, notice.chatId))
            .setDeleteIntent(broadcast(context, Intent(context, AlertActionReceiver::class.java).setAction(ACTION_LIVE_DISMISSED), 0))
            .apply {
                if (notice.folder.isNotEmpty()) setSubText(notice.folder)
                if (notice.since != null) { setWhen(notice.since); setUsesChronometer(true); setShowWhen(true) } else setShowWhen(false)
                // Before Android 12 an action can't ask for an unlocked phone, so Stop stays in the app there.
                if (notice.stoppable && notice.chatId != null && Build.VERSION.SDK_INT >= 31) addAction(stopAction(context, notice.chatId, notice.title))
                if (Build.VERSION.SDK_INT >= 36 && notice.promoted) {
                    // API 36 has no builder method for this yet; Android 16 reads the extra.
                    addExtras(Bundle().apply { putBoolean(EXTRA_PROMOTED, true) })
                    notice.chip?.let(::setShortCriticalText)
                    setStyle(if (notice.lines.isEmpty()) Notification.ProgressStyle().setProgressIndeterminate(true) else Notification.BigTextStyle().bigText(details))
                } else setStyle(Notification.BigTextStyle().bigText(details))
            }.build()
    }

    /** In place of the working notification once the service gave up: quiet, and gone once the Mac answers again. */
    fun unreachable(context: Context) {
        if (!allowed(context)) return
        context.getSystemService(NotificationManager::class.java).notify(WORKING_ID, Notification.Builder(context, WORKING)
            .setSmallIcon(R.drawable.ic_notification).setColor(context.getColor(R.color.brand_teal)).setContentTitle("Can't reach your Mac")
            .setContentText("You'll get an alert when a chat finishes or needs you.").setContentIntent(openIntent(context, null)).setAutoCancel(true).build())
    }
    fun reachable(context: Context) { if (!watching) context.getSystemService(NotificationManager::class.java).cancel(WORKING_ID) }

    /** Stop asks for an unlocked phone, so a pocket or a passer-by can't end the owner's work from the lock screen. */
    @RequiresApi(31)
    private fun stopAction(context: Context, chatId: String, title: String): Notification.Action {
        val intent = Intent(context, AlertActionReceiver::class.java).setAction(ACTION_STOP).putExtra(EXTRA_CHAT, chatId).putExtra(EXTRA_TITLE, title)
        return Notification.Action.Builder(null, "Stop", broadcast(context, intent, (chatId + ACTION_STOP).hashCode())).setAuthenticationRequired(true).build()
    }

    private fun broadcast(context: Context, intent: Intent, code: Int) =
        PendingIntent.getBroadcast(context, code, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    private fun notify(context: Context, chatId: String, notification: Notification) {
        if (allowed(context)) context.getSystemService(NotificationManager::class.java).notify(chatId, CHAT_ID, notification)
    }
}

/**
 * Watches the Mac while PocketBridge is closed and a chat works: one status-only event stream, a state fetch per
 * burst of changes, backoff on failure. Step hints on that stream read only new messages, at most every ten seconds,
 * for the working notification's step line. It stops as soon as nothing is running or waiting, alerts go off, or the
 * pairing is gone, so it never sits idle. A Mac out of reach for a quarter of an hour (while the phone has a network)
 * leaves the saved baseline to [AlertJob], which looks again once there's a network.
 */
class AlertService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var watcher: Job? = null
    private var statuses = mutableMapOf<String, String>()
    private val started = mutableMapOf<String, Long>()
    /** What works now, and what the ongoing notification last showed of it. */
    private var active = emptyList<ChatStatus>()
    private var shown: LiveNotice? = null
    /** Per running chat, its newest messages and the tool step they end on; and chats with new steps since the last look. */
    private var running = emptySet<String>()
    private val tails = mutableMapOf<String, JSONObject>()
    private val steps = mutableMapOf<String, String>()
    private val stepsChanged = ConcurrentHashMap.newKeySet<String>()
    /** Step hints, kept across reconnects; with the screen off they wait, and the screen coming on makes one look. */
    private val stepHints = Channel<Unit>(Channel.CONFLATED)
    private var lastLook = 0L
    /** Waiting chats announced without their approvals (the fetch failed): asked again until Allow and Deny can be added. */
    private val unfetched = mutableSetOf<String>()
    /** Per waiting chat, the request its notification shows; and chats whose requests changed since the last look. */
    private val notified = mutableMapOf<String, String>()
    private val approvalsChanged = ConcurrentHashMap.newKeySet<String>()
    /** Set by a reconnect or a reset stream: approval events in between were never seen, so every waiting chat is read again. */
    @Volatile private var recheckApprovals = false
    private var deliveryCheckAt = 0L
    private val proven = mutableMapOf<String, String>()
    private var pairing = ""
    /** The Mac stayed out of reach: the saved baseline is left for the catch-up job. */
    private var handedOver = false
    private val transcripts by lazy { TranscriptCache(File(filesDir, "transcripts")) }
    private var listening = false
    private val screenOn = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) { stepHints.trySend(Unit) }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Alerts.channels(this)
        // Leaving the app again brings back a working notification the owner swiped away.
        Alerts.liveDismissed = false
        // Android needs the service in the foreground within seconds of starting it.
        val promoted = runCatching {
            val notification = Alerts.working(this, liveNotice(active, started, steps).also { shown = it })
            if (Build.VERSION.SDK_INT >= 34) startForeground(Alerts.WORKING_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            else startForeground(Alerts.WORKING_ID, notification)
        }
        val store = Store(this)
        store.markAlertsBlocked(Build.VERSION.SDK_INT >= 31 && promoted.exceptionOrNull() is ForegroundServiceStartNotAllowedException)
        if (promoted.isFailure) {
            // Refused (battery restrictions, a restart from the background): the catch-up job looks instead, more slowly.
            intent?.getStringExtra("baseline")?.let { store.saveAlertBaseline(decodeStatuses(it)) }
            handedOver = true
            planCatchUp(this, unwatched = store.alertBaseline().isNotEmpty())
            stopSelf(); return START_NOT_STICKY
        }
        if (!listening) ContextCompat.registerReceiver(this, screenOn, IntentFilter(Intent.ACTION_SCREEN_ON), ContextCompat.RECEIVER_NOT_EXPORTED)
        listening = true; Alerts.watching = true
        // Restarted after the process died there's no intent: the saved baseline stands in for the one it was started with.
        val baseline = intent?.getStringExtra("baseline")?.let(::decodeStatuses) ?: store.alertBaseline()
        baseline.forEach { (id, status) -> statuses.putIfAbsent(id, status) }
        if (statuses.isEmpty()) { finish(); return START_NOT_STICKY }
        store.saveAlertBaseline(statuses)
        if (watcher?.isActive != true) watcher = scope.launch { watch() }
        return START_STICKY
    }

    override fun onDestroy() {
        if (listening) unregisterReceiver(screenOn)
        Alerts.watching = false
        // Stopped on purpose (nothing left, the app came back, alerts off): there's nothing for a later look to compare.
        if (!handedOver || Alerts.foreground) Store(this).saveAlertBaseline(emptyMap())
        scope.cancel(); super.onDestroy()
    }

    /** Stops for good. [clear] also takes PocketBridge's notifications; [handOver] leaves the work to the catch-up job. */
    private fun finish(clear: Boolean = false, handOver: Boolean = false) {
        handedOver = handOver
        if (handOver) Store(this).saveAlertBaseline(statuses)
        stopForeground(STOP_FOREGROUND_REMOVE)
        if (clear) { Alerts.clear(this); forgetBackground(this) }
        else {
            // Without a word the working notification would just vanish, as if the work were done. Not after a swipe, though.
            if (handOver && !Alerts.liveDismissed) Alerts.unreachable(this)
            // A scheduled prompt still waiting gets its look either way.
            planCatchUp(this, unwatched = handOver)
        }
        stopSelf()
        scope.cancel()
    }

    private fun api(): Api? {
        val store = Store(this)
        if (store.get("alerts") == "off" || !Alerts.allowed(this)) return null
        return runCatching { pairing = store.get("token"); store.token().takeIf { it.isNotEmpty() }?.let { Api(normalizeServer(store.get("base")), it) } }.getOrNull()
    }

    private suspend fun watch() {
        val api = api() ?: return finish(clear = true)
        // Both start over only once a stream proves itself: a Mac (or a proxy) that answers but drops the stream at once
        // still backs off and gives up.
        val backoff = Backoff(2000, 60_000)
        val outage = OutageTimer()
        val proof = StreamProof()
        val networkChanged = Channel<Unit>(Channel.CONFLATED)
        scope.launch {
            var last = network()
            // Registering reports the current network at once; only a real change counts, once it has settled.
            networkChanges(this@AlertService).collect {
                delay(1000)
                if (!hasNetwork(this@AlertService)) outage.offline()
                val now = network()
                if (now != last) { last = now; api.evictConnections(); networkChanged.trySend(Unit) }
            }
        }
        while (currentCoroutineContext().isActive) {
            try {
                val seq = refresh(api) ?: return
                val changes = Channel<Unit>(Channel.CONFLATED)
                coroutineScope {
                    // A stream on the old network would only time out: start again at once.
                    launch { networkChanged.receive(); throw NetworkChanged() }
                    // Bursts of changes become one state fetch a second. A question still missing its actions asks again a little later.
                    launch {
                        if (unfetched.isNotEmpty() || Alerts.deliveries.isNotEmpty()) changes.trySend(Unit)
                        for (change in changes) { delay(if (unfetched.isEmpty()) 1000 else 5000); if (refresh(api) == null) return@launch; if (unfetched.isNotEmpty() || Alerts.deliveries.isNotEmpty()) changes.trySend(Unit) }
                    }
                    // Step hints never fetch state: at most one look at the new messages every ten seconds updates the step line,
                    // and none while the screen is off.
                    launch {
                        for (hint in stepHints) {
                            if (!getSystemService(PowerManager::class.java).isInteractive) continue
                            delay(stepLookDelay(lastLook, System.currentTimeMillis())); lastLook = System.currentTimeMillis(); lookAtSteps(api)
                        }
                    }
                    api.watch(seq, "status", onOpen = { proof.opened(SystemClock.elapsedRealtime()) }) { line ->
                        proof.line(line)
                        if (!line.startsWith("data:")) return@watch
                        val data = line.removePrefix("data:").trim()
                        val step = stepChat(data)
                        if (step != null) { stepsChanged += step; stepHints.trySend(Unit) }
                        else { approvalChat(data)?.let(approvalsChanged::add); if (streamReset(data)) recheckApprovals = true; changes.trySend(Unit) }
                    }
                    coroutineContext.cancelChildren()
                }
                throw IOException("The event stream closed.")
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                if (failure is ApiError && failure.status == 401) return finish(clear = true)
                // Approval events while disconnected never arrive: the next look reads every waiting chat's request again.
                recheckApprovals = true
                if (proof.take(SystemClock.elapsedRealtime())) { backoff.reset(); outage.reset() }
                if (failure is NetworkChanged) continue
                val now = System.currentTimeMillis()
                if (statuses.values.none(::mayWork) && Alerts.deliveries.values.none { awaitingDelivery(it, it.promptId in Alerts.inFlight, now) }) return finish()
                // A Mac out of reach for a quarter of an hour isn't worth a radio kept awake; a job looks again later.
                if (outage.failed(SystemClock.elapsedRealtime(), hasNetwork(this))) return finish(handOver = true)
                reconnecting()
                networkChanged.waitOr(backoff.take())
            }
        }
    }

    private class NetworkChanged : IOException("The network changed.")

    /** The default network and whether it's validated, to tell a real change from the callback's first report. */
    private fun network() = runCatching {
        val manager = getSystemService(ConnectivityManager::class.java)
        val network = manager.activeNetwork
        network to (manager.getNetworkCapabilities(network)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true)
    }.getOrNull()

    /** While the Mac is out of reach the working notification says so, instead of a step that may be long over. */
    private fun reconnecting() {
        val notice = shown?.copy(text = "Reconnecting to your Mac", lines = emptyList(), promoted = false, stoppable = false) ?: return
        if (notice == shown || Alerts.liveDismissed || !scope.isActive) return
        shown = notice
        getSystemService(NotificationManager::class.java).notify(Alerts.WORKING_ID, Alerts.working(this, notice))
    }

    /** One look at the Mac: posts what changed and updates the ongoing summary. Null once the service has stopped. */
    private suspend fun refresh(api: Api): Long? {
        if (!Alerts.answerable(Store(this))) { finish(clear = true); return null }
        val store = Store(this)
        if (store.get("token") != pairing) { finish(); return null }
        val now = System.currentTimeMillis()
        if (now >= deliveryCheckAt) {
            val supportsStatus = runCatching { JSONObject(store.get("state")).getJSONObject("capabilities").optBoolean("promptStatus") }.getOrDefault(false)
            // ponytail: uncertain sends get two minutes per attempt; old records get one read on each background transition.
            deliveryCheckAt = now + if (supportsStatus) 5000 else 30_000
            for ((id, watch) in Alerts.deliveries.toMap()) {
                // One lookup that fails waits for the next look; it mustn't hold up every other chat's alerts.
                val proof = orNull { withContext(Dispatchers.IO) { deliveryStatus(api, id, watch.promptId, supportsStatus) } } ?: continue
                if (store.get("token") != pairing) { finish(); return null }
                if (proof.optBoolean("accepted")) {
                    withContext(Dispatchers.IO) { store.reconcilePrompt(id, watch.promptId, pairing) }
                    if (Alerts.deliveries.remove(id, watch) && !proof.optBoolean("deleted")) proven[id] = watch.promptId
                } else if (proof.optBoolean("deleted") || !awaitingDelivery(watch, watch.promptId in Alerts.inFlight, System.currentTimeMillis())) {
                    Alerts.deliveries.remove(id, watch)
                }
            }
        }
        // State follows acceptance proof, so an older idle snapshot can't manufacture a completion.
        val state = withContext(Dispatchers.IO) { api.request("/api/state") }
        // Alerts may have gone off while that was on its way.
        if (!Alerts.answerable(Store(this))) { finish(clear = true); return null }
        if (store.get("token") != pairing) { finish(); return null }
        val chats = chatStatuses(state)
        val viewing = if (Alerts.foreground) Alerts.viewing else ""
        val unresolved = Alerts.deliveries.filterValues { awaitingDelivery(it, it.promptId in Alerts.inFlight, System.currentTimeMillis()) }.keys
        val events = alertEvents(statuses, chats, viewing, proven.keys)
        proven.clear()
        for (event in events) when (event) {
            is NeedsAnswer -> announce(api, event.chat, fresh = true)
            is Ended -> Alerts.ended(this, event.chat)
            is Answered -> Alerts.dismiss(this, event.chat.id)
        }
        val waiting = chats.filter { it.status == "waiting" && it.id != viewing }.map { it.id }.toSet()
        unfetched.retainAll(waiting); notified.keys.retainAll(waiting)
        // Still waiting, but on another request (one answered, the next asked between two looks, or during an outage), or still missing its actions.
        val changed = approvalsChanged.toSet().also { approvalsChanged.removeAll(it) }
        val recheck = recheckApprovals.also { recheckApprovals = false }
        for (chat in chats.filter { it.id in waiting && (recheck || it.id in unfetched || it.id in changed) && events.none { event -> event.chat.id == it.id } }) announce(api, chat, fresh = false)
        val awaitingProof = statuses.filterValues { it == "sending" }.keys
        statuses = chats.associate { it.id to it.status }.toMutableMap()
        unresolved.forEach { if (!isWorking(statuses[it]) && (it in awaitingProof || statuses[it] == null)) statuses[it] = "sending" }
        store.saveAlertBaseline(statuses)
        // A scheduled prompt seen running is this service's to report; the catch-up job would only announce it twice.
        store.scheduledAlerts().let { saved ->
            val kept = saved.filter { (id, prompt) -> chats.none { it.id == id && isWorking(it.status) && it.scheduled != prompt.id } }
            if (kept.size != saved.size) store.saveScheduledAlerts(kept)
        }
        val working = chats.filter { isWorking(it.status) }
        val active = working + unresolved.filter { id -> working.none { it.id == id } }.map { id ->
            chats.find { it.id == id }?.copy(status = "sending") ?: ChatStatus(id, "Sending prompt", "sending")
        }
        if (active.isEmpty()) { finish(); return null }
        // A turn that ended, or waits on the owner, lets go of its timer and step; the live notification follows.
        running = working.filter { it.status == "running" }.map { it.id }.toSet()
        started.keys.retainAll(active.filter { it.status != "waiting" }.map { it.id }.toSet())
        tails.keys.retainAll(running); steps.keys.retainAll(running)
        for (id in running.filter { it !in started }) started[id] = track(api, id) ?: System.currentTimeMillis()
        this.active = active
        post()
        return state.optLong("lastSeq")
    }

    /** Shows what works now on the ongoing notification, unless nothing changed or the owner swiped it away. */
    private fun post() {
        // A look that outlived the service must not bring back the notification it removed.
        if (!scope.isActive) return
        val notice = liveNotice(active, started, steps)
        if (notice == shown || Alerts.liveDismissed) return
        shown = notice
        getSystemService(NotificationManager::class.java).notify(Alerts.WORKING_ID, Alerts.working(this, notice))
    }

    /** The first look at a running chat: its turn's start for the timer, and the step it's on. The app's saved transcript, if any, means only what came since is read. */
    private suspend fun track(api: Api, chatId: String): Long? {
        val cached = withContext(Dispatchers.IO) { runCatching { JSONObject(transcripts.read(chatId)) }.getOrNull() }
        val since = cached?.textOrNull("cursor")?.let { "?since=" + URLEncoder.encode(it, "UTF-8") }.orEmpty()
        val messages = orNull { withContext(Dispatchers.IO) { api.request("/api/chats/$chatId/messages$since") } } ?: return null
        follow(chatId, cached.takeIf { since.isNotEmpty() }, messages)
        // Turns are metadata, always complete, also in an answer with only the new messages.
        return runningSince(parseTurns(messages), null)
    }

    /** New steps in running chats, read from only the messages since the last look. A failed look waits for the next hint. */
    private suspend fun lookAtSteps(api: Api) {
        for (id in stepsChanged.toSet().also { stepsChanged.removeAll(it) }) {
            if (id !in running) continue
            val tail = tails[id]
            val since = tail?.optString("cursor")?.takeIf { it.isNotEmpty() }?.let { "?since=" + URLEncoder.encode(it, "UTF-8") }.orEmpty()
            val response = orNull { withContext(Dispatchers.IO) { api.request("/api/chats/$id/messages$since") } } ?: continue
            if (id in running) follow(id, tail.takeIf { since.isNotEmpty() }, response)
        }
        if (running.isNotEmpty()) post()
    }

    private fun follow(chatId: String, tail: JSONObject?, response: JSONObject) {
        val next = runCatching { stepTail(tail, response) }.getOrNull() ?: return
        tails[chatId] = next
        runningStep(next)?.let { steps[chatId] = it } ?: steps.remove(chatId)
    }

    private suspend fun messages(api: Api, chatId: String) = orNull { withContext(Dispatchers.IO) { api.request("/api/chats/$chatId/messages") } }
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
        val approval = pendingApproval(messages)
        val key = approval?.optString("id").orEmpty()
        if (!fresh && key.isEmpty()) { if (!notified[chat.id].isNullOrEmpty()) { Alerts.dismiss(this, chat.id); notified.remove(chat.id) }; return }
        if (!fresh && notified[chat.id] == key) return
        notified[chat.id] = key
        // A plain notice already stood in for this request: it gains its actions without a second alert.
        Alerts.needsAnswer(this, chat, approval, quiet = !fresh && standIn)
    }
}

/** Allow or Deny from a permission notification, or Stop from the working one, sent straight to the Mac. */
class AlertActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Alerts.ACTION_LIVE_DISMISSED -> { Alerts.liveDismissed = true; return }
            Alerts.ACTION_STOP -> return stop(context.applicationContext, intent)
        }
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

    /**
     * The chat's own Stop. The working notification then follows the Mac: Stopping, then Stopped. A lost reply is
     * checked against the Mac's state before saying the stop didn't arrive; Stop stays on the notification for another try.
     */
    private fun stop(app: Context, intent: Intent) {
        val chat = Alerts.answer(intent).second
        if (chat.isEmpty()) return
        val result = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            val token = Store(app).get("token")
            fun current() = Store(app).let { Alerts.answerable(it) && it.get("token") == token }
            try {
                if (!current()) return@launch
                val store = Store(app)
                val api = Api(normalizeServer(store.get("base")), store.token())
                try {
                    withTimeout(6000) { api.request("/api/chats/$chat/stop", JSONObject()) }
                } catch (failure: Exception) {
                    val state = runCatching { withTimeout(3000) { api.request("/api/state") } }.getOrNull()
                    if (current() && !stopSettled(state, chat)) Alerts.answered(app, chat, Alerts.title(intent), notStopped(failure))
                }
            } catch (failure: Exception) {
                if (current()) Alerts.answered(app, chat, Alerts.title(intent), notStopped(failure))
            } finally { result.finish() }
        }
    }
}
