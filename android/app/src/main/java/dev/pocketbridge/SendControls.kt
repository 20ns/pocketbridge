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

/**
 * Send when idle. While work runs: Stop, and once something is typed a split Steer button beside it. Steer is one
 * tap; its arrow (or a long press) opens Steer and, below it, Send now.
 */
@Composable fun SendControls(working: Boolean, sending: Boolean, ready: Boolean, stopEnabled: Boolean, onSend: (String?) -> Unit, onStop: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    AnimatedContent(
        working,
        transitionSpec = { (scaleIn(Motion.fastSpatial(), initialScale = 0.7f) + fadeIn(Motion.fastEffects())) togetherWith (scaleOut(Motion.fastSpatial(), targetScale = 0.7f) + fadeOut(Motion.fastEffects())) },
        label = "send",
    ) { live ->
        if (live) Row(verticalAlignment = Alignment.CenterVertically) {
            FilledIconButton(
                onClick = onStop, enabled = stopEnabled, modifier = Modifier.size(Sizes.sendButton),
                colors = IconButtonDefaults.filledIconButtonColors(containerColor = colors.errorContainer, contentColor = colors.onErrorContainer),
            ) { Icon(PocketIcons.Stop, "Stop") }
            AnimatedVisibility(ready, enter = expandHorizontally(Motion.fastSpatial(IntSize.VisibilityThreshold), Alignment.Start) + fadeIn(Motion.fastEffects()), exit = shrinkHorizontally(Motion.fastSpatial(IntSize.VisibilityThreshold), Alignment.Start) + fadeOut(Motion.fastEffects())) {
                SteerButton(Modifier.padding(start = Spacing.sm), onSend)
            }
        }
        else FilledIconButton(
            onClick = { onSend(null) }, enabled = ready, modifier = Modifier.size(Sizes.sendButton),
            colors = IconButtonDefaults.filledIconButtonColors(disabledContainerColor = Pocket.colors.pill, disabledContentColor = colors.onSurfaceVariant.copy(alpha = 0.55f)),
        ) {
            if (sending) CircularProgressIndicator(Modifier.size(Sizes.smallIcon).semantics { contentDescription = "Sending" }, strokeWidth = 2.dp, color = colors.onSurfaceVariant)
            else Icon(PocketIcons.ArrowUp, "Send", Modifier.size(22.dp))
        }
    }
}

/** M3 split button: "Steer" leads; the arrow segment opens the two ways to send while a turn runs. */
@OptIn(ExperimentalFoundationApi::class)
@Composable private fun SteerButton(modifier: Modifier, onSend: (String?) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val haptics = rememberHaptics()
    var menu by remember { mutableStateOf(false) }
    val outer = Sizes.sendButton / 2
    Row(modifier.height(Sizes.sendButton), horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
        Row(
            Modifier.fillMaxHeight().clip(RoundedCornerShape(outer, Corners.groupInner, Corners.groupInner, outer)).background(colors.primary)
                .combinedClickable(onClickLabel = "Steer the running turn", role = Role.Button, onLongClickLabel = "More ways to send", onLongClick = { haptics.perform(Haptic.LongPress); menu = true }) { onSend(STEER) }
                .padding(start = Spacing.md, end = Spacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(PocketIcons.ArrowUp, null, Modifier.size(Sizes.smallIcon), tint = colors.onPrimary)
            Spacer(Modifier.width(Spacing.xs + Spacing.xxs))
            Text("Steer", style = MaterialTheme.typography.labelLarge, color = colors.onPrimary, maxLines = 1)
        }
        Box {
            val turn by animateFloatAsState(if (menu) 180f else 0f, Motion.fastSpatial(), label = "steer-chevron")
            Box(
                Modifier.fillMaxHeight().width(Sizes.pill).clip(RoundedCornerShape(Corners.groupInner, outer, outer, Corners.groupInner)).background(colors.primary)
                    .clickable(onClickLabel = "More ways to send", role = Role.Button) { menu = true },
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Default.ArrowDropDown, "Send options", Modifier.rotate(turn), tint = colors.onPrimary) }
            DropdownMenu(menu, { menu = false }, Modifier.widthIn(min = 220.dp, max = 300.dp), shape = RoundedCornerShape(Corners.groupOuter), containerColor = Pocket.colors.panel, shadowElevation = 8.dp) {
                Text("Send", Modifier.padding(start = Spacing.lg, end = Spacing.lg, top = Spacing.xs, bottom = Spacing.xs).semantics { heading() }, style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                SendChoice(PocketIcons.ArrowUp, "Steer", "Joins the turn at its next step") { menu = false; onSend(STEER) }
                SendChoice(PocketIcons.SkipNext, "Send now", "Interrupts and runs this next") { menu = false; onSend(INTERRUPT) }
            }
        }
    }
}

@Composable private fun SendChoice(icon: ImageVector, label: String, detail: String, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    DropdownMenuItem(
        text = {
            Column(Modifier.padding(vertical = Spacing.xs), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                Text(label, style = MaterialTheme.typography.bodyLarge, color = colors.onSurface)
                Text(detail, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
            }
        },
        leadingIcon = { Icon(icon, null, Modifier.size(20.dp), tint = colors.onSurfaceVariant) },
        onClick = onClick,
        modifier = Modifier.padding(horizontal = Spacing.xs).clip(RoundedCornerShape(Corners.groupInner * 3)),
    )
}
