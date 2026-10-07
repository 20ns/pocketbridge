package dev.pocketbridge

import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class CleanupTest {
    @Test fun `distinct transcript snapshots with matching string hashes are saved`() {
        val dir = Files.createTempDirectory("transcripts").toFile()
        try {
            val cache = TranscriptCache(dir)
            val first = "{\"messages\":[{\"text\":\"Aa\"}]}"
            val next = "{\"messages\":[{\"text\":\"BB\"}]}"
            assertEquals(first.hashCode(), next.hashCode())
            cache.write("chat", first)
            cache.write("chat", next)
            assertEquals(next, cache.read("chat"))
        } finally { dir.deleteRecursively() }
    }

    @Test fun `downloaded updates go once installed, unreadable or stale`() {
        val hour = 3_600_000L
        // Installed: the running app is this version or newer.
        assertTrue(staleUpdate(installedCode = 10, apkCode = 10, ageMillis = hour))
        assertTrue(staleUpdate(installedCode = 11, apkCode = 10, ageMillis = hour))
        // Waiting for Install: kept for a while.
        assertFalse(staleUpdate(installedCode = 9, apkCode = 10, ageMillis = hour))
        assertTrue(staleUpdate(installedCode = 9, apkCode = 10, ageMillis = UPDATE_KEEP_MILLIS + 1))
        // Partial or corrupt files Android can't read.
        assertTrue(staleUpdate(installedCode = 9, apkCode = null, ageMillis = 0))
    }

    @Test fun `transcripts of chats the Mac no longer lists are dropped`() {
        val dir = Files.createTempDirectory("transcripts").toFile()
        val cache = TranscriptCache(dir)
        cache.write("a", "{}"); cache.write("b", "{}"); cache.write("c/../x", "{}")
        cache.keepOnly(setOf("a"))
        assertEquals("{}", cache.read("a"))
        assertEquals("", cache.read("b"))
        assertEquals(listOf("a.json"), dir.list()!!.toList())
        // A pruned chat that comes back is written again rather than skipped as unchanged.
        cache.write("b", "{}")
        assertEquals("{}", cache.read("b"))
        dir.deleteRecursively()
    }

    @Test fun `project icons keep only each project's current version`() {
        val dir = Files.createTempDirectory("icons").toFile()
        val icons = IconCache(dir)
        icons.put("p1", "v1", byteArrayOf(1)); icons.put("p1", "v2", byteArrayOf(2)); icons.put("p2", "v1", byteArrayOf(3))
        icons.keepOnly(mapOf("p1" to "v2"))
        assertEquals(setOf(icons.file("p1", "v2").name), dir.list()!!.toSet())
        assertArrayEquals(byteArrayOf(2), icons.file("p1", "v2").readBytes())
        // Tags and ids can't escape the folder.
        assertEquals(dir, icons.file("../p", "../../t").parentFile)
        dir.deleteRecursively()
    }

    @Test fun `project colours are stable, in range and varied`() {
        assertEquals(projectHue("8f1c2e0a-project", 8), projectHue("8f1c2e0a-project", 8))
        val ids = (0 until 200).map { "project-$it" }
        assertTrue(ids.all { projectHue(it, 8) in 0 until 8 })
        // Every colour gets used across a realistic number of projects, none by more than a third of them.
        val counts = ids.groupingBy { projectHue(it, 8) }.eachCount()
        assertEquals(8, counts.size)
        assertTrue(counts.values.max() < ids.size / 3)
        assertEquals(0, projectHue("", 1))
    }
}
