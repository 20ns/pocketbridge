package dev.pocketbridge

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * On-demand project details: the git line, "/" commands, Mac sessions and logos. Each is fetched when a screen needs
 * it, never in a loop of its own, and belongs to one pairing.
 */
class ProjectDetails(private val scope: CoroutineScope, private val api: () -> Api?, private val icons: IconCache) {
    /** Per project: last known working tree; a null value means not a repository. Kept while refreshing so nothing jumps. */
    var git by mutableStateOf<Map<String, GitInfo?>>(emptyMap()); private set
    private val gitFetchedAt = ConcurrentHashMap<String, Long>()
    /** "/" commands per project and agent, kept ten minutes. */
    var commands by mutableStateOf<Map<String, List<SlashCommand>>>(emptyMap()); private set
    var commandsLoading by mutableStateOf<Set<String>>(emptySet()); private set
    private val commandsFetchedAt = mutableMapOf<String, Long>()
    /** Claude and Codex sessions started on the Mac, per project, for Continue. */
    var sessions by mutableStateOf<Map<String, List<MacSession>>>(emptyMap()); private set
    var sessionsLoading by mutableStateOf<Set<String>>(emptySet()); private set
    /** Icons the Mac couldn't send this session, so a missing one isn't asked for on every frame. */
    private val iconMissing = ConcurrentHashMap.newKeySet<String>()
    @Volatile private var iconTags = emptyMap<String, String>()

    fun refreshGit(projectId: String, force: Boolean = false) {
        val currentApi = api() ?: return
        if (projectId.isEmpty()) return
        val now = System.currentTimeMillis()
        val last = gitFetchedAt[projectId] ?: 0
        // The Mac recomputes at most every four seconds; a negative stamp marks a request in flight.
        if (last < 0 || (!force && now - last < 4000)) return
        gitFetchedAt[projectId] = -1
        scope.launch {
            try {
                val info = withContext(Dispatchers.IO) { parseGit(currentApi.request("/api/projects/$projectId/git")) }
                if (api() === currentApi) git = git + (projectId to info)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { }
            finally { gitFetchedAt[projectId] = System.currentTimeMillis() }
        }
    }

    fun loadCommands(projectId: String, agent: String) {
        val currentApi = api() ?: return
        val key = "$projectId:$agent"
        if (projectId.isEmpty() || key in commandsLoading || System.currentTimeMillis() - (commandsFetchedAt[key] ?: 0) < 10 * 60_000) return
        commandsLoading = commandsLoading + key
        scope.launch {
            try {
                val list = withContext(Dispatchers.IO) { parseCommands(currentApi.request("/api/projects/$projectId/commands?agent=$agent")) }
                if (api() === currentApi) { commands = commands + (key to list); commandsFetchedAt[key] = System.currentTimeMillis() }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { commandsFetchedAt[key] = System.currentTimeMillis() - 9 * 60_000 }
            finally { commandsLoading = commandsLoading - key }
        }
    }

    fun refreshSessions(projectId: String) {
        val currentApi = api() ?: return
        if (projectId.isEmpty() || projectId in sessionsLoading) return
        sessionsLoading = sessionsLoading + projectId
        scope.launch {
            try {
                val list = withContext(Dispatchers.IO) { parseSessions(currentApi.request("/api/projects/$projectId/sessions")) }
                if (api() === currentApi) sessions = sessions + (projectId to list)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { }
            finally { sessionsLoading = sessionsLoading - projectId }
        }
    }

    /** A continued session became a chat here; it leaves the "On your Mac" list. */
    fun forgetSession(projectId: String, sessionId: String) {
        sessions = sessions + (projectId to sessions[projectId].orEmpty().filter { it.id != sessionId })
    }

    /** The project's logo on disk, fetched once per version tag. Null when the Mac has none or can't send it. */
    suspend fun iconFile(projectId: String, tag: String): File? {
        val file = icons.file(projectId, tag)
        if (file.isFile) return file
        val currentApi = api() ?: return null
        val key = "$projectId:$tag"
        if (key in iconMissing) return null
        return withContext(Dispatchers.IO) {
            runCatching {
                val bytes = currentApi.bytes("/api/projects/$projectId/icon", limit = 2L * 1024 * 1024)
                // A tag replaced while this was on its way is already pruned; don't bring it back.
                if (api() === currentApi && iconTags[projectId] == tag) icons.put(projectId, tag, bytes)
                file.takeIf { it.isFile }
            // Only a definite "no icon" is remembered; a dropped connection tries again once the Mac is back.
            }.onFailure { if (it is ApiError && it.status == 404) iconMissing += key }.getOrNull()
        }
    }

    /** After a state snapshot: forget logos whose project is gone or whose tag changed. */
    fun projectsChanged(projects: Map<String, String>) {
        if (projects == iconTags) return
        iconTags = projects
        // Prunes against the newest tags when it runs, so an older snapshot's prune can't delete a newer logo.
        scope.launch(Dispatchers.IO) { icons.keepOnly(iconTags) }
    }

    fun clear() {
        git = emptyMap(); gitFetchedAt.clear(); commands = emptyMap(); commandsFetchedAt.clear(); sessions = emptyMap()
        iconMissing.clear(); iconTags = emptyMap()
        scope.launch(Dispatchers.IO) { icons.clear() }
    }
}

/** A Unicode letter (\p{L}) or number (\p{N}: digits, letter numbers like Ⅳ, other numbers), by code point. */
private fun letterOrNumber(codePoint: Int) = Character.isLetter(codePoint) || when (Character.getType(codePoint).toByte()) {
    Character.DECIMAL_DIGIT_NUMBER, Character.LETTER_NUMBER, Character.OTHER_NUMBER -> true
    else -> false
}

/**
 * Why a folder name won't do on the Mac, in the Mac's own rules (/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u, no trailing dot
 * or space, at most 64 UTF-16 units like its JavaScript length), or null when it's fine. Checked by code point, so
 * letters outside the basic plane count as one letter. Surrounding spaces are trimmed before sending.
 */
fun projectNameProblem(name: String): String? {
    val trimmed = name.trim()
    val points = trimmed.codePoints().toArray()
    return when {
        points.isEmpty() -> "Name the project."
        trimmed.length > 64 -> "Use 64 characters or fewer."
        !letterOrNumber(points.first()) -> "Start with a letter or number."
        trimmed.endsWith('.') -> "Don't end with a dot."
        points.any { !(letterOrNumber(it) || it == ' '.code || it == '.'.code || it == '_'.code || it == '-'.code) } -> "Use letters, numbers, spaces, dots, dashes and underscores."
        else -> null
    }
}

/** One try at making a project folder. Its [id] goes with every retry of the same name, so a lost answer makes no second folder. */
data class ProjectAttempt(val id: String, val name: String) {
    fun store() = JSONObject().put("id", id).put("name", name).toString()
    companion object {
        fun parse(value: String) = runCatching { JSONObject(value).let { ProjectAttempt(it.getString("id"), it.getString("name")) } }.getOrNull()
    }
}

/** The saved attempt when it was for this same name and is still unanswered; otherwise a new one. */
fun projectAttempt(saved: String, name: String, newId: () -> String = { UUID.randomUUID().toString() }): ProjectAttempt =
    saved.takeIf { it.isNotBlank() }?.let(ProjectAttempt::parse)?.takeIf { it.name == name } ?: ProjectAttempt(newId(), name)

/** Projects for starting a chat: most recently active first, then by name; [query] matches name or folder. */
fun projectsByActivity(projects: List<JSONObject>, chats: List<JSONObject>, query: String = ""): List<JSONObject> {
    val newest = chats.groupBy { it.optString("projectId") }.mapValues { (_, list) -> list.maxOf { it.optLong("updatedAt") } }
    fun activity(project: JSONObject) = projectActivity(project.optLong("lastUsedAt"), newest[project.optString("id")] ?: 0L)
    return folderProjects(projects).filter { query.isBlank() || matchesProject(query, it.optString("name"), it.optString("path")) }
        .sortedWith(Comparator { a, b -> compareProjectActivity(activity(a), a.optString("name"), activity(b), b.optString("name"), newest = true) })
}

/** The Mac's General project: chats that belong to no folder (computer use, questions). Older Macs have none. */
fun isGeneral(project: JSONObject?) = project?.optBoolean("general") == true
fun generalProject(projects: List<JSONObject>): JSONObject? = projects.firstOrNull(::isGeneral)
/** Folders only: General has its own entry and its own option, never a row among them. */
fun folderProjects(projects: List<JSONObject>): List<JSONObject> = projects.filterNot(::isGeneral)
