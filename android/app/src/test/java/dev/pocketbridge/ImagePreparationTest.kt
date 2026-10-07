package dev.pocketbridge

import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class ImagePreparationTest {
    @Test fun `picker and share batches never prepare photos concurrently`() = runBlocking {
        val dir = Files.createTempDirectory("photos").toFile()
        val active = AtomicInteger()
        val maximum = AtomicInteger()
        try {
            val batches = (0 until 8).map { batch -> async {
                prepareImages(listOf(File(dir, "$batch.jpg"))) { _, file ->
                    val running = active.incrementAndGet()
                    maximum.accumulateAndGet(running, ::maxOf)
                    Thread.sleep(10)
                    file.writeText("photo")
                    active.decrementAndGet()
                    true
                }
            } }
            assertEquals(8, batches.awaitAll().flatten().size)
            assertEquals(1, maximum.get())
        } finally { dir.deleteRecursively() }
    }

    @Test fun `cancelling preparation removes completed and partial files and skips remaining photos`() = runBlocking {
        val dir = Files.createTempDirectory("photos").toFile()
        val files = (0 until 3).map { File(dir, "$it.jpg") }
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val processed = AtomicInteger()
        try {
            val preparation = launch {
                prepareImages(files) { index, file ->
                    processed.incrementAndGet()
                    if (index == 1) {
                        File(file.path + ".tmp").writeText("partial")
                        entered.countDown()
                        check(release.await(2, TimeUnit.SECONDS))
                    }
                    file.writeText("photo")
                    true
                }
            }
            withContext(Dispatchers.IO) { assertTrue(entered.await(2, TimeUnit.SECONDS)) }
            preparation.cancel()
            release.countDown()
            withTimeout(2000) { preparation.join() }
            assertEquals(2, processed.get())
            assertTrue(dir.listFiles()!!.isEmpty())
        } finally { release.countDown(); dir.deleteRecursively() }
    }
}
