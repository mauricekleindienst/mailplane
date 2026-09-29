@file:OptIn(ExperimentalMaterial3Api::class)

package app.mailplane.android.ui.message

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Reply
import androidx.compose.material.icons.automirrored.outlined.ReplyAll
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.MarkEmailUnread
import androidx.compose.material.icons.outlined.Shortcut
import androidx.compose.material.icons.outlined.Star
import androidx.compose.material.icons.outlined.StarOutline
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import app.mailplane.android.ui.MailViewModel
import app.mailplane.android.ui.components.Avatar
import app.mailplane.android.ui.components.accentWash
import app.mailplane.android.ui.theme.Frost
import app.mailplane.android.ui.theme.FrostColors
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

@Composable
fun MessageScreen(vm: MailViewModel, snackbar: SnackbarHostState, onBack: () -> Unit, onCompose: () -> Unit) {
    val c = Frost.colors
    val r by vm.reader.collectAsState()
    val m = r.summary ?: return
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    Scaffold(
        containerColor = c.canvas,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back", tint = c.ink) } },
                actions = {
                    ActionIcon(Icons.Outlined.Archive, "Archive") { vm.archive(m); onBack() }
                    ActionIcon(Icons.Outlined.Delete, "Delete") { vm.delete(m); onBack() }
                    ActionIcon(Icons.Outlined.MarkEmailUnread, "Mark unread") { vm.setSeen(m, false); onBack() }
                    ActionIcon(if (m.flagged) Icons.Outlined.Star else Icons.Outlined.StarOutline, if (m.flagged) "Unstar" else "Star") { vm.toggleFlag(m) }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = c.canvas),
            )
        },
        bottomBar = {
            Row(Modifier.fillMaxWidth().background(c.canvas).navigationBarsPadding().padding(horizontal = 16.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BottomAction(Icons.AutoMirrored.Outlined.Reply, "Reply", primary = true, modifier = Modifier.weight(1f)) { vm.reply(all = false); onCompose() }
                BottomAction(Icons.AutoMirrored.Outlined.ReplyAll, "Reply all", modifier = Modifier.weight(1f)) { vm.reply(all = true); onCompose() }
                BottomAction(Icons.Outlined.Shortcut, "Forward", modifier = Modifier.weight(1f)) { vm.forward(); onCompose() }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())) {
            // Header card with the accent wash (desktop: .detail-header)
            Column(
                Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(RoundedCornerShape(20.dp))
                    .background(c.raised).background(accentWash()).padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text(m.subject, style = MaterialTheme.typography.headlineSmall, color = c.ink)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Avatar(m.fromName, 40.dp)
                    Column(Modifier.weight(1f)) {
                        Text(m.fromName, style = MaterialTheme.typography.titleMedium, color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(m.fromEmail, style = MaterialTheme.typography.bodySmall, color = c.inkTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val to = r.body?.to?.joinToString(", ") { it.name ?: it.email }
                        if (!to.isNullOrBlank()) Text("to $to", style = MaterialTheme.typography.bodySmall, color = c.inkTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                m.date?.let {
                    Text(DateFormat.getDateTimeInstance(DateFormat.FULL, DateFormat.SHORT).format(Date.from(it)),
                        style = MaterialTheme.typography.labelSmall, color = c.inkTertiary)
                }
            }

            val body = r.body
            when {
                r.loading -> Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = c.inkSecondary, strokeWidth = 2.dp)
                }
                r.error != null -> Text(r.error!!, color = c.danger, modifier = Modifier.padding(24.dp))
                body != null -> {
                    val html = body.html
                    val hasRemote = html != null && REMOTE_IMG.containsMatchIn(html)
                    if (hasRemote && !r.imagesAllowed) {
                        Row(
                            Modifier.padding(16.dp).fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.tile).padding(start = 14.dp, end = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("Remote images are blocked", style = MaterialTheme.typography.bodySmall, color = c.inkSecondary, modifier = Modifier.weight(1f))
                            Text("Load images", style = MaterialTheme.typography.labelMedium, color = c.onAccent,
                                modifier = Modifier.padding(vertical = 6.dp).clip(RoundedCornerShape(10.dp)).background(c.accent)
                                    .clickable { vm.allowImages() }.padding(horizontal = 12.dp, vertical = 8.dp))
                        }
                    }
                    if (html != null) {
                        MailWebView(html, allowImages = r.imagesAllowed, colors = c, onLink = { url ->
                            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                        })
                    } else {
                        Text(body.text ?: "(empty message)", style = MaterialTheme.typography.bodyLarge, color = c.ink,
                            modifier = Modifier.padding(horizontal = 24.dp, vertical = 20.dp))
                    }
                    if (body.attachments.isNotEmpty()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            body.attachments.forEach { att ->
                                Row(
                                    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.tile)
                                        .clickable {
                                            scope.launch {
                                                vm.attachmentIntent(att)?.let { intent ->
                                                    runCatching { context.startActivity(Intent.createChooser(intent, att.fileName)) }
                                                }
                                            }
                                        }.padding(12.dp),
                                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    Icon(Icons.Outlined.AttachFile, null, tint = c.inkSecondary, modifier = Modifier.size(18.dp))
                                    Text(att.fileName, style = MaterialTheme.typography.bodyMedium, color = c.ink, modifier = Modifier.weight(1f),
                                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(formatSize(att.size), style = MaterialTheme.typography.labelSmall, color = c.inkTertiary)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private val REMOTE_IMG = Regex("<img[^>]+src=[\"']?https?://", RegexOption.IGNORE_CASE)

@Composable
private fun ActionIcon(icon: ImageVector, label: String, onClick: () -> Unit) {
    IconButton(onClick = onClick) { Icon(icon, label, tint = Frost.colors.ink) }
}

@Composable
private fun BottomAction(icon: ImageVector, label: String, modifier: Modifier = Modifier, primary: Boolean = false, onClick: () -> Unit) {
    val c = Frost.colors
    Row(
        modifier.clip(RoundedCornerShape(14.dp)).background(if (primary) c.accent else c.tile).clickable(onClick = onClick)
            .padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = if (primary) c.onAccent else c.ink, modifier = Modifier.size(18.dp))
        Text("  $label", style = MaterialTheme.typography.labelLarge, color = if (primary) c.onAccent else c.ink)
    }
}

/**
 * Sandboxed HTML view: JavaScript off, no file/content access, remote images
 * only after "Load images", every link opens in the browser.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun MailWebView(html: String, allowImages: Boolean, colors: FrostColors, onLink: (String) -> Unit) {
    val bg = colors.surface.toCss()
    val fg = colors.ink.toCss()
    val doc = remember(html, allowImages, bg, fg) {
        """<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>html,body{margin:0;background:$bg;color:$fg;font-family:sans-serif;font-size:15px;line-height:1.55;word-break:break-word}
        body{padding:20px 22px 32px}img{max-width:100%!important;height:auto!important}table{max-width:100%!important}
        a{color:$fg}blockquote{margin:12px 0;padding-left:12px;border-left:3px solid rgba(128,128,128,.35);opacity:.8}</style>
        </head><body>$html</body></html>"""
    }
    AndroidView(
        modifier = Modifier.fillMaxWidth(),
        factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.loadWithOverviewMode = true
                settings.useWideViewPort = false
                isVerticalScrollBarEnabled = false
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
    else -> String.format("%.1f MB", bytes / 1048576.0)
}
