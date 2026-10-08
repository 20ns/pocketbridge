package dev.pocketbridge

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.*
import org.json.JSONObject

/** A previous status known only from the app's cache: the chat may still work, so a question alerts, but it can't "finish". */
const val UNKNOWN = "unknown"
/** Out of reach this long, counted only while Android had a network, the alerts service hands over to [AlertJob]. */
const val GIVE_UP_MILLIS = 15 * 60_000L
/** How often [AlertJob] looks again at work nothing else watches. */
const val CATCH_UP_RETRY_MILLIS = 15 * 60_000L
/** A scheduled prompt is looked at this long after it goes, so its turn is plainly running or over. */
const val SCHEDULED_LOOK_MILLIS = 60_000L

private const val BASELINE = "alertBaseline"
private const val SCHEDULED_PROMPTS = "alertScheduled"
private const val BLOCKED = "alertsBlocked"
private const val CATCH_UP_JOB = 1

/** A prompt the Mac holds for later: its id and when it goes. */
data class ScheduledPrompt(val id: String, val notBefore: Long)

/** Could still work: an unknown status counts until the Mac says otherwise. */
fun mayWork(status: String?) = isWorking(status) || status == UNKNOWN

/** Statuses worth keeping for a later look: work that may still end or ask. Idle chats have nothing left to report. */
fun watchedStatuses(statuses: Map<String, String>) = statuses.filterValues { mayWork(it) || it == "sending" }

/** What [alertEvents] compares with: a chat holding a scheduled prompt counts as [SCHEDULED] unless it was seen working. */
fun withScheduled(statuses: Map<String, String>, scheduled: Set<String>) = statuses + scheduled.filterNot { isWorking(statuses[it]) }.associateWith { SCHEDULED }

fun encodeStatuses(statuses: Map<String, String>) = JSONObject().apply { statuses.forEach { (id, status) -> put(id, status) } }.toString()
fun decodeStatuses(raw: String): Map<String, String> =
    runCatching { JSONObject(raw).let { json -> json.keys().asSequence().associateWith { json.getString(it) } } }.getOrDefault(emptyMap())

fun encodeScheduled(prompts: Map<String, ScheduledPrompt>) =
    JSONObject().apply { prompts.forEach { (chat, prompt) -> put(chat, JSONObject().put("id", prompt.id).put("notBefore", prompt.notBefore)) } }.toString()
fun decodeScheduled(raw: String): Map<String, ScheduledPrompt> = runCatching {
    JSONObject(raw).let { json -> json.keys().asSequence().associateWith { json.getJSONObject(it).let { p -> ScheduledPrompt(p.getString("id"), p.optLong("notBefore")) } } }
}.getOrDefault(emptyMap())

/**
 * When [AlertJob] should look next: a minute after the earliest scheduled prompt goes (at least a minute from now), or
 * [CATCH_UP_RETRY_MILLIS] when work was left [unwatched], whichever is sooner. Null when nothing needs a look.
 */
fun catchUpDelay(now: Long, scheduled: Collection<Long>, unwatched: Boolean): Long? = listOfNotNull(
    scheduled.minOrNull()?.let { (it - now + SCHEDULED_LOOK_MILLIS).coerceAtLeast(SCHEDULED_LOOK_MILLIS) },
    CATCH_UP_RETRY_MILLIS.takeIf { unwatched },
).minOrNull()

/**
 * How long the Mac has been out of reach. Monotonic time, so a clock change can't end or stretch it; the time before a
 * failure counts only when Android had a network then, since a phone in a tunnel or airplane mode isn't the Mac's fault.
 */
class OutageTimer(private val limit: Long = GIVE_UP_MILLIS) {
    private var counted = 0L
    private var last = -1L
    /** A failed attempt at [now] (elapsed realtime). Answers whether it's time to give up. */
    fun failed(now: Long, network: Boolean): Boolean {
        if (last >= 0 && network) counted += (now - last).coerceAtLeast(0)
        last = now
        return counted > limit
    }
    fun reset() { counted = 0; last = -1 }
}

// What background alerts last knew, saved so a later look (a restart, the catch-up job) can still tell what changed.
fun Store.alertBaseline() = decodeStatuses(get(BASELINE))
fun Store.saveAlertBaseline(statuses: Map<String, String>) = watchedStatuses(statuses).let { update(BASELINE, if (it.isEmpty()) "" else encodeStatuses(it)) }
fun Store.scheduledAlerts() = decodeScheduled(get(SCHEDULED_PROMPTS))
fun Store.saveScheduledAlerts(prompts: Map<String, ScheduledPrompt>) = update(SCHEDULED_PROMPTS, if (prompts.isEmpty()) "" else encodeScheduled(prompts))
/** Android refused to start the alerts service when the app was left (battery restrictions): when, for Settings to explain. */
fun Store.alertsBlocked() = get(BLOCKED).toLongOrNull()
fun Store.markAlertsBlocked(blocked: Boolean) = if (blocked) put(BLOCKED, System.currentTimeMillis().toString()) else update(BLOCKED, "")
/** Writes only a change: preferences rewrite their whole file, cached state and all, and this runs on every look. */
private fun Store.update(key: String, value: String) { if (get(key) != value) { if (value.isEmpty()) remove(key) else put(key, value) } }

/** Schedules [AlertJob] for saved scheduled prompts and for work left [unwatched]; cancels it when neither is left. */
fun planCatchUp(context: Context, unwatched: Boolean) {
    val jobs = context.getSystemService(JobScheduler::class.java)
    val delay = catchUpDelay(System.currentTimeMillis(), Store(context).scheduledAlerts().values.map { it.notBefore }, unwatched)
    if (delay == null) { jobs.cancel(CATCH_UP_JOB); return }
    runCatching {
        jobs.schedule(JobInfo.Builder(CATCH_UP_JOB, ComponentName(context, AlertJob::class.java))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setMinimumLatency(delay).setPersisted(true).build())
    }
}

/** Nothing is watched in the background any more: the app is on screen, alerts went off or the pairing did. */
fun forgetBackground(context: Context) {
    Store(context).apply { update(BASELINE, ""); update(SCHEDULED_PROMPTS, "") }
    context.getSystemService(JobScheduler::class.java).cancel(CATCH_UP_JOB)
    Alerts.reachable(context)
}

/**
 * One look at the Mac for work the alerts service lost sight of, or a scheduled prompt that may have run: posts what
 * changed since the saved baseline, saves the new one and tries to hand running work back to the service. Answers
 * whether work is left that nothing watches.
 */
internal suspend fun catchUp(context: Context): Boolean {
    val store = Store(context)
    if (!Alerts.answerable(store) || !Alerts.allowed(context)) { forgetBackground(context); return false }
    // On screen the app shows everything, and a running service watches by itself; it hands over again if it gives up.
    if (Alerts.foreground || Alerts.watching) return false
    val baseline = store.alertBaseline()
    val scheduled = store.scheduledAlerts()
    if (baseline.isEmpty() && scheduled.isEmpty()) return false
    val pairing = store.get("token")
    val api = Api(normalizeServer(store.get("base")), store.token())
    val state = try { withContext(Dispatchers.IO) { api.request("/api/state") } }
    catch (cancelled: CancellationException) { throw cancelled }
    catch (failure: Exception) {
        if (failure is ApiError && failure.status == 401) { forgetBackground(context); return false }
        return true
    }
    if (!Alerts.answerable(store) || store.get("token") != pairing) return false
    val chats = chatStatuses(state)
    // A prompt its chat no longer holds either started, which makes a later idle chat finished, or was cancelled.
    val started = mutableSetOf<String>()
    val waiting = mutableMapOf<String, ScheduledPrompt>()
    for ((id, prompt) in scheduled) {
        val chat = chats.find { it.id == id } ?: continue
        if (chat.scheduled == prompt.id) { waiting[id] = prompt; continue }
        val lookup = orNull { withContext(Dispatchers.IO) { api.request("/api/chats/$id/prompts/${prompt.id}") } }
        if (lookup == null) waiting[id] = prompt
        else if (lookup.optJSONObject("schedule")?.optString("state") == "started") started += id
    }
    for (event in alertEvents(withScheduled(baseline, scheduled.keys), chats, "", started)) when (event) {
        is NeedsAnswer -> Alerts.needsAnswer(context, event.chat, pendingApproval(orNull { withContext(Dispatchers.IO) { api.request("/api/chats/${event.chat.id}/messages") } }))
        is Ended -> Alerts.ended(context, event.chat)
        is Answered -> Alerts.dismiss(context, event.chat.id)
    }
    store.saveAlertBaseline(chats.associate { it.id to it.status })
    store.saveScheduledAlerts(waiting)
    Alerts.reachable(context)
    if (chats.none { isWorking(it.status) }) return false
    // Android 12+ rarely lets a job start it; then the next look is a job too.
    return !Alerts.start(context, store.alertBaseline(), fromApp = false)
}

/** Looks once at the Mac when there's a network, then plans the next look. */
class AlertJob : JobService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    override fun onStartJob(params: JobParameters): Boolean {
        scope.launch {
            val unwatched = try { catchUp(this@AlertJob) } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { true }
            // Scheduling this job's id while it runs would stop it, so it finishes first.
            jobFinished(params, false)
            planCatchUp(this@AlertJob, unwatched)
        }
        return true
    }
    override fun onStopJob(params: JobParameters): Boolean { scope.coroutineContext.cancelChildren(); return true }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
}

/** After a restart or an app update, work the alerts service was watching is watched again. The job is persisted by itself. */
class AlertBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val store = Store(context)
        val baseline = store.alertBaseline()
        if (baseline.isNotEmpty() && Alerts.answerable(store)) Alerts.start(context, baseline)
    }
}
