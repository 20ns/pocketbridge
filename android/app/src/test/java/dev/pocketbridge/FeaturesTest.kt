package dev.pocketbridge

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class FeaturesTest {
    @Test fun `an unconfirmed send never announces completion before delivery is proved`() {
        val idle = ChatStatus("chat", "Chat", "idle")
        assertTrue(alertEvents(mapOf("chat" to "sending"), listOf(idle), "").isEmpty())
        assertTrue(alertEvents(mapOf("chat" to "running"), listOf(idle), "").single() is Ended)
        assertTrue(deliveredPrompt(listOf(JSONObject().put("id", "prompt").put("role", "user")), "prompt"))
        assertFalse(deliveredPrompt(emptyList(), "prompt"))
    }
    // Delivery: images and steer/interrupt travel with the immutable delivery id.

    @Test fun `prompt keeps its images and delivery across a restart and a retry`() {
        val prompt = PendingPrompt("id", "", "auto", "opus", "high", "project", CLAUDE, listOf("u1", "u2"), STEER)
        val saved = prompt.json().toString()
        assertEquals(prompt, PendingPrompt.parse(saved))
        val sent = JSONObject(saved)
        assertEquals(listOf("u1", "u2"), sent.getJSONArray("attachments").let { a -> (0 until a.length()).map(a::getString) })
        assertEquals("steer", sent.getString("delivery"))
        assertEquals(PendingPrompt.parse(saved).json().toString(), prompt.json().toString())
    }

    @Test fun `older saved prompts read as no images and a normal turn`() {
        val old = PendingPrompt.parse("""{"id":"old","text":"hi","mode":"auto","model":"opus","effort":"high"}""")
        assertEquals(emptyList<String>(), old.attachments)
        assertNull(old.delivery)
        val json = old.json()
        assertFalse(json.has("attachments"))
        assertFalse(json.has("delivery"))
        assertNull(PendingPrompt.parse("""{"id":"x","text":"hi","delivery":"later"}""").delivery)
        assertEquals(INTERRUPT, PendingPrompt.parse(PendingPrompt("x", "hi", delivery = INTERRUPT).json().toString()).delivery)
    }

    @Test fun `upload sends raw bytes with their type and the credential header only`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(201).setBody("""{"id":"0b2f6c1e-0000-4000-8000-000000000001","type":"image/jpeg","size":3}"""))
            val result = Api(server.url("/").toString().trimEnd('/'), "token").upload(byteArrayOf(1, 2, 3), "image/jpeg")
            assertEquals("0b2f6c1e-0000-4000-8000-000000000001", result.getString("id"))
            val request = server.takeRequest()
            assertEquals("/api/uploads", request.path)
            assertEquals("POST", request.method)
            assertEquals("image/jpeg", request.getHeader("Content-Type"))
            assertEquals("Bearer token", request.getHeader("Authorization"))
            assertArrayEquals(byteArrayOf(1, 2, 3), request.body.readByteArray())
        }
    }

    @Test fun `image downloads refuse oversized answers and status streams ask for status only`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("x".repeat(64)))
            val api = Api(server.url("/").toString().trimEnd('/'), "token")
            assertTrue(runCatching { api.bytes("/api/uploads/a", limit = 16) }.isFailure)
            assertEquals("/api/events?after=5&scope=status", api.events(5, "status").request().url.encodedPath + "?" + api.events(5, "status").request().url.encodedQuery)
            assertEquals("after=5", api.events(5).request().url.encodedQuery)
        }
    }

    // Composer images.

    @Test fun `composer images round trip and only uploaded ones count as sendable`() {
        val list = listOf(Attachment("a", "/f/a.jpg", "u1"), Attachment("b", "/f/b.jpg"))
        val restored = decodeAttachments(encodeAttachments(list))
        assertEquals(UploadState.Ready, restored[0].state)
        assertEquals(UploadState.Failed, restored[1].state)
        assertEquals(listOf("/f/a.jpg", "/f/b.jpg"), restored.map { it.file })
        assertTrue(decodeAttachments("not json").isEmpty())
        assertFalse(canSendDraft("", emptyList()))
        assertTrue(canSendDraft("", listOf(Attachment("a", "f", "u"))))
        assertFalse(canSendDraft("text", restored))
        assertFalse(canSendDraft("text", listOf(Attachment("a", "f", state = UploadState.Uploading))))
        assertTrue(canSendDraft("text", emptyList()))
    }

    @Test fun `a draft holding only images stays listed`() {
        val rows = listedDrafts(listOf(ListedDraft("a", "p", "", false, images = 2), ListedDraft("b", "p", "", false)))
        assertEquals(listOf("a"), rows.map { it.getString("id") })
        assertEquals("New chat", rows.single().getString("title"))
    }

    @Test fun `downscaling keeps the long side readable and never enlarges`() {
        assertEquals(1, sampleSize(1440, 3120, 2048))
        assertEquals(4, sampleSize(16320, 12240, 2048))
        assertEquals(2, sampleSize(4096, 3072, 2048))
        assertEquals(945 to 2048, scaledSize(1440, 3120, 2048))
        assertEquals(2048 to 1536, scaledSize(4080, 3060, 2048))
        assertEquals(800 to 600, scaledSize(800, 600, 2048))
    }

    @Test fun `share targets list active chats, then recent ones, then recent projects`() {
        val projects = listOf(project("p1", 100), project("p2", 500), project("p3", 50))
        val chats = listOf(chat("a", "p1", "running", 10), chat("b", "p1", "idle", 300), chat("c", "p2", "idle", 200), chat("gone", "x", "idle", 900))
        val targets = shareTargets(chats, projects)
        assertEquals(listOf("a"), targets.active.map { it.getString("id") })
        assertEquals(listOf("b", "c"), targets.recent.map { it.getString("id") })
        assertEquals(listOf("p2", "p1", "p3"), targets.projects.map { it.getString("id") })
    }

    // Turns and sub-agents.

    private fun said(id: String, role: String, text: String, at: Long, kind: String = "") = Said(id, role, text, at, kind)

    @Test fun `turns and sub-agents parse with nulls`() {
        val json = JSONObject("""{"turns":[{"id":"t1","startedAt":10,"endedAt":null},{"id":"t2","startedAt":20,"endedAt":40}],
            "subagents":[{"id":"s1","promptId":"t1","agent":"claude","title":"Audit","kind":"Explore","model":"Haiku 4.5","effort":"high","status":"running","activity":null,"startedAt":12,"endedAt":null,"toolUses":null,"tokens":null}],"activity":null}""")
        assertEquals(listOf(Turn("t1", 10, null), Turn("t2", 20, 40)), parseTurns(json))
        val agent = parseSubagents(json).single()
        assertEquals("", agent.activity)
        assertNull(agent.endedAt)
        assertTrue(agent.running)
        assertEquals("Explore · Haiku 4.5 · High", subagentDetail(agent))
        assertEquals("Haiku 4.5", subagentDetail(agent.copy(kind = "", effort = "default")))
        assertTrue(parseTurns(JSONObject("{}")).isEmpty())
    }

    @Test fun `sub-agents sit after the steps that started them, inside their turn`() {
        val entries = transcript(listOf(
            said("t1", "user", "audit", 100),
            said("a1", "activity", "Agent\n{\"description\":\"Audit\"}", 110),
            said("r1", "assistant", "Started two", 130),
            said("t2", "user", "next", 200),
            said("r2", "assistant", "Done", 210),
        ))
        val agents = listOf(Subagent("s1", "t1", "Audit", "", "", "", "running", "", 111, null), Subagent("s2", "t1", "Tests", "", "", "", "completed", "", 112, 150))
        val placed = withSubagents(entries, agents, listOf(Turn("t1", 100, 140), Turn("t2", 200, 220)))
        assertEquals(listOf("t1", "steps:a1", "agents:t1", "r1", "t2", "r2"), placed.map { it.key })
        // Unknown prompt: last; no sub-agents: unchanged.
        assertEquals("agents:", withSubagents(entries, listOf(agents[0].copy(promptId = "")), emptyList()).last().key)
        assertSame(entries, withSubagents(entries, emptyList()))
    }

    @Test fun `running sub-agents come first so they never hide behind more`() {
        val done = Subagent("d", "t", "Done", "", "", "", "completed", "", 1, 5)
        val live = Subagent("l", "t", "Live", "", "", "", "running", "", 3, null)
        assertEquals(listOf("l", "d"), subagentOrder(listOf(done, live)).map { it.id })
    }

    @Test fun `each finished turn reports its duration on its last reply, steers included`() {
        val entries = transcript(listOf(
            said("t1", "user", "go", 0),
            said("r1", "assistant", "on it", 10),
            said("s1", "user", "use staging", 20, STEER),
            said("r2", "assistant", "switched", 30),
            said("t2", "user", "again", 100),
            said("r3", "assistant", "working", 110),
        ))
        val turns = listOf(Turn("t1", 0, 134_000), Turn("t2", 100, null))
        assertEquals(mapOf("r2" to 134_000L), turnDurations(entries, turns))
        assertEquals("Worked 2m 14s", workedLabel(134_000))
        assertEquals("Worked 1s", workedLabel(120))
        // A steer joins the turn: the reply before it doesn't close a turn.
        assertEquals(setOf("r2"), turnEnds(entries, live = true))
        assertEquals(100L, runningSince(turns, 5))
        assertEquals(5L, runningSince(listOf(Turn("t1", 0, 9)), 5))
    }

    // Project details.

    @Test fun `git status reads branch or commit and describes every number`() {
        val git = parseGit(JSONObject("""{"repo":true,"branch":"feature/composer","detached":false,"commit":"abc1234","ahead":1,"behind":0,"files":3,"added":8,"removed":2}"""))!!
        assertEquals("feature/composer", git.head)
        assertEquals("On feature/composer. 8 lines added, 2 removed in 3 files. 1 commit ahead", gitDescription(git))
        val detached = parseGit(JSONObject("""{"repo":true,"branch":null,"detached":true,"commit":"abc1234","ahead":0,"behind":2,"files":0,"added":0,"removed":0}"""))!!
        assertEquals("abc1234", detached.head)
        assertEquals("Detached at abc1234. No changes. 2 behind", gitDescription(detached))
        assertNull(parseGit(JSONObject("""{"repo":false}""")))
    }

    @Test fun `the slash list opens only for a bare command and ranks prefixes first`() {
        assertEquals("", slashQuery("/"))
        assertEquals("rel", slashQuery("/rel"))
        assertNull(slashQuery("/release 1.0"))
        assertNull(slashQuery("release"))
        val commands = listOf(SlashCommand("review-pr", "", ""), SlashCommand("release", "", "[version]"), SlashCommand("plugin:deploy-release", "", ""), SlashCommand("unslop", "", ""))
        assertEquals(listOf("review-pr", "release"), filterCommands(commands, "re").take(2).map { it.name })
        assertEquals(listOf("release", "plugin:deploy-release"), filterCommands(commands, "rel").map { it.name })
        assertEquals(listOf("plugin:deploy-release"), filterCommands(commands, "deploy").map { it.name })
        assertEquals(listOf("unslop"), filterCommands(commands, "usp").map { it.name })
        assertEquals(commands, filterCommands(commands, ""))
        assertEquals(listOf("release"), parseCommands(JSONObject("""{"commands":[{"name":"/release","description":"Ship","hint":""},{"name":""}]}""")).map { it.name })
        // A command and a skill sharing a name list once, the first kept: the list keys rows by name.
        assertEquals(listOf(SlashCommand("review", "Command", ""), SlashCommand("ship", "", "")), parseCommands(JSONObject("""{"commands":[{"name":"review","description":"Command"},{"name":"/review","description":"Skill"},{"name":"ship"}]}""")))
    }

    @Test fun `Mac sessions parse with their agent and an empty preview`() {
        val sessions = parseSessions(JSONObject("""{"sessions":[{"agent":"codex","id":"t1","title":"Fix","updatedAt":5,"preview":null},{"id":"c1","title":"","updatedAt":1,"preview":"Last reply"}]}"""))
        assertEquals(listOf(MacSession(CODEX, "t1", "Fix", 5, ""), MacSession(CLAUDE, "c1", "Untitled session", 1, "Last reply")), sessions)
        assertEquals("Codex", agentProduct(CODEX))
        assertEquals("Claude Code", agentProduct(CLAUDE))
    }

    // Alerts.

    private fun status(id: String, status: String) = ChatStatus(id, "Chat $id", status)

    @Test fun `alerts announce answers needed and turns that end, never the chat on screen`() {
        val previous = mapOf("a" to "running", "b" to "running", "c" to "waiting", "d" to "running", "e" to "stopping", "f" to "idle")
        val current = listOf(status("a", "waiting"), status("b", "idle"), status("c", "running"), status("d", "error"), status("e", "interrupted"), status("f", "idle"), status("g", "waiting"))
        val events = alertEvents(previous, current, viewing = "")
        assertEquals(
            listOf("needs:a", "ended:b", "answered:c", "ended:d", "ended:e", "needs:g"),
            events.map { (when (it) { is NeedsAnswer -> "needs:"; is Ended -> "ended:"; is Answered -> "answered:" }) + it.chat.id },
        )
        assertTrue(alertEvents(previous, current, viewing = "a").none { it.chat.id == "a" })
        // A chat never seen working can't have finished.
        assertTrue(alertEvents(emptyMap(), listOf(status("x", "idle")), "").isEmpty())
        assertEquals(listOf("Done", "Failed", "Interrupted"), listOf("idle", "error", "interrupted").map(::endedLabel))
    }

    @Test fun `a notification answer is judged by the Mac's record before its actions come back`() {
        assertEquals("c1", approvalChat("""{"seq":4,"chatId":"c1","type":"approval"}"""))
        assertNull(approvalChat("""{"seq":5,"chatId":"c1","type":"state"}"""))
        assertNull(approvalChat("not json"))
        val messages = JSONObject("""{"messages":[],"approvals":[{"id":"a","status":"allow"},{"id":"b","status":"pending"},{"id":"c","status":"deny"}]}""")
        assertEquals("Allowed", approvalOutcome(messages, "a"))
        assertNull(approvalOutcome(messages, "b"))
        assertEquals("Denied", approvalOutcome(messages, "c"))
        assertEquals("", approvalOutcome(messages, "gone"))
        // Nothing could be read: the actions come back for another try.
        assertNull(approvalOutcome(null, "a"))
    }

    @Test fun `a steer taken between turns starts its own turn for Copy and Worked alike`() {
        val entries = transcript(listOf(
            said("t1", "user", "go", 0), said("r1", "assistant", "done", 10),
            said("s1", "user", "one more thing", 50, STEER), said("r2", "assistant", "also done", 60),
        ))
        val turns = listOf(Turn("t1", 0, 20), Turn("s1", 50, 70))
        assertEquals(setOf("r1", "r2"), turnEnds(entries, live = false, turns))
        assertEquals(turnDurations(entries, turns).keys, turnEnds(entries, live = false, turns))
        // Without its turn the steer joined the running one.
        assertEquals(setOf("r2"), turnEnds(entries, live = false))
    }

    @Test fun `nothing ticks once the chat stops, whatever a turn or sub-agent row still says`() {
        val stale = listOf(Turn("t1", 100, null), Turn("t2", 200, 300))
        assertNull(runningSince(stale, 250, working = false))
        // An older turn a crash never closed doesn't count; the newest prompt does.
        assertEquals(400L, runningSince(stale, 400))
        assertEquals(500L, runningSince(stale + Turn("t3", 500, null), 450))
        val agents = listOf(
            Subagent("a", "t2", "Explore", "", "", "", "running", "", 210, null),
            Subagent("b", "gone", "Plan", "", "", "", "running", "", 220, null),
            Subagent("c", "t2", "Done", "", "", "", "completed", "", 205, 250),
        )
        assertEquals(agents, settledSubagents(agents, stale, working = true, stoppedAt = 900))
        val settled = settledSubagents(agents, stale, working = false, stoppedAt = 900)
        assertEquals(listOf("stopped" to 300L, "stopped" to 900L, "completed" to 250L), settled.map { it.status to it.endedAt })
        assertTrue(settled.none { it.running })
    }

    @Test fun `a prompt the Mac saved settles without a resend and an older snapshot can't close its chat`() {
        val messages = listOf(JSONObject().put("id", "p1").put("role", "user"), JSONObject().put("id", "p2").put("role", "assistant"))
        assertTrue(deliveredPrompt(messages, "p1"))
        assertFalse(deliveredPrompt(messages, "p2"))
        assertFalse(deliveredPrompt(messages, "p3"))
        // Accepted when three snapshots had been asked for: the third predates it, the fourth doesn't.
        assertFalse(chatGone(listed = false, local = false, generation = 3, acceptedAt = 3))
        assertTrue(chatGone(listed = false, local = false, generation = 4, acceptedAt = 3))
        assertTrue(chatGone(listed = false, local = false, generation = 1, acceptedAt = null))
        assertFalse(chatGone(listed = false, local = true, generation = 9, acceptedAt = null))
        assertFalse(chatGone(listed = true, local = false, generation = 9, acceptedAt = null))
        assertTrue(lostUpload(ApiError(400, "Attachment not found")))
        assertFalse(lostUpload(ApiError(400, "Attachments must be up to 8 upload ids")))
    }

    private fun project(id: String, used: Long) = JSONObject().put("id", id).put("name", id).put("path", "/p/$id").put("lastUsedAt", used)
    private fun chat(id: String, project: String, status: String, updated: Long) = JSONObject().put("id", id).put("projectId", project).put("status", status).put("updatedAt", updated).put("title", id)
}
