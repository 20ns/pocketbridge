package dev.pocketbridge

import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException
import kotlin.random.Random
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class ConnectionTest {
    @Test fun `backoff doubles to its cap with a fifth of jitter and starts over after reset`() {
        val backoff = Backoff(1000, 15000, Random(7))
        listOf(1000L, 2000L, 4000L, 8000L, 15000L, 15000L).forEach { base ->
            val delay = backoff.take()
            assertTrue("$delay is not within a fifth of $base", delay in (base * 8 / 10)..(base * 12 / 10))
        }
        backoff.reset()
        assertTrue(backoff.take() in 800L..1200L)
    }
    @Test fun `seeded backoff jitter is spread rather than fixed`() {
        val backoff = Backoff(1000, 1000, Random(1))
        assertTrue((1..20).map { backoff.take() }.toSet().size > 1)
    }
    @Test fun `a wake cuts the wait short and a quiet channel waits it out`() = runBlocking {
        val wake = Channel<Unit>(Channel.CONFLATED)
        assertFalse(wake.waitOr(10))
        wake.trySend(Unit); wake.trySend(Unit)
        assertTrue(wake.waitOr(5000))
        // Conflated: two wakes before the wait count once.
        assertFalse(wake.waitOr(10))
    }
    @Test fun `only a failed handshake blames the certificate`() {
        assertTrue(failureReason(SSLHandshakeException("bad cert")).contains("certificate"))
        val dropped = failureReason(SSLException("Connection reset by peer"))
        assertFalse(dropped.contains("certificate"))
        assertEquals("The connection to your Mac was interrupted. Check Tailscale on both devices.", dropped)
    }
    @Test fun `a connect timeout says the Mac may be asleep and a slow answer says it took too long`() {
        assertTrue(failureReason(SocketTimeoutException("failed to connect to /100.64.0.2 (port 443) after 10000ms")).contains("may be asleep"))
        assertTrue(failureReason(SocketTimeoutException("connect timed out")).contains("may be asleep"))
        assertTrue(failureReason(SocketTimeoutException("timeout")).contains("took too long"))
        assertTrue(failureReason(ConnectException("refused")).startsWith("Can't reach your Mac"))
    }
    @Test fun `a bare proxy 502 explains the service is down and is not the Mac's own answer`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(502).setBody("Bad Gateway"))
            server.enqueue(MockResponse().setResponseCode(503).setBody("{\"error\":\"Claude Code is not installed or could not be started\"}"))
            val api = Api(server.url("/").toString().trimEnd('/'))
            val proxy = runCatching { api.request("/api/chats/chat/prompts", PendingPrompt("id", "hi").json()) }.exceptionOrNull() as ApiError
            assertEquals(502, proxy.status)
            assertFalse(proxy.fromMac)
            assertEquals("Your Mac is reachable, but PocketBridge isn't answering on it. It restarts on its own; check the Mac if this lasts.", failureReason(proxy))
            val service = runCatching { api.request("/api/chats/chat/prompts", PendingPrompt("id", "hi").json()) }.exceptionOrNull() as ApiError
            assertEquals(503, service.status)
            assertTrue(service.fromMac)
            assertEquals("Claude Code is not installed or could not be started", failureReason(service))
        }
    }
    @Test fun `one dropped connection stays quiet and a repeat names the cause`() {
        val dropped = IOException("The connection to your Mac closed.")
        assertEquals("", connectionIssue(dropped, failures = 1, failingFor = 60_000, network = true))
        // A service restart: the stream closes and the next try a second later is refused. Still quiet.
        assertEquals("", connectionIssue(dropped, failures = 2, failingFor = 1_000, network = true))
        assertEquals(failureReason(dropped), connectionIssue(dropped, failures = 2, failingFor = QUIET_MILLIS, network = true))
        assertEquals(NO_NETWORK, connectionIssue(UnknownHostException("mac"), failures = 1, failingFor = 0, network = false))
        assertEquals(REVOKED, connectionIssue(ApiError(401, "Unauthorized"), failures = 1, failingFor = 0, network = true))
    }
    @Test fun `only a recent prompt that does not interrupt is sent again by itself`() {
        val now = 1_000_000_000L
        val savedAt = now - 60_000
        val watch = savedAt + DELIVERY_WATCH_MILLIS
        assertTrue(resendable(PendingPrompt("id", "hi"), watch, now))
        assertTrue(resendable(PendingPrompt("id", "hi", delivery = STEER), watch, now))
        assertTrue(resendable(PendingPrompt("id", "later", schedule = SCHEDULE_RESET), watch, now))
        assertFalse(resendable(PendingPrompt("id", "hi", delivery = INTERRUPT), watch, now))
        // Older than ten minutes, or with no saved watch: Retry stays the owner's call.
        assertTrue(resendable(PendingPrompt("id", "hi"), now - RESEND_WINDOW_MILLIS + DELIVERY_WATCH_MILLIS, now))
        assertFalse(resendable(PendingPrompt("id", "hi"), now - RESEND_WINDOW_MILLIS - 1 + DELIVERY_WATCH_MILLIS, now))
        assertFalse(resendable(PendingPrompt("id", "hi"), null, now))
        // A save dated in the future (the clock moved back) isn't trusted either.
        assertFalse(resendable(PendingPrompt("id", "hi"), now + 60_000 + DELIVERY_WATCH_MILLIS, now))
    }
    @Test fun `a rate limited deletion is tried again later`() {
        assertFalse(deletionSettled(ApiError(429, "Too many requests")))
        assertTrue(deletionSettled(ApiError(409, "Stop this chat")))
    }
    @Test fun `update failures name GitHub rather than the Mac`() {
        listOf(UnknownHostException("github.com"), ConnectException("refused"), SocketTimeoutException("timeout"), SSLHandshakeException("bad")).forEach {
            val message = updateFailure(it)
            assertTrue(message, message.contains("GitHub"))
            assertFalse(message, message.contains("Mac"))
        }
        assertEquals("The update checksum did not match.", updateFailure(IllegalArgumentException("The update checksum did not match.")))
    }
}
