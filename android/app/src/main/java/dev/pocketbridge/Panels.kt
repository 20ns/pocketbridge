package dev.pocketbridge

import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlin.coroutines.cancellation.CancellationException
import org.json.JSONArray

/**
 * A panel that rises from the bottom over a scrim, like the model panel: 28dp corners, a hairline border, its own
 * scroll and at most [maxFraction] of the screen. Back follows the gesture and shrinks it; the scrim closes it.
 * [modifier] places it, e.g. above the navigation bar and keyboard.
 */
@Composable fun BoxScope.RisingPanel(
    visible: Boolean, onDismiss: () -> Unit, closeLabel: String, modifier: Modifier = Modifier, maxFraction: Float = 0.5f,
    onBack: () -> Unit = onDismiss,
    content: @Composable () -> Unit,
) {
    var back by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(visible) { if (visible) back = 0f }
    // [onBack] may step inside the panel rather than close it, so the panel springs back to full size after it.
    PredictiveBackHandler(enabled = visible) { events ->
        try { events.collect { back = it.progress }; onBack() } catch (cancelled: CancellationException) { back = 0f; throw cancelled }
        back = 0f
    }
    AnimatedVisibility(visible, enter = fadeIn(Motion.effects()), exit = fadeOut(Motion.fastEffects())) {
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.32f)).clickable(remember { MutableInteractionSource() }, null, onClickLabel = closeLabel, onClick = onDismiss))
    }
    val maxHeight = (LocalConfiguration.current.screenHeightDp * maxFraction).dp
    AnimatedVisibility(
        visible, Modifier.align(Alignment.BottomCenter),
        enter = expandVertically(Motion.spatial(IntSize.VisibilityThreshold), expandFrom = Alignment.Bottom) + fadeIn(Motion.effects()),
        exit = shrinkVertically(Motion.fastSpatial(IntSize.VisibilityThreshold), shrinkTowards = Alignment.Bottom) + fadeOut(Motion.fastEffects()),
    ) {
        Surface(
            modifier.padding(horizontal = Spacing.sm, vertical = Spacing.xs).fillMaxWidth().heightIn(max = maxHeight)
                .graphicsLayer { val p = back; transformOrigin = TransformOrigin(0.5f, 1f); scaleX = 1f - 0.06f * p; scaleY = 1f - 0.06f * p; translationY = p * 16.dp.toPx() },
            shape = RoundedCornerShape(Corners.composer), color = Pocket.colors.panel, contentColor = MaterialTheme.colorScheme.onSurface,
            shadowElevation = 8.dp, border = BorderStroke(1.dp, Pocket.colors.composerBorder),
        ) { content() }
    }
}

/**
 * Where to start a chat, from the Projects bar's +: New project first (when the Mac has an experiments folder),
 * then every project, most recently used first, with a search field. A pick opens a new chat draft there.
 */
@Composable fun BoxScope.NewChatPanel(model: BridgeModel, visible: Boolean, onDismiss: () -> Unit, onPick: (String) -> Unit) {
    var naming by rememberSaveable { mutableStateOf(false) }
    // The typed name outlives a step back to the list, and goes when the panel closes.
    var name by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(visible) { if (!visible) { naming = false; name = ""; model.clearProjectError() } }
    val toList = { naming = false; model.clearProjectError() }
    // Back from the name field returns to the list first; from the list it closes the panel.
    RisingPanel(visible, onDismiss, "Close", Modifier.navigationBarsPadding().imePadding(), maxFraction = 0.6f, onBack = { if (naming) toList() else onDismiss() }) {
        AnimatedContent(naming, transitionSpec = { fadeIn(Motion.effects()) togetherWith fadeOut(Motion.fastEffects()) }, label = "new-chat") { showing ->
            if (showing) ProjectNameForm(model, name, { name = it }, toList)
            else ProjectPicker(model, onNewProject = { naming = true }, onPick = onPick)
        }
    }
}

@Composable private fun ProjectPicker(model: BridgeModel, onNewProject: () -> Unit, onPick: (String) -> Unit) {
    val general = generalProject(model.projects)
    var query by rememberSaveable { mutableStateOf("") }
    val projects = remember(model.projects, model.chats, query) { projectsByActivity(model.projects, model.chats, query) }
    val colors = MaterialTheme.colorScheme
    Column {
        Text("New chat", Modifier.padding(start = Spacing.xl, end = Spacing.xl, top = Spacing.lg, bottom = Spacing.xs).semantics { heading() }, style = MaterialTheme.typography.labelLarge, color = colors.primary)
        // Search only earns its room once there are enough projects to look for one.
        if (folderProjects(model.projects).size > 6) TextField(
            query, { query = it }, Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs).heightIn(min = 52.dp),
            placeholder = { Text("Search projects") }, singleLine = true, shape = CircleShape,
            leadingIcon = { Icon(Icons.Default.Search, null) },
            trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Default.Clear, "Clear search") } },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search, autoCorrectEnabled = false),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = Pocket.colors.pill, unfocusedContainerColor = Pocket.colors.pill,
                focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
            ),
        )
        LazyColumn(Modifier.fillMaxWidth(), contentPadding = PaddingValues(start = Spacing.sm, end = Spacing.sm, bottom = Spacing.sm)) {
            if (model.experiments.isNotEmpty() && query.isBlank()) item(key = "new-project") {
                PanelRow(onClick = onNewProject, enabled = model.online, label = "Create a project", leading = {
                    Box(Modifier.size(Sizes.headerAvatar).background(colors.primaryContainer, RoundedCornerShape(Corners.groupInner * 2)), contentAlignment = Alignment.Center) {
                        Icon(Icons.Default.Add, null, Modifier.size(Sizes.smallIcon), tint = colors.onPrimaryContainer)
                    }
                }, title = "New project", detail = "In " + model.experiments, titleColor = colors.primary)
            }
            // A chat that belongs to no project, e.g. for computer use. Older Macs have no General.
            if (general != null && query.isBlank()) item(key = "general") {
                PanelRow(onClick = { onPick(general.optString("id")) }, label = "Start a general chat", leading = {
                    Box(Modifier.size(Sizes.headerAvatar).background(colors.primaryContainer, RoundedCornerShape(Corners.groupInner * 2)), contentAlignment = Alignment.Center) {
                        Icon(PocketIcons.Chat, null, Modifier.size(Sizes.tinyIcon + Spacing.xxs), tint = colors.onPrimaryContainer)
                    }
                }, title = "General chat", detail = "Not in a project", titleColor = colors.primary)
            }
            if (query.isBlank() && (general != null || model.experiments.isNotEmpty()) && projects.isNotEmpty()) item(key = "divider") {
                HorizontalDivider(Modifier.padding(horizontal = Spacing.md, vertical = Spacing.xs), color = colors.outlineVariant)
            }
            items(projects, key = { it.optString("id") }) { project ->
                PanelRow(onClick = { onPick(project.optString("id")) }, label = "New chat here", leading = { ProjectAvatar(model, project, Sizes.headerAvatar) },
                    title = project.optString("name"), detail = compactPath(project.optString("path")))
            }
            if (projects.isEmpty()) item(key = "none") {
                Text(if (query.isBlank()) "No projects yet." else "No project matches “${query.trim()}”.", Modifier.padding(Spacing.md), style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
            }
        }
    }
}

@Composable private fun PanelRow(
    onClick: () -> Unit, label: String, leading: @Composable () -> Unit, title: String, detail: String,
    enabled: Boolean = true, titleColor: Color = MaterialTheme.colorScheme.onSurface,
) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Corners.groupOuter - Spacing.xs)).clickable(enabled, onClickLabel = label, onClick = onClick)
            .heightIn(min = 56.dp).padding(horizontal = Spacing.md, vertical = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Column(Modifier.weight(1f).padding(start = Spacing.md), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = titleColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** One field, keyboard up, Create. The Mac's folder shows under it; a refusal shows in its place. */
@Composable private fun ProjectNameForm(model: BridgeModel, name: String, onName: (String) -> Unit, onCancel: () -> Unit) {
    val focus = remember { FocusRequester() }
    val haptics = rememberHaptics()
    LaunchedEffect(Unit) { focus.requestFocus() }
    val error = model.projectError
    LaunchedEffect(error) { if (error.isNotEmpty()) haptics.perform(Haptic.Reject) }
    val ready = name.isNotBlank() && model.online && !model.creatingProject
    val create = { if (ready) { haptics.perform(Haptic.Confirm); model.createProject(name) } }
    Column(Modifier.padding(start = Spacing.lg, end = Spacing.lg, top = Spacing.lg, bottom = Spacing.md), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        Text("New project", Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            name, { onName(it); if (error.isNotEmpty()) model.clearProjectError() }, Modifier.fillMaxWidth().focusRequester(focus),
            label = { Text("Name") }, singleLine = true, isError = error.isNotEmpty(), enabled = !model.creatingProject,
            supportingText = { Text(error.ifEmpty { "In " + model.experiments }) },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, autoCorrectEnabled = false, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { create() }), shape = RoundedCornerShape(Corners.groupInner * 3),
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Spacing.sm, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onCancel, enabled = !model.creatingProject) { Text("Cancel") }
            Button(onClick = create, enabled = ready) {
                if (model.creatingProject) { CircularProgressIndicator(Modifier.size(Sizes.smallIcon), strokeWidth = 2.dp, color = LocalContentColor.current); Spacer(Modifier.width(Spacing.sm)) }
                Text("Create")
            }
        }
    }
}

/**
 * Scroll positions of the Projects list and each project's chats, kept while moving between screens and across
 * process death, so Back lands where the list was left.
 */
@Stable class ListPositions(private val saved: Map<String, Pair<Int, Int>> = emptyMap()) {
    private val states = mutableMapOf<String, LazyListState>()
    fun of(key: String): LazyListState = states.getOrPut(key) { saved[key]?.let { (index, offset) -> LazyListState(index, offset) } ?: LazyListState() }
    fun snapshot(): Map<String, Pair<Int, Int>> = saved + states.mapValues { it.value.firstVisibleItemIndex to it.value.firstVisibleItemScrollOffset }
    companion object {
        /** At most this many lists are remembered; the rest start at the top. */
        const val LIMIT = 24
        fun encode(positions: Map<String, Pair<Int, Int>>): String =
            JSONArray(positions.entries.filter { it.value.first > 0 || it.value.second > 0 }.take(LIMIT).map { JSONArray().put(it.key).put(it.value.first).put(it.value.second) }).toString()
        fun decode(value: String): Map<String, Pair<Int, Int>> = runCatching {
            val list = JSONArray(value)
            (0 until list.length()).associate { list.getJSONArray(it).let { entry -> entry.getString(0) to (entry.getInt(1).coerceAtLeast(0) to entry.getInt(2).coerceAtLeast(0)) } }
        }.getOrDefault(emptyMap())
        val Saver = Saver<ListPositions, String>(save = { encode(it.snapshot()) }, restore = { ListPositions(decode(it)) })
    }
}

/** Whether a new chat can start in [project], or the one line saying why not. */
fun newChatBlocked(model: BridgeModel, project: String): String? = when {
    model.agents.isNotEmpty() && model.agents.none { it.usable } -> if (model.agents.any { it.available }) "Claude and Codex are both off. Turn one on in Settings." else "No coding agent is available on your Mac."
    model.agents.isEmpty() && !model.claudeAvailable -> "No coding agent is available on your Mac."
    model.projects.none { it.optString("id") == project } -> "This project was removed on your Mac."
    else -> null
}
