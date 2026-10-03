package dev.pocketbridge

import android.text.format.DateUtils
import org.junit.Assert.*
import org.junit.Test

class ProjectActivityTest {
    @Test fun `latest means activity in the last seven days`() {
        val now = 10L * DateUtils.DAY_IN_MILLIS
        assertFalse(isLatestProject(now - 8L * DateUtils.DAY_IN_MILLIS, now))
        assertTrue(isLatestProject(now - 7L * DateUtils.DAY_IN_MILLIS, now))
        assertTrue(isLatestProject(now - 1L * DateUtils.DAY_IN_MILLIS, now))
    }

    @Test fun `project activity is the newest metadata or managed chat timestamp`() {
        assertEquals(90L, projectActivity(lastUsedAt = 10L, newestChatUpdatedAt = 90L))
        assertEquals(90L, projectActivity(lastUsedAt = 90L, newestChatUpdatedAt = 10L))
        assertEquals(0L, projectActivity(lastUsedAt = -1L, newestChatUpdatedAt = 0L))
    }

    @Test fun `activity ordering has a stable name tie breaker`() {
        assertTrue(compareProjectActivity(20, "Beta", 30, "Alpha", newest = true) > 0)
        assertTrue(compareProjectActivity(20, "Beta", 30, "Alpha", newest = false) < 0)
        assertTrue(compareProjectActivity(20, "Alpha", 20, "Beta", newest = true) < 0)
    }
}
