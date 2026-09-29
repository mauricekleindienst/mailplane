package app.mailplane.android.ui.onboarding

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.mailplane.android.MailplaneApplication
import app.mailplane.core.Account
import app.mailplane.core.Addresses
import app.mailplane.core.AutoConfig
import app.mailplane.core.ProviderPresets
import app.mailplane.core.Security
import app.mailplane.core.ServerConfig
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

enum class SetupStep { WELCOME, EMAIL, PASSWORD, SERVERS, CHECKING, PERSONALIZE }
enum class CheckStatus { PENDING, RUNNING, OK, FAILED }

data class ServerForm(val host: String = "", val port: String = "", val security: Security = Security.SSL) {
    fun toConfig(): ServerConfig? = port.toIntOrNull()?.takeIf { host.isNotBlank() }?.let { ServerConfig(host.trim(), it, security) }
    companion object { fun of(c: ServerConfig) = ServerForm(c.host, c.port.toString(), c.security) }
}

data class SetupState(
    val step: SetupStep = SetupStep.WELCOME,
    val firstAccount: Boolean = true,
    val email: String = "",
    val emailError: String? = null,
    val detecting: Boolean = false,
    val provider: String? = null,
    val providerSource: AutoConfig.Source? = null,
    val note: String? = null,
    val helpUrl: String? = null,
    val password: String = "",
    val username: String = "",
    val imap: ServerForm = ServerForm(),
    val smtp: ServerForm = ServerForm(),
    val incoming: CheckStatus = CheckStatus.PENDING,
    val outgoing: CheckStatus = CheckStatus.PENDING,
    val checkError: String? = null,
    val name: String = "",
    val color: String = PALETTE.first(),
) {
    /** Provider recognised while typing (built-in presets only — instant, no network). */
    val instantProvider: String? get() = ProviderPresets.forEmail(email)?.provider
    val progress: Float get() = when (step) {
        SetupStep.WELCOME -> 0f
        SetupStep.EMAIL -> 0.25f
        SetupStep.PASSWORD, SetupStep.SERVERS -> 0.5f
        SetupStep.CHECKING -> 0.75f
        SetupStep.PERSONALIZE -> 1f
    }

    companion object {
        /** Muted account colours — same palette as the desktop app. */
        val PALETTE = listOf("#5f8fc4", "#6fa665", "#c9a23a", "#8f7fc4", "#cf6f5f", "#4fa596", "#d38c55", "#c2708f", "#7b80c9", "#4ea2bf")
    }
}

class SetupViewModel(app: Application) : AndroidViewModel(app) {
    private val mail = (app as MailplaneApplication).mail
    private val accounts = (app as MailplaneApplication).accounts

    private val _state = MutableStateFlow(
        SetupState(
            firstAccount = accounts.accounts.value.isEmpty(),
            step = if (accounts.accounts.value.isEmpty()) SetupStep.WELCOME else SetupStep.EMAIL,
            color = SetupState.PALETTE[accounts.accounts.value.size % SetupState.PALETTE.size],
        )
    )
    val state: StateFlow<SetupState> = _state
    private var checkJob: Job? = null

    fun start() = _state.update { it.copy(step = SetupStep.EMAIL) }
    fun setEmail(v: String) = _state.update { it.copy(email = v.trim(), emailError = null) }
    fun setPassword(v: String) = _state.update { it.copy(password = v) }
    fun setUsername(v: String) = _state.update { it.copy(username = v) }
    fun setImap(f: ServerForm) = _state.update { it.copy(imap = f) }
    fun setSmtp(f: ServerForm) = _state.update { it.copy(smtp = f) }
    fun setName(v: String) = _state.update { it.copy(name = v) }
    fun setColor(v: String) = _state.update { it.copy(color = v) }
    fun editServers() = _state.update { it.copy(step = SetupStep.SERVERS) }

    fun back(): Boolean {
        val s = _state.value
        val prev = when (s.step) {
            SetupStep.WELCOME -> return false
            SetupStep.EMAIL -> if (s.firstAccount) SetupStep.WELCOME else return false
            SetupStep.PASSWORD -> SetupStep.EMAIL
            SetupStep.SERVERS -> SetupStep.PASSWORD
            SetupStep.CHECKING -> { checkJob?.cancel(); SetupStep.PASSWORD }
            SetupStep.PERSONALIZE -> SetupStep.PASSWORD
        }
        _state.update { it.copy(step = prev) }
        return true
    }

    /** EMAIL → PASSWORD: validate, then look up server settings. */
    fun submitEmail() {
        val email = _state.value.email
        if (!Addresses.isValid(email)) { _state.update { it.copy(emailError = "That doesn't look like an e-mail address") }; return }
        if (accounts.accounts.value.any { it.email.equals(email, ignoreCase = true) }) {
            _state.update { it.copy(emailError = "This account is already set up") }; return
        }
        _state.update { it.copy(detecting = true) }
        viewModelScope.launch {
            val found = runCatching { mail.discover(email) }.getOrNull()
            val preset = found?.preset ?: ProviderPresets.guess(email)!!
            _state.update {
                it.copy(
                    detecting = false,
                    step = SetupStep.PASSWORD,
                    provider = found?.preset?.provider,
                    providerSource = found?.source,
                    note = preset.note,
                    helpUrl = preset.helpUrl,
                    username = email,
                    imap = ServerForm.of(preset.imap),
                    smtp = ServerForm.of(preset.smtp),
                    name = it.name.ifBlank { defaultName(email) },
                )
            }
        }
    }

    /** PASSWORD / SERVERS → CHECKING: test incoming then outgoing, each with its own status. */
    fun check() {
        val s = _state.value
        if (s.password.isBlank()) return
        val account = draftAccount(s) ?: run {
            _state.update { it.copy(step = SetupStep.SERVERS, checkError = "Fill in both servers") }; return
        }
        _state.update { it.copy(step = SetupStep.CHECKING, incoming = CheckStatus.RUNNING, outgoing = CheckStatus.PENDING, checkError = null) }
        checkJob?.cancel()
        checkJob = viewModelScope.launch {
            val incoming = runCatching { mail.verifyIncoming(account, s.password) }
            if (incoming.isFailure) {
                _state.update { it.copy(incoming = CheckStatus.FAILED, checkError = incoming.exceptionOrNull()?.message) }
                return@launch
            }
            _state.update { it.copy(incoming = CheckStatus.OK, outgoing = CheckStatus.RUNNING) }
            val outgoing = runCatching { mail.verifyOutgoing(account, s.password) }
            if (outgoing.isFailure) {
                _state.update { it.copy(outgoing = CheckStatus.FAILED, checkError = outgoing.exceptionOrNull()?.message) }
                return@launch
            }
            _state.update { it.copy(outgoing = CheckStatus.OK) }
            delay(450) // let the second tick register before moving on
            _state.update { it.copy(step = SetupStep.PERSONALIZE) }
        }
    }

    /** Saves the account; returns its id. */
    fun finish(): String? {
        val s = _state.value
        val base = draftAccount(s) ?: return null
        val account = base.copy(name = s.name.trim().ifBlank { defaultName(s.email) }, color = s.color)
        accounts.add(account, s.password)
        return account.id
    }

    private val draftId = UUID.randomUUID().toString()

    private fun draftAccount(s: SetupState): Account? {
        val imap = s.imap.toConfig() ?: return null
        val smtp = s.smtp.toConfig() ?: return null
        return Account(id = draftId, name = s.name, email = s.email, imap = imap, smtp = smtp,
            username = s.username.ifBlank { s.email })
    }

    private fun defaultName(email: String) = email.substringBefore('@')
        .split('.', '_', '-').filter { it.isNotBlank() }
        .joinToString(" ") { part -> part.replaceFirstChar { c -> c.uppercase() } }
}
