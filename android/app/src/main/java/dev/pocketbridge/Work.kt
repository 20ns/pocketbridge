package dev.pocketbridge

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.json.JSONObject

/** A prompt that started a turn: its id is that user message's id. */
data class Turn(val id: String, val startedAt: Long, val endedAt: Long?)

/** A sub-agent the chat's agent started, as the Mac tracks it. [model] is already a display name. */
data class Subagent(
    val id: String, val promptId: String, val title: String, val kind: String, val model: String, val effort: String,
    val status: String, val activity: String, val startedAt: Long, val endedAt: Long?,
) {
    val running get() = status == "running"
}

private fun JSONObject.text(key: String) = if (isNull(key)) "" else optString(key)
private fun JSONObject.time(key: String) = if (isNull(key) || !has(key)) null else optLong(key).takeIf { it > 0 }

fun parseTurns(messages: JSONObject): List<Turn> = messages.optJSONArray("turns")?.objects().orEmpty().mapNotNull { turn ->
    val id = turn.text("id").takeIf { it.isNotBlank() } ?: return@mapNotNull null
    Turn(id, turn.optLong("startedAt"), turn.time("endedAt"))
}

fun parseSubagents(messages: JSONObject): List<Subagent> = messages.optJSONArray("subagents")?.objects().orEmpty().mapNotNull { agent ->
    val id = agent.text("id").takeIf { it.isNotBlank() } ?: return@mapNotNull null
    Subagent(
        id, agent.text("promptId"), agent.text("title").ifBlank { "Sub-agent" }, agent.text("kind"), agent.text("model"), agent.text("effort"),
        agent.text("status").ifBlank { "running" }, agent.text("activity"), agent.optLong("startedAt"), agent.time("endedAt"),
    )
}

/** A user message that opens a new turn: a known turn start, or any prompt that wasn't a steer. */
private fun opensTurn(entry: Entry, starts: Set<String>) =
    entry is Message && entry.said.role == "user" && entry.said.kind != "imported" && (entry.said.id in starts || entry.said.kind != STEER)

private fun startOf(entry: Entry) = when (entry) { is Message -> entry.said.createdAt; is Steps -> entry.steps.first().at; else -> Long.MAX_VALUE }

/**
 * Sub-agents shown where their turn started them: after the last entry of that turn that began before the first of
 * them did (the steps that launched them). Sub-agents without a known prompt go last.
 */
fun withSubagents(entries: List<Entry>, subagents: List<Subagent>, turns: List<Turn> = emptyList()): List<Entry> {
    if (subagents.isEmpty()) return entries
    val starts = turns.map { it.id }.toSet()
    val placed = subagents.groupBy { it.promptId }.map { (promptId, group) ->
        val start = group.minOf { it.startedAt }
        val prompt = entries.indexOfFirst { it is Message && it.said.id == promptId }
        var at = if (prompt < 0) entries.size - 1 else prompt
        if (prompt >= 0) for (i in prompt + 1 until entries.size) {
            if (opensTurn(entries[i], starts)) break
            if (startOf(entries[i]) <= start) at = i
        }
        Triple(at + 1, start, Agents(promptId, group))
    }
    val result = entries.toMutableList()
    // Inserting from the end keeps earlier indices valid; equal places keep start order.
    placed.sortedWith(compareByDescending<Triple<Int, Long, Agents>> { it.first }.thenByDescending { it.second }).forEach { (index, _, agents) -> result.add(index, agents) }
    return result
}

/** For each finished turn, the key of the last reply in it and how long the turn ran. */
fun turnDurations(entries: List<Entry>, turns: List<Turn>): Map<String, Long> {
    val starts = turns.map { it.id }.toSet()
    val result = mutableMapOf<String, Long>()
    for (turn in turns) {
        val end = turn.endedAt ?: continue
        val prompt = entries.indexOfFirst { it is Message && it.said.id == turn.id }
        if (prompt < 0 || end < turn.startedAt) continue
        var reply: String? = null
        for (i in prompt + 1 until entries.size) {
            val entry = entries[i]
            if (opensTurn(entry, starts)) break
            if (entry is Message && entry.said.role == "assistant" && entry.said.text.isNotBlank()) reply = entry.key
        }
        reply?.let { result[it] = end - turn.startedAt }
    }
    return result
}

/** The running turn's start, else the newest prompt's time. */
fun runningSince(turns: List<Turn>, lastPromptAt: Long?): Long? = turns.lastOrNull { it.endedAt == null }?.startedAt?.takeIf { it > 0 } ?: lastPromptAt

/** "Worked 2m 14s"; under a second reads as "Worked 1s" so a finished turn never says 0. */
fun workedLabel(millis: Long) = "Worked " + elapsedLabel(millis.coerceAtLeast(1000))

/** "Explore · Opus 5.5 · High": the quiet second line of a sub-agent row. */
fun subagentDetail(agent: Subagent) = listOfNotNull(
    agent.kind.takeIf { it.isNotBlank() }?.replaceFirstChar(Char::uppercase),
    agent.model.takeIf { it.isNotBlank() },
    agent.effort.takeIf { it.isNotBlank() && it != "default" }?.let(::effortLabel),
).joinToString(" · ")

fun subagentStatusLabel(status: String) = when (status) { "running" -> "Running"; "completed" -> "Done"; "failed" -> "Failed"; "stopped" -> "Stopped"; else -> status.replaceFirstChar(Char::uppercase) }

/** Running sub-agents first, then the rest, each in the order they started: the live ones never hide behind "more". */
fun subagentOrder(agents: List<Subagent>) = agents.sortedWith(compareBy<Subagent> { !it.running }.thenBy { it.startedAt })

/**
 * The sub-agents one turn started: a row each with title, kind, model and effort, a live timer (frozen once done),
 * a status mark that differs in shape, and what it's doing now. More than three fold behind "+N more".
 */
@Composable fun SubagentsCard(group: Agents, modifier: Modifier = Modifier) {
    var expanded by rememberSaveable(group.key) { mutableStateOf(false) }
    val agents = subagentOrder(group.agents)
    val running = agents.count { it.running }
    val now by produceState(System.currentTimeMillis(), running) { while (running > 0) { value = System.currentTimeMillis(); delay(1000) } }
    val colors = MaterialTheme.colorScheme
    Surface(modifier.fillMaxWidth(), color = Pocket.colors.row, shape = RoundedCornerShape(Corners.groupOuter)) {
        Column(Modifier.animateContentSize(Motion.spatial(IntSize.VisibilityThreshold)).padding(top = Spacing.md, bottom = if (agents.size > 3) Spacing.xxs else Spacing.sm)) {
            Text(
                plural(agents.size, "sub-agent") + if (running > 0) " · $running running" else "",
                Modifier.padding(horizontal = Spacing.lg), style = MaterialTheme.typography.labelLarge, color = colors.onSurfaceVariant,
            )
            (if (expanded) agents else agents.take(3)).forEach { SubagentRow(it, now) }
            if (agents.size > 3) TextButton(onClick = { expanded = !expanded }, Modifier.padding(start = Spacing.xs)) {
                Text(if (expanded) "Show fewer" else "+${agents.size - 3} more")
            }
        }
    }
}

@Composable private fun SubagentRow(agent: Subagent, now: Long) {
    val colors = MaterialTheme.colorScheme
    val detail = subagentDetail(agent)
    val elapsed = elapsedLabel((agent.endedAt ?: now) - agent.startedAt)
    Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}.padding(start = Spacing.lg, end = Spacing.lg, top = Spacing.sm + Spacing.xxs, bottom = Spacing.xs)) {
        Box(Modifier.padding(top = Spacing.xxs).size(Sizes.smallIcon + Spacing.xxs), contentAlignment = Alignment.Center) {
            val status = subagentStatusLabel(agent.status)
            when (agent.status) {
                "running" -> CircularProgressIndicator(Modifier.size(Sizes.tinyIcon + Spacing.xxs).semantics { contentDescription = status }, strokeWidth = 2.dp)
                "completed" -> Icon(Icons.Default.CheckCircle, status, Modifier.size(Sizes.smallIcon), tint = colors.primary)
                "failed" -> Icon(PocketIcons.Error, status, Modifier.size(Sizes.smallIcon), tint = colors.error)
                else -> Icon(PocketIcons.StopCircle, status, Modifier.size(Sizes.smallIcon), tint = colors.onSurfaceVariant)
            }
        }
        Column(Modifier.weight(1f).padding(start = Spacing.md), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(agent.title, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(elapsed, Modifier.padding(start = Spacing.sm), style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"), color = if (agent.running) colors.primary else colors.onSurfaceVariant)
            }
            if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (agent.activity.isNotBlank()) Text(firstLine(agent.activity, 200), style = MaterialTheme.typography.bodySmall, color = if (agent.running) colors.onSurface else colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
