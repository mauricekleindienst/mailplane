@file:OptIn(ExperimentalMaterial3Api::class)

package app.mailplane.android.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.unit.dp
import app.mailplane.android.BuildConfig
import app.mailplane.android.data.Accents
import app.mailplane.android.data.ThemeMode
import app.mailplane.android.ui.MailViewModel
import app.mailplane.android.ui.components.AccountDot
import app.mailplane.android.ui.components.BrandMark
import app.mailplane.android.ui.components.Group
import app.mailplane.android.ui.components.SectionLabel
import app.mailplane.android.ui.theme.Frost
import app.mailplane.core.Account

@Composable
fun SettingsScreen(vm: MailViewModel, onBack: () -> Unit, onAddAccount: () -> Unit) {
    val c = Frost.colors
    val accounts by vm.accounts.collectAsState()
    val theme by vm.settings.theme.collectAsState()
    val accent by vm.settings.accent.collectAsState()
    val notifications by vm.settings.notifications.collectAsState()
    val blockImages by vm.settings.blockImages.collectAsState()
    var confirmRemove by remember { mutableStateOf<Account?>(null) }

    Scaffold(
        containerColor = c.canvas,
        topBar = {
            TopAppBar(
                title = { Text("Settings", style = MaterialTheme.typography.headlineSmall, color = c.ink) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back", tint = c.ink) } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = c.canvas),
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp)) {
            SectionLabel("Accounts")
            Group {
                accounts.forEachIndexed { i, acc ->
                    if (i > 0) HorizontalDivider(color = c.tile)
                    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        AccountDot(acc.color, 10.dp)
                        Column(Modifier.weight(1f)) {
                            Text(acc.name.ifBlank { acc.email }, style = MaterialTheme.typography.bodyMedium, color = c.ink)
                            Text("${acc.email} · ${acc.imap.host}", style = MaterialTheme.typography.bodySmall, color = c.inkTertiary)
                        }
                        IconButton(onClick = { confirmRemove = acc }) { Icon(Icons.Outlined.Delete, "Remove ${acc.email}", tint = c.inkSecondary) }
                    }
                }
                if (accounts.isNotEmpty()) HorizontalDivider(color = c.tile)
                Row(Modifier.fillMaxWidth().clickable(onClick = onAddAccount).padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Icon(Icons.Outlined.Add, null, tint = c.ink, modifier = Modifier.size(18.dp))
                    Text("Add account", style = MaterialTheme.typography.bodyMedium, color = c.ink)
                }
            }

            SectionLabel("Appearance")
            Group {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text("Theme", style = MaterialTheme.typography.bodyMedium, color = c.ink)
                    val modes = listOf(ThemeMode.SYSTEM to "Automatic", ThemeMode.LIGHT to "Light", ThemeMode.DARK to "Dark")
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        modes.forEachIndexed { i, (mode, label) ->
                            SegmentedButton(
                                selected = theme == mode, onClick = { vm.settings.setTheme(mode) },
                                shape = SegmentedButtonDefaults.itemShape(i, modes.size),
                                colors = SegmentedButtonDefaults.colors(activeContainerColor = c.accent, activeContentColor = c.onAccent),
                            ) { Text(label) }
                        }
                    }
                    Text("Accent colour", style = MaterialTheme.typography.bodyMedium, color = c.ink)
                    Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                        Accents.all.forEach { a ->
                            val selected = a.hex == accent
                            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp),
                                modifier = Modifier.clip(RoundedCornerShape(10.dp)).clickable { vm.settings.setAccent(a.hex) }.padding(4.dp)) {
                                Box(
                                    Modifier.size(34.dp).clip(CircleShape)
                                        .border(if (selected) 2.dp else 0.dp, if (selected) c.ink else Color.Transparent, CircleShape)
                                        .padding(3.dp).clip(CircleShape).background(Color(a.hex)),
                                )
                                Text(a.label, style = MaterialTheme.typography.labelSmall, color = if (selected) c.ink else c.inkTertiary)
                            }
                        }
                    }
                }
            }

            SectionLabel("Mail")
            Group {
                ToggleRow("New mail notifications", "Checked about every 15 minutes", notifications, vm.settings::setNotifications)
                HorizontalDivider(color = c.tile)
                ToggleRow("Block remote images", "Stops senders from tracking when you open a message", blockImages, vm.settings::setBlockImages)
            }

            Column(Modifier.fillMaxWidth().padding(vertical = 32.dp), horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                BrandMark(44.dp)
                Text("Mailplane ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall, color = c.inkTertiary)
            }
        }
    }

    confirmRemove?.let { acc ->
        AlertDialog(
            onDismissRequest = { confirmRemove = null },
            title = { Text("Remove ${acc.email}?") },
            text = { Text("Mail stays on the server. You can add the account again later.") },
            confirmButton = { TextButton(onClick = { vm.removeAccount(acc.id); confirmRemove = null }) { Text("Remove", color = c.danger) } },
            dismissButton = { TextButton(onClick = { confirmRemove = null }) { Text("Cancel", color = c.ink) } },
            containerColor = c.surface,
        )
    }
}

@Composable
private fun ToggleRow(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    val c = Frost.colors
    Row(Modifier.fillMaxWidth().clickable { onChange(!checked) }.padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium, color = c.ink)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = c.inkTertiary)
        }
        Switch(checked, onChange, colors = SwitchDefaults.colors(checkedTrackColor = c.accentDeep, checkedThumbColor = Color.White,
            uncheckedTrackColor = c.tile, uncheckedThumbColor = c.inkTertiary, uncheckedBorderColor = c.tileActive))
    }
}
