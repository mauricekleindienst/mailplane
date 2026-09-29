package app.mailplane.android.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.mailplane.android.ui.theme.Frost

/** The Mailplane mark (same geometry as assets/icon.svg), coloured by theme + accent. */
@Composable
fun BrandMark(size: Dp, modifier: Modifier = Modifier) {
    val c = Frost.colors
    Canvas(modifier.size(size)) {
        // Source artwork uses the 824px macOS grid starting at 100,100
        val s = this.size.width / 824f
        fun p(x: Float, y: Float) = Offset((x - 100f) * s, (y - 100f) * s)
        drawRoundRect(c.ink, cornerRadius = CornerRadius(186f * s))
        val env = Path().apply {
            moveTo(p(236f, 500f).x, p(236f, 500f).y)
            lineTo(p(512f, 676f).x, p(512f, 676f).y); lineTo(p(788f, 500f).x, p(788f, 500f).y)
            lineTo(p(788f, 736f).x, p(788f, 736f).y)
            quadraticTo(p(788f, 792f).x, p(788f, 792f).y, p(732f, 792f).x, p(732f, 792f).y)
            lineTo(p(292f, 792f).x, p(292f, 792f).y)
            quadraticTo(p(236f, 792f).x, p(236f, 792f).y, p(236f, 736f).x, p(236f, 736f).y)
            close()
        }
        drawPath(env, c.surface)
        val flap = Path().apply {
            moveTo(p(236f, 500f).x, p(236f, 500f).y); lineTo(p(512f, 676f).x, p(512f, 676f).y); lineTo(p(788f, 500f).x, p(788f, 500f).y)
        }
        drawPath(flap, c.inkTertiary, style = Stroke(width = 16f * s, cap = StrokeCap.Round, join = StrokeJoin.Round))
        // Plane: translate(560,206) rotate(-6°)
        val a = Math.toRadians(-6.0)
        fun q(px: Float, py: Float): Offset {
            val x = 560 + px * Math.cos(a) - py * Math.sin(a)
            val y = 206 + px * Math.sin(a) + py * Math.cos(a)
            return p(x.toFloat(), y.toFloat())
        }
        fun tri(a1: Offset, b: Offset, c2: Offset) = Path().apply { moveTo(a1.x, a1.y); lineTo(b.x, b.y); lineTo(c2.x, c2.y); close() }
        drawPath(tri(q(232f, 0f), q(0f, 104f), q(96f, 142f)), c.accent)
        drawPath(tri(q(232f, 0f), q(96f, 142f), q(126f, 236f)), c.accentDeep)
    }
}

/** Neutral initials avatar (no rainbow colours). */
@Composable
fun Avatar(name: String, size: Dp = 40.dp) {
    val c = Frost.colors
    val initials = name.split(Regex("\\s+")).filter { it.isNotBlank() }.take(2).joinToString("") { it.take(1) }.uppercase().ifEmpty { "?" }
    Box(Modifier.size(size).clip(CircleShape).background(c.avatar), contentAlignment = Alignment.Center) {
        Text(initials, color = c.inkSecondary, fontSize = (size.value * 0.36f).sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
fun AccountDot(hex: String, size: Dp = 8.dp) {
    val color = runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrDefault(Frost.colors.inkTertiary)
    Box(Modifier.size(size).clip(CircleShape).background(color))
}

/** The soft accent wash used for selection and message headers (desktop: --lime-wash). */
@Composable
fun accentWash(): Brush {
    val c = Frost.colors
    val a = if (c.isDark) 0.2f else 0.62f
    return Brush.linearGradient(
        0f to c.accent.copy(alpha = a),
        0.4f to c.accent.copy(alpha = a * 0.3f),
        0.75f to Color.Transparent,
        start = Offset.Zero, end = Offset(900f, 700f),
    )
}

@Composable
fun AccentButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val c = Frost.colors
    Button(
        onClick = onClick, enabled = enabled, modifier = modifier.height(50.dp),
        shape = RoundedCornerShape(14.dp),
        colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = c.onAccent,
            disabledContainerColor = c.tile, disabledContentColor = c.inkTertiary),
        contentPadding = PaddingValues(horizontal = 22.dp),
    ) { Text(text, style = MaterialTheme.typography.labelLarge) }
}

@Composable
fun TileButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Frost.colors
    Button(
        onClick = onClick, modifier = modifier.height(50.dp), shape = RoundedCornerShape(14.dp),
        colors = ButtonDefaults.buttonColors(containerColor = c.tile, contentColor = c.ink),
        contentPadding = PaddingValues(horizontal = 22.dp),
    ) { Text(text, style = MaterialTheme.typography.labelLarge) }
}

/** Grouped list container, like the desktop settings groups. */
@Composable
fun Group(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val c = Frost.colors
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(c.raised)) { content() }
}

@Composable
fun SectionLabel(text: String) {
    Text(text, color = Frost.colors.inkTertiary, style = MaterialTheme.typography.labelMedium,
        modifier = Modifier.padding(start = 6.dp, top = 18.dp, bottom = 8.dp))
}

@Composable
fun InfoCard(title: String, body: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    val c = Frost.colors
    Column(
        modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(accentWash()).background(c.raised.copy(alpha = 0.6f)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = c.ink)
        Text(body, style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary)
        action?.invoke()
    }
}

@Composable
fun Pill(text: String, selected: Boolean, dotHex: String? = null, badge: Int = 0, onClick: () -> Unit) {
    val c = Frost.colors
    Row(
        Modifier.clip(RoundedCornerShape(10.dp)).background(if (selected) c.tileActive else c.tile)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (dotHex != null) AccountDot(dotHex, 7.dp)
        Text(text, style = MaterialTheme.typography.labelMedium, color = if (selected) c.ink else c.inkSecondary,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (badge > 0) Text(badge.toString(), style = MaterialTheme.typography.labelSmall, color = c.inkTertiary)
    }
}
