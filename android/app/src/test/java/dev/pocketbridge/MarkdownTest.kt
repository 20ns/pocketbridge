package dev.pocketbridge

import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
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
        assertEquals(listOf(Table(listOf(listOf("Mode", "Asks"), listOf("Bypass", "Never")))), parseMarkdown("| Mode | Asks |\n|---|:-:|\n| Bypass | Never |"))
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
        assertEquals(listOf(Table(listOf(listOf("Flag", "Meaning"), listOf("a|b", "either")))), parseMarkdown("| Flag | Meaning |\n|---|---|\n| a\\|b | either |"))
    }
}
