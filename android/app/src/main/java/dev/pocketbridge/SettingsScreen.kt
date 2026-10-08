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
import androidx.compose.material.icons.filled.Lock
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

@Composable fun Settings(model: BridgeModel, insets: PageInsets) {
    var confirm by remember { mutableStateOf(false) }
    var changeAddress by remember { mutableStateOf(false) }
    var address by rememberSaveable { mutableStateOf("") }
    val colors = MaterialTheme.colorScheme
    LaunchedEffect(model.online) { if (model.online) model.usage.refresh() }
    RefreshBox(model.refreshing, { model.retry(); model.usage.refresh(force = true) }, Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize().then(insets.scroll).verticalScroll(rememberScrollState()).padding(bottom = insets.bottom + Spacing.xxl)) {
        // Agents first: the owner switches subscriptions often, so on and off is one tap from the Projects bar.
        AgentsGroup(model)
        GroupLabel("Mac")
        val rows = if (model.mac.canLock) 4 else 3
        GroupRow(
            0, rows, onClick = { address = model.pairUrl; changeAddress = true }.takeIf { !model.busy }, onClickLabel = "Change HTTPS address",
            leading = { Tile(colors.secondaryContainer) { Icon(PocketIcons.Laptop, null, Modifier.size(20.dp), tint = colors.onSecondaryContainer) } },
            supporting = {
                when {
                    model.online -> StatusLine("idle", word = "Connected", tint = colors.primary)
                    model.connectionIssue.isEmpty() -> StatusLine("running", word = "Connecting")
                    else -> Text("Offline · " + model.connectionIssue, maxLines = 3)
                }
                Text("Change HTTPS address", style = MaterialTheme.typography.bodySmall)
            },
        ) { SelectionContainer { Text(model.pairUrl, maxLines = 1, overflow = TextOverflow.Ellipsis) } }
        if (model.mac.canLock) LockRow(model, rows)
        GroupRow(
            rows - 2, rows, onClick = model::retry.takeIf { !model.refreshing },
            leading = { Tile(Color.Transparent) { Icon(Icons.Default.Refresh, null, tint = colors.onSurfaceVariant) } },
            trailing = { if (model.refreshing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) },
        ) { Text("Reconnect") }
        GroupRow(
            rows - 1, rows, onClick = { confirm = true }.takeIf { !model.busy },
            leading = { Tile(Color.Transparent) { Icon(Icons.AutoMirrored.Filled.ExitToApp, null, tint = colors.error) } },
        ) { Text("Disconnect", color = colors.error) }

        AlertsRow(model)

        if (model.usage.agents.isNotEmpty()) {
            GroupLabel("Usage") {
                if (model.usage.loading) CircularProgressIndicator(Modifier.padding(end = Spacing.md).size(Sizes.smallIcon), strokeWidth = 2.dp)
                else IconButton(onClick = { model.usage.refresh(force = true) }, Modifier.size(32.dp), enabled = model.online) { Icon(Icons.Default.Refresh, "Refresh usage", Modifier.size(20.dp)) }
            }
            Box(Modifier.padding(horizontal = Spacing.lg)) { UsageGroups(model) }
        }

        GroupLabel("Updates")
        UpdateRow(model)
    }
    }
    if (confirm) AlertDialog(
        onDismissRequest = { confirm = false },
        title = { Text("Disconnect from your Mac?") },
        text = { Text("You'll need a new pairing code to reconnect. Drafts on this phone are removed. Work already running on the Mac keeps going.") },
        confirmButton = { TextButton(onClick = { model.disconnect(); confirm = false }) { Text("Disconnect", color = colors.error) } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
    )
    if (changeAddress) AlertDialog(
        onDismissRequest = { changeAddress = false },
        title = { Text("Mac's HTTPS address") },
        text = {
            OutlinedTextField(address, { address = it }, singleLine = true,
                label = { Text("HTTPS address") }, placeholder = { Text("https://mac.tailnet.ts.net") },
                supportingText = { Text("Use the address from Connect phone on your Mac. Pairing and drafts stay saved.") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
            )
        },
        confirmButton = { TextButton(onClick = { model.updateAddress(address); changeAddress = false }, enabled = address.isNotBlank() && !model.busy) { Text("Save") } },
        dismissButton = { TextButton(onClick = { changeAddress = false }) { Text("Cancel") } },
    )
}

/** Claude Code and Codex, each one tap to turn on or off on the Mac. The switch moves at once and gives a toggle tick. */
@Composable private fun AgentsGroup(model: BridgeModel) {
    val haptics = rememberHaptics()
    GroupLabel("Agents", Modifier.padding(top = 0.dp))
    val agents = model.agents.ifEmpty { listOf(AgentInfo(CLAUDE, "Claude", model.claudeAvailable, emptyList(), emptyList(), "default", "default")) }
    val switchable = model.online && model.agents.isNotEmpty()
    agents.forEachIndexed { index, agent ->
        val toggle = { haptics.toggle(!agent.enabled); model.setAgentEnabled(agent.id, !agent.enabled) }
        GroupRow(
            index, agents.size,
            leading = {
                val hint = agentColors(agent.id)
                Tile(hint.container) { Icon(if (agent.id == CODEX) PocketIcons.Terminal else PocketIcons.Spark, null, Modifier.size(20.dp), tint = hint.accent) }
            },
            supporting = {
                Text(when {
                    !agent.available -> "Not found. Install and sign in on the Mac, then restart PocketBridge."
                    !agent.enabled -> "Off. New chats and usage skip it."
                    agent.models.isEmpty() -> "Model list unavailable"
                    else -> listOfNotNull(agent.version.ifBlank { null }, plural(agent.models.size, "model"), modelName(agent, agent.defaultModel)).joinToString(" · ")
                })
            },
            // The switch is the whole row's action: one tap turns an agent on or off on the Mac.
            onClick = toggle.takeIf { agent.available && switchable },
            onClickLabel = if (agent.enabled) "Turn off" else "Turn on",
            trailing = {
                if (!agent.available) StatusLine("error", word = "Missing")
                else Switch(agent.enabled, null, enabled = switchable, modifier = Modifier.semantics { contentDescription = "${agent.name} ${if (agent.enabled) "on" else "off"}" })
            },
        ) { Text(if (agent.id == CLAUDE) "Claude Code" else agent.name) }
    }
}

/** Locks the Mac's screen, for when it was left unlocked. Shown only when the Mac offers it. */
@Composable private fun LockRow(model: BridgeModel, rows: Int) {
    val colors = MaterialTheme.colorScheme
    val locked = model.mac.locked == true
    GroupRow(
        1, rows, onClick = model::lockMac.takeIf { model.online && !model.busy && !locked }, onClickLabel = "Lock the Mac",
        leading = { Tile(Color.Transparent) { Icon(Icons.Default.Lock, null, tint = colors.onSurfaceVariant) } },
        supporting = { if (model.mac.locked == false) Text("Unlocked") },
    ) { Text(if (locked) "Screen locked" else "Lock screen") }
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
    val haptics = rememberHaptics()
    val toggle = {
        haptics.toggle(!on)
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
    // Android 16 lets the owner turn off Live Updates per app; work then shows only in the shade.
    val liveOff = remember(lifecycle) { Alerts.liveUpdatesOff(context) }
    if (on && liveOff && Build.VERSION.SDK_INT >= 36) TextButton(
        // Some Android 16 builds have no promotion screen; the app's notification settings hold the switch there.
        onClick = {
            val promotion = Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
            try { context.startActivity(promotion) } catch (_: android.content.ActivityNotFoundException) { openSettings() }
        },
        Modifier.padding(start = Spacing.xxxl - Spacing.md),
    ) { Text("Live updates are off. Turn on", style = MaterialTheme.typography.bodySmall) }
}

@Composable private fun UpdateRow(model: BridgeModel) {
    val update = model.updates.status
    val colors = MaterialTheme.colorScheme
    GroupRow(
        0, 1,
        leading = { Tile(colors.secondaryContainer) { Icon(PocketIcons.Download, null, Modifier.size(20.dp), tint = colors.onSecondaryContainer) } },
        supporting = { Text(if (update.latest.isBlank()) update.message else "Latest ${update.latest} · ${update.message}") },
        trailing = {
            when {
                model.updates.busy -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                update.apkPath.isNotBlank() -> Button(onClick = model.updates::install) { Text("Install") }
                update.release != null -> Button(onClick = model.updates::download) { Text("Download") }
                else -> FilledTonalButton(onClick = model.updates::check) { Text("Check") }
            }
        },
    ) { Text("PocketBridge ${update.installed}") }
}
