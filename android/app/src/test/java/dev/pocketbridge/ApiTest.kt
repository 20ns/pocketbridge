package dev.pocketbridge

import java.io.IOException
import kotlinx.coroutines.*
import okhttp3.mockwebserver.SocketPolicy
import java.util.concurrent.TimeUnit
import java.util.concurrent.CountDownLatch
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ApiTest {
    @Test fun `server accepts HTTPS and encrypted tailnet addresses`() {
        assertEquals("https://mac.example.ts.net", normalizeServer(" https://mac.example.ts.net/ "))
        assertEquals("http://100.64.0.1:8787", normalizeServer("http://100.64.0.1:8787"))
        assertEquals("http://10.0.2.2:8787", normalizeServer("http://10.0.2.2:8787"))
    }
    @Test fun `server rejects credentials queries public cleartext and invalid tailnet IP`() {
        listOf("https://user:secret@mac.ts.net", "https://mac.ts.net?token=secret", "https://mac.ts.net/api", "http://example.com", "http://100.63.0.1", "http://100.64.999.1", "http://127.attacker.example", "http://127.1", "http://127.0.0.999", "file:///tmp/socket").forEach {
            assertTrue("Accepted unsafe URL $it", runCatching { normalizeServer(it) }.isFailure)
        }
    }
    @Test fun `prompt survives restart with same delivery ID text and mode`() {
        val prompt = PendingPrompt("stable-id", "Change the project", "auto", "sonnet", "high", "project")
        assertEquals(prompt, PendingPrompt.parse(prompt.json().toString()))
        assertEquals("auto", prompt.json().getString("mode"))
        assertEquals("sonnet", prompt.json().getString("model"))
        assertEquals("high", prompt.json().getString("effort"))
        assertEquals("project", prompt.json().getString("projectId"))
        assertEquals(PendingPrompt("old", "hi", "auto"), PendingPrompt.parse("""{"id":"old","text":"hi","mode":"auto"}"""))
    }
    @Test fun `saved options keep their agent and older saves default to Claude`() {
        assertEquals(ChatOptions("auto", "gpt-6-luna", "low", CODEX), ChatOptions.parse(ChatOptions("auto", "gpt-6-luna", "low", CODEX).store()))
        assertEquals(ChatOptions("auto", "haiku", "max"), ChatOptions.parse("""{"mode":"auto","model":"haiku","effort":"max"}"""))
        val codex = PendingPrompt("id", "hi", "readOnly", "gpt-6-luna", "low", "project", CODEX)
        assertEquals(codex, PendingPrompt.parse(codex.json().toString()))
        assertEquals(CODEX, codex.json().getString("agent"))
        assertEquals(ChatOptions("readOnly", "gpt-6-luna", "low", CODEX), codex.options)
        assertEquals(CLAUDE, PendingPrompt.parse("""{"id":"old","text":"hi"}""").agent)
    }
    @Test fun `cursor never commits unseen updates that arrived during reconciliation`() {
        val cursor = EventCursor(10)
        cursor.observe("id: 15")
        cursor.commit(12)
        assertEquals(12L, cursor.committed)
        cursor.commit(9)
        assertEquals(12L, cursor.committed)
        cursor.observe("id: invalid")
        assertEquals(15L, cursor.observed)
    }
    @Test fun `API sends app credential only in authorization header`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("{\"accepted\":true,\"duplicate\":true}"))
            val result = Api(server.url("/").toString().trimEnd('/'), "private-app-token").request("/api/chats/chat/prompts", PendingPrompt("same-id", "hello", "auto").json())
            assertTrue(result.getBoolean("duplicate"))
            val request = server.takeRequest()
            assertEquals("Bearer private-app-token", request.getHeader("Authorization"))
            assertEquals("/api/chats/chat/prompts", request.path)
            assertEquals("same-id", JSONObject(request.body.readUtf8()).getString("id"))
        }
    }
    @Test fun `API exposes definitive rejection without losing server explanation`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(409).setBody("{\"error\":\"Chat is already running\"}"))
            val error = runCatching { Api(server.url("/").toString().trimEnd('/')).request("/api/chats/chat/prompts", JSONObject()) }.exceptionOrNull()
            assertTrue(error is ApiError)
            assertEquals(409, (error as ApiError).status)
            assertEquals("Chat is already running", error.message)
        }
    }
    @Test fun `malformed response is recoverable transport failure`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("not-json"))
            assertTrue(runCatching { Api(server.url("/").toString().trimEnd('/')).request("/api/state") }.exceptionOrNull() is IOException)
        }
    }
    @Test fun `SSE resumes from cursor without placing credentials in URL`() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("id: 17\nevent: change\ndata: {\"seq\":17}\n\n"))
            Api(server.url("/").toString().trimEnd('/'), "private-app-token").events(16).execute().use { response -> assertTrue(response.body!!.string().contains("id: 17")) }
            val request = server.takeRequest()
            assertEquals("/api/events?after=16", request.path)
            assertEquals("Bearer private-app-token", request.getHeader("Authorization"))
            assertEquals("text/event-stream", request.getHeader("Accept"))
        }
    }

    @Test fun `HTTP status remains available when an error response is not JSON`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(401).setBody("Unauthorized"))
            val failure = runCatching { Api(server.url("/").toString().trimEnd('/')).request("/api/state") }.exceptionOrNull() as ApiError
            assertEquals(401, failure.status)
            assertTrue(failure.definitiveRejection)
        }
    }
    @Test fun `ambiguous HTTP responses retain delivery IDs`() {
        listOf(302, 408, 500, 502, 503).forEach { assertFalse(ApiError(it, "Uncertain").definitiveRejection) }
        listOf(400, 401, 403, 409, 413, 429).forEach { assertTrue(ApiError(it, "Rejected").definitiveRejection) }
    }
    @Test fun `canceling a stalled request releases it immediately`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val call = Api(server.url("/").toString().trimEnd('/')).events(0)
            val request = launch { call.consume { it.body!!.string() } }
            withContext(Dispatchers.IO) { assertNotNull(server.takeRequest(2, TimeUnit.SECONDS)) }
            withTimeout(2000) { request.cancelAndJoin() }
            assertTrue("Cancellation must close the underlying socket", call.isCanceled())
        }
    }
    @Test fun `canceling SSE releases its connection for background resume`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("data: change\n\ndata: next\n\n").throttleBody(16, 500, TimeUnit.MILLISECONDS))
            val received = CountDownLatch(1)
            val stream = launch { Api(server.url("/").toString().trimEnd('/')).watch(10) { received.countDown() } }
            withContext(Dispatchers.IO) { assertTrue(received.await(2, TimeUnit.SECONDS)) }
            withTimeout(2000) { stream.cancelAndJoin() }
        }
    }

    @Test fun `GET snapshot recovers when a reused connection closes before its response`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("{}"))
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            server.enqueue(MockResponse().setBody("{\"messages\":[]}"))
            val api = Api(server.url("/").toString().trimEnd('/'))
            api.request("/api/state")
            assertTrue(api.request("/api/chats/chat/messages").has("messages"))
            assertEquals(0, server.takeRequest().sequenceNumber)
            assertEquals(1, server.takeRequest().sequenceNumber)
            assertEquals(0, server.takeRequest().sequenceNumber)
            assertEquals(3, server.requestCount)
        }
    }
    @Test fun `POST is never repeated after losing its response`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("{}"))
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            server.enqueue(MockResponse().setBody("{\"id\":\"duplicate-chat\"}"))
            val api = Api(server.url("/").toString().trimEnd('/'))
            api.request("/api/state")
            assertTrue(runCatching { api.request("/api/chats", JSONObject().put("projectId", "project")) }.exceptionOrNull() is IOException)
            assertEquals("GET", server.takeRequest().method)
            val sent = server.takeRequest()
            assertEquals("POST", sent.method)
            assertEquals(0, sent.sequenceNumber)
            assertNull(server.takeRequest(200, TimeUnit.MILLISECONDS))
        }
    }

    @Test fun `POST is never repeated by a 503 Retry-After response`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(503).setHeader("Retry-After", "0").setBody("{\"error\":\"Try later\"}"))
            server.enqueue(MockResponse().setBody("{\"id\":\"duplicate-chat\"}"))
            val api = Api(server.url("/").toString().trimEnd('/'))
            val failure = runCatching { api.request("/api/chats", JSONObject().put("projectId", "project")) }.exceptionOrNull()
            assertTrue(failure is ApiError)
            assertEquals(503, (failure as ApiError).status)
            assertEquals("POST", server.takeRequest().method)
            assertNull(server.takeRequest(200, TimeUnit.MILLISECONDS))
            assertEquals(1, server.requestCount)
        }
    }

    @Test fun `mutations never reuse idle connections including closed server keepalives`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("{\"ok\":true}").setSocketPolicy(SocketPolicy.DISCONNECT_AT_END))
            server.enqueue(MockResponse().setBody("{\"ok\":true}"))
            server.enqueue(MockResponse().setBody("{\"ok\":true}"))
            val api = Api(server.url("/").toString().trimEnd('/'))
            assertTrue(api.request("/api/chats/chat/stop", JSONObject()).getBoolean("ok"))
            delay(100)
            assertTrue(api.request("/api/chats/chat/stop", JSONObject()).getBoolean("ok"))
            delay(100)
            assertTrue(api.request("/api/chats/chat/stop", JSONObject()).getBoolean("ok"))
            repeat(3) {
                val sent = server.takeRequest()
                assertEquals("POST", sent.method)
                assertEquals(0, sent.sequenceNumber)
            }
            assertEquals(3, server.requestCount)
        }
    }
}
