package dev.pocketbridge

import java.io.File
import java.util.concurrent.ConcurrentHashMap

private fun safeName(id: String) = id.replace(Regex("[^A-Za-z0-9-]"), "_")

/** Last-known transcripts for offline reading, one file per chat. Unchanged snapshots are not rewritten. */
class TranscriptCache(private val dir: File) {
    private val written = ConcurrentHashMap<String, Int>()
    private fun file(id: String) = File(dir, safeName(id) + ".json")
    fun read(id: String): String = runCatching { file(id).takeIf { it.isFile }?.readText().orEmpty() }.getOrDefault("")
    fun write(id: String, text: String) {
        if (written[id] == text.hashCode()) return
        runCatching {
            dir.mkdirs()
            val temporary = File(dir, file(id).name + ".tmp")
            temporary.writeText(text)
            if (!temporary.renameTo(file(id))) temporary.delete() else written[id] = text.hashCode()
        }
    }
    fun remove(id: String) { written.remove(id); file(id).delete() }
    /** Drops transcripts of chats the Mac no longer lists, such as ones deleted from another client. */
    fun keepOnly(ids: Set<String>) {
        val names = ids.map { file(it).name }.toSet()
        dir.listFiles().orEmpty().filter { it.name !in names }.forEach { stale ->
            written.keys.removeAll { file(it).name == stale.name }
            stale.delete()
        }
    }
    fun clear() { written.clear(); dir.deleteRecursively() }
}

/** Project logos as the Mac sent them, one file per project and icon version tag. Writes and pruning never interleave. */
class IconCache(private val dir: File) {
    fun file(projectId: String, tag: String) = File(dir, safeName(projectId) + "__" + safeName(tag))
    @Synchronized fun put(projectId: String, tag: String, bytes: ByteArray) {
        dir.mkdirs()
        val target = file(projectId, tag)
        val temporary = File(dir, target.name + ".tmp")
        temporary.writeBytes(bytes)
        if (!temporary.renameTo(target)) temporary.delete()
    }
    /** Keeps only the current icon of each listed project; older versions and removed projects go. */
    @Synchronized fun keepOnly(current: Map<String, String>) {
        val names = current.map { (id, tag) -> file(id, tag).name }.toSet()
        dir.listFiles().orEmpty().filter { it.name !in names }.forEach { it.delete() }
    }
    @Synchronized fun clear() { dir.deleteRecursively() }
}
