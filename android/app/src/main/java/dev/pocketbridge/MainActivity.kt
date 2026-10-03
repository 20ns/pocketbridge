package dev.pocketbridge

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.BackEventCompat
import androidx.activity.ComponentActivity
import androidx.activity.compose.PredictiveBackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val model by viewModels<BridgeModel>()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); enableEdgeToEdge()
        Alerts.channels(this)
        // A recreated activity (rotation, theme, font size) still holds the launch intent; only a fresh launch reads it.
        if (savedInstanceState == null) handle(intent)
        setContent { PocketTheme { BridgeApp(model) } }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); handle(intent) }
    override fun onResume() { super.onResume(); model.resumeUpdateInstall() }
    // On screen, the app's own connection shows everything; closed with work running, the alerts service takes over.
    override fun onStart() { super.onStart(); Alerts.stop(this) }
    override fun onStop() { super.onStop(); if (!isChangingConfigurations) model.startAlerts() }

    /** A pairing link, images shared from another app, or a tapped notification. */
    private fun handle(intent: Intent) = when (intent.action) {
        Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> model.receiveShare(sharedImages(intent))
        Alerts.ACTION_OPEN -> intent.getStringExtra(Alerts.EXTRA_CHAT)?.let(model::openFromAlert) ?: Unit
        else -> model.handleLink(intent.data)
    }

    private fun sharedImages(intent: Intent): List<Uri> {
        val streams = if (Build.VERSION.SDK_INT >= 33) {
            if (intent.action == Intent.ACTION_SEND) listOfNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java))
            else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
        } else @Suppress("DEPRECATION") {
            if (intent.action == Intent.ACTION_SEND) listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
            else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
        }
        val clips = intent.clipData?.let { clip -> (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri } }.orEmpty()
        return (streams + clips).distinct()
    }
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
    var usage by rememberSaveable { mutableStateOf(false) }
    var models by rememberSaveable { mutableStateOf(false) }
    var project by rememberSaveable { mutableStateOf(model.chat?.optString("projectId") ?: "") }
    // An open chat always belongs to the list Back returns to, including after a restart.
    val chatProject = model.chat?.optString("projectId")
    LaunchedEffect(chatProject) { if (!chatProject.isNullOrEmpty()) project = chatProject }
    LaunchedEffect(model.paired) { if (!model.paired) { settings = false; project = ""; usage = false } }
    // The model panel belongs to one chat and closes once its choices lock.
    LaunchedEffect(model.selected, model.pending) { if (model.pending != null || model.selected.isEmpty()) models = false }
    // A notification or a share chose a chat: show it over whatever was open.
    LaunchedEffect(model.showChat) { if (model.showChat > 0) { settings = false; usage = false; models = false } }
    // Asked once, on the first send, so a turn can report back after the app closes.
    val askAlerts = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { model.alertsAsked(it) }
    LaunchedEffect(model.askAlerts) { if (model.askAlerts && Build.VERSION.SDK_INT >= 33) askAlerts.launch(Manifest.permission.POST_NOTIFICATIONS) }
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

    // Back is the system gesture alone. The page follows the finger, like Android's own back preview.
    var backProgress by remember { mutableFloatStateOf(0f) }
    var leavingProgress by remember { mutableFloatStateOf(0f) }
    var backEdge by remember { mutableIntStateOf(BackEventCompat.EDGE_LEFT) }
    PredictiveBackHandler(enabled = screen.depth > 0) { events ->
        leavingProgress = 0f
        try {
            events.collect { event -> backProgress = event.progress; backEdge = event.swipeEdge }
            leavingProgress = backProgress
            back()
        } finally { backProgress = 0f }
    }

    // One-off action failures are transient; connection problems get a persistent banner instead.
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(model.error, model.paired) {
        if (model.paired && model.error.isNotEmpty()) { snackbar.showSnackbar(model.error, withDismissAction = true, duration = SnackbarDuration.Long); model.clearError() }
    }

    // One image viewer over every screen, opened from prompts and the composer.
    var viewer by remember { mutableStateOf<Pair<List<String>, Int>?>(null) }
    LaunchedEffect(model.selected) { viewer = null }
    CompositionLocalProvider(LocalImageViewer provides { ids, index -> viewer = ids to index }) {
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerHighest)) {
        AnimatedContent(
            screen,
            transitionSpec = {
                // Shared axis: the new page slides a little from the side it belongs to while the old one makes way.
                val direction = if (targetState.depth >= initialState.depth) 1 else -1
                (slideInHorizontally(Motion.spatial(IntOffset.VisibilityThreshold)) { width -> direction * width / 10 } + fadeIn(tween(210, delayMillis = 60, easing = Motion.Emphasized))) togetherWith
                    (slideOutHorizontally(Motion.spatial(IntOffset.VisibilityThreshold)) { width -> -direction * width / 14 } + fadeOut(tween(90)))
            },
            label = "screen",
        ) { target ->
            // The page a gesture sent away keeps its shrink only while it leaves; the next change of page starts flat.
            if (target == screen) {
                val settled = transition.currentState == transition.targetState
                LaunchedEffect(settled) { if (settled) leavingProgress = 0f }
            }
            val progress = FastOutSlowInEasing.transform(if (target == screen) backProgress else leavingProgress)
            Box(Modifier.fillMaxSize().graphicsLayer {
                if (progress > 0f) {
                    val scale = 1f - 0.1f * progress
                    scaleX = scale; scaleY = scale
                    translationX = (if (backEdge == BackEventCompat.EDGE_LEFT) 1 else -1) * progress * 16.dp.toPx()
                    shape = RoundedCornerShape(32.dp * progress); clip = true
                }
            }) {
                when (target) {
                    Screen.Pair -> Scaffold(snackbarHost = { SnackbarHost(snackbar) }) { inset -> Box(Modifier.padding(inset).consumeWindowInsets(inset)) { Pairing(model) } }
                    Screen.Projects -> Page(
                        model, snackbar, title = "Projects", saved = model.projects.isNotEmpty(), onSettings = { settings = true },
                        actions = {
                            UsageMeter(model.usage) { usage = true }
                            IconButton(onClick = { settings = true }) { Icon(Icons.Default.Settings, "Settings") }
                        },
                    ) { insets -> Projects(model, insets, onOpenProject = { project = it }, onOpenChat = { chat -> project = chat.optString("projectId"); model.open(chat.optString("id")) }) }
                    Screen.Chats -> ChatsPage(model, snackbar, project, onSettings = { settings = true })
                    Screen.Settings -> Page(model, snackbar, title = "Settings") { insets -> Settings(model, insets) }
                    Screen.Chat -> Page(
                        model, snackbar, title = model.chat?.optString("title")?.ifBlank { null } ?: "New chat", large = false,
                        saved = model.messages.isNotEmpty(), onSettings = { settings = true },
                        actions = {
                            // How full this chat's context is, beside the chat it belongs to.
                            chatContext(model.chat)?.let { ContextMeter(it) }
                            ConversationMenu(model)
                        },
                        bottomBar = { Composer(model, models) { models = !models } },
                        dimTop = models, onDimTop = { models = false },
                        overlay = { ModelPanel(model, models) { models = false } },
                    ) { Conversation(model) }
                }
            }
        }
        viewer?.let { (ids, index) -> ImageViewer(model, ids, index) { viewer = null } }
    }
    }
    if (usage && screen == Screen.Projects) UsageSheet(model) { usage = false }
    if (model.paired) SharePanel(model)
}

@Composable private fun ChatsPage(model: BridgeModel, snackbar: SnackbarHostState, project: String, onSettings: () -> Unit) {
    var sort by rememberSaveable { mutableStateOf(ChatSort.Newest) }
    val list = rememberLazyListState()
    // The button shrinks to its icon once the list scrolls, leaving titles readable underneath.
    val extended by remember { derivedStateOf { list.firstVisibleItemIndex == 0 } }
    Page(
        model, snackbar, title = projectName(model, project), onSettings = onSettings,
        saved = projectChats(model.chats, project, model.visibleDrafts()).isNotEmpty(),
        actions = { SortMenu(ChatSort.entries, sort, { it.label }) { sort = it } },
        fab = { NewChatButton(model, project, snackbar, extended) },
    ) { insets -> Chats(model, project, sort, list, insets) }
}

/**
 * One screen frame: top app bar, the persistent connection banner, then content. List screens use a large title
 * that collapses as the list scrolls; the conversation keeps a compact bar. [saved]: cached data to show offline.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun Page(
    model: BridgeModel,
    snackbar: SnackbarHostState,
    title: String,
    large: Boolean = true,
    actions: @Composable RowScope.() -> Unit = {},
    onSettings: () -> Unit = {},
    saved: Boolean = false,
    fab: @Composable () -> Unit = {},
    bottomBar: (@Composable () -> Unit)? = null,
    overlay: @Composable BoxScope.() -> Unit = {},
    dimTop: Boolean = false,
    onDimTop: () -> Unit = {},
    content: @Composable (PageInsets) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val scroll = if (large) TopAppBarDefaults.exitUntilCollapsedScrollBehavior() else null
    Scaffold(
        topBar = {
            val heading = @Composable { Title(title, model) }
            Box {
                if (scroll != null) LargeTopAppBar(heading, actions = actions, scrollBehavior = scroll, colors = TopAppBarDefaults.largeTopAppBarColors(containerColor = colors.surface, scrolledContainerColor = colors.surfaceContainer))
                else TopAppBar(heading, actions = actions, colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.surface))
                // A panel over the content dims the bar too, so only the panel and its composer stay lit.
                AnimatedVisibility(dimTop, Modifier.matchParentSize(), enter = fadeIn(Motion.effects()), exit = fadeOut(Motion.fastEffects())) {
                    Box(Modifier.fillMaxSize().background(colors.scrim.copy(alpha = 0.32f)).clickable(remember { MutableInteractionSource() }, null, onClick = onDimTop))
                }
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
        floatingActionButton = fab,
        bottomBar = bottomBar ?: {},
    ) { inset ->
        // Lists draw behind the navigation bar and pad their last row instead; the composer is opaque, so the conversation stops above it.
        val bottom = inset.calculateBottomPadding()
        Column(Modifier.fillMaxSize().padding(top = inset.calculateTopPadding()).consumeWindowInsets(inset)) {
            ConnectionBanner(model, saved, onSettings)
            Box(Modifier.weight(1f).padding(bottom = if (bottomBar != null) bottom else 0.dp)) {
                // The list sits inside pull-to-refresh; collapsing the title first means a pull at the top expands it before refreshing.
                content(PageInsets(scroll?.let { Modifier.nestedScroll(it.nestedScrollConnection) } ?: Modifier, if (bottomBar != null) 0.dp else bottom))
                overlay()
            }
        }
    }
}

@Composable private fun Title(title: String, model: BridgeModel) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
        Text(title, Modifier.weight(1f, fill = false), maxLines = 1, overflow = TextOverflow.Ellipsis)
        ConnectionDot(model)
    }
}

@Composable private fun ConversationMenu(model: BridgeModel) {
    val chat = model.chat ?: return
    val id = chat.optString("id")
    val local = model.chats.none { it.optString("id") == id }
    if (local && model.pending != null) return
    val working = isWorking(chat.optString("status"))
    var menu by remember { mutableStateOf(false) }
    var rename by remember { mutableStateOf(false) }
    var delete by remember { mutableStateOf(false) }
    val title = chat.optString("title").ifBlank { "New chat" }
    Box {
        IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "Chat actions") }
        ChatMenu(menu, { menu = false }, if (local) null else ({ rename = true }), { delete = true }, working)
    }
    if (rename) RenameDialog(title, { rename = false }, { model.rename(id, it); rename = false })
    if (delete) DeleteDialog(title, working, local, { delete = false }, { if (local) model.discardDraft(id) else model.delete(id); delete = false })
}

@Composable private fun NewChatButton(model: BridgeModel, project: String, snackbar: SnackbarHostState, extended: Boolean) {
    val scope = rememberCoroutineScope()
    ExtendedFloatingActionButton(
        onClick = {
            val blocked = when {
                model.agents.isNotEmpty() && model.agents.none { it.usable } -> if (model.agents.any { it.available }) "Claude and Codex are both off. Turn one on in Settings." else "No coding agent is available on your Mac."
                model.agents.isEmpty() && !model.claudeAvailable -> "No coding agent is available on your Mac."
                model.projects.none { it.optString("id") == project } -> "This project was removed on your Mac."
                else -> null
            }
            if (blocked != null) scope.launch { snackbar.currentSnackbarData?.dismiss(); snackbar.showSnackbar(blocked) }
            else model.newChat(project)
        },
        expanded = extended,
        icon = { Icon(Icons.Default.Add, null) },
        text = { Text("New chat") },
    )
}

fun projectName(model: BridgeModel, id: String?) = model.projects.find { it.optString("id") == id }?.optString("name") ?: "Project removed"

/** Only a problem is worth a word. Connected stays silent; connecting and offline get a small labelled pill. */
@Composable private fun ConnectionDot(model: BridgeModel) {
    if (model.online) return
    val colors = MaterialTheme.colorScheme
    val (label, dot) = if (model.connectionIssue.isEmpty()) "Connecting" to colors.outline else "Offline" to colors.error
    Surface(shape = CircleShape, color = colors.surfaceContainerHigh, modifier = Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }) {
        Row(Modifier.padding(horizontal = Spacing.sm + Spacing.xxs, vertical = Spacing.xs), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(7.dp).background(dot, CircleShape))
            Spacer(Modifier.width(Spacing.xs + Spacing.xxs))
            Text(label, style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
        }
    }
}

@Composable private fun ConnectionBanner(model: BridgeModel, saved: Boolean, openSettings: () -> Unit) {
    if (model.online || model.connectionIssue.isEmpty()) return
    val colors = MaterialTheme.colorScheme
    val revoked = model.revoked
    Surface(
        Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.xs).fillMaxWidth(), shape = RoundedCornerShape(Corners.groupOuter),
        color = if (revoked) colors.errorContainer else Pocket.colors.row, contentColor = if (revoked) colors.onErrorContainer else colors.onSurface,
    ) {
        Row(Modifier.padding(start = Spacing.lg, end = Spacing.sm, top = Spacing.md, bottom = Spacing.md).semantics { liveRegion = LiveRegionMode.Polite }, verticalAlignment = Alignment.CenterVertically) {
            Icon(PocketIcons.Error, null, Modifier.size(20.dp), tint = if (revoked) colors.onErrorContainer else colors.error)
            Column(Modifier.weight(1f).padding(horizontal = Spacing.md), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                Text(if (revoked) "Pairing removed" else "Can't reach your Mac", style = MaterialTheme.typography.titleSmall)
                Text(
                    if (revoked) model.connectionIssue else model.connectionIssue.removePrefix("Can't reach your Mac. ") + if (saved) " Showing saved copies." else "",
                    style = MaterialTheme.typography.bodySmall, color = if (revoked) colors.onErrorContainer else colors.onSurfaceVariant,
                )
            }
            when {
                revoked -> TextButton(onClick = openSettings) { Text("Settings") }
                model.refreshing -> Box(Modifier.size(Sizes.touch), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) }
                else -> FilledTonalButton(onClick = model::retry) { Text("Retry") }
            }
        }
    }
}
