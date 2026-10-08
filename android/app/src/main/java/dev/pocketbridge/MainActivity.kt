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
import androidx.compose.foundation.lazy.LazyListState
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

/** The launcher shortcut's action (res/xml/shortcuts.xml). */
const val ACTION_NEW_CHAT = "dev.pocketbridge.NEW_CHAT"

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
    override fun onResume() { super.onResume(); model.updates.resume() }
    // On screen, the app's own connection shows everything; closed with work running, the alerts service takes over.
    override fun onStart() { super.onStart(); Alerts.stop(this) }
    // A rotation is not leaving: an open Undo window survives it; really leaving ends it now.
    override fun onStop() { super.onStop(); if (!isChangingConfigurations) { model.leaving(); model.startAlerts() } }

    /** A pairing link, images shared from another app, or a tapped notification. */
    private fun handle(intent: Intent) = when (intent.action) {
        Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> model.receiveShare(sharedImages(intent))
        Alerts.ACTION_OPEN -> intent.getStringExtra(Alerts.EXTRA_CHAT)?.let(model::openFromAlert) ?: Unit
        ACTION_NEW_CHAT -> model.requestNewChat()
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
/** What a page shows. A page that is leaving keeps its own project, so it doesn't redraw empty while it animates away. */
private data class Destination(val screen: Screen, val project: String)

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
    var newChat by rememberSaveable { mutableStateOf(false) }
    // The open project survives a restart too, so the app reopens where it was left.
    var project by rememberSaveable { mutableStateOf(model.chat?.optString("projectId") ?: model.uiSetting("project")) }
    LaunchedEffect(project) { model.saveUiSetting("project", project) }
    // A project removed on the Mac closes its list once the Mac has answered.
    LaunchedEffect(model.projects, project) { if (project.isNotEmpty() && model.projects.isNotEmpty() && model.projects.none { it.optString("id") == project }) project = "" }
    // Back lands where each list was left: Projects, and every project's chats.
    val positions = rememberSaveable(saver = ListPositions.Saver) { ListPositions() }
    // An open chat always belongs to the list Back returns to, including after a restart.
    val chatProject = model.chat?.optString("projectId")
    LaunchedEffect(chatProject) { if (!chatProject.isNullOrEmpty()) project = chatProject }
    LaunchedEffect(model.paired) { if (!model.paired) { settings = false; project = ""; usage = false; newChat = false } }
    // The launcher's New chat shortcut: Projects with the panel open.
    LaunchedEffect(model.newChatRequested) { if (model.newChatRequested) { settings = false; usage = false; project = ""; newChat = true; model.newChatShown() } }
    // A picked project opens its draft; the panel's job is done.
    LaunchedEffect(model.selected) { if (model.selected.isNotEmpty()) newChat = false }
    // The model panel belongs to one chat and closes once its choices lock.
    LaunchedEffect(model.selected, model.pending) { if (model.pending != null || model.selected.isEmpty()) models = false }
    // A notification or a share chose a chat: show it over whatever was open.
    LaunchedEffect(model.showChat) { if (model.showChat) { settings = false; usage = false; models = false; model.chatShown() } }
    // Asked once, on the first send, so a turn can report back after the app closes.
    val askAlerts = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { model.alertsAsked(it) }
    LaunchedEffect(model.askAlerts) { if (model.askAlerts && Build.VERSION.SDK_INT >= 33) askAlerts.launch(Manifest.permission.POST_NOTIFICATIONS) }
    // Leaving a chat shows the list first and closes the chat once its page has animated away, so it never redraws empty.
    var closing by remember { mutableStateOf("") }
    val screen = when {
        !model.paired -> Screen.Pair
        settings -> Screen.Settings
        model.selected.isNotEmpty() && model.selected != closing -> Screen.Chat
        project.isNotEmpty() -> Screen.Chats
        else -> Screen.Projects
    }
    val back: () -> Unit = {
        when (screen) {
            Screen.Settings -> settings = false
            Screen.Chat -> closing = model.selected
            Screen.Chats -> project = ""
            else -> Unit
        }
    }

    // The back arrow and the system gesture do the same; during the gesture the page follows the finger, like Android's own back preview.
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
    LaunchedEffect(model.notice) {
        if (model.notice.isNotEmpty()) { snackbar.showSnackbar(model.notice, duration = SnackbarDuration.Short); model.clearNotice() }
    }
    val haptics = rememberHaptics()
    LaunchedEffect(model.error, model.paired) {
        if (model.paired && model.error.isNotEmpty()) { haptics.perform(Haptic.Reject); snackbar.showSnackbar(model.error, withDismissAction = true, duration = SnackbarDuration.Long); model.clearError() }
    }
    // Deleting is undoable for a few seconds; the Mac deletes the chat once this snackbar goes.
    LaunchedEffect(model.deleting) {
        if (model.deleting == null) return@LaunchedEffect
        snackbar.currentSnackbarData?.dismiss()
        val result = snackbar.showSnackbar("Chat deleted", actionLabel = "Undo", duration = SnackbarDuration.Long)
        if (result == SnackbarResult.ActionPerformed) model.undoDelete() else model.commitDeletion()
    }

    val scope = rememberCoroutineScope()
    // One image viewer over every screen, opened from prompts and the composer.
    var viewer by remember { mutableStateOf<Pair<List<String>, Int>?>(null) }
    LaunchedEffect(model.selected) { viewer = null }
    // The composer's message or one of its pastes, full screen. It belongs to the open chat and closes with it.
    var editing by rememberSaveable(model.selected) { mutableStateOf<String?>(null) }
    CompositionLocalProvider(LocalImageViewer provides { ids, index -> viewer = ids to index }, LocalTextEditor provides { editing = it }) {
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerHighest)) {
        AnimatedContent(
            Destination(screen, project),
            contentKey = { it.screen },
            transitionSpec = {
                // Shared axis: the new page slides a little from the side it belongs to while the old one makes way.
                val direction = if (targetState.screen.depth >= initialState.screen.depth) 1 else -1
                (slideInHorizontally(Motion.spatial(IntOffset.VisibilityThreshold)) { width -> direction * width / 10 } + fadeIn(tween(210, delayMillis = 60, easing = Motion.Emphasized))) togetherWith
                    (slideOutHorizontally(Motion.spatial(IntOffset.VisibilityThreshold)) { width -> -direction * width / 14 } + fadeOut(tween(90)))
            },
            label = "screen",
        ) { destination ->
            val target = destination.screen
            // The page a gesture sent away keeps its shrink only while it leaves; the next change of page starts flat.
            if (target == screen) {
                val settled = transition.currentState == transition.targetState
                LaunchedEffect(settled) {
                    if (!settled) return@LaunchedEffect
                    leavingProgress = 0f
                    if (closing.isNotEmpty()) { if (model.selected == closing) model.open(""); closing = "" }
                }
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
                            IconButton(onClick = { newChat = true }, enabled = model.projects.isNotEmpty() || model.experiments.isNotEmpty()) { Icon(Icons.Default.Add, "New chat") }
                            UsageMeter(model) { usage = true }
                            IconButton(onClick = { settings = true }) { Icon(Icons.Default.Settings, "Settings") }
                        },
                        dimTop = newChat, onDimTop = { newChat = false },
                        overlay = {
                            NewChatPanel(model, newChat, { newChat = false }) { id ->
                                val blocked = newChatBlocked(model, id)
                                if (blocked != null) scope.launch { snackbar.currentSnackbarData?.dismiss(); snackbar.showSnackbar(blocked) }
                                else { project = id; model.newChat(id) }
                            }
                        },
                    ) { insets -> Projects(model, insets, positions.of("projects"), onOpenProject = { project = it }, onOpenChat = { chat -> project = chat.optString("projectId"); model.open(chat.optString("id")) }) }
                    Screen.Chats -> ChatsPage(model, snackbar, destination.project, positions.of("chats:${destination.project}"), onBack = back, onSettings = { settings = true })
                    Screen.Settings -> Page(model, snackbar, title = "Settings", onBack = back) { insets -> Settings(model, insets) }
                    Screen.Chat -> Page(
                        model, snackbar, title = model.chat?.optString("title")?.ifBlank { null } ?: "New chat", onBack = back,
                        // The folder under the title, with a dot in the agent's colour, so it's clear where and with what.
                        subtitle = model.chat?.let { chat ->
                            {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    AgentDot(model.options.agent)
                                    Spacer(Modifier.width(Spacing.xs + Spacing.xxs))
                                    Text(projectName(model, chat.optString("projectId")), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                        },
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
        editing?.let { TextEditor(model, snackbar, it) { editing = null } }
        viewer?.let { (ids, index) -> ImageViewer(model, ids, index) { viewer = null } }
    }
    }
    if (usage && screen == Screen.Projects) UsageSheet(model) { usage = false }
    if (model.paired) SharePanel(model)
}

@Composable private fun ChatsPage(model: BridgeModel, snackbar: SnackbarHostState, project: String, list: LazyListState, onBack: () -> Unit, onSettings: () -> Unit) {
    var sort by remember { mutableStateOf(ChatSort.entries.find { it.name == model.uiSetting("chatSort") } ?: ChatSort.Newest) }
    // The button shrinks to its icon once the list scrolls, leaving titles readable underneath.
    val extended by remember { derivedStateOf { list.firstVisibleItemIndex == 0 } }
    val info = model.projects.find { it.optString("id") == project }
    Page(
        model, snackbar, title = projectName(model, project), onBack = onBack, onSettings = onSettings,
        leading = { ProjectAvatar(model, info, Sizes.headerAvatar) },
        subtitle = info?.takeUnless(::isGeneral)?.let { { Text(compactPath(it.optString("path")), maxLines = 1, overflow = TextOverflow.Ellipsis) } },
        saved = projectChats(model.chats, project, model.visibleDrafts()).isNotEmpty(),
        actions = { SortMenu(ChatSort.entries, sort, { it.label }) { sort = it; model.saveUiSetting("chatSort", it.name) } },
        fab = { NewChatButton(model, project, snackbar, extended) },
    ) { insets -> Chats(model, project, sort, list, insets) }
}

@Composable private fun ConversationMenu(model: BridgeModel) {
    val chat = model.chat ?: return
    val id = chat.optString("id")
    val local = model.chats.none { it.optString("id") == id }
    if (local && model.pending != null) return
    val working = isWorking(chat.optString("status"))
    var menu by remember { mutableStateOf(false) }
    var rename by remember { mutableStateOf(false) }
    val title = chat.optString("title").ifBlank { "New chat" }
    Box {
        IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "Chat actions") }
        val desktop = if (local || chat.optString("agent").ifBlank { "claude" } != "claude") null else ({ model.openInDesktop(id) })
        ChatMenu(menu, { menu = false }, if (local) null else ({ rename = true }), { model.deleteWithUndo(id, title) }, working, desktop)
    }
    if (rename) RenameDialog(title, { rename = false }, { model.rename(id, it); rename = false })
}

@Composable private fun NewChatButton(model: BridgeModel, project: String, snackbar: SnackbarHostState, extended: Boolean) {
    val scope = rememberCoroutineScope()
    ExtendedFloatingActionButton(
        onClick = {
            val blocked = newChatBlocked(model, project)
            if (blocked != null) scope.launch { snackbar.currentSnackbarData?.dismiss(); snackbar.showSnackbar(blocked) }
            else model.newChat(project)
        },
        expanded = extended,
        icon = { Icon(Icons.Default.Add, null) },
        text = { Text("New chat") },
    )
}

fun projectName(model: BridgeModel, id: String?) = model.projects.find { it.optString("id") == id }?.optString("name") ?: "Project removed"
