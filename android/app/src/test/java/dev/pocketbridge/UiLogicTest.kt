package dev.pocketbridge

import java.time.ZoneOffset
import java.util.Locale
import org.junit.Assert.*
import org.junit.Test

class UiLogicTest {
    private fun names(models: List<ModelInfo>) = models.map { it.name }

    @Test fun `current models come first and older versions follow`() {
        val claude = listOf("Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 4.5", "Opus 5", "Opus 4.8", "Sonnet 4.6").map { ModelInfo(it, it) }
        val (latest, older) = modelTiers(claude)
        assertEquals(listOf("Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 4.5"), names(latest))
        assertEquals(listOf("Opus 5", "Opus 4.8", "Sonnet 4.6"), names(older))
    }

    @Test fun `a broader older name is an older version of a newer family`() {
        val codex = listOf("GPT-6-Astra", "GPT-6-Sol", "GPT-6-Luna", "GPT-5.5").map { ModelInfo(it, it) }
        assertEquals(listOf("GPT-5.5"), names(modelTiers(codex).second))
        val real = listOf("gpt-5.1-codex-max", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1", "gpt-5-codex", "gpt-5").map { ModelInfo(it, it) }
        assertEquals(listOf("gpt-5-codex", "gpt-5"), names(modelTiers(real).second))
    }

    @Test fun `names without versions are never older`() {
        val models = listOf("Opus", "Sonnet", "o3", "Default").map { ModelInfo(it, it) }
        assertEquals(models, modelTiers(models).first)
    }

    @Test fun `reset times read as a countdown, then a weekday, then a date`() {
        val now = 1_791_000_000_000L
        val utc = ZoneOffset.UTC
        assertEquals("", resetLabel(0, now, utc, Locale.US))
        assertEquals("Resets now", resetLabel(now + 20_000, now, utc, Locale.US))
        assertEquals("Resets in 42m", resetLabel(now + 42 * 60_000, now, utc, Locale.US))
        assertEquals("Resets in 2h 24m", resetLabel(now + 144 * 60_000, now, utc, Locale.US))
        assertEquals("Resets in 3h", resetLabel(now + 180 * 60_000, now, utc, Locale.US))
        assertEquals("Resets Tue", resetLabel(now + 3L * 86_400_000, now, utc, Locale.US))
        assertEquals("Resets Oct 15", resetLabel(now + 12L * 86_400_000, now, utc, Locale.US))
    }

    @Test fun `the meter shows the tightest limit and full limits are critical`() {
        val claude = AgentUsage("claude", "Claude", "Max", listOf(UsageLimit("session", "5-hour session", 34, 0, "normal"), UsageLimit("weekly", "Weekly", 61, 0, "normal")), null, 0)
        val codex = AgentUsage("codex", "Codex", "Pro Lite", listOf(UsageLimit("secondary", "5-hour", 82, 0, "warning")), 2353.72, 0)
        assertEquals("5-hour", tightestLimit(listOf(claude, codex))?.second?.label)
        assertNull(tightestLimit(emptyList()))
        assertEquals("critical", limitSeverity(UsageLimit("w", "Weekly", 100, 0, "warning")))
        assertEquals("warning", limitSeverity(UsageLimit("w", "Weekly", 82, 0, "warning")))
    }

    @Test fun `token counts and paths stay short`() {
        assertEquals("412k", compactTokens(412_000))
        assertEquals("1M", compactTokens(1_000_000))
        assertEquals("1.5M", compactTokens(1_500_000))
        assertEquals("950", compactTokens(950))
        assertEquals("~/Desktop/…/projects/site", compactPath("/Users/nav/Desktop/PocketBridge/work/projects/site"))
        assertEquals("~/Desktop/PocketBridge", compactPath("/Users/nav/Desktop/PocketBridge"))
    }
}
