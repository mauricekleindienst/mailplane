@file:OptIn(ExperimentalMaterial3Api::class)

package app.mailplane.android.ui.message

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Forward
import androidx.compose.material.icons.automirrored.outlined.Reply
import androidx.compose.material.icons.automirrored.outlined.ReplyAll
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.MarkEmailUnread
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Star
import androidx.compose.material.icons.outlined.StarOutline
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import app.mailplane.android.ui.MailViewModel
import app.mailplane.android.ui.ReaderState
import app.mailplane.android.ui.tr
import app.mailplane.android.ui.components.SenderAvatar
import app.mailplane.android.ui.inbox.shortDate
import app.mailplane.android.ui.theme.Frost
import app.mailplane.android.ui.theme.FrostColors
import app.mailplane.core.AttachmentInfo
import app.mailplane.core.MessageSummary
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

class MessageActions(
    val onBack: () -> Unit = {},
    val onArchive: () -> Unit = {},
    val onDelete: () -> Unit = {},
    val onUnread: () -> Unit = {},
    val onStar: () -> Unit = {},
    val onReply: () -> Unit = {},
    val onReplyAll: () -> Unit = {},
    val onForward: () -> Unit = {},
    val onAllowImages: () -> Unit = {},
    val onOpenThread: (MessageSummary) -> Unit = {},
    val onAttachment: (AttachmentInfo) -> Unit = {},
    val onLink: (String) -> Unit = {},
    val onSnooze: (java.time.Instant) -> Unit = {},
    val onSummarize: () -> Unit = {},
)

@Composable
fun MessageScreen(vm: MailViewModel, snackbar: SnackbarHostState, onBack: () -> Unit, onCompose: () -> Unit) {
    val r by vm.reader.collectAsState()
    val ai by vm.ai.collectAsState()
    val m = r.summary ?: return
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    MessageContent(
        r, snackbar,
        MessageActions(
            onBack = onBack,
            onArchive = { vm.archive(m); onBack() },
            onDelete = { vm.delete(m); onBack() },
            onUnread = { vm.setSeen(m, false); onBack() },
            onStar = { vm.toggleFlag(m) },
            onReply = { vm.reply(all = false); onCompose() },
            onReplyAll = { vm.reply(all = true); onCompose() },
            onForward = { vm.forward(); onCompose() },
            onAllowImages = vm::allowImages,
            onOpenThread = { vm.open(it) },
            onAttachment = { att ->
                scope.launch {
                    vm.attachmentIntent(att)?.let { intent ->
                        runCatching { context.startActivity(Intent.createChooser(intent, att.fileName)) }
                    }
                }
            },
            onLink = { url -> runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } },
            onSnooze = { until -> vm.snooze(m, until); onBack() },
            onSummarize = vm::summarize,
        ),
        aiEnabled = ai.enabled,
    )
}

@Composable
fun MessageContent(r: ReaderState, snackbar: SnackbarHostState = remember { SnackbarHostState() }, actions: MessageActions = MessageActions(),
                   aiEnabled: Boolean = false) {
    val c = Frost.colors
    val m = r.summary ?: return
    var menu by remember { mutableStateOf(false) }
    var snoozeOpen by remember { mutableStateOf(false) }
    if (snoozeOpen) SnoozeDialog(onPick = { snoozeOpen = false; actions.onSnooze(it) }, onDismiss = { snoozeOpen = false })

    Scaffold(
        containerColor = c.canvas,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = { IconButton(onClick = actions.onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, tr("Back"), tint = c.ink) } },
                actions = {
                    ActionIcon(Icons.Outlined.Archive, tr("Archive"), onClick = actions.onArchive)
                    ActionIcon(Icons.Outlined.Schedule, tr("Snooze")) { snoozeOpen = true }
                    ActionIcon(Icons.Outlined.Delete, tr("Delete"), onClick = actions.onDelete)
                    ActionIcon(if (m.flagged) Icons.Outlined.Star else Icons.Outlined.StarOutline, tr(if (m.flagged) "Unstar" else "Star"),
                        tint = if (m.flagged) c.accentDeep else c.ink, onClick = actions.onStar)
                    Box {
                        ActionIcon(Icons.Outlined.MoreVert, tr("More")) { menu = true }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = c.surface) {
                            DropdownMenuItem(text = { Text(tr("Mark as unread")) }, leadingIcon = { Icon(Icons.Outlined.MarkEmailUnread, null) },
                                onClick = { menu = false; actions.onUnread() })
                            if (aiEnabled) DropdownMenuItem(text = { Text(tr("Summarize")) }, leadingIcon = { Icon(Icons.Outlined.AutoAwesome, null) },
                                onClick = { menu = false; actions.onSummarize() })
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = c.canvas),
            )
        },
        bottomBar = {
            Row(Modifier.fillMaxWidth().background(c.canvas).navigationBarsPadding().padding(horizontal = 16.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BottomAction(Icons.AutoMirrored.Outlined.Reply, tr("Reply"), primary = true, modifier = Modifier.weight(1f), onClick = actions.onReply)
                BottomAction(Icons.AutoMirrored.Outlined.ReplyAll, tr("Reply all"), modifier = Modifier.weight(1f), onClick = actions.onReplyAll)
                BottomAction(Icons.AutoMirrored.Outlined.Forward, tr("Forward"), modifier = Modifier.weight(1f), onClick = actions.onForward)
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(horizontal = 12.dp).clip(RoundedCornerShape(24.dp)).background(c.surface)
            .verticalScroll(rememberScrollState())) {
            if (r.thread.isNotEmpty()) ThreadContext(r.thread, actions.onOpenThread)

            // Header: subject, sender, recipients — no card, a hairline below
            Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text(m.subject, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, color = c.ink)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    SenderAvatar(m.fromName, m.fromEmail, 40.dp)
                    Column(Modifier.weight(1f)) {
                        Text(m.fromName, style = MaterialTheme.typography.titleMedium, color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(m.fromEmail, style = MaterialTheme.typography.bodySmall, color = c.inkTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val to = r.body?.to?.joinToString(", ") { it.name ?: it.email }
                        if (!to.isNullOrBlank()) Text(tr("to $to"), style = MaterialTheme.typography.bodySmall, color = c.inkTertiary,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    m.date?.let {
                        Text(DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date.from(it)),
                            style = MaterialTheme.typography.labelSmall, color = c.inkTertiary)
                    }
                }
            }
            HorizontalDivider(Modifier.padding(horizontal = 20.dp), color = c.tile)
            if (r.aiBusy || r.aiSummary != null) {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp).fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.tile)
                    .padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(Icons.Outlined.AutoAwesome, null, tint = c.inkSecondary, modifier = Modifier.size(14.dp))
                        Text(tr(if (r.aiBusy) "Summarizing…" else "Summary"), style = MaterialTheme.typography.labelMedium, color = c.inkSecondary)
                    }
                    r.aiSummary?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.ink) }
                }
            }

            val body = r.body
            when {
                r.loading -> Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    listOf(0.9f, 0.75f, 0.85f, 0.5f).forEach { w ->
                        Box(Modifier.fillMaxWidth(w).height(10.dp).clip(RoundedCornerShape(5.dp)).background(c.tile))
                    }
                }
                r.error != null -> Text(r.error, color = c.danger, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(24.dp))
                body != null -> {
                    val html = body.html
                    if (html != null && REMOTE_IMG.containsMatchIn(html) && !r.imagesAllowed) {
                        Row(
                            Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp).fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.tile)
                                .padding(start = 14.dp, end = 6.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Icon(Icons.Outlined.Image, null, tint = c.inkTertiary, modifier = Modifier.size(18.dp))
                            Text(tr("Pictures from the web are hidden"), style = MaterialTheme.typography.bodySmall, color = c.inkSecondary, modifier = Modifier.weight(1f))
                            Text(tr("Show"), style = MaterialTheme.typography.labelMedium, color = c.onAccent,
                                modifier = Modifier.padding(vertical = 6.dp).clip(RoundedCornerShape(10.dp)).background(c.accent)
                                    .clickable(onClick = actions.onAllowImages).padding(horizontal = 14.dp, vertical = 8.dp))
                        }
                    }
                    if (html != null && !LocalInspectionMode.current) {
                        MailWebView(html, allowImages = r.imagesAllowed, colors = c, onLink = actions.onLink)
                    } else {
                        Text(body.text ?: body.snippet.ifBlank { tr("(empty message)") }, style = MaterialTheme.typography.bodyLarge, color = c.ink,
                            modifier = Modifier.padding(horizontal = 20.dp, vertical = 18.dp))
                    }
                    if (body.attachments.isNotEmpty()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            body.attachments.forEach { att -> AttachmentCard(att) { actions.onAttachment(att) } }
                        }
                    }
                }
            }
        }
    }
}

/** Other messages of the conversation, collapsed to one line each. */
@Composable
private fun ThreadContext(thread: List<MessageSummary>, onOpen: (MessageSummary) -> Unit) {
    val c = Frost.colors
    var open by remember { mutableStateOf(false) }
    Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp)) {
        Row(Modifier.clip(RoundedCornerShape(10.dp)).background(c.tile).clickable { open = !open }.padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, tint = c.inkSecondary, modifier = Modifier.size(16.dp))
            Text(tr("${thread.size} other message${if (thread.size > 1) "s" else ""} in this conversation"),
                style = MaterialTheme.typography.labelMedium, color = c.inkSecondary)
        }
        if (open) Column(Modifier.padding(top = 6.dp)) {
            thread.forEach { t ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { onOpen(t) }.padding(horizontal = 8.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(t.fromName, style = MaterialTheme.typography.bodySmall, fontWeight = if (t.seen) FontWeight.Normal else FontWeight.SemiBold,
                        color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.width(110.dp))
                    Text(t.subject, style = MaterialTheme.typography.bodySmall, color = c.inkTertiary, maxLines = 1,
                        overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(shortDate(t), style = MaterialTheme.typography.labelSmall, color = c.inkTertiary)
                }
            }
        }
    }
}

@Composable
private fun AttachmentCard(att: AttachmentInfo, onClick: () -> Unit) {
    val c = Frost.colors
    val ext = att.fileName.substringAfterLast('.', "file").take(4).uppercase()
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.tile).clickable(onClick = onClick).padding(10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(width = 34.dp, height = 40.dp).clip(RoundedCornerShape(7.dp)).background(c.raised), contentAlignment = Alignment.Center) {
            Text(ext, fontSize = 9.sp, fontWeight = FontWeight.Bold, color = c.inkSecondary)
        }
        Column(Modifier.weight(1f)) {
            Text(att.fileName, style = MaterialTheme.typography.bodyMedium, color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val size = formatSize(att.size)
            if (size.isNotEmpty()) Text(size, style = MaterialTheme.typography.labelSmall, color = c.inkTertiary)
        }
        Box(Modifier.size(32.dp).clip(CircleShape).background(c.raised), contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.Download, tr("Open"), tint = c.inkSecondary, modifier = Modifier.size(16.dp))
        }
    }
}

/** Later today / This evening / Tomorrow / This weekend / Next week — like the desktop. */
@Composable
private fun SnoozeDialog(onPick: (java.time.Instant) -> Unit, onDismiss: () -> Unit) {
    val c = Frost.colors
    val options = remember { snoozeOptions(java.time.LocalDateTime.now()) }
    val fmt = remember { java.time.format.DateTimeFormatter.ofPattern("EEE HH:mm", java.util.Locale.getDefault()) }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.surface,
        title = { Text(tr("Snooze until")) },
        text = {
            Column {
                options.forEach { (label, at) ->
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable {
                        onPick(at.atZone(java.time.ZoneId.systemDefault()).toInstant())
                    }.padding(horizontal = 12.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(tr(label), style = MaterialTheme.typography.bodyLarge, color = c.ink, modifier = Modifier.weight(1f))
                        Text(at.format(fmt), style = MaterialTheme.typography.labelMedium, color = c.inkTertiary)
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { androidx.compose.material3.TextButton(onClick = onDismiss) { Text(tr("Cancel"), color = c.ink) } },
    )
}

internal fun snoozeOptions(now: java.time.LocalDateTime): List<Pair<String, java.time.LocalDateTime>> {
    val out = mutableListOf<Pair<String, java.time.LocalDateTime>>()
    val later = now.plusHours(3).withMinute(0).withSecond(0).withNano(0)
    if (later.toLocalDate() == now.toLocalDate() && later.hour <= 21) out += "Later today" to later
    if (now.hour < 17) out += "This evening" to now.toLocalDate().atTime(18, 0)
    out += "Tomorrow" to now.toLocalDate().plusDays(1).atTime(8, 0)
    val dow = now.dayOfWeek.value   // 1 = Monday
    if (dow in 1..4) out += "This weekend" to now.toLocalDate().plusDays((6 - dow).toLong()).atTime(9, 0)
    out += "Next week" to now.toLocalDate().plusDays((8 - dow).toLong()).atTime(8, 0)
    return out
}

private val REMOTE_IMG = Regex("<img[^>]+src=[\"']?https?://", RegexOption.IGNORE_CASE)

@Composable
private fun ActionIcon(icon: ImageVector, label: String, tint: androidx.compose.ui.graphics.Color = Frost.colors.ink, onClick: () -> Unit) {
    IconButton(onClick = onClick) { Icon(icon, label, tint = tint) }
}

@Composable
private fun BottomAction(icon: ImageVector, label: String, modifier: Modifier = Modifier, primary: Boolean = false, onClick: () -> Unit) {
    val c = Frost.colors
    Row(
        modifier.height(48.dp).clip(RoundedCornerShape(14.dp)).background(if (primary) c.accent else c.tile).clickable(onClick = onClick),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = if (primary) c.onAccent else c.ink, modifier = Modifier.size(18.dp))
        Text(label, style = MaterialTheme.typography.labelLarge, color = if (primary) c.onAccent else c.ink)
    }
}

/**
 * Sandboxed HTML view: JavaScript off, no file/content access, remote images
 * only after "Show", every link opens in the browser. Sized to its content so
 * the whole message scrolls as one page with the header.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun MailWebView(html: String, allowImages: Boolean, colors: FrostColors, onLink: (String) -> Unit) {
    val bg = colors.surface.toCss()
    val fg = colors.ink.toCss()
    val link = colors.inkSecondary.toCss()
    val doc = remember(html, allowImages, bg, fg) {
        """<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>html,body{margin:0;background:$bg;color:$fg;font-family:sans-serif;font-size:15px;line-height:1.6;word-break:break-word}
        body{padding:18px 20px 28px}img{max-width:100%!important;height:auto!important}table{max-width:100%!important}
        a{color:$fg;text-decoration-color:$link}blockquote{margin:12px 0;padding-left:12px;border-left:3px solid rgba(128,128,128,.35);opacity:.8}
        pre{white-space:pre-wrap}</style>
        </head><body>$html</body></html>"""
    }
    AndroidView(
        modifier = Modifier.fillMaxWidth(),
        factory = { ctx ->
            WebView(ctx).apply {
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                settings.javaScriptEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.loadWithOverviewMode = true
                settings.useWideViewPort = false
                isVerticalScrollBarEnabled = false
                isHorizontalScrollBarEnabled = false
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        onLink(request.url.toString()); return true
                    }
                }
            }
        },
        update = { wv ->
            wv.settings.blockNetworkImage = !allowImages
            wv.settings.blockNetworkLoads = !allowImages
            if (wv.tag != doc) {
                wv.tag = doc
                wv.loadDataWithBaseURL(null, doc, "text/html", "utf-8", null)
            }
        },
    )
}

private fun androidx.compose.ui.graphics.Color.toCss(): String =
    "rgb(${(red * 255).toInt()},${(green * 255).toInt()},${(blue * 255).toInt()})"

private fun formatSize(bytes: Long): String = when {
    bytes <= 0 -> ""
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${bytes / 1024} KB"
    else -> String.format(java.util.Locale.ROOT, "%.1f MB", bytes / 1048576.0)
}
