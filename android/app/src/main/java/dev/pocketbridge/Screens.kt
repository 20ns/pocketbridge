package dev.pocketbridge

import android.text.format.DateUtils
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
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
        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            FilledTonalButton(onClick = model::retry, enabled = !model.refreshing, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (model.refreshing) "Reconnecting…" else "Reconnect") }
            OutlinedButton(onClick = { confirm = true }, enabled = !model.busy, modifier = Modifier.heightIn(min = 48.dp), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Disconnect") }
        }
        Text("PocketBridge ${BuildConfig.VERSION_NAME}", Modifier.padding(16.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (confirm) AlertDialog(
        onDismissRequest = { confirm = false },
        title = { Text("Disconnect from your Mac?") },
        text = { Text("You'll need a new pairing code to reconnect. Drafts on this phone are removed. Tasks already running on the Mac keep going.") },
        confirmButton = { TextButton(onClick = { model.disconnect(); confirm = false }) { Text("Disconnect", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
    )
}

/** Minute-resolution clock so relative times stay true while the list is open. */
@Composable private fun rememberNow(): Long {
    val now by produceState(System.currentTimeMillis()) { while (true) { delay(30_000); value = System.currentTimeMillis() } }
    return now
}

fun relativeTime(time: Long, now: Long): String =
    if (now - time < DateUtils.MINUTE_IN_MILLIS) "Just now"
    else DateUtils.getRelativeTimeSpanString(time, now, DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE or DateUtils.FORMAT_ABBREV_MONTH).toString()

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun Projects(model: BridgeModel, onOpen: (String) -> Unit) {
    val now = rememberNow()
    // Most recently used first; projects without chats keep the Mac's order after them.
    val latest = model.chats.groupBy { it.optString("projectId") }
    val projects = model.projects.sortedByDescending { project -> latest[project.optString("id")]?.maxOf { it.optLong("updatedAt") } ?: 0L }
    PullToRefreshBox(model.refreshing, model::retry, Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            if (!model.claudeAvailable) item { Notice("Claude Code isn't available on your Mac. Install it and sign in there, then restart PocketBridge.", Modifier.padding(16.dp)) }
            if (projects.isEmpty()) item {
                if (model.online) Empty("No projects yet", "Add a project folder in PocketBridge on your Mac. It appears here right away.")
                else Empty("Waiting for your Mac", "Projects appear once your Mac answers.")
            }
            items(projects, key = { it.getString("id") }) { project ->
                val chats = latest[project.optString("id")].orEmpty()
                ProjectRow(project, chats, now) { onOpen(project.getString("id")) }
            }
        }
    }
}

@Composable private fun ProjectRow(project: JSONObject, chats: List<JSONObject>, now: Long, onOpen: () -> Unit) {
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
        trailingContent = { chats.maxOfOrNull { it.optLong("updatedAt") }?.let { Text(relativeTime(it, now), style = MaterialTheme.typography.labelMedium) } },
        modifier = Modifier.clickable(onClickLabel = "Open project", onClick = onOpen),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun Chats(model: BridgeModel, project: String) {
    val chats = model.chats.filter { it.optString("projectId") == project }
    val now = rememberNow()
    PullToRefreshBox(model.refreshing, model::retry, Modifier.fillMaxSize()) {
        // Bottom room keeps the last row clear of the New chat button.
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
            if (!model.claudeAvailable) item { Notice("Claude Code isn't available on your Mac. Install it and sign in there, then restart PocketBridge.", Modifier.padding(16.dp)) }
            if (chats.isEmpty()) item { Empty("No chats here yet", "Start one with New chat. Claude keeps working on your Mac when this phone locks.") }
            items(chats, key = { it.getString("id") }) { chat -> ChatRow(model, chat, now) }
        }
    }
}

@Composable private fun ChatRow(model: BridgeModel, chat: JSONObject, now: Long) {
    val status = chat.optString("status")
    val colors = MaterialTheme.colorScheme
    ListItem(
        headlineContent = { Text(chat.optString("title").ifBlank { "New chat" }, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        // Ready chats stay quiet; only states that need a look get a second line.
        supportingContent = if (status in listOf("idle", "")) null else {
            {
                val tint = when (status) { "waiting" -> colors.tertiary; "error" -> colors.error; "interrupted" -> colors.onSurfaceVariant; else -> colors.primary }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (status == "running" || status == "stopping") CircularProgressIndicator(Modifier.size(12.dp), color = tint, strokeWidth = 1.75.dp)
                    Text(statusLabel(status), color = tint)
                }
            }
        },
        trailingContent = { Text(relativeTime(chat.optLong("updatedAt"), now), style = MaterialTheme.typography.labelMedium) },
        modifier = Modifier.clickable(onClickLabel = "Open chat") { model.open(chat.getString("id")) },
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
