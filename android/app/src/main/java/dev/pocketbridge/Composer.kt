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
import androidx.compose.foundation.selection.toggleable
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
 * The git strip, then one box: images, prompt, and a row of attach, model, effort and permission pills with Send or
 * Stop. While a turn runs and something is typed, Steer joins Stop, with Send now in its menu. Fixed above the
 * keyboard and navigation bar.
 */
@Composable fun Composer(model: BridgeModel, modelsOpen: Boolean, onModels: () -> Unit) {
    val chat = model.chat
    val status = chat?.optString("status")
    val working = isWorking(status)
    val pending = model.pending
    val colors = MaterialTheme.colorScheme
    val pocket = Pocket.colors
    val haptics = LocalHapticFeedback.current
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    val options = model.options
    val agent = model.agent(options.agent)
    val info = agent?.model(options.model)
    val projectId = chat?.optString("projectId").orEmpty()
    // Choices apply to the next prompt, so they stay open while work runs; only an unconfirmed prompt locks them.
    val locked = pending != null || model.busy
    // A saved chat whose agent is switched off can be read but not continued until it's back on.
    val off = agent?.enabled == false && !model.canSwitchAgent && pending == null
    // While a prompt awaits confirmation it shows in the conversation, so the box stays empty and locked.
    val shownDraft = if (pending == null) model.draft else ""
    val shownImages = if (pending == null) model.attachments else emptyList()
    val ready = pending == null && !off && !model.busy && model.online && model.selected.isNotEmpty() && canSendDraft(model.draft, model.attachments)
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MAX_ATTACHMENTS)) { model.attach(it) }
    val canAttach = pending == null && !model.busy && !off && model.selected.isNotEmpty() && model.attachments.size < MAX_ATTACHMENTS
    // "/" commands: shown while the draft is a bare "/word"; Back or Escape hides them until the text changes.
    var slashHidden by remember { mutableStateOf<String?>(null) }
    val query = slashQuery(shownDraft)?.takeIf { shownDraft != slashHidden && !locked }
    val commandKey = "$projectId:${options.agent}"
    LaunchedEffect(query != null, commandKey) { if (query != null) model.details.loadCommands(projectId, options.agent) }
    val matches = query?.let { filterCommands(model.details.commands[commandKey].orEmpty(), it) }.orEmpty()
    val loadingCommands = query != null && commandKey in model.details.commandsLoading && model.details.commands[commandKey] == null
    val slashOpen = query != null && (matches.isNotEmpty() || loadingCommands)
    BackHandler(slashOpen) { slashHidden = shownDraft }
    var boxWidth by remember { mutableIntStateOf(0) }
    Surface(color = colors.surface) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(start = Spacing.sm, end = Spacing.sm, top = Spacing.xs, bottom = Spacing.sm)) {
            if (off) Row(Modifier.fillMaxWidth().padding(start = Spacing.md, bottom = Spacing.xs), verticalAlignment = Alignment.CenterVertically) {
                Text("${agent?.name ?: "This agent"} is off", Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, color = colors.onSurfaceVariant)
                TextButton(onClick = { model.setAgentEnabled(options.agent, true) }, enabled = model.online && !model.busy) { Text("Turn on") }
            }
            if (projectId.isNotEmpty()) GitStrip(model, projectId)
            Box {
                Surface(Modifier.onSizeChanged { boxWidth = it.width }, shape = RoundedCornerShape(Corners.composer), color = pocket.composer, border = BorderStroke(1.dp, pocket.composerBorder)) {
                    Column(Modifier.animateContentSize(Motion.fastSpatial(IntSize.VisibilityThreshold))) {
                        if (shownImages.isNotEmpty()) AttachmentStrip(model, shownImages)
                        MessageField(
                            value = shownDraft, onValue = { if (pending == null) model.editDraft(it) },
                            enabled = pending == null && !model.busy,
                            placeholder = when { pending != null -> "Waiting for your Mac to confirm"; status == "waiting" -> "Answer above to continue"; working -> "Steer or add a message"; else -> "Message ${agent?.name ?: "Claude"}" },
                            onEscape = { if (slashOpen) { slashHidden = shownDraft; true } else false },
                        )
                        Row(Modifier.fillMaxWidth().padding(start = Spacing.sm, end = Spacing.sm, bottom = Spacing.sm), verticalAlignment = Alignment.CenterVertically) {
                            val pills = rememberScrollState()
                            Row(Modifier.weight(1f).fadeEnd(pills).horizontalScroll(pills), horizontalArrangement = Arrangement.spacedBy(Spacing.xs + Spacing.xxs), verticalAlignment = Alignment.CenterVertically) {
                                AttachButton(canAttach) { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
                                // The model pill carries the agent's hint colour: orange for Claude, blue for Codex.
                                Pill(modelName(agent, options.model), "Model", !locked, modelsOpen, agentColors(options.agent).container) { keyboard?.hide(); focus.clearFocus(); onModels() }
                                if (info == null || info.efforts.isNotEmpty()) PillMenu(effortName(agent, options.model, options.effort), "Effort", !locked) { close ->
                                    (info?.efforts ?: listOf(options.effort)).forEach { effort ->
                                        MenuChoice(effortLabel(effort), selected = effort == options.effort) { model.updateOptions(options.copy(effort = effort)); close() }
                                    }
                                }
                                info?.speeds?.takeIf { it.isNotEmpty() }?.let { speeds -> SpeedPill(speeds, options.speed, !locked) { model.updateOptions(options.copy(speed = it)) } }
                                PillMenu(modeShort(options.mode), "Permissions", !locked) { close ->
                                    (agent?.modes ?: listOf(options.mode)).forEach { mode ->
                                        MenuChoice(modeLabel(mode), modeHelp(options.agent, mode), mode == options.mode) { model.updateOptions(options.copy(mode = mode)); close() }
                                    }
                                }
                            }
                            Spacer(Modifier.width(Spacing.sm))
                            SendControls(
                                working = working, sending = model.busy && pending != null, ready = ready && status != "stopping",
                                stopEnabled = !model.busy && model.online && status != "stopping",
                                onSend = { delivery -> haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove); model.send(delivery) },
                                onStop = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); model.stop() },
                            )
                        }
                    }
                }
                if (slashOpen) SlashMenu(matches, loadingCommands, boxWidth) { command -> model.editDraft("/${command.name} ") }
            }
        }
    }
}

/** Pills that run under Stop or Steer fade out instead of ending in a hard cut, so the row reads as scrollable. */
private fun Modifier.fadeEnd(scroll: ScrollState) = graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }.drawWithContent {
    drawContent()
    if (scroll.canScrollForward) {
        val width = Spacing.xxl.toPx()
        drawRect(Brush.horizontalGradient(listOf(Color.Black, Color.Transparent), startX = size.width - width, endX = size.width), topLeft = Offset(size.width - width, 0f), size = Size(width, size.height), blendMode = BlendMode.DstIn)
    }
}

/** Keeps the cursor where the person put it, and at the end when the text is replaced from outside (a picked command). */
@Composable private fun MessageField(value: String, onValue: (String) -> Unit, enabled: Boolean, placeholder: String, onEscape: () -> Boolean) {
    val colors = MaterialTheme.colorScheme
    val style = MaterialTheme.typography.bodyLarge
    var field by remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
    val shown = if (field.text == value) field else TextFieldValue(value, TextRange(value.length))
    BasicTextField(
        shown, { next -> field = next; if (next.text != value) onValue(next.text) },
        Modifier.fillMaxWidth().semantics { contentDescription = placeholder }.onPreviewKeyEvent { it.key == Key.Escape && it.type == KeyEventType.KeyUp && onEscape() },
        enabled = enabled, textStyle = style.copy(color = colors.onSurface), cursorBrush = SolidColor(colors.primary), maxLines = 8,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        decorationBox = { inner ->
            Box(Modifier.padding(start = Spacing.lg + Spacing.xxs, end = Spacing.lg, top = Spacing.md + Spacing.xxs, bottom = Spacing.sm)) {
                if (value.isEmpty()) Text(placeholder, style = style, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                inner()
            }
        },
    )
}

/** Opens the system photo picker. Tonal like the pills, round, with the image glyph. */
@Composable private fun AttachButton(enabled: Boolean, onClick: () -> Unit) {
    Surface(onClick = onClick, enabled = enabled, shape = CircleShape, color = Pocket.colors.pill, contentColor = MaterialTheme.colorScheme.onSurface, modifier = Modifier.alpha(if (enabled) 1f else 0.45f)) {
        Box(Modifier.size(Sizes.pill - Spacing.xxs), contentAlignment = Alignment.Center) { Icon(PocketIcons.AddPhoto, "Add images", Modifier.size(Sizes.smallIcon)) }
    }
}

/** A compact choice in the composer. Its chevron turns while its menu or panel is open. */
@Composable private fun Pill(label: String, description: String, enabled: Boolean, open: Boolean, closed: Color = Pocket.colors.pill, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val container by animateColorAsState(if (open) colors.secondaryContainer else closed, Motion.effects(), label = "pill")
    val turn by animateFloatAsState(if (open) 180f else 0f, Motion.fastSpatial(), label = "chevron")
    Surface(
        onClick = onClick, enabled = enabled, shape = CircleShape, color = container, contentColor = if (open) colors.onSecondaryContainer else colors.onSurface,
        modifier = Modifier.alpha(if (enabled) 1f else 0.45f).semantics { contentDescription = "$description: $label" },
    ) {
        Row(Modifier.heightIn(min = 34.dp).padding(start = Spacing.md, end = Spacing.xs + Spacing.xxs), verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.labelLarge, maxLines = 1)
            Icon(Icons.Default.ArrowDropDown, null, Modifier.size(Sizes.smallIcon).rotate(turn), tint = colors.onSurfaceVariant)
        }
    }
}

@Composable private fun PillMenu(label: String, description: String, enabled: Boolean, items: @Composable (close: () -> Unit) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        Pill(label, description, enabled, open) { open = true }
        DropdownMenu(
            open, { open = false }, Modifier.widthIn(min = 200.dp, max = 320.dp),
            shape = RoundedCornerShape(Corners.groupOuter), containerColor = Pocket.colors.panel, shadowElevation = 8.dp,
        ) {
            Text(description, Modifier.padding(start = Spacing.lg, end = Spacing.lg, top = Spacing.xs, bottom = Spacing.xs).semantics { heading() }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            items { open = false }
        }
    }
}

/**
 * The model's faster service tier, named by the CLI (Codex calls it Fast). One speed is a toggle: tonal with a bolt
 * when on. Several open a menu with Standard first. Hidden for models without speeds.
 */
@Composable private fun SpeedPill(speeds: List<SpeedInfo>, selected: String?, enabled: Boolean, onPick: (String?) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val chosen = speeds.find { it.id == selected }
    if (speeds.size > 1) {
        PillMenu(chosen?.name ?: "Standard", "Speed", enabled) { close ->
            MenuChoice("Standard", selected = chosen == null) { onPick(null); close() }
            speeds.forEach { speed -> MenuChoice(speed.name, speed.description, speed.id == selected) { onPick(speed.id); close() } }
        }
        return
    }
    val speed = speeds.single()
    val on = chosen != null
    val container by animateColorAsState(if (on) colors.secondaryContainer else Pocket.colors.pill, Motion.effects(), label = "speed")
    Surface(
        shape = CircleShape, color = container, contentColor = if (on) colors.onSecondaryContainer else colors.onSurfaceVariant,
        modifier = Modifier.alpha(if (enabled) 1f else 0.45f).toggleable(on, enabled = enabled, role = Role.Switch) { onPick(if (it) speed.id else null) }
            .semantics { contentDescription = speed.name + if (speed.description.isNotBlank()) ", " + speed.description else "" },
    ) {
        Row(Modifier.heightIn(min = 34.dp).padding(start = Spacing.sm + Spacing.xxs, end = Spacing.md), verticalAlignment = Alignment.CenterVertically) {
            Icon(PocketIcons.Bolt, null, Modifier.size(Sizes.smallIcon), tint = if (on) colors.onSecondaryContainer else colors.onSurfaceVariant)
            Spacer(Modifier.width(Spacing.xxs))
            Text(speed.name, style = MaterialTheme.typography.labelLarge, maxLines = 1, color = if (on) colors.onSecondaryContainer else colors.onSurface)
        }
    }
}
