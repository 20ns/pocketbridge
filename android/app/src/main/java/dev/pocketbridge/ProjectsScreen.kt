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
import org.json.JSONObject

enum class ProjectSort(val label: String) { Newest("Newest"), Oldest("Oldest"), Name("Name") }
enum class ChatSort(val label: String) { Newest("Newest"), Oldest("Oldest") }

val LatestProjectWindowMillis = 7L * DateUtils.DAY_IN_MILLIS

fun projectActivity(lastUsedAt: Long, newestChatUpdatedAt: Long) = maxOf(lastUsedAt.coerceAtLeast(0), newestChatUpdatedAt.coerceAtLeast(0))
fun isLatestProject(activityAt: Long, now: Long) = activityAt > 0 && activityAt >= now - LatestProjectWindowMillis
fun compareProjectActivity(leftAt: Long, leftName: String, rightAt: Long, rightName: String, newest: Boolean): Int {
    val activity = if (newest) rightAt.compareTo(leftAt) else leftAt.compareTo(rightAt)
    return activity.takeIf { it != 0 } ?: leftName.compareTo(rightName, ignoreCase = true)
}
/** Every word must appear in the name or folder path, in any order. */
fun matchesProject(query: String, name: String, path: String): Boolean {
    val words = query.trim().lowercase().split(Regex("\\s+")).filter(String::isNotEmpty)
    val haystack = "$name $path".lowercase()
    return words.all { it in haystack }
}
private fun projectActivity(project: JSONObject, chats: List<JSONObject>) = projectActivity(project.optLong("lastUsedAt"), chats.maxOfOrNull { it.optLong("updatedAt") } ?: 0L)

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun Projects(model: BridgeModel, insets: PageInsets, list: LazyListState, onOpenProject: (String) -> Unit, onOpenChat: (JSONObject) -> Unit) {
    val now = rememberNow()
    // Filter and sort are this phone's preference, kept across launches.
    var recent by remember { mutableStateOf(model.uiSetting("projectsAll") != "1") }
    var sort by remember { mutableStateOf(ProjectSort.entries.find { it.name == model.uiSetting("projectSort") } ?: ProjectSort.Newest) }
    LaunchedEffect(recent, sort) { model.saveUiSetting("projectsAll", if (recent) "" else "1"); model.saveUiSetting("projectSort", sort.name) }
    var query by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(model.online) { if (model.online) model.usage.refresh() }
    val byProject = model.chats.filter { it.optString("id") !in model.deletions }.groupBy { it.optString("projectId") }
    fun activity(project: JSONObject) = projectActivity(project, byProject[project.optString("id")].orEmpty())
    val searching = query.isNotBlank()
    val general = generalProject(model.projects)
    val projects = folderProjects(model.projects)
        .filter { if (searching) matchesProject(query, it.optString("name"), it.optString("path")) else !recent || isLatestProject(activity(it), now) }
        .sortedWith(when (sort) {
            ProjectSort.Newest -> Comparator { a, b -> compareProjectActivity(activity(a), a.optString("name"), activity(b), b.optString("name"), newest = true) }
            ProjectSort.Oldest -> Comparator { a, b -> compareProjectActivity(activity(a), a.optString("name"), activity(b), b.optString("name"), newest = false) }
            ProjectSort.Name -> compareBy<JSONObject, String>(String.CASE_INSENSITIVE_ORDER) { it.optString("name") }.thenByDescending { activity(it) }
        })
    // Work in progress anywhere comes first, so a waiting question is one tap from launch.
    val active = if (searching) emptyList() else model.chats.filter { isWorking(it.optString("status")) }
    RefreshBox(model.refreshing, model::retry, Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize().then(insets.scroll), list, PaddingValues(bottom = insets.bottom + Spacing.xxl)) {
            item(key = "search") { SearchField(query) { query = it } }
            if (!searching) item(key = "filters") {
                Row(Modifier.fillMaxWidth().padding(start = Spacing.lg, end = Spacing.xs), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                    FilterChip(recent, { recent = true }, label = { Text("Recent") }, shape = CircleShape)
                    FilterChip(!recent, { recent = false }, label = { Text("All") }, shape = CircleShape)
                    Spacer(Modifier.weight(1f))
                    SortMenu(ProjectSort.entries, sort, { it.label }) { sort = it }
                }
            }
            // General sits apart from the folders: one quiet row, always there so it can be found.
            if (general != null && !searching) item(key = "general") {
                GeneralRow(byProject[general.optString("id")].orEmpty(), now) { onOpenProject(general.optString("id")) }
            }
            if (model.agents.isNotEmpty() && model.agents.none { it.available }) item { Notice("No coding agent found on your Mac. Install Claude Code or Codex and sign in there, then restart PocketBridge.", Modifier.padding(Spacing.lg)) }
            if (active.isNotEmpty()) {
                item(key = "active-label") { GroupLabel("Active", Modifier.padding(top = 0.dp)) }
                itemsIndexed(active, key = { _, chat -> "active:" + chat.getString("id") }) { index, chat -> ActiveRow(model, chat, index, active.size, now) { onOpenChat(chat) } }
                item(key = "projects-label") { GroupLabel("Projects") }
            } else item(key = "top-gap") { Spacer(Modifier.height(Spacing.xs)) }
            if (projects.isEmpty()) item(key = "empty") {
                when {
                    searching -> EmptyState(Icons.Default.Search, "No matches", "No project name or folder contains “${query.trim()}”.")
                    model.online && model.projects.isNotEmpty() && recent -> EmptyState(PocketIcons.Folder, "Nothing recent", "No project used in the last 7 days.") {
                        FilledTonalButton(onClick = { recent = false }) { Text("Show all") }
                    }
                    model.online -> EmptyState(PocketIcons.Folder, "No projects yet", "Folders where you've used Claude Code or Codex on your Mac appear here.")
                    else -> EmptyState(PocketIcons.Laptop, "Waiting for your Mac", "Projects appear once it answers.")
                }
            }
            itemsIndexed(projects, key = { _, project -> project.getString("id") }) { index, project ->
                val chats = byProject[project.optString("id")].orEmpty()
                ProjectRow(model, project, chats, projectActivity(project, chats), now, index, projects.size) { onOpenProject(project.getString("id")) }
            }
        }
    }
}

@Composable private fun SearchField(query: String, onQuery: (String) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val focus = LocalFocusManager.current
    TextField(
        query, onQuery, Modifier.fillMaxWidth().padding(start = Spacing.lg, end = Spacing.lg, top = Spacing.xs, bottom = Spacing.sm).heightIn(min = 56.dp),
        placeholder = { Text("Search projects") }, singleLine = true, shape = CircleShape,
        leadingIcon = { Icon(Icons.Default.Search, null) },
        trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { onQuery("") }) { Icon(Icons.Default.Clear, "Clear search") } },
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search, autoCorrectEnabled = false),
        // Search runs as you type; the keyboard's search key just puts the keyboard away.
        keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }),
        colors = TextFieldDefaults.colors(
            focusedContainerColor = Pocket.colors.row, unfocusedContainerColor = Pocket.colors.row,
            focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
            unfocusedLeadingIconColor = colors.onSurfaceVariant, focusedLeadingIconColor = colors.onSurface,
        ),
    )
}

/** Status in the leading tile: a spinner while working, an amber mark when it needs you. */
@Composable private fun StatusTile(status: String, fallback: @Composable () -> Unit) {
    val colors = MaterialTheme.colorScheme
    when (status) {
        "running", "stopping" -> Tile(colors.primaryContainer) { CircularProgressIndicator(Modifier.size(20.dp), color = colors.onPrimaryContainer, strokeWidth = 2.dp, trackColor = Color.Transparent) }
        "waiting" -> Tile(colors.tertiaryContainer) { Icon(PocketIcons.Help, null, Modifier.size(22.dp), tint = colors.onTertiaryContainer) }
        else -> fallback()
    }
}

@Composable private fun ActiveRow(model: BridgeModel, chat: JSONObject, index: Int, count: Int, now: Long, onOpen: () -> Unit) {
    val status = chat.optString("status")
    val agent = agentColors(chat.optString("agent"))
    GroupRow(
        index, count, onClick = onOpen, onClickLabel = "Open chat", container = agent.tint, accent = agent.accent,
        leading = { StatusTile(status) { Tile(MaterialTheme.colorScheme.secondaryContainer) {} } },
        supporting = { StatusLine(status, projectName(model, chat.optString("projectId"))) },
        trailing = { Text(relativeTime(chat.optLong("updatedAt"), now), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) },
    ) { Text(chat.optString("title").ifBlank { "New chat" }, maxLines = 1, overflow = TextOverflow.Ellipsis) }
}

@Composable private fun ProjectRow(model: BridgeModel, project: JSONObject, chats: List<JSONObject>, activityAt: Long, now: Long, index: Int, count: Int, onOpen: () -> Unit) {
    val waiting = chats.any { it.optString("status") == "waiting" }
    val working = chats.any { isWorking(it.optString("status")) }
    val colors = MaterialTheme.colorScheme
    val name = project.optString("name")
    GroupRow(
        index, count, onClick = onOpen, onClickLabel = "Open project",
        leading = {
            StatusTile(if (waiting) "waiting" else if (working) "running" else "idle") { ProjectAvatar(model, project) }
        },
        // A project with work in progress says so in place of its folder.
        supporting = {
            when {
                waiting -> StatusLine("waiting")
                working -> StatusLine("running")
                else -> Text(compactPath(project.optString("path")), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        },
        trailing = { if (activityAt > 0) Text(relativeTime(activityAt, now), style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant) },
    ) { Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis) }
}

/** General's entry above the folders: a chat mark, its chat count and when it was last used. */
@Composable private fun GeneralRow(chats: List<JSONObject>, now: Long, onOpen: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val newest = chats.maxOfOrNull { it.optLong("updatedAt") } ?: 0L
    val working = chats.any { isWorking(it.optString("status")) }
    GroupRow(
        0, 1, Modifier.padding(bottom = Spacing.xs), onClick = onOpen, onClickLabel = "Open General chats",
        leading = { Tile(colors.surfaceContainerHigh) { Icon(PocketIcons.Chat, null, Modifier.size(20.dp), tint = colors.onSurfaceVariant) } },
        supporting = {
            if (working) StatusLine(if (chats.any { it.optString("status") == "waiting" }) "waiting" else "running")
            else Text(if (chats.isEmpty()) "Chats outside any project" else plural(chats.size, "chat"), maxLines = 1)
        },
        trailing = { if (newest > 0) Text(relativeTime(newest, now), style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant) },
    ) { Text("General", maxLines = 1) }
}
