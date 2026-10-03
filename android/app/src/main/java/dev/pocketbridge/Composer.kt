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
    LaunchedEffect(query != null, commandKey) { if (query != null) model.loadCommands(projectId, options.agent) }
    val matches = query?.let { filterCommands(model.commands[commandKey].orEmpty(), it) }.orEmpty()
    val loadingCommands = query != null && commandKey in model.commandsLoading && model.commands[commandKey] == null
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
                                Pill(modelName(agent, options.model), "Model", !locked, modelsOpen) { keyboard?.hide(); focus.clearFocus(); onModels() }
                                if (info == null || info.efforts.isNotEmpty()) PillMenu(effortName(agent, options.model, options.effort), "Effort", !locked) { close ->
                                    (info?.efforts ?: listOf(options.effort)).forEach { effort ->
                                        MenuChoice(effortLabel(effort), selected = effort == options.effort) { model.updateOptions(options.copy(effort = effort)); close() }
                                    }
                                }
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

/**
 * Send when idle. While work runs: Stop, and once something is typed a split Steer button beside it. Steer is one
 * tap; its arrow (or a long press) opens Steer and, below it, Send now.
 */
@Composable private fun SendControls(working: Boolean, sending: Boolean, ready: Boolean, stopEnabled: Boolean, onSend: (String?) -> Unit, onStop: () -> Unit) {
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
            if (sending) CircularProgressIndicator(Modifier.size(Sizes.smallIcon), strokeWidth = 2.dp, color = colors.onSurfaceVariant)
            else Icon(PocketIcons.ArrowUp, "Send", Modifier.size(22.dp))
        }
    }
}

/** M3 split button: "Steer" leads; the arrow segment opens the two ways to send while a turn runs. */
@OptIn(ExperimentalFoundationApi::class)
@Composable private fun SteerButton(modifier: Modifier, onSend: (String?) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val haptics = LocalHapticFeedback.current
    var menu by remember { mutableStateOf(false) }
    val outer = Sizes.sendButton / 2
    Row(modifier.height(Sizes.sendButton), horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
        Row(
            Modifier.fillMaxHeight().clip(RoundedCornerShape(outer, Corners.groupInner, Corners.groupInner, outer)).background(colors.primary)
                .combinedClickable(onClickLabel = "Steer the running turn", role = Role.Button, onLongClickLabel = "More ways to send", onLongClick = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); menu = true }) { onSend(STEER) }
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

/** Picked images above the prompt: each shows its upload, can be removed, and retries on tap when it failed. */
@Composable private fun AttachmentStrip(model: BridgeModel, attachments: List<Attachment>) {
    val open = LocalImageViewer.current
    val uploaded = attachments.filter { it.state == UploadState.Ready }.map { it.upload }
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = Spacing.md, end = Spacing.md, top = Spacing.md),
        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        attachments.forEachIndexed { index, item -> key(item.key) { AttachmentTile(model, item, index, attachments.size) { uploaded.indexOf(item.upload).takeIf { it >= 0 }?.let { open(uploaded, it) } } } }
    }
}

@Composable private fun AttachmentTile(model: BridgeModel, item: Attachment, index: Int, count: Int, onView: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val size = with(LocalDensity.current) { Sizes.thumbnail.roundToPx() }
    val label = "Image ${index + 1} of $count, " + when (item.state) { UploadState.Uploading -> "uploading"; UploadState.Failed -> "didn't upload"; UploadState.Ready -> "ready" }
    // The remove mark overlaps the corner, so the tile sits inside a slightly larger box.
    Box(Modifier.size(Sizes.thumbnail + Spacing.sm)) {
        Box(
            Modifier.align(Alignment.BottomStart).size(Sizes.thumbnail).clip(RoundedCornerShape(Corners.groupInner * 3)).border(1.dp, Pocket.colors.composerBorder, RoundedCornerShape(Corners.groupInner * 3))
                .clickable(onClickLabel = if (item.state == UploadState.Failed) "Retry upload" else "View image", enabled = item.state != UploadState.Uploading) {
                    if (item.state == UploadState.Failed) model.retryAttachment(item.key) else onView()
                }
                .semantics(mergeDescendants = true) { contentDescription = label },
            contentAlignment = Alignment.Center,
        ) {
            if (item.preparing) Box(Modifier.fillMaxSize().background(colors.surfaceContainerHigh))
            else LocalImage(model, item.file, size, Modifier.fillMaxSize(), description = null)
            when (item.state) {
                UploadState.Uploading -> Box(Modifier.fillMaxSize().background(colors.scrim.copy(alpha = 0.35f)), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
                }
                UploadState.Failed -> Box(Modifier.fillMaxSize().background(colors.errorContainer.copy(alpha = 0.88f)), contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Refresh, null, Modifier.size(22.dp), tint = colors.onErrorContainer)
                }
                UploadState.Ready -> Unit
            }
        }
        Box(
            Modifier.align(Alignment.TopEnd).size(Sizes.pill - Spacing.xs).clip(CircleShape).clickable(onClickLabel = "Remove image ${index + 1}", role = Role.Button) { model.removeAttachment(item.key) },
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(20.dp).background(colors.inverseSurface, CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.Close, "Remove image ${index + 1}", Modifier.size(14.dp), tint = colors.inverseOnSurface)
            }
        }
    }
}

/** A compact choice in the composer. Its chevron turns while its menu or panel is open. */
@Composable private fun Pill(label: String, description: String, enabled: Boolean, open: Boolean, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val container by animateColorAsState(if (open) colors.secondaryContainer else Pocket.colors.pill, Motion.effects(), label = "pill")
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

/** One menu row: label, optional one-line detail, a check on the current choice. */
@Composable fun MenuChoice(label: String, detail: String = "", selected: Boolean, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    DropdownMenuItem(
        text = {
            Column(Modifier.padding(vertical = Spacing.xs), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                Text(label, style = MaterialTheme.typography.bodyLarge, color = if (selected) colors.primary else colors.onSurface)
                if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
            }
        },
        onClick = onClick,
        trailingIcon = { if (selected) Icon(Icons.Default.Check, "Selected", tint = colors.primary) },
        modifier = Modifier.padding(horizontal = Spacing.xs).clip(RoundedCornerShape(Corners.groupInner * 3)).then(if (selected) Modifier.background(colors.secondaryContainer.copy(alpha = 0.6f)) else Modifier),
    )
}

/**
 * Models rise from the composer in a panel no taller than half the screen: current models first, older versions
 * below, its own scroll. An unsent chat switches agent at the top. One tap picks and closes. Back follows the gesture.
 */
@Composable fun BoxScope.ModelPanel(model: BridgeModel, visible: Boolean, onDismiss: () -> Unit) {
    var back by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(visible) { if (visible) back = 0f }
    PredictiveBackHandler(enabled = visible) { events ->
        try { events.collect { back = it.progress }; onDismiss() } catch (cancelled: CancellationException) { back = 0f; throw cancelled }
    }
    AnimatedVisibility(visible, enter = fadeIn(Motion.effects()), exit = fadeOut(Motion.fastEffects())) {
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.32f)).clickable(remember { MutableInteractionSource() }, null, onClickLabel = "Close models", onClick = onDismiss))
    }
    val maxHeight = (LocalConfiguration.current.screenHeightDp * 0.5f).dp
    AnimatedVisibility(
        visible, Modifier.align(Alignment.BottomCenter),
        enter = expandVertically(Motion.spatial(IntSize.VisibilityThreshold), expandFrom = Alignment.Bottom) + fadeIn(Motion.effects()),
        exit = shrinkVertically(Motion.fastSpatial(IntSize.VisibilityThreshold), shrinkTowards = Alignment.Bottom) + fadeOut(Motion.fastEffects()),
    ) {
        Surface(
            Modifier.padding(horizontal = Spacing.sm, vertical = Spacing.xs).fillMaxWidth().heightIn(max = maxHeight)
                .graphicsLayer { val p = back; transformOrigin = TransformOrigin(0.5f, 1f); scaleX = 1f - 0.06f * p; scaleY = 1f - 0.06f * p; translationY = p * 16.dp.toPx() },
            shape = RoundedCornerShape(Corners.composer), color = Pocket.colors.panel, shadowElevation = 8.dp, border = BorderStroke(1.dp, Pocket.colors.composerBorder),
        ) { ModelList(model, onDismiss) }
    }
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
    Row(
        Modifier.padding(start = Spacing.md, end = Spacing.md, top = Spacing.md, bottom = Spacing.xs).fillMaxWidth()
            .background(Pocket.colors.pill, CircleShape).padding(Spacing.xs).selectableGroup(),
    ) {
        agents.forEach { agent ->
            val on = agent.id == selected
            val fill by animateColorAsState(if (on) colors.secondaryContainer else Color.Transparent, Motion.effects(), label = "agent")
            Box(
                Modifier.weight(1f).heightIn(min = 40.dp).clip(CircleShape).background(fill).selectable(on, role = Role.Tab) { onSelect(agent.id) },
                contentAlignment = Alignment.Center,
            ) { Text(agent.name, style = MaterialTheme.typography.labelLarge, color = if (on) colors.onSecondaryContainer else colors.onSurfaceVariant) }
        }
    }
}
