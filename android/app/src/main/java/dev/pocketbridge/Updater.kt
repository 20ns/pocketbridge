package dev.pocketbridge

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.ResponseBody
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

private const val LatestRelease = "https://api.github.com/repos/20ns/pocketbridge/releases/latest"
private const val GitHubJson = "application/vnd.github+json"
private const val OctetStream = "application/octet-stream"
private const val MaxReleaseJsonBytes = 1L * 1024L * 1024L
private const val MaxChecksumBytes = 4L * 1024L
// ponytail: 100 MB is enough for this app's signed APK; raise it if release artifacts grow past that.
private const val MaxApkBytes = 100L * 1024L * 1024L

data class UpdateRelease(val version: String, val apkUrl: String, val shaUrl: String)
data class UpdateStatus(
    val installed: String = BuildConfig.VERSION_NAME,
    val latest: String = "",
    val message: String = "Not checked",
    val release: UpdateRelease? = null,
    val apkPath: String = "",
    val waitingForPermission: Boolean = false,
)

data class VersionParts(val major: Int, val minor: Int, val patch: Int) : Comparable<VersionParts> {
    override fun compareTo(other: VersionParts) = compareValuesBy(this, other, VersionParts::major, VersionParts::minor, VersionParts::patch)
    override fun toString() = "$major.$minor.$patch"
}

private val VersionPattern = Regex("""v?(\d+)\.(\d+)\.(\d+)""")
fun parseVersion(value: String) = VersionPattern.matchEntire(value.trim())?.destructured?.let { (major, minor, patch) ->
    VersionParts(major.toIntOrNull() ?: return@let null, minor.toIntOrNull() ?: return@let null, patch.toIntOrNull() ?: return@let null)
} ?: throw IllegalArgumentException("Use vX.Y.Z or X.Y.Z.")
fun compareVersions(left: String, right: String) = parseVersion(left).compareTo(parseVersion(right))

fun allowedUpdateHost(url: String): Boolean = runCatching {
    val uri = URI(url)
    val host = uri.host?.lowercase() ?: return@runCatching false
    val authority = uri.rawAuthority?.lowercase() ?: return@runCatching false
    uri.scheme == "https" &&
        uri.userInfo == null &&
        uri.fragment == null &&
        (uri.port == -1 || uri.port == 443) &&
        (authority == host || authority == "$host:443") &&
        host in setOf("api.github.com", "github.com", "release-assets.githubusercontent.com")
}.getOrDefault(false)

sealed class ReleaseSelection {
    data class Available(val release: UpdateRelease) : ReleaseSelection()
    data class Incomplete(val version: String) : ReleaseSelection()
    data object Current : ReleaseSelection()
    data object Unreadable : ReleaseSelection()
}

fun selectPocketBridgeRelease(json: String, installed: String): ReleaseSelection = runCatching {
    val release = JSONObject(json)
    if (release.optBoolean("draft") || release.optBoolean("prerelease")) return ReleaseSelection.Current
    val tag = release.optString("tag_name")
    if (!tag.startsWith("v")) return ReleaseSelection.Unreadable
    val version = parseVersion(tag)
    if (version <= parseVersion(installed)) return ReleaseSelection.Current
    val assets = release.optJSONArray("assets") ?: return ReleaseSelection.Incomplete(version.toString())
    fun assetUrl(name: String) = (0 until assets.length()).asSequence()
        .map { assets.getJSONObject(it) }
        .firstOrNull { it.optString("name") == name }
        ?.optString("browser_download_url")
        ?.takeIf(::allowedUpdateHost)
    val apkName = "PocketBridge-$version.apk"
    val apk = assetUrl(apkName) ?: return ReleaseSelection.Incomplete(version.toString())
    val sha = assetUrl("$apkName.sha256") ?: return ReleaseSelection.Incomplete(version.toString())
    ReleaseSelection.Available(UpdateRelease(version.toString(), apk, sha))
}.getOrDefault(ReleaseSelection.Unreadable)

fun copyBounded(input: InputStream, output: OutputStream, maxBytes: Long, digest: MessageDigest? = null): Long {
    val buffer = ByteArray(8 * 1024)
    var total = 0L
    while (true) {
        val read = input.read(buffer)
        if (read == -1) break
        total += read
        require(total <= maxBytes) { "The update is too large." }
        digest?.update(buffer, 0, read)
        output.write(buffer, 0, read)
    }
    return total
}

/** Downloaded updates are kept this long at most; after that a fresh check downloads again. */
const val UPDATE_KEEP_MILLIS = 3L * 24 * 60 * 60 * 1000

/**
 * Whether a downloaded APK can go: Android couldn't read it, this version or a newer one is installed (the update
 * went in), or it has waited too long to be installed.
 */
fun staleUpdate(installedCode: Long, apkCode: Long?, ageMillis: Long) = apkCode == null || apkCode <= installedCode || ageMillis > UPDATE_KEEP_MILLIS

fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

/** Only a completed, checksum-verified download has a record. Recheck bytes and Android's signing rules on reuse. */
internal fun recoverUpdate(record: String, dir: File, waiting: Boolean, installed: String = BuildConfig.VERSION_NAME, validate: (File) -> Unit): UpdateStatus {
    if (record.isBlank()) return UpdateStatus()
    val saved = runCatching {
        val json = JSONObject(record)
        val release = UpdateRelease(parseVersion(json.getString("version")).toString(), json.getString("apkUrl"), json.getString("shaUrl"))
        require(allowedUpdateHost(release.apkUrl) && allowedUpdateHost(release.shaUrl))
        val checksum = json.getString("checksum")
        require(Regex("[0-9a-f]{64}").matches(checksum))
        release to checksum
    }.getOrElse { return UpdateStatus(message = "Saved update could not be read. Check again.") }
    val (release, expected) = saved
    val apk = File(dir, "PocketBridge-${release.version}.apk")
    if (compareVersions(release.version, installed) <= 0) {
        apk.delete()
        return UpdateStatus(message = "You have the latest version.")
    }
    val status = UpdateStatus(latest = release.version, release = release)
    return runCatching {
        require(apk.isFile) { "The downloaded update is missing." }
        require(System.currentTimeMillis() - apk.lastModified() <= UPDATE_KEEP_MILLIS) { "The downloaded update expired." }
        val digest = MessageDigest.getInstance("SHA-256")
        apk.inputStream().use { input ->
            copyBounded(input, object : OutputStream() {
                override fun write(value: Int) {}
                override fun write(bytes: ByteArray, offset: Int, count: Int) {}
            }, MaxApkBytes, digest)
        }
        require(digest.digest().joinToString("") { "%02x".format(it) } == expected) { "The update checksum did not match." }
        validate(apk)
        status.copy(message = "Update ready to install.", apkPath = apk.absolutePath, waitingForPermission = waiting)
    }.getOrElse { failure ->
        apk.delete()
        status.copy(message = "${failureReason(failure)} Download again.")
    }
}

class Updater(private val context: Context) {
    private val saved = context.getSharedPreferences("updates", Context.MODE_PRIVATE)
    private val dir = File(context.cacheDir, "updates")
    private val client = OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false)
        .callTimeout(120, TimeUnit.SECONDS).connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS)
        .build()

    suspend fun check(): UpdateStatus {
        val text = fetchText(LatestRelease, MaxReleaseJsonBytes, GitHubJson)
        return when (val selection = selectPocketBridgeRelease(text, BuildConfig.VERSION_NAME)) {
            is ReleaseSelection.Available -> UpdateStatus(latest = selection.release.version, message = "Version ${selection.release.version} is available.", release = selection.release)
            is ReleaseSelection.Incomplete -> UpdateStatus(message = "Latest update is still being published. Try again shortly.")
            ReleaseSelection.Current -> UpdateStatus(message = "You have the latest version.")
            ReleaseSelection.Unreadable -> UpdateStatus(message = "Latest update is unreadable. Try again shortly.")
        }
    }

    suspend fun download(release: UpdateRelease): UpdateStatus {
        require(allowedUpdateHost(release.apkUrl) && allowedUpdateHost(release.shaUrl)) { "Update assets must come from GitHub." }
        val expected = fetchText(release.shaUrl, MaxChecksumBytes, OctetStream).trim().substringBefore(' ').lowercase()
        require(Regex("[0-9a-f]{64}").matches(expected)) { "The update checksum is unreadable." }
        dir.deleteRecursively(); dir.mkdirs()
        check(saved.edit().clear().commit()) { "Could not save update state." }
        val apk = File(dir, "PocketBridge-${release.version}.apk")
        runCatching {
            val actual = fetchFile(release.apkUrl, apk)
            require(actual == expected) { "The update checksum did not match." }
            validateApk(apk)
            val record = JSONObject().put("version", release.version).put("apkUrl", release.apkUrl).put("shaUrl", release.shaUrl).put("checksum", expected)
            check(saved.edit().putString("ready", record.toString()).commit()) { "Could not save update state." }
        }.onFailure { apk.delete() }.getOrThrow()
        return UpdateStatus(latest = release.version, message = "Update ready to install.", release = release, apkPath = apk.absolutePath)
    }

    /** Deletes downloaded APKs that are installed, unreadable or stale, and any partial files. Runs on an IO thread. */
    fun cleanup() {
        val files = dir.listFiles() ?: return
        val pm = context.packageManager
        val installed = runCatching { pm.getPackageInfo(BuildConfig.APPLICATION_ID, 0).longVersion() }.getOrNull() ?: return
        files.forEach { file ->
            val code = if (file.isFile && file.name.endsWith(".apk")) runCatching { pm.getPackageArchiveInfo(file.absolutePath, 0)?.longVersion() }.getOrNull() else null
            if (staleUpdate(installed, code, System.currentTimeMillis() - file.lastModified())) file.deleteRecursively()
        }
        if (dir.listFiles().isNullOrEmpty()) dir.delete()
    }

    fun restore(): UpdateStatus {
        cleanup()
        val record = saved.getString("ready", "").orEmpty()
        if (record.isBlank()) dir.deleteRecursively()
        val status = recoverUpdate(record, dir, saved.getBoolean("permission", false), validate = ::validateApk)
        if (status.release == null) saved.edit().clear().apply()
        else if (status.apkPath.isBlank()) saved.edit().remove("permission").apply()
        return status
    }

    suspend fun install(): UpdateStatus {
        val status = withContext(Dispatchers.IO) { restore() }
        if (status.apkPath.isBlank()) return status
        val apk = File(status.apkPath)
        if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls()) {
            withContext(Dispatchers.IO) { check(saved.edit().putBoolean("permission", true).commit()) { "Could not save update state." } }
            context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${BuildConfig.APPLICATION_ID}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return status.copy(message = "Allow installs from PocketBridge, then return to continue.", waitingForPermission = true)
        }
        withContext(Dispatchers.IO) { check(saved.edit().remove("permission").commit()) { "Could not save update state." } }
        val uri = FileProvider.getUriForFile(context, "${BuildConfig.APPLICATION_ID}.files", apk)
        context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION))
        return status.copy(message = "Android will ask before installing.", waitingForPermission = false)
    }

    private suspend fun fetchText(url: String, maxBytes: Long, accept: String) = String(fetchBytes(url, maxBytes, accept), Charsets.UTF_8)

    private suspend fun fetchBytes(url: String, maxBytes: Long, accept: String) = fetchBody(url, maxBytes, accept) { body ->
        body.byteStream().use { input ->
            val output = ByteArrayOutputStream()
            copyBounded(input, output, maxBytes)
            output.toByteArray()
        }
    }

    private suspend fun fetchFile(url: String, file: File) = fetchBody(url, MaxApkBytes, OctetStream) { body ->
        val digest = MessageDigest.getInstance("SHA-256")
        body.byteStream().use { input -> file.outputStream().use { output -> copyBounded(input, output, MaxApkBytes, digest) } }
        digest.digest().joinToString("") { "%02x".format(it) }
    }

    private suspend fun <T> fetchBody(url: String, maxBytes: Long, accept: String, read: (ResponseBody) -> T): T {
        require(allowedUpdateHost(url)) { "Update downloads must come from GitHub." }
        var current = url
        repeat(5) {
            val result: T? = client.newCall(Request.Builder().url(current).header("Accept", accept).build()).consume { response ->
                if (response.code in 300..399) {
                    current = response.header("Location")?.takeIf(::allowedUpdateHost) ?: error("GitHub redirected to an unexpected host.")
                    null
                } else {
                    require(response.isSuccessful) { "GitHub returned ${response.code}." }
                    val body = response.body ?: error("GitHub returned an empty update.")
                    body.contentLength().takeIf { it > maxBytes }?.let { error("The update is too large.") }
                    read(body)
                }
            }
            if (result != null) return result
        }
        error("GitHub redirected too many times.")
    }

    private fun validateApk(file: File) {
        val pm = context.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val archive = pm.getPackageArchiveInfo(file.absolutePath, flags) ?: error("Android could not read the APK.")
        require(archive.packageName == BuildConfig.APPLICATION_ID) { "The update is for a different app." }
        require(archive.longVersion() > pm.getPackageInfo(BuildConfig.APPLICATION_ID, 0).longVersion()) { "The downloaded APK is not newer." }
        val archiveCerts = archive.certificates()
        val installedCerts = pm.getPackageInfo(BuildConfig.APPLICATION_ID, flags).certificates()
        require(archiveCerts.isNotEmpty() && archiveCerts == installedCerts) { "The update is signed with a different key." }
    }
}

private fun PackageInfo.longVersion() = if (Build.VERSION.SDK_INT >= 28) longVersionCode else @Suppress("DEPRECATION") versionCode.toLong()
private fun PackageInfo.certificates(): Set<String> = if (Build.VERSION.SDK_INT >= 28) signingInfo?.apkContentsSigners.orEmpty().map { sha256(it.toByteArray()) }.toSet()
else @Suppress("DEPRECATION") signatures.orEmpty().map { sha256(it.toByteArray()) }.toSet()

/** Settings' Updates row: check, download and install the public signed APK, one step at a time. */
class UpdateModel(private val context: Context, private val scope: CoroutineScope) {
    private val updater = Updater(context)
    var busy by mutableStateOf(false); private set
    var status by mutableStateOf(UpdateStatus()); private set

    init { step {
        status = withContext(Dispatchers.IO) { updater.restore() }
        if (status.waitingForPermission && context.packageManager.canRequestPackageInstalls()) status = updater.install()
    } }

    fun check() = step {
        status = withContext(Dispatchers.IO) {
            val checked = updater.check()
            val ready = updater.restore()
            if (ready.apkPath.isNotBlank() && checked.release == ready.release) ready else checked
        }
    }
    fun download() = step {
        val release = status.release ?: error("Check for an update first.")
        status = withContext(Dispatchers.IO) { updater.download(release) }
    }
    fun install() = step { status = updater.install() }
    /** Back from Android's install permission screen: carry on if it was granted. */
    fun resume() {
        if (busy || status.apkPath.isBlank()) return
        step {
            status = withContext(Dispatchers.IO) { updater.restore() }
            if (status.waitingForPermission && context.packageManager.canRequestPackageInstalls()) status = updater.install()
        }
    }

    private fun step(block: suspend () -> Unit) {
        if (busy) return
        busy = true
        scope.launch {
            try { block() } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { status = status.copy(message = failureReason(failure)) }
            finally { busy = false }
        }
    }
}
