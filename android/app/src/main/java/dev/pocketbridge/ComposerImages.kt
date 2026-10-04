package dev.pocketbridge

import androidx.activity.compose.BackHandler
import androidx.activity.compose.PredictiveBackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.foundation.ScrollState
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlin.coroutines.cancellation.CancellationException

/** Picked images above the prompt: each shows its upload, can be removed, and retries on tap when it failed. */
@Composable fun AttachmentStrip(model: BridgeModel, attachments: List<Attachment>) {
    val open = LocalImageViewer.current
    val uploaded = attachments.filter { it.state == UploadState.Ready }.map { it.upload }
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = Spacing.md, end = Spacing.md, top = Spacing.md),
        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        attachments.forEachIndexed { index, item -> key(item.key) { AttachmentTile(model, item, index, attachments.size) { uploaded.indexOf(item.upload).takeIf { it >= 0 }?.let { open(uploaded, it) } } } }
    }
}

@Composable private fun AttachmentTile(model: BridgeModel, item: Attachment, index: Int, count: Int, onView: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val size = with(LocalDensity.current) { Sizes.thumbnail.roundToPx() }
    val label = "Image ${index + 1} of $count, " + when (item.state) { UploadState.Uploading -> "uploading"; UploadState.Failed -> "didn't upload"; UploadState.Ready -> "ready" }
    // The remove mark overlaps the corner, so the tile sits inside a slightly larger box.
    Box(Modifier.size(Sizes.thumbnail + Spacing.sm)) {
        Box(
            Modifier.align(Alignment.BottomStart).size(Sizes.thumbnail).clip(RoundedCornerShape(Corners.groupInner * 3)).border(1.dp, Pocket.colors.composerBorder, RoundedCornerShape(Corners.groupInner * 3))
                .clickable(onClickLabel = if (item.state == UploadState.Failed) "Retry upload" else "View image", enabled = item.state != UploadState.Uploading) {
                    if (item.state == UploadState.Failed) model.retryAttachment(item.key) else onView()
                }
                .semantics(mergeDescendants = true) { contentDescription = label },
            contentAlignment = Alignment.Center,
        ) {
            if (item.preparing) Box(Modifier.fillMaxSize().background(colors.surfaceContainerHigh))
            else LocalImage(model, item.file, size, Modifier.fillMaxSize(), description = null)
            when (item.state) {
                UploadState.Uploading -> Box(Modifier.fillMaxSize().background(colors.scrim.copy(alpha = 0.35f)), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
                }
                UploadState.Failed -> Box(Modifier.fillMaxSize().background(colors.errorContainer.copy(alpha = 0.88f)), contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Refresh, null, Modifier.size(22.dp), tint = colors.onErrorContainer)
                }
                UploadState.Ready -> Unit
            }
        }
        Box(
            Modifier.align(Alignment.TopEnd).size(Sizes.pill - Spacing.xs).clip(CircleShape).clickable(onClickLabel = "Remove image ${index + 1}", role = Role.Button) { model.removeAttachment(item.key) },
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(20.dp).background(colors.inverseSurface, CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.Close, "Remove image ${index + 1}", Modifier.size(14.dp), tint = colors.inverseOnSurface)
            }
        }
    }
}
