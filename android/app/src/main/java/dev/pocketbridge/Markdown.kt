package dev.pocketbridge

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

// Chat Markdown only: blocks Claude and Codex commonly write. Raw HTML is shown as text and only web links open.
sealed interface Block
data class Heading(val level: Int, val text: String) : Block
data class Paragraph(val text: String) : Block
data class Bullet(val marker: String, val text: String, val depth: Int) : Block
data class Quote(val text: String) : Block
data class Code(val language: String, val text: String) : Block
enum class ColumnAlign { Start, Center, End }
data class Table(val rows: List<List<String>>, val align: List<ColumnAlign> = emptyList()) : Block
data object Rule : Block

private val fence = Regex("^\\s*(```+|~~~+)\\s*([\\w+#.-]*).*$")
private val heading = Regex("^\\s{0,3}(#{1,6})\\s+(.*?)(?:\\s+#+)?\\s*$")
private val item = Regex("^(\\s*)([-*+]|\\d{1,3}[.)])\\s+(.*)$")
private val rule = Regex("^\\s{0,3}([-*_])(\\s*\\1){2,}\\s*$")
private val cellBreak = Regex("(?<!\\\\)\\|")
private val divider = Regex("^\\s*\\|?\\s*:?-+:?\\s*(\\|\\s*:?-+:?\\s*)*\\|?\\s*$")

private fun cells(line: String) = line.trim().removePrefix("|").removeSuffix("|").split(cellBreak).map { it.trim().replace("\\|", "|") }
private fun alignment(cell: String) = when {
    cell.startsWith(":") && cell.endsWith(":") -> ColumnAlign.Center
    cell.endsWith(":") -> ColumnAlign.End
    else -> ColumnAlign.Start
}

fun parseMarkdown(text: String): List<Block> {
    val lines = text.replace("\r\n", "\n").split('\n')
    val blocks = mutableListOf<Block>()
    val paragraph = mutableListOf<String>()
    // Indents of the open list levels: an item nests one level when indented at least two past its parent.
    val listIndents = mutableListOf<Int>()
    fun flush() { if (paragraph.isNotEmpty()) { blocks += Paragraph(paragraph.joinToString("\n")); paragraph.clear() } }
    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        val open = fence.matchEntire(line)
        val title = heading.matchEntire(line)
        val listItem = item.matchEntire(line)
        when {
            open != null -> {
                flush()
                val marker = open.groupValues[1]
                val indent = line.length - line.trimStart().length
                val code = mutableListOf<String>()
                fun closes(candidate: String) = candidate.trim().let { it.startsWith(marker) && it.all { c -> c == marker[0] } }
                // A fence still streaming in has no closing marker yet; show what has arrived.
                // Fences inside list items are indented; the code itself starts at the fence's column.
                while (++i < lines.size && !closes(lines[i])) code += lines[i].drop(lines[i].takeWhile { it == ' ' }.length.coerceAtMost(indent))
                blocks += Code(open.groupValues[2], code.joinToString("\n").trimEnd())
            }
            line.isBlank() -> flush()
            rule.matches(line) -> { flush(); blocks += Rule }
            title != null -> { flush(); blocks += Heading(title.groupValues[1].length, title.groupValues[2]) }
            '|' in line && i + 1 < lines.size && '-' in lines[i + 1] && divider.matches(lines[i + 1]) -> {
                flush()
                val rows = mutableListOf(cells(line))
                val align = cells(lines[++i]).map(::alignment)
                while (i + 1 < lines.size && '|' in lines[i + 1] && lines[i + 1].isNotBlank()) rows += cells(lines[++i])
                blocks += Table(rows, align)
            }
            listItem != null -> {
                flush()
                val marker = listItem.groupValues[2].let { if (it[0].isDigit()) it.dropLast(1) + "." else "•" }
                val indent = listItem.groupValues[1].replace("\t", "    ").length
                if (blocks.lastOrNull() !is Bullet) listIndents.clear()
                while (listIndents.isNotEmpty() && indent < listIndents.last()) listIndents.removeAt(listIndents.lastIndex)
                if (listIndents.isEmpty() || indent >= listIndents.last() + 2) listIndents += indent
                blocks += Bullet(marker, listItem.groupValues[3], (listIndents.size - 1).coerceAtMost(3))
            }
            line.trimStart().startsWith(">") -> {
                flush()
                val quoted = line.trimStart().removePrefix(">").trim()
                val last = blocks.lastOrNull()
                if (last is Quote && lines[i - 1].trimStart().startsWith(">")) blocks[blocks.lastIndex] = Quote(last.text + "\n" + quoted) else blocks += Quote(quoted)
            }
            // Indented text right after a list item continues that item.
            paragraph.isEmpty() && line.startsWith("  ") && blocks.lastOrNull() is Bullet && lines[i - 1].isNotBlank() -> {
                val last = blocks.last() as Bullet
                blocks[blocks.lastIndex] = last.copy(text = last.text + " " + line.trim())
            }
            else -> paragraph += line.trimEnd()
        }
        i++
    }
    flush()
    return blocks
}

/** Space above [block], in dp: headings open a section, list items stay together, everything else gets a paragraph break. */
fun blockGap(previous: Block?, block: Block): Int = when {
    previous == null -> 0
    block is Heading -> if (block.level <= 2) 22 else 18
    previous is Heading -> 6
    previous is Bullet && block is Bullet -> if (block.depth > previous.depth) 4 else 6
    else -> 12
}

// Groups: 1 code, 2-3 bold, 4 italic, 5 strike, 6-7 link, 8 bare URL. Underscore bold needs word edges so __init__ stays a name.
private val inlineToken = Regex(
    "`([^`\\n]+)`|\\*\\*(?=\\S)(.+?)(?<=\\S)\\*\\*|(?<![\\w_])__(?=\\S)((?:(?!__).)+?)(?<=\\S)__(?![\\w_]|\\.\\w)|(?<![\\w*])\\*(?=\\S)([^*\\n]+?)(?<=\\S)\\*(?![\\w*])" +
        "|~~(?=\\S)(.+?)(?<=\\S)~~|\\[([^\\]\\n]+)]\\(([^)\\s]+)\\)|(https?://[^\\s<>()]*[^\\s<>().,;:!?'\"])",
)
private val webAddress = Regex("^https?://\\S+$")
/** A file Claude links by relative path, e.g. [Api.kt](android/Api.kt:12). Shown as code; it can't open on a phone. */
private val fileLabel = Regex("^[\\w./~-]*\\w\\.\\w{1,8}(:\\d+(-\\d+)?)?$|^[\\w.~-]*/[\\w./-]+$")

class InlineStyles(val code: SpanStyle, val link: TextLinkStyles)

fun inlineMarkdown(text: String, styles: InlineStyles): AnnotatedString = buildAnnotatedString { appendInline(text, styles) }

private fun AnnotatedString.Builder.appendInline(text: String, styles: InlineStyles) {
    var end = 0
    for (match in inlineToken.findAll(text)) {
        append(text.substring(end, match.range.first))
        val g = match.groups
        when {
            g[1] != null -> withStyle(styles.code) { append(g[1]!!.value) }
            g[2] != null || g[3] != null -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { appendInline((g[2] ?: g[3])!!.value, styles) }
            g[4] != null -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { appendInline(g[4]!!.value, styles) }
            g[5] != null -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { appendInline(g[5]!!.value, styles) }
            // Only web addresses open. Relative file links keep their label, styled as code when it names a file.
            g[6] != null -> when {
                webAddress.matches(g[7]!!.value) -> withLink(LinkAnnotation.Url(g[7]!!.value, styles.link)) { append(g[6]!!.value) }
                fileLabel.matches(g[6]!!.value) -> withStyle(styles.code) { append(g[6]!!.value) }
                else -> appendInline(g[6]!!.value, styles)
            }
            else -> withLink(LinkAnnotation.Url(g[8]!!.value, styles.link)) { append(g[8]!!.value) }
        }
        end = match.range.last + 1
    }
    append(text.substring(end))
}

@Composable fun rememberInlineStyles(): InlineStyles {
    val primary = MaterialTheme.colorScheme.primary
    val chip = Pocket.colors.inlineCode
    return remember(primary, chip) {
        InlineStyles(
            code = SpanStyle(fontFamily = FontFamily.Monospace, fontSize = 0.88.em, background = chip, letterSpacing = 0.sp),
            link = TextLinkStyles(SpanStyle(color = primary, textDecoration = TextDecoration.Underline)),
        )
    }
}

/** Selectable formatted text. [style] is the paragraph style; headings, code and tables derive their own. */
@Composable fun Markdown(text: String, modifier: Modifier = Modifier, style: TextStyle = MaterialTheme.typography.reading) {
    val blocks = remember(text) { parseMarkdown(text) }
    val styles = rememberInlineStyles()
    val type = MaterialTheme.typography
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val bar = MaterialTheme.colorScheme.outlineVariant
    SelectionContainer(modifier) {
        Column {
            blocks.forEachIndexed { index, block ->
                val top = Modifier.padding(top = blockGap(blocks.getOrNull(index - 1), block).dp)
                when (block) {
                    is Heading -> Text(
                        inlineMarkdown(block.text, styles), top.semantics { heading() },
                        style = type.heading(block.level), color = if (block.level >= 4) muted else Color.Unspecified,
                    )
                    is Paragraph -> Text(inlineMarkdown(block.text, styles), top, style = style)
                    is Bullet -> Row(top.padding(start = (block.depth * 22).dp)) {
                        val ordered = block.marker[0].isDigit()
                        Text(
                            if (ordered) block.marker else bulletGlyph(block.depth), Modifier.widthIn(min = Spacing.xl),
                            style = style.copy(fontFeatureSettings = "tnum", textAlign = if (ordered) TextAlign.End else TextAlign.Center),
                            color = muted,
                        )
                        Spacer(Modifier.width(Spacing.sm))
                        Text(inlineMarkdown(block.text, styles), style = style)
                    }
                    is Quote -> Text(
                        inlineMarkdown(block.text, styles),
                        top.drawBehind { drawRoundRect(bar, size = Size(3.dp.toPx(), size.height), cornerRadius = CornerRadius(1.5.dp.toPx())) }.padding(start = Spacing.lg),
                        style = style, color = muted,
                    )
                    is Code -> CodeBlock(block.text, top, language = block.language)
                    is Table -> TableBlock(block, styles, top)
                    Rule -> HorizontalDivider(top.padding(vertical = Spacing.sm), color = bar)
                }
            }
        }
    }
}

private fun bulletGlyph(depth: Int) = when (depth % 3) { 0 -> "•"; 1 -> "◦"; else -> "▪" }

/** Code with its language, Copy, highlighting and diff line tints. Wide code scrolls sideways unless [wrap]ped. */
@Composable fun CodeBlock(code: String, modifier: Modifier = Modifier, language: String = "", wrap: Boolean = false, label: String = languageLabel(language)) {
    val pocket = Pocket.colors
    val highlighted = rememberHighlighted(code, language)
    val diff = remember(code, language) { if (isDiff(language, code)) diffLines(code) else emptyList() }
    Surface(modifier.fillMaxWidth(), color = pocket.code, shape = RoundedCornerShape(Corners.code), border = BorderStroke(1.dp, pocket.codeBorder)) {
        Column {
            Row(Modifier.fillMaxWidth().background(pocket.codeHeader).padding(start = Spacing.lg, end = Spacing.xs), verticalAlignment = Alignment.CenterVertically) {
                Text(label, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                CopyButton(code, "Copy code")
            }
            HorizontalDivider(color = pocket.codeBorder)
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val viewport = maxWidth
                var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
                val added = pocket.syntax.addedLine
                val removed = pocket.syntax.removedLine
                val text = Modifier
                    .widthIn(min = viewport)
                    .drawBehind {
                        val result = layout ?: return@drawBehind
                        val pad = Spacing.md.toPx()
                        diff.forEach { line ->
                            val top = result.getLineTop(result.getLineForOffset(line.start)) + pad
                            val bottom = result.getLineBottom(result.getLineForOffset(line.end)) + pad
                            drawRect(if (line.added) added else removed, Offset(0f, top), Size(size.width, bottom - top))
                        }
                    }
                    .padding(horizontal = Spacing.lg, vertical = Spacing.md)
                Text(
                    highlighted,
                    if (wrap) text else Modifier.horizontalScroll(rememberScrollState()).then(text),
                    style = MaterialTheme.typography.code, color = MaterialTheme.colorScheme.onSurface, softWrap = wrap, onTextLayout = { layout = it },
                )
            }
        }
    }
}

/** A labelled Copy action that confirms in place. */
@Composable fun CopyButton(text: String, description: String, modifier: Modifier = Modifier) {
    val clipboard = LocalClipboardManager.current
    val haptics = rememberHaptics()
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { delay(1600); copied = false } }
    TextButton(
        onClick = { clipboard.setText(AnnotatedString(text)); haptics.perform(Haptic.Confirm); copied = true },
        modifier.semantics { contentDescription = if (copied) "Copied" else description }, contentPadding = PaddingValues(horizontal = Spacing.md),
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant),
    ) {
        Icon(if (copied) Icons.Default.Check else PocketIcons.Copy, null, Modifier.size(16.dp))
        Spacer(Modifier.width(Spacing.xs + Spacing.xxs))
        Text(if (copied) "Copied" else "Copy", style = MaterialTheme.typography.labelMedium)
    }
}

/** A real grid: columns size to their widest cell (wrapping past a cap), honour :--: alignment and scroll sideways. */
@Composable private fun TableBlock(table: Table, styles: InlineStyles, modifier: Modifier) {
    val rows = table.rows
    val columns = rows.maxOf { it.size }
    val pocket = Pocket.colors
    val line = pocket.codeBorder
    val type = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum")
    Surface(modifier, color = pocket.code, shape = RoundedCornerShape(Corners.code), border = BorderStroke(1.dp, line)) {
        Layout(
            content = {
                rows.forEachIndexed { r, row ->
                    repeat(columns) { c ->
                        val align = when (table.align.getOrNull(c)) { ColumnAlign.Center -> TextAlign.Center; ColumnAlign.End -> TextAlign.End; else -> TextAlign.Start }
                        Text(
                            inlineMarkdown(row.getOrNull(c).orEmpty(), styles),
                            Modifier
                                .then(if (r == 0) Modifier.background(pocket.codeHeader) else Modifier)
                                .drawBehind { if (r < rows.lastIndex) drawLine(line, Offset(0f, size.height), Offset(size.width, size.height), 1.dp.toPx()) }
                                .padding(horizontal = Spacing.md, vertical = Spacing.sm + Spacing.xxs),
                            style = type.copy(textAlign = align), fontWeight = if (r == 0) FontWeight.SemiBold else null,
                        )
                    }
                }
            },
            modifier = Modifier.horizontalScroll(rememberScrollState()),
        ) { cells, _ ->
            val cap = 260.dp.roundToPx()
            val widths = IntArray(columns) { c -> rows.indices.maxOf { r -> cells[r * columns + c].maxIntrinsicWidth(Constraints.Infinity).coerceAtMost(cap) } }
            val heights = IntArray(rows.size) { r -> (0 until columns).maxOf { c -> cells[r * columns + c].minIntrinsicHeight(widths[c]) } }
            val placed = cells.mapIndexed { i, cell -> cell.measure(Constraints.fixed(widths[i % columns], heights[i / columns])) }
            layout(widths.sum(), heights.sum()) {
                var y = 0
                rows.indices.forEach { r ->
                    var x = 0
                    repeat(columns) { c -> placed[r * columns + c].place(x, y); x += widths[c] }
                    y += heights[r]
                }
            }
        }
    }
}

