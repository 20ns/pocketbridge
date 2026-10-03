package dev.pocketbridge

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
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
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
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
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject

// Own messages sit right in the accent colour; Claude's sit left on a neutral bubble. Tails point at the sender's edge.
private val Mine = RoundedCornerShape(20.dp, 20.dp, 6.dp, 20.dp)
private val Theirs = RoundedCornerShape(20.dp, 20.dp, 20.dp, 6.dp)

@Composable fun Conversation(model: BridgeModel) {
    val entries = remember(model.messages) { transcript(model.messages.map { Said(it.optString("id"), it.optString("role"), it.optString("text")) }) }
    val approvals = model.approvals.filter { it.optString("status") == "pending" }
    val chat = model.chat
    val status = chat?.optString("status").orEmpty()
    val pending = model.pending
    // The Mac stores a prompt under its delivery ID, so an accepted-but-unconfirmed prompt is already in the transcript.
    val pendingShown = pending != null && model.messages.any { it.optString("id") == pending.id }
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val scrolledUp by remember { derivedStateOf { list.firstVisibleItemIndex > 1 } }
    Box(Modifier.fillMaxSize()) {
        // Reverse layout anchors the newest content above the composer while replies stream in.
        LazyColumn(Modifier.fillMaxSize(), list, PaddingValues(horizontal = 12.dp, vertical = 12.dp), reverseLayout = true, verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.Bottom)) {
            item(key = "footer") { Footer(status, chat?.optString("error").orEmpty(), approvals.isNotEmpty()) }
            if (pending != null) item(key = "pending") { Unconfirmed(if (pendingShown) null else pending.text, model) }
            items(approvals.asReversed(), key = { "approval:" + it.getString("id") }) { ApprovalCard(it, model) }
            items(entries.asReversed(), key = { it.key }) { entry ->
                when (entry) {
                    is Steps -> StepsGroup(entry, live = entry === entries.lastOrNull() && status == "running")
                    is Message -> when {
                        entry.said.role == "user" -> UserBubble(entry.said.text)
                        entry.said.text.isNotBlank() -> AssistantBubble(entry.said.text)
                    }
                }
            }
            if (entries.isEmpty() && pending == null) item(key = "empty") { EmptyConversation(model) }
        }
        AnimatedVisibility(scrolledUp, Modifier.align(Alignment.BottomEnd).padding(16.dp), enter = fadeIn(), exit = fadeOut()) {
            SmallFloatingActionButton(onClick = { scope.launch { list.animateScrollToItem(0) } }, containerColor = MaterialTheme.colorScheme.surfaceContainerHighest) {
                Icon(Icons.Default.KeyboardArrowDown, "Jump to latest")
            }
        }
    }
}

@Composable private fun EmptyConversation(model: BridgeModel) {
    val project = model.projects.find { it.optString("id") == model.chat?.optString("projectId") }
    // Offline with nothing saved, this chat may well have history; don't invite a first prompt over it.
    val (title, body) = if (model.online) "What should Claude work on?" to (project?.optString("path")?.let { "Runs in ${shortPath(it)} on your Mac." } ?: "Runs in this project on your Mac.")
        else "Waiting for your Mac" to "This chat's messages appear once your Mac connects."
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 24.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.titleLarge)
        Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable private fun UserBubble(text: String, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Spacer(Modifier.width(48.dp))
        Surface(color = colors.primary, contentColor = colors.onPrimary, shape = Mine) {
            // Default selection colours are the accent, which would vanish on an accent bubble.
            CompositionLocalProvider(LocalTextSelectionColors provides TextSelectionColors(colors.onPrimary, colors.onPrimary.copy(alpha = 0.35f))) {
                SelectionContainer { Text(text, Modifier.padding(horizontal = 16.dp, vertical = 10.dp), style = MaterialTheme.typography.bodyLarge) }
            }
        }
    }
}

@Composable private fun AssistantBubble(text: String) {
    val colors = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth()) {
        Surface(Modifier.weight(1f, fill = false), color = colors.surfaceContainerHigh, shape = Theirs) {
            Markdown(text, Modifier.padding(horizontal = 16.dp, vertical = 12.dp), code = colors.surfaceContainerLowest)
        }
        Spacer(Modifier.width(24.dp))
    }
}

/** A prompt whose delivery the Mac hasn't confirmed. Retry reuses its ID, so it can never run twice. */
@Composable private fun Unconfirmed(text: String?, model: BridgeModel) {
    val sending = model.busy
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        text?.let { UserBubble(it, Modifier.alpha(if (sending) 0.7f else 1f)) }
        Row(Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }, verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (sending) "Sending…" else "Not confirmed by your Mac",
                Modifier.padding(horizontal = 4.dp), style = MaterialTheme.typography.labelMedium,
                color = if (sending) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
            )
            if (!sending) TextButton(onClick = model::send, Modifier.heightIn(min = 48.dp)) { Text("Retry") }
        }
    }
}

@Composable private fun Footer(status: String, error: String, answering: Boolean) {
    Box(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }) {
        when (status) {
            "running" -> Typing("Claude is working")
            "waiting" -> if (!answering) Typing("Waiting for your answer")
            "stopping" -> Note("Stopping…", "")
            "interrupted" -> Note("Interrupted", error.ifEmpty { "This task stopped before it finished." } + " Send a message to continue.")
            "error" -> Note("Failed", error.ifEmpty { "Claude stopped with an error." }, MaterialTheme.colorScheme.error)
        }
    }
}

/** Three pulsing dots in Claude's bubble, the messaging cue that a reply is still coming. */
@Composable private fun Typing(description: String) {
    val pulse = rememberInfiniteTransition(label = "typing")
    val phase by pulse.animateFloat(0f, 3f, infiniteRepeatable(tween(1200)), label = "phase")
    val dot = MaterialTheme.colorScheme.onSurfaceVariant
    Surface(Modifier.semantics { contentDescription = description }, color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = Theirs) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 14.dp), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            repeat(3) { i ->
                val lift = (1f - kotlin.math.abs(phase - i - 0.5f).coerceAtMost(1f))
                Box(Modifier.size(7.dp).alpha(0.35f + 0.65f * lift).background(dot, CircleShape))
            }
        }
    }
}

/** A centred line in the conversation, like a messaging app's system note. Long crash output folds. */
@Composable private fun Note(title: String, body: String, tint: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    var full by rememberSaveable(body) { mutableStateOf(false) }
    val long = body.length > 280 || body.count { it == '\n' } > 4
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 4.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = tint)
        if (body.isNotEmpty()) SelectionContainer {
            Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, maxLines = if (long && !full) 4 else Int.MAX_VALUE, overflow = TextOverflow.Ellipsis)
        }
        if (long) TextButton(onClick = { full = !full }, Modifier.heightIn(min = 48.dp)) { Text(if (full) "Show less" else "Show full message") }
    }
}

@Composable private fun StepsGroup(group: Steps, live: Boolean) {
    var open by rememberSaveable(group.key) { mutableStateOf(false) }
    val failed = group.steps.count { it.failed }
    val rotation by animateFloatAsState(if (open) 180f else 0f, label = "chevron")
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable(onClickLabel = if (open) "Hide steps" else "Show steps") { open = !open }.heightIn(min = 48.dp).padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
                if (live) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp) else Icon(PocketIcons.Terminal, null, Modifier.size(18.dp), tint = muted)
            }
            Column(Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(stepsTitle(group.steps), style = MaterialTheme.typography.labelLarge, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (!open) group.steps.last().summary.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            if (failed > 0) Text("$failed failed", Modifier.padding(end = 8.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
            Icon(Icons.Default.KeyboardArrowDown, null, Modifier.rotate(rotation), tint = muted)
        }
        AnimatedVisibility(open, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
            Column(Modifier.padding(start = 32.dp)) { group.steps.forEach { StepRow(it) } }
        }
    }
}

@Composable private fun StepRow(step: Step) {
    var open by rememberSaveable(step.id) { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(onClickLabel = if (open) "Hide details" else "Show details") { open = !open }.heightIn(min = 48.dp).padding(horizontal = 8.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                buildAnnotatedString { withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = colors.onSurface)) { append(step.tool) }; if (step.summary.isNotEmpty()) append("  " + step.summary) },
                Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant, maxLines = if (open) 4 else 1, overflow = TextOverflow.Ellipsis,
            )
            if (step.failed) Text("Failed", Modifier.padding(start = 8.dp), style = MaterialTheme.typography.labelMedium, color = colors.error)
        }
        if (open) Column(Modifier.padding(start = 8.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (step.isNote) Detail(step.input)
            else if (step.input.isNotBlank()) Detail(remember(step.input) { describeInput(step.tool, step.input) })
            step.result?.takeIf { it.isNotBlank() }?.let { Detail(it, if (step.failed) colors.errorContainer else colors.surfaceContainerHigh) }
        }
    }
}

@Composable private fun Detail(text: String, color: Color = MaterialTheme.colorScheme.surfaceContainerHigh) {
    val shown = remember(text) { if (text.length > 6000) text.take(6000) + "\n…" else text }
    Surface(Modifier.fillMaxWidth(), color = color, shape = RoundedCornerShape(10.dp)) {
        SelectionContainer(Modifier.heightIn(max = 280.dp).verticalScroll(rememberScrollState())) {
            Text(shown, Modifier.padding(12.dp), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
        }
    }
}

private const val OTHER = "\u0000other"
private val AnswersSaver = Saver<Answers, String>(save = { encodeAnswers(it) }, restore = ::decodeAnswers)

@Composable private fun ApprovalCard(approval: JSONObject, model: BridgeModel) {
    val id = approval.getString("id")
    val tool = approval.optString("tool")
    val input = approval.optJSONObject("input") ?: JSONObject()
    val questions = input.optJSONArray("questions")?.objects().orEmpty()
    val enabled = !model.busy && model.online
    Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceContainerLow, border = BorderStroke(1.dp, MaterialTheme.colorScheme.tertiary), shape = RoundedCornerShape(18.dp)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            when {
                questions.isNotEmpty() -> Questions(id, questions, enabled, model)
                tool == "ExitPlanMode" -> {
                    CardTitle("Review Claude's plan")
                    Markdown(input.optString("plan").ifBlank { "Claude is ready to leave plan mode." })
                    Decision("Approve plan", "Keep planning", enabled, { model.decide(id, true, JSONObject()) }, { model.decide(id, false, JSONObject()) })
                }
                tool == "AskUserQuestion" -> {
                    var answer by rememberSaveable(id) { mutableStateOf("") }
                    CardTitle("Claude has a question")
                    OutlinedTextField(answer, { answer = it }, Modifier.fillMaxWidth(), label = { Text("Your answer") })
                    Decision("Send answer", "Decline", enabled && answer.isNotBlank(), { model.decide(id, true, JSONObject().put("answer", answer)) }, { model.decide(id, false, JSONObject()) })
                }
                else -> {
                    CardTitle("Allow $tool?")
                    input.optString("description").takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    // Wrapped, never clipped: the whole command must be visible before it is allowed.
                    val command = input.optString("command").takeIf { it.isNotBlank() }
                    CodeBlock(command ?: describeInput(tool, input.toString()), language = if (command != null) "Command" else "Details", wrap = true)
                    Decision("Allow", "Deny", enabled, { model.decide(id, true, JSONObject()) }, { model.decide(id, false, JSONObject()) })
                }
            }
        }
    }
}

@Composable private fun CardTitle(text: String) { Text(text, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface) }

@Composable private fun Decision(confirm: String, decline: String, enabled: Boolean, onConfirm: () -> Unit, onDecline: () -> Unit, declineEnabled: Boolean = true) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
        TextButton(onClick = onDecline, enabled = declineEnabled, modifier = Modifier.heightIn(min = 48.dp)) { Text(decline) }
        Button(onClick = onConfirm, enabled = enabled, modifier = Modifier.heightIn(min = 48.dp)) { Text(confirm) }
    }
}

@Composable private fun Questions(id: String, questions: List<JSONObject>, enabled: Boolean, model: BridgeModel) {
    // Survives rotation and theme or font changes while the question is still pending.
    var answers by rememberSaveable(id, stateSaver = AnswersSaver) { mutableStateOf(Answers()) }
    fun answer(question: JSONObject): String {
        val key = question.optString("question")
        val chosen = answers.picks[key].orEmpty()
        val noOptions = question.optJSONArray("options")?.length() == 0 || !question.has("options")
        val parts = chosen.filter { it != OTHER } + listOfNotNull(answers.typed[key]?.trim()?.takeIf { it.isNotEmpty() && (OTHER in chosen || noOptions) })
        return parts.joinToString(", ")
    }
    CardTitle(if (questions.size == 1) "Claude has a question" else "Claude has ${questions.size} questions")
    questions.forEach { question ->
        val key = question.optString("question")
        val multi = question.optBoolean("multiSelect")
        val options = question.optJSONArray("options")?.objects().orEmpty()
        val chosen = answers.picks[key].orEmpty()
        fun pick(label: String) { answers = answers.copy(picks = answers.picks + (key to if (multi) (if (label in chosen) chosen - label else chosen + label) else setOf(label))) }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(key, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(bottom = 4.dp))
            if (multi) Text("Choose any that apply", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            options.forEach { option -> val label = option.optString("label"); OptionRow(label, option.optString("description"), label in chosen, multi) { pick(label) } }
            if (options.isNotEmpty()) OptionRow("Something else", "", OTHER in chosen, multi) { pick(OTHER) }
            if (options.isEmpty() || OTHER in chosen) OutlinedTextField(
                answers.typed[key].orEmpty(), { answers = answers.copy(typed = answers.typed + (key to it)) }, Modifier.fillMaxWidth().padding(top = 4.dp),
                label = { Text("Your answer") }, keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            )
        }
    }
    val complete = questions.all { answer(it).isNotBlank() }
    Decision("Send answer", "Decline", enabled && complete, {
        model.decide(id, true, JSONObject().apply { questions.forEach { put(it.optString("question"), answer(it)) } })
    }, { model.decide(id, false, JSONObject()) }, declineEnabled = enabled)
}

@Composable private fun OptionRow(label: String, description: String, selected: Boolean, multi: Boolean, onClick: () -> Unit) {
    val base = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
    val row = if (multi) base.toggleable(selected, role = Role.Checkbox) { onClick() } else base.selectable(selected, role = Role.RadioButton, onClick = onClick)
    Row(row.heightIn(min = 48.dp).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        if (multi) Checkbox(selected, null, Modifier.padding(12.dp)) else RadioButton(selected, null, Modifier.padding(12.dp))
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            if (description.isNotBlank()) Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}


@Composable fun Composer(model: BridgeModel) {
    val status = model.chat?.optString("status")
    val working = isWorking(status)
    val pending = model.pending
    val colors = MaterialTheme.colorScheme
    val connection = when { model.online -> ""; model.connectionIssue.isEmpty() -> "Connecting…"; else -> "Offline" }
    Surface(color = colors.surfaceContainer) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(start = 8.dp, end = 12.dp, top = 4.dp, bottom = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ModeMenu(model.mode, model.modes, enabled = !working && pending == null && !model.busy) { model.mode = it }
                Spacer(Modifier.weight(1f))
                if (connection.isNotEmpty()) Text(connection, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
            }
            Row(Modifier.padding(start = 4.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val field = colors.surfaceContainerHighest
                // While a prompt awaits confirmation it shows in the conversation, so the field stays empty and locked.
                TextField(
                    if (pending == null) model.draft else "", { if (pending == null) model.editDraft(it) }, Modifier.weight(1f).heightIn(min = 52.dp),
                    enabled = pending == null && !model.busy,
                    placeholder = { Text(when { pending != null -> "Waiting for your Mac to confirm"; status == "waiting" -> "Answer above to continue"; working -> "Draft your next message"; else -> "Message Claude" }, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    maxLines = 6, shape = RoundedCornerShape(26.dp),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = field, unfocusedContainerColor = field, disabledContainerColor = field,
                        focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent,
                    ),
                )
                val size = Modifier.size(52.dp)
                if (working) FilledTonalIconButton(
                    onClick = model::stop, enabled = !model.busy && model.online && status != "stopping", modifier = size,
                    colors = IconButtonDefaults.filledTonalIconButtonColors(containerColor = colors.errorContainer, contentColor = colors.onErrorContainer),
                ) { Icon(PocketIcons.Stop, "Stop Claude") }
                else FilledIconButton(onClick = model::send, enabled = pending == null && !model.busy && model.online && model.draft.isNotBlank() && model.selected.isNotEmpty(), modifier = size) {
                    Icon(Icons.AutoMirrored.Filled.Send, "Send")
                }
            }
        }
    }
}

@Composable private fun ModeMenu(value: String, modes: List<String>, enabled: Boolean, onChange: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        TextButton(
            onClick = { expanded = true }, enabled = enabled,
            modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Permission mode: ${modeLabel(value)}" },
            contentPadding = PaddingValues(start = 12.dp, end = 4.dp),
            colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant),
        ) {
            Text(modeLabel(value), style = MaterialTheme.typography.labelLarge)
            Icon(Icons.Default.ArrowDropDown, null)
        }
        DropdownMenu(expanded, { expanded = false }) {
            modes.forEach { mode ->
                DropdownMenuItem(
                    text = { Column(Modifier.padding(vertical = 6.dp)) { Text(modeLabel(mode), style = MaterialTheme.typography.bodyLarge); Text(modeHelp(mode), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } },
                    leadingIcon = { Box(Modifier.size(24.dp)) { if (mode == value) Icon(Icons.Default.Check, null) } },
                    onClick = { onChange(mode); expanded = false },
                )
            }
        }
    }
}
