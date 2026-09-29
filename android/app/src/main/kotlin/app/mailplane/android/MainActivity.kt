package app.mailplane.android

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import app.mailplane.android.ui.I18n
import app.mailplane.android.ui.MailViewModel
import androidx.compose.runtime.key
import app.mailplane.android.ui.compose.ComposeScreen
import app.mailplane.android.ui.inbox.InboxScreen
import app.mailplane.android.ui.message.MessageScreen
import app.mailplane.android.ui.onboarding.OnboardingScreen
import app.mailplane.android.ui.settings.SettingsScreen
import app.mailplane.android.ui.theme.MailplaneTheme
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {
    private val vm: MailViewModel by viewModels()
    /** mailto: link waiting to be opened in the composer. */
    private val pendingMailto = MutableStateFlow<Uri?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        handleIntent(intent)
        val app = application as MailplaneApplication

        setContent {
            val theme by app.settings.theme.collectAsState()
            val accent by app.settings.accent.collectAsState()
            val language by app.settings.language.collectAsState()
            val accounts by vm.accounts.collectAsState()
            val mailto by pendingMailto.collectAsState()
            val nav = rememberNavController()
            val snackbar = remember { SnackbarHostState() }
            val notifPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }

            LaunchedEffect(Unit) { vm.messages.collect { snackbar.showSnackbar(it) } }
            LaunchedEffect(mailto, accounts.isNotEmpty()) {
                val uri = mailto ?: return@LaunchedEffect
                if (accounts.isEmpty()) return@LaunchedEffect
                val m = parseMailto(uri)
                vm.newDraft(to = m["to"].orEmpty(), cc = m["cc"].orEmpty(), subject = m["subject"].orEmpty(), body = m["body"].orEmpty())
                pendingMailto.value = null
                nav.navigate("compose")
            }

            // The whole UI re-composes in the new language (see ui/I18n)
            I18n.apply(language)
            MailplaneTheme(theme, accent) { key(language) {
                NavHost(nav, startDestination = if (accounts.isEmpty()) "onboarding" else "inbox") {
                    composable("onboarding") {
                        OnboardingScreen(
                            onDone = { id ->
                                vm.onAccountAdded(id)
                                if (Build.VERSION.SDK_INT >= 33) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                                nav.navigate("inbox") { popUpTo(0) }
                            },
                            onCancel = if (accounts.isEmpty()) null else ({ nav.popBackStack(); Unit }),
                        )
                    }
                    composable("inbox") {
                        InboxScreen(
                            vm, snackbar,
                            onOpen = { m ->
                                if (vm.isDraft(m)) vm.openDraft(m) { nav.navigate("compose") }
                                else { vm.open(m); nav.navigate("message") }
                            },
                            onCompose = { vm.newDraft(); nav.navigate("compose") },
                            onAddAccount = { nav.navigate("onboarding") },
                            onSettings = { nav.navigate("settings") },
                        )
                    }
                    composable("message") {
                        MessageScreen(vm, snackbar, onBack = { nav.popBackStack() }, onCompose = { nav.navigate("compose") })
                    }
                    composable("compose") { ComposeScreen(vm, onClose = { nav.popBackStack() }) }
                    composable("settings") {
                        SettingsScreen(vm, onBack = { nav.popBackStack() }, onAddAccount = { nav.navigate("onboarding") })
                    }
                }
            } }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        intent?.getStringExtra(EXTRA_ACCOUNT_ID)?.let { vm.switchAccount(it) }
        val data = intent?.data
        if (data?.scheme == "mailto") pendingMailto.value = data
    }

    companion object {
        const val EXTRA_ACCOUNT_ID = "accountId"

        /** mailto:a@b.c?cc=…&subject=…&body=… (RFC 6068) */
        fun parseMailto(uri: Uri): Map<String, String> {
            val raw = uri.toString().removePrefix("mailto:")
            val (addr, query) = raw.split('?', limit = 2).let { it[0] to it.getOrElse(1) { "" } }
            val params = query.split('&').filter { '=' in it }.associate {
                val (k, v) = it.split('=', limit = 2)
                k.lowercase() to Uri.decode(v)
            }
            val to = listOf(Uri.decode(addr), params["to"].orEmpty()).filter { it.isNotBlank() }.joinToString(", ")
            return params + ("to" to to)
        }
    }
}
