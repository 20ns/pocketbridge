package dev.pocketbridge

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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import kotlinx.coroutines.delay

// Chat Markdown only: blocks Claude commonly writes. Raw HTML is shown as text and only web links open.
sealed interface Block
data class Heading(val level: Int, val text: String) : Block
data class Paragraph(val text: String) : Block
data class Bullet(val marker: String, val text: String, val depth: Int) : Block
data class Quote(val text: String) : Block
data class Code(val language: String, val text: String) : Block
data class Table(val rows: List<List<String>>) : Block
data object Rule : Block

private val fence = Regex("^\\s*(```+|~~~+)\\s*([\\w+#.-]*).*$")
private val heading = Regex("^\\s{0,3}(#{1,6})\\s+(.*?)(?:\\s+#+)?\\s*$")
private val item = Regex("^(\\s*)([-*+]|\\d{1,3}[.)])\\s+(.*)$")
private val rule = Regex("^\\s{0,3}([-*_])(\\s*\\1){2,}\\s*$")
private val cellBreak = Regex("(?<!\\\\)\\|")
private val divider = Regex("^\\s*\\|?\\s*:?-+:?\\s*(\\|\\s*:?-+:?\\s*)*\\|?\\s*$")

fun parseMarkdown(text: String): List<Block> {
    val lines = text.replace("\r\n", "\n").split('\n')
    val blocks = mutableListOf<Block>()
    val paragraph = mutableListOf<String>()
    fun flush() { if (paragraph.isNotEmpty()) { blocks += Paragraph(paragraph.joinToString("\n")); paragraph.clear() } }
    fun cells(line: String) = line.trim().removePrefix("|").removeSuffix("|").split(cellBreak).map { it.trim().replace("\\|", "|") }
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
                i++
                while (i + 1 < lines.size && '|' in lines[i + 1] && lines[i + 1].isNotBlank()) rows += cells(lines[++i])
                blocks += Table(rows)
            }
            listItem != null -> {
                flush()
                val marker = listItem.groupValues[2].let { if (it[0].isDigit()) it.dropLast(1) + "." else "•" }
                blocks += Bullet(marker, listItem.groupValues[3], (listItem.groupValues[1].replace("\t", "    ").length / 2).coerceAtMost(3))
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

// Groups: 1 code, 2-3 bold, 4 italic, 5 strike, 6-7 link, 8 bare URL. Underscore bold needs word edges so __init__ stays a name.
private val inlineToken = Regex(
    "`([^`\\n]+)`|\\*\\*(?=\\S)(.+?)(?<=\\S)\\*\\*|(?<![\\w_])__(?=\\S)((?:(?!__).)+?)(?<=\\S)__(?![\\w_]|\\.\\w)|(?<![\\w*])\\*(?=\\S)([^*\\n]+?)(?<=\\S)\\*(?![\\w*])" +
        "|~~(?=\\S)(.+?)(?<=\\S)~~|\\[([^\\]\\n]+)]\\(([^)\\s]+)\\)|(https?://[^\\s<>()]*[^\\s<>().,;:!?'\"])",
)
private val webAddress = Regex("^https?://\\S+$")

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
            // Claude links files by relative path; those show their label, and only web addresses open.
            g[6] != null -> if (webAddress.matches(g[7]!!.value)) withLink(LinkAnnotation.Url(g[7]!!.value, styles.link)) { append(g[6]!!.value) } else appendInline(g[6]!!.value, styles)
            else -> withLink(LinkAnnotation.Url(g[8]!!.value, styles.link)) { append(g[8]!!.value) }
        }
        end = match.range.last + 1
    }
    append(text.substring(end))
}

@Composable fun rememberInlineStyles(codeBackground: Color): InlineStyles {
    val colors = MaterialTheme.colorScheme
    return remember(colors, codeBackground) {
        InlineStyles(
            code = SpanStyle(fontFamily = FontFamily.Monospace, fontSize = 0.9.em, background = codeBackground),
            link = TextLinkStyles(SpanStyle(color = colors.primary, textDecoration = TextDecoration.Underline)),
        )
    }
}

/** [code] is the fill for code and tables, chosen to stand apart from whatever the text sits on. */
@Composable fun Markdown(text: String, modifier: Modifier = Modifier, code: Color = MaterialTheme.colorScheme.surfaceContainerHigh) {
    val blocks = remember(text) { parseMarkdown(text) }
    val styles = rememberInlineStyles(code)
    val type = MaterialTheme.typography
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    SelectionContainer(modifier) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            blocks.forEachIndexed { index, block ->
                when (block) {
                    is Heading -> Text(
                        inlineMarkdown(block.text, styles),
                        Modifier.padding(top = if (index == 0) 0.dp else 6.dp).semantics { heading() },
                        style = when (block.level) { 1 -> type.titleLarge; 2 -> type.titleMedium; else -> type.titleSmall },
                    )
                    is Paragraph -> Text(inlineMarkdown(block.text, styles), style = type.bodyLarge)
                    is Bullet -> Row(Modifier.padding(start = (block.depth * 18).dp)) {
                        Text(block.marker, Modifier.widthIn(min = 22.dp).padding(end = 6.dp), style = type.bodyLarge, color = muted)
                        Text(inlineMarkdown(block.text, styles), style = type.bodyLarge)
                    }
                    is Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
                        VerticalDivider(thickness = 2.dp, color = MaterialTheme.colorScheme.outlineVariant)
                        Text(inlineMarkdown(block.text, styles), Modifier.padding(start = 14.dp), style = type.bodyLarge, color = muted)
                    }
                    is Code -> CodeBlock(block.text, language = block.language, color = code)
                    is Table -> TableBlock(block.rows, styles, code)
                    Rule -> HorizontalDivider(Modifier.padding(vertical = 6.dp), color = MaterialTheme.colorScheme.outlineVariant)
                }
            }
        }
    }
}

@Composable fun CodeBlock(code: String, modifier: Modifier = Modifier, language: String = "", wrap: Boolean = false, color: Color = MaterialTheme.colorScheme.surfaceContainerHigh) {
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { delay(1800); copied = false } }
    Surface(modifier.fillMaxWidth(), color = color, shape = RoundedCornerShape(12.dp)) {
        Column {
            Row(Modifier.fillMaxWidth().padding(start = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(language, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                IconButton(onClick = { clipboard.setText(AnnotatedString(code)); copied = true }) {
                    Icon(if (copied) Icons.Default.Check else PocketIcons.Copy, if (copied) "Copied" else "Copy code", Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Text(
                code,
                (if (wrap) Modifier else Modifier.horizontalScroll(rememberScrollState())).padding(start = 14.dp, end = 14.dp, bottom = 14.dp),
                fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall.copy(lineHeight = 1.5.em), softWrap = wrap,
            )
        }
    }
}

/** A real grid: columns size to their widest cell (wrapping past a cap) and wide tables scroll sideways. */
@Composable private fun TableBlock(rows: List<List<String>>, styles: InlineStyles, color: Color) {
    val columns = rows.maxOf { it.size }
    val line = MaterialTheme.colorScheme.outlineVariant
    Surface(color = color, shape = RoundedCornerShape(12.dp)) {
        Layout(
            content = {
                rows.forEachIndexed { r, row ->
                    repeat(columns) { c ->
                        Text(
                            inlineMarkdown(row.getOrNull(c).orEmpty(), styles),
                            Modifier.drawBehind { if (r < rows.lastIndex) drawLine(line, Offset(0f, size.height), Offset(size.width, size.height), 1.dp.toPx()) }.padding(horizontal = 12.dp, vertical = 8.dp),
                            style = MaterialTheme.typography.bodyMedium, fontWeight = if (r == 0) FontWeight.SemiBold else null,
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
