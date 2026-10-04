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

/** Where a page's list may draw: the app bar's collapse connection and room for the navigation bar. */
class PageInsets(val scroll: Modifier, val bottom: Dp)

@Composable fun Pairing(model: BridgeModel) {
    val focus = LocalFocusManager.current
    val colors = MaterialTheme.colorScheme
    val ready = !model.busy && model.pairUrl.isNotBlank() && model.pairCode.isNotBlank()
    val connect = { if (ready) { focus.clearFocus(); model.pair() } }
    val field = RoundedCornerShape(Corners.groupInner * 4)
    Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = Spacing.xxl, vertical = Spacing.xxxl)) {
        Spacer(Modifier.height(Spacing.huge))
        Box(Modifier.size(56.dp).background(colors.primaryContainer, RoundedCornerShape(Corners.groupOuter)), contentAlignment = Alignment.Center) {
            Icon(PocketIcons.Laptop, null, Modifier.size(28.dp), tint = colors.onPrimaryContainer)
        }
        Spacer(Modifier.height(Spacing.xxl))
        Text("Pair with your Mac", Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(Spacing.sm))
        Text("In PocketBridge on your Mac, choose Connect phone. Scan its QR code, or enter the address and code.", style = MaterialTheme.typography.bodyLarge, color = colors.onSurfaceVariant)
        Spacer(Modifier.height(Spacing.xxxl))
        OutlinedTextField(
            model.pairUrl, { model.pairUrl = it }, Modifier.fillMaxWidth(), shape = field,
            label = { Text("Mac address") }, placeholder = { Text("https://mac.tailnet.ts.net") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false, imeAction = ImeAction.Next),
        )
        Spacer(Modifier.height(Spacing.md))
        OutlinedTextField(
            model.pairCode, { model.pairCode = it.uppercase().filter { c -> !c.isWhitespace() } }, Modifier.fillMaxWidth(), shape = field,
            label = { Text("Pairing code") }, supportingText = { Text("Valid for 10 minutes") }, singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, keyboardType = KeyboardType.Ascii, autoCorrectEnabled = false, imeAction = ImeAction.Go),
            keyboardActions = KeyboardActions(onGo = { connect() }),
        )
        if (model.error.isNotEmpty()) Notice(model.error, Modifier.padding(top = Spacing.md), isError = true)
        Spacer(Modifier.height(Spacing.xl))
        Button(onClick = connect, enabled = ready, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
            if (model.busy) { CircularProgressIndicator(Modifier.size(Sizes.smallIcon), strokeWidth = 2.dp, color = LocalContentColor.current); Spacer(Modifier.width(Spacing.md)); Text("Connecting…") }
            else Text("Connect", style = MaterialTheme.typography.titleSmall)
        }
        Spacer(Modifier.height(Spacing.xl))
        Text("Tailscale on both devices. Claude and Codex sign-in stays on the Mac.", style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
    }
}

@Composable fun Notice(text: String, modifier: Modifier = Modifier, isError: Boolean = false) {
    val colors = MaterialTheme.colorScheme
    Surface(modifier.fillMaxWidth(), color = if (isError) colors.errorContainer else colors.tertiaryContainer, contentColor = if (isError) colors.onErrorContainer else colors.onTertiaryContainer, shape = RoundedCornerShape(Corners.groupOuter)) {
        Row(Modifier.padding(Spacing.lg), horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
            Icon(if (isError) Icons.Default.Warning else Icons.Default.Info, null, Modifier.size(20.dp))
            Text(text, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/** A section title above a group, aligned with the rows' text. */
@Composable fun GroupLabel(text: String, modifier: Modifier = Modifier, trailing: @Composable RowScope.() -> Unit = {}) {
    Row(modifier.fillMaxWidth().padding(start = Spacing.xxxl, end = Spacing.lg, top = Spacing.xl, bottom = Spacing.sm).heightIn(min = 24.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        trailing()
    }
}

/**
 * One row of a grouped list: rounded ends on the first and last row, tight joins between. Rows are tonal cards on the
 * page, the Android 16 settings layout. [onClick] and [onLongClick] make it interactive with labels for TalkBack.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable fun GroupRow(
    index: Int, count: Int, modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null, onClickLabel: String? = null, onLongClick: (() -> Unit)? = null, onLongClickLabel: String? = null,
    leading: (@Composable () -> Unit)? = null, trailing: (@Composable () -> Unit)? = null, supporting: (@Composable () -> Unit)? = null,
    headline: @Composable () -> Unit,
) {
    val click = when {
        onClick != null && onLongClick != null -> Modifier.combinedClickable(onClickLabel = onClickLabel, onClick = onClick, onLongClickLabel = onLongClickLabel, onLongClick = onLongClick)
        onClick != null -> Modifier.clickable(onClickLabel = onClickLabel, onClick = onClick)
        else -> Modifier
    }
    Row(
        modifier.padding(horizontal = Spacing.lg).padding(bottom = if (index < count - 1) Spacing.xxs else 0.dp).fillMaxWidth()
            .clip(groupShape(index, count)).background(Pocket.colors.row).then(click).heightIn(min = 64.dp)
            .padding(start = Spacing.lg, end = Spacing.lg, top = Spacing.md, bottom = Spacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading?.let { it(); Spacer(Modifier.width(Spacing.lg)) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            ProvideTextStyle(MaterialTheme.typography.titleMedium) { headline() }
            supporting?.let { CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onSurfaceVariant) { ProvideTextStyle(MaterialTheme.typography.bodyMedium) { it() } } }
        }
        trailing?.let { Spacer(Modifier.width(Spacing.md)); it() }
    }
}

/** A 40dp rounded tile for a row's leading slot. */
@Composable fun Tile(container: Color, content: @Composable BoxScope.() -> Unit) {
    Box(Modifier.size(Sizes.tile).background(container, RoundedCornerShape(Corners.groupInner * 3)), contentAlignment = Alignment.Center, content = content)
}

@Composable fun Settings(model: BridgeModel, insets: PageInsets) {
    var confirm by remember { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    LaunchedEffect(model.online) { if (model.online) model.refreshUsage() }
    Column(Modifier.fillMaxSize().then(insets.scroll).verticalScroll(rememberScrollState()).padding(bottom = insets.bottom + Spacing.xxl)) {
        GroupLabel("Mac", Modifier.padding(top = 0.dp))
        GroupRow(
            0, 3,
            leading = { Tile(colors.secondaryContainer) { Icon(PocketIcons.Laptop, null, Modifier.size(20.dp), tint = colors.onSecondaryContainer) } },
            supporting = {
                when {
                    model.online -> StatusLine("idle", word = "Connected", tint = colors.primary)
                    model.connectionIssue.isEmpty() -> StatusLine("running", word = "Connecting")
                    else -> Text("Offline · " + model.connectionIssue, maxLines = 3)
                }
            },
        ) { SelectionContainer { Text(model.pairUrl, maxLines = 1, overflow = TextOverflow.Ellipsis) } }
        GroupRow(
            1, 3, onClick = model::retry.takeIf { !model.refreshing },
            leading = { Tile(Color.Transparent) { Icon(Icons.Default.Refresh, null, tint = colors.onSurfaceVariant) } },
            trailing = { if (model.refreshing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) },
        ) { Text("Reconnect") }
        GroupRow(
            2, 3, onClick = { confirm = true }.takeIf { !model.busy },
            leading = { Tile(Color.Transparent) { Icon(Icons.AutoMirrored.Filled.ExitToApp, null, tint = colors.error) } },
        ) { Text("Disconnect", color = colors.error) }

        GroupLabel("Agents")
        val agents = model.agents.ifEmpty { listOf(AgentInfo(CLAUDE, "Claude", model.claudeAvailable, emptyList(), emptyList(), "default", "default")) }
        agents.forEachIndexed { index, agent ->
            GroupRow(
                index, agents.size,
                leading = { Tile(colors.secondaryContainer) { Icon(PocketIcons.Terminal, null, Modifier.size(20.dp), tint = colors.onSecondaryContainer) } },
                supporting = {
                    Text(when {
                        !agent.available -> "Not found. Install and sign in on the Mac, then restart PocketBridge."
                        !agent.enabled -> "Off. New chats and usage skip it."
                        agent.models.isEmpty() -> "Model list unavailable"
                        else -> "${plural(agent.models.size, "model")} · ${modelName(agent, agent.defaultModel)}"
                    })
                },
                // The switch is the whole row's action: one tap turns an agent on or off on the Mac.
                onClick = { model.setAgentEnabled(agent.id, !agent.enabled) }.takeIf { agent.available && model.online && !model.busy && model.agents.isNotEmpty() },
                onClickLabel = if (agent.enabled) "Turn off" else "Turn on",
                trailing = {
                    if (!agent.available) StatusLine("error", word = "Missing")
                    else Switch(agent.enabled, null, enabled = model.online && !model.busy && model.agents.isNotEmpty(), modifier = Modifier.semantics { contentDescription = "${agent.name} ${if (agent.enabled) "on" else "off"}" })
                },
            ) { Text(if (agent.id == CLAUDE) "Claude Code" else agent.name) }
        }

        AlertsRow(model)

        if (model.usage.isNotEmpty()) {
            GroupLabel("Usage") {
                if (model.usageLoading) CircularProgressIndicator(Modifier.padding(end = Spacing.md).size(Sizes.smallIcon), strokeWidth = 2.dp)
                else IconButton(onClick = { model.refreshUsage(force = true) }, Modifier.size(32.dp), enabled = model.online) { Icon(Icons.Default.Refresh, "Refresh usage", Modifier.size(20.dp)) }
            }
            Box(Modifier.padding(horizontal = Spacing.lg)) { UsageGroups(model.usage) }
        }

        GroupLabel("Updates")
        UpdateRow(model)
    }
    if (confirm) AlertDialog(
        onDismissRequest = { confirm = false },
        title = { Text("Disconnect from your Mac?") },
        text = { Text("You'll need a new pairing code to reconnect. Drafts on this phone are removed. Work already running on the Mac keeps going.") },
        confirmButton = { TextButton(onClick = { model.disconnect(); confirm = false }) { Text("Disconnect", color = colors.error) } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
    )
}

/** One switch for background alerts. Turning it on asks Android for notifications, or opens their settings once refused. */
@Composable private fun AlertsRow(model: BridgeModel) {
    val context = LocalContext.current
    val colors = MaterialTheme.colorScheme
    // Re-read when the app returns, since notification permission changes in Android's own settings.
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val permitted = remember(lifecycle) { Alerts.allowed(context) }
    val openSettings = { context.startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> model.alertsAsked(granted); if (!granted) openSettings() }
    val on = model.alertsOn && permitted
    val toggle = {
        when {
            on -> model.setAlerts(false)
            permitted -> model.setAlerts(true)
            Build.VERSION.SDK_INT >= 33 -> { model.setAlerts(true); ask.launch(Manifest.permission.POST_NOTIFICATIONS) }
            else -> { model.setAlerts(true); openSettings() }
        }
    }
    GroupLabel("Alerts")
    GroupRow(
        0, 1, onClick = toggle, onClickLabel = if (on) "Turn off" else "Turn on",
        leading = { Tile(colors.secondaryContainer) { Icon(Icons.Default.Notifications, null, Modifier.size(20.dp), tint = colors.onSecondaryContainer) } },
        supporting = { Text(if (model.alertsOn && !permitted) "Notifications are off for PocketBridge in Android settings." else "Done, failed and questions while the app is closed.") },
        trailing = { Switch(on, null, modifier = Modifier.semantics { contentDescription = "Alerts ${if (on) "on" else "off"}" }) },
    ) { Text("Alerts when closed") }
    if (on) Text(
        "On Samsung, set PocketBridge's battery use to Unrestricted so alerts arrive on time.",
        Modifier.padding(start = Spacing.xxxl, end = Spacing.xxl, top = Spacing.sm), style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant,
    )
}

@Composable private fun UpdateRow(model: BridgeModel) {
    val update = model.updateStatus
    val colors = MaterialTheme.colorScheme
    GroupRow(
        0, 1,
        leading = { Tile(colors.secondaryContainer) { Icon(PocketIcons.Download, null, Modifier.size(20.dp), tint = colors.onSecondaryContainer) } },
        supporting = { Text(if (update.latest.isBlank()) update.message else "Latest ${update.latest} · ${update.message}") },
        trailing = {
            when {
                model.updateBusy -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                update.apkPath.isNotBlank() -> Button(onClick = model::installUpdate) { Text("Install") }
                update.release != null -> Button(onClick = model::downloadUpdate) { Text("Download") }
                else -> FilledTonalButton(onClick = model::checkUpdate) { Text("Check") }
            }
        },
    ) { Text("PocketBridge ${update.installed}") }
}

/** Minute-resolution clock so relative times stay true while the list is open. */
@Composable private fun rememberNow(): Long {
    val now by produceState(System.currentTimeMillis()) { while (true) { delay(30_000); value = System.currentTimeMillis() } }
    return now
}

fun relativeTime(time: Long, now: Long): String =
    if (now - time < DateUtils.MINUTE_IN_MILLIS) "Now"
    else DateUtils.getRelativeTimeSpanString(time, now, DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE or DateUtils.FORMAT_ABBREV_MONTH).toString()

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
@Composable fun Projects(model: BridgeModel, insets: PageInsets, onOpenProject: (String) -> Unit, onOpenChat: (JSONObject) -> Unit) {
    val now = rememberNow()
    var recent by rememberSaveable { mutableStateOf(true) }
    var sort by rememberSaveable { mutableStateOf(ProjectSort.Newest) }
    var query by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(model.online) { if (model.online) model.refreshUsage() }
    val byProject = model.chats.groupBy { it.optString("projectId") }
    fun activity(project: JSONObject) = projectActivity(project, byProject[project.optString("id")].orEmpty())
    val searching = query.isNotBlank()
    val projects = model.projects
        .filter { if (searching) matchesProject(query, it.optString("name"), it.optString("path")) else !recent || isLatestProject(activity(it), now) }
        .sortedWith(when (sort) {
            ProjectSort.Newest -> Comparator { a, b -> compareProjectActivity(activity(a), a.optString("name"), activity(b), b.optString("name"), newest = true) }
            ProjectSort.Oldest -> Comparator { a, b -> compareProjectActivity(activity(a), a.optString("name"), activity(b), b.optString("name"), newest = false) }
            ProjectSort.Name -> compareBy<JSONObject, String>(String.CASE_INSENSITIVE_ORDER) { it.optString("name") }.thenByDescending { activity(it) }
        })
    // Work in progress anywhere comes first, so a waiting question is one tap from launch.
    val active = if (searching) emptyList() else model.chats.filter { isWorking(it.optString("status")) }
    PullToRefreshBox(model.refreshing, model::retry, Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize().then(insets.scroll), contentPadding = PaddingValues(bottom = insets.bottom + Spacing.xxl)) {
            item(key = "search") { SearchField(query) { query = it } }
            if (!searching) item(key = "filters") {
                Row(Modifier.fillMaxWidth().padding(start = Spacing.lg, end = Spacing.xs), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                    FilterChip(recent, { recent = true }, label = { Text("Recent") }, shape = CircleShape)
                    FilterChip(!recent, { recent = false }, label = { Text("All") }, shape = CircleShape)
                    Spacer(Modifier.weight(1f))
                    SortMenu(ProjectSort.entries, sort, { it.label }) { sort = it }
                }
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
                ProjectRow(project, chats, projectActivity(project, chats), now, index, projects.size) { onOpenProject(project.getString("id")) }
            }
        }
    }
}

@Composable private fun SearchField(query: String, onQuery: (String) -> Unit) {
    val colors = MaterialTheme.colorScheme
    TextField(
        query, onQuery, Modifier.fillMaxWidth().padding(start = Spacing.lg, end = Spacing.lg, top = Spacing.xs, bottom = Spacing.sm).heightIn(min = 56.dp),
        placeholder = { Text("Search projects") }, singleLine = true, shape = CircleShape,
        leadingIcon = { Icon(Icons.Default.Search, null) },
        trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { onQuery("") }) { Icon(Icons.Default.Clear, "Clear search") } },
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search, autoCorrectEnabled = false),
        colors = TextFieldDefaults.colors(
            focusedContainerColor = Pocket.colors.row, unfocusedContainerColor = Pocket.colors.row,
            focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
            unfocusedLeadingIconColor = colors.onSurfaceVariant, focusedLeadingIconColor = colors.onSurface,
        ),
    )
}

/** Status in the leading tile: a spinner while working, an amber mark when it needs you. */
@Composable private fun StatusTile(status: String, fallback: @Composable BoxScope.() -> Unit) {
    val colors = MaterialTheme.colorScheme
    when (status) {
        "running", "stopping" -> Tile(colors.primaryContainer) { CircularProgressIndicator(Modifier.size(20.dp), color = colors.onPrimaryContainer, strokeWidth = 2.dp, trackColor = Color.Transparent) }
        "waiting" -> Tile(colors.tertiaryContainer) { Icon(PocketIcons.Help, null, Modifier.size(22.dp), tint = colors.onTertiaryContainer) }
        else -> Tile(colors.secondaryContainer, fallback)
    }
}

@Composable private fun ActiveRow(model: BridgeModel, chat: JSONObject, index: Int, count: Int, now: Long, onOpen: () -> Unit) {
    val status = chat.optString("status")
    GroupRow(
        index, count, onClick = onOpen, onClickLabel = "Open chat",
        leading = { StatusTile(status) {} },
        supporting = { StatusLine(status, projectName(model, chat.optString("projectId"))) },
        trailing = { Text(relativeTime(chat.optLong("updatedAt"), now), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) },
    ) { Text(chat.optString("title").ifBlank { "New chat" }, maxLines = 1, overflow = TextOverflow.Ellipsis) }
}

/** Spinner or dot plus the shared status word; colour is never the only signal. */
@Composable fun StatusLine(status: String, detail: String = "", word: String = statusLabel(status), tint: Color = statusColor(status)) {
    val colors = MaterialTheme.colorScheme
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (status == "running" || status == "stopping") CircularProgressIndicator(Modifier.size(12.dp), color = tint, strokeWidth = 1.75.dp)
        else Box(Modifier.size(8.dp).background(tint, CircleShape))
        Spacer(Modifier.width(Spacing.xs + Spacing.xxs))
        Text(word, color = tint, maxLines = 1, style = MaterialTheme.typography.labelLarge)
        if (detail.isNotEmpty()) Text(" · $detail", color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable fun <T> SortMenu(values: List<T>, selected: T, label: (T) -> String, onPick: (T) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { expanded = true }, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant)) {
            Icon(PocketIcons.Sort, null, Modifier.size(Sizes.smallIcon)); Spacer(Modifier.width(Spacing.sm)); Text(label(selected))
        }
        DropdownMenu(expanded, { expanded = false }, shape = RoundedCornerShape(Corners.groupOuter), containerColor = Pocket.colors.panel, shadowElevation = 8.dp) {
            Text("Sort", Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.xs).semantics { heading() }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            values.forEach { value -> MenuChoice(label(value), selected = value == selected) { onPick(value); expanded = false } }
        }
    }
}

@Composable private fun ProjectRow(project: JSONObject, chats: List<JSONObject>, activityAt: Long, now: Long, index: Int, count: Int, onOpen: () -> Unit) {
    val waiting = chats.any { it.optString("status") == "waiting" }
    val working = chats.any { isWorking(it.optString("status")) }
    val colors = MaterialTheme.colorScheme
    val name = project.optString("name")
    GroupRow(
        index, count, onClick = onOpen, onClickLabel = "Open project",
        leading = {
            StatusTile(if (waiting) "waiting" else if (working) "running" else "idle") {
                Text(name.firstOrNull { it.isLetterOrDigit() }?.uppercase() ?: "#", style = MaterialTheme.typography.titleMedium, color = colors.onSecondaryContainer)
            }
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun Chats(model: BridgeModel, project: String, sort: ChatSort, list: LazyListState, insets: PageInsets) {
    val chats = projectChats(model.chats, project, model.visibleDrafts()).sortedWith(when (sort) {
        ChatSort.Newest -> compareByDescending { it.optLong("updatedAt") }
        ChatSort.Oldest -> compareBy { it.optLong("updatedAt") }
    })
    val now = rememberNow()
    val path = model.projects.find { it.optString("id") == project }?.optString("path")
    // Sessions started in Terminal or the desktop apps, offered for continuing here. Asked for once per visit.
    LaunchedEffect(project, model.online) { if (model.online) model.refreshSessions(project) }
    val sessions = model.sessions[project].orEmpty()
    var macOpen by rememberSaveable { mutableStateOf(true) }
    var macAll by rememberSaveable(project) { mutableStateOf(false) }
    var continuing by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(model.busy) { if (!model.busy) continuing = null }
    val refresh = { model.retry(); model.refreshSessions(project); model.refreshGit(project, force = true) }
    PullToRefreshBox(model.refreshing, refresh, Modifier.fillMaxSize()) {
        // Bottom room keeps the last row clear of the New chat button.
        LazyColumn(Modifier.fillMaxSize().then(insets.scroll), list, PaddingValues(bottom = insets.bottom + 96.dp)) {
            if (path != null) item(key = "path") {
                Row(Modifier.padding(start = Spacing.xxxl, end = Spacing.lg, bottom = Spacing.md), verticalAlignment = Alignment.CenterVertically) {
                    Icon(PocketIcons.Folder, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.width(Spacing.sm))
                    Text(compactPath(path), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (model.agents.isNotEmpty() && model.agents.none { it.available }) item { Notice("No coding agent found on your Mac. Install Claude Code or Codex and sign in there, then restart PocketBridge.", Modifier.padding(Spacing.lg)) }
            if (sessions.isNotEmpty()) {
                item(key = "mac-label") { SectionToggle("On your Mac", sessions.size, macOpen) { macOpen = !macOpen } }
                if (macOpen) {
                    val shown = if (macAll || sessions.size <= 3) sessions else sessions.take(3)
                    val more = sessions.size > shown.size
                    itemsIndexed(shown, key = { _, session -> "mac:" + session.agent + session.id }) { index, session ->
                        SessionRow(session, now, index, shown.size, continuing == session.id, enabled = model.online && !model.busy) {
                            continuing = session.id; model.continueSession(project, session)
                        }
                    }
                    if (more) item(key = "mac-more") {
                        TextButton(onClick = { macAll = true }, Modifier.padding(start = Spacing.xl, top = Spacing.xxs)) { Text("Show all ${sessions.size}") }
                    }
                }
                if (chats.isNotEmpty()) item(key = "chats-label") { GroupLabel("Chats") }
            }
            if (chats.isEmpty() && sessions.isEmpty()) item(key = "empty") { EmptyState(PocketIcons.Terminal, "No chats yet", "") }
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
@Composable private fun SessionRow(session: MacSession, now: Long, index: Int, count: Int, continuing: Boolean, enabled: Boolean, onContinue: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    GroupRow(
        index, count, onClick = onContinue.takeIf { enabled }, onClickLabel = "Continue on this phone",
        leading = { Tile(colors.secondaryContainer) { Icon(if (session.agent == CODEX) PocketIcons.Terminal else PocketIcons.Spark, null, Modifier.size(20.dp), tint = colors.onSecondaryContainer) } },
        supporting = { if (session.preview.isNotBlank()) Text(session.preview, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        trailing = {
            if (continuing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            else Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                if (session.updatedAt > 0) Text(relativeTime(session.updatedAt, now), style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                Text(if (session.agent == CODEX) "Codex" else "Claude", style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant, maxLines = 1)
            }
        },
    ) { Text(session.title, maxLines = 1, overflow = TextOverflow.Ellipsis) }
}

@Composable private fun ChatRow(model: BridgeModel, chat: JSONObject, now: Long, index: Int, count: Int) {
    val status = chat.optString("status")
    val colors = MaterialTheme.colorScheme
    var menu by remember { mutableStateOf(false) }
    var rename by remember { mutableStateOf(false) }
    var delete by remember { mutableStateOf(false) }
    val id = chat.getString("id")
    val local = chat.optBoolean("local")
    val unconfirmed = local && status == "unconfirmed"
    val working = isWorking(status)
    val title = chat.optString("title").ifBlank { "New chat" }
    val agent = model.agent(chat.optString("agent"))
    val preview = chat.optString("preview")
    Box {
        GroupRow(
            index, count, onClick = { model.open(id) }, onClickLabel = "Open chat",
            // Long press opens chat actions; an unconfirmed prompt has none until the Mac answers.
            onLongClick = if (unconfirmed) null else ({ menu = true }), onLongClickLabel = "Chat actions",
            // Quiet chats show their last words; anything that needs a look shows its state instead.
            supporting = {
                when {
                    status !in listOf("idle", "") -> StatusLine(status)
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
        Box(Modifier.align(Alignment.TopEnd).padding(end = Spacing.xxxl)) { ChatMenu(menu, { menu = false }, if (local) null else ({ rename = true }), { delete = true }, working, desktop) }
    }
    if (rename) RenameDialog(title, { rename = false }, { model.rename(id, it); rename = false })
    if (delete) DeleteDialog(title, working, local, { delete = false }, { if (local) model.discardDraft(id) else model.delete(id); delete = false })
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
    var title by rememberSaveable(current) { mutableStateOf(current) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename chat") },
        text = { OutlinedTextField(title, { title = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Name") }, shape = RoundedCornerShape(Corners.groupInner * 3)) },
        confirmButton = { TextButton(onClick = { onSave(title) }, enabled = title.isNotBlank()) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable fun DeleteDialog(title: String, working: Boolean, local: Boolean, onDismiss: () -> Unit, onDelete: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (working) "Stop this chat first" else "Delete chat?") },
        text = { Text(when {
            working -> "It's still working or waiting. Stop it before deleting."
            local -> "Delete \"$title\" from this phone. It hasn't been sent."
            else -> "Delete \"$title\" from PocketBridge on this phone and Mac."
        }) },
        confirmButton = { TextButton(onClick = onDelete, enabled = !working) { Text("Delete", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Icon, title and at most one line of what to expect, with an optional single action. */
@Composable fun EmptyState(icon: ImageVector, title: String, body: String, action: (@Composable () -> Unit)? = null) {
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.xxxl, vertical = Spacing.huge), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(64.dp).background(colors.surfaceContainerHigh, CircleShape), contentAlignment = Alignment.Center) {
            Icon(icon, null, Modifier.size(28.dp), tint = colors.onSurfaceVariant)
        }
        Spacer(Modifier.height(Spacing.lg))
        Text(title, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
        if (body.isNotEmpty()) {
            Spacer(Modifier.height(Spacing.xs))
            Text(body, style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant, textAlign = TextAlign.Center)
        }
        action?.let { Spacer(Modifier.height(Spacing.lg)); it() }
    }
}

/** Macs keep projects under the home folder; "~" keeps the useful tail visible on a phone. */
fun shortPath(path: String) = path.replaceFirst(Regex("^/Users/[^/]+"), "~")

/** A deep folder keeps its first two and last two parts: "~/Desktop/…/projects/site". */
fun compactPath(path: String): String {
    val parts = shortPath(path).split('/')
    return if (parts.size <= 5) parts.joinToString("/") else (parts.take(2) + "…" + parts.takeLast(2)).joinToString("/")
}
