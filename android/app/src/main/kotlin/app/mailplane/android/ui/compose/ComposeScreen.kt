@file:OptIn(ExperimentalMaterial3Api::class)

package app.mailplane.android.ui.compose

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.mailplane.android.ui.MailViewModel
import app.mailplane.android.ui.components.AccountDot
import app.mailplane.android.ui.theme.Frost

@Composable
fun ComposeScreen(vm: MailViewModel, onClose: () -> Unit) {
    val c = Frost.colors
    val d by vm.draft.collectAsState()
    val accounts by vm.accounts.collectAsState()
    var showCc by remember { mutableStateOf(d.cc.isNotBlank() || d.bcc.isNotBlank()) }
    val from = accounts.firstOrNull { it.id == d.accountId } ?: accounts.firstOrNull()

    val fieldColors = TextFieldDefaults.colors(
        focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
        focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, cursorColor = c.ink,
    )

    Scaffold(
        containerColor = c.canvas,
        topBar = {
            TopAppBar(
                title = { Text(d.title, style = MaterialTheme.typography.titleLarge, color = c.ink) },
                navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.Outlined.Close, "Discard", tint = c.ink) } },
                actions = {
                    if (d.sending) CircularProgressIndicator(Modifier.padding(end = 20.dp).size(20.dp), strokeWidth = 2.dp, color = c.inkSecondary)
                    else TextButton(onClick = { vm.send(onClose) }) {
                        Text("Send", color = c.onAccent, style = MaterialTheme.typography.labelLarge,
                            modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(c.accent).padding(horizontal = 16.dp, vertical = 8.dp))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = c.canvas),
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).imePadding().padding(horizontal = 12.dp)
                .clip(RoundedCornerShape(20.dp)).background(c.surface).verticalScroll(rememberScrollState()),
        ) {
            if (d.error != null) Text(d.error!!, color = c.danger, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(16.dp))

            // From (only interesting with several accounts)
            if (accounts.size > 1 && from != null) {
                var open by remember { mutableStateOf(false) }
                ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }) {
                    TextField(
                        value = from.email, onValueChange = {}, readOnly = true,
                        prefix = { Text("From  ", color = c.inkTertiary) },
                        leadingIcon = { AccountDot(from.color) },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
                        colors = fieldColors,
                        modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable),
                    )
                    ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                        accounts.forEach { acc ->
                            DropdownMenuItem(
                                text = { Text(acc.email) }, leadingIcon = { AccountDot(acc.color) },
                                onClick = { vm.updateDraft { it.copy(accountId = acc.id) }; open = false },
                            )
                        }
                    }
                }
                HorizontalDivider(color = c.tile)
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                TextField(d.to, { v -> vm.updateDraft { it.copy(to = v, error = null) } }, prefix = { Text("To  ", color = c.inkTertiary) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), colors = fieldColors, modifier = Modifier.weight(1f))
                if (!showCc) TextButton(onClick = { showCc = true }) { Text("Cc/Bcc", color = c.inkSecondary) }
            }
            HorizontalDivider(color = c.tile)
            if (showCc) {
                TextField(d.cc, { v -> vm.updateDraft { it.copy(cc = v) } }, prefix = { Text("Cc  ", color = c.inkTertiary) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), colors = fieldColors, modifier = Modifier.fillMaxWidth())
                HorizontalDivider(color = c.tile)
                TextField(d.bcc, { v -> vm.updateDraft { it.copy(bcc = v) } }, prefix = { Text("Bcc  ", color = c.inkTertiary) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), colors = fieldColors, modifier = Modifier.fillMaxWidth())
                HorizontalDivider(color = c.tile)
            }
            TextField(d.subject, { v -> vm.updateDraft { it.copy(subject = v) } }, placeholder = { Text("Subject") },
                textStyle = MaterialTheme.typography.titleMedium, colors = fieldColors, modifier = Modifier.fillMaxWidth())
            HorizontalDivider(color = c.tile)
            TextField(d.body, { v -> vm.updateDraft { it.copy(body = v) } }, placeholder = { Text("Write your message") },
                colors = fieldColors, modifier = Modifier.fillMaxWidth().heightIn(min = 220.dp))
            if (d.quoted.isNotBlank()) {
                Text(d.quoted, style = MaterialTheme.typography.bodySmall, color = c.inkTertiary, maxLines = 12,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
            }
        }
    }
}
