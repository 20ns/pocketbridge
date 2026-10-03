package dev.pocketbridge

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

/** The project's working tree against HEAD, as the Mac reports it. */
data class GitInfo(
    val branch: String, val detached: Boolean, val commit: String, val ahead: Int, val behind: Int, val files: Int, val added: Int, val removed: Int,
) {
    /** The branch, or the short commit when detached. */
    val head get() = branch.ifBlank { commit.ifBlank { "HEAD" } }
    val changed get() = files > 0 || added > 0 || removed > 0
}

/** Null when the folder isn't a git repository. */
fun parseGit(json: JSONObject): GitInfo? = if (!json.optBoolean("repo")) null else GitInfo(
    if (json.isNull("branch")) "" else json.optString("branch"), json.optBoolean("detached"), if (json.isNull("commit")) "" else json.optString("commit"),
    json.optInt("ahead"), json.optInt("behind"), json.optInt("files"), json.optInt("added"), json.optInt("removed"),
)

/** What TalkBack reads and the tooltip shows: every number in words. */
fun gitDescription(git: GitInfo) = buildList {
    add(if (git.detached) "Detached at ${git.head}" else "On ${git.head}")
    if (git.changed) add("${plural(git.added, "line")} added, ${git.removed} removed in ${plural(git.files, "file")}") else add("No changes")
    if (git.ahead > 0) add("${plural(git.ahead, "commit")} ahead")
    if (git.behind > 0) add("${git.behind} behind")
}.joinToString(". ")

/** A command or skill the agent offers in this project, typed as "/name". */
data class SlashCommand(val name: String, val description: String, val hint: String)

/** One row per name: the first listed wins (a project command and a skill may share one). */
fun parseCommands(json: JSONObject): List<SlashCommand> = json.optJSONArray("commands")?.objects().orEmpty().mapNotNull { command ->
    val name = command.optString("name").removePrefix("/").takeIf { it.isNotBlank() } ?: return@mapNotNull null
    SlashCommand(name, command.optString("description"), command.optString("hint"))
}.distinctBy { it.name }

/** The typed command prefix while the draft is still a bare "/word"; null once there's a space or no slash. */
fun slashQuery(draft: String): String? = if (draft.startsWith("/") && draft.none(Char::isWhitespace)) draft.drop(1) else null

/** Prefix matches first, then names containing the text, then names holding its letters in order. */
fun filterCommands(commands: List<SlashCommand>, query: String): List<SlashCommand> {
    val typed = query.lowercase()
    if (typed.isEmpty()) return commands
    fun rank(name: String): Int? {
        val lower = name.lowercase()
        return when {
            lower.startsWith(typed) -> 0
            lower.split(':', '-', '_', '.').any { it.startsWith(typed) } -> 1
            typed in lower -> 2
            inOrder(lower, typed) -> 3
            else -> null
        }
    }
    return commands.mapNotNull { command -> rank(command.name)?.let { it to command } }.sortedBy { it.first }.map { it.second }
}

private fun inOrder(text: String, letters: String): Boolean {
    var at = 0
    for (char in letters) { at = text.indexOf(char, at); if (at < 0) return false; at++ }
    return true
}

/** A Claude or Codex session in this folder that PocketBridge didn't start. */
data class MacSession(val agent: String, val id: String, val title: String, val updatedAt: Long, val preview: String)

fun parseSessions(json: JSONObject): List<MacSession> = json.optJSONArray("sessions")?.objects().orEmpty().mapNotNull { session ->
    val id = session.optString("id").takeIf { it.isNotBlank() } ?: return@mapNotNull null
    MacSession(session.optString("agent", CLAUDE), id, session.optString("title").ifBlank { "Untitled session" }, session.optLong("updatedAt"), if (session.isNull("preview")) "" else session.optString("preview"))
}

fun agentProduct(agent: String) = if (agent == CODEX) "Codex" else "Claude Code"

/**
 * One quiet line above the composer: branch, lines added and removed, files, and ahead or behind when they aren't
 * zero. Refreshes on open, after each turn and every 15 seconds while on screen; the last value stays while it loads.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable fun GitStrip(model: BridgeModel, projectId: String) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(projectId, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { while (true) { model.refreshGit(projectId); delay(15_000) } } }
    val info = model.git[projectId]
    AnimatedVisibility(info != null, enter = expandVertically(Motion.spatial(IntSize.VisibilityThreshold)) + fadeIn(Motion.effects()), exit = shrinkVertically(Motion.fastSpatial(IntSize.VisibilityThreshold)) + fadeOut(Motion.fastEffects())) {
        val git = info ?: return@AnimatedVisibility
        val colors = MaterialTheme.colorScheme
        val syntax = Pocket.colors.syntax
        val tooltip = rememberTooltipState()
        val scope = rememberCoroutineScope()
        val described = gitDescription(git)
        val label = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum")
        TooltipBox(TooltipDefaults.rememberPlainTooltipPositionProvider(), tooltip = { PlainTooltip { Text(described) } }, state = tooltip) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = Spacing.xxxl).clip(RoundedCornerShape(Corners.groupInner * 2))
                    .clickable(onClickLabel = "Show branch details") { scope.launch { tooltip.show() } }
                    .semantics(mergeDescendants = true) { contentDescription = described }
                    .padding(start = Spacing.lg + Spacing.xxs, end = Spacing.lg),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(PocketIcons.Branch, null, Modifier.size(Sizes.tinyIcon), tint = colors.onSurfaceVariant)
                Spacer(Modifier.width(Spacing.xs + Spacing.xxs))
                Text(git.head, Modifier.weight(1f, fill = false), style = label, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (git.changed) Text(
                    buildAnnotatedString {
                        append("   ")
                        withStyle(SpanStyle(color = syntax.added, fontWeight = FontWeight.SemiBold)) { append("+${git.added}") }
                        append(" ")
                        withStyle(SpanStyle(color = syntax.removed, fontWeight = FontWeight.SemiBold)) { append("\u2212${git.removed}") }
                        append("  ·  ${plural(git.files, "file")}")
                    },
                    style = label, color = colors.onSurfaceVariant, maxLines = 1,
                )
                if (git.ahead > 0 || git.behind > 0) Text(
                    listOfNotNull(git.ahead.takeIf { it > 0 }?.let { "\u2191$it" }, git.behind.takeIf { it > 0 }?.let { "\u2193$it" }).joinToString(" ", prefix = "  ·  "),
                    style = label, color = colors.onSurfaceVariant, maxLines = 1,
                )
            }
        }
    }
}

/** Places a popup's bottom edge just above its anchor, start-aligned: the "/" list sits on the composer. */
private class AboveAnchor(private val gap: Int) : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize) =
        IntOffset(anchorBounds.left, (anchorBounds.top - popupContentSize.height - gap).coerceAtLeast(0))
}

/** Commands and skills for "/": a compact list on top of the composer that never takes the keyboard's focus. */
@Composable fun SlashMenu(commands: List<SlashCommand>, loading: Boolean, width: Int, onPick: (SlashCommand) -> Unit) {
    val density = LocalDensity.current
    val position = remember(density) { AboveAnchor(with(density) { Spacing.xs.roundToPx() }) }
    val appear = remember { MutableTransitionState(false).apply { targetState = true } }
    Popup(popupPositionProvider = position, properties = PopupProperties(focusable = false)) {
        AnimatedVisibility(appear, enter = expandVertically(Motion.fastSpatial(IntSize.VisibilityThreshold), expandFrom = Alignment.Bottom) + fadeIn(Motion.effects())) {
            Surface(
                Modifier.width(with(density) { width.toDp() }).heightIn(max = 280.dp), shape = RoundedCornerShape(Corners.groupOuter),
                color = Pocket.colors.panel, contentColor = MaterialTheme.colorScheme.onSurface, shadowElevation = 8.dp, border = BorderStroke(1.dp, Pocket.colors.composerBorder),
            ) {
                LazyColumn(contentPadding = PaddingValues(Spacing.xs)) {
                    if (loading) item(key = "loading") {
                        Row(Modifier.fillMaxWidth().heightIn(min = Sizes.touch).padding(horizontal = Spacing.md), verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(Modifier.size(Sizes.tinyIcon), strokeWidth = 2.dp)
                            Spacer(Modifier.width(Spacing.md))
                            Text("Loading commands", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    items(commands, key = { "command:" + it.name }) { command -> CommandRow(command) { onPick(command) } }
                }
            }
        }
    }
}

@Composable private fun CommandRow(command: SlashCommand, onPick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Corners.groupInner * 3)).clickable(onClickLabel = "Insert command", onClick = onPick)
            .heightIn(min = Sizes.touch).padding(horizontal = Spacing.md, vertical = Spacing.sm),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs, Alignment.CenterVertically),
    ) {
        Text(
            buildAnnotatedString {
                withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = colors.onSurface)) { append("/" + command.name) }
                if (command.hint.isNotBlank()) append("  " + command.hint)
            },
            style = MaterialTheme.typography.code, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        if (command.description.isNotBlank()) Text(command.description, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
