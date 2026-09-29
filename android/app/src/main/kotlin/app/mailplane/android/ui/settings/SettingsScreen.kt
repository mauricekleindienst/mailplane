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
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.ui.text.input.PasswordVisualTransformation
import app.mailplane.android.data.AiSettings
import app.mailplane.core.AiClient
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import app.mailplane.android.BuildConfig
import app.mailplane.android.data.Accents
import app.mailplane.android.data.ThemeMode
import app.mailplane.android.data.UpdateState
import app.mailplane.android.ui.components.AccentButton
import app.mailplane.android.ui.MailViewModel
import app.mailplane.android.ui.I18n
import app.mailplane.android.ui.tr
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
    val compact by vm.settings.compact.collectAsState()
    val recent by vm.settings.recentSearches.collectAsState()
    val uriHandler = androidx.compose.ui.platform.LocalUriHandler.current
    val update by vm.updater.state.collectAsState()
    var confirmRemove by remember { mutableStateOf<Account?>(null) }

    Scaffold(
        containerColor = c.canvas,
        topBar = {
            TopAppBar(
                title = { Text(tr("Settings"), style = MaterialTheme.typography.headlineSmall, color = c.ink) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, tr("Back"), tint = c.ink) } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = c.canvas),
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp)) {
            SectionLabel(tr("Accounts"))
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
                        IconButton(onClick = { confirmRemove = acc }) { Icon(Icons.Outlined.Delete, tr("Remove ${acc.email}"), tint = c.inkSecondary) }
                    }
                }
                if (accounts.isNotEmpty()) HorizontalDivider(color = c.tile)
                Row(Modifier.fillMaxWidth().clickable(onClick = onAddAccount).padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Icon(Icons.Outlined.Add, null, tint = c.ink, modifier = Modifier.size(18.dp))
                    Text(tr("Add account"), style = MaterialTheme.typography.bodyMedium, color = c.ink)
                }
            }

            SectionLabel(tr("Appearance"))
            Group {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text(tr("Theme"), style = MaterialTheme.typography.bodyMedium, color = c.ink)
                    val modes = listOf(ThemeMode.SYSTEM to tr("Automatic"), ThemeMode.LIGHT to tr("Light"), ThemeMode.DARK to tr("Dark"))
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        modes.forEachIndexed { i, (mode, label) ->
                            SegmentedButton(
                                selected = theme == mode, onClick = { vm.settings.setTheme(mode) },
                                shape = SegmentedButtonDefaults.itemShape(i, modes.size),
                                colors = SegmentedButtonDefaults.colors(activeContainerColor = c.accent, activeContentColor = c.onAccent),
                            ) { Text(label) }
                        }
                    }
                    Text(tr("Accent colour"), style = MaterialTheme.typography.bodyMedium, color = c.ink)
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
                                Text(tr(a.label), style = MaterialTheme.typography.labelSmall, color = if (selected) c.ink else c.inkTertiary)
                            }
                        }
                    }
                }
            }

            SectionLabel(tr("Language"))
            Group {
                val lang by vm.settings.language.collectAsState()
                Column(Modifier.padding(16.dp)) {
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        I18n.languages.forEachIndexed { i, (code, label) ->
                            SegmentedButton(
                                selected = lang == code, onClick = { vm.settings.setLanguage(code) },
                                shape = SegmentedButtonDefaults.itemShape(i, I18n.languages.size),
                                colors = SegmentedButtonDefaults.colors(activeContainerColor = c.accent, activeContentColor = c.onAccent),
                            ) { Text(tr(label)) }
                        }
                    }
                }
            }

            SectionLabel(tr("Reading"))
            Group {
                ToggleRow(tr("Compact list"), tr("One line per message, no pictures — fits more on screen"), compact, vm.settings::setCompact)
                if (recent.isNotEmpty()) {
                    HorizontalDivider(color = c.tile)
                    Row(Modifier.fillMaxWidth().clickable { vm.settings.clearRecentSearches() }.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(tr("Clear recent searches"), style = MaterialTheme.typography.bodyMedium, color = c.ink)
                            Text(tr("${recent.size} saved on this phone"), style = MaterialTheme.typography.bodySmall, color = c.inkTertiary)
                        }
                    }
                }
            }

            SectionLabel(tr("Mail"))
            Group {
                ToggleRow(tr("New mail notifications"), tr("Checked about every 15 minutes"), notifications, vm.settings::setNotifications)
                HorizontalDivider(color = c.tile)
                ToggleRow(tr("Block remote images"), tr("Stops senders from tracking when you open a message"), blockImages, vm.settings::setBlockImages)
            }

            SectionLabel(tr("AI assistant"))
            Group { AiSection(vm) }

            SectionLabel(tr("Updates"))
            Group {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    val u = update
                    Text(
                        when (u) {
                            is UpdateState.Available -> tr("Mailplane ${u.release.version} is available.")
                            is UpdateState.Downloading -> tr("Downloading ${u.release.version}… ${u.percent}%")
                            is UpdateState.Failed -> u.message
                            UpdateState.Checking -> tr("Checking GitHub for a new version…")
                            UpdateState.UpToDate -> tr("You have the latest version (${BuildConfig.VERSION_NAME}).")
                            UpdateState.Idle -> tr("New versions come from GitHub Releases. Android asks you to confirm each install.")
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (u is UpdateState.Failed) c.danger else c.inkSecondary,
                    )
                    when (u) {
                        is UpdateState.Available -> AccentButton(tr("Update to ${u.release.version}"), { vm.installUpdate(u.release) }, Modifier.fillMaxWidth())
                        is UpdateState.Downloading -> LinearProgressIndicator(
                            progress = { u.percent / 100f }, modifier = Modifier.fillMaxWidth(), color = c.accentDeep, trackColor = c.tile,
                        )
                        is UpdateState.Failed -> if (u.release != null) {
                            AccentButton(tr("Try again"), { vm.installUpdate(u.release) }, Modifier.fillMaxWidth())
                        } else {
                            TextButton(onClick = { vm.checkForUpdate() }) { Text(tr("Check again"), color = c.ink) }
                        }
                        UpdateState.Checking -> {}
                        else -> TextButton(onClick = { vm.checkForUpdate() }) { Text(tr("Check for updates"), color = c.ink) }
                    }
                }
            }

            Column(Modifier.fillMaxWidth().padding(vertical = 32.dp), horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                BrandMark(44.dp)
                Text("Mailplane ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall, color = c.inkTertiary)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { uriHandler.openUri("https://github.com/mauricekleindienst/mailplane") }) {
                        Text(tr("Source code"), color = c.inkSecondary, style = MaterialTheme.typography.labelMedium)
                    }
                    TextButton(onClick = { uriHandler.openUri("https://github.com/mauricekleindienst/mailplane/issues") }) {
                        Text(tr("Report a problem"), color = c.inkSecondary, style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
        }
    }

    confirmRemove?.let { acc ->
        AlertDialog(
            onDismissRequest = { confirmRemove = null },
            title = { Text(tr("Remove ${acc.email}?")) },
            text = { Text(tr("Mail stays on the server. You can add the account again later.")) },
            confirmButton = { TextButton(onClick = { vm.removeAccount(acc.id); confirmRemove = null }) { Text(tr("Remove"), color = c.danger) } },
            dismissButton = { TextButton(onClick = { confirmRemove = null }) { Text(tr("Cancel"), color = c.ink) } },
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

/**
 * Optional AI: provider, address, key and model. While it is off the app shows
 * no AI controls anywhere; nothing is sent until an AI button is tapped.
 */
@Composable
private fun AiSection(vm: MailViewModel) {
    val c = Frost.colors
    val saved by vm.ai.collectAsState()
    var provider by remember(saved) { mutableStateOf(saved.provider) }
    var baseUrl by remember(saved) { mutableStateOf(saved.baseUrl) }
    var model by remember(saved) { mutableStateOf(saved.model) }
    var key by remember { mutableStateOf("") }
    var models by remember { mutableStateOf<List<String>>(emptyList()) }
    var status by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var providerMenu by remember { mutableStateOf(false) }
    var modelMenu by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val info = AiClient.provider(provider)
    val fieldColors = TextFieldDefaults.colors(focusedContainerColor = c.tile, unfocusedContainerColor = c.tile,
        focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, cursorColor = c.ink)

    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(tr("Summaries, reply drafts and rewriting with a model you choose. Nothing is sent until you tap an AI button; while AI is off, Mailplane shows no AI features."),
            style = MaterialTheme.typography.bodySmall, color = c.inkTertiary)
        Box {
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.tile).clickable { providerMenu = true }.padding(14.dp)) {
                Text(tr("Provider"), style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary, modifier = Modifier.weight(1f))
                Text(info?.label ?: tr("Off"), style = MaterialTheme.typography.bodyMedium, color = c.ink)
            }
            DropdownMenu(expanded = providerMenu, onDismissRequest = { providerMenu = false }, containerColor = c.surface) {
                DropdownMenuItem(text = { Text(tr("Off")) }, onClick = {
                    providerMenu = false; provider = "off"; vm.saveAi(AiSettings(), null); status = null
                })
                AiClient.providers.forEach { p ->
                    DropdownMenuItem(text = { Text(p.label) }, onClick = {
                        providerMenu = false; provider = p.id; baseUrl = p.baseUrl; model = ""; models = emptyList(); status = null
                    })
                }
            }
        }
        if (info != null) {
            TextField(baseUrl, { baseUrl = it }, label = { Text(tr("Server address")) }, singleLine = true, colors = fieldColors,
                shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth(),
                supportingText = if (info.local) ({ Text(tr("The address of the computer running the AI app")) }) else null)
            if (info.needsKey || provider == "custom") {
                TextField(key, { key = it }, label = { Text(tr("API key")) }, singleLine = true, colors = fieldColors,
                    visualTransformation = PasswordVisualTransformation(), shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth(),
                    supportingText = if (vm.hasAiKey() && key.isEmpty()) ({ Text(tr("Saved in this phone’s secure storage. Enter a new one to replace it.")) }) else null)
            }
            Box {
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.tile).clickable(enabled = models.isNotEmpty()) { modelMenu = true }
                    .padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(tr("Model"), style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary, modifier = Modifier.weight(1f))
                    Text(model.ifBlank { "—" }, style = MaterialTheme.typography.bodyMedium, color = c.ink)
                }
                DropdownMenu(expanded = modelMenu, onDismissRequest = { modelMenu = false }, containerColor = c.surface) {
                    models.forEach { m -> DropdownMenuItem(text = { Text(m) }, onClick = { modelMenu = false; model = m }) }
                }
            }
            status?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.inkSecondary) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(enabled = !busy, onClick = {
                    busy = true; status = tr("Loading…")
                    scope.launch {
                        vm.aiModels(provider, baseUrl, key).fold(
                            onSuccess = { list -> models = list; if (model.isBlank()) model = list.firstOrNull().orEmpty(); status = null },
                            onFailure = { e -> status = e.message },
                        )
                        busy = false
                    }
                }) { Text(tr("Load models"), color = c.ink) }
                AccentButton(tr("Save"), {
                    vm.saveAi(AiSettings(provider, baseUrl.trim(), model), key.ifBlank { null })
                    key = ""
                    status = tr("Saved")
                }, Modifier.weight(1f))
            }
        }
    }
}
