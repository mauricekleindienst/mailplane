package app.mailplane.android.ui

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.mailplane.android.MailplaneApplication
import app.mailplane.core.Account
import app.mailplane.core.AttachmentInfo
import app.mailplane.core.FolderRole
import app.mailplane.core.MailFolder
import app.mailplane.core.MessageBody
import app.mailplane.core.MessageSummary
import app.mailplane.core.OutgoingMessage
import app.mailplane.core.Subjects
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File
import java.text.DateFormat
import java.util.Date

data class ListState(
    val folders: List<MailFolder> = emptyList(),
    val folderPath: String = "INBOX",
    val messages: List<MessageSummary> = emptyList(),
    val total: Int = 0,
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val loadingMore: Boolean = false,
    val error: String? = null,
    val query: String = "",
    val searching: Boolean = false,
) {
    val folder: MailFolder? get() = folders.firstOrNull { it.path == folderPath }
    val canLoadMore: Boolean get() = !searching && messages.size < total
}

data class ReaderState(
    val summary: MessageSummary? = null,
    val body: MessageBody? = null,
    val loading: Boolean = false,
    val error: String? = null,
    val imagesAllowed: Boolean = false,
)

data class Draft(
    val accountId: String? = null,
    val to: String = "",
    val cc: String = "",
    val bcc: String = "",
    val subject: String = "",
    val body: String = "",
    val quoted: String = "",
    val inReplyTo: String? = null,
    val references: String? = null,
    val sending: Boolean = false,
    val error: String? = null,
    val title: String = "New message",
)

class MailViewModel(app: Application) : AndroidViewModel(app) {
    private val mplane = app as MailplaneApplication
    private val repo = mplane.mail
    val accounts: StateFlow<List<Account>> = mplane.accounts.accounts
    val settings = mplane.settings
    val updater = mplane.updater

    private val _activeId = MutableStateFlow(accounts.value.firstOrNull()?.id)
    val activeAccountId: StateFlow<String?> = _activeId

    private val _list = MutableStateFlow(ListState())
    val list: StateFlow<ListState> = _list

    private val _reader = MutableStateFlow(ReaderState())
    val reader: StateFlow<ReaderState> = _reader

    private val _draft = MutableStateFlow(Draft())
    val draft: StateFlow<Draft> = _draft

    private val _unread = MutableStateFlow<Map<String, Int>>(emptyMap())
    /** Inbox unread per account, for the account pills. */
    val unread: StateFlow<Map<String, Int>> = _unread

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    /** One-off messages for the snackbar. */
    val messages: SharedFlow<String> = _messages

    private var loadJob: Job? = null

    val activeAccount: Account? get() = accounts.value.firstOrNull { it.id == _activeId.value } ?: accounts.value.firstOrNull()

    init {
        reloadAll()
        viewModelScope.launch { updater.check() }   // at most once a day
    }

    fun checkForUpdate() = viewModelScope.launch { updater.check(force = true) }
    fun installUpdate(release: app.mailplane.android.data.AppRelease) = viewModelScope.launch { updater.install(release) }

    fun reloadAll() {
        val acc = activeAccount ?: return
        _activeId.value = acc.id
        loadFolders(acc)
        loadMessages(reset = true)
    }

    fun switchAccount(id: String) {
        if (id == _activeId.value) return
        _activeId.value = id
        _list.value = ListState(loading = true)
        activeAccount?.let { loadFolders(it) }
        loadMessages(reset = true)
    }

    fun openFolder(path: String) {
        _list.update { it.copy(folderPath = path, messages = emptyList(), total = 0, query = "", searching = false) }
        loadMessages(reset = true)
    }

    fun refresh() {
        activeAccount?.let { loadFolders(it) }
        loadMessages(reset = true, pull = true)
    }

    private fun loadFolders(acc: Account) = viewModelScope.launch {
        runCatching { repo.folders(acc) }
            .onSuccess { folders ->
                _list.update { st ->
                    val path = if (folders.any { it.path == st.folderPath }) st.folderPath
                    else folders.firstOrNull { it.role == FolderRole.INBOX }?.path ?: "INBOX"
                    st.copy(folders = folders, folderPath = path)
                }
                folders.firstOrNull { it.role == FolderRole.INBOX }?.let { inbox ->
                    _unread.update { it + (acc.id to inbox.unread) }
                }
            }
    }

    fun loadMessages(reset: Boolean = false, pull: Boolean = false) {
        val acc = activeAccount ?: return
        val st = _list.value
        if (!reset && (st.loadingMore || !st.canLoadMore)) return
        loadJob?.cancel()
        val folder = st.folderPath
        val accountId = acc.id
        _list.update {
            it.copy(loading = reset && !pull && it.messages.isEmpty(), refreshing = pull, loadingMore = !reset, error = null)
        }
        loadJob = viewModelScope.launch {
            val offset = if (reset) 0 else _list.value.messages.size
            runCatching { repo.messages(acc, folder, offset) }
                .onSuccess { page ->
                    if (_activeId.value != accountId || _list.value.folderPath != folder) return@onSuccess
                    _list.update {
                        val merged = if (reset) page.messages else (it.messages + page.messages).distinctBy { m -> m.uid }
                        it.copy(messages = merged, total = page.total, loading = false, refreshing = false, loadingMore = false)
                    }
                    if (_list.value.folder?.role == FolderRole.INBOX) _unread.update { it + (accountId to page.unread) }
                }
                .onFailure { e ->
                    _list.update { it.copy(loading = false, refreshing = false, loadingMore = false, error = e.message) }
                }
        }
    }

    fun search(query: String) {
        _list.update { it.copy(query = query) }
        val acc = activeAccount ?: return
        if (query.isBlank()) { _list.update { it.copy(searching = false) }; loadMessages(reset = true); return }
        loadJob?.cancel()
        val folder = _list.value.folderPath
        _list.update { it.copy(searching = true, loading = true, error = null) }
        loadJob = viewModelScope.launch {
            kotlinx.coroutines.delay(350) // debounce typing
            runCatching { repo.search(acc, folder, query.trim()) }
                .onSuccess { hits -> _list.update { it.copy(messages = hits, total = hits.size, loading = false) } }
                .onFailure { e -> _list.update { it.copy(loading = false, error = e.message) } }
        }
    }

    // ── Reading ─────────────────────────────────────────────────────────────

    fun open(m: MessageSummary) {
        val acc = activeAccount ?: return
        _reader.value = ReaderState(summary = m, loading = true, imagesAllowed = !settings.blockImages.value)
        viewModelScope.launch {
            runCatching { repo.body(acc, m) }
                .onSuccess { body -> if (_reader.value.summary?.uid == m.uid) _reader.update { it.copy(body = body, loading = false) } }
                .onFailure { e -> _reader.update { it.copy(loading = false, error = e.message) } }
            if (!m.seen) setSeen(m, true, quiet = true)
        }
    }

    fun allowImages() = _reader.update { it.copy(imagesAllowed = true) }

    fun setSeen(m: MessageSummary, seen: Boolean, quiet: Boolean = false) = mutate(m, { it.copy(seen = seen) }) { acc ->
        repo.setSeen(acc, m, seen)
        if (_list.value.folder?.role == FolderRole.INBOX) _unread.update { u -> u + (acc.id to ((u[acc.id] ?: 0) + if (seen) -1 else 1).coerceAtLeast(0)) }
        if (!quiet) _messages.tryEmit(if (seen) "Marked as read" else "Marked as unread")
    }

    fun toggleFlag(m: MessageSummary) = mutate(m, { it.copy(flagged = !m.flagged) }) { acc -> repo.setFlagged(acc, m, !m.flagged) }

    fun delete(m: MessageSummary) = remove(m, "Moved to Trash") { acc -> repo.delete(acc, m) }
    fun archive(m: MessageSummary) = remove(m, "Archived") { acc -> repo.archive(acc, m) }

    /** Optimistically updates the list and reader, rolls back if the server call fails. */
    private fun mutate(m: MessageSummary, change: (MessageSummary) -> MessageSummary, call: suspend (Account) -> Unit) {
        val acc = activeAccount ?: return
        val updated = change(m)
        fun apply(v: MessageSummary) {
            _list.update { st -> st.copy(messages = st.messages.map { if (it.uid == v.uid && it.folder == v.folder) v else it }) }
            _reader.update { r -> if (r.summary?.uid == v.uid) r.copy(summary = v) else r }
        }
        apply(updated)
        viewModelScope.launch {
            runCatching { call(acc) }.onFailure { e -> apply(m); _messages.tryEmit(e.message ?: "Something went wrong") }
        }
    }

    private fun remove(m: MessageSummary, done: String, call: suspend (Account) -> Unit) {
        val acc = activeAccount ?: return
        val before = _list.value.messages
        _list.update { st -> st.copy(messages = st.messages.filterNot { it.uid == m.uid && it.folder == m.folder }, total = (st.total - 1).coerceAtLeast(0)) }
        viewModelScope.launch {
            runCatching { call(acc) }
                .onSuccess { _messages.tryEmit(done) }
                .onFailure { e -> _list.update { it.copy(messages = before) }; _messages.tryEmit(e.message ?: "Something went wrong") }
        }
    }

    /** Downloads an attachment into the cache and returns a VIEW intent for it. */
    suspend fun attachmentIntent(att: AttachmentInfo): Intent? {
        val acc = activeAccount ?: return null
        val m = _reader.value.summary ?: return null
        return runCatching {
            val bytes = repo.attachment(acc, m, att.index)
            val dir = File(getApplication<Application>().cacheDir, "attachments").apply { mkdirs() }
            val safe = att.fileName.replace(Regex("[/\\\\:*?\"<>|]"), "_")
            val file = File(dir, safe).apply { writeBytes(bytes) }
            val ctx = getApplication<Application>()
            val uri: Uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", file)
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, att.mimeType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }.onFailure { _messages.tryEmit("Download failed: ${it.message}") }.getOrNull()
    }

    // ── Composing ───────────────────────────────────────────────────────────

    fun newDraft(to: String = "", cc: String = "", subject: String = "", body: String = "") {
        _draft.value = Draft(accountId = activeAccount?.id, to = to, cc = cc, subject = subject, body = body)
    }

    fun reply(all: Boolean) {
        val acc = activeAccount ?: return
        val m = _reader.value.summary ?: return
        val b = _reader.value.body
        val me = acc.email.lowercase()
        val seen = mutableSetOf(me)
        fun uniq(list: List<String>) = list.filter { it.isNotBlank() && seen.add(it.lowercase()) }
        val from = b?.from?.email ?: m.fromEmail
        val to = uniq(listOf(from) + if (all) b?.to.orEmpty().map { it.email } else emptyList())
        val cc = if (all) uniq(b?.cc.orEmpty().map { it.email }) else emptyList()
        _draft.value = Draft(
            accountId = acc.id, to = to.joinToString(", "), cc = cc.joinToString(", "),
            subject = Subjects.reply(m.subject), quoted = quote(m, b),
            inReplyTo = b?.messageId, references = listOfNotNull(b?.references, b?.messageId).joinToString(" ").ifBlank { null },
            title = if (all) "Reply all" else "Reply",
        )
    }

    fun forward() {
        val m = _reader.value.summary ?: return
        val b = _reader.value.body
        _draft.value = Draft(
            accountId = activeAccount?.id, subject = Subjects.forward(m.subject), title = "Forward",
            quoted = "---------- Forwarded message ----------\nFrom: ${m.fromName} <${m.fromEmail}>\n" +
                "Date: ${formatFull(m)}\nSubject: ${m.subject}\n\n${b?.text ?: app.mailplane.core.Snippets.of(null, b?.html, Int.MAX_VALUE)}",
        )
    }

    fun updateDraft(change: (Draft) -> Draft) = _draft.update(change)

    fun send(onSent: () -> Unit) {
        val d = _draft.value
        val acc = accounts.value.firstOrNull { it.id == d.accountId } ?: activeAccount ?: return
        val invalid = app.mailplane.core.Addresses.firstInvalid(d.to) ?: app.mailplane.core.Addresses.firstInvalid(d.cc)
            ?: app.mailplane.core.Addresses.firstInvalid(d.bcc)
        if (d.to.isBlank()) { _draft.update { it.copy(error = "Add a recipient") }; return }
        if (invalid != null) { _draft.update { it.copy(error = "Invalid address: $invalid") }; return }
        val text = buildString {
            append(d.body.trimEnd())
            if (acc.signature.isNotBlank()) append("\n\n-- \n").append(acc.signature)
            if (d.quoted.isNotBlank()) append("\n\n").append(d.quoted)
        }
        _draft.update { it.copy(sending = true, error = null) }
        viewModelScope.launch {
            runCatching {
                repo.send(acc, OutgoingMessage(to = d.to, cc = d.cc, bcc = d.bcc, subject = d.subject, text = text,
                    inReplyTo = d.inReplyTo, references = d.references))
            }.onSuccess {
                _draft.value = Draft()
                _messages.tryEmit("Sent")
                onSent()
            }.onFailure { e -> _draft.update { it.copy(sending = false, error = e.message) } }
        }
    }

    fun onAccountAdded(id: String) {
        _activeId.value = id
        _list.value = ListState(loading = true)
        reloadAll()
    }

    fun removeAccount(id: String) {
        repo.disconnect(id)
        mplane.accounts.remove(id)
        _unread.update { it - id }
        if (_activeId.value == id) {
            _activeId.value = accounts.value.firstOrNull()?.id
            _list.value = ListState()
            reloadAll()
        }
    }

    private fun quote(m: MessageSummary, b: MessageBody?): String {
        val body = b?.text ?: app.mailplane.core.Snippets.of(null, b?.html, Int.MAX_VALUE)
        return "On ${formatFull(m)}, ${m.fromName} wrote:\n" + body.lines().joinToString("\n") { "> $it" }
    }

    private fun formatFull(m: MessageSummary) =
        m.date?.let { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date.from(it)) } ?: ""
}
