package dev.pocketbridge

import android.Manifest
import android.content.Intent
import android.os.Build
import android.text.format.DateUtils
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import org.json.JSONObject

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun Chats(model: BridgeModel, project: String, sort: ChatSort, list: LazyListState, insets: PageInsets) {
    // A chat inside its Undo window, or deleted but not yet confirmed by the Mac, is already gone from the list.
    val hidden = model.deletions.keys
    val chats = projectChats(model.chats, project, model.visibleDrafts()).filter { it.optString("id") !in hidden }.sortedWith(when (sort) {
        ChatSort.Newest -> compareByDescending { it.optLong("updatedAt") }
        ChatSort.Oldest -> compareBy { it.optLong("updatedAt") }
    })
    val now = rememberNow()
    // Sessions started in Terminal or the desktop apps, offered for continuing here. Asked for once per visit.
    // General belongs to no folder, so it has no Mac sessions and no git line.
    val general = isGeneral(model.projects.find { it.optString("id") == project })
    LaunchedEffect(project, model.online) { if (model.online && !general) model.details.refreshSessions(project) }
    val sessions = if (general) emptyList() else model.details.sessions[project].orEmpty()
    var macOpen by rememberSaveable { mutableStateOf(true) }
    var macAll by rememberSaveable(project) { mutableStateOf(false) }
    var continuing by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(model.busy) { if (!model.busy) continuing = null }
    val refresh = { model.retry(); if (!general) { model.details.refreshSessions(project); model.details.refreshGit(project, force = true) } }
    RefreshBox(model.refreshing, refresh, Modifier.fillMaxSize()) {
        // Bottom room keeps the last row clear of the New chat button.
        LazyColumn(Modifier.fillMaxSize().then(insets.scroll), list, PaddingValues(bottom = insets.bottom + 96.dp)) {
            item(key = "top-gap") { Spacer(Modifier.height(Spacing.xs)) }
            if (model.agents.isNotEmpty() && model.agents.none { it.available }) item { Notice("No coding agent found on your Mac. Install Claude Code or Codex and sign in there, then restart PocketBridge.", Modifier.padding(Spacing.lg)) }
            if (sessions.isNotEmpty()) {
                item(key = "mac-label") { SectionToggle("On your Mac", sessions.size, macOpen) { macOpen = !macOpen } }
                if (macOpen) {
                    val shown = if (macAll || sessions.size <= 3) sessions else sessions.take(3)
                    val more = sessions.size > shown.size
                    itemsIndexed(shown, key = { _, session -> "mac:" + session.agent + session.id }) { index, session ->
                        SessionRow(session, model.agent(session.agent)?.name ?: session.agent.replaceFirstChar(Char::uppercase), now, index, shown.size, continuing == session.id, enabled = model.online && !model.busy) {
                            continuing = session.id; model.continueSession(project, session)
                        }
                    }
                    if (more) item(key = "mac-more") {
                        TextButton(onClick = { macAll = true }, Modifier.padding(start = Spacing.xl, top = Spacing.xxs)) { Text("Show all ${sessions.size}") }
                    }
                }
                if (chats.isNotEmpty()) item(key = "chats-label") { GroupLabel("Chats") }
            }
            // Nothing says "No chats yet" while the Mac's own sessions for this folder are still on their way.
            val sessionsPending = !general && project in model.details.sessionsLoading && model.details.sessions[project] == null
            if (chats.isEmpty() && sessions.isEmpty() && !sessionsPending) item(key = "empty") { EmptyState(PocketIcons.Terminal, "No chats yet", "") }
            itemsIndexed(chats, key = { _, chat -> chat.getString("id") }) { index, chat -> ChatRow(model, chat, now, index, chats.size) }
        }
    }
}

/** A section title that folds its group: label, count, and a chevron that turns. */
@Composable private fun SectionToggle(label: String, count: Int, open: Boolean, onToggle: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val turn by animateFloatAsState(if (open) 180f else 0f, Motion.fastSpatial(), label = "section")
    Row(
        Modifier.fillMaxWidth().padding(top = Spacing.xs).clickable(onClickLabel = if (open) "Hide" else "Show", onClick = onToggle)
            .heightIn(min = Sizes.touch).padding(start = Spacing.xxxl, end = Spacing.xl).semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = colors.primary)
        Text("  $count", Modifier.weight(1f), style = MaterialTheme.typography.labelLarge.copy(fontFeatureSettings = "tnum"), color = colors.onSurfaceVariant)
        Icon(Icons.Default.KeyboardArrowDown, null, Modifier.rotate(turn), tint = colors.onSurfaceVariant)
    }
}

/** A session from the Mac: agent mark, title, its last words and when. Tapping forks it into a chat here. */
@Composable private fun SessionRow(session: MacSession, agentName: String, now: Long, index: Int, count: Int, continuing: Boolean, enabled: Boolean, onContinue: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    GroupRow(
        index, count, onClick = onContinue.takeIf { enabled }, onClickLabel = "Continue on this phone",
        leading = {
            val agent = agentColors(session.agent)
            Tile(agent.container) { Icon(if (session.agent == CODEX) PocketIcons.Terminal else PocketIcons.Spark, null, Modifier.size(20.dp), tint = agent.accent) }
        },
        supporting = { if (session.preview.isNotBlank()) Text(session.preview, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        trailing = {
            if (continuing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            else Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                if (session.updatedAt > 0) Text(relativeTime(session.updatedAt, now), style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                Text(agentName, style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant, maxLines = 1)
            }
        },
    ) { Text(session.title, maxLines = 1, overflow = TextOverflow.Ellipsis) }
}

@Composable private fun ChatRow(model: BridgeModel, chat: JSONObject, now: Long, index: Int, count: Int) {
    val status = chat.optString("status")
    val colors = MaterialTheme.colorScheme
    var menu by remember { mutableStateOf(false) }
    var rename by remember { mutableStateOf(false) }
    val haptics = rememberHaptics()
    val id = chat.getString("id")
    val local = chat.optBoolean("local")
    val unconfirmed = local && status == "unconfirmed"
    val working = isWorking(status)
    val title = chat.optString("title").ifBlank { "New chat" }
    val agent = model.agent(chat.optString("agent"))
    val hint = agentColors(chat.optString("agent"))
    val preview = chat.optString("preview")
    Box {
        GroupRow(
            index, count, onClick = { model.open(id) }, onClickLabel = "Open chat", container = hint.tint, accent = hint.accent,
            // Long press opens chat actions; an unconfirmed prompt has none until the Mac answers.
            onLongClick = if (unconfirmed) null else ({ haptics.perform(Haptic.LongPress); menu = true }), onLongClickLabel = "Chat actions",
            // Quiet chats show their last words; anything that needs a look shows its state instead.
            supporting = {
                val scheduled = chatScheduled(chat)
                when {
                    status !in listOf("idle", "") -> StatusLine(status)
                    scheduled != null -> ScheduledLine(scheduled.second, now)
                    preview.isNotBlank() -> Text(preview, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            },
            trailing = {
                Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    if (!local || chat.optLong("updatedAt") > 0) Text(relativeTime(chat.optLong("updatedAt"), now), style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                    if (!local) Text(modelName(agent, chat.optString("model", "default")), style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant, maxLines = 1)
                }
            },
        ) { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        val desktop = if (local || chat.optString("agent").ifBlank { "claude" } != "claude") null else ({ model.openInDesktop(id) })
        Box(Modifier.align(Alignment.TopEnd).padding(end = Spacing.xxxl)) { ChatMenu(menu, { menu = false }, if (local) null else ({ rename = true }), { model.deleteWithUndo(id, title) }, working, desktop) }
    }
    if (rename) RenameDialog(title, { rename = false }, { model.rename(id, it); rename = false })
}

@Composable fun ChatMenu(expanded: Boolean, onDismiss: () -> Unit, onRename: (() -> Unit)?, onDelete: () -> Unit, working: Boolean, onDesktop: (() -> Unit)? = null) {
    DropdownMenu(expanded, onDismiss, shape = RoundedCornerShape(Corners.groupOuter), containerColor = Pocket.colors.panel, shadowElevation = 8.dp) {
        // Both apps writing one session at once would interleave turns, so the hand-off waits for the turn to end.
        if (onDesktop != null) DropdownMenuItem(text = { Text(if (working) "Open in Claude Desktop when done" else "Open in Claude Desktop") }, enabled = !working, onClick = { onDismiss(); onDesktop() })
        if (onRename != null) DropdownMenuItem(text = { Text("Rename") }, onClick = { onDismiss(); onRename() })
        DropdownMenuItem(
            text = { Text(if (working) "Stop before deleting" else "Delete", color = if (working) Color.Unspecified else MaterialTheme.colorScheme.error) },
            enabled = !working,
            onClick = { onDismiss(); onDelete() },
        )
    }
}

@Composable fun RenameDialog(current: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    // Opens with the keyboard up and the old name selected, so typing replaces it; Done saves.
    var title by rememberSaveable(current, stateSaver = TextFieldValue.Saver) { mutableStateOf(TextFieldValue(current, TextRange(0, current.length))) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    val save = { if (title.text.isNotBlank()) onSave(title.text) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename chat") },
        text = {
            OutlinedTextField(
                title, { title = it }, Modifier.fillMaxWidth().focusRequester(focus), singleLine = true, label = { Text("Name") }, shape = RoundedCornerShape(Corners.groupInner * 3),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { save() }),
            )
        },
        confirmButton = { TextButton(onClick = save, enabled = title.text.isNotBlank()) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
