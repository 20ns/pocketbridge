package dev.pocketbridge

import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.font.FontFamily
import org.junit.Assert.*
import org.junit.Test

class MarkdownTest {
    @Test fun `blocks Claude commonly writes are recognised`() {
        val blocks = parseMarkdown("## Changes\n\nText line one\nline two\n\n- item\n  continued\n  - nested\n2. second\n\n> quoted\n> more\n\n---\n\n```kotlin\nval x = 1\n```")
        assertEquals(listOf(
            Heading(2, "Changes"), Paragraph("Text line one\nline two"),
            Bullet("•", "item continued", 0), Bullet("•", "nested", 1), Bullet("2.", "second", 0),
            Quote("quoted\nmore"), Rule, Code("kotlin", "val x = 1"),
        ), blocks)
    }

    @Test fun `streaming code fence and tables render without a closing line`() {
        assertEquals(listOf(Paragraph("Run:"), Code("", "./gradlew")), parseMarkdown("Run:\n```\n./gradlew"))
        assertEquals(listOf(Table(listOf(listOf("Mode", "Asks"), listOf("Bypass", "Never")), listOf(ColumnAlign.Start, ColumnAlign.Center))), parseMarkdown("| Mode | Asks |\n|---|:-:|\n| Bypass | Never |"))
        assertEquals(listOf(Paragraph("a | b")), parseMarkdown("a | b"))
    }

    @Test fun `inline formatting keeps raw HTML as text and links only web addresses`() {
        val styles = InlineStyles(SpanStyle(), TextLinkStyles())
        val text = inlineMarkdown("<b>x</b> **bold** `a*b*c` [site](https://example.org) [bad](javascript:alert) [Api.kt](android/Api.kt:12) snake_case_name __init__.py __strong__", styles)
        assertEquals("<b>x</b> bold a*b*c site bad Api.kt snake_case_name __init__.py strong", text.text)
        val links = text.getLinkAnnotations(0, text.length).map { (it.item as LinkAnnotation.Url).url }
        assertEquals(listOf("https://example.org"), links)
        assertEquals("see https://a.dev/x.", inlineMarkdown("see https://a.dev/x.", styles).text)
        assertEquals(listOf("https://a.dev/x"), inlineMarkdown("see https://a.dev/x.", styles).let { s -> s.getLinkAnnotations(0, s.length).map { (it.item as LinkAnnotation.Url).url } })
    }

    @Test fun `headings keep trailing hashes that belong to words`() {
        assertEquals(listOf(Heading(2, "Port to C#"), Heading(3, "Done")), parseMarkdown("## Port to C#\n### Done ###"))
    }

    @Test fun `code fenced inside a list item loses only the list indentation`() {
        assertEquals(
            listOf(Bullet("1.", "Run:", 0), Code("sh", "pnpm test\n  --watch"), Paragraph("Then commit.")),
            parseMarkdown("1. Run:\n   ```sh\n   pnpm test\n     --watch\n   ```\nThen commit."),
        )
        // A longer run of backticks inside the block is content, not the closing fence.
        assertEquals(listOf(Code("md", "```kotlin\nx\n```")), parseMarkdown("````md\n```kotlin\nx\n```\n````"))
    }

    @Test fun `table cells may contain escaped pipes`() {
        assertEquals(listOf(Table(listOf(listOf("Flag", "Meaning"), listOf("a|b", "either")), listOf(ColumnAlign.Start, ColumnAlign.Start))), parseMarkdown("| Flag | Meaning |\n|---|---|\n| a\\|b | either |"))
    }

    @Test fun `table columns follow their divider alignment`() {
        val table = parseMarkdown("| Name | Tests | Time |\n|:---|:---:|---:|\n| JVM | 59 | 4.2 s |").single() as Table
        assertEquals(listOf(ColumnAlign.Start, ColumnAlign.Center, ColumnAlign.End), table.align)
        assertEquals(listOf("JVM", "59", "4.2 s"), table.rows[1])
    }

    @Test fun `file links read as code and never become links`() {
        val code = SpanStyle(fontFamily = FontFamily.Monospace)
        val styles = InlineStyles(code, TextLinkStyles())
        val text = inlineMarkdown("See [Api.kt](android/Api.kt:12) and [the guide](docs/guide)", styles)
        assertEquals("See Api.kt and the guide", text.text)
        assertTrue(text.getLinkAnnotations(0, text.length).isEmpty())
        assertEquals(listOf(4 to 10), text.spanStyles.filter { it.item == code }.map { it.start to it.end })
    }

    @Test fun `nested lists take their depth from the parent item, not the absolute indent`() {
        assertEquals(
            listOf(Bullet("•", "a", 0), Bullet("•", "b", 1), Bullet("•", "c", 2), Bullet("•", "d", 1), Bullet("•", "e", 0)),
            parseMarkdown("- a\n    - b\n        - c\n    - d\n- e"),
        )
        assertEquals(listOf(Bullet("1.", "one", 0), Bullet("•", "sub", 1), Bullet("•", "less", 1)), parseMarkdown("1. one\n   - sub\n  - less"))
        // A new list after other text starts at the top again.
        assertEquals(listOf(Bullet("•", "a", 0), Paragraph("Then:"), Bullet("•", "x", 0)), parseMarkdown("- a\n\nThen:\n    - x"))
    }

    @Test fun `spacing opens sections and keeps list items together`() {
        assertEquals(0, blockGap(null, Paragraph("a")))
        assertEquals(22, blockGap(Paragraph("a"), Heading(2, "b")))
        assertEquals(18, blockGap(Paragraph("a"), Heading(3, "b")))
        assertEquals(6, blockGap(Heading(2, "b"), Paragraph("c")))
        assertEquals(6, blockGap(Bullet("•", "x", 0), Bullet("•", "y", 0)))
        assertEquals(4, blockGap(Bullet("•", "x", 0), Bullet("•", "y", 1)))
        assertEquals(12, blockGap(Bullet("•", "x", 0), Paragraph("z")))
    }
}
