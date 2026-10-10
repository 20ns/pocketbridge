// The framework ExifInterface reads streams reliably on API 26+, the minimum here; no extra dependency needed.
@file:SuppressLint("ExifInterface")

package dev.pocketbridge

import android.annotation.SuppressLint

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.util.LruCache
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.ui.platform.LocalView
import androidx.core.graphics.createBitmap
import androidx.core.graphics.scale
import androidx.core.view.WindowCompat
import java.io.File
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

@OptIn(ExperimentalCoroutinesApi::class)
private val imagePreparation = Dispatchers.IO.limitedParallelism(1)

/** Picker and share preparations use one worker, so eight photos never decode eight full bitmaps together. */
internal suspend fun prepareImages(files: List<File>, prepare: (Int, File) -> Boolean): List<String> = try {
    withContext(imagePreparation) {
        files.mapIndexedNotNull { index, file ->
            ensureActive()
            if (prepare(index, file)) file.path else { file.delete(); File(file.path + ".tmp").delete(); null }
        }.also { ensureActive() }
    }
} catch (failure: Throwable) {
    withContext(NonCancellable + Dispatchers.IO) { files.forEach { it.delete(); File(it.path + ".tmp").delete() } }
    throw failure
}

/** Screenshots stay readable at 2048 px on the long side; JPEG 85 keeps them a few hundred KB over Tailscale. */
const val UPLOAD_MAX_SIDE = 2048
private const val UPLOAD_QUALITY = 85

/** The largest power-of-two sample that keeps the longest side at or above [maxSide], so the final scale only shrinks. */
fun sampleSize(width: Int, height: Int, maxSide: Int): Int {
    var sample = 1
    val longest = maxOf(width, height)
    while (longest / (sample * 2) >= maxSide) sample *= 2
    return sample
}

/** Width and height with the longest side at most [maxSide], keeping the aspect ratio. */
fun scaledSize(width: Int, height: Int, maxSide: Int): Pair<Int, Int> {
    val longest = maxOf(width, height)
    if (longest <= maxSide) return width to height
    val scale = maxSide.toDouble() / longest
    return maxOf(1, (width * scale).roundToInt()) to maxOf(1, (height * scale).roundToInt())
}

private fun decode(open: () -> java.io.InputStream?, sample: Int): Bitmap? {
    var size = sample
    // A huge photo may not fit at the first sample; halve again rather than fail.
    repeat(4) {
        try { return open()?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = size }) } }
        catch (_: OutOfMemoryError) { size *= 2 }
    }
    return null
}

private fun upright(bitmap: Bitmap, orientation: Int): Bitmap {
    val matrix = Matrix()
    when (orientation) {
        ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
        ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
        ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
        ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
        ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
        ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.setRotate(-90f); matrix.postScale(-1f, 1f) }
        ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
        else -> return bitmap
    }
    return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
}

private fun fit(bitmap: Bitmap, maxSide: Int): Bitmap {
    val (width, height) = scaledSize(bitmap.width, bitmap.height, maxSide)
    return if (width == bitmap.width && height == bitmap.height) bitmap else bitmap.scale(width, height)
}

/** Owns [bitmap]; shrink before EXIF copies it, then recycle every replaced intermediate. */
internal fun fitUpright(bitmap: Bitmap, orientation: Int, maxSide: Int): Bitmap {
    var image = bitmap
    try {
        val fitted = fit(image, maxSide)
        if (fitted !== image) image.recycle()
        image = fitted
        val rotated = upright(image, orientation)
        if (rotated !== image) image.recycle()
        return rotated
    } catch (failure: Throwable) { image.recycle(); throw failure }
}

private fun orientation(open: () -> java.io.InputStream?) = runCatching {
    open()?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
}.getOrNull() ?: ExifInterface.ORIENTATION_NORMAL

/**
 * Reads a picked or shared image, turns it upright, fits it in [UPLOAD_MAX_SIDE] and writes a JPEG to [out].
 * Runs on an IO thread. False when the source isn't a readable image.
 */
fun prepareImage(resolver: ContentResolver, uri: Uri, out: File): Boolean = runCatching {
    val open = { resolver.openInputStream(uri) }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    open()?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return false
    val decoded = decode(open, sampleSize(bounds.outWidth, bounds.outHeight, UPLOAD_MAX_SIDE)) ?: return false
    var image = fitUpright(decoded, orientation(open), UPLOAD_MAX_SIDE)
    try {
        // JPEG has no transparency; a transparent PNG sits on white instead.
        if (image.hasAlpha()) {
            val flat = createBitmap(image.width, image.height)
            Canvas(flat).apply { drawColor(android.graphics.Color.WHITE); drawBitmap(image, 0f, 0f, null) }
            image.recycle(); image = flat
        }
        out.parentFile?.mkdirs()
        val temporary = File(out.path + ".tmp")
        temporary.outputStream().use { check(image.compress(Bitmap.CompressFormat.JPEG, UPLOAD_QUALITY, it)) }
        temporary.renameTo(out)
    } finally { image.recycle() }
}.getOrDefault(false)

/**
 * Images by upload id: a small in-memory cache of decoded bitmaps per display size, and the original bytes on disk
 * under the app's cache folder, so a transcript never downloads a screenshot twice.
 */
class ImageCache(private val dir: File) {
    private val memory = object : LruCache<String, Bitmap>((Runtime.getRuntime().maxMemory() / 1024 / 8).toInt().coerceAtMost(48 * 1024)) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount / 1024
    }
    fun cached(key: String): Bitmap? = memory.get(key)
    fun file(id: String) = File(dir, id.filter { it.isLetterOrDigit() || it == '-' })

    /** Saves an image the phone already has (an upload it just sent), trimming the folder past 64 MB. */
    fun put(id: String, bytes: ByteArray) = runCatching {
        dir.mkdirs()
        val temporary = File(dir, file(id).name + ".tmp")
        temporary.writeBytes(bytes)
        temporary.renameTo(file(id))
        val files = dir.listFiles().orEmpty().filter { it != file(id) }.sortedBy { it.lastModified() }
        var total = files.sumOf { it.length() } + bytes.size
        if (total > 64L * 1024 * 1024) for (old in files) { if (total <= 48L * 1024 * 1024) break; total -= old.length(); old.delete() }
    }

    /** Decodes [source]'s file sampled for [maxPx] off the main thread. Null when it can't be read. */
    suspend fun load(key: String, maxPx: Int, source: suspend () -> File?): Bitmap? {
        memory.get(key)?.let { return it }
        val file = source() ?: return null
        return withContext(Dispatchers.IO) {
            runCatching {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(file.path, bounds)
                if (bounds.outWidth <= 0) return@runCatching null
                val decoded = decode({ file.inputStream() }, sampleSize(bounds.outWidth, bounds.outHeight, maxPx)) ?: return@runCatching null
                fitUpright(decoded, orientation { file.inputStream() }, maxPx)
            }.getOrNull()
        }?.also { memory.put(key, it) }
    }

    fun clear() { memory.evictAll(); dir.deleteRecursively() }
}

private sealed interface Loaded { data object Loading : Loaded; data object Failed : Loaded; data class Done(val bitmap: Bitmap) : Loaded }

/** One image, fetched and decoded off the main thread; a tonal block while loading and a mark when it can't load. */
@Composable private fun CachedImage(key: String, description: String?, modifier: Modifier, scale: ContentScale, placeholder: Color, fit: Boolean = false, online: Boolean = false, retryable: Boolean = false, load: suspend () -> Bitmap?) {
    var retry by remember(key) { mutableIntStateOf(0) }
    val state by produceState<Loaded>(Loaded.Loading, key, online, retry) {
        value = Loaded.Loading
        value = load()?.let { Loaded.Done(it) } ?: Loaded.Failed
    }
    // [fit]: one prompt image keeps its own shape inside a bounded box, so a tall screenshot stays a tall thumbnail.
    fun Modifier.bounded(ratio: Float) = if (fit) widthIn(max = 220.dp).heightIn(max = 280.dp).aspectRatio(ratio) else this
    when (val shown = state) {
        is Loaded.Done -> Image(shown.bitmap.asImageBitmap(), description, modifier.bounded(shown.bitmap.width.toFloat() / shown.bitmap.height.coerceAtLeast(1)), contentScale = scale)
        Loaded.Loading -> Box(modifier.bounded(0.75f).background(placeholder).semantics { description?.let { contentDescription = it } })
        Loaded.Failed -> Box(modifier.bounded(1f).background(placeholder).semantics { contentDescription = "Image unavailable" }, contentAlignment = Alignment.Center) {
            if (retryable) Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Image unavailable", color = Color.White, style = MaterialTheme.typography.bodyMedium)
                IconButton(onClick = { retry++ }) { Icon(PocketIcons.Reset, "Retry image", tint = Color.White) }
            } else Icon(PocketIcons.BrokenImage, null, Modifier.size(Sizes.smallIcon), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** An image the Mac holds, by upload id. */
@Composable fun UploadedImage(
    model: BridgeModel, id: String, maxPx: Int, modifier: Modifier = Modifier, description: String? = "Image", scale: ContentScale = ContentScale.Crop,
    placeholder: Color = MaterialTheme.colorScheme.surfaceContainerHigh, fit: Boolean = false, retryable: Boolean = false,
) {
    val key = "u:$id@$maxPx"
    CachedImage(key, description, modifier, if (fit) ContentScale.Fit else scale, placeholder, fit, model.online, retryable) { model.images.load(key, maxPx) { model.uploadFile(id) } }
}

/** A prepared image still on this phone. */
@Composable fun LocalImage(model: BridgeModel, path: String, maxPx: Int, modifier: Modifier = Modifier, description: String? = "Image") {
    val key = "f:$path@$maxPx"
    CachedImage(key, description, modifier, ContentScale.Crop, MaterialTheme.colorScheme.surfaceContainerHigh) { model.images.load(key, maxPx) { File(path).takeIf { it.isFile } } }
}

/** Opens the full-screen viewer on a prompt's images at one of them. Provided by the app shell. */
val LocalImageViewer = staticCompositionLocalOf<(List<String>, Int) -> Unit> { { _, _ -> } }

/**
 * Full screen over everything, black, pinch to zoom and pan, double tap to zoom. Swipes between a prompt's images.
 * The back gesture shrinks it away like any page; a back arrow and image count keep navigation visible.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable fun ImageViewer(model: BridgeModel, ids: List<String>, start: Int, onDismiss: () -> Unit) {
    val pages = rememberPagerState(start) { ids.size }
    val maxPx = with(LocalDensity.current) { LocalConfiguration.current.screenHeightDp.dp.roundToPx() }.coerceAtMost(UPLOAD_MAX_SIDE)
    var back by remember { mutableFloatStateOf(0f) }
    PredictiveBackHandler { events ->
        try { events.collect { back = it.progress }; onDismiss() } catch (cancelled: kotlin.coroutines.cancellation.CancellationException) { back = 0f; throw cancelled }
    }
    // Light status bar icons on black while it's open.
    val view = LocalView.current
    DisposableEffect(view) {
        val window = (view.context as? android.app.Activity)?.window
        val bars = window?.let { WindowCompat.getInsetsController(it, view) }
        val light = bars?.isAppearanceLightStatusBars
        bars?.isAppearanceLightStatusBars = false
        onDispose { if (light != null) bars.isAppearanceLightStatusBars = light }
    }
    Box(
        Modifier.fillMaxSize().graphicsLayer { alpha = 1f - 0.5f * back; scaleX = 1f - 0.1f * back; scaleY = 1f - 0.1f * back }.background(Color.Black)
            .pointerInput(Unit) { detectTapGestures { } },
    ) {
        HorizontalPager(pages, Modifier.fillMaxSize(), key = { ids[it] }) { page ->
            var zoom by remember { mutableFloatStateOf(1f) }
            var pan by remember { mutableStateOf(Offset.Zero) }
            val transform = rememberTransformableState { change, offset, _ ->
                zoom = (zoom * change).coerceIn(1f, 5f)
                pan = if (zoom == 1f) Offset.Zero else pan + offset
            }
            Box(
                Modifier.fillMaxSize()
                    .pointerInput(Unit) { detectTapGestures(onDoubleTap = { if (zoom > 1f) { zoom = 1f; pan = Offset.Zero } else zoom = 2.5f }) }
                    // At rest a horizontal swipe belongs to the pager; zoomed in, it pans the image.
                    .transformable(transform, canPan = { zoom > 1f }),
                contentAlignment = Alignment.Center,
            ) {
                UploadedImage(
                    model, ids[page], maxPx, Modifier.fillMaxSize().graphicsLayer { scaleX = zoom; scaleY = zoom; translationX = pan.x; translationY = pan.y },
                    description = if (ids.size > 1) "Image ${page + 1} of ${ids.size}" else "Image", scale = ContentScale.Fit, placeholder = Color.Black,
                    retryable = true,
                )
            }
        }
        Row(Modifier.fillMaxWidth().align(Alignment.TopCenter).background(Color.Black.copy(alpha = 0.75f)).statusBarsPadding().padding(end = Spacing.lg), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onDismiss) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White) }
            Text(if (ids.size > 1) "Image ${pages.currentPage + 1} of ${ids.size}" else "Image", color = Color.White, style = MaterialTheme.typography.titleSmall)
        }
        Text(
            if (ids.size > 1) "Pinch to zoom · Swipe for next image" else "Pinch or double tap to zoom",
            Modifier.align(Alignment.BottomCenter).background(Color.Black.copy(alpha = 0.75f)).navigationBarsPadding().padding(Spacing.md),
            color = Color.White, style = MaterialTheme.typography.bodySmall,
        )
    }
}
