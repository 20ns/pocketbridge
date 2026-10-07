package dev.pocketbridge

import org.junit.Assert.*
import org.junit.Test

class TranscriptTest {
    private fun activity(id: String, text: String) = Said(id, "activity", text)

    @Test fun `consecutive activity becomes one group between replies`() {
        val entries = transcript(listOf(
            Said("u", "user", "Fix it"),
            activity("a1", "Read\n{\n  \"file_path\": \"/repo/app/Api.kt\"\n}"),
            activity("a2", "Tool result\n1\tpackage dev"),
            activity("a3", "Bash\n{\"command\": \"pnpm test\", \"description\": \"Run Mac tests\"}"),
            activity("a4", "Tool failed\nEADDRINUSE"),
            Said("c", "assistant", "Done"),
        ))
        assertEquals(listOf("u", "steps:a1", "c"), entries.map { it.key })
        val steps = (entries[1] as Steps).steps
        assertEquals(listOf("Read" to "Api.kt", "Bash" to "Run Mac tests"), steps.map { it.tool to it.summary })
        assertEquals("1\tpackage dev", steps[0].result)
        assertTrue(steps[1].failed)
        assertEquals("2 steps · Read, Bash", stepsTitle(steps))
    }

    @Test fun `parallel results pair with calls in order`() {
        val steps = (transcript(listOf(
            activity("a", "Read\n{\"file_path\":\"a.txt\"}"), activity("b", "Read\n{\"file_path\":\"b.txt\"}"),
            activity("c", "Tool result\nA"), activity("d", "Tool result\nB"),
        )).single() as Steps).steps
        assertEquals(listOf("A", "B"), steps.map { it.result })
    }

    @Test fun `notices and orphan results stay visible without inventing tools`() {
        val steps = (transcript(listOf(activity("n", "Permission denied for Bash"), activity("r", "Tool result\nlate output"))).single() as Steps).steps
        assertTrue(steps[0].isNote)
        assertEquals("Result", steps[1].tool)
        assertEquals("2 steps · Result", stepsTitle(steps))
    }

    @Test fun `summaries prefer intent and stay short`() {
        assertEquals("Updated 3 tasks", summarize("TodoWrite", "{\"todos\":[1,2,3]}"))
        assertEquals("fun send", summarize("Grep", "{\"pattern\":\"fun send\",\"path\":\"android\"}"))
        assertEquals("not json", summarize("X", "not json"))
        assertEquals(90, firstLine("x".repeat(200)).length)
        assertEquals("5 steps · A, B, C +2", stepsTitle("ABCDE".map { Step(it.toString(), it.toString(), "", "{}") }))
    }

    @Test fun `tool input and results read as text rather than JSON`() {
        assertEquals("$ pnpm test", describeInput("Bash", "{\"command\":\"pnpm test\",\"description\":\"Run tests\"}"))
        assertEquals("app/Api.kt\n- val a = 1\n+ val a = 2", describeInput("Edit", "{\"file_path\":\"app/Api.kt\",\"old_string\":\"val a = 1\",\"new_string\":\"val a = 2\"}"))
        assertEquals("[x] Read\n[~] Fix", describeInput("TodoWrite", "{\"todos\":[{\"content\":\"Read\",\"status\":\"completed\"},{\"content\":\"Fix\",\"status\":\"in_progress\"}]}"))
        assertEquals("Old path:\na\nb", describeInput("Move", "{\"old_path\":\"a\\nb\"}"))
        val steps = (transcript(listOf(
            activity("t", "Task\n{\"description\":\"Survey\"}"),
            activity("r", "Tool result\n[{\"type\":\"text\",\"text\":\"Found 3 files\"}]"),
        )).single() as Steps).steps
        assertEquals("Found 3 files", steps.single().result)
        assertEquals("[1, 2]", resultText("[1, 2]"))
    }

    @Test fun `answers in progress survive being saved as text`() {
        val answers = Answers(
            picks = mapOf("Which \"files\"?\nPick any" to setOf("Api.kt", "\u0000other"), "Ship?" to emptySet()),
            typed = mapOf("Which \"files\"?\nPick any" to "and the tests"),
        )
        assertEquals(answers, decodeAnswers(encodeAnswers(answers)))
    }

    @Test fun `a named result after a steer joins its command in the earlier group`() {
        val entries = transcript(listOf(
            activity("c2", "Shell\n{\"command\": \"pnpm test\"}"),
            Said("n1", "assistant", "Noted: use staging."),
            activity("c2:result", "Tool result\nok"),
            activity("f1", "Edit\n{\"file_path\": \"src/http.ts\"}"),
        ))
        assertEquals(3, entries.size)
        assertEquals("ok", (entries[0] as Steps).steps.single().result)
        assertEquals(listOf("f1"), (entries[2] as Steps).steps.map { it.id })
    }

    @Test fun `long tool runs keep named and legacy results paired`() {
        val count = 4000
        val calls = (0 until count).map { activity("t$it", "Shell\n{\"command\":\"true\"}") }
        val named = (count - 1 downTo 0 step 2).map { activity("t$it:result", "Tool result\n$it") }
        val legacy = (0 until count step 2).map { activity("legacy$it", "Tool result\n$it") }
        val steps = (transcript(calls + named + legacy).single() as Steps).steps
        assertEquals(count, steps.size)
        assertEquals((0 until count).map(Int::toString), steps.map { it.result })
    }

    @Test fun `turn markers handle long histories and ignore joined steers`() {
        val messages = (0 until 2000).flatMap { i -> listOf(
            Said("u$i", "user", "run"), Said("a$i", "assistant", "working"),
            Said("s$i", "user", "adjust", kind = STEER), Said("r$i", "assistant", "done"),
        ) }
        val entries = transcript(messages)
        val turns = (0 until 2000).map { i -> Turn("u$i", i * 100L, i * 100L + 10) }
        val replies = (0 until 2000).map { "r$it" }.toSet()
        assertEquals(replies, turnEnds(entries, live = false, turns))
        assertEquals(replies - "r1999", turnEnds(entries, live = true, turns))
        assertEquals(replies.associateWith { 10L }, turnDurations(entries, turns))
    }

    @Test fun `a blank reply blocks Copy but durations use the last nonblank reply`() {
        val entries = transcript(listOf(
            Said("u1", "user", "run"), Said("r1", "assistant", "done"), Said("blank", "assistant", ""),
            Said("u2", "user", "again"), Said("r2", "assistant", "running"),
        ))
        val turns = listOf(Turn("u1", 10, 30), Turn("u2", 40, null))
        assertTrue(turnEnds(entries, live = true, turns).isEmpty())
        assertEquals(mapOf("r1" to 20L), turnDurations(entries, turns))
    }

}
