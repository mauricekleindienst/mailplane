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
import androidx.compose.material.icons.outlined.AllInbox
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.Newspaper
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material.icons.outlined.SupportAgent
import androidx.compose.material.icons.outlined.VerifiedUser
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
    ) { Text(app.mailplane.android.ui.tr(text), style = MaterialTheme.typography.labelLarge) }
}

@Composable
fun TileButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Frost.colors
    Button(
        onClick = onClick, modifier = modifier.height(50.dp), shape = RoundedCornerShape(14.dp),
        colors = ButtonDefaults.buttonColors(containerColor = c.tile, contentColor = c.ink),
        contentPadding = PaddingValues(horizontal = 22.dp),
    ) { Text(app.mailplane.android.ui.tr(text), style = MaterialTheme.typography.labelLarge) }
}

/** Grouped list container, like the desktop settings groups. */
@Composable
fun Group(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val c = Frost.colors
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(c.raised)) { content() }
}

@Composable
fun SectionLabel(text: String) {
    Text(app.mailplane.android.ui.tr(text), color = Frost.colors.inkTertiary, style = MaterialTheme.typography.labelMedium,
        modifier = Modifier.padding(start = 6.dp, top = 18.dp, bottom = 8.dp))
}

@Composable
fun InfoCard(title: String, body: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    val c = Frost.colors
    Column(
        modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(accentWash()).background(c.raised.copy(alpha = 0.6f)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(app.mailplane.android.ui.tr(title), style = MaterialTheme.typography.titleMedium, color = c.ink)
        Text(app.mailplane.android.ui.tr(body), style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary)
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

// ── Sender pictures ────────────────────────────────────────────────────────────

/**
 * Sender avatar: initials for people; for automated senders (receipts,
 * notifications, newsletters, …) a placeholder picture that says what they are.
 */
@Composable
fun SenderAvatar(name: String, email: String, size: Dp = 40.dp) {
    val c = Frost.colors
    val kind = app.mailplane.core.Senders.kindOf(email)
    if (kind == app.mailplane.core.SenderKind.PERSON) {
        Box(Modifier.size(size).clip(CircleShape).background(c.avatar), contentAlignment = Alignment.Center) {
            Text(app.mailplane.core.Senders.initials(name.ifBlank { email }), color = c.inkSecondary,
                fontSize = (size.value * 0.36f).sp, fontWeight = FontWeight.Medium)
        }
        return
    }
    val bg = if (kind == app.mailplane.core.SenderKind.BILLING) lerpColor(c.tile, c.accent, 0.35f) else c.tileActive
    val icon = when (kind) {
        app.mailplane.core.SenderKind.BILLING -> Icons.AutoMirrored.Outlined.ReceiptLong
        app.mailplane.core.SenderKind.SECURITY -> Icons.Outlined.VerifiedUser
        app.mailplane.core.SenderKind.SUPPORT -> Icons.Outlined.SupportAgent
        app.mailplane.core.SenderKind.NEWS -> Icons.Outlined.Newspaper
        else -> Icons.Outlined.NotificationsNone
    }
    Box(Modifier.size(size).clip(CircleShape).background(bg), contentAlignment = Alignment.Center) {
        androidx.compose.material3.Icon(icon, contentDescription = null, tint = c.inkSecondary, modifier = Modifier.size(size * 0.46f))
    }
}

private fun lerpColor(a: Color, b: Color, t: Float) = Color(
    red = a.red + (b.red - a.red) * t, green = a.green + (b.green - a.green) * t, blue = a.blue + (b.blue - a.blue) * t, alpha = 1f,
)

/** Account switcher avatar: the active one shows its name (like the desktop title bar). */
@Composable
/** [colorHex] null = the "All inboxes" chip. */
fun AccountChip(name: String, colorHex: String?, active: Boolean, badge: Int, onClick: () -> Unit) {
    val c = Frost.colors
    Row(
        Modifier.clip(RoundedCornerShape(20.dp)).background(if (active) c.tile else Color.Transparent)
            .clickable(onClick = onClick).padding(start = 3.dp, end = if (active) 12.dp else 3.dp, top = 3.dp, bottom = 3.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box {
            Box(Modifier.size(30.dp).clip(CircleShape).background(if (active) c.raised else c.tile), contentAlignment = Alignment.Center) {
                if (colorHex == null) androidx.compose.material3.Icon(androidx.compose.material.icons.Icons.Outlined.AllInbox, null,
                    tint = if (active) c.ink else c.inkSecondary, modifier = Modifier.size(16.dp))
                else Text(app.mailplane.core.Senders.initials(name), color = if (active) c.ink else c.inkSecondary,
                    fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            }
            if (colorHex != null) Box(Modifier.align(Alignment.BottomStart).size(10.dp).clip(CircleShape).background(c.canvas).padding(2.dp)) {
                AccountDot(colorHex, 6.dp)
            }
            if (badge > 0 && !active) {
                Text(if (badge > 99) "99+" else badge.toString(), fontSize = 9.sp, fontWeight = FontWeight.SemiBold, color = c.onAccent,
                    modifier = Modifier.align(Alignment.BottomEnd).clip(RoundedCornerShape(8.dp)).background(c.accent).padding(horizontal = 4.dp))
            }
        }
        if (active) {
            Text(name, style = MaterialTheme.typography.labelLarge, color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (badge > 0) Text(badge.toString(), style = MaterialTheme.typography.labelSmall, color = c.onAccent,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(c.accent).padding(horizontal = 6.dp, vertical = 1.dp))
        }
    }
}

/** Day header in the message list: TODAY · YESTERDAY · MONDAY … */
@Composable
fun DayHeader(label: String) {
    Text(app.mailplane.android.ui.tr(label).uppercase(), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp,
        color = Frost.colors.inkTertiary, modifier = Modifier.padding(start = 20.dp, top = 16.dp, bottom = 6.dp))
}

/** Storage bar (IMAP QUOTA) for the folder drawer. */
@Composable
fun StorageBar(quota: app.mailplane.core.StorageQuota, modifier: Modifier = Modifier) {
    val c = Frost.colors
    val full = quota.fraction >= 0.9f
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("${formatKb(quota.usedKb)} of ${formatKb(quota.limitKb)} used", style = MaterialTheme.typography.labelSmall,
            color = if (full) c.danger else c.inkTertiary)
        Box(Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(c.tile)) {
            Box(Modifier.fillMaxWidth(quota.fraction).height(4.dp).clip(RoundedCornerShape(2.dp))
                .background(if (full) c.danger else c.inkTertiary))
        }
    }
}

fun formatKb(kb: Long): String = when {
    kb >= 1024L * 1024 -> String.format(java.util.Locale.ROOT, "%.1f GB", kb / 1048576.0)
    kb >= 1024 -> "${kb / 1024} MB"
    else -> "$kb KB"
}

/** Friendly empty / error state with an optional next step. */
@Composable
fun EmptyMessage(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, body: String,
                 action: String? = null, onAction: () -> Unit = {}) {
    val c = Frost.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(52.dp).clip(CircleShape).background(accentWash()).background(c.tile.copy(alpha = 0.7f)), contentAlignment = Alignment.Center) {
            androidx.compose.material3.Icon(icon, null, tint = c.ink, modifier = Modifier.size(22.dp))
        }
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = c.ink)
        Text(body, style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        if (action != null) {
            Text(action, color = c.ink, style = MaterialTheme.typography.labelLarge,
                modifier = Modifier.padding(top = 6.dp).clip(RoundedCornerShape(12.dp)).background(c.tile).clickable(onClick = onAction)
                    .padding(horizontal = 16.dp, vertical = 10.dp))
        }
    }
}
