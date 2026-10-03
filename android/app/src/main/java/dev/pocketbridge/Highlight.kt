package dev.pocketbridge

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight

// Lightweight highlighting for code in replies: a single pass per block, no regex backtracking, no parsing.
// It colours what a reader scans for (keywords, strings, comments, numbers, types) and leaves the rest plain.

enum class TokenKind { Keyword, Str, Comment, Number, Type, Function, Annotation, Variable, Added, Removed, Meta }
data class Token(val start: Int, val end: Int, val kind: TokenKind)

private class Grammar(
    val keywords: Set<String>,
    val lineComments: List<String> = listOf("//"),
    val block: Pair<String, String>? = "/*" to "*/",
    val quotes: String = "\"'",
    val triple: Boolean = false,
    val types: Boolean = true,
    val annotations: Boolean = true,
    val variables: Boolean = false,
    val keys: Boolean = false,
    val ignoreCase: Boolean = false,
)

private fun words(text: String) = text.split(' ').filter(String::isNotEmpty).toSet()

private val cLike = words("if else for while do switch case default break continue return goto sizeof struct union enum typedef static const extern void int char long short float double unsigned signed bool true false null nullptr new delete class public private protected virtual override template typename namespace using this throw try catch auto inline")
private val kotlin = Grammar(words("package import class interface object fun val var if else when for while do return break continue try catch finally throw is in as null true false this super typealias data sealed enum companion override private public protected internal open abstract final lateinit const suspend inline reified by init get set where out vararg crossinline noinline operator infix annotation constructor value"), triple = true)
private val java = Grammar(words("package import class interface enum extends implements new return if else for while do switch case default break continue try catch finally throw throws this super null true false void int long short byte char float double boolean static final abstract public private protected synchronized volatile transient native instanceof var record sealed permits yield"))
private val swift = Grammar(words("func let var if else guard return struct class enum protocol extension import self Self nil true false in for while repeat switch case default break continue throw throws rethrows try catch do async await public private internal fileprivate open static final override mutating init deinit some any where as is weak lazy actor typealias inout defer"), quotes = "\"", triple = true)
private val script = Grammar(words("const let var function return if else for while do switch case default break continue new delete typeof instanceof in of class extends super this null undefined true false import export from as async await yield try catch finally throw interface type enum implements public private protected readonly static get set void never unknown any number string boolean keyof declare namespace abstract satisfies"), quotes = "\"'`")
private val python = Grammar(words("def class return if elif else for while in not and or is None True False import from as with try except finally raise lambda yield pass break continue global nonlocal async await assert del self match case"), listOf("#"), null, triple = true)
private val go = Grammar(words("func package import var const type struct interface map chan go defer return if else for range switch case default break continue fallthrough select nil true false"), quotes = "\"'`")
private val rust = Grammar(words("fn let mut pub mod use crate self Self super struct enum impl trait where for in if else match loop while return break continue as const static ref move async await dyn true false unsafe type"), quotes = "\"")
private val shell = Grammar(words("if then else elif fi for in do done while until case esac function return export local readonly declare echo cd exit set unset source alias sudo"), listOf("#"), null, quotes = "\"'`", types = false, annotations = false, variables = true)
private val json = Grammar(words("true false null"), emptyList(), null, quotes = "\"", types = false, annotations = false, keys = true)
private val yaml = Grammar(words("true false null yes no on off"), listOf("#"), null, types = false, annotations = false, keys = true)
private val sql = Grammar(words("select from where insert into values update set delete create alter drop table index view join left right inner outer full on group by order having limit offset as and or not null is in like between distinct primary key foreign references default union all exists case when then else end with returning"), listOf("--"), types = false, annotations = false, ignoreCase = true)
private val css = Grammar(words("important inherit initial none auto"), emptyList(), types = false, annotations = false)

private fun grammar(language: String): Grammar? = when (language.lowercase()) {
    "kotlin", "kt", "kts", "gradle" -> kotlin
    "java" -> java
    "swift" -> swift
    "ts", "typescript", "tsx", "js", "javascript", "jsx", "mjs", "cjs", "node" -> script
    "py", "python", "python3" -> python
    "go", "golang" -> go
    "rust", "rs" -> rust
    "sh", "bash", "zsh", "shell", "console", "shellscript", "fish" -> shell
    "json", "jsonc", "json5" -> json
    "yaml", "yml", "toml", "ini" -> yaml
    "sql" -> sql
    "css", "scss" -> css
    "c", "h", "cpp", "c++", "cc", "hpp", "cs", "csharp", "objc", "objective-c", "dart", "scala" -> Grammar(cLike)
    else -> null
}

private val labels = mapOf(
    "kt" to "Kotlin", "kts" to "Kotlin script", "ts" to "TypeScript", "tsx" to "TSX", "js" to "JavaScript", "jsx" to "JSX", "mjs" to "JavaScript",
    "py" to "Python", "sh" to "Shell", "zsh" to "Zsh", "rs" to "Rust", "yml" to "YAML", "yaml" to "YAML", "json" to "JSON", "sql" to "SQL", "css" to "CSS",
    "html" to "HTML", "xml" to "XML", "cpp" to "C++", "cs" to "C#", "csharp" to "C#", "objc" to "Objective-C", "md" to "Markdown", "toml" to "TOML",
    "typescript" to "TypeScript", "javascript" to "JavaScript", "golang" to "Go",
)
/** How a fence's language reads in a code block header. */
fun languageLabel(language: String) = labels[language.lowercase()] ?: language.replaceFirstChar(Char::uppercase)

/** A unified diff: labelled as one, or headed by @@/---/+++ lines. */
fun isDiff(language: String, code: String): Boolean {
    if (language.lowercase() in listOf("diff", "patch")) return true
    if (language.isNotEmpty()) return false
    val lines = code.lines().filter(String::isNotEmpty)
    return lines.any { it.startsWith("@@") || it.startsWith("+++ ") || it.startsWith("--- ") } && lines.any { it.startsWith("+") || it.startsWith("-") }
}

/** An added or removed line of a diff, by character range, for its background tint. File headers are neither. */
data class DiffLine(val start: Int, val end: Int, val added: Boolean)

fun diffLines(code: String): List<DiffLine> {
    val lines = mutableListOf<DiffLine>()
    var start = 0
    for (line in code.split('\n')) {
        val end = start + line.length
        if (!line.startsWith("+++") && !line.startsWith("---") && (line.startsWith("+") || line.startsWith("-"))) lines += DiffLine(start, end, line[0] == '+')
        start = end + 1
    }
    return lines
}

fun highlight(code: String, language: String): List<Token> {
    if (isDiff(language, code)) return highlightDiff(code)
    val grammar = grammar(language) ?: return emptyList()
    val tokens = mutableListOf<Token>()
    val n = code.length
    var i = 0
    fun startOfWord(at: Int) = at == 0 || !(code[at - 1].isLetterOrDigit() || code[at - 1] == '_')
    fun nextNonSpace(from: Int): Char? { var j = from; while (j < n && (code[j] == ' ' || code[j] == '\t')) j++; return code.getOrNull(j) }
    while (i < n) {
        val c = code[i]
        val block = grammar.block
        val line = grammar.lineComments.firstOrNull { code.startsWith(it, i) && (it != "#" || i == 0 || code[i - 1].isWhitespace()) }
        when {
            block != null && code.startsWith(block.first, i) -> {
                val close = code.indexOf(block.second, i + block.first.length)
                val end = if (close < 0) n else close + block.second.length
                tokens += Token(i, end, TokenKind.Comment); i = end
            }
            line != null -> {
                val end = code.indexOf('\n', i).let { if (it < 0) n else it }
                tokens += Token(i, end, TokenKind.Comment); i = end
            }
            c in grammar.quotes -> {
                val fence = "$c$c$c"
                val end = if (grammar.triple && code.startsWith(fence, i)) code.indexOf(fence, i + 3).let { if (it < 0) n else it + 3 }
                    else {
                        var j = i + 1
                        // Strings end at their quote or the line; template literals may span lines.
                        while (j < n && code[j] != c && (code[j] != '\n' || c == '`')) j += if (code[j] == '\\') 2 else 1
                        if (j < n && code[j] == c) j + 1 else j.coerceAtMost(n)
                    }
                tokens += Token(i, end, if (grammar.keys && nextNonSpace(end) == ':') TokenKind.Function else TokenKind.Str); i = end
            }
            grammar.annotations && c == '@' && code.getOrNull(i + 1)?.isLetter() == true -> {
                var j = i + 1
                while (j < n && (code[j].isLetterOrDigit() || code[j] == '_' || code[j] == '.')) j++
                tokens += Token(i, j, TokenKind.Annotation); i = j
            }
            grammar.variables && c == '$' && i + 1 < n && (code[i + 1].isLetterOrDigit() || code[i + 1] in "_{@#?") -> {
                var j = i + 1
                if (code[j] == '{') { j = code.indexOf('}', j).let { if (it < 0) n else it + 1 } }
                else if (code[j] in "@#?") j++
                else while (j < n && (code[j].isLetterOrDigit() || code[j] == '_')) j++
                tokens += Token(i, j, TokenKind.Variable); i = j
            }
            c.isDigit() && startOfWord(i) -> {
                var j = i + 1
                while (j < n && (code[j].isLetterOrDigit() || code[j] == '_' || (code[j] == '.' && code.getOrNull(j + 1)?.isDigit() == true))) j++
                tokens += Token(i, j, TokenKind.Number); i = j
            }
            c.isLetter() || c == '_' -> {
                var j = i + 1
                while (j < n && (code[j].isLetterOrDigit() || code[j] == '_' || (grammar.keys && code[j] == '-'))) j++
                val word = code.substring(i, j)
                val keyword = if (grammar.ignoreCase) word.lowercase() in grammar.keywords else word in grammar.keywords
                val kind = when {
                    grammar.keys && nextNonSpace(j) == ':' && startOfLine(code, i) -> TokenKind.Function
                    keyword -> TokenKind.Keyword
                    grammar.types && word[0].isUpperCase() && word.any(Char::isLowerCase) -> TokenKind.Type
                    !grammar.keys && grammar.types && nextNonSpace(j) == '(' -> TokenKind.Function
                    else -> null
                }
                if (kind != null) tokens += Token(i, j, kind)
                i = j
            }
            else -> i++
        }
    }
    return tokens
}

/** A YAML key sits first on its line, after indentation or a list dash. */
private fun startOfLine(code: String, at: Int): Boolean {
    var j = at - 1
    while (j >= 0 && (code[j] == ' ' || code[j] == '\t' || code[j] == '-')) j--
    return j < 0 || code[j] == '\n' || code[j] == '{' || code[j] == ','
}

private fun highlightDiff(code: String): List<Token> {
    val tokens = mutableListOf<Token>()
    var start = 0
    for (line in code.lines()) {
        val end = start + line.length
        when {
            line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") -> tokens += Token(start, end, TokenKind.Meta)
            line.startsWith("+") -> tokens += Token(start, start + 1, TokenKind.Added)
            line.startsWith("-") -> tokens += Token(start, start + 1, TokenKind.Removed)
        }
        start = end + 1
    }
    return tokens
}

@Composable fun rememberHighlighted(code: String, language: String): AnnotatedString {
    val syntax = Pocket.colors.syntax
    return remember(code, language, syntax) {
        val tokens = highlight(code, language)
        if (tokens.isEmpty()) AnnotatedString(code)
        else buildAnnotatedString {
            append(code)
            tokens.forEach { token ->
                val style = when (token.kind) {
                    TokenKind.Keyword -> SpanStyle(color = syntax.keyword, fontWeight = FontWeight.Medium)
                    TokenKind.Str -> SpanStyle(color = syntax.string)
                    TokenKind.Comment -> SpanStyle(color = syntax.comment, fontStyle = FontStyle.Italic)
                    TokenKind.Number -> SpanStyle(color = syntax.number)
                    TokenKind.Type -> SpanStyle(color = syntax.type)
                    TokenKind.Function -> SpanStyle(color = syntax.function)
                    TokenKind.Annotation, TokenKind.Variable -> SpanStyle(color = syntax.annotation)
                    TokenKind.Added -> SpanStyle(color = syntax.added, fontWeight = FontWeight.Bold)
                    TokenKind.Removed -> SpanStyle(color = syntax.removed, fontWeight = FontWeight.Bold)
                    TokenKind.Meta -> SpanStyle(color = syntax.type, fontWeight = FontWeight.Medium)
                }
                addStyle(style, token.start, token.end.coerceAtMost(code.length))
            }
        }
    }
}
