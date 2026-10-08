package dev.pocketbridge

import org.json.JSONArray
import org.json.JSONObject

/** A paste this long becomes one block in the composer instead of a wall of text in the box. */
const val PASTE_CHARS = 1000
const val PASTE_LINES = 20

/**
 * Text pasted into the composer as one block. Saved per chat with the typed draft, and sent inside the prompt text,
 * so the Mac and the delivery record see one ordinary prompt.
 */
data class Paste(val key: String, val text: String)

fun lineCount(text: String) = if (text.isEmpty()) 0 else text.count { it == '\n' } + if (text.endsWith('\n')) 0 else 1

fun isLargePaste(text: String) = text.length >= PASTE_CHARS || lineCount(text) >= PASTE_LINES

/** "312 lines", or "1,240 characters" for one long line. */
fun pasteSize(text: String) = lineCount(text).let { lines -> if (lines > 1) "%,d lines".format(lines) else "%,d characters".format(text.length) }

fun encodePastes(list: List<Paste>): String = JSONArray(list.map { JSONObject().put("key", it.key).put("text", it.text) }).toString()

fun decodePastes(value: String): List<Paste> = if (value.isBlank()) emptyList() else runCatching {
    JSONArray(value).objects().mapNotNull { item -> item.optString("key").takeIf { it.isNotBlank() }?.let { Paste(it, item.optString("text")) } }
}.getOrDefault(emptyList())

/**
 * What Send delivers: pasted blocks in the order they were pasted, then the typed text, a blank line apart. Long
 * material first and the ask last reads best to a model; a typed "/command" stays at the start so it still runs.
 */
fun promptText(typed: String, pastes: List<Paste>): String {
    val text = typed.trim()
    val blocks = pastes.map { it.text.trimStart('\n', '\r').trimEnd() }.filter { it.isNotEmpty() }
    if (blocks.isEmpty()) return text
    val parts = if (text.startsWith("/")) listOf(text) + blocks else blocks + text
    return parts.filter { it.isNotEmpty() }.joinToString("\n\n").trim()
}

/** An edit that inserted a large block: the text left in the box, the caret there, and the pasted block. */
data class Insertion(val kept: String, val cursor: Int, val pasted: String)

/**
 * Finds a large paste in one edit of the message box. [start] and [end] are the selection before the edit, [cursor]
 * the caret after it; a paste replaces the selection and leaves the caret after what it inserted. Edits that don't
 * fit that shape fall back to comparing the texts. Typing and small pastes return null.
 */
fun largeInsertion(before: String, start: Int, end: Int, after: String, cursor: Int): Insertion? {
    if (after.length - before.length + (end - start) < PASTE_LINES - 1) return null
    val head = before.substring(0, start.coerceIn(0, before.length))
    val tail = before.substring(end.coerceIn(head.length, before.length))
    if (cursor - head.length == after.length - head.length - tail.length && after.startsWith(head) && after.endsWith(tail)) {
        val pasted = after.substring(head.length, cursor)
        return if (isLargePaste(pasted)) Insertion(head + tail, head.length, pasted) else null
    }
    val limit = minOf(before.length, after.length)
    var prefix = 0
    while (prefix < limit && before[prefix] == after[prefix]) prefix++
    var suffix = 0
    while (suffix < limit - prefix && before[before.length - 1 - suffix] == after[after.length - 1 - suffix]) suffix++
    val pasted = after.substring(prefix, after.length - suffix)
    return if (isLargePaste(pasted)) Insertion(after.substring(0, prefix) + after.substring(after.length - suffix), prefix, pasted) else null
}

/**
 * Lines the message box shows before it scrolls inside: about 30% of the height left above the keyboard, from 3 to 8,
 * so the options, Send and some of the conversation always stay in view.
 */
fun composerLines(visibleHeight: Float, lineHeight: Float) = if (lineHeight <= 0f) 8 else (visibleHeight * 0.3f / lineHeight).toInt().coerceIn(3, 8)
