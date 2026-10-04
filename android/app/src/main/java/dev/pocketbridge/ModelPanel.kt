package dev.pocketbridge

import androidx.activity.compose.BackHandler
import androidx.activity.compose.PredictiveBackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.foundation.ScrollState
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlin.coroutines.cancellation.CancellationException

private val versionNumber = Regex("\\d+(?:[.-]\\d+)*")

/** A model name's family words and version: "GPT-6-Astra" is {gpt, astra} 6, "Sonnet 4.6" is {sonnet} 4.6. */
private fun modelVersion(name: String): Pair<Set<String>, List<Int>>? {
    val version = versionNumber.find(name)?.value?.split('.', '-')?.mapNotNull(String::toIntOrNull)?.takeIf { it.isNotEmpty() } ?: return null
    val family = name.lowercase().split(Regex("[^a-z0-9]+")).filter { it.isNotEmpty() && it.none(Char::isDigit) }.toSet()
    return if (family.isEmpty()) null else family to version
}

private fun compareVersion(left: List<Int>, right: List<Int>): Int {
    for (i in 0 until maxOf(left.size, right.size)) (left.getOrElse(i) { 0 }).compareTo(right.getOrElse(i) { 0 }).let { if (it != 0) return it }
    return 0
}

/**
 * The catalog split into current models and older versions, each in catalog order. A model is older when another of
 * its family (or a broader name containing its words, as GPT-6-Astra contains GPT) has a higher version.
 */
fun modelTiers(models: List<ModelInfo>): Pair<List<ModelInfo>, List<ModelInfo>> {
    val versions = models.map { modelVersion(it.name) }
    val older = models.indices.filter { i ->
        val (family, version) = versions[i] ?: return@filter false
        versions.indices.any { j -> j != i && versions[j]?.let { (other, newer) -> other.containsAll(family) && compareVersion(newer, version) > 0 } == true }
    }.toSet()
    return models.filterIndexed { i, _ -> i !in older } to models.filterIndexed { i, _ -> i in older }
}

/**
 * Models rise from the composer in a panel no taller than half the screen: current models first, older versions
 * below, its own scroll. An unsent chat switches agent at the top. One tap picks and closes. Back follows the gesture.
 */
@Composable fun BoxScope.ModelPanel(model: BridgeModel, visible: Boolean, onDismiss: () -> Unit) {
    RisingPanel(visible, onDismiss, "Close models") { ModelList(model, onDismiss) }
}

@Composable private fun ModelList(model: BridgeModel, onDismiss: () -> Unit) {
    val options = model.options
    val agents = if (model.canSwitchAgent) model.agents.filter { it.usable && it.models.isNotEmpty() } else listOfNotNull(model.agent(options.agent))
    var tab by remember { mutableStateOf(options.agent.takeIf { id -> agents.any { it.id == id } } ?: agents.firstOrNull()?.id ?: options.agent) }
    val agent = agents.find { it.id == tab }
    val selected = model.agent(options.agent)?.model(options.model)?.id ?: options.model
    val (latest, older) = remember(agent) { modelTiers(agent?.models.orEmpty()) }
    // An older model in use opens scrolled to it, with the row above it for context.
    val olderIndex = if (tab == options.agent) older.indexOfFirst { it.id == selected } else -1
    val list = remember(tab) { LazyListState(if (olderIndex >= 0) latest.size + olderIndex else 0) }
    Column {
        if (agents.size > 1) AgentSwitch(agents, tab) { tab = it }
        else Text(agent?.name ?: "Models", Modifier.padding(start = Spacing.xl, end = Spacing.xl, top = Spacing.lg, bottom = Spacing.xs).semantics { heading() }, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        LazyColumn(Modifier.fillMaxWidth(), list, PaddingValues(start = Spacing.sm, end = Spacing.sm, top = Spacing.xs, bottom = Spacing.sm)) {
            if (agent == null || agent.models.isEmpty()) item {
                Text("Model list unavailable. Check ${agent?.name ?: "the agent"} on your Mac.", Modifier.padding(Spacing.md), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            items(latest, key = { "latest:" + it.id }) { entry -> ModelRow(entry, tab == options.agent && entry.id == selected) { pick(model, agent!!, entry); onDismiss() } }
            if (older.isNotEmpty()) item(key = "older") {
                Row(Modifier.padding(start = Spacing.md, end = Spacing.md, top = Spacing.md, bottom = Spacing.xs), verticalAlignment = Alignment.CenterVertically) {
                    Text("Older versions", Modifier.semantics { heading() }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    HorizontalDivider(Modifier.padding(start = Spacing.md), color = MaterialTheme.colorScheme.outlineVariant)
                }
            }
            items(older, key = { "older:" + it.id }) { entry -> ModelRow(entry, tab == options.agent && entry.id == selected) { pick(model, agent!!, entry); onDismiss() } }
        }
    }
}

private fun pick(model: BridgeModel, agent: AgentInfo, entry: ModelInfo) {
    model.updateOptions(resolveOptions(agent, model.options.copy(model = entry.id, agent = agent.id)))
}

@Composable private fun ModelRow(entry: ModelInfo, chosen: Boolean, onPick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Corners.groupOuter - Spacing.xs)).background(if (chosen) colors.secondaryContainer else Color.Transparent)
            .selectable(chosen, role = Role.RadioButton, onClick = onPick).heightIn(min = 56.dp).padding(horizontal = Spacing.md, vertical = Spacing.sm + Spacing.xxs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            Text(entry.name, style = MaterialTheme.typography.titleSmall, color = if (chosen) colors.onSecondaryContainer else colors.onSurface)
            if (entry.description.isNotBlank()) Text(entry.description, style = MaterialTheme.typography.bodySmall, color = if (chosen) colors.onSecondaryContainer else colors.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (chosen) Icon(Icons.Default.Check, "Selected", Modifier.padding(start = Spacing.sm), tint = colors.onSecondaryContainer)
    }
}

/** Claude or Codex, for a chat that hasn't been sent. A tonal track with the chosen agent filled. */
@Composable private fun AgentSwitch(agents: List<AgentInfo>, selected: String, onSelect: (String) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val haptics = rememberHaptics()
    Row(
        Modifier.padding(start = Spacing.md, end = Spacing.md, top = Spacing.md, bottom = Spacing.xs).fillMaxWidth()
            .background(Pocket.colors.pill, CircleShape).padding(Spacing.xs).selectableGroup(),
    ) {
        agents.forEach { agent ->
            val on = agent.id == selected
            val fill by animateColorAsState(if (on) colors.secondaryContainer else Color.Transparent, Motion.effects(), label = "agent")
            Box(
                Modifier.weight(1f).heightIn(min = 40.dp).clip(CircleShape).background(fill).selectable(on, role = Role.Tab) { if (!on) haptics.perform(Haptic.Tick); onSelect(agent.id) },
                contentAlignment = Alignment.Center,
            ) { Text(agent.name, style = MaterialTheme.typography.labelLarge, color = if (on) colors.onSecondaryContainer else colors.onSurfaceVariant) }
        }
    }
}
