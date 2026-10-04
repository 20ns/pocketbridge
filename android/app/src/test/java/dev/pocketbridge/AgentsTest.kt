package dev.pocketbridge

import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AgentsTest {
    private val capabilities = JSONObject("""
        {"modes":["bypassPermissions"],"models":["default","opus"],"efforts":["default","high"],"agents":[
          {"id":"claude","name":"Claude","available":true,"modes":["bypassPermissions","auto","plan","acceptEdits","default"],"defaultModel":"opus","defaultEffort":"high","models":[
            {"id":"opus","name":"Opus 5.5","description":"Best for everyday, complex tasks","efforts":["low","medium","high","xhigh","max"],"defaultEffort":"high"},
            {"id":"sonnet","name":"Sonnet 5.5","efforts":["low","medium","high"],"defaultEffort":"high"},
            {"id":"haiku","name":"Haiku 4.5","efforts":[],"defaultEffort":"default"}]},
          {"id":"codex","name":"Codex","available":true,"modes":["bypassPermissions","auto","readOnly"],"defaultModel":"gpt-6-astra","defaultEffort":"xhigh","models":[
            {"id":"gpt-6-astra","name":"GPT-6-Astra","efforts":["low","medium","high","xhigh","max","ultra"],"defaultEffort":"medium"},
            {"id":"gpt-6-luna","name":"GPT-6-Luna","efforts":["low","medium"],"defaultEffort":"medium"}]}]}
    """)
    private val agents = parseAgents(capabilities)
    private val claude = agents.first { it.id == CLAUDE }
    private val codex = agents.first { it.id == CODEX }

    @Test fun `catalog names real models and old Macs fall back to Claude aliases`() {
        assertEquals(listOf("Opus 5.5", "Sonnet 5.5", "Haiku 4.5"), claude.models.map { it.name })
        assertEquals("Opus 5.5", modelName(claude, "default"))
        assertEquals("gpt-5", modelName(codex, "gpt-5"))
        // "default" never shows as a name: the default model's, else the first model's, else the agent's.
        assertEquals("Opus", modelName(claude.copy(models = emptyList()), "default"))
        assertEquals("Opus 5.5", modelName(claude.copy(defaultModel = "default"), "default"))
        assertEquals("Codex", modelName(codex.copy(models = emptyList(), defaultModel = "default"), "default"))
        assertEquals("Claude", modelName(null, "default"))
        val legacy = parseAgents(JSONObject("""{"modes":["bypassPermissions","auto"],"models":["default","opus","haiku"],"efforts":["default","low","high"]}"""))
        assertEquals(listOf("opus", "haiku"), legacy.single().models.map { it.id })
        assertEquals(emptyList<String>(), legacy.single().models.last().efforts)
        assertEquals("opus", legacy.single().defaultModel)
    }

    @Test fun `new chats start from a concrete model and keep supported choices`() {
        assertEquals(ChatOptions("bypassPermissions", "opus", "high", CLAUDE), resolveOptions(claude, null))
        assertEquals(ChatOptions("bypassPermissions", "opus", "high", CLAUDE), resolveOptions(claude, ChatOptions("bypassPermissions")))
        assertEquals(ChatOptions("bypassPermissions", "gpt-6-astra", "xhigh", CODEX), resolveOptions(codex, null))
        assertEquals(ChatOptions("plan", "sonnet", "low", CLAUDE), resolveOptions(claude, ChatOptions("plan", "sonnet", "low")))
        // An effort the new model lacks falls back to that model's own default; Haiku has none.
        assertEquals("high", resolveOptions(claude, ChatOptions("auto", "sonnet", "max")).effort)
        assertEquals("default", resolveOptions(claude, ChatOptions("auto", "haiku", "max")).effort)
        // Switching agent keeps a shared mode and drops one the other CLI doesn't have.
        assertEquals("auto", resolveOptions(codex, ChatOptions("auto", "gpt-6-luna", "high", CODEX)).mode)
        // Never a wider mode: Plan becomes Read only, Accept edits becomes Auto, Manual becomes Read only.
        assertEquals(ChatOptions("readOnly", "gpt-6-luna", "medium", CODEX), resolveOptions(codex, ChatOptions("plan", "gpt-6-luna", "max", CLAUDE)))
        assertEquals("plan", resolveOptions(claude, ChatOptions("readOnly", "opus", "high", CODEX)).mode)
        assertEquals("auto", resolveOptions(codex, ChatOptions("acceptEdits")).mode)
        assertEquals("readOnly", resolveOptions(codex, ChatOptions("default")).mode)
        assertEquals("bypassPermissions", resolveOptions(codex, ChatOptions("bypassPermissions")).mode)
        assertEquals("high", supportedOptions(claude, ChatOptions("auto", "sonnet", "max")).effort)
        assertEquals("default", supportedOptions(claude, ChatOptions("auto", "haiku", "max")).effort)
        assertEquals(ChatOptions("auto", "default", "default"), supportedOptions(claude, ChatOptions("auto", "default", "default")))
        // A model the Mac no longer lists is replaced by the default.
        assertEquals("opus", resolveOptions(claude, ChatOptions("auto", "claude-opus-3")).model)
    }

    @Test fun `new chats use the last agent while it is on, else the first one on`() {
        val off = codex.copy(enabled = false)
        assertEquals(CODEX, newChatAgent(listOf(claude, codex), CODEX))
        assertEquals(CLAUDE, newChatAgent(listOf(claude, off), CODEX))
        assertEquals(CODEX, newChatAgent(listOf(claude.copy(enabled = false), codex), CLAUDE))
        assertEquals(CODEX, newChatAgent(listOf(claude.copy(available = false), codex), CLAUDE))
        assertNull(newChatAgent(listOf(claude.copy(enabled = false), off), CLAUDE))
        assertEquals(CLAUDE, newChatAgent(emptyList(), CODEX))
        assertFalse(parseAgents(JSONObject("""{"agents":[{"id":"codex","enabled":false}]}""")).single().enabled)
        assertTrue(parseAgents(JSONObject("""{"agents":[{"id":"codex"}]}""")).single().enabled)
    }

    @Test fun `older default effort shows the level that applies`() {
        assertEquals("High", effortName(claude, "default", "default"))
        assertEquals("Extra high", effortName(codex, "gpt-6-astra", "default"))
        assertEquals("Medium", effortName(codex, "gpt-6-luna", "default"))
        assertEquals("Auto", effortName(null, "opus", "default"))
        assertEquals("Ultra", effortName(codex, "gpt-6-astra", "ultra"))
        assertEquals("Read only", modeLabel("readOnly"))
        assertEquals("Bypass", modeShort("bypassPermissions"))
    }

    @Test fun `streaming text for other chats does not refetch anything`() {
        assertEquals(SYNC_MESSAGES, syncKind("""{"seq":4,"chatId":"open","type":"message"}""", "open"))
        assertEquals(0, syncKind("""{"seq":4,"chatId":"other","type":"message"}""", "open"))
        assertEquals(SYNC_STATE, syncKind("""{"seq":5,"chatId":"other","type":"state"}""", "open"))
        assertEquals(SYNC_STATE or SYNC_MESSAGES, syncKind("""{"seq":6,"chatId":"open","type":"approval"}""", "open"))
        assertEquals(SYNC_STATE, syncKind("""{"seq":7,"type":"state"}""", ""))
        assertEquals(SYNC_STATE or SYNC_MESSAGES, syncKind("not json", "open"))
    }

    @Test fun `project search matches every word in name or path`() {
        assertTrue(matchesProject("pocket", "PocketBridge", "/Users/me/Desktop/PocketBridge"))
        assertTrue(matchesProject("desk bridge", "PocketBridge", "/Users/me/Desktop/PocketBridge"))
        assertFalse(matchesProject("bridge vapi", "PocketBridge", "/Users/me/Desktop/PocketBridge"))
        assertTrue(matchesProject("  ", "Anything", "/x"))
    }

    @Test fun `exact result ids pair out of order results and live steps show what runs now`() {
        val entries = transcript(listOf(
            Said("u", "user", "Go"),
            Said("a", "activity", "Shell\n{\"command\":\"sleep 9\"}"),
            Said("b", "activity", "Shell\n{\"command\":\"false\"}"),
            Said("b:result", "activity", "Tool failed\nExit code 1"),
        ))
        val steps = (entries.last() as Steps).steps
        assertNull(steps[0].result)
        assertTrue(steps[1].failed)
        assertEquals("sleep 9", liveStep(entries)?.summary)
        val orphan = (transcript(listOf(Said("x:result", "activity", "Tool result\nlate"))).single() as Steps).steps.single()
        assertEquals("Result", orphan.tool)
    }

    @Test fun `copy appears on replies that close a turn`() {
        val entries = transcript(listOf(
            Said("u1", "user", "a"), Said("r1", "assistant", "first"), Said("t", "activity", "Read\n{}"), Said("r2", "assistant", "second"),
            Said("u2", "user", "b"), Said("r3", "assistant", "streaming"),
        ))
        assertEquals(setOf("r2"), turnEnds(entries, live = true))
        assertEquals(setOf("r2", "r3"), turnEnds(entries, live = false))
        assertEquals("59s", elapsedLabel(59_900))
        assertEquals("1m 05s", elapsedLabel(65_000))
        assertEquals("2h 03m", elapsedLabel((2 * 3600 + 3 * 60) * 1000L))
    }

    @Test fun `usage keeps agents with limits and context reads as a percentage`() {
        val usage = parseUsage(JSONObject("""{"agents":[
          {"id":"claude","name":"Claude","plan":"Max","limits":[{"id":"session","label":"5-hour session","percent":14,"resetsAt":1790000000000,"severity":"normal"},{"id":"weekly_all","label":"Weekly","percent":125,"resetsAt":0}],"updatedAt":5},
          {"id":"codex","name":"Codex","plan":"Pro Lite","limits":[{"id":"primary","label":"Weekly","percent":39,"resetsAt":1791580292000}],"credits":2353.72},
          {"id":"other","name":"Other","limits":[]},
          {"id":"credits","name":"Credits only","limits":[],"credits":12.5}]}"""))
        assertEquals(listOf("claude", "codex", "credits"), usage.map { it.id })
        assertEquals(12.5, usage[2].credits!!, 0.001)
        assertEquals(listOf(14, 100), usage[0].limits.map { it.percent })
        assertEquals("normal", usage[0].limits[1].severity)
        assertEquals(2353.72, usage[1].credits!!, 0.001)
        assertNull(usage[0].credits)
        assertEquals(23, chatContext(JSONObject("""{"context":{"used":230000,"window":1000000}}"""))?.percent)
        assertNull(chatContext(JSONObject("{}")))
        assertTrue(parseUsage(JSONObject("{}")).isEmpty())
    }

    @Test fun `transcript cache keeps one file per chat and skips unchanged writes`() {
        val dir = Files.createTempDirectory("transcripts").toFile()
        val cache = TranscriptCache(dir)
        cache.write("chat-1", "{\"messages\":[]}")
        assertEquals("{\"messages\":[]}", cache.read("chat-1"))
        val file = dir.listFiles()!!.single()
        file.setLastModified(1000)
        cache.write("chat-1", "{\"messages\":[]}")
        assertEquals(1000, file.lastModified())
        cache.write("../escape", "x")
        assertTrue(dir.listFiles()!!.all { it.parentFile == dir })
        cache.remove("chat-1")
        assertEquals("", cache.read("chat-1"))
        cache.clear()
        assertFalse(dir.exists())
    }

    private val fastCatalog = parseAgents(JSONObject("""
        {"agents":[{"id":"codex","name":"Codex","available":true,"version":"0.130.0","modes":["bypassPermissions","auto","readOnly"],"defaultModel":"gpt-6-astra","defaultEffort":"high","models":[
          {"id":"gpt-6-astra","name":"GPT-6-Astra","efforts":["low","high"],"defaultEffort":"high","speeds":[{"id":"priority","name":"Fast","description":"1.5x speed, increased usage"}]},
          {"id":"gpt-6-luna","name":"GPT-6-Luna","efforts":["low"],"defaultEffort":"low","speeds":[]}]},
         {"id":"claude","name":"Claude","available":true,"modes":["bypassPermissions"],"defaultModel":"opus","defaultEffort":"high","models":[{"id":"opus","name":"Opus 5.5","efforts":["high"],"defaultEffort":"high","speeds":[]}]}]}
    """))
    private val fastCodex = fastCatalog.first { it.id == CODEX }

    @Test fun `speeds come from the catalog with their own names`() {
        val astra = fastCodex.model("gpt-6-astra")!!
        assertEquals(listOf(SpeedInfo("priority", "Fast", "1.5x speed, increased usage")), astra.speeds)
        assertTrue(fastCodex.model("gpt-6-luna")!!.speeds.isEmpty())
        assertEquals("0.130.0", fastCodex.version)
        assertEquals("", claude.version)
        assertTrue(claude.models.all { it.speeds.isEmpty() })
        // A catalog entry without a name still reads as a word, never a raw tier id.
        val unnamed = parseAgents(JSONObject("""{"agents":[{"id":"codex","models":[{"id":"m","name":"M","speeds":[{"id":"priority"}]}]}]}"""))
        assertEquals("Fast", unnamed.single().models.single().speeds.single().name)
    }

    @Test fun `speed carries over only to models that offer it`() {
        val fast = ChatOptions("bypassPermissions", "gpt-6-astra", "high", CODEX, "priority")
        assertEquals("priority", resolveOptions(fastCodex, fast).speed)
        assertNull(resolveOptions(fastCodex, fast.copy(model = "gpt-6-luna")).speed)
        assertNull(resolveOptions(fastCatalog.first { it.id == CLAUDE }, fast.copy(agent = CLAUDE, model = "opus")).speed)
        assertNull(resolveOptions(fastCodex, fast.copy(speed = "turbo")).speed)
        // Saved options drop a speed the model no longer lists; the Mac would refuse it.
        assertNull(supportedOptions(fastCodex, fast.copy(model = "gpt-6-luna", effort = "low")).speed)
        assertEquals("priority", supportedOptions(fastCodex, fast).speed)
        // Unknown catalog: keep what was chosen.
        assertEquals("priority", supportedOptions(null, fast).speed)
    }

    @Test fun `last used options, drafts and chats remember speed`() {
        val fast = ChatOptions("auto", "gpt-6-astra", "high", CODEX, "priority")
        assertEquals(fast, ChatOptions.parse(fast.store()))
        assertEquals(fast.copy(speed = null), ChatOptions.parse(fast.copy(speed = null).store()))
        assertTrue(JSONObject(fast.copy(speed = null).store()).isNull("speed"))
        // Options saved before 0.7 have no speed.
        assertNull(ChatOptions.parse("""{"agent":"codex","mode":"auto","model":"gpt-6-astra","effort":"high"}""").speed)
        val draft = DraftChat.of("chat", "project", fast, 5)
        assertEquals(draft, DraftChat.parse("chat", draft.store()))
        assertEquals(fast, draft.options)
        assertEquals("priority", chatOptions(draft.json()).speed)
        // The Mac reports standard as null, which is not the word "null".
        assertNull(chatOptions(JSONObject("""{"agent":"codex","speed":null}""")).speed)
        // A new chat starts from the last options used with that agent.
        assertEquals(fast, resolveOptions(fastCodex, ChatOptions.parse(fast.store())))
    }

    @Test fun `a prompt's speed is part of its immutable delivery record`() {
        val prompt = PendingPrompt("id", "go", "auto", "gpt-6-astra", "high", "project", CODEX, speed = "priority")
        assertEquals("priority", prompt.json().getString("speed"))
        assertEquals(prompt, PendingPrompt.parse(prompt.json().toString()))
        assertEquals("priority", prompt.options.speed)
        // Standard is sent explicitly, so a retry never adopts a speed chosen later.
        val standard = prompt.copy(speed = null)
        assertTrue(standard.json().has("speed") && standard.json().isNull("speed"))
        assertNull(PendingPrompt.parse(standard.json().toString()).speed)
        assertNull(PendingPrompt.parse("""{"id":"old","text":"hi"}""").speed)
    }
}
