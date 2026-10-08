package dev.pocketbridge

import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import kotlin.coroutines.cancellation.CancellationException

/** The full-screen editor's target: the composer's typed text, or a pasted block by its key. */
const val DRAFT_EDITOR = "draft"

/** Opens the full-screen editor on [DRAFT_EDITOR] or a paste key. Provided by the app shell. */
val LocalTextEditor = staticCompositionLocalOf<(String) -> Unit> { {} }

/** Large pastes above the prompt, one chip each: tap to read or edit it, the cross to remove it. */
@Composable fun PasteStrip(pastes: List<Paste>, enabled: Boolean, onRemove: (String) -> Unit) {
    val open = LocalTextEditor.current
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = Spacing.md, end = Spacing.md, top = Spacing.md),
        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        pastes.forEach { paste -> key(paste.key) { PasteChip(paste, enabled, { open(paste.key) }) { onRemove(paste.key) } } }
    }
}

@Composable private fun PasteChip(paste: Paste, enabled: Boolean, onOpen: () -> Unit, onRemove: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val size = remember(paste.text) { pasteSize(paste.text) }
    Surface(
        onClick = onOpen, enabled = enabled, shape = RoundedCornerShape(Corners.groupInner * 3), color = Pocket.colors.pill, border = BorderStroke(1.dp, Pocket.colors.composerBorder),
        modifier = Modifier.semantics { contentDescription = "Pasted text, $size" },
    ) {
        Row(Modifier.heightIn(min = Sizes.touch).padding(start = Spacing.md), verticalAlignment = Alignment.CenterVertically) {
            Icon(PocketIcons.Article, null, Modifier.size(20.dp), tint = colors.onSurfaceVariant)
            Column(Modifier.padding(start = Spacing.sm)) {
                Text("Pasted text", style = MaterialTheme.typography.labelLarge, maxLines = 1)
                Text(size, style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant, maxLines = 1)
            }
            IconButton(onClick = onRemove, enabled = enabled) { Icon(Icons.Default.Close, "Remove pasted text", Modifier.size(Sizes.smallIcon)) }
        }
    }
}

/**
 * The message, or one pasted block, full screen. Back (arrow or gesture) returns to the composer. Edits go straight
 * to the draft, one way, so the box underneath never fights the typing here. A paste left empty is removed.
 */
@Composable fun TextEditor(model: BridgeModel, snackbar: SnackbarHostState, target: String, onClose: () -> Unit) {
    val draft = target == DRAFT_EDITOR
    // A prompt on its way locks the composer, and a removed paste has nothing left to edit.
    val gone by remember(target) { derivedStateOf { model.pending != null || (!draft && model.pastes.none { it.key == target }) } }
    if (gone) { LaunchedEffect(Unit) { onClose() }; return }
    // Read once, so the edits flowing back don't recompose this screen. Not saveable: a long paste would overflow the
    // saved state; a rotation reopens it from the draft.
    val state = remember(target) { TextFieldState(Snapshot.withoutReadObservation { if (draft) model.draft else model.pastes.first { it.key == target }.text }) }
    val empty by remember(state) { derivedStateOf { state.text.isEmpty() } }
    LaunchedEffect(state) { snapshotFlow { state.text.toString() }.collect { if (draft) model.editDraft(it) else model.editPaste(target, it) } }
    val close = {
        if (draft) model.editDraft(state.text.toString())
        else if (state.text.isBlank()) model.removePaste(target) else model.editPaste(target, state.text.toString())
        onClose()
    }
    var back by remember { mutableFloatStateOf(0f) }
    PredictiveBackHandler { events ->
        try { events.collect { back = it.progress }; close() } catch (cancelled: CancellationException) { back = 0f; throw cancelled }
    }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { if (draft) runCatching { focus.requestFocus() } }
    val colors = MaterialTheme.colorScheme
    val style = MaterialTheme.typography.bodyLarge
    Box(Modifier.fillMaxSize().graphicsLayer { scaleX = 1f - 0.1f * back; scaleY = 1f - 0.1f * back; alpha = 1f - 0.3f * back }) {
        Page(
            model, snackbar, title = if (draft) "Message" else "Pasted text", onBack = close,
            subtitle = if (draft) null else ({ Text(pasteSize(state.text.toString()), maxLines = 1) }),
            actions = { if (!draft) IconButton(onClick = { model.removePaste(target); onClose() }) { Icon(Icons.Default.Delete, "Remove pasted text") } },
        ) { insets ->
            Box(Modifier.fillMaxSize().padding(bottom = insets.bottom).imePadding().padding(horizontal = Spacing.lg, vertical = Spacing.md)) {
                if (empty) Text(if (draft) "Message" else "Pasted text", style = style, color = colors.onSurfaceVariant)
                BasicTextField(
                    state, Modifier.fillMaxSize().focusRequester(focus).semantics { contentDescription = if (draft) "Message" else "Pasted text" },
                    textStyle = style.copy(color = colors.onSurface), cursorBrush = SolidColor(colors.primary),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                )
            }
        }
    }
}
