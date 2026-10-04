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

private const val OTHER = "\u0000other"
private val AnswersSaver = Saver<Answers, String>(save = { encodeAnswers(it) }, restore = ::decodeAnswers)

@Composable fun ApprovalCard(approval: JSONObject, model: BridgeModel, modifier: Modifier = Modifier) {
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
