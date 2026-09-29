@file:OptIn(ExperimentalMaterial3Api::class)

package app.mailplane.android.ui.onboarding

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import app.mailplane.android.ui.components.AccentButton
import app.mailplane.android.ui.components.AccountDot
import app.mailplane.android.ui.components.BrandMark
import app.mailplane.android.ui.components.InfoCard
import app.mailplane.android.ui.components.TileButton
import app.mailplane.android.ui.components.accentWash
import app.mailplane.android.ui.theme.Frost
import app.mailplane.android.ui.tr
import app.mailplane.core.AutoConfig
import app.mailplane.core.Security

/**
 * First-run and "add account" flow:
 * Welcome → e-mail (provider detection) → password (app-password guidance)
 * → live connection check → personalise. Server settings are one tap away
 * but never required for known providers.
 */
@Composable
fun OnboardingScreen(onDone: (accountId: String) -> Unit, onCancel: (() -> Unit)?) {
    val vm: SetupViewModel = viewModel()
    val s by vm.state.collectAsState()
    val c = Frost.colors

    BackHandler(enabled = true) { if (!vm.back()) onCancel?.invoke() }

    Box(Modifier.fillMaxSize().background(c.canvas).background(accentWash())) {
        // safeDrawing already includes the keyboard (IME) inset
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            if (s.step != SetupStep.WELCOME) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { if (!vm.back()) onCancel?.invoke() }) {
                        Icon(if (s.step == SetupStep.EMAIL && !s.firstAccount) Icons.Outlined.Close else Icons.AutoMirrored.Outlined.ArrowBack,
                            contentDescription = tr("Back"), tint = c.ink)
                    }
                    val progress by animateFloatAsState(s.progress, label = "progress")
                    LinearProgressIndicator(
                        progress = { progress },
                        modifier = Modifier.weight(1f).padding(horizontal = 12.dp).height(4.dp).clip(RoundedCornerShape(2.dp)),
                        color = c.accentDeep, trackColor = c.tile, drawStopIndicator = {},
                    )
                    Spacer(Modifier.width(48.dp))
                }
            }
            AnimatedContent(
                targetState = s.step,
                transitionSpec = { (fadeIn() + slideInHorizontally { it / 8 }) togetherWith fadeOut() },
                modifier = Modifier.weight(1f),
                label = "step",
            ) { step ->
                Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    when (step) {
                        SetupStep.WELCOME -> Welcome(onStart = vm::start)
                        SetupStep.EMAIL -> EmailStep(s, vm)
                        SetupStep.PASSWORD -> PasswordStep(s, vm)
                        SetupStep.SERVERS -> ServersStep(s, vm)
                        SetupStep.CHECKING -> CheckingStep(s, vm)
                        SetupStep.PERSONALIZE -> PersonalizeStep(s, vm) { vm.finish()?.let(onDone) }
                    }
                }
            }
        }
    }
}

@Composable
private fun Title(title: String, subtitle: String?) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 12.dp, bottom = 4.dp)) {
        Text(tr(title), style = MaterialTheme.typography.headlineMedium, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, color = Frost.colors.ink)
        if (subtitle != null) Text(tr(subtitle), style = MaterialTheme.typography.bodyLarge, color = Frost.colors.inkSecondary)
    }
}

@Composable
internal fun Welcome(onStart: () -> Unit) {
    val c = Frost.colors
    Spacer(Modifier.height(48.dp))
    BrandMark(84.dp)
    Title("Mailplane", "Calm, fast e-mail for every account you have.")
    Spacer(Modifier.height(8.dp))
    Feature(Icons.Outlined.Bolt, "Works with Gmail, Outlook, iCloud, Yahoo and any IMAP server")
    Feature(Icons.Outlined.Lock, "Passwords are encrypted with this phone's secure hardware and never leave it")
    Feature(Icons.Outlined.NotificationsNone, "Quiet notifications when new mail arrives")
    Spacer(Modifier.height(24.dp))
    AccentButton("Add your first account", onStart, Modifier.fillMaxWidth())
    Text(tr("You can add more accounts any time."), style = MaterialTheme.typography.bodySmall, color = c.inkTertiary,
        modifier = Modifier.fillMaxWidth(), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
}

@Composable
private fun Feature(icon: ImageVector, text: String) {
    val c = Frost.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Box(Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(c.tile), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = c.ink, modifier = Modifier.size(20.dp))
        }
        Text(tr(text), style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary)
    }
}

@Composable
private fun frostFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Frost.colors.accentDeep,
    unfocusedBorderColor = Frost.colors.tileActive,
    focusedContainerColor = Frost.colors.raised,
    unfocusedContainerColor = Frost.colors.raised,
    cursorColor = Frost.colors.ink,
    focusedLabelColor = Frost.colors.inkSecondary,
)

@Composable
private fun EmailStep(s: SetupState, vm: SetupViewModel) {
    val c = Frost.colors
    Title("What's your e-mail address?", "We'll find the right server settings for you.")
    OutlinedTextField(
        value = s.email, onValueChange = vm::setEmail,
        label = { Text(tr("E-mail address")) }, singleLine = true,
        isError = s.emailError != null,
        supportingText = {
            when {
                s.emailError != null -> Text(tr(s.emailError))
                s.instantProvider != null -> Text(tr("✓ ${s.instantProvider} — settings are built in"), color = c.inkSecondary)
            }
        },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onNext = { vm.submitEmail() }),
        shape = RoundedCornerShape(14.dp), colors = frostFieldColors(),
        modifier = Modifier.fillMaxWidth(),
    )
    if (s.detecting) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = c.inkSecondary)
            Text(tr("Looking up server settings…"), style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary)
        }
    }
    AccentButton("Continue", vm::submitEmail, Modifier.fillMaxWidth(), enabled = s.email.isNotBlank() && !s.detecting)
}

@Composable
private fun PasswordStep(s: SetupState, vm: SetupViewModel) {
    val c = Frost.colors
    val context = LocalContext.current
    var visible by remember { mutableStateOf(false) }
    Title("Sign in", s.email)
    ProviderBadge(s)
    if (s.note != null) {
        InfoCard(title = "Use an app password", body = s.note) {
            if (s.helpUrl != null) TextButton(onClick = {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(s.helpUrl)))
            }) { Text(tr("Create one at ${s.provider ?: tr("your provider")} ↗"), color = c.ink) }
        }
    }
    OutlinedTextField(
        value = s.password, onValueChange = vm::setPassword,
        label = { Text(tr(if (s.note != null) "App password" else "Password")) }, singleLine = true,
        visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
        trailingIcon = {
            IconButton(onClick = { visible = !visible }) {
                Icon(if (visible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                    contentDescription = tr(if (visible) "Hide password" else "Show password"))
            }
        },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Go, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onGo = { vm.check() }),
        shape = RoundedCornerShape(14.dp), colors = frostFieldColors(),
        modifier = Modifier.fillMaxWidth(),
    )
    AccentButton("Sign in", vm::check, Modifier.fillMaxWidth(), enabled = s.password.isNotBlank())
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        TextButton(onClick = vm::editServers) { Text(tr("Server settings"), color = c.inkSecondary) }
    }
}

@Composable
private fun ProviderBadge(s: SetupState) {
    val c = Frost.colors
    val (title, detail) = when (s.providerSource) {
        AutoConfig.Source.BUILT_IN -> s.provider to "Settings are built in"
        AutoConfig.Source.ISPDB -> s.provider to "Found in Mozilla's provider directory"
        AutoConfig.Source.DOMAIN -> s.provider to "Found on your domain's autoconfig"
        null -> "Custom server" to "We'll try ${s.imap.host} — change it under Server settings if needed"
    }
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.raised).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(32.dp).clip(CircleShape).background(c.tile), contentAlignment = Alignment.Center) {
            Text((title ?: "?").take(1).uppercase(), color = c.ink, style = MaterialTheme.typography.labelLarge)
        }
        Column {
            Text(tr(title ?: ""), style = MaterialTheme.typography.titleMedium, color = c.ink)
            Text(tr(detail), style = MaterialTheme.typography.bodySmall, color = c.inkTertiary)
        }
    }
}

@Composable
private fun ServersStep(s: SetupState, vm: SetupViewModel) {
    Title("Server settings", "Your provider's help pages list these. Most use SSL on port 993 and STARTTLS on 587.")
    if (s.checkError != null) Text(tr(s.checkError), color = Frost.colors.danger, style = MaterialTheme.typography.bodyMedium)
    ServerFields("Incoming mail (IMAP)", s.imap, vm::setImap)
    ServerFields("Outgoing mail (SMTP)", s.smtp, vm::setSmtp)
    OutlinedTextField(
        value = s.username, onValueChange = vm::setUsername, label = { Text(tr("Username")) }, singleLine = true,
        supportingText = { Text(tr("Usually your full e-mail address")) },
        shape = RoundedCornerShape(14.dp), colors = frostFieldColors(), modifier = Modifier.fillMaxWidth(),
    )
    AccentButton("Check connection", vm::check, Modifier.fillMaxWidth(), enabled = s.password.isNotBlank())
}

@Composable
private fun ServerFields(label: String, form: ServerForm, onChange: (ServerForm) -> Unit) {
    val c = Frost.colors
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(c.raised).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(tr(label), style = MaterialTheme.typography.titleMedium, color = c.ink)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(form.host, { onChange(form.copy(host = it)) }, label = { Text(tr("Server")) }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                shape = RoundedCornerShape(12.dp), colors = frostFieldColors(), modifier = Modifier.weight(1f))
            OutlinedTextField(form.port, { v -> onChange(form.copy(port = v.filter(Char::isDigit).take(5))) }, label = { Text(tr("Port")) },
                singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                shape = RoundedCornerShape(12.dp), colors = frostFieldColors(), modifier = Modifier.width(96.dp))
        }
        val options = listOf(Security.SSL to "SSL/TLS", Security.STARTTLS to "STARTTLS", Security.NONE to tr("None"))
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            options.forEachIndexed { i, (sec, text) ->
                SegmentedButton(
                    selected = form.security == sec,
                    onClick = {
                        // Switching security also switches to that mode's usual port if the old one was the default
                        val port = when {
                            form.port.isBlank() || form.port in listOf("993", "143", "465", "587", "25") ->
                                if (label.contains("IMAP")) (if (sec == Security.SSL) "993" else "143")
                                else (if (sec == Security.SSL) "465" else "587")
                            else -> form.port
                        }
                        onChange(form.copy(security = sec, port = port))
                    },
                    shape = SegmentedButtonDefaults.itemShape(i, options.size),
                    colors = SegmentedButtonDefaults.colors(activeContainerColor = c.accent, activeContentColor = c.onAccent),
                ) { Text(text) }
            }
        }
        if (form.security == Security.NONE) {
            Text(tr("Without encryption your password travels in plain text. Only use this for local servers."),
                style = MaterialTheme.typography.bodySmall, color = c.danger)
        }
    }
}

@Composable
private fun CheckingStep(s: SetupState, vm: SetupViewModel) {
    val c = Frost.colors
    val failed = s.incoming == CheckStatus.FAILED || s.outgoing == CheckStatus.FAILED
    Title(if (failed) "Couldn't connect" else "Connecting…", s.email)
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(c.raised).padding(vertical = 6.dp),
    ) {
        CheckRow("Incoming mail", "${s.imap.host}:${s.imap.port}", s.incoming)
        CheckRow("Outgoing mail", "${s.smtp.host}:${s.smtp.port}", s.outgoing)
    }
    if (failed) {
        InfoCard(title = "What went wrong", body = s.checkError ?: "Unknown error")
        AccentButton("Try another password", { vm.back() }, Modifier.fillMaxWidth())
        TileButton("Edit server settings", vm::editServers, Modifier.fillMaxWidth())
    }
}

@Composable
private fun CheckRow(title: String, detail: String, status: CheckStatus) {
    val c = Frost.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(tr(title), style = MaterialTheme.typography.titleMedium, color = if (status == CheckStatus.PENDING) c.inkTertiary else c.ink)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = c.inkTertiary)
        }
        Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) {
            when (status) {
                CheckStatus.PENDING -> Box(Modifier.size(10.dp).clip(CircleShape).background(c.tileActive))
                CheckStatus.RUNNING -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = c.inkSecondary)
                CheckStatus.OK -> Box(Modifier.size(26.dp).clip(CircleShape).background(c.accent), contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.Check, contentDescription = "OK", tint = c.onAccent, modifier = Modifier.size(16.dp))
                }
                CheckStatus.FAILED -> Box(Modifier.size(26.dp).clip(CircleShape).background(c.danger), contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.Close, contentDescription = tr("Failed"), tint = Color.White, modifier = Modifier.size(16.dp))
                }
            }
        }
    }
}

@Composable
private fun PersonalizeStep(s: SetupState, vm: SetupViewModel, onFinish: () -> Unit) {
    val c = Frost.colors
    Title("You're connected", "Make this account easy to recognise.")
    OutlinedTextField(
        value = s.name, onValueChange = vm::setName, label = { Text(tr("Your name")) }, singleLine = true,
        supportingText = { Text(tr("Shown to people you write to")) },
        shape = RoundedCornerShape(14.dp), colors = frostFieldColors(), modifier = Modifier.fillMaxWidth(),
    )
    Text(tr("Account colour"), style = MaterialTheme.typography.labelMedium, color = c.inkSecondary)
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
        SetupState.PALETTE.take(6).forEach { hex ->
            val selected = hex == s.color
            Box(
                Modifier.size(38.dp).clip(CircleShape)
                    .border(if (selected) 2.dp else 0.dp, if (selected) c.ink else Color.Transparent, CircleShape)
                    .padding(4.dp).clip(CircleShape)
                    .clickable { vm.setColor(hex) },
                contentAlignment = Alignment.Center,
            ) { AccountDot(hex, 30.dp) }
        }
    }
    // Preview of how the account appears in the account switcher
    Row(
        Modifier.clip(RoundedCornerShape(10.dp)).background(c.tileActive).padding(horizontal = 14.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AccountDot(s.color, 7.dp)
        Text(s.name.ifBlank { s.email }, style = MaterialTheme.typography.labelMedium, color = c.ink)
    }
    Spacer(Modifier.height(8.dp))
    AccentButton("Open inbox", onFinish, Modifier.fillMaxWidth())
}
