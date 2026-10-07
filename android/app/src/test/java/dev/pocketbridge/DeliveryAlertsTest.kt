package dev.pocketbridge

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class DeliveryAlertsTest {
    @Test fun `expired event cursor refetches state and the selected transcript`() {
        assertEquals(SYNC_STATE or SYNC_MESSAGES, syncKind("""{"type":"state","seq":10001,"chatId":null,"reset":true}""", "chat"))
    }
    @Test fun `verified lost acknowledgement announces completion once and unresolved steer cannot mask an ending`() {
        val done = listOf(ChatStatus("chat", "Chat", "idle"))
        assertTrue(alertEvents(mapOf("chat" to "sending"), done, "").isEmpty())
        assertTrue(alertEvents(mapOf("chat" to "sending"), done, "", setOf("chat")).single() is Ended)
        assertTrue(alertEvents(mapOf("chat" to "idle"), done, "").isEmpty())
        assertTrue(alertEvents(mapOf("chat" to "running"), done, "").single() is Ended)
        assertTrue(alertEvents(mapOf("chat" to "sending"), done, "chat", setOf("chat")).isEmpty())
    }

    @Test fun `uncertain grace is bounded without removing the durable retry`() {
        val watch = DeliveryWatch("id", 120000)
        assertTrue(awaitingDelivery(watch, false, 119999))
        assertFalse(awaitingDelivery(watch, false, 120000))
        assertTrue(awaitingDelivery(watch, true, 120000))
        assertFalse(awaitingDelivery(DeliveryWatch("old", 0), false, 1))
    }

    @Test fun `delivery proof uses tiny read-only ledger request and old Macs remain compatible`() = runBlocking {
        MockWebServer().use { server ->
            val api = Api(server.url("/").toString().trimEnd('/'), "token")
            server.enqueue(MockResponse().setBody("""{"accepted":true,"endedAt":42}"""))
            assertTrue(deliveryStatus(api, "chat", "prompt", true).getBoolean("accepted"))
            server.takeRequest().let { assertEquals("GET", it.method); assertEquals("/api/chats/chat/prompts/prompt", it.path); assertEquals(0, it.bodySize) }
            server.enqueue(MockResponse().setBody("""{"messages":[{"id":"prompt","role":"user"}]}"""))
            assertTrue(deliveryStatus(api, "chat", "prompt", false).getBoolean("accepted"))
            assertEquals("/api/chats/chat/messages", server.takeRequest().path)
            server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"Chat not found"}"""))
            assertFalse(deliveryStatus(api, "draft", "prompt", false).getBoolean("accepted"))
        }
    }
}
