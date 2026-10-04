package dev.pocketbridge

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable fun StepsGroup(group: Steps, live: Boolean, modifier: Modifier = Modifier) {
    var open by rememberSaveable(group.key) { mutableStateOf(false) }
    val failed = group.steps.count { it.failed }
    val turn by animateFloatAsState(if (open) 180f else 0f, Motion.fastSpatial(), label = "chevron")
    val colors = MaterialTheme.colorScheme
    Surface(modifier.fillMaxWidth(), color = Pocket.colors.row, shape = RoundedCornerShape(Corners.groupOuter)) {
        Column(Modifier.animateContentSize(Motion.spatial(IntSize.VisibilityThreshold))) {
            Row(
                Modifier.fillMaxWidth().clickable(onClickLabel = if (open) "Hide steps" else "Show steps") { open = !open }.heightIn(min = 56.dp).padding(start = Spacing.md, end = Spacing.md, top = Spacing.sm, bottom = Spacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(32.dp).background(Pocket.colors.pill, CircleShape), contentAlignment = Alignment.Center) {
                    if (live) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) else Icon(PocketIcons.Terminal, null, Modifier.size(16.dp), tint = colors.onSurfaceVariant)
                }
                Column(Modifier.weight(1f).padding(horizontal = Spacing.md), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                    Text(stepsTitle(group.steps), style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (!open) group.steps.last().summary.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
                if (failed > 0) Text("$failed failed", Modifier.padding(end = Spacing.sm), style = MaterialTheme.typography.labelMedium, color = colors.error)
                Icon(Icons.Default.KeyboardArrowDown, null, Modifier.rotate(turn), tint = colors.onSurfaceVariant)
            }
            if (open) Column(Modifier.padding(start = Spacing.sm, end = Spacing.sm, bottom = Spacing.sm)) {
                HorizontalDivider(Modifier.padding(horizontal = Spacing.sm, vertical = Spacing.xxs), color = colors.outlineVariant.copy(alpha = 0.6f))
                group.steps.forEach { StepRow(it) }
            }
        }
    }
}

/** Language for a step's input as [describeInput] prints it: a shell command or an edit as removed and added lines. */
private fun inputLanguage(described: String) = when {
    described.startsWith("$ ") -> "sh"
    described.lines().drop(1).let { rest -> rest.isNotEmpty() && rest.all { it.startsWith("- ") || it.startsWith("+ ") || it == "-" || it == "+" } } -> "diff"
    else -> ""
}

@Composable private fun StepRow(step: Step) {
    var open by rememberSaveable(step.id) { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(Corners.groupInner * 3)).clickable(onClickLabel = if (open) "Hide details" else "Show details") { open = !open }
                .heightIn(min = Sizes.touch).padding(horizontal = Spacing.sm, vertical = Spacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold, color = colors.onSurface)) { append(step.tool) }
                    if (step.summary.isNotEmpty()) append("  " + step.summary)
                },
                Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant, maxLines = if (open) 4 else 1, overflow = TextOverflow.Ellipsis,
            )
            if (step.failed) Row(Modifier.padding(start = Spacing.sm), verticalAlignment = Alignment.CenterVertically) {
                Icon(PocketIcons.Error, null, Modifier.size(14.dp), tint = colors.error)
                Spacer(Modifier.width(Spacing.xs))
                Text("Failed", style = MaterialTheme.typography.labelMedium, color = colors.error)
            }
        }
        AnimatedVisibility(open, enter = expandVertically(Motion.spatial(IntSize.VisibilityThreshold)) + fadeIn(Motion.effects()), exit = shrinkVertically(Motion.fastSpatial(IntSize.VisibilityThreshold)) + fadeOut(Motion.fastEffects())) {
            Column(Modifier.padding(start = Spacing.sm, end = Spacing.sm, bottom = Spacing.sm), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                if (step.isNote) Detail(step.input)
                else if (step.input.isNotBlank()) {
                    val described = remember(step.input) { describeInput(step.tool, step.input) }
                    Detail(described, inputLanguage(described))
                }
                step.result?.takeIf { it.isNotBlank() }?.let { Detail(it, failed = step.failed) }
            }
        }
    }
}

@Composable private fun Detail(text: String, language: String = "", failed: Boolean = false) {
    val shown = remember(text) { if (text.length > 6000) text.take(6000) + "\n…" else text }
    val pocket = Pocket.colors
    val colors = MaterialTheme.colorScheme
    val highlighted = rememberHighlighted(shown, language)
    Surface(
        Modifier.fillMaxWidth(), color = if (failed) colors.errorContainer else pocket.code, contentColor = if (failed) colors.onErrorContainer else colors.onSurface,
        shape = RoundedCornerShape(Corners.code - Spacing.xs), border = if (failed) null else BorderStroke(1.dp, pocket.codeBorder),
    ) {
        SelectionContainer(Modifier.heightIn(max = 280.dp).verticalScroll(rememberScrollState())) {
            Text(highlighted, Modifier.padding(Spacing.md), style = MaterialTheme.typography.code)
        }
    }
}
