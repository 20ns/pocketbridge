package dev.pocketbridge

import org.junit.Assert.*
import org.junit.Test

class HighlightTest {
    private fun spans(code: String, language: String) = highlight(code, language).map { code.substring(it.start, it.end) to it.kind }

    @Test fun `kotlin keywords strings comments numbers types and annotations`() {
        val code = "@Composable fun Row(count: Int = 42) { val name = \"pocket\" } // done"
        assertEquals(listOf(
            "@Composable" to TokenKind.Annotation, "fun" to TokenKind.Keyword, "Row" to TokenKind.Type, "Int" to TokenKind.Type,
            "42" to TokenKind.Number, "val" to TokenKind.Keyword, "\"pocket\"" to TokenKind.Str, "// done" to TokenKind.Comment,
        ), spans(code, "kotlin"))
    }

    @Test fun `calls are functions, constants and plain names stay plain`() {
        assertEquals(listOf("listOf" to TokenKind.Function), spans("listOf(MAX_SIZE, items)", "kt"))
    }

    @Test fun `block comments and escaped quotes stay whole`() {
        assertEquals(listOf("/* a \"b\" */" to TokenKind.Comment, "const" to TokenKind.Keyword, "'it\\'s'" to TokenKind.Str), spans("/* a \"b\" */ const x = 'it\\'s'", "ts"))
    }

    @Test fun `an unterminated string stops at its line`() {
        assertEquals(listOf("\"open" to TokenKind.Str, "val" to TokenKind.Keyword), spans("\"open\nval x", "kotlin"))
    }

    @Test fun `python triple quotes and hash comments`() {
        assertEquals(listOf("def" to TokenKind.Keyword, "run" to TokenKind.Function, "\"\"\"Doc\nmore\"\"\"" to TokenKind.Str, "# end" to TokenKind.Comment),
            spans("def run():\n    \"\"\"Doc\nmore\"\"\" # end", "py"))
    }

    @Test fun `json keys differ from string values`() {
        assertEquals(listOf("\"agent\"" to TokenKind.Function, "\"codex\"" to TokenKind.Str, "\"ok\"" to TokenKind.Function, "true" to TokenKind.Keyword, "\"count\"" to TokenKind.Function, "7" to TokenKind.Number),
            spans("{ \"agent\": \"codex\", \"ok\": true, \"count\": 7 }", "json"))
    }

    @Test fun `shell comments need a word break and variables are marked`() {
        assertEquals(listOf("echo" to TokenKind.Keyword, "\"\$HOME\"" to TokenKind.Str, "\$PATH" to TokenKind.Variable, "# note" to TokenKind.Comment),
            spans("echo \"\$HOME\" a#b \$PATH # note", "bash"))
    }

    @Test fun `unknown languages are left plain`() {
        assertTrue(highlight("val x = 1", "").isEmpty())
        assertTrue(highlight("<b>hi</b>", "html").isEmpty())
    }

    @Test fun `diffs mark signs, headers and line ranges`() {
        val diff = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same"
        assertTrue(isDiff("", diff))
        assertTrue(isDiff("patch", "-a"))
        assertFalse(isDiff("", "- a list\n- of items"))
        assertFalse(isDiff("kotlin", diff))
        assertEquals(listOf(DiffLine(28, 32, false), DiffLine(33, 37, true)), diffLines(diff))
        assertEquals(listOf(TokenKind.Meta, TokenKind.Meta, TokenKind.Meta, TokenKind.Removed, TokenKind.Added), highlight(diff, "diff").map { it.kind })
    }

    @Test fun `language labels read naturally`() {
        assertEquals("Kotlin", languageLabel("kotlin"))
        assertEquals("TypeScript", languageLabel("ts"))
        assertEquals("Shell", languageLabel("sh"))
        assertEquals("JSON", languageLabel("json"))
        assertEquals("Swift", languageLabel("swift"))
        assertEquals("", languageLabel(""))
    }
}
