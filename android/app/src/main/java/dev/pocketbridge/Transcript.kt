package dev.pocketbridge

import org.json.JSONArray
import org.json.JSONObject

/** A saved chat message. Activity text is `Tool\n{json}`, `Tool result\n…`, `Tool failed\n…` or a plain Mac notice. */
data class Said(val id: String, val role: String, val text: String)

/** One tool call paired with its result once that arrives. */
data class Step(val id: String, val tool: String, val summary: String, val input: String, val result: String? = null, val failed: Boolean = false) {
    val isNote get() = tool == NOTE
}

sealed interface Entry { val key: String }
data class Message(val said: Said) : Entry { override val key get() = said.id }
data class Steps(val steps: List<Step>) : Entry { override val key get() = "steps:" + steps.first().id }

private const val NOTE = "Note"
private val summaryKeys = listOf("description", "command", "file_path", "notebook_path", "pattern", "path", "url", "query", "prompt", "skill")

/** Groups consecutive activity messages so tool work reads as one collapsible run between replies. */
fun transcript(messages: List<Said>): List<Entry> {
    val entries = mutableListOf<Entry>()
    var steps = mutableListOf<Step>()
    fun flush() { if (steps.isNotEmpty()) { entries += Steps(steps); steps = mutableListOf() } }
    for (said in messages) {
        if (said.role != "activity") { flush(); entries += Message(said); continue }
        val head = said.text.substringBefore('\n').trim()
        val body = said.text.substringAfter('\n', "").let { if (head == "Tool result" || head == "Tool failed") resultText(it) else it }
        val isResult = head == "Tool result" || head == "Tool failed"
        // Parallel tool calls return results in call order, so pair with the oldest call still waiting.
        val waiting = steps.indexOfFirst { it.result == null && !it.isNote }
        when {
            isResult && waiting >= 0 -> steps[waiting] = steps[waiting].copy(result = body, failed = head == "Tool failed")
            isResult -> steps += Step(said.id, if (head == "Tool failed") "Failed" else "Result", firstLine(body), "", body, head == "Tool failed")
            body.trimStart().startsWith("{") -> steps += Step(said.id, head, summarize(head, body), body)
            else -> steps += Step(said.id, NOTE, firstLine(said.text), said.text)
        }
    }
    flush()
    return entries
}

fun summarize(tool: String, json: String): String {
    val input = runCatching { JSONObject(json) }.getOrNull() ?: return firstLine(json)
    if (tool == "TodoWrite") input.optJSONArray("todos")?.let { return "Updated ${plural(it.length(), "task")}" }
    for (key in summaryKeys) {
        val value = input.opt(key) as? String ?: continue
        if (value.isBlank()) continue
        return firstLine(if (key.endsWith("path") && key != "path") value.trimEnd('/').substringAfterLast('/') else value)
    }
    val first = input.keys().asSequence().firstOrNull() ?: return ""
    return when (val value = input.opt(first)) { is JSONArray -> plural(value.length(), "item"); is JSONObject -> first; else -> firstLine(value?.toString().orEmpty()) }
}

/** Tool input as a person reads it: the command, an edit as removed and added lines, a task list, or labelled fields. */
fun describeInput(tool: String, json: String): String {
    val input = runCatching { JSONObject(json) }.getOrNull() ?: return json
    input.optString("command").takeIf { it.isNotBlank() }?.let { return "$ $it" }
    if (tool == "TodoWrite") input.optJSONArray("todos")?.let { todos ->
        return todos.objects().joinToString("\n") { todo ->
            when (todo.optString("status")) { "completed" -> "[x] "; "in_progress" -> "[~] "; else -> "[ ] " } + todo.optString("content")
        }
    }
    val edits = input.optJSONArray("edits")?.objects() ?: listOf(input).filter { it.has("old_string") }
    if (edits.isNotEmpty()) return (listOf(input.optString("file_path")) + edits.flatMap { edit ->
        edit.optString("old_string").lines().map { "- $it" } + edit.optString("new_string").lines().map { "+ $it" }
    }).joinToString("\n")
    return input.keys().asSequence().joinToString("\n") { key ->
        val label = key.replace('_', ' ').replaceFirstChar(Char::uppercase)
        when (val value = input.opt(key)) {
            is String -> if ('\n' in value) "$label:\n$value" else "$label: $value"
            is JSONObject -> "$label:\n" + value.toString(2)
            is JSONArray -> "$label:\n" + value.toString(2)
            else -> "$label: $value"
        }
    }
}

/** Results may arrive as Claude content blocks; show their text rather than the JSON around it. */
fun resultText(body: String): String {
    if (!body.trimStart().startsWith("[")) return body
    val blocks = runCatching { JSONArray(body).objects() }.getOrNull()?.takeIf { list -> list.isNotEmpty() && list.all { it.has("type") } } ?: return body
    return blocks.joinToString("\n") { if (it.optString("type") == "text") it.optString("text") else "[${it.optString("type")}]" }
}

/** "4 steps · Read, Grep, Edit +1" — the distinct tools in the order Claude used them. */
fun stepsTitle(steps: List<Step>): String {
    val tools = steps.filterNot { it.isNote }.map { it.tool }.distinct()
    val names = if (tools.size > 3) tools.take(3).joinToString(", ") + " +${tools.size - 3}" else tools.joinToString(", ")
    return if (names.isEmpty()) plural(steps.size, "note") else plural(steps.size, "step") + " · " + names
}

fun plural(count: Int, noun: String) = "$count $noun" + if (count == 1) "" else "s"

fun firstLine(text: String, max: Int = 90): String {
    val line = text.lineSequence().map(String::trim).firstOrNull { it.isNotEmpty() }.orEmpty()
    return if (line.length > max) line.take(max - 1).trimEnd() + "…" else line
}

/** Question answers in progress: chosen options and typed text per question. Kept as one JSON string so a Bundle can hold it. */
data class Answers(val picks: Map<String, Set<String>> = emptyMap(), val typed: Map<String, String> = emptyMap())

fun encodeAnswers(answers: Answers): String = JSONObject()
    .put("picks", JSONObject().apply { answers.picks.forEach { (question, chosen) -> put(question, JSONArray(chosen.toList())) } })
    .put("typed", JSONObject().apply { answers.typed.forEach { (question, text) -> put(question, text) } })
    .toString()

fun decodeAnswers(saved: String): Answers {
    val json = JSONObject(saved)
    val picks = json.getJSONObject("picks")
    val typed = json.getJSONObject("typed")
    return Answers(
        picks.keys().asSequence().associateWith { question -> picks.getJSONArray(question).let { list -> (0 until list.length()).map(list::getString).toSet() } },
        typed.keys().asSequence().associateWith(typed::getString),
    )
}
