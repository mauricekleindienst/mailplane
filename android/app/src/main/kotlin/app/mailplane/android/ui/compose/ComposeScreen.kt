@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package app.mailplane.android.ui.compose

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.mailplane.android.ui.Draft
import app.mailplane.android.ui.MailViewModel
import app.mailplane.android.ui.components.AccountDot
import app.mailplane.android.ui.theme.Frost
import app.mailplane.core.Account
import app.mailplane.core.Addresses
import app.mailplane.core.Senders

class ComposeActions(
    val onChange: ((Draft) -> Draft) -> Unit = {},
    val onSend: () -> Unit = {},
    val onDiscard: () -> Unit = {},
)

@Composable
fun ComposeScreen(vm: MailViewModel, onClose: () -> Unit) {
    val d by vm.draft.collectAsState()
    val accounts by vm.accounts.collectAsState()
    ComposeContent(d, accounts, ComposeActions(onChange = vm::updateDraft, onSend = { vm.send(onClose) }, onDiscard = onClose))
}

@Composable
fun ComposeContent(d: Draft, accounts: List<Account>, actions: ComposeActions = ComposeActions()) {
    val c = Frost.colors
    var showCc by remember { mutableStateOf(d.cc.isNotBlank() || d.bcc.isNotBlank()) }
    var confirmDiscard by remember { mutableStateOf(false) }
    val hasContent = d.to.isNotBlank() || d.subject.isNotBlank() || d.body.isNotBlank()
    val close: () -> Unit = {
        if (hasContent && !d.sending) { confirmDiscard = true } else { actions.onDiscard() }
    }
    BackHandler(onBack = close)

    val fieldColors = TextFieldDefaults.colors(
        focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
        focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, cursorColor = c.ink,
    )

    if (confirmDiscard) {
        AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            containerColor = c.surface,
            title = { Text("Discard this message?") },
            text = { Text("What you wrote won’t be saved.", color = c.inkSecondary) },
            confirmButton = { TextButton(onClick = { confirmDiscard = false; actions.onDiscard() }) { Text("Discard", color = c.danger) } },
            dismissButton = { TextButton(onClick = { confirmDiscard = false }) { Text("Keep editing", color = c.ink) } },
        )
    }

    Scaffold(
        containerColor = c.canvas,
        topBar = {
            TopAppBar(
                title = {
                    Text(d.subject.ifBlank { d.title }, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold,
                        color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.Outlined.Close, "Close", tint = c.ink) } },
                actions = {
                    if (d.sending) CircularProgressIndicator(Modifier.padding(end = 20.dp).size(20.dp), strokeWidth = 2.dp, color = c.inkSecondary)
                    else Row(
                        Modifier.padding(end = 12.dp).clip(RoundedCornerShape(12.dp)).background(c.accent).clickable(onClick = actions.onSend)
                            .padding(horizontal = 14.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Icon(Icons.AutoMirrored.Outlined.Send, null, tint = c.onAccent, modifier = Modifier.size(16.dp))
                        Text("Send", color = c.onAccent, style = MaterialTheme.typography.labelLarge)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = c.canvas),
            )
        },
        bottomBar = {
            // Sender lives in the footer, like the desktop compose window
            val from = accounts.firstOrNull { it.id == d.accountId } ?: accounts.firstOrNull()
            if (from != null) FromFooter(from, accounts) { id -> actions.onChange { it.copy(accountId = id) } }
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().padding(horizontal = 12.dp)
                .clip(RoundedCornerShape(24.dp)).background(c.surface).verticalScroll(rememberScrollState()),
        ) {
            if (d.error != null) {
                Text(d.error, color = c.danger, style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp))
            }
            RecipientField("To", d.to, trailing = {
                if (!showCc) TextButton(onClick = { showCc = true }) { Text("Cc Bcc", color = c.inkSecondary, fontSize = 13.sp) }
            }) { v -> actions.onChange { it.copy(to = v, error = null) } }
            HorizontalDivider(color = c.tile)
            if (showCc) {
                RecipientField("Cc", d.cc) { v -> actions.onChange { it.copy(cc = v, error = null) } }
                HorizontalDivider(color = c.tile)
                RecipientField("Bcc", d.bcc) { v -> actions.onChange { it.copy(bcc = v, error = null) } }
                HorizontalDivider(color = c.tile)
            }
            TextField(d.subject, { v -> actions.onChange { it.copy(subject = v) } }, placeholder = { Text("Subject", color = c.inkTertiary) },
                textStyle = MaterialTheme.typography.titleMedium, colors = fieldColors, singleLine = true, modifier = Modifier.fillMaxWidth())
            HorizontalDivider(color = c.tile)
            TextField(d.body, { v -> actions.onChange { it.copy(body = v) } }, placeholder = { Text("Write your message", color = c.inkTertiary) },
                textStyle = MaterialTheme.typography.bodyLarge, colors = fieldColors, modifier = Modifier.fillMaxWidth().heightIn(min = 220.dp))
            if (d.quoted.isNotBlank()) {
                Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    Box(Modifier.size(width = 3.dp, height = 60.dp).clip(RoundedCornerShape(2.dp)).background(c.tileActive))
                    Text(d.quoted, style = MaterialTheme.typography.bodySmall, color = c.inkTertiary, maxLines = 10,
                        overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 10.dp))
                }
            }
        }
    }
}

/**
 * Recipients as chips. The draft keeps a plain "a@b.c, Name <d@e.f>" string;
 * finished addresses (followed by a comma, space or Enter) become chips.
 */
@Composable
private fun RecipientField(label: String, value: String, trailing: @Composable () -> Unit = {}, onChange: (String) -> Unit) {
    val c = Frost.colors
    val parts = value.split(',', ';')
    val endsOpen = !Regex("[,;]\\s*$").containsMatchIn(value) && value.isNotBlank()
    val chips = (if (endsOpen) parts.dropLast(1) else parts).map { it.trim() }.filter { it.isNotEmpty() }
    val typing = if (endsOpen) parts.last().trimStart() else ""
    fun join(list: List<String>, tail: String) = (list.joinToString(", ") + if (list.isNotEmpty()) ", " else "") + tail

    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = c.inkTertiary, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.widthIn(min = 34.dp))
        FlowRow(Modifier.weight(1f).padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)) {
            chips.forEachIndexed { i, entry ->
                val addr = Regex("<([^>]+)>").find(entry)?.groupValues?.get(1) ?: entry
                val name = entry.substringBefore('<').trim().trim('"')
                val valid = Addresses.firstInvalid(addr) == null
                Row(
                    Modifier.clip(RoundedCornerShape(14.dp)).background(if (valid) c.tile else c.danger.copy(alpha = 0.15f))
                        .padding(start = 3.dp, end = 2.dp, top = 3.dp, bottom = 3.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Box(Modifier.size(20.dp).clip(CircleShape).background(c.tileActive), contentAlignment = Alignment.Center) {
                        Text(Senders.initials(name.ifBlank { addr }), fontSize = 8.sp, fontWeight = FontWeight.SemiBold, color = c.inkSecondary)
                    }
                    Text(name.ifBlank { addr }, style = MaterialTheme.typography.bodySmall, color = if (valid) c.ink else c.danger,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 200.dp))
                    Box(Modifier.size(20.dp).clip(CircleShape).clickable { onChange(join(chips.filterIndexed { j, _ -> j != i }, typing)) },
                        contentAlignment = Alignment.Center) {
                        Icon(Icons.Outlined.Close, "Remove $addr", tint = c.inkTertiary, modifier = Modifier.size(12.dp))
                    }
                }
            }
            BasicTextField(
                value = typing,
                onValueChange = { v ->
                    // A comma, semicolon or space after an address finishes it
                    if (Regex("[,;]|\\s$").containsMatchIn(v) && v.trim().trim(',', ';').isNotEmpty()) {
                        onChange(join(chips + v.trim().trim(',', ';').trim(), ""))
                    } else onChange(join(chips, v))
                },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = c.ink),
                cursorBrush = SolidColor(c.ink),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
                keyboardActions = KeyboardActions(onNext = { if (typing.isNotBlank()) onChange(join(chips + typing.trim(), "")) }),
                modifier = Modifier.widthIn(min = 120.dp).padding(vertical = 6.dp),
            )
        }
        trailing()
    }
}

@Composable
private fun FromFooter(from: Account, accounts: List<Account>, onPick: (String) -> Unit) {
    val c = Frost.colors
    var open by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().background(c.canvas).navigationBarsPadding().padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text("from", style = MaterialTheme.typography.labelMedium, color = c.inkTertiary)
        Box {
            Row(Modifier.padding(start = 6.dp).clip(RoundedCornerShape(10.dp))
                .clickable(enabled = accounts.size > 1) { open = true }.padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                AccountDot(from.color, 7.dp)
                Text(from.email, style = MaterialTheme.typography.labelMedium, color = c.inkSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (accounts.size > 1) Icon(Icons.Outlined.ExpandMore, "Choose sender", tint = c.inkTertiary, modifier = Modifier.size(16.dp))
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = c.surface) {
                accounts.forEach { acc ->
                    DropdownMenuItem(text = { Text(acc.email) }, leadingIcon = { AccountDot(acc.color) },
                        onClick = { onPick(acc.id); open = false })
                }
            }
        }
    }
}
