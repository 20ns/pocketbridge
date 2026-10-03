package dev.pocketbridge

import android.text.format.DateUtils
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.json.JSONObject

@Composable fun Pairing(model: BridgeModel) {
    val focus = LocalFocusManager.current
    val ready = !model.busy && model.pairUrl.isNotBlank() && model.pairCode.isNotBlank()
    val connect = { if (ready) { focus.clearFocus(); model.pair() } }
    Column(
        Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Pair with your Mac", Modifier.padding(top = 24.dp).semantics { heading() }, style = MaterialTheme.typography.headlineMedium)
        Text(
            "On your Mac, open PocketBridge and choose Connect phone. Scan the QR code with your camera, or enter the address and code here.",
            style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(4.dp))
        OutlinedTextField(
            model.pairUrl, { model.pairUrl = it }, Modifier.fillMaxWidth(),
            label = { Text("Mac address") }, placeholder = { Text("https://your-mac.your-tailnet.ts.net") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false, imeAction = ImeAction.Next),
        )
        OutlinedTextField(
            model.pairCode, { model.pairCode = it.uppercase().filter { c -> !c.isWhitespace() } }, Modifier.fillMaxWidth(),
            label = { Text("Pairing code") }, supportingText = { Text("One-time code, valid for 10 minutes") }, singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, keyboardType = KeyboardType.Ascii, autoCorrectEnabled = false, imeAction = ImeAction.Go),
            keyboardActions = KeyboardActions(onGo = { connect() }),
        )
        if (model.error.isNotEmpty()) Notice(model.error, isError = true)
        Button(onClick = connect, enabled = ready, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
            if (model.busy) { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = LocalContentColor.current); Spacer(Modifier.width(12.dp)); Text("Connecting…") }
            else Text("Connect to Mac")
        }
        Text(
            "Keep Tailscale on for both devices. Pairing stays saved on this phone, and your Claude login never leaves your Mac.",
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable fun Notice(text: String, modifier: Modifier = Modifier, isError: Boolean = false) {
    val colors = MaterialTheme.colorScheme
    Surface(modifier.fillMaxWidth(), color = if (isError) colors.errorContainer else colors.tertiaryContainer, contentColor = if (isError) colors.onErrorContainer else colors.onTertiaryContainer, shape = RoundedCornerShape(12.dp)) {
        Row(Modifier.padding(14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(if (isError) Icons.Default.Warning else Icons.Default.Info, null, Modifier.size(20.dp))
            Text(text, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable fun Settings(model: BridgeModel) {
    var confirm by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
        ListItem(
            headlineContent = { SelectionContainer { Text(model.pairUrl) } },
            overlineContent = { Text("Paired Mac") },
            supportingContent = { Text(if (model.online) "Connected" else if (model.connectionIssue.isEmpty()) "Connecting…" else "Offline · " + model.connectionIssue) },
        )
        ListItem(
            headlineContent = { Text(if (model.claudeAvailable) "Available on your Mac" else "Not found on your Mac") },
            overlineContent = { Text("Claude Code") },
            supportingContent = { Text(if (model.claudeAvailable) "Sign-in stays inside the official Claude Code app on the Mac." else "Install Claude Code and sign in on the Mac, then restart PocketBridge.") },
        )
        Text(
            "Work continues on the Mac when you close this app or lose signal. Keep the Mac awake, plugged in and on Tailscale.",
            Modifier.padding(horizontal = 16.dp, vertical = 12.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        HorizontalDivider(Modifier.padding(vertical = 4.dp))
        UpdateSettings(model)
        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            FilledTonalButton(onClick = model::retry, enabled = !model.refreshing, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (model.refreshing) "Reconnecting…" else "Reconnect") }
            OutlinedButton(onClick = { confirm = true }, enabled = !model.busy, modifier = Modifier.heightIn(min = 48.dp), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Disconnect") }
        }
    }
    if (confirm) AlertDialog(
        onDismissRequest = { confirm = false },
        title = { Text("Disconnect from your Mac?") },
        text = { Text("You'll need a new pairing code to reconnect. Drafts on this phone are removed. Tasks already running on the Mac keep going.") },
        confirmButton = { TextButton(onClick = { model.disconnect(); confirm = false }) { Text("Disconnect", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
    )
}

@Composable private fun UpdateSettings(model: BridgeModel) {
    val update = model.updateStatus
    ListItem(
        headlineContent = { Text("PocketBridge ${update.installed}") },
        overlineContent = { Text("App updates") },
        supportingContent = { Text(if (update.latest.isBlank()) update.message else "Latest ${update.latest} · ${update.message}") },
    )
    Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        FilledTonalButton(onClick = model::checkUpdate, enabled = !model.updateBusy, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (model.updateBusy) "Checking…" else "Check latest") }
        if (update.release != null && update.apkPath.isBlank()) Button(onClick = model::downloadUpdate, enabled = !model.updateBusy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Download") }
        if (update.apkPath.isNotBlank()) Button(onClick = model::installUpdate, enabled = !model.updateBusy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Install") }
    }
}

/** Minute-resolution clock so relative times stay true while the list is open. */
@Composable private fun rememberNow(): Long {
    val now by produceState(System.currentTimeMillis()) { while (true) { delay(30_000); value = System.currentTimeMillis() } }
    return now
}

fun relativeTime(time: Long, now: Long): String =
    if (now - time < DateUtils.MINUTE_IN_MILLIS) "Just now"
    else DateUtils.getRelativeTimeSpanString(time, now, DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE or DateUtils.FORMAT_ABBREV_MONTH).toString()

private enum class ProjectFilter { Latest, All }
private enum class ProjectSort { Newest, Oldest, Name }
private enum class ChatSort { Newest, Oldest }

val LatestProjectWindowMillis = 7L * DateUtils.DAY_IN_MILLIS

fun projectActivity(lastUsedAt: Long, newestChatUpdatedAt: Long) = maxOf(lastUsedAt.coerceAtLeast(0), newestChatUpdatedAt.coerceAtLeast(0))
fun isLatestProject(activityAt: Long, now: Long) = activityAt > 0 && activityAt >= now - LatestProjectWindowMillis
fun compareProjectActivity(leftAt: Long, leftName: String, rightAt: Long, rightName: String, newest: Boolean): Int {
    val activity = if (newest) rightAt.compareTo(leftAt) else leftAt.compareTo(rightAt)
    return activity.takeIf { it != 0 } ?: leftName.compareTo(rightName, ignoreCase = true)
}
private fun projectActivity(project: JSONObject, chats: List<JSONObject>) = projectActivity(project.optLong("lastUsedAt"), chats.maxOfOrNull { it.optLong("updatedAt") } ?: 0L)

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun Projects(model: BridgeModel, onOpen: (String) -> Unit) {
    val now = rememberNow()
    var filter by rememberSaveable { mutableStateOf(ProjectFilter.Latest) }
    var sort by rememberSaveable { mutableStateOf(ProjectSort.Newest) }
    val latest = model.chats.groupBy { it.optString("projectId") }
    fun activity(project: JSONObject) = projectActivity(project, latest[project.optString("id")].orEmpty())
    val projects = model.projects
        .filter { filter == ProjectFilter.All || isLatestProject(activity(it), now) }
        .sortedWith(when (sort) {
            ProjectSort.Newest -> Comparator { a, b -> compareProjectActivity(activity(a), a.optString("name"), activity(b), b.optString("name"), newest = true) }
            ProjectSort.Oldest -> Comparator { a, b -> compareProjectActivity(activity(a), a.optString("name"), activity(b), b.optString("name"), newest = false) }
            ProjectSort.Name -> compareBy<JSONObject, String>(String.CASE_INSENSITIVE_ORDER) { it.optString("name") }.thenByDescending { activity(it) }
        })
    PullToRefreshBox(model.refreshing, model::retry, Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item { ProjectControls(filter, sort, { filter = it }, { sort = it }) }
            if (!model.claudeAvailable) item { Notice("Claude Code isn't available on your Mac. Install it and sign in there, then restart PocketBridge.", Modifier.padding(16.dp)) }
            if (projects.isEmpty()) item {
                if (model.online && model.projects.isNotEmpty() && filter == ProjectFilter.Latest) Empty("No recent projects", "Latest shows projects used in the last 7 days. Choose All to see every project.")
                else if (model.online) Empty("No projects yet", "Add a project folder in PocketBridge on your Mac. It appears here right away.")
                else Empty("Waiting for your Mac", "Projects appear once your Mac answers.")
            }
            items(projects, key = { it.getString("id") }) { project ->
                val chats = latest[project.optString("id")].orEmpty()
                ProjectRow(project, chats, projectActivity(project, chats), now) { onOpen(project.getString("id")) }
            }
        }
    }
}

@Composable private fun ProjectControls(filter: ProjectFilter, sort: ProjectSort, onFilter: (ProjectFilter) -> Unit, onSort: (ProjectSort) -> Unit) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        MenuButton("Show", if (filter == ProjectFilter.Latest) "Latest" else "All") {
            DropdownMenuItem(text = { Text("Latest") }, onClick = { onFilter(ProjectFilter.Latest); it() })
            DropdownMenuItem(text = { Text("All") }, onClick = { onFilter(ProjectFilter.All); it() })
        }
        MenuButton("Sort", when (sort) { ProjectSort.Newest -> "Newest"; ProjectSort.Oldest -> "Oldest"; ProjectSort.Name -> "Name" }) {
            DropdownMenuItem(text = { Text("Newest") }, onClick = { onSort(ProjectSort.Newest); it() })
            DropdownMenuItem(text = { Text("Oldest") }, onClick = { onSort(ProjectSort.Oldest); it() })
            DropdownMenuItem(text = { Text("Name") }, onClick = { onSort(ProjectSort.Name); it() })
        }
    }
}

@Composable private fun ProjectRow(project: JSONObject, chats: List<JSONObject>, activityAt: Long, now: Long, onOpen: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    // The one state worth surfacing from here: a chat that is waiting on you, or still working.
    val active = when {
        chats.any { it.optString("status") == "waiting" } -> "waiting"
        chats.any { isWorking(it.optString("status")) } -> "running"
        else -> ""
    }
    ListItem(
        headlineContent = { Text(project.optString("name"), maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            if (active.isEmpty()) Text(shortPath(project.optString("path")), maxLines = 1, overflow = TextOverflow.Ellipsis)
            else Text(statusLabel(active), color = if (active == "waiting") colors.tertiary else colors.primary)
        },
        trailingContent = { if (activityAt > 0) Text(relativeTime(activityAt, now), style = MaterialTheme.typography.labelMedium) },
        modifier = Modifier.clickable(onClickLabel = "Open project", onClick = onOpen),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun Chats(model: BridgeModel, project: String) {
    var sort by rememberSaveable { mutableStateOf(ChatSort.Newest) }
    val chats = projectChats(model.chats, project, model.visibleDrafts()).sortedWith(when (sort) {
        ChatSort.Newest -> compareByDescending { it.optLong("updatedAt") }
        ChatSort.Oldest -> compareBy { it.optLong("updatedAt") }
    })
    val now = rememberNow()
    PullToRefreshBox(model.refreshing, model::retry, Modifier.fillMaxSize()) {
        // Bottom room keeps the last row clear of the New chat button.
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
            item { ChatControls(sort) { sort = it } }
            if (!model.claudeAvailable) item { Notice("Claude Code isn't available on your Mac. Install it and sign in there, then restart PocketBridge.", Modifier.padding(16.dp)) }
            if (chats.isEmpty()) item { Empty("No chats here yet", "Start one with New chat. Claude keeps working on your Mac when this phone locks.") }
            items(chats, key = { it.getString("id") }) { chat -> ChatRow(model, chat, now) }
        }
    }
}

@Composable private fun ChatControls(sort: ChatSort, onSort: (ChatSort) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        MenuButton("Sort", if (sort == ChatSort.Newest) "Newest" else "Oldest") {
            DropdownMenuItem(text = { Text("Newest") }, onClick = { onSort(ChatSort.Newest); it() })
            DropdownMenuItem(text = { Text("Oldest") }, onClick = { onSort(ChatSort.Oldest); it() })
        }
    }
}

@Composable internal fun MenuButton(label: String, value: String, enabled: Boolean = true, content: @Composable (close: () -> Unit) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        AssistChip(onClick = { expanded = true }, enabled = enabled, label = { Text("$label: $value") }, modifier = Modifier.heightIn(min = 48.dp))
        DropdownMenu(expanded, { expanded = false }) { content { expanded = false } }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable private fun ChatRow(model: BridgeModel, chat: JSONObject, now: Long) {
    val status = chat.optString("status")
    val colors = MaterialTheme.colorScheme
    var menu by remember { mutableStateOf(false) }
    var rename by remember { mutableStateOf(false) }
    var delete by remember { mutableStateOf(false) }
    val id = chat.getString("id")
    val local = chat.optBoolean("local")
    val unconfirmed = local && status == "unconfirmed"
    val working = isWorking(status)
    val open = { model.open(id) }
    ListItem(
        headlineContent = { Text(chat.optString("title").ifBlank { "New chat" }, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        // Ready chats stay quiet; only states that need a look get a second line.
        supportingContent = if (status in listOf("idle", "")) null else {
            {
                val tint = when (status) { "waiting" -> colors.tertiary; "error", "unconfirmed" -> colors.error; "interrupted", "draft" -> colors.onSurfaceVariant; else -> colors.primary }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (status == "running" || status == "stopping") CircularProgressIndicator(Modifier.size(12.dp), color = tint, strokeWidth = 1.75.dp)
                    Text(statusLabel(status), color = tint)
                }
            }
        },
        trailingContent = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (!local || chat.optLong("updatedAt") > 0) Text(relativeTime(chat.optLong("updatedAt"), now), style = MaterialTheme.typography.labelMedium)
                if (!unconfirmed) Box {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "Chat actions") }
                    ChatMenu(menu, { menu = false }, if (local) null else ({ rename = true }), { delete = true }, working)
                }
            }
        },
        modifier = if (unconfirmed) Modifier.clickable(onClickLabel = "Open chat", onClick = open) else Modifier.combinedClickable(onClickLabel = "Open chat", onClick = open, onLongClickLabel = "Chat actions", onLongClick = { menu = true }),
    )
    if (rename) RenameDialog(chat.optString("title").ifBlank { "New chat" }, { rename = false }, { model.rename(id, it); rename = false })
    if (delete) DeleteDialog(chat.optString("title").ifBlank { "New chat" }, working, local, { delete = false }, { if (local) model.discardDraft(id) else model.delete(id); delete = false })
}

@Composable private fun ChatMenu(expanded: Boolean, onDismiss: () -> Unit, onRename: (() -> Unit)?, onDelete: () -> Unit, working: Boolean) {
    DropdownMenu(expanded, onDismiss) {
        if (onRename != null) DropdownMenuItem(text = { Text("Rename") }, onClick = { onDismiss(); onRename() })
        DropdownMenuItem(
            text = { Text(if (working) "Stop before deleting" else "Delete") },
            enabled = !working,
            onClick = { onDismiss(); onDelete() },
        )
    }
}

@Composable private fun RenameDialog(current: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var title by rememberSaveable(current) { mutableStateOf(current) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename chat") },
        text = { OutlinedTextField(title, { title = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Name") }) },
        confirmButton = { TextButton(onClick = { onSave(title) }, enabled = title.isNotBlank()) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable private fun DeleteDialog(title: String, working: Boolean, local: Boolean, onDismiss: () -> Unit, onDelete: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (working) "Stop this chat first" else "Delete chat?") },
        text = { Text(when {
            working -> "Claude is still working or waiting. Stop it before deleting."
            local -> "Delete \"$title\" from this phone. It has not been sent."
            else -> "Delete \"$title\" from PocketBridge on this phone and Mac."
        }) },
        confirmButton = { TextButton(onClick = onDelete, enabled = !working) { Text("Delete", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable private fun Empty(title: String, body: String) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 40.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleLarge)
        Text(body, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Macs keep projects under the home folder; "~" keeps the useful tail visible on a phone. */
fun shortPath(path: String) = path.replaceFirst(Regex("^/Users/[^/]+"), "~")
