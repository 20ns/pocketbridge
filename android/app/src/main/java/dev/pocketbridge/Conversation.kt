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

// Own prompts sit right in a teal bubble whose tail points at the sender. Replies are unbubbled, full-width reading text.
private val Mine = RoundedCornerShape(Corners.bubble, Corners.bubble, Corners.tail, Corners.bubble)

@Composable fun Conversation(model: BridgeModel) {
    val chat = model.chat
    val status = chat?.optString("status").orEmpty()
    // Once the chat stops working nothing it started still runs, whatever a sub-agent row last said.
    val working = isWorking(status)
    val stoppedAt = chat?.optLong("updatedAt")?.takeIf { it > 0 }
    val subagents = remember(model.subagents, model.turns, working, stoppedAt) { settledSubagents(model.subagents, model.turns, working, stoppedAt) }
    val entries = remember(model.messages, subagents, model.turns) { withSubagents(transcript(model.messages.map(::said)), subagents, model.turns) }
    val approvals = model.approvals.filter { it.optString("status") == "pending" }
    val pending = model.pending
    // The Mac stores a prompt under its delivery ID, so an accepted-but-unconfirmed prompt is already in the transcript.
    val pendingShown = pending != null && model.messages.any { it.optString("id") == pending.id }
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    // Shown once the newest content is about a screen away, including inside one long reply.
    val away = with(LocalDensity.current) { 480.dp.roundToPx() }
    val scrolledUp by remember { derivedStateOf { list.firstVisibleItemIndex > 1 || (list.firstVisibleItemIndex == 1 && list.firstVisibleItemScrollOffset > away) } }
    val live = status == "running" || status == "waiting"
    // A reply that closes a turn gets a Copy action; replies still streaming don't.
    val turnEnds = remember(entries, live, model.turns) { turnEnds(entries, live, model.turns) }
    // Each finished turn says how long it ran, once, beside the reply that closed it.
    val durations = remember(entries, model.turns) { turnDurations(entries, model.turns) }
    val startedAt = remember(model.messages, model.turns, working) { runningSince(model.turns, model.messages.lastOrNull { it.optString("role") == "user" }?.optLong("createdAt")?.takeIf { it > 0 }, working) }
    val lastWork = entries.lastOrNull { it !is Agents }
    // Copied in from a Mac session: dimmed, under one divider naming where it came from.
    val firstImported = entries.firstOrNull { it is Message && it.said.kind == "imported" }?.key
    val agentName = agentProduct(chat?.optString("agent").orEmpty())
    val activity = model.activity.ifBlank { chat?.optString("activity").orEmpty() }
    val runningAgents = subagents.count { it.running }
    val openImage = LocalImageViewer.current
    Box(Modifier.fillMaxSize()) {
        // Reverse layout anchors the newest content above the composer while replies stream in.
        LazyColumn(
            Modifier.fillMaxSize(), list, PaddingValues(start = Spacing.lg, end = Spacing.lg, top = Spacing.lg, bottom = Spacing.md),
            reverseLayout = true, verticalArrangement = Arrangement.spacedBy(Spacing.md, Alignment.Bottom),
        ) {
            item(key = "footer") { Footer(status, chat?.optString("error").orEmpty(), approvals.isNotEmpty(), liveStep(entries), startedAt, activity, runningAgents) }
            if (pending != null) item(key = "pending") {
                Unconfirmed(if (pendingShown) null else pending, model, openImage, Modifier.animateItem(fadeInSpec = Motion.effects(), placementSpec = null, fadeOutSpec = Motion.fastEffects()))
            }
            items(approvals.asReversed(), key = { "approval:" + it.getString("id") }) {
                ApprovalCard(it, model, Modifier.animateItem(fadeInSpec = Motion.effects(), placementSpec = null, fadeOutSpec = Motion.fastEffects()))
            }
            items(entries.asReversed(), key = { it.key }) { entry ->
                // New entries fade in; nothing slides, so streaming text never makes its neighbours drift.
                val fade = Modifier.animateItem(fadeInSpec = Motion.effects(), placementSpec = null, fadeOutSpec = null)
                when (entry) {
                    is Steps -> StepsGroup(entry, live = entry === lastWork && status == "running", fade)
                    is Agents -> SubagentsCard(entry, fade)
                    is Message -> Column(fade.fillMaxWidth()) {
                        val imported = entry.said.kind == "imported"
                        if (entry.key == firstImported) ImportedDivider(agentName)
                        when {
                            entry.said.role == "user" -> UserMessage(model, entry.said, openImage, Modifier.padding(top = if (entry.key == firstImported) 0.dp else Spacing.md))
                            entry.said.text.isNotBlank() -> Reply(entry.said.text, copyable = entry.key in turnEnds && !imported, durations[entry.key], if (imported) Modifier.alpha(0.7f) else Modifier)
                        }
                    }
                }
            }
            // A saved chat invites a first prompt only once its messages are known to be none; offline it says it's waiting.
            if (entries.isEmpty() && pending == null && !working && (model.transcriptReady || !model.online)) item(key = "empty") { EmptyConversation(model) }
        }
        AnimatedVisibility(
            scrolledUp, Modifier.align(Alignment.BottomCenter).padding(bottom = Spacing.md),
            enter = scaleIn(Motion.fastSpatial(), 0.6f) + fadeIn(Motion.fastEffects()), exit = scaleOut(Motion.fastSpatial(), targetScale = 0.6f) + fadeOut(Motion.fastEffects()),
        ) {
            SmallFloatingActionButton(
                onClick = { scope.launch { list.animateScrollToItem(0) } }, shape = CircleShape,
                containerColor = Pocket.colors.panel, contentColor = MaterialTheme.colorScheme.onSurface,
            ) { Icon(Icons.Default.KeyboardArrowDown, "Jump to latest") }
        }
    }
}

@Composable private fun ImportedDivider(agent: String) {
    val colors = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().padding(top = Spacing.md, bottom = Spacing.md), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = colors.outlineVariant)
        Text("Continued from $agent", Modifier.padding(horizontal = Spacing.md).semantics { heading() }, style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
        HorizontalDivider(Modifier.weight(1f), color = colors.outlineVariant)
    }
}

/** A prompt: its images, then its text in the bubble, then how it was delivered when it joined a running turn. */
@Composable private fun UserMessage(model: BridgeModel, said: Said, onImage: (List<String>, Int) -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        if (said.attachments.isNotEmpty()) PromptImages(model, said.attachments) { onImage(said.attachments, it) }
        // An image sent alone carries the Mac's stand-in text; the image already says it.
        if (said.text.isNotBlank() && !(said.attachments.isNotEmpty() && said.text in imageOnlyText)) UserBubble(said.text, quiet = said.kind == "imported")
        deliveryLabel(said.kind)?.let { (icon, label) ->
            Row(Modifier.padding(end = Spacing.sm), verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, null, Modifier.size(Sizes.tinyIcon), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(Spacing.xs))
                Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

private val imageOnlyText = setOf("Look at the attached image.", "Look at the attached images.")

private fun deliveryLabel(kind: String) = when (kind) { STEER -> PocketIcons.ArrowUp to "Steered"; INTERRUPT -> PocketIcons.SkipNext to "Sent now"; else -> null }

/** One image keeps its shape; several sit as square tiles. Tap opens the viewer. */
@OptIn(ExperimentalLayoutApi::class)
@Composable private fun PromptImages(model: BridgeModel, ids: List<String>, onOpen: (Int) -> Unit) {
    val density = LocalDensity.current
    val shape = RoundedCornerShape(Corners.code)
    if (ids.size == 1) {
        UploadedImage(
            model, ids[0], with(density) { 280.dp.roundToPx() },
            Modifier.padding(start = Spacing.huge).clip(shape).border(1.dp, Pocket.colors.composerBorder, shape).clickable(onClickLabel = "View image") { onOpen(0) },
            description = "Attached image", fit = true,
        )
    } else FlowRow(Modifier.padding(start = Spacing.huge), horizontalArrangement = Arrangement.spacedBy(Spacing.xs, Alignment.End), verticalArrangement = Arrangement.spacedBy(Spacing.xs), maxItemsInEachRow = 3) {
        ids.forEachIndexed { index, id ->
            UploadedImage(
                model, id, with(density) { Sizes.promptImage.roundToPx() },
                Modifier.size(Sizes.promptImage).clip(shape).border(1.dp, Pocket.colors.composerBorder, shape).clickable(onClickLabel = "View image") { onOpen(index) },
                description = "Attached image ${index + 1} of ${ids.size}",
            )
        }
    }
}

@Composable private fun EmptyConversation(model: BridgeModel) {
    val project = model.projects.find { it.optString("id") == model.chat?.optString("projectId") }
    val agent = model.agent(model.options.agent)?.name ?: "Claude"
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.xs, vertical = Spacing.xxxl), verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
        // Offline with nothing saved, this chat may well have history; don't invite a first prompt over it.
        if (!model.online) {
            Text("Waiting for your Mac", style = MaterialTheme.typography.headlineSmall)
            Text("Messages appear once it connects.", style = MaterialTheme.typography.bodyLarge, color = colors.onSurfaceVariant)
            return@Column
        }
        Text("What should $agent work on?", style = MaterialTheme.typography.headlineSmall)
        project?.let {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(PocketIcons.Folder, null, Modifier.size(Sizes.smallIcon), tint = colors.onSurfaceVariant)
                Spacer(Modifier.width(Spacing.sm))
                Text(compactPath(it.optString("path")), style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** [quiet]: a prompt copied in from a Mac session, tonal instead of teal so it reads as context, not as sent from here. */
@Composable private fun UserBubble(text: String, modifier: Modifier = Modifier, quiet: Boolean = false) {
    val pocket = Pocket.colors
    val container = if (quiet) MaterialTheme.colorScheme.secondaryContainer else pocket.userBubble
    val content = if (quiet) MaterialTheme.colorScheme.onSecondaryContainer else pocket.onUserBubble
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Spacer(Modifier.width(Spacing.huge))
        Surface(color = container, contentColor = content, shape = Mine) {
            // Default selection colours are the accent, which would vanish on an accent bubble.
            CompositionLocalProvider(LocalTextSelectionColors provides TextSelectionColors(content, content.copy(alpha = 0.35f))) {
                SelectionContainer { Text(text, Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.sm + Spacing.xxs), style = MaterialTheme.typography.bodyLarge) }
            }
        }
    }
}

@Composable private fun Reply(text: String, copyable: Boolean, worked: Long?, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth()) {
        Markdown(text, Modifier.fillMaxWidth())
        if (copyable || worked != null) Row(Modifier.offset(x = if (copyable) -Spacing.md else 0.dp).heightIn(min = Sizes.touch), verticalAlignment = Alignment.CenterVertically) {
            if (copyable) CopyButton(text, "Copy reply")
            worked?.let { Text(workedLabel(it), Modifier.padding(start = if (copyable) 0.dp else Spacing.xxs), style = MaterialTheme.typography.bodySmall.copy(fontFeatureSettings = "tnum"), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

/** A prompt whose delivery the Mac hasn't confirmed. Retry reuses its ID, so it can never run twice. */
@Composable private fun Unconfirmed(prompt: PendingPrompt?, model: BridgeModel, onImage: (List<String>, Int) -> Unit, modifier: Modifier = Modifier) {
    val sending = model.busy
    val colors = MaterialTheme.colorScheme
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        prompt?.let { UserMessage(model, Said(it.id, "user", it.text, attachments = it.attachments), onImage, Modifier.graphicsLayer { alpha = if (sending) 0.7f else 1f }) }
        Row(Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }, verticalAlignment = Alignment.CenterVertically) {
            if (sending) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = colors.onSurfaceVariant)
            else Icon(PocketIcons.Error, null, Modifier.size(16.dp), tint = colors.error)
            Spacer(Modifier.width(Spacing.xs + Spacing.xxs))
            Text(if (sending) "Sending…" else "Not confirmed", style = MaterialTheme.typography.labelMedium, color = if (sending) colors.onSurfaceVariant else colors.error)
            if (!sending) TextButton(onClick = model::send) { Text("Retry") }
        }
    }
}

@Composable private fun Footer(status: String, error: String, answering: Boolean, step: Step?, startedAt: Long?, activity: String, subagents: Int) {
    Box(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }) {
        when (status) {
            "running" -> Working("Working", step, startedAt, activity = activity, subagents = subagents)
            "waiting" -> if (!answering) Working("Waiting for your answer", null, startedAt, MaterialTheme.colorScheme.tertiary)
            "stopping" -> Working("Stopping", null, null, MaterialTheme.colorScheme.onSurfaceVariant)
            "interrupted" -> Note(PocketIcons.Pause, "Interrupted", error.ifEmpty { "Stopped before it finished." } + " Send a message to continue.")
            "error" -> Note(PocketIcons.Error, "Failed", error.ifEmpty { "Stopped with an error." }, failed = true)
        }
    }
}

/** Typing dots, then the status with its elapsed time and live sub-agents, then the agent's own summary or the step running now. */
@Composable private fun Working(label: String, step: Step?, startedAt: Long?, tint: Color = MaterialTheme.colorScheme.primary, activity: String = "", subagents: Int = 0) {
    val now by produceState(System.currentTimeMillis(), startedAt) { while (true) { value = System.currentTimeMillis(); delay(1000) } }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.padding(vertical = Spacing.xs), verticalAlignment = Alignment.Top) {
        Box(Modifier.height(20.dp), contentAlignment = Alignment.Center) { Typing(tint) }
        Column(Modifier.padding(start = Spacing.md).weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            Text(
                listOfNotNull(label, startedAt?.let { elapsedLabel(now - it) }, subagents.takeIf { it > 0 }?.let { plural(it, "sub-agent") + " running" }).joinToString(" · "),
                style = MaterialTheme.typography.labelLarge.copy(fontFeatureSettings = "tnum"), color = tint,
            )
            if (activity.isNotBlank()) Text(firstLine(activity, 160), style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            else step?.let {
                Text(
                    buildAnnotatedString { withStyle(SpanStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold)) { append(it.tool) }; if (it.summary.isNotEmpty()) append("  " + it.summary) },
                    style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** Three dots in a wave: the messaging cue that work is live. Read in the draw phase so it never recomposes. The status text beside it is what TalkBack reads. */
@Composable private fun Typing(tint: Color) {
    val pulse = rememberInfiniteTransition(label = "typing")
    val phase = pulse.animateFloat(0f, 3f, infiniteRepeatable(tween(1200, easing = LinearEasing)), label = "phase")
    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        repeat(3) { i ->
            Box(
                Modifier.size(6.dp).graphicsLayer {
                    val lift = 1f - kotlin.math.abs(phase.value - i - 0.5f).coerceAtMost(1f)
                    alpha = 0.3f + 0.7f * lift; translationY = -2.dp.toPx() * lift
                }.background(tint, CircleShape),
            )
        }
    }
}

/** How a turn ended, in the flow of the conversation. Long crash output folds. */
@Composable private fun Note(icon: ImageVector, title: String, body: String, failed: Boolean = false) {
    var full by rememberSaveable(body) { mutableStateOf(false) }
    val long = body.length > 280 || body.count { it == '\n' } > 4
    val colors = MaterialTheme.colorScheme
    Surface(Modifier.fillMaxWidth(), color = if (failed) colors.errorContainer else Pocket.colors.row, contentColor = if (failed) colors.onErrorContainer else colors.onSurface, shape = RoundedCornerShape(Corners.groupOuter)) {
        Row(Modifier.padding(start = Spacing.lg, end = Spacing.lg, top = Spacing.md + Spacing.xxs, bottom = if (long) Spacing.xs else Spacing.md + Spacing.xxs)) {
            Icon(icon, null, Modifier.size(20.dp), tint = if (failed) colors.error else colors.onSurfaceVariant)
            Column(Modifier.padding(start = Spacing.md).weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                if (body.isNotEmpty()) SelectionContainer {
                    Text(body, style = MaterialTheme.typography.bodyMedium, color = if (failed) colors.onErrorContainer else colors.onSurfaceVariant, maxLines = if (long && !full) 4 else Int.MAX_VALUE, overflow = TextOverflow.Ellipsis)
                }
                if (long) TextButton(onClick = { full = !full }, Modifier.offset(x = -Spacing.md), colors = ButtonDefaults.textButtonColors(contentColor = if (failed) colors.onErrorContainer else colors.primary)) {
                    Text(if (full) "Show less" else "Show full message")
                }
            }
        }
    }
}

@Composable private fun StepsGroup(group: Steps, live: Boolean, modifier: Modifier = Modifier) {
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

private const val OTHER = "\u0000other"
private val AnswersSaver = Saver<Answers, String>(save = { encodeAnswers(it) }, restore = ::decodeAnswers)

@Composable private fun ApprovalCard(approval: JSONObject, model: BridgeModel, modifier: Modifier = Modifier) {
    val id = approval.getString("id")
    val tool = approval.optString("tool")
    val input = approval.optJSONObject("input") ?: JSONObject()
    val questions = input.optJSONArray("questions")?.objects().orEmpty()
    val enabled = !model.busy && model.online
    val agent = model.agent(model.chat?.optString("agent"))?.name ?: "Claude"
    Surface(modifier.fillMaxWidth(), color = Pocket.colors.row, border = BorderStroke(1.5.dp, MaterialTheme.colorScheme.tertiary), shape = RoundedCornerShape(Corners.card)) {
        Column(Modifier.padding(Spacing.lg), verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
            when {
                questions.isNotEmpty() -> Questions(id, questions, enabled, model, agent)
                tool == "ExitPlanMode" -> {
                    CardTitle(PocketIcons.Help, "Review the plan")
                    Markdown(input.optString("plan").ifBlank { "$agent is ready to leave plan mode." })
                    Decision("Approve plan", "Keep planning", enabled, { model.decide(id, true, JSONObject()) }, { model.decide(id, false, JSONObject()) })
                }
                tool == "AskUserQuestion" -> {
                    var answer by rememberSaveable(id) { mutableStateOf("") }
                    CardTitle(PocketIcons.Help, "$agent has a question")
                    OutlinedTextField(answer, { answer = it }, Modifier.fillMaxWidth(), label = { Text("Your answer") }, shape = RoundedCornerShape(Corners.groupInner * 3))
                    Decision("Send answer", "Decline", enabled, { model.decide(id, true, JSONObject().put("answer", answer)) }, { model.decide(id, false, JSONObject()) }, ready = answer.isNotBlank())
                }
                else -> {
                    CardTitle(PocketIcons.Shield, "Allow $tool?")
                    input.optString("description").takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    // Wrapped, never clipped: the whole command must be visible before it is allowed.
                    val command = input.optString("command").takeIf { it.isNotBlank() }
                    CodeBlock(command ?: describeInput(tool, input.toString()), language = if (command != null) "sh" else "", wrap = true, label = if (command != null) "Command" else "Details")
                    Decision("Allow", "Deny", enabled, { model.decide(id, true, JSONObject()) }, { model.decide(id, false, JSONObject()) })
                }
            }
        }
    }
}

/** Amber mark and title: this card is waiting on you. */
@Composable private fun CardTitle(icon: ImageVector, text: String) {
    val colors = MaterialTheme.colorScheme
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(32.dp).background(colors.tertiaryContainer, CircleShape), contentAlignment = Alignment.Center) {
            Icon(icon, null, Modifier.size(Sizes.smallIcon), tint = colors.onTertiaryContainer)
        }
        Text(text, Modifier.padding(start = Spacing.md).semantics { heading() }, style = MaterialTheme.typography.titleMedium)
    }
}

/** Both buttons need the Mac and no other answer on its way; confirm also needs the answer to be [ready]. */
@Composable private fun Decision(confirm: String, decline: String, enabled: Boolean, onConfirm: () -> Unit, onDecline: () -> Unit, ready: Boolean = true) {
    Row(Modifier.fillMaxWidth().padding(top = Spacing.xs), horizontalArrangement = Arrangement.spacedBy(Spacing.sm, Alignment.End)) {
        OutlinedButton(onClick = onDecline, enabled = enabled) { Text(decline) }
        Button(onClick = onConfirm, enabled = enabled && ready) { Text(confirm) }
    }
}

@Composable private fun Questions(id: String, questions: List<JSONObject>, enabled: Boolean, model: BridgeModel, agent: String) {
    // Survives rotation and theme or font changes while the question is still pending.
    var answers by rememberSaveable(id, stateSaver = AnswersSaver) { mutableStateOf(Answers()) }
    fun answer(question: JSONObject): String {
        val key = question.optString("question")
        val chosen = answers.picks[key].orEmpty()
        val noOptions = question.optJSONArray("options")?.length() == 0 || !question.has("options")
        val parts = chosen.filter { it != OTHER } + listOfNotNull(answers.typed[key]?.trim()?.takeIf { it.isNotEmpty() && (OTHER in chosen || noOptions) })
        return parts.joinToString(", ")
    }
    CardTitle(PocketIcons.Help, if (questions.size == 1) "$agent has a question" else "$agent has ${questions.size} questions")
    questions.forEach { question ->
        val key = question.optString("question")
        val multi = question.optBoolean("multiSelect")
        val options = question.optJSONArray("options")?.objects().orEmpty()
        val chosen = answers.picks[key].orEmpty()
        fun pick(label: String) { answers = answers.copy(picks = answers.picks + (key to if (multi) (if (label in chosen) chosen - label else chosen + label) else setOf(label))) }
        Column(Modifier.padding(top = Spacing.xs), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            Text(key, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(bottom = Spacing.xs))
            if (multi) Text("Choose any", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = Spacing.xs))
            options.forEach { option -> val label = option.optString("label"); OptionRow(label, option.optString("description"), label in chosen, multi) { pick(label) } }
            if (options.isNotEmpty()) OptionRow("Something else", "", OTHER in chosen, multi) { pick(OTHER) }
            if (options.isEmpty() || OTHER in chosen) OutlinedTextField(
                answers.typed[key].orEmpty(), { answers = answers.copy(typed = answers.typed + (key to it)) }, Modifier.fillMaxWidth().padding(top = Spacing.xs),
                label = { Text("Your answer") }, keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences), shape = RoundedCornerShape(Corners.groupInner * 3),
            )
        }
    }
    val complete = questions.all { answer(it).isNotBlank() }
    Decision("Send answer", "Decline", enabled, {
        model.decide(id, true, JSONObject().apply { questions.forEach { put(it.optString("question"), answer(it)) } })
    }, { model.decide(id, false, JSONObject()) }, ready = complete)
}

@Composable private fun OptionRow(label: String, description: String, selected: Boolean, multi: Boolean, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val base = Modifier.fillMaxWidth().clip(RoundedCornerShape(Corners.groupInner * 4)).background(if (selected) colors.secondaryContainer else Color.Transparent)
    val row = if (multi) base.toggleable(selected, role = Role.Checkbox) { onClick() } else base.selectable(selected, role = Role.RadioButton, onClick = onClick)
    Row(row.heightIn(min = Sizes.touch + Spacing.xs).padding(vertical = Spacing.xxs), verticalAlignment = Alignment.CenterVertically) {
        if (multi) Checkbox(selected, null, Modifier.padding(horizontal = Spacing.md)) else RadioButton(selected, null, Modifier.padding(horizontal = Spacing.md))
        Column(Modifier.weight(1f).padding(end = Spacing.md)) {
            Text(label, style = MaterialTheme.typography.bodyLarge, color = if (selected) colors.onSecondaryContainer else colors.onSurface)
            if (description.isNotBlank()) Text(description, style = MaterialTheme.typography.bodySmall, color = if (selected) colors.onSecondaryContainer else colors.onSurfaceVariant)
        }
    }
}
