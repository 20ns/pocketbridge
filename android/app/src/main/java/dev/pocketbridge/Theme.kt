package dev.pocketbridge

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Warm white and charcoal neutrals with a restrained teal accent. Amber (tertiary) marks "needs you".
private val Light = lightColorScheme(
    primary = Color(0xFF006A60), onPrimary = Color.White, primaryContainer = Color(0xFF9EF2E4), onPrimaryContainer = Color(0xFF00201C),
    secondary = Color(0xFF4A635F), onSecondary = Color.White, secondaryContainer = Color(0xFFD3E9E3), onSecondaryContainer = Color(0xFF0B201C),
    tertiary = Color(0xFF8A5100), onTertiary = Color.White, tertiaryContainer = Color(0xFFFFDDB8), onTertiaryContainer = Color(0xFF2C1600),
    error = Color(0xFFBA1A1A), onError = Color.White, errorContainer = Color(0xFFFFDAD6), onErrorContainer = Color(0xFF410002),
    background = Color(0xFFFAF9F5), onBackground = Color(0xFF1B1C1A), surface = Color(0xFFFAF9F5), onSurface = Color(0xFF1B1C1A),
    surfaceVariant = Color(0xFFE1E4DF), onSurfaceVariant = Color(0xFF474B47), outline = Color(0xFF767A76), outlineVariant = Color(0xFFC7CBC6),
    surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFF4F3EE), surfaceContainer = Color(0xFFEFEEE9),
    surfaceContainerHigh = Color(0xFFE9E8E3), surfaceContainerHighest = Color(0xFFE3E3DE), surfaceDim = Color(0xFFDBDAD5), surfaceBright = Color(0xFFFAF9F5),
    inverseSurface = Color(0xFF30312E), inverseOnSurface = Color(0xFFF2F1EC), inversePrimary = Color(0xFF81D5C8), scrim = Color.Black,
)
private val Dark = darkColorScheme(
    primary = Color(0xFF81D5C8), onPrimary = Color(0xFF003731), primaryContainer = Color(0xFF005048), onPrimaryContainer = Color(0xFF9EF2E4),
    secondary = Color(0xFFB1CCC6), onSecondary = Color(0xFF1C3531), secondaryContainer = Color(0xFF234C46), onSecondaryContainer = Color(0xFFD3E9E3),
    tertiary = Color(0xFFFFB86E), onTertiary = Color(0xFF4A2800), tertiaryContainer = Color(0xFF693C00), onTertiaryContainer = Color(0xFFFFDDB8),
    error = Color(0xFFFFB4AB), onError = Color(0xFF690005), errorContainer = Color(0xFF93000A), onErrorContainer = Color(0xFFFFDAD6),
    background = Color(0xFF101413), onBackground = Color(0xFFE0E3E0), surface = Color(0xFF101413), onSurface = Color(0xFFE0E3E0),
    surfaceVariant = Color(0xFF3F4945), onSurfaceVariant = Color(0xFFBEC9C4), outline = Color(0xFF89938F), outlineVariant = Color(0xFF3F4945),
    surfaceContainerLowest = Color(0xFF0B0F0E), surfaceContainerLow = Color(0xFF181C1B), surfaceContainer = Color(0xFF1C201F),
    surfaceContainerHigh = Color(0xFF262B29), surfaceContainerHighest = Color(0xFF313634), surfaceDim = Color(0xFF101413), surfaceBright = Color(0xFF363A39),
    inverseSurface = Color(0xFFE0E3E0), inverseOnSurface = Color(0xFF2D3130), inversePrimary = Color(0xFF006A60), scrim = Color.Black,
)

@Composable fun PocketTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, content = content)
}

object PocketIcons {
    val Stop = materialIcon("Stop") { materialPath { moveTo(8f, 6f); horizontalLineTo(16f); quadTo(18f, 6f, 18f, 8f); verticalLineTo(16f); quadTo(18f, 18f, 16f, 18f); horizontalLineTo(8f); quadTo(6f, 18f, 6f, 16f); verticalLineTo(8f); quadTo(6f, 6f, 8f, 6f); close() } }
    val Copy = materialIcon("Copy") {
        materialPath {
            moveTo(16f, 1f); horizontalLineTo(4f); curveTo(2.9f, 1f, 2f, 1.9f, 2f, 3f); verticalLineToRelative(14f); horizontalLineToRelative(2f); verticalLineTo(3f); horizontalLineToRelative(12f); verticalLineTo(1f); close()
            moveTo(19f, 5f); horizontalLineTo(8f); curveTo(6.9f, 5f, 6f, 5.9f, 6f, 7f); verticalLineToRelative(14f); curveToRelative(0f, 1.1f, 0.9f, 2f, 2f, 2f); horizontalLineToRelative(11f); curveToRelative(1.1f, 0f, 2f, -0.9f, 2f, -2f); verticalLineTo(7f); curveToRelative(0f, -1.1f, -0.9f, -2f, -2f, -2f); close()
            moveTo(19f, 21f); horizontalLineTo(8f); verticalLineTo(7f); horizontalLineToRelative(11f); verticalLineToRelative(14f); close()
        }
    }
    val Terminal = materialIcon("Terminal") {
        materialPath {
            moveTo(20f, 4f); horizontalLineTo(4f); curveTo(2.89f, 4f, 2f, 4.9f, 2f, 6f); verticalLineToRelative(12f); curveToRelative(0f, 1.1f, 0.89f, 2f, 2f, 2f); horizontalLineToRelative(16f); curveToRelative(1.1f, 0f, 2f, -0.9f, 2f, -2f); verticalLineTo(6f); curveTo(22f, 4.9f, 21.11f, 4f, 20f, 4f); close()
            moveTo(20f, 18f); horizontalLineTo(4f); verticalLineTo(8f); horizontalLineToRelative(16f); verticalLineTo(18f); close()
            moveTo(18f, 17f); horizontalLineToRelative(-6f); verticalLineToRelative(-2f); horizontalLineToRelative(6f); verticalLineTo(17f); close()
            moveTo(7.5f, 17f); lineToRelative(-1.41f, -1.41f); lineTo(8.67f, 13f); lineToRelative(-2.59f, -2.59f); lineTo(7.5f, 9f); lineToRelative(4f, 4f); lineTo(7.5f, 17f); close()
        }
    }
}

fun statusLabel(status: String) = when (status) {
    "running" -> "Working"; "waiting" -> "Needs your answer"; "stopping" -> "Stopping"
    "interrupted" -> "Interrupted"; "error" -> "Failed"; else -> "Ready"
}
fun isWorking(status: String?) = status in listOf("running", "waiting", "stopping")
/** Preferred first, then the Mac's order; never a silent switch away from what the chat uses. */
fun defaultMode(modes: List<String>) = if ("bypassPermissions" in modes || modes.isEmpty()) "bypassPermissions" else modes.first()

fun modeLabel(mode: String) = when (mode) {
    "bypassPermissions" -> "Bypass permissions"; "auto" -> "Auto"; "acceptEdits" -> "Accept edits"; "plan" -> "Plan"; else -> "Manual"
}
fun modelLabel(model: String) = when (model) {
    "default" -> "Default"; "opus" -> "Opus"; "sonnet" -> "Sonnet"; "haiku" -> "Haiku"; else -> model
}
fun effortLabel(effort: String) = when (effort) {
    "default" -> "Default"; "low" -> "Low"; "medium" -> "Medium"; "high" -> "High"; "xhigh" -> "Extra high"; "max" -> "Max"; else -> effort
}
