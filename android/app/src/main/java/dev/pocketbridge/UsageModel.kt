package dev.pocketbridge

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

private const val RESET_ATTEMPT = "codexReset"

/**
 * One try at spending a banked Codex reset. Its [id] is the idempotency key: saved before the request, reused by
 * every retry until the Mac gives a definite answer, so a lost response can't spend a second credit.
 */
data class ResetAttempt(val id: String, val creditId: String?) {
    fun store() = JSONObject().put("id", id).put("creditId", creditId ?: JSONObject.NULL).toString()
    fun body() = JSONObject().put("id", id).apply { creditId?.let { put("creditId", it) } }
    companion object {
        fun parse(value: String) = runCatching { JSONObject(value).let { json -> json.textOrNull("id")?.let { ResetAttempt(it, json.textOrNull("creditId")) } } }.getOrNull()
    }
}

/** The saved attempt when one is still unanswered, otherwise a new key for [creditId]. */
fun resetAttempt(saved: String, creditId: String?, newId: () -> String = { UUID.randomUUID().toString() }): ResetAttempt =
    saved.takeIf { it.isNotBlank() }?.let(ResetAttempt::parse) ?: ResetAttempt(newId(), creditId)

/**
 * Whether a failed attempt is settled, so the next try mints a new key and can pick another credit: the Mac refused
 * it (4xx, such as 400 for a bad credit or 409 with Codex off) or relayed Codex's own refusal (502). Only an unknown
 * outcome keeps the key: no answer, a timeout (408, 504) or any other server error, since the credit may be spent.
 */
fun resetSettled(failure: Throwable) = failure is ApiError && (failure.definitiveRejection || failure.status == 502)

fun resetOutcomeLabel(outcome: String) = when (outcome) {
    "reset" -> "Codex limits reset"
    "nothingToReset" -> "Nothing to reset yet"
    "noCredit" -> "No resets left"
    "alreadyRedeemed" -> "That reset was already used"
    else -> "Reset sent"
}

/**
 * Codex's banked resets as they stand after a redemption answered [outcome], before fresh usage arrives: a spent
 * credit is gone at once, so the count can't offer it again.
 */
fun afterReset(usage: List<AgentUsage>, creditId: String?, outcome: String): List<AgentUsage> = usage.map { agent ->
    val resets = agent.resets
    if (agent.id != CODEX || resets == null) agent
    else when (outcome) {
        "reset", "alreadyRedeemed" -> {
            val spent = resets.credits.find { it.id == creditId } ?: resets.next
            agent.copy(resets = Resets((resets.available - 1).coerceAtLeast(0), resets.credits.filter { it != spent }))
        }
        "noCredit" -> agent.copy(resets = Resets(0, emptyList()))
        else -> agent
    }
}

/** Plan usage per agent, and Codex's banked resets. The last answer is kept so it shows offline and at launch. */
class UsageModel(
    private val store: Store,
    private val scope: CoroutineScope,
    private val api: () -> Api?,
) {
    var agents by mutableStateOf(store.get("usage").takeIf { it.isNotEmpty() }?.let { runCatching { parseUsage(JSONObject(it)) }.getOrNull() }.orEmpty()); private set
    var loading by mutableStateOf(false); private set
    var resetting by mutableStateOf(false); private set
    /** The last redemption's outcome, shown beside the button (a snackbar would sit under the usage sheet). */
    var resetMessage by mutableStateOf(""); private set
    var resetFailed by mutableStateOf(false); private set
    private var fetchedAt = 0L
    /** Bumped by each request and each redemption; an answer from before either is dropped. */
    private var generation = 0

    /** Asks the Mac at most once a minute unless [force]d. An older Mac without usage keeps the list empty. */
    fun refresh(force: Boolean = false) {
        val currentApi = api() ?: return
        if (loading || (!force && System.currentTimeMillis() - fetchedAt < 60_000)) return
        scope.launch { fetch(currentApi) }
    }

    private suspend fun fetch(currentApi: Api) {
        loading = true
        val asked = ++generation
        try {
            val result = withContext(Dispatchers.IO) { currentApi.request("/api/usage") }
            if (api() === currentApi && asked == generation) { agents = parseUsage(result); fetchedAt = System.currentTimeMillis(); store.put("usage", result.toString()) }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { fetchedAt = System.currentTimeMillis() }
        finally { loading = false }
    }

    /** A finished turn or a switched agent changed usage; the next look asks again. */
    fun stale() { fetchedAt = 0 }

    /**
     * Spends one banked Codex reset, the one expiring soonest, then shows the outcome. The spent credit leaves the
     * count straight away and older usage answers are dropped, so a stale count can't start a second redemption.
     */
    fun useReset() {
        val currentApi = api() ?: return
        if (resetting) return
        val credit = agents.find { it.id == CODEX }?.resets?.next?.id
        val session = store.session()
        resetting = true
        resetMessage = ""
        scope.launch {
            val attempt = resetAttempt(store.get(RESET_ATTEMPT), credit)
            try {
                val result = withContext(Dispatchers.IO) {
                    store.commit(RESET_ATTEMPT, attempt.store(), session)
                    currentApi.request("/api/usage/codex/reset", attempt.body())
                }
                store.removeIfSame(RESET_ATTEMPT, attempt.store(), session)
                if (api() !== currentApi) return@launch
                val outcome = result.optString("outcome")
                generation++
                agents = afterReset(agents, attempt.creditId, outcome)
                resetMessage = resetOutcomeLabel(outcome); resetFailed = false
                fetch(currentApi)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                if (resetSettled(failure)) store.removeIfSame(RESET_ATTEMPT, attempt.store(), session)
                if (api() === currentApi) { resetMessage = failureReason(failure); resetFailed = true }
            } finally { resetting = false }
        }
    }

    fun clearResetMessage() { resetMessage = "" }

    fun clear() { agents = emptyList(); fetchedAt = 0; resetMessage = "" }
}
