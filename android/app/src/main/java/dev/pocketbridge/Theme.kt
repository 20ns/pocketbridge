package dev.pocketbridge

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.spring
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Material You on a fixed teal seed. Warm neutrals carry the page; amber (tertiary) means "needs you", red means failed or Stop.
// Wallpaper colour is not used: it would recolour Working and Needs your answer.
private val Light = lightColorScheme(
    primary = Color(0xFF006B5F), onPrimary = Color.White, primaryContainer = Color(0xFFA0F2E2), onPrimaryContainer = Color(0xFF00201C),
    secondary = Color(0xFF4A635E), onSecondary = Color.White, secondaryContainer = Color(0xFFCCE8E1), onSecondaryContainer = Color(0xFF051F1B),
    tertiary = Color(0xFF8B5000), onTertiary = Color.White, tertiaryContainer = Color(0xFFFFDCBD), onTertiaryContainer = Color(0xFF2C1600),
    error = Color(0xFFBA1A1A), onError = Color.White, errorContainer = Color(0xFFFFDAD6), onErrorContainer = Color(0xFF410002),
    background = Color(0xFFF5F4EF), onBackground = Color(0xFF1A1C1A), surface = Color(0xFFF5F4EF), onSurface = Color(0xFF1A1C1A),
    surfaceVariant = Color(0xFFDEE4E0), onSurfaceVariant = Color(0xFF444A47), outline = Color(0xFF737975), outlineVariant = Color(0xFFC3C8C4),
    surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFEFEEE9), surfaceContainer = Color(0xFFE9E8E3),
    surfaceContainerHigh = Color(0xFFE3E2DD), surfaceContainerHighest = Color(0xFFDDDCD7), surfaceDim = Color(0xFFD6D5D0), surfaceBright = Color(0xFFF5F4EF),
    surfaceTint = Color(0xFF006B5F), inverseSurface = Color(0xFF2F312F), inverseOnSurface = Color(0xFFF1F0EB), inversePrimary = Color(0xFF83D5C6), scrim = Color.Black,
)
private val Dark = darkColorScheme(
    primary = Color(0xFF83D5C6), onPrimary = Color(0xFF003731), primaryContainer = Color(0xFF005048), onPrimaryContainer = Color(0xFFA0F2E2),
    secondary = Color(0xFFB1CCC5), onSecondary = Color(0xFF1C3530), secondaryContainer = Color(0xFF2A4A44), onSecondaryContainer = Color(0xFFCCE8E1),
    tertiary = Color(0xFFFFB86F), onTertiary = Color(0xFF4A2800), tertiaryContainer = Color(0xFF6A3C00), onTertiaryContainer = Color(0xFFFFDCBD),
    error = Color(0xFFFFB4AB), onError = Color(0xFF690005), errorContainer = Color(0xFF93000A), onErrorContainer = Color(0xFFFFDAD6),
    background = Color(0xFF0E1312), onBackground = Color(0xFFDEE4E1), surface = Color(0xFF0E1312), onSurface = Color(0xFFDEE4E1),
    surfaceVariant = Color(0xFF3F4946), onSurfaceVariant = Color(0xFFBEC9C5), outline = Color(0xFF889390), outlineVariant = Color(0xFF3F4946),
    surfaceContainerLowest = Color(0xFF090E0D), surfaceContainerLow = Color(0xFF161D1B), surfaceContainer = Color(0xFF1A2120),
    surfaceContainerHigh = Color(0xFF242B2A), surfaceContainerHighest = Color(0xFF2F3635), surfaceDim = Color(0xFF0E1312), surfaceBright = Color(0xFF343B39),
    surfaceTint = Color(0xFF83D5C6), inverseSurface = Color(0xFFDEE4E1), inverseOnSurface = Color(0xFF2B3130), inversePrimary = Color(0xFF006B5F), scrim = Color.Black,
)

/** Colours for code: token kinds, diff lines. Each passes 4.5:1 on [PocketColors.code]. */
@Immutable data class SyntaxColors(
    val keyword: Color, val string: Color, val comment: Color, val number: Color, val type: Color, val function: Color,
    val annotation: Color, val added: Color, val removed: Color, val addedLine: Color, val removedLine: Color,
)

/** Roles Material doesn't name: grouped list rows, the two sides of a conversation, the composer and code. */
@Immutable data class PocketColors(
    val row: Color, val userBubble: Color, val onUserBubble: Color, val composer: Color, val composerBorder: Color, val pill: Color, val panel: Color,
    val code: Color, val codeHeader: Color, val codeBorder: Color, val inlineCode: Color, val syntax: SyntaxColors,
)

private val LightPocket = PocketColors(
    row = Color.White, userBubble = Color(0xFF006B5F), onUserBubble = Color.White, composer = Color.White, composerBorder = Color(0xFFD6DAD5),
    pill = Color(0xFFEEEDE8), panel = Color.White,
    code = Color.White, codeHeader = Color(0xFFF1F0EB), codeBorder = Color(0xFFDCDFDA), inlineCode = Color(0xFFE7E6E0),
    syntax = SyntaxColors(
        keyword = Color(0xFF8C3A9C), string = Color(0xFF2E7531), comment = Color(0xFF6B726D), number = Color(0xFFB03E1B), type = Color(0xFF00687F),
        function = Color(0xFF2F5BAE), annotation = Color(0xFF8B5000), added = Color(0xFF1E6B33), removed = Color(0xFFA3261F),
        addedLine = Color(0xFFDFF3E3), removedLine = Color(0xFFFCE3E1),
    ),
)
private val DarkPocket = PocketColors(
    row = Color(0xFF1A2120), userBubble = Color(0xFF005048), onUserBubble = Color(0xFFA0F2E2), composer = Color(0xFF1A2120), composerBorder = Color(0xFF2C3533),
    pill = Color(0xFF2A3230), panel = Color(0xFF222A28),
    code = Color(0xFF161D1B), codeHeader = Color(0xFF1C2422), codeBorder = Color(0xFF2A3230), inlineCode = Color(0xFF2A3230),
    syntax = SyntaxColors(
        keyword = Color(0xFFD7A8EE), string = Color(0xFFA0D58B), comment = Color(0xFF8E9893), number = Color(0xFFF2A07B), type = Color(0xFF7CCFDF),
        function = Color(0xFFA0C2FF), annotation = Color(0xFFFFB86F), added = Color(0xFFA0D58B), removed = Color(0xFFFFB0A8),
        addedLine = Color(0xFF173323), removedLine = Color(0xFF3D1D1C),
    ),
)
private val LocalPocketColors = staticCompositionLocalOf { LightPocket }

/** App tokens beside MaterialTheme: `Pocket.colors.row`. */
object Pocket {
    val colors: PocketColors @Composable @ReadOnlyComposable get() = LocalPocketColors.current
}

// The Material 3 scale with firmer titles and tighter body tracking for long replies.
private val Base = Typography()
private val PocketTypography = Typography(
    displaySmall = Base.displaySmall,
    headlineLarge = Base.headlineLarge,
    headlineMedium = Base.headlineMedium.copy(fontWeight = FontWeight.Medium, letterSpacing = (-0.2).sp),
    headlineSmall = Base.headlineSmall.copy(fontWeight = FontWeight.Medium),
    titleLarge = Base.titleLarge.copy(fontWeight = FontWeight.Medium),
    titleMedium = Base.titleMedium.copy(fontWeight = FontWeight.Medium, letterSpacing = 0.1.sp),
    titleSmall = Base.titleSmall,
    bodyLarge = Base.bodyLarge.copy(letterSpacing = 0.15.sp),
    bodyMedium = Base.bodyMedium.copy(letterSpacing = 0.2.sp),
    bodySmall = Base.bodySmall.copy(letterSpacing = 0.3.sp),
    labelLarge = Base.labelLarge,
    labelMedium = Base.labelMedium.copy(letterSpacing = 0.3.sp),
    labelSmall = Base.labelSmall.copy(letterSpacing = 0.4.sp),
)

/** Reply paragraphs: body size with a looser line for long reading. */
val Typography.reading get() = bodyLarge.copy(lineHeight = 26.sp)
/** Code blocks and tool details. */
val Typography.code get() = bodyMedium.copy(fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 20.sp, letterSpacing = 0.sp)
/** Markdown headings inside replies: a step above body per level, never louder than the app bar. */
fun Typography.heading(level: Int) = when (level) {
    1 -> titleLarge.copy(fontSize = 22.sp, lineHeight = 30.sp, fontWeight = FontWeight.SemiBold)
    2 -> titleLarge.copy(fontSize = 19.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold)
    3 -> titleMedium.copy(fontSize = 17.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold)
    else -> titleSmall.copy(fontSize = 15.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold)
}

private val PocketShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp), small = RoundedCornerShape(8.dp), medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(16.dp), extraLarge = RoundedCornerShape(28.dp),
)

/** 4dp grid. */
object Spacing {
    val xxs = 2.dp; val xs = 4.dp; val sm = 8.dp; val md = 12.dp; val lg = 16.dp; val xl = 20.dp; val xxl = 24.dp; val xxxl = 32.dp; val huge = 48.dp
}

/** Corner radii beyond Material's five: grouped lists, conversation bubbles, cards and the composer. */
object Corners {
    val groupOuter = 20.dp; val groupInner = 4.dp; val bubble = 22.dp; val tail = 6.dp; val card = 24.dp; val composer = 28.dp
    val code = 14.dp
}

/** Sizes shared by several components. */
object Sizes {
    val touch = 48.dp; val smallIcon = 18.dp; val pill = 36.dp; val sendButton = 44.dp; val tile = 40.dp
    /** Composer image tiles and prompt image grids. */
    val thumbnail = 64.dp; val promptImage = 96.dp; val tinyIcon = 14.dp
}

/** Material 3 Expressive springs. Animator duration scale 0 (Remove animations) settles them at once. */
object Motion {
    fun <T> spatial(threshold: T? = null): FiniteAnimationSpec<T> = spring(dampingRatio = 0.9f, stiffness = 700f, visibilityThreshold = threshold)
    fun <T> fastSpatial(threshold: T? = null): FiniteAnimationSpec<T> = spring(dampingRatio = 0.9f, stiffness = 1400f, visibilityThreshold = threshold)
    fun <T> effects(): FiniteAnimationSpec<T> = spring(dampingRatio = 1f, stiffness = 1600f)
    fun <T> fastEffects(): FiniteAnimationSpec<T> = spring(dampingRatio = 1f, stiffness = 3800f)
    val Emphasized = CubicBezierEasing(0.2f, 0f, 0f, 1f)
}

@Composable fun PocketTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    CompositionLocalProvider(LocalPocketColors provides if (dark) DarkPocket else LightPocket) {
        MaterialTheme(colorScheme = if (dark) Dark else Light, typography = PocketTypography, shapes = PocketShapes, content = content)
    }
}

/** Material Symbols the core icon set lacks, from their published path data. */
object PocketIcons {
    private fun icon(name: String, path: String) = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f, autoMirror = false)
        .addPath(addPathNodes(path), fill = SolidColor(Color.Black)).build()
    private fun outline(name: String, path: String) = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f, autoMirror = false)
        .addPath(addPathNodes(path), fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round).build()

    val Stop = materialIcon("Stop") { materialPath { moveTo(8f, 6f); horizontalLineTo(16f); quadTo(18f, 6f, 18f, 8f); verticalLineTo(16f); quadTo(18f, 18f, 16f, 18f); horizontalLineTo(8f); quadTo(6f, 18f, 6f, 16f); verticalLineTo(8f); quadTo(6f, 6f, 8f, 6f); close() } }
    val Copy = icon("Copy", "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z")
    val Sort = icon("Sort", "M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z")
    val Terminal = icon("Terminal", "M20 4H4c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.89-2-2-2zm0 14H4V8h16v10zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4-4 4z")
    val ArrowUp = icon("ArrowUp", "M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z")
    val Folder = icon("Folder", "M9.17 6l2 2H20v10H4V6h5.17M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z")
    val Help = icon("Help", "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z")
    val Error = icon("Error", "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z")
    val Pause = icon("Pause", "M6 19h4V5H6v14zm8-14v14h4V5h-4z")
    val Shield = icon("Shield", "M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z")
    val Laptop = icon("Laptop", "M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z")
    val Download = icon("Download", "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z")
    val AddPhoto = icon("AddPhoto", "M19 7v2.99s-1.99.01-2 0V7h-3s.01-1.99 0-2h3V2h2v3h3v2h-3zm-3 4V8h-3V5H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-8h-3zM5 19l3-4 2 3 3-4 4 5H5z")
    val BrokenImage = icon("BrokenImage", "M21 5v6.59l-3-3.01-4 4.01-4-4-4 4-3-3.01V5c0-1.1.9-2 2-2h14c1.1 0 2 .9 2 2zm-3 6.42l3 3.01V19c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2v-6.58l3 2.99 4-4 4 4 4-3.99z")
    val SkipNext = icon("SkipNext", "M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z")
    val StopCircle = icon("StopCircle", "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4 14H8V8h8v8z")
    val Branch = outline("Branch", "M8.25 5.5a2.25 2.25 0 1 1-4.5 0a2.25 2.25 0 1 1 4.5 0zM8.25 18.5a2.25 2.25 0 1 1-4.5 0a2.25 2.25 0 1 1 4.5 0zM20.25 5.5a2.25 2.25 0 1 1-4.5 0a2.25 2.25 0 1 1 4.5 0zM6 7.75v8.5M18 7.75v1c0 2.5-2 4-4.5 4h-3c-2.6 0-4.5 1.4-4.5 3.5")
    /** Claude's mark in lists: a plain spark, not the brand logo. Codex uses [Terminal]. */
    val Spark = outline("Spark", "M12 3.5v17M3.5 12h17M6 6l12 12M18 6L6 18")
}

fun statusLabel(status: String) = when (status) {
    "running" -> "Working"; "waiting" -> "Needs your answer"; "stopping" -> "Stopping"
    "interrupted" -> "Interrupted"; "error" -> "Failed"; "draft" -> "Draft"; "unconfirmed" -> "Not confirmed"; else -> "Ready"
}
fun isWorking(status: String?) = status in listOf("running", "waiting", "stopping")

/** The colour that goes with [statusLabel]. Always shown with the word or an icon, never alone. */
@Composable @ReadOnlyComposable fun statusColor(status: String): Color {
    val colors = MaterialTheme.colorScheme
    return when (status) { "waiting" -> colors.tertiary; "error", "unconfirmed" -> colors.error; "interrupted", "draft", "idle", "" -> colors.onSurfaceVariant; else -> colors.primary }
}

/** Corner shape for row [index] of [count] in a grouped list: round outer ends, tight joins. */
fun groupShape(index: Int, count: Int, outer: Dp = Corners.groupOuter, inner: Dp = Corners.groupInner) = RoundedCornerShape(
    topStart = if (index == 0) outer else inner, topEnd = if (index == 0) outer else inner,
    bottomStart = if (index == count - 1) outer else inner, bottomEnd = if (index == count - 1) outer else inner,
)
