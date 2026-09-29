package app.mailplane.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import app.mailplane.android.data.ThemeMode

/** "Frost" palette — the same tokens as the desktop theme.css. */
@Immutable
data class FrostColors(
    val canvas: Color,
    val surface: Color,
    val raised: Color,
    val tile: Color,
    val tileActive: Color,
    val avatar: Color,
    val ink: Color,
    val inkSecondary: Color,
    val inkTertiary: Color,
    val accent: Color,
    val accentDeep: Color,
    val onAccent: Color,
    val danger: Color,
    val isDark: Boolean,
)

val LocalFrost = staticCompositionLocalOf { frost(dark = false, accent = Color(0xFFE2F47C)) }

fun frost(dark: Boolean, accent: Color): FrostColors {
    val lightAccent = accent.luminance() > 0.4f
    val deep = if (lightAccent) lerp(accent, Color.Black, 0.22f) else lerp(accent, Color.White, 0.2f)
    return if (dark) FrostColors(
        canvas = Color(0xFF121413), surface = Color(0xFF1E211F), raised = Color(0xFF242725),
        tile = Color(0xFF272A28), tileActive = Color(0xFF323633), avatar = Color(0xFF333735),
        ink = Color(0xFFE7EAE8), inkSecondary = Color(0xFF9BA19D), inkTertiary = Color(0xFF646A66),
        accent = accent, accentDeep = deep, onAccent = if (lightAccent) Color(0xFF262A28) else Color(0xFFF3F5F4),
        danger = Color(0xFFD9695A), isDark = true,
    ) else FrostColors(
        canvas = Color(0xFFE2E6E3), surface = Color(0xFFF1F3F2), raised = Color(0xFFFAFBFA),
        tile = Color(0xFFE3E7E4), tileActive = Color(0xFFD5DAD6), avatar = Color(0xFFD6DBD7),
        ink = Color(0xFF262A28), inkSecondary = Color(0xFF6B716D), inkTertiary = Color(0xFFA0A6A2),
        accent = accent, accentDeep = deep, onAccent = if (lightAccent) Color(0xFF262A28) else Color(0xFFF3F5F4),
        danger = Color(0xFFC4513F), isDark = false,
    )
}

private fun lerp(a: Color, b: Color, t: Float) = Color(
    red = a.red + (b.red - a.red) * t,
    green = a.green + (b.green - a.green) * t,
    blue = a.blue + (b.blue - a.blue) * t,
    alpha = 1f,
)

private val FrostTypography = Typography().let { t ->
    t.copy(
        headlineMedium = TextStyle(fontSize = 26.sp, fontWeight = FontWeight.Normal, letterSpacing = (-0.5).sp),
        headlineSmall = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.Normal, letterSpacing = (-0.3).sp),
        titleLarge = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.Normal, letterSpacing = (-0.2).sp),
        titleMedium = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium),
        bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
        bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        bodySmall = TextStyle(fontSize = 12.5.sp, lineHeight = 17.sp),
        labelLarge = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
        labelMedium = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium),
        labelSmall = TextStyle(fontSize = 11.sp),
    )
}

@Composable
fun MailplaneTheme(mode: ThemeMode, accentArgb: Long, content: @Composable () -> Unit) {
    val dark = when (mode) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
    }
    val f = frost(dark, Color(accentArgb))
    val scheme = if (dark) darkColorScheme(
        primary = f.accent, onPrimary = f.onAccent, secondary = f.inkSecondary,
        background = f.canvas, onBackground = f.ink, surface = f.surface, onSurface = f.ink,
        surfaceVariant = f.tile, onSurfaceVariant = f.inkSecondary, outline = f.inkTertiary,
        outlineVariant = f.tileActive, error = f.danger, surfaceContainer = f.surface,
        surfaceContainerHigh = f.raised, surfaceContainerLow = f.surface, surfaceContainerLowest = f.canvas,
        secondaryContainer = f.tileActive, onSecondaryContainer = f.ink,
    ) else lightColorScheme(
        primary = f.accent, onPrimary = f.onAccent, secondary = f.inkSecondary,
        background = f.canvas, onBackground = f.ink, surface = f.surface, onSurface = f.ink,
        surfaceVariant = f.tile, onSurfaceVariant = f.inkSecondary, outline = f.inkTertiary,
        outlineVariant = f.tileActive, error = f.danger, surfaceContainer = f.surface,
        surfaceContainerHigh = f.raised, surfaceContainerLow = f.surface, surfaceContainerLowest = f.canvas,
        secondaryContainer = f.tileActive, onSecondaryContainer = f.ink,
    )
    CompositionLocalProvider(LocalFrost provides f) {
        MaterialTheme(colorScheme = scheme, typography = FrostTypography, content = content)
    }
}

object Frost {
    val colors: FrostColors @Composable get() = LocalFrost.current
}
