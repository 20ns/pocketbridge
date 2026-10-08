package dev.pocketbridge

import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlin.coroutines.cancellation.CancellationException
import org.json.JSONArray
import org.json.JSONObject

const val MAX_ATTACHMENTS = 8

enum class UploadState { Uploading, Ready, Failed }

/**
 * An image in the composer: the downscaled JPEG on this phone and, once the Mac has it, its upload id. Saved per chat
 * so a picked screenshot survives process death; one without an upload id comes back as Failed with Retry.
 */
data class Attachment(
    val key: String, val file: String, val upload: String = "", val state: UploadState = if (upload.isEmpty()) UploadState.Failed else UploadState.Ready,
    /** Still being downscaled: there's no file to show yet. Not saved; a restart finds the file or a failure. */
    val preparing: Boolean = false,
)

fun encodeAttachments(list: List<Attachment>): String =
    JSONArray(list.map { JSONObject().put("key", it.key).put("file", it.file).put("upload", it.upload) }).toString()

fun decodeAttachments(value: String): List<Attachment> = if (value.isBlank()) emptyList() else runCatching {
    JSONArray(value).objects().mapNotNull { item ->
        val key = item.optString("key").takeIf { it.isNotBlank() } ?: return@mapNotNull null
        Attachment(key, item.optString("file"), item.optString("upload"))
    }
}.getOrDefault(emptyList())

/** Send needs text, a paste or an image, and every image already on the Mac: nothing is dropped silently. */
fun canSendDraft(text: String, attachments: List<Attachment>, pastes: List<Paste> = emptyList()) =
    attachments.all { it.state == UploadState.Ready } && (text.isNotBlank() || pastes.any { it.text.isNotBlank() } || attachments.isNotEmpty())

/** Where shared images can go: chats working now, recent chats, then a new chat in a recently used project. */
data class ShareTargets(val active: List<JSONObject>, val recent: List<JSONObject>, val projects: List<JSONObject>)

fun shareTargets(chats: List<JSONObject>, projects: List<JSONObject>, recentChats: Int = 6, recentProjects: Int = 4): ShareTargets {
    val known = projects.map { it.optString("id") }.toSet()
    val live = chats.filter { it.optString("projectId") in known }
    val active = live.filter { isWorking(it.optString("status")) }
    val recent = live.filter { !isWorking(it.optString("status")) }.sortedByDescending { it.optLong("updatedAt") }.take(recentChats)
    val newest = live.groupBy { it.optString("projectId") }.mapValues { (_, list) -> list.maxOf { it.optLong("updatedAt") } }
    val ordered = projects.sortedByDescending { maxOf(it.optLong("lastUsedAt"), newest[it.optString("id")] ?: 0) }.take(recentProjects)
    return ShareTargets(active, recent, ordered)
}

/**
 * "Send to" for images shared from another app: a compact panel from the bottom, like the model panel, over a scrim.
 * Picking a chat opens it with the images attached and uploading. Back or the scrim cancels.
 */
@Composable fun SharePanel(model: BridgeModel) {
    val visible = model.sharing || model.shared.isNotEmpty()
    Box(Modifier.fillMaxSize()) {
        RisingPanel(visible, model::cancelShare, "Cancel sharing", Modifier.navigationBarsPadding(), maxFraction = 0.6f) { ShareList(model) }
    }
}

@Composable private fun ShareList(model: BridgeModel) {
    val targets = remember(model.chats, model.projects) { shareTargets(model.chats, model.projects) }
    val ready = model.shared.isNotEmpty()
    val density = LocalDensity.current
    val colors = MaterialTheme.colorScheme
    Column {
        Row(Modifier.fillMaxWidth().padding(start = Spacing.xl, end = Spacing.lg, top = Spacing.lg, bottom = Spacing.xs), verticalAlignment = Alignment.CenterVertically) {
            Text("Send to", Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleMedium)
            if (!ready) CircularProgressIndicator(Modifier.size(Sizes.smallIcon), strokeWidth = 2.dp)
            else Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                model.shared.take(3).forEach { path ->
                    Surface(shape = RoundedCornerShape(Corners.groupInner * 2), border = BorderStroke(1.dp, Pocket.colors.composerBorder)) {
                        LocalImage(model, path, with(density) { Sizes.tile.roundToPx() }, Modifier.size(Sizes.pill), description = null)
                    }
                }
            }
            if (ready) Text(plural(model.shared.size, "image"), Modifier.padding(start = Spacing.md), style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
        }
        LazyColumn(Modifier.fillMaxWidth(), contentPadding = PaddingValues(start = Spacing.sm, end = Spacing.sm, bottom = Spacing.sm)) {
            if (targets.active.isNotEmpty()) {
                item(key = "active") { ShareLabel("Active") }
                items(targets.active, key = { "a:" + it.optString("id") }) { chat ->
                    ShareRow(chat.optString("title").ifBlank { "New chat" }, projectName(model, chat.optString("projectId")) + " · " + statusLabel(chat.optString("status")), ready) { model.shareTo(chat.optString("id"), chat.optString("projectId")) }
                }
            }
            if (targets.recent.isNotEmpty()) {
                item(key = "recent") { ShareLabel("Recent") }
                items(targets.recent, key = { "r:" + it.optString("id") }) { chat ->
                    ShareRow(chat.optString("title").ifBlank { "New chat" }, projectName(model, chat.optString("projectId")), ready) { model.shareTo(chat.optString("id"), chat.optString("projectId")) }
                }
            }
            if (targets.projects.isNotEmpty()) {
                item(key = "new") { ShareLabel("New chat") }
                items(targets.projects, key = { "p:" + it.optString("id") }) { project ->
                    ShareRow("New chat in " + project.optString("name"), compactPath(project.optString("path")), ready, newChat = true) { model.shareTo(null, project.optString("id")) }
                }
            }
            if (targets.active.isEmpty() && targets.recent.isEmpty() && targets.projects.isEmpty()) item(key = "none") {
                Text("No projects yet. Use Claude Code or Codex in a folder on your Mac first.", Modifier.padding(Spacing.md), style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
            }
        }
    }
}

@Composable private fun ShareLabel(text: String) {
    Text(text, Modifier.padding(start = Spacing.md, end = Spacing.md, top = Spacing.md, bottom = Spacing.xs).semantics { heading() }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
}

@Composable private fun ShareRow(title: String, detail: String, enabled: Boolean, newChat: Boolean = false, onPick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Corners.groupOuter - Spacing.xs)).clickable(enabled, onClickLabel = "Attach here", onClick = onPick)
            .heightIn(min = 56.dp).padding(horizontal = Spacing.md, vertical = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = if (newChat) colors.primary else colors.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
