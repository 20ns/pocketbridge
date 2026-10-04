package dev.pocketbridge

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.filled.Check
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.unit.IntSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import java.text.NumberFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** "Resets in 2h 24m" within a day, then the weekday, then the date. Blank when the CLI gave no time. */
fun resetLabel(resetsAt: Long, now: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()) = whenLabel("Resets", resetsAt, now, zone, locale)

/** "Expires in 5h", "Expires Thu", "Expires Oct 12" for a banked reset. */
fun expiryLabel(expiresAt: Long, now: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()) = whenLabel("Expires", expiresAt, now, zone, locale)

private fun whenLabel(verb: String, at: Long, now: Long, zone: ZoneId, locale: Locale): String {
    if (at <= 0) return ""
    val minutes = (at - now) / 60_000
    return when {
        minutes < 1 -> "$verb now"
        minutes < 60 -> "$verb in ${minutes}m"
        minutes < 24 * 60 -> "$verb in ${minutes / 60}h" + if (minutes % 60 == 0L) "" else " ${minutes % 60}m"
        else -> {
            val date = Instant.ofEpochMilli(at).atZone(zone)
            if (minutes < 7 * 24 * 60) "$verb " + date.dayOfWeek.getDisplayName(TextStyle.SHORT, locale)
            else "$verb " + date.month.getDisplayName(TextStyle.SHORT, locale) + " " + date.dayOfMonth
        }
    }
}

/** Severity as the CLI reported it; a full limit is critical whatever it said. */
fun limitSeverity(limit: UsageLimit) = if (limit.percent >= 100) "critical" else limit.severity

/** 412000 -> "412k", 1000000 -> "1M". */
fun compactTokens(count: Long): String = when {
    count >= 1_000_000 -> (count / 100_000).let { tenths -> if (tenths % 10 == 0L) "${tenths / 10}M" else "${tenths / 10}.${tenths % 10}M" }
    count >= 1_000 -> "${count / 1_000}k"
    else -> count.toString()
}

fun updatedLabel(updatedAt: Long, now: Long): String {
    if (updatedAt <= 0) return ""
    val minutes = (now - updatedAt) / 60_000
    return when {
        minutes < 1 -> "Updated just now"
        minutes < 60 -> "Updated $minutes min ago"
        else -> "Updated ${minutes / 60}h ago"
    }
}

@Composable private fun severityColor(severity: String): Color = when (severity) {
    "critical" -> MaterialTheme.colorScheme.error
    "warning" -> MaterialTheme.colorScheme.tertiary
    else -> MaterialTheme.colorScheme.primary
}

@Composable fun Ring(fraction: Float, color: Color, size: Dp, stroke: Dp = 3.dp) {
    CircularProgressIndicator(
        progress = { fraction.coerceIn(0f, 1f) }, Modifier.size(size), color = color, strokeWidth = stroke,
        trackColor = MaterialTheme.colorScheme.surfaceContainerHighest, strokeCap = StrokeCap.Round, gapSize = 1.dp,
    )
}

/**
 * Top bar meter: each enabled agent's weekly use as a ring in its colour (Claude orange, Codex blue) and a number,
 * which turns amber or red near a limit. Opens the full breakdown. Hidden when the Mac reports nothing.
 */
@Composable fun UsageMeter(model: BridgeModel, onClick: () -> Unit) {
    val enabled = model.agents.takeIf { it.isNotEmpty() }?.filter { it.enabled }?.map { it.id }?.toSet()
    val rings = weeklyUsage(model.usage.agents, enabled)
    if (rings.isEmpty()) return
    Surface(
        onClick = onClick, shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier.padding(end = Spacing.xs).semantics {
            contentDescription = "Usage. " + rings.joinToString(", ") { (agent, limit) -> "${agent.name} ${limit.label} at ${limit.percent}%" }
        },
    ) {
        // The surface carries the label and the click; its rings and numbers stay out of the reading.
        Row(
            Modifier.clearAndSetSemantics {}.heightIn(min = Sizes.pill).padding(start = Spacing.sm + Spacing.xxs, end = Spacing.md),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            rings.forEach { (agent, limit) ->
                val severity = limitSeverity(limit)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Ring(limit.percent / 100f, agentColors(agent.id).accent, Sizes.ring, 2.5.dp)
                    Spacer(Modifier.width(Spacing.xs + Spacing.xxs))
                    Text("${limit.percent}%", style = MaterialTheme.typography.labelLarge.copy(fontFeatureSettings = "tnum"), color = if (severity == "normal") MaterialTheme.colorScheme.onSurface else severityColor(severity))
                }
            }
        }
    }
}

/** Plan limits for each agent, refreshed on open. A compact sheet that sizes to its content. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable fun UsageSheet(model: BridgeModel, onDismiss: () -> Unit) {
    LaunchedEffect(Unit) { model.usage.refresh() }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(start = Spacing.lg, end = Spacing.lg, bottom = Spacing.xxl)) {
            UsageHeader(model)
            Spacer(Modifier.height(Spacing.md))
            UsageGroups(model, Pocket.colors.panel)
        }
    }
}

@Composable private fun UsageHeader(model: BridgeModel) {
    val now by produceState(System.currentTimeMillis()) { while (true) { delay(30_000); value = System.currentTimeMillis() } }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Usage", Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge)
            val updated = updatedLabel(model.usage.agents.maxOfOrNull { it.updatedAt } ?: 0, now)
            if (updated.isNotEmpty()) Text(updated, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Box(Modifier.size(Sizes.touch), contentAlignment = Alignment.Center) {
            if (model.usage.loading) CircularProgressIndicator(Modifier.size(Sizes.smallIcon), strokeWidth = 2.dp)
            else IconButton(onClick = { model.usage.refresh(force = true) }, enabled = model.online) { Icon(Icons.Default.Refresh, "Refresh usage") }
        }
    }
}

/** One rounded group per agent: plan, each limit as a bar with its reset time, then credits and banked resets. */
@Composable fun UsageGroups(model: BridgeModel, container: Color = Pocket.colors.row) {
    val now by produceState(System.currentTimeMillis()) { while (true) { delay(30_000); value = System.currentTimeMillis() } }
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
        model.usage.agents.forEach { agent ->
            Surface(color = container, shape = groupShape(0, 1)) {
                Column(Modifier.fillMaxWidth().padding(Spacing.lg), verticalArrangement = Arrangement.spacedBy(Spacing.lg)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        AgentDot(agent.id, Modifier.padding(end = Spacing.sm))
                        Text(agent.name, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleMedium)
                        if (agent.plan.isNotBlank()) Surface(shape = CircleShape, color = MaterialTheme.colorScheme.secondaryContainer) {
                            Text(agent.plan, Modifier.padding(horizontal = Spacing.md, vertical = Spacing.xs), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSecondaryContainer)
                        }
                    }
                    agent.limits.forEach { LimitRow(it, now) }
                    agent.credits?.let { credits ->
                        Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically) {
                            Text("Credits", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                            Text(
                                NumberFormat.getNumberInstance().apply { minimumFractionDigits = 2; maximumFractionDigits = 2 }.format(credits),
                                style = MaterialTheme.typography.labelLarge.copy(fontFeatureSettings = "tnum"),
                            )
                        }
                    }
                    agent.resets?.let { ResetRow(model, it, now) }
                }
            }
        }
    }
}

@Composable private fun LimitRow(limit: UsageLimit, now: Long) {
    val severity = limitSeverity(limit)
    val color = severityColor(severity)
    val reset = resetLabel(limit.resetsAt, now)
    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        Row(verticalAlignment = Alignment.Bottom) {
            Text(limit.label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
            if (severity != "normal") Text(if (limit.percent >= 100) "Limit reached · " else "Near limit · ", style = MaterialTheme.typography.labelMedium, color = color)
            Text("${limit.percent}%", style = MaterialTheme.typography.labelLarge.copy(fontFeatureSettings = "tnum"), color = if (severity == "normal") MaterialTheme.colorScheme.onSurface else color)
        }
        LinearProgressIndicator(
            progress = { limit.percent / 100f }, Modifier.fillMaxWidth().height(6.dp), color = color,
            trackColor = MaterialTheme.colorScheme.surfaceContainerHighest, strokeCap = StrokeCap.Round, gapSize = 3.dp, drawStopIndicator = {},
        )
        if (reset.isNotEmpty()) Text(reset, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** How full this Claude chat's context window was after its last turn. Tap for the token counts. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable fun ContextMeter(context: ContextUse) {
    val tooltip = rememberTooltipState(isPersistent = false)
    val scope = rememberCoroutineScope()
    val percent = context.percent
    val color = when { percent >= 95 -> MaterialTheme.colorScheme.error; percent >= 80 -> MaterialTheme.colorScheme.tertiary; else -> MaterialTheme.colorScheme.primary }
    val detail = "${compactTokens(context.used)} of ${compactTokens(context.window)} tokens"
    TooltipBox(TooltipDefaults.rememberPlainTooltipPositionProvider(), tooltip = { PlainTooltip { Text(detail) } }, state = tooltip) {
        Surface(
            onClick = { scope.launch { tooltip.show() } }, shape = CircleShape, color = Color.Transparent,
            modifier = Modifier.semantics { contentDescription = "Context $percent% full, $detail" },
        ) {
            Row(Modifier.clearAndSetSemantics {}.heightIn(min = Sizes.pill).padding(horizontal = Spacing.sm), verticalAlignment = Alignment.CenterVertically) {
                Ring(percent / 100f, color, 16.dp, 2.5.dp)
                Spacer(Modifier.width(Spacing.xs + Spacing.xxs))
                Text("$percent%", style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/**
 * Codex's banked resets: how many, when the next expires, and Use, which asks first. The Mac spends the credit
 * expiring soonest; the outcome shows under the row for a few seconds and the limits above refresh.
 */
@Composable private fun ResetRow(model: BridgeModel, resets: Resets, now: Long) {
    var confirm by remember { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    val haptics = rememberHaptics()
    val expiry = resets.next?.expiresAt?.let { expiryLabel(it, now) }.orEmpty()
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            Text(if (resets.available == 0) "No banked resets" else plural(resets.available, "banked reset"), style = MaterialTheme.typography.bodyMedium)
            if (resets.available > 0 && expiry.isNotEmpty()) Text("Next " + expiry.replaceFirstChar(Char::lowercase), style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
        }
        if (model.usage.resetting) Box(Modifier.size(Sizes.touch), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) }
        else if (resets.available > 0) FilledTonalButton(onClick = { confirm = true }, enabled = model.online) {
            Icon(PocketIcons.Reset, null, Modifier.size(Sizes.smallIcon)); Spacer(Modifier.width(Spacing.sm)); Text("Use")
        }
    }
    val message = model.usage.resetMessage
    LaunchedEffect(message) {
        if (message.isEmpty()) return@LaunchedEffect
        if (model.usage.resetFailed) haptics.perform(Haptic.Reject)
        delay(8_000); model.usage.clearResetMessage()
    }
    AnimatedVisibility(message.isNotEmpty(), enter = expandVertically(Motion.spatial(IntSize.VisibilityThreshold)) + fadeIn(Motion.effects()), exit = shrinkVertically(Motion.fastSpatial(IntSize.VisibilityThreshold)) + fadeOut(Motion.fastEffects())) {
        Row(Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }, verticalAlignment = Alignment.CenterVertically) {
            val tint = if (model.usage.resetFailed) colors.error else colors.primary
            Icon(if (model.usage.resetFailed) PocketIcons.Error else Icons.Default.Check, null, Modifier.size(Sizes.smallIcon), tint = tint)
            Spacer(Modifier.width(Spacing.sm))
            Text(message, style = MaterialTheme.typography.bodySmall, color = tint)
        }
    }
    if (confirm) AlertDialog(
        onDismissRequest = { confirm = false },
        title = { Text("Use 1 of ${resets.available} ${if (resets.available == 1) "reset" else "resets"}?") },
        text = { Text("Resets your Codex limits now.") },
        confirmButton = { TextButton(onClick = { confirm = false; haptics.perform(Haptic.Confirm); model.usage.useReset() }) { Text("Use reset") } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
    )
}
