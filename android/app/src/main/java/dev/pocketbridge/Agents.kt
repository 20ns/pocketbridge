package dev.pocketbridge

import org.json.JSONArray
import org.json.JSONObject

const val CLAUDE = "claude"
const val CODEX = "codex"

/** A service tier the model offers on top of standard, such as Codex's Fast. Named by the CLI. */
data class SpeedInfo(val id: String, val name: String, val description: String = "")

/** One entry from an agent CLI's own model picker, as the Mac reports it. */
data class ModelInfo(
    val id: String, val name: String, val description: String = "", val efforts: List<String> = emptyList(), val defaultEffort: String = "default",
    val speeds: List<SpeedInfo> = emptyList(),
)

data class AgentInfo(
    val id: String,
    val name: String,
    val available: Boolean,
    val modes: List<String>,
    val models: List<ModelInfo>,
    val defaultModel: String,
    val defaultEffort: String,
    /** The owner's switch on the Mac, for when only one subscription is active. */
    val enabled: Boolean = true,
    /** The CLI version the Mac runs, the newest one installed; blank from a Mac before 0.7. */
    val version: String = "",
) {
    /** Installed and switched on: offered for new chats and able to run turns. */
    val usable get() = available && enabled
    /** "default" is how older chats were saved; it means whatever this agent resolves by default. */
    fun model(id: String) = models.find { it.id == id } ?: if (id == "default") models.find { it.id == defaultModel } else null
}

/** Model, effort, speed and permission mode for the next prompt, and the agent CLI that runs it. [speed] null is standard. */
data class ChatOptions(val mode: String, val model: String = "default", val effort: String = "default", val agent: String = CLAUDE, val speed: String? = null) {
    fun store() = JSONObject().put("agent", agent).put("mode", mode).put("model", model).put("effort", effort).put("speed", speed ?: JSONObject.NULL).toString()
    companion object {
        fun parse(value: String) = JSONObject(value).let {
            ChatOptions(it.optString("mode", "bypassPermissions"), it.optString("model", "default"), it.optString("effort", "default"), it.optString("agent", CLAUDE), it.textOrNull("speed"))
        }
    }
}

fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).mapNotNull { optString(it).takeIf(String::isNotBlank) }

/** A string field that may be missing, blank or JSON null; [JSONObject.optString] would turn null into "null". */
fun JSONObject.textOrNull(key: String): String? = if (isNull(key)) null else optString(key).ifBlank { null }

/** The Mac's screen lock from /api/state: whether it offers Lock, and whether it is locked now (null when unknown or an older Mac). */
data class MacScreen(val canLock: Boolean = false, val locked: Boolean? = null)
fun parseMacScreen(state: JSONObject) = MacScreen(
    state.optJSONObject("capabilities")?.optJSONObject("mac")?.optBoolean("lock") == true,
    state.optJSONObject("server")?.lockedOrNull(),
)
fun JSONObject.lockedOrNull(): Boolean? = if (has("locked") && !isNull("locked")) optBoolean("locked") else null

/** Agents from /api/state. A Mac service before 0.5 only lists Claude's legacy aliases. */
fun parseAgents(capabilities: JSONObject?): List<AgentInfo> {
    val listed = capabilities?.optJSONArray("agents")?.objects().orEmpty().mapNotNull { agent ->
        val id = agent.optString("id").takeIf { it.isNotBlank() } ?: return@mapNotNull null
        val models = agent.optJSONArray("models")?.objects().orEmpty().mapNotNull { model ->
            val modelId = model.optString("id").takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val speeds = model.optJSONArray("speeds")?.objects().orEmpty().mapNotNull { speed ->
                val speedId = speed.textOrNull("id") ?: return@mapNotNull null
                SpeedInfo(speedId, speed.optString("name").ifBlank { speedLabel(speedId) }, speed.optString("description"))
            }
            ModelInfo(modelId, model.optString("name").ifBlank { modelId }, model.optString("description"), model.optJSONArray("efforts").strings(), model.optString("defaultEffort", "default"), speeds)
        }
        AgentInfo(id, agent.optString("name").ifBlank { id }, agent.optBoolean("available", true), agent.optJSONArray("modes").strings().ifEmpty { listOf("bypassPermissions") }, models, agent.optString("defaultModel", "default"), agent.optString("defaultEffort", "default"), agent.optBoolean("enabled", true), agent.textOrNull("version").orEmpty())
    }
    if (listed.isNotEmpty()) return listed
    val efforts = capabilities?.optJSONArray("efforts").strings().filter { it != "default" }
    val models = capabilities?.optJSONArray("models").strings().filter { it != "default" }.map {
        val supported = if (it == "haiku") emptyList() else efforts
        ModelInfo(it, modelLabel(it), "", supported, if ("high" in supported) "high" else supported.lastOrNull() ?: "default")
    }
    return listOf(AgentInfo(CLAUDE, "Claude", true, capabilities?.optJSONArray("modes").strings().ifEmpty { listOf("bypassPermissions") }, models, models.firstOrNull()?.id ?: "default", "default"))
}

/**
 * Concrete options for a prompt: the wanted choice where this agent's catalog still offers it, otherwise its
 * defaults. Effort and speed carry over between models that support them. A placeholder "default" becomes a real model.
 */
fun resolveOptions(agent: AgentInfo, wanted: ChatOptions?): ChatOptions {
    val model = wanted?.model?.takeIf { it != "default" && (agent.models.isEmpty() || agent.models.any { model -> model.id == it }) } ?: agent.defaultModel
    val info = agent.model(model)
    val effort = when {
        info == null -> wanted?.effort ?: agent.defaultEffort
        info.efforts.isEmpty() -> "default"
        wanted?.effort in info.efforts -> wanted!!.effort
        model == agent.defaultModel && agent.defaultEffort in info.efforts -> agent.defaultEffort
        else -> info.defaultEffort
    }
    val speed = wanted?.speed?.takeIf { info == null || info.speeds.any { offered -> offered.id == it } }
    return ChatOptions(equivalentMode(wanted?.mode, agent.modes), model, effort, agent.id, speed)
}

/** The agent a new chat starts with: the last one used while it's still on, else the first one on. Null when none is. */
fun newChatAgent(agents: List<AgentInfo>, last: String): String? =
    if (agents.isEmpty()) CLAUDE else agents.firstOrNull { it.id == last && it.usable }?.id ?: agents.firstOrNull { it.usable }?.id

/** Preferred first, then the Mac's order; never a silent switch away from what the chat uses. */
fun defaultMode(modes: List<String>) = if ("bypassPermissions" in modes || modes.isEmpty()) "bypassPermissions" else modes.first()

private val sameIntent = mapOf("plan" to "readOnly", "readOnly" to "plan", "acceptEdits" to "auto", "default" to "readOnly")
private val strictest = listOf("readOnly", "plan", "default", "acceptEdits", "auto", "bypassPermissions")

/**
 * A mode for another agent that never widens what the chat may do: Plan and Read only map to each other, Accept
 * edits to Auto, Manual to Read only, and anything else to the most restrictive mode on offer.
 */
fun equivalentMode(mode: String?, modes: List<String>): String = when {
    modes.isEmpty() -> mode ?: "bypassPermissions"
    mode in modes -> mode!!
    mode == null -> defaultMode(modes)
    sameIntent[mode] in modes -> sameIntent.getValue(mode)
    else -> strictest.firstOrNull { it in modes } ?: modes.first()
}

/**
 * Saved options with an effort the model doesn't list (chats from older clients) send the model's own default, and a
 * speed the model no longer offers goes back to standard, since the Mac would refuse it.
 */
fun supportedOptions(agent: AgentInfo?, options: ChatOptions): ChatOptions {
    val info = agent?.model(options.model) ?: return options
    val speed = options.speed?.takeIf { speed -> info.speeds.any { it.id == speed } }
    if (options.effort == "default" || options.effort in info.efforts) return options.copy(speed = speed)
    return options.copy(effort = if (info.efforts.isEmpty()) "default" else info.defaultEffort, speed = speed)
}

/** Never "Default": a chat saved with the placeholder shows the model it resolves to, else the first one, else the agent. */
fun modelName(agent: AgentInfo?, model: String): String {
    agent?.model(model)?.let { return it.name }
    if (model != "default") return modelLabel(model)
    return agent?.defaultModel?.takeIf { it.isNotBlank() && it != "default" }?.let(::modelLabel) ?: agent?.models?.firstOrNull()?.name ?: agent?.name ?: "Claude"
}

/** Older chats saved effort "default"; show the level that actually applies when the catalog knows it. */
fun effortName(agent: AgentInfo?, model: String, effort: String): String {
    if (effort != "default") return effortLabel(effort)
    val info = agent?.model(model) ?: return "Auto"
    return when {
        info.efforts.isEmpty() -> "Auto"
        agent.defaultEffort in info.efforts -> effortLabel(agent.defaultEffort)
        info.defaultEffort in info.efforts -> effortLabel(info.defaultEffort)
        else -> "Auto"
    }
}

fun modeLabel(mode: String) = when (mode) {
    "bypassPermissions" -> "Bypass permissions"; "auto" -> "Auto"; "acceptEdits" -> "Accept edits"; "plan" -> "Plan"; "readOnly" -> "Read only"; else -> "Manual"
}
fun modeShort(mode: String) = when (mode) { "bypassPermissions" -> "Bypass"; else -> modeLabel(mode) }
fun modeHelp(agent: String, mode: String) = when (mode) {
    "bypassPermissions" -> if (agent == CODEX) "No sandbox and no prompts." else "Runs commands and edits files without asking."
    "auto" -> if (agent == CODEX) "Edits inside the project folder; nothing outside it." else "Works alone while a safety check blocks risky actions."
    "acceptEdits" -> "Edits files freely, asks before commands."
    "plan" -> "Explores and proposes a plan before changing anything."
    "readOnly" -> "Reads and answers. Changes nothing."
    else -> "Asks before every edit and command."
}
fun modelLabel(model: String) = when (model) {
    "default" -> "Default"; "opus" -> "Opus"; "sonnet" -> "Sonnet"; "haiku" -> "Haiku"; "fable" -> "Fable"; else -> model
}
/** Display fallback only: the Mac names each speed from the CLI's own catalog. */
fun speedLabel(speed: String) = if (speed == "priority") "Fast" else speed.replaceFirstChar(Char::uppercase)
fun effortLabel(effort: String) = when (effort) {
    "default" -> "Auto"; "minimal" -> "Minimal"; "low" -> "Low"; "medium" -> "Medium"; "high" -> "High"; "xhigh" -> "Extra high"; "max" -> "Max"; "ultra" -> "Ultra"
    else -> effort.replaceFirstChar(Char::uppercase)
}

/**
 * One plan limit as the agent's CLI reports it, e.g. Claude's 5-hour session or Codex's weekly window. [window] is
 * "session", "weekly" or "other"; blank from a Mac before 0.7.
 */
data class UsageLimit(val id: String, val label: String, val percent: Int, val resetsAt: Long, val severity: String, val window: String = "") {
    /** Older Macs don't say which window a limit is; their ids and labels do ("weekly", "Weekly · Opus"). */
    val weekly get() = if (window.isNotEmpty()) window == "weekly" else "week" in id.lowercase() || "week" in label.lowercase()
}
/** A banked Codex reset: using one clears the plan's current limits. */
data class ResetCredit(val id: String, val title: String, val description: String, val expiresAt: Long?)
data class Resets(val available: Int, val credits: List<ResetCredit>) {
    /** The credit to spend first: the one expiring soonest, then the Mac's order. */
    val next get() = credits.sortedBy { it.expiresAt ?: Long.MAX_VALUE }.firstOrNull()
}
data class AgentUsage(
    val id: String, val name: String, val plan: String, val limits: List<UsageLimit>, val credits: Double?, val updatedAt: Long,
    /** Codex only; null when unknown or when the agent has no banked resets. */
    val resets: Resets? = null,
)

/** /api/usage. Agents with neither limits, credits nor banked resets (not installed, or an older Mac) are left out. */
fun parseUsage(json: JSONObject): List<AgentUsage> = json.optJSONArray("agents")?.objects().orEmpty().mapNotNull { agent ->
    val limits = agent.optJSONArray("limits")?.objects().orEmpty().map {
        UsageLimit(it.optString("id"), it.optString("label"), it.optInt("percent").coerceIn(0, 100), it.optLong("resetsAt"), it.optString("severity", "normal"), it.textOrNull("window").orEmpty())
    }
    val credits = agent.optDouble("credits").takeUnless { it.isNaN() }
    val resets = agent.optJSONObject("resets")?.let { resets ->
        val list = resets.optJSONArray("credits")?.objects().orEmpty().mapNotNull { credit ->
            val id = credit.textOrNull("id") ?: return@mapNotNull null
            ResetCredit(id, credit.optString("title"), credit.optString("description"), credit.optLong("expiresAt").takeIf { !credit.isNull("expiresAt") && it > 0 })
        }
        Resets(resets.optInt("available", list.size).coerceAtLeast(0), list)
    }
    if (limits.isEmpty() && credits == null && resets == null) null
    else AgentUsage(agent.optString("id"), agent.optString("name").ifBlank { agent.optString("id") }, agent.optString("plan"), limits, credits, agent.optLong("updatedAt"), resets)
}

/**
 * The top bar's rings: each enabled agent's weekly limit closest to running out, Claude before Codex. An agent that
 * reports no weekly window shows its tightest limit instead, so a ring is never missing for an agent that's on.
 */
fun weeklyUsage(usage: List<AgentUsage>, enabled: Set<String>?): List<Pair<AgentUsage, UsageLimit>> =
    usage.filter { enabled == null || it.id in enabled }.sortedBy { if (it.id == CLAUDE) 0 else 1 }.mapNotNull { agent ->
        val limit = agent.limits.filter { it.weekly }.maxByOrNull { it.percent } ?: agent.limits.maxByOrNull { it.percent }
        limit?.let { agent to it }
    }

/** How full a Claude chat's context window was after its last turn. */
data class ContextUse(val used: Long, val window: Long) {
    val percent get() = if (window <= 0) 0 else ((used * 100) / window).toInt().coerceIn(0, 100)
}
fun chatContext(chat: JSONObject?): ContextUse? = chat?.optJSONObject("context")?.let { context ->
    ContextUse(context.optLong("used"), context.optLong("window")).takeIf { it.used > 0 && it.window > 0 }
}
