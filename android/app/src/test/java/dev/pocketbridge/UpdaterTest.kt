package dev.pocketbridge

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.nio.file.Files
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class UpdaterTest {
    @Test fun `release parser selects strict stable tag with canonical APK and checksum`() {
        val release = release("v0.4.0",
            asset("PocketBridge-0.4.0.apk", "https://github.com/20ns/pocketbridge/releases/download/v0.4.0/PocketBridge-0.4.0.apk"),
            asset("PocketBridge-0.4.0.apk.sha256", "https://github.com/20ns/pocketbridge/releases/download/v0.4.0/PocketBridge-0.4.0.apk.sha256"),
            asset("notes.txt", "https://github.com/20ns/pocketbridge/releases/download/v0.4.0/notes.txt"),
        )
        val selected = selectPocketBridgeRelease(release.toString(), "0.3.0") as ReleaseSelection.Available
        assertEquals("0.4.0", selected.release.version)
        assertTrue(selected.release.apkUrl.endsWith(".apk"))
        assertTrue(selected.release.shaUrl.endsWith(".apk.sha256"))
    }

    @Test fun `release parser distinguishes current malformed and incomplete newer releases`() {
        val same = release("v0.4.0",
            asset("PocketBridge-0.4.0.apk", "https://github.com/20ns/pocketbridge/releases/download/v0.4.0/PocketBridge-0.4.0.apk"),
            asset("PocketBridge-0.4.0.apk.sha256", "https://github.com/20ns/pocketbridge/releases/download/v0.4.0/PocketBridge-0.4.0.apk.sha256"),
        )
        val missingSha = release("v0.5.0", asset("PocketBridge-0.5.0.apk", "https://github.com/20ns/pocketbridge/releases/download/v0.5.0/PocketBridge-0.5.0.apk"))
        val malformed = release("0.5.0",
            asset("PocketBridge-0.5.0.apk", "https://github.com/20ns/pocketbridge/releases/download/v0.5.0/PocketBridge-0.5.0.apk"),
            asset("PocketBridge-0.5.0.apk.sha256", "https://github.com/20ns/pocketbridge/releases/download/v0.5.0/PocketBridge-0.5.0.apk.sha256"),
        )
        assertSame(ReleaseSelection.Current, selectPocketBridgeRelease(same.toString(), "0.4.0"))
        assertEquals(ReleaseSelection.Incomplete("0.5.0"), selectPocketBridgeRelease(missingSha.toString(), "0.4.0"))
        assertSame(ReleaseSelection.Unreadable, selectPocketBridgeRelease(malformed.toString(), "0.4.0"))
    }

    @Test fun `release parser ignores draft and prerelease updates`() {
        assertSame(ReleaseSelection.Current, selectPocketBridgeRelease(release("v0.5.0").put("draft", true).toString(), "0.4.0"))
        assertSame(ReleaseSelection.Current, selectPocketBridgeRelease(release("v0.5.0").put("prerelease", true).toString(), "0.4.0"))
    }

    @Test fun `update downloads are limited to official HTTPS URLs`() {
        assertTrue(allowedUpdateHost("https://api.github.com/repos/20ns/pocketbridge/releases/latest"))
        assertTrue(allowedUpdateHost("https://github.com/20ns/pocketbridge/releases/download/v0.4.0/PocketBridge-0.4.0.apk"))
        assertTrue(allowedUpdateHost("https://release-assets.githubusercontent.com/github-production-release-asset/file.apk?download=1"))
        listOf(
            "http://github.com/20ns/pocketbridge/releases/latest",
            "https://user:token@github.com/20ns/pocketbridge/releases/latest",
            "https://github.com:99999/20ns/pocketbridge/releases/latest",
            "https://github.com/20ns/pocketbridge/releases/latest#token",
            "https://github.evil.example/file.apk",
        ).forEach { assertFalse("Accepted unsafe URL $it", allowedUpdateHost(it)) }
    }

    @Test fun `version comparison is strict and does not subtract`() {
        assertTrue(compareVersions("0.4.0", "0.3.9") > 0)
        assertEquals(0, compareVersions("v0.4.0", "0.4.0"))
        assertTrue(compareVersions("0.4.0", "0.4.1") < 0)
        assertTrue(runCatching { compareVersions("0.4", "0.4.0") }.isFailure)
        assertTrue(runCatching { compareVersions("999999999999.0.0", "1.0.0") }.isFailure)
    }

    @Test fun `bounded copy hashes small streams and rejects over limit streams`() {
        val digest = MessageDigest.getInstance("SHA-256")
        val output = ByteArrayOutputStream()
        copyBounded(ByteArrayInputStream("hello".toByteArray()), output, 5, digest)
        assertEquals("hello", output.toString("UTF-8"))
        assertEquals(sha256("hello".toByteArray()), digest.digest().joinToString("") { "%02x".format(it) })
        assertTrue(runCatching { copyBounded(ByteArrayInputStream("hello!".toByteArray()), ByteArrayOutputStream(), 5) }.isFailure)
    }

    @Test fun `sha256 is lowercase hex`() {
        assertEquals("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", sha256("hello".toByteArray()))
    }

    @Test fun `verified download recovers after restart and keeps permission intent`() {
        val dir = Files.createTempDirectory("updates").toFile()
        try {
            val apk = java.io.File(dir, "PocketBridge-9.0.0.apk").apply { writeText("verified APK") }
            var validated = false
            val status = recoverUpdate(savedDownload(sha256(apk.readBytes())), dir, waiting = true) {
                assertEquals(apk, it)
                validated = true
            }
            assertTrue(validated)
            assertEquals(apk.absolutePath, status.apkPath)
            assertTrue(status.waitingForPermission)
            assertEquals("9.0.0", status.release?.version)
        } finally { dir.deleteRecursively() }
    }

    @Test fun `missing changed expired and invalid APKs return to Download`() {
        val dir = Files.createTempDirectory("updates").toFile()
        val apk = java.io.File(dir, "PocketBridge-9.0.0.apk")
        val record = savedDownload(sha256("verified APK".toByteArray()))
        try {
            val missing = recoverUpdate(record, dir, waiting = true) { fail("Missing APK cannot be validated") }
            apk.writeText("changed APK")
            val changed = recoverUpdate(record, dir, waiting = true) { fail("Changed bytes cannot reach Android validation") }
            assertFalse(apk.exists())
            apk.writeText("verified APK")
            apk.setLastModified(System.currentTimeMillis() - UPDATE_KEEP_MILLIS - 1000)
            val expired = recoverUpdate(record, dir, waiting = true) { fail("Expired APK cannot be validated") }
            apk.writeText("verified APK")
            val invalid = recoverUpdate(record, dir, waiting = true) { error("The update is signed with a different key.") }
            listOf(missing, changed, expired, invalid).forEach {
                assertEquals("", it.apkPath)
                assertFalse(it.waitingForPermission)
                assertNotNull(it.release)
                assertTrue(it.message.endsWith("Download again."))
            }
            assertFalse(apk.exists())
        } finally { dir.deleteRecursively() }
    }

    @Test fun `installed update and invalid saved metadata cannot become ready`() {
        val dir = Files.createTempDirectory("updates").toFile()
        try {
            val apk = java.io.File(dir, "PocketBridge-9.0.0.apk").apply { writeText("verified APK") }
            val installed = recoverUpdate(savedDownload(sha256(apk.readBytes())), dir, waiting = true, installed = "9.0.0") { fail("Installed APK cannot be reinstalled") }
            assertNull(installed.release)
            assertFalse(apk.exists())
            val invalid = recoverUpdate("{\"version\":\"../../9.0.0\"}", dir, waiting = true) { fail("Invalid metadata cannot be validated") }
            assertNull(invalid.release)
            assertEquals("", invalid.apkPath)
            assertFalse(invalid.waitingForPermission)
        } finally { dir.deleteRecursively() }
    }

    private fun savedDownload(checksum: String) = JSONObject()
        .put("version", "9.0.0")
        .put("apkUrl", "https://github.com/20ns/pocketbridge/releases/download/v9.0.0/PocketBridge-9.0.0.apk")
        .put("shaUrl", "https://github.com/20ns/pocketbridge/releases/download/v9.0.0/PocketBridge-9.0.0.apk.sha256")
        .put("checksum", checksum).toString()

    private fun release(tag: String, vararg assets: JSONObject) = JSONObject()
        .put("tag_name", tag)
        .put("draft", false)
        .put("prerelease", false)
        .put("assets", JSONArray().apply { assets.forEach(::put) })

    private fun asset(name: String, url: String) = JSONObject().put("name", name).put("browser_download_url", url)
}
