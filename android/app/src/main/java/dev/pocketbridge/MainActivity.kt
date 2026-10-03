package dev.pocketbridge

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val model by viewModels<BridgeModel>()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); enableEdgeToEdge()
        // A recreated activity (rotation, theme, font size) still holds the launch intent; only a fresh launch reads its link.
        if (savedInstanceState == null) model.handleLink(intent.data)
        setContent { PocketTheme { BridgeApp(model) } }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); model.handleLink(intent.data) }
    override fun onResume() { super.onResume(); model.resumeUpdateInstall() }
}

/** Depth drives the slide direction: deeper screens enter from the end, Back reverses it. */
private enum class Screen(val depth: Int) { Pair(0), Projects(0), Chats(1), Settings(1), Chat(2) }

@Composable private fun BridgeApp(model: BridgeModel) {
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event -> when (event) { Lifecycle.Event.ON_START -> model.foreground(true); Lifecycle.Event.ON_STOP -> model.foreground(false); else -> Unit } }
        owner.lifecycle.addObserver(observer)
        model.foreground(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
        onDispose { owner.lifecycle.removeObserver(observer); model.foreground(false) }
    }
    var settings by rememberSaveable { mutableStateOf(false) }
    var project by rememberSaveable { mutableStateOf(model.chat?.optString("projectId") ?: "") }
    // An open chat always belongs to the list Back returns to, including after a restart.
    val chatProject = model.chat?.optString("projectId")
    LaunchedEffect(chatProject) { if (!chatProject.isNullOrEmpty()) project = chatProject }
    LaunchedEffect(model.paired) { if (!model.paired) { settings = false; project = "" } }
    val screen = when {
        !model.paired -> Screen.Pair
        settings -> Screen.Settings
        model.selected.isNotEmpty() -> Screen.Chat
        project.isNotEmpty() -> Screen.Chats
        else -> Screen.Projects
    }
    val back: () -> Unit = {
        when (screen) {
            Screen.Settings -> settings = false
            Screen.Chat -> model.open("")
            Screen.Chats -> project = ""
            else -> Unit
        }
    }
    BackHandler(screen.depth > 0, onBack = back)

    // One-off action failures are transient; connection problems get a persistent banner instead.
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(model.error, model.paired) {
        if (model.paired && model.error.isNotEmpty()) { snackbar.showSnackbar(model.error, withDismissAction = true, duration = SnackbarDuration.Long); model.clearError() }
    }

    AnimatedContent(
        screen,
        transitionSpec = {
            val forward = targetState.depth >= initialState.depth
            (slideInHorizontally(tween(260)) { width -> (if (forward) width else -width) / 12 } + fadeIn(tween(220, delayMillis = 40))) togetherWith fadeOut(tween(90))
        },
        label = "screen",
    ) { target ->
        when (target) {
            Screen.Pair -> Scaffold(snackbarHost = { SnackbarHost(snackbar) }) { inset -> Box(Modifier.padding(inset).consumeWindowInsets(inset)) { Pairing(model) } }
            Screen.Projects -> Page(
                model, snackbar,
                title = { Text("Projects") }, subtitle = { ConnectionLine(model) }, onSettings = { settings = true }, saved = model.projects.isNotEmpty(),
                actions = { IconButton(onClick = { settings = true }) { Icon(Icons.Default.Settings, "Connection settings") } },
            ) { Projects(model) { project = it } }
            Screen.Chats -> Page(
                model, snackbar,
                title = { Text(projectName(model, project), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigation = { BackLabel("Projects", back) }, onSettings = { settings = true }, saved = projectChats(model.chats, project, model.visibleDrafts()).isNotEmpty(),
                fab = { NewChatButton(model, project, snackbar) },
            ) { Chats(model, project) }
            Screen.Settings -> Page(model, snackbar, title = { Text("Connection") }, navigation = { BackLabel("", back) }) { Settings(model) }
            Screen.Chat -> Page(
                model, snackbar,
                title = { Text(model.chat?.optString("title")?.ifBlank { null } ?: "New chat", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                subtitle = { Text(projectName(model, model.chat?.optString("projectId")), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigation = { BackLabel("Recent chats", back) }, onSettings = { settings = true }, saved = model.messages.isNotEmpty(),
                bottomBar = { Composer(model) },
            ) { Conversation(model) }
        }
    }
}

/** One screen frame: top app bar, the persistent connection banner, then content. [saved]: this screen has cached data to show offline. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun Page(
    model: BridgeModel,
    snackbar: SnackbarHostState,
    title: @Composable () -> Unit,
    subtitle: (@Composable () -> Unit)? = null,
    navigation: @Composable () -> Unit = {},
    actions: @Composable RowScope.() -> Unit = {},
    onSettings: () -> Unit = {},
    saved: Boolean = false,
    fab: @Composable () -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    content: @Composable () -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        title()
                        subtitle?.let { CompositionLocalProvider(LocalTextStyle provides MaterialTheme.typography.labelMedium, LocalContentColor provides MaterialTheme.colorScheme.onSurfaceVariant) { it() } }
                    }
                },
                navigationIcon = navigation, actions = actions,
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
        floatingActionButton = fab,
        bottomBar = bottomBar,
    ) { inset ->
        Column(Modifier.fillMaxSize().padding(inset).consumeWindowInsets(inset)) {
            ConnectionBanner(model, saved, onSettings)
            Box(Modifier.weight(1f)) { content() }
        }
    }
}

/** Back with its destination named, as in a messaging app. Large font sizes keep only the arrow. */
@Composable private fun BackLabel(label: String, onBack: () -> Unit) {
    val roomy = LocalDensity.current.fontScale <= 1.3f
    if (label.isEmpty() || !roomy) IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, if (label.isEmpty()) "Back" else "Back to ${label.lowercase()}") }
    else TextButton(onClick = onBack, Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Back to ${label.lowercase()}" }, contentPadding = PaddingValues(start = 8.dp, end = 12.dp)) {
        Icon(Icons.AutoMirrored.Filled.ArrowBack, null, Modifier.size(22.dp))
        Spacer(Modifier.width(6.dp))
        Text(label, maxLines = 1)
    }
}

@Composable private fun NewChatButton(model: BridgeModel, project: String, snackbar: SnackbarHostState) {
    val scope = rememberCoroutineScope()
    ExtendedFloatingActionButton(
        modifier = Modifier.semantics { contentDescription = "New chat" },
        onClick = {
            val blocked = when {
                !model.claudeAvailable -> "Claude Code isn't available on your Mac."
                model.projects.none { it.optString("id") == project } -> "This project was removed on your Mac."
                else -> null
            }
            if (blocked != null) scope.launch { snackbar.currentSnackbarData?.dismiss(); snackbar.showSnackbar(blocked) }
            else model.newChat(project, defaultMode(model.modes))
        },
        icon = { Icon(Icons.Default.Add, null) },
        text = { Text("New chat") },
    )
}

fun projectName(model: BridgeModel, id: String?) = model.projects.find { it.optString("id") == id }?.optString("name") ?: "Project removed"

/** Connection to the Mac only; agent state is shown per chat. */
@Composable private fun ConnectionLine(model: BridgeModel) {
    val colors = MaterialTheme.colorScheme
    val (label, dot) = when {
        model.online -> "Connected to your Mac" to colors.primary
        model.connectionIssue.isEmpty() -> "Connecting…" to colors.outline
        else -> "Offline" to colors.error
    }
    Row(Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(7.dp).background(dot, CircleShape))
        Text(label)
    }
}

@Composable private fun ConnectionBanner(model: BridgeModel, saved: Boolean, openSettings: () -> Unit) {
    if (model.online || model.connectionIssue.isEmpty()) return
    val colors = MaterialTheme.colorScheme
    val revoked = model.revoked
    Surface(color = if (revoked) colors.errorContainer else colors.surfaceContainerHigh, contentColor = if (revoked) colors.onErrorContainer else colors.onSurface) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp).semantics { liveRegion = LiveRegionMode.Polite }, verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Warning, null, Modifier.size(20.dp), tint = if (revoked) colors.onErrorContainer else colors.error)
            Column(Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(if (revoked) "Pairing removed" else "Can't reach your Mac", style = MaterialTheme.typography.titleSmall)
                Text(
                    if (revoked) model.connectionIssue else model.connectionIssue.removePrefix("Can't reach your Mac. ") + if (saved) " Showing saved copies." else "",
                    style = MaterialTheme.typography.bodySmall, color = if (revoked) colors.onErrorContainer else colors.onSurfaceVariant,
                )
            }
            when {
                revoked -> TextButton(onClick = openSettings, Modifier.heightIn(min = 48.dp)) { Text("Settings") }
                model.refreshing -> Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) }
                else -> TextButton(onClick = model::retry, Modifier.heightIn(min = 48.dp)) { Text("Retry") }
            }
        }
    }
}
