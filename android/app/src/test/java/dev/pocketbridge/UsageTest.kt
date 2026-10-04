package dev.pocketbridge

import java.time.ZoneOffset
import java.util.Locale
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class UsageTest {
    private val usage = parseUsage(JSONObject("""
        {"agents":[
          {"id":"codex","name":"Codex","plan":"Pro","limits":[
            {"id":"primary","label":"5-hour","percent":91,"resetsAt":0,"severity":"critical","window":"session"},
            {"id":"secondary","label":"Weekly","percent":17,"resetsAt":0,"severity":"normal","window":"weekly"}],
           "resets":{"available":3,"credits":[
             {"id":"c-late","title":"Reset","description":"","expiresAt":null},
             {"id":"c-soon","title":"Reset","description":"","expiresAt":1800000000000},
             {"id":"c-mid","title":"Reset","description":"","expiresAt":1900000000000}]}},
          {"id":"claude","name":"Claude","plan":"Max","limits":[
            {"id":"session","label":"5-hour session","percent":80,"resetsAt":0,"severity":"warning","window":"session"},
            {"id":"weekly","label":"Weekly","percent":42,"resetsAt":0,"severity":"normal","window":"weekly"},
            {"id":"weekly_opus","label":"Weekly · Opus","percent":55,"resetsAt":0,"severity":"normal","window":"weekly"}]}]}
    """))
    private val claude = usage.first { it.id == CLAUDE }
    private val codex = usage.first { it.id == CODEX }

    @Test fun `the top bar shows each enabled agent's weekly use, Claude first, never the 5-hour window`() {
        val rings = weeklyUsage(usage, setOf(CLAUDE, CODEX))
        assertEquals(listOf(CLAUDE, CODEX), rings.map { it.first.id })
        // Claude's tightest weekly window, not its fuller 5-hour session.
        assertEquals(55, rings[0].second.percent)
        assertEquals(17, rings[1].second.percent)
        assertEquals(listOf(CODEX), weeklyUsage(usage, setOf(CODEX)).map { it.first.id })
        // Before the catalog arrives every reported agent shows.
        assertEquals(2, weeklyUsage(usage, null).size)
        assertTrue(weeklyUsage(emptyList(), setOf(CLAUDE)).isEmpty())
    }

    @Test fun `older Macs without windows are read from ids and labels, and an agent without a weekly limit shows its tightest`() {
        val legacy = AgentUsage("claude", "Claude", "", listOf(UsageLimit("session", "5-hour session", 70, 0, "normal"), UsageLimit("weekly_all", "Weekly", 30, 0, "normal")), null, 0)
        assertEquals(30, weeklyUsage(listOf(legacy), null).single().second.percent)
        val sessionOnly = AgentUsage("codex", "Codex", "", listOf(UsageLimit("primary", "5-hour", 64, 0, "normal", "session")), null, 0)
        assertEquals(64, weeklyUsage(listOf(sessionOnly), null).single().second.percent)
        assertFalse(UsageLimit("weekly", "Weekly", 1, 0, "normal", "other").weekly)
    }

    @Test fun `banked resets parse and the soonest expiring credit goes first`() {
        val resets = codex.resets!!
        assertEquals(3, resets.available)
        assertEquals("c-soon", resets.next?.id)
        assertNull(resets.credits.first().expiresAt)
        assertNull(claude.resets)
        // An agent with only banked resets still shows.
        val only = parseUsage(JSONObject("""{"agents":[{"id":"codex","name":"Codex","limits":[],"resets":{"available":0,"credits":[]}}]}"""))
        assertEquals(0, only.single().resets?.available)
        assertNull(Resets(0, emptyList()).next)
    }

    @Test fun `a reset attempt keeps its idempotency key until the Mac answers for sure`() {
        var minted = 0
        val first = resetAttempt("", "c-soon") { "key-${++minted}" }
        assertEquals(ResetAttempt("key-1", "c-soon"), first)
        // Saved before the request: a retry after a lost answer sends the same key and credit, even if the list changed.
        assertEquals(first, resetAttempt(first.store(), "c-mid") { "key-${++minted}" })
        assertEquals(1, minted)
        assertEquals(JSONObject().put("id", "key-1").put("creditId", "c-soon").toString(), first.body().toString())
        assertFalse(ResetAttempt("k", null).body().has("creditId"))
        assertEquals(ResetAttempt("k", null), ResetAttempt.parse(ResetAttempt("k", null).store()))
        // Unreadable saved state never blocks a new attempt.
        assertEquals("key-2", resetAttempt("{nope", null) { "key-${++minted}" }.id)
        // A definite refusal settles a failed attempt: the Mac's own 400 and 409, and Codex's refusal relayed as 502.
        assertTrue(resetSettled(ApiError(400, "Unknown credit id")))
        assertTrue(resetSettled(ApiError(409, "Codex is off")))
        assertTrue(resetSettled(ApiError(502, "Unknown reset credit")))
        // An unknown outcome keeps the key, since the credit may have been spent: no answer, timeouts, other errors.
        assertFalse(resetSettled(ApiError(504, "Codex didn't answer")))
        assertFalse(resetSettled(ApiError(408, "Timeout")))
        assertFalse(resetSettled(ApiError(500, "Server error")))
        assertFalse(resetSettled(java.io.IOException("reset")))
        assertFalse(resetSettled(java.net.SocketTimeoutException("reset")))
        assertEquals("Codex limits reset", resetOutcomeLabel("reset"))
        assertEquals("No resets left", resetOutcomeLabel("noCredit"))
    }

    @Test fun `a spent reset leaves the count at once, before fresh usage arrives`() {
        val spent = afterReset(usage, "c-soon", "reset").first { it.id == CODEX }.resets!!
        assertEquals(2, spent.available)
        assertEquals(listOf("c-late", "c-mid"), spent.credits.map { it.id })
        assertEquals(2, afterReset(usage, null, "alreadyRedeemed").first { it.id == CODEX }.resets!!.available)
        assertEquals(Resets(0, emptyList()), afterReset(usage, "c-soon", "noCredit").first { it.id == CODEX }.resets)
        assertEquals(usage, afterReset(usage, "c-soon", "nothingToReset"))
        // Claude has no banked resets and is never touched.
        assertEquals(claude, afterReset(usage, "c-soon", "reset").first { it.id == CLAUDE })
    }

    @Test fun `expiry reads like reset times`() {
        val now = 1_791_000_000_000L
        assertEquals("Expires in 5h", expiryLabel(now + 300 * 60_000, now, ZoneOffset.UTC, Locale.US))
        assertEquals("Expires Oct 15", expiryLabel(now + 12L * 86_400_000, now, ZoneOffset.UTC, Locale.US))
        assertEquals("", expiryLabel(0, now))
    }
}
