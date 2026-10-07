package dev.pocketbridge

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.media.ExifInterface
import android.net.Uri
import android.test.InstrumentationTestCase
import java.io.File
import kotlin.math.abs

/** Uses the platform runner: real bitmap scaling, EXIF and JPEG, with no test dependency. */
@Suppress("DEPRECATION")
class ImageOrientationTest : InstrumentationTestCase() {
    fun testAllExifOrientationsKeepTheirCornersAndUploadDimensions() {
        val context = instrumentation.targetContext
        val directory = File(context.cacheDir, "orientation-check").apply { mkdirs() }
        val source = File(directory, "source.jpg")
        val output = File(directory, "prepared.jpg")
        val colors = listOf(Color.RED, Color.GREEN, Color.BLUE, Color.YELLOW)
        val bitmap = Bitmap.createBitmap(3000, 2000, Bitmap.Config.ARGB_8888)
        try {
            val canvas = Canvas(bitmap)
            colors.forEachIndexed { index, color ->
                val x = (index % 2) * 1500f
                val y = (index / 2) * 1000f
                canvas.drawRect(x, y, x + 1500f, y + 1000f, Paint().apply { this.color = color })
            }
            source.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 100, it)) }
        } finally { bitmap.recycle() }
        val corners = listOf(
            listOf(0, 1, 2, 3), listOf(1, 0, 3, 2), listOf(3, 2, 1, 0), listOf(2, 3, 0, 1),
            listOf(0, 2, 1, 3), listOf(2, 0, 3, 1), listOf(3, 1, 2, 0), listOf(1, 3, 0, 2),
        )
        try {
            corners.forEachIndexed { index, expected ->
                val orientation = index + 1
                ExifInterface(source.path).apply {
                    setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString()); saveAttributes()
                }
                assertTrue("EXIF $orientation", prepareImage(context.contentResolver, Uri.fromFile(source), output))
                val prepared = BitmapFactory.decodeFile(output.path)
                try {
                    assertEquals(if (orientation < 5) 2048 else 1365, prepared.width)
                    assertEquals(if (orientation < 5) 1365 else 2048, prepared.height)
                    expected.forEachIndexed { corner, colorIndex ->
                        val actual = prepared.getPixel(prepared.width * (if (corner % 2 == 0) 1 else 3) / 4, prepared.height * (if (corner < 2) 1 else 3) / 4)
                        val color = colors[colorIndex]
                        assertTrue("EXIF $orientation corner $corner", abs(Color.red(actual) - Color.red(color)) < 20 && abs(Color.green(actual) - Color.green(color)) < 20 && abs(Color.blue(actual) - Color.blue(color)) < 20)
                    }
                } finally { prepared.recycle() }
            }
        } finally { directory.deleteRecursively() }
    }

    fun testOwnedBitmapsAreRecycledOnlyWhenReplaced() {
        val unchanged = Bitmap.createBitmap(20, 10, Bitmap.Config.ARGB_8888)
        assertSame(unchanged, fitUpright(unchanged, ExifInterface.ORIENTATION_NORMAL, 100))
        assertFalse(unchanged.isRecycled)
        unchanged.recycle()
        val source = Bitmap.createBitmap(300, 200, Bitmap.Config.ARGB_8888)
        val fitted = fitUpright(source, ExifInterface.ORIENTATION_ROTATE_90, 100)
        try {
            assertTrue(source.isRecycled)
            assertFalse(fitted.isRecycled)
            assertEquals(67, fitted.width)
            assertEquals(100, fitted.height)
        } finally { fitted.recycle() }
    }
}
