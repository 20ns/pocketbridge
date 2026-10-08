package dev.pocketbridge

import org.junit.Assert.*
import org.junit.Test

class PastesTest {
    @Test fun `long or many-line pastes become blocks and short ones stay text`() {
        assertFalse(isLargePaste("a".repeat(PASTE_CHARS - 1)))
        assertTrue(isLargePaste("a".repeat(PASTE_CHARS)))
        assertFalse(isLargePaste("x\n".repeat(PASTE_LINES - 1)))
        assertTrue(isLargePaste("x\n".repeat(PASTE_LINES)))
        assertEquals(0, lineCount(""))
        assertEquals(1, lineCount("one"))
        assertEquals(2, lineCount("one\ntwo\n"))
        assertEquals("312 lines", pasteSize("x\n".repeat(312)))
        assertEquals("%,d characters".format(1240), pasteSize("a".repeat(1240)))
    }

    @Test fun `a large paste is found where it went and the box keeps the rest`() {
        val log = "error\n".repeat(30)
        val pasted = largeInsertion("Fix  please", 4, 4, "Fix $log please", 4 + log.length)
        assertEquals(Insertion("Fix  please", 4, log), pasted)
        // A paste over a selection replaces it.
        assertEquals(Insertion("Fix  please", 4, log), largeInsertion("Fix THIS please", 4, 8, "Fix $log please", 4 + log.length))
        // Typing and small pastes stay in the box.
        assertNull(largeInsertion("Fix", 3, 3, "Fix ", 4))
        assertNull(largeInsertion("", 0, 0, "a short line of pasted text", 27))
    }

    @Test fun `a paste that starts like the text after the caret keeps its own text`() {
        val block = "\n" + "row\n".repeat(25)
        val before = "x\n"
        val after = "x" + block + "\n"
        assertEquals(block, largeInsertion(before, 1, 1, after, 1 + block.length)?.pasted)
        // Without a usable caret, the texts are compared instead.
        assertEquals(lineCount(block), largeInsertion(before, 1, 1, after, 0)?.pasted?.let(::lineCount))
    }

    @Test fun `the prompt carries pasted blocks first, then the typed ask`() {
        val log = Paste("a", "\nstack trace\n  at line 4\n\n")
        val config = Paste("b", "key: value")
        assertEquals("Why?", promptText("  Why?  ", emptyList()))
        assertEquals("stack trace\n  at line 4\n\nkey: value\n\nWhy?", promptText("Why?", listOf(log, config)))
        assertEquals("key: value", promptText("  ", listOf(config, Paste("c", " \n "))))
        // A slash command must stay at the start to run.
        assertEquals("/review now\n\nkey: value", promptText("/review now", listOf(config)))
    }

    @Test fun `pasted blocks survive their saved form`() {
        val pastes = listOf(Paste("a", "line one\nline \"two\"\n"), Paste("b", "é ✓ 🙂"))
        assertEquals(pastes, decodePastes(encodePastes(pastes)))
        assertEquals(emptyList<Paste>(), decodePastes(""))
        assertEquals(emptyList<Paste>(), decodePastes("not json"))
        assertEquals(listOf(Paste("k", "t")), decodePastes("""[{"key":"","text":"x"},{"key":"k","text":"t"}]"""))
    }

    @Test fun `send counts a paste as something to send`() {
        assertFalse(canSendDraft(" ", emptyList(), listOf(Paste("a", " "))))
        assertTrue(canSendDraft(" ", emptyList(), listOf(Paste("a", "log"))))
    }

    @Test fun `the message box shows fewer lines with the keyboard up`() {
        assertEquals(8, composerLines(900f, 24f))
        assertEquals(6, composerLines(500f, 24f))
        assertEquals(3, composerLines(150f, 24f))
        assertEquals(8, composerLines(500f, 0f))
    }
}
