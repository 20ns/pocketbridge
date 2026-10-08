package dev.pocketbridge

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/**
 * One screen frame: a compact top bar, the persistent connection banner, then content. Every screen but Projects has
 * a back arrow; the system back gesture does the same. The bar takes a container tone once its list scrolls.
 * [subtitle] sits under the title in small bold grey, like a chat's folder. [saved]: cached data to show offline.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable fun Page(
    model: BridgeModel,
    snackbar: SnackbarHostState,
    title: String,
    onBack: (() -> Unit)? = null,
    subtitle: (@Composable () -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
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
    val scroll = TopAppBarDefaults.pinnedScrollBehavior()
    Scaffold(
        topBar = {
            Box {
                TopAppBar(
                    title = { PageTitle(title, model, subtitle, leading) },
                    navigationIcon = { if (onBack != null) IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                    actions = actions, scrollBehavior = scroll,
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.surface, scrolledContainerColor = colors.surfaceContainer),
                )
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
                content(PageInsets(Modifier.nestedScroll(scroll.nestedScrollConnection), if (bottomBar != null) 0.dp else bottom))
                overlay()
            }
        }
    }
}

/** Title, then the connection pill when there's a problem; a subtitle drops the title a step so both fit the bar. */
@Composable private fun PageTitle(title: String, model: BridgeModel, subtitle: (@Composable () -> Unit)?, leading: (@Composable () -> Unit)?) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
        leading?.invoke()
        Column(Modifier.weight(1f, fill = false)) {
            Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = if (subtitle == null) MaterialTheme.typography.titleLarge else MaterialTheme.typography.titleMedium)
            if (subtitle != null) CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onSurfaceVariant) {
                ProvideTextStyle(MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Bold)) { subtitle() }
            }
        }
        ConnectionDot(model)
    }
}

/** Only a problem is worth a word. Connected stays silent; connecting, a reconnect and offline get a small labelled pill. */
@Composable fun ConnectionDot(model: BridgeModel) {
    if (model.online) return
    val colors = MaterialTheme.colorScheme
    val (label, dot) = when {
        model.connectionIssue.isNotEmpty() -> "Offline" to colors.error
        model.wasOnline -> "Reconnecting" to colors.outline
        else -> "Connecting" to colors.outline
    }
    Surface(shape = CircleShape, color = colors.surfaceContainerHigh, modifier = Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }) {
        Row(Modifier.padding(horizontal = Spacing.sm + Spacing.xxs, vertical = Spacing.xs), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(7.dp).background(dot, CircleShape))
            Spacer(Modifier.width(Spacing.xs + Spacing.xxs))
            Text(label, style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
        }
    }
}

@Composable fun ConnectionBanner(model: BridgeModel, saved: Boolean, openSettings: () -> Unit) {
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
                val phoneOffline = model.connectionIssue == NO_NETWORK
                Text(if (revoked) "Pairing removed" else if (phoneOffline) "No internet connection" else "Can't reach your Mac", style = MaterialTheme.typography.titleSmall)
                Text(
                    if (revoked) model.connectionIssue
                    else (if (phoneOffline) "Reconnects when this phone is back online." else model.connectionIssue.removePrefix("Can't reach your Mac. ")) + if (saved) " Showing saved copies." else "",
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
