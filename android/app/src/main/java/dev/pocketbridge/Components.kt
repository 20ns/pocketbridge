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
import androidx.compose.material.icons.filled.Check
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
import androidx.compose.foundation.Image
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import kotlinx.coroutines.delay
import org.json.JSONObject

/** Where a page's list may draw: the app bar's collapse connection and room for the navigation bar. */
class PageInsets(val scroll: Modifier, val bottom: Dp)

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
 * A chat row passes its agent's [container] tint and [accent], drawn as a thin edge at the start.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable fun GroupRow(
    index: Int, count: Int, modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null, onClickLabel: String? = null, onLongClick: (() -> Unit)? = null, onLongClickLabel: String? = null,
    leading: (@Composable () -> Unit)? = null, trailing: (@Composable () -> Unit)? = null, supporting: (@Composable () -> Unit)? = null,
    container: Color = Pocket.colors.row, accent: Color? = null,
    headline: @Composable () -> Unit,
) {
    val click = when {
        onClick != null && onLongClick != null -> Modifier.combinedClickable(onClickLabel = onClickLabel, onClick = onClick, onLongClickLabel = onLongClickLabel, onLongClick = onLongClick)
        onClick != null -> Modifier.clickable(onClickLabel = onClickLabel, onClick = onClick)
        else -> Modifier
    }
    Row(
        modifier.padding(horizontal = Spacing.lg).padding(bottom = if (index < count - 1) Spacing.xxs else 0.dp).fillMaxWidth()
            .clip(groupShape(index, count)).background(container)
            .then(if (accent == null) Modifier else Modifier.drawBehind { drawRect(accent, size = Size(Sizes.agentEdge.toPx(), size.height)) })
            .then(click).heightIn(min = 64.dp)
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

/** One menu row: label, optional one-line detail, a check on the current choice. */
@Composable fun MenuChoice(label: String, detail: String = "", selected: Boolean, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    DropdownMenuItem(
        text = {
            Column(Modifier.padding(vertical = Spacing.xs), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                Text(label, style = MaterialTheme.typography.bodyLarge, color = if (selected) colors.primary else colors.onSurface)
                if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
            }
        },
        onClick = onClick,
        trailingIcon = { if (selected) Icon(Icons.Default.Check, "Selected", tint = colors.primary) },
        modifier = Modifier.padding(horizontal = Spacing.xs).clip(RoundedCornerShape(Corners.groupInner * 3)).then(if (selected) Modifier.background(colors.secondaryContainer.copy(alpha = 0.6f)) else Modifier),
    )
}

/** A small dot in the agent's colour, before a chat's folder in the conversation header. */
@Composable fun AgentDot(agent: String?, modifier: Modifier = Modifier) {
    Box(modifier.size(Sizes.agentDot).background(agentColors(agent).accent, CircleShape))
}

/**
 * A project's own logo when the Mac found one, otherwise its first letter on a colour picked from its id. The logo
 * loads off the main thread and is cached on disk by version tag; the letter shows until it's ready.
 */
@Composable fun ProjectAvatar(model: BridgeModel, project: JSONObject?, size: Dp = Sizes.tile) {
    val id = project?.optString("id").orEmpty()
    val tag = project?.textOrNull("icon")
    val name = project?.optString("name").orEmpty()
    val shape = RoundedCornerShape(if (size < Sizes.tile) Corners.groupInner * 2 else Corners.groupInner * 3)
    val px = with(LocalDensity.current) { size.roundToPx() }
    val key = "p:$id:$tag@$px"
    // Seeded from memory so a logo already seen doesn't flash its letter first.
    // A dropped fetch tries again a few times, and again when the Mac comes back; a project without a logo costs nothing.
    val icon by produceState(tag?.let { model.images.cached(key) }, key, model.online) {
        if (value != null || tag == null) return@produceState
        repeat(3) { attempt ->
            value = model.images.load(key, px) { model.details.iconFile(id, tag) }
            if (value != null) return@produceState
            delay(30_000L * (attempt + 1))
        }
    }
    val colors = projectColors(id)
    Box(Modifier.size(size).clip(shape).background(if (icon != null) MaterialTheme.colorScheme.surfaceContainerLow else colors.container), contentAlignment = Alignment.Center) {
        val logo = icon
        if (logo != null) Image(logo.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
        else Text(
            name.firstOrNull { it.isLetterOrDigit() }?.uppercase() ?: "#", color = colors.content,
            style = if (size < Sizes.tile) MaterialTheme.typography.labelLarge else MaterialTheme.typography.titleMedium,
        )
    }
}

/** Minute-resolution clock so relative times stay true while the list is open. */
@Composable fun rememberNow(): Long {
    val now by produceState(System.currentTimeMillis()) { while (true) { delay(30_000); value = System.currentTimeMillis() } }
    return now
}

fun relativeTime(time: Long, now: Long): String =
    if (now - time < DateUtils.MINUTE_IN_MILLIS) "Now"
    else DateUtils.getRelativeTimeSpanString(time, now, DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE or DateUtils.FORMAT_ABBREV_MONTH).toString()

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
