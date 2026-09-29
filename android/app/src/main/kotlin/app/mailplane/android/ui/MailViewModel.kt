package app.mailplane.android.ui

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.mailplane.android.MailplaneApplication
import app.mailplane.android.data.AI_KEY_ID
import app.mailplane.android.data.AiSettings
import app.mailplane.android.sync.UnsnoozeWorker
import app.mailplane.core.Account
import app.mailplane.core.AiClient
import app.mailplane.core.AttachmentInfo
import app.mailplane.core.DraftRef
import app.mailplane.core.FolderRole
import app.mailplane.core.MailFolder
import app.mailplane.core.MessageBody
import app.mailplane.core.MessagePage
import app.mailplane.core.MessageSummary
import app.mailplane.core.OutgoingAttachment
import app.mailplane.core.OutgoingMessage
import app.mailplane.core.Snippets
import app.mailplane.core.Subjects
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.text.DateFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Date

/** Path of the "Starred" smart folder (flagged mail from every folder). */
const val STARRED = "__starred__"
/** Account id of the unified inbox (every account's inbox in one list). */
const val ALL_ACCOUNTS = "__all__"

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
    /** Search every folder instead of just the open one. */
    val searchAllFolders: Boolean = false,
    /** Every account's inbox in one list. */
    val unified: Boolean = false,
) {
    val folder: MailFolder? get() = folders.firstOrNull { it.path == folderPath }
    val isStarred: Boolean get() = folderPath == STARRED
    val isDrafts: Boolean get() = folder?.role == FolderRole.DRAFTS
    val title: String get() = when {
        unified -> tr("All inboxes")
        isStarred -> tr("Starred")
        else -> folder?.let { I18n.folderName(it) } ?: tr("Inbox")
    }
    val canLoadMore: Boolean get() = !searching && !isStarred && !unified && messages.size < total
}

data class ReaderState(
    val summary: MessageSummary? = null,
    val body: MessageBody? = null,
    val loading: Boolean = false,
    val error: String? = null,
    val imagesAllowed: Boolean = false,
    /** Other messages of the same conversation in the loaded list, oldest first. */
    val thread: List<MessageSummary> = emptyList(),
    /** AI summary of this message, once asked for. */
    val aiSummary: String? = null,
    val aiBusy: Boolean = false,
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
    val attachments: List<OutgoingAttachment> = emptyList(),
    val sending: Boolean = false,
    val error: String? = null,
    val title: String = "New message",
    /** Server copy in the Drafts folder ([savedAccountId] owns it). */
    val saved: DraftRef? = null,
    val savedAccountId: String? = null,
    /** "Saving…" / "Saved" / "Not saved" in the compose footer. */
    val saveState: String? = null,
    val aiBusy: Boolean = false,
    /** What the original message said — for AI reply drafts. */
    val sourceFrom: String? = null,
    val sourceText: String? = null,
) {
    val hasContent: Boolean get() = to.isNotBlank() || cc.isNotBlank() || bcc.isNotBlank() || subject.isNotBlank() ||
        body.isNotBlank() || attachments.isNotEmpty()
}

class MailViewModel(app: Application) : AndroidViewModel(app) {
    private val mplane = app as MailplaneApplication
    private val repo = mplane.mail
    val accounts: StateFlow<List<Account>> = mplane.accounts.accounts
    val settings = mplane.settings
    val updater = mplane.updater

    private val _activeId = MutableStateFlow(accounts.value.firstOrNull()?.id)
    /** An account id, or [ALL_ACCOUNTS] for the unified inbox. */
    val activeAccountId: StateFlow<String?> = _activeId

    private val _list = MutableStateFlow(ListState())
    val list: StateFlow<ListState> = _list

    private val _reader = MutableStateFlow(ReaderState())
    val reader: StateFlow<ReaderState> = _reader

    private val _draft = MutableStateFlow(Draft())
    val draft: StateFlow<Draft> = _draft

    private val _quota = MutableStateFlow<app.mailplane.core.StorageQuota?>(null)
    /** Storage of the active mailbox (null when the server doesn't report it). */
    val quota: StateFlow<app.mailplane.core.StorageQuota?> = _quota

    private val _unread = MutableStateFlow<Map<String, Int>>(emptyMap())
    /** Inbox unread per account, for the account pills. */
    val unread: StateFlow<Map<String, Int>> = _unread

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    /** One-off messages for the snackbar (already translated). */
    val messages: SharedFlow<String> = _messages

    private var loadJob: Job? = null
    private var draftJob: Job? = null
    /** Bumped on every edit; the autosave only writes when it moved on. */
    private var draftVersion = 0
    private var savedVersion = 0

    val isUnified: Boolean get() = _activeId.value == ALL_ACCOUNTS
    /** The open account — the first one while the unified inbox is shown. */
    val activeAccount: Account? get() = accounts.value.firstOrNull { it.id == _activeId.value } ?: accounts.value.firstOrNull()
    private fun accountOf(m: MessageSummary): Account? = accounts.value.firstOrNull { it.id == m.accountId } ?: activeAccount
    private fun say(text: String) { _messages.tryEmit(tr(text)) }

    init {
        reloadAll()
        viewModelScope.launch { updater.check() }   // at most once a day
    }

    fun checkForUpdate() = viewModelScope.launch { updater.check(force = true) }
    fun installUpdate(release: app.mailplane.android.data.AppRelease) = viewModelScope.launch { updater.install(release) }

    fun reloadAll() {
        if (isUnified) { loadMessages(reset = true); return }
        val acc = activeAccount ?: return
        _activeId.value = acc.id
        loadFolders(acc)
        loadQuota(acc)
        loadMessages(reset = true)
    }

    fun switchAccount(id: String) {
        if (id == _activeId.value) return
        _activeId.value = id
        _list.value = ListState(loading = true, unified = id == ALL_ACCOUNTS)
        if (id == ALL_ACCOUNTS) {
            _quota.value = null
            accounts.value.forEach { loadFolders(it, apply = false) }
        } else activeAccount?.let { loadFolders(it); loadQuota(it) }
        loadMessages(reset = true)
    }

    fun openFolder(path: String) {
        if (isUnified) {
            // Folders belong to one account: leave the unified inbox for the first one
            _activeId.value = accounts.value.firstOrNull()?.id
            _list.update { it.copy(unified = false) }
            activeAccount?.let { loadFolders(it); loadQuota(it) }
        }
        _list.update { it.copy(folderPath = path, messages = emptyList(), total = 0, query = "", searching = false, unified = false) }
        loadMessages(reset = true)
    }

    fun refresh() {
        if (isUnified) accounts.value.forEach { loadFolders(it, apply = false) } else activeAccount?.let { loadFolders(it) }
        loadMessages(reset = true, pull = true)
    }

    private fun loadQuota(acc: Account) = viewModelScope.launch {
        _quota.value = null
        val q = runCatching { repo.quota(acc) }.getOrNull()
        if (_activeId.value == acc.id) _quota.value = q
    }

    private fun loadFolders(acc: Account, apply: Boolean = true) = viewModelScope.launch {
        runCatching { repo.folders(acc) }
            .onSuccess { folders ->
                if (apply && _activeId.value == acc.id) _list.update { st ->
                    val path = if (st.folderPath == STARRED || folders.any { it.path == st.folderPath }) st.folderPath
                    else folders.firstOrNull { it.role == FolderRole.INBOX }?.path ?: "INBOX"
                    st.copy(folders = folders, folderPath = path)
                }
                folders.firstOrNull { it.role == FolderRole.INBOX }?.let { inbox ->
                    _unread.update { it + (acc.id to inbox.unread) }
                }
            }
    }

    fun loadMessages(reset: Boolean = false, pull: Boolean = false) {
        val st = _list.value
        if (!reset && (st.loadingMore || !st.canLoadMore)) return
        loadJob?.cancel()
        val unified = isUnified
        val acc = if (unified) null else activeAccount ?: return
        val folder = st.folderPath
        val active = _activeId.value
        _list.update {
            it.copy(loading = reset && !pull && it.messages.isEmpty(), refreshing = pull, loadingMore = !reset, error = null, unified = unified)
        }
        loadJob = viewModelScope.launch {
            val offset = if (reset) 0 else _list.value.messages.size
            runCatching {
                when {
                    unified -> unifiedInbox()
                    folder == STARRED -> repo.starred(acc!!).let { MessagePage(it, it.size, it.count { m -> !m.seen }) }
                    else -> repo.messages(acc!!, folder, offset)
                }
            }
                .onSuccess { page ->
                    if (_activeId.value != active || (!unified && _list.value.folderPath != folder)) return@onSuccess
                    _list.update {
                        val merged = if (reset) page.messages else (it.messages + page.messages).distinctBy { m -> Triple(m.accountId, m.folder, m.uid) }
                        it.copy(messages = merged, total = page.total, loading = false, refreshing = false, loadingMore = false)
                    }
                    if (!unified && _list.value.folder?.role == FolderRole.INBOX) _unread.update { it + (acc!!.id to page.unread) }
                }
                .onFailure { e ->
                    _list.update { it.copy(loading = false, refreshing = false, loadingMore = false, error = e.message) }
                }
        }
    }

    /** Newest inbox mail of every account, merged by date; accounts that fail are skipped. */
    private suspend fun unifiedInbox(): MessagePage = withContext(Dispatchers.IO) {
        val pages = accounts.value.map { acc -> async { acc to runCatching { repo.messages(acc, "INBOX", 0, 30) }.getOrNull() } }.awaitAll()
        pages.forEach { (acc, page) -> page?.let { p -> _unread.update { it + (acc.id to p.unread) } } }
        if (pages.all { it.second == null } && pages.isNotEmpty()) throw IllegalStateException(tr("Couldn’t load mail"))
        val all = pages.flatMap { it.second?.messages.orEmpty() }.sortedByDescending { it.date }
        MessagePage(all, all.size, pages.sumOf { it.second?.unread ?: 0 })
    }

    fun search(query: String) {
        _list.update { it.copy(query = query) }
        if (query.isBlank()) { _list.update { it.copy(searching = false) }; loadMessages(reset = true); return }
        loadJob?.cancel()
        val st = _list.value
        val folder = st.folderPath.let { if (it == STARRED) "INBOX" else it }
        val targets = if (isUnified) accounts.value else listOfNotNull(activeAccount)
        _list.update { it.copy(searching = true, loading = true, error = null) }
        loadJob = viewModelScope.launch {
            delay(350) // debounce typing
            runCatching {
                targets.map { acc ->
                    async {
                        if (st.searchAllFolders) repo.searchAll(acc, query.trim())
                        else repo.search(acc, if (isUnified) "INBOX" else folder, query.trim())
                    }
                }.awaitAll().flatten().sortedByDescending { it.date }
            }
                .onSuccess { hits ->
                    _list.update { it.copy(messages = hits, total = hits.size, loading = false) }
                    if (query.trim().length >= 2) settings.rememberSearch(query.trim())
                }
                .onFailure { e -> _list.update { it.copy(loading = false, error = e.message) } }
        }
    }

    fun setSearchAllFolders(on: Boolean) {
        _list.update { it.copy(searchAllFolders = on) }
        if (_list.value.query.isNotBlank()) search(_list.value.query)
    }

    // ── Reading ─────────────────────────────────────────────────────────────

    /** Drafts open in the composer instead of the reader. */
    fun isDraft(m: MessageSummary): Boolean = _list.value.isDrafts && m.folder == _list.value.folderPath

    fun open(m: MessageSummary) {
        val acc = accountOf(m) ?: return
        val norm = Subjects.base(m.subject).lowercase()
        val thread = if (norm.isBlank()) emptyList() else _list.value.messages
            .filter { it != m && it.accountId == m.accountId && Subjects.base(it.subject).lowercase() == norm }
            .sortedBy { it.date }
        _reader.value = ReaderState(summary = m, loading = true, imagesAllowed = !settings.blockImages.value, thread = thread)
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
        if (m.folder == "INBOX" || _list.value.folder?.role == FolderRole.INBOX) {
            _unread.update { u -> u + (acc.id to ((u[acc.id] ?: 0) + if (seen) -1 else 1).coerceAtLeast(0)) }
        }
        if (!quiet) say(if (seen) "Marked as read" else "Marked as unread")
    }

    fun toggleFlag(m: MessageSummary) {
        if (m.flagged && _list.value.isStarred) {
            remove(m, "Removed from Starred") { acc -> repo.setFlagged(acc, m, false) }
            return
        }
        mutate(m, { it.copy(flagged = !m.flagged) }) { acc -> repo.setFlagged(acc, m, !m.flagged) }
    }

    fun delete(m: MessageSummary) = remove(m, "Moved to Trash") { acc -> repo.delete(acc, m) }
    fun archive(m: MessageSummary) = remove(m, "Archived") { acc -> repo.archive(acc, m) }

    /** Moves the message to the server's "Snoozed" folder; it comes back unread at [until]. */
    fun snooze(m: MessageSummary, until: Instant) {
        val label = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault()).format(until)
        remove(m, "Snoozed until $label") { acc ->
            val ref = repo.snooze(acc, m)
            UnsnoozeWorker.schedule(getApplication(), acc.id, ref, returnTo = m.folder, until = until, subject = m.subject, from = m.fromName)
        }
    }

    /** Optimistically updates the list and reader, rolls back if the server call fails. */
    private fun mutate(m: MessageSummary, change: (MessageSummary) -> MessageSummary, call: suspend (Account) -> Unit) {
        val acc = accountOf(m) ?: return
        val updated = change(m)
        fun same(a: MessageSummary, b: MessageSummary) = a.uid == b.uid && a.folder == b.folder && a.accountId == b.accountId
        fun apply(v: MessageSummary) {
            _list.update { st -> st.copy(messages = st.messages.map { if (same(it, v)) v else it }) }
            _reader.update { r -> if (r.summary?.let { same(it, v) } == true) r.copy(summary = v) else r }
        }
        apply(updated)
        viewModelScope.launch {
            runCatching { call(acc) }.onFailure { e -> apply(m); _messages.tryEmit(tr(e.message ?: "Something went wrong")) }
        }
    }

    private fun remove(m: MessageSummary, done: String, call: suspend (Account) -> Unit) {
        val acc = accountOf(m) ?: return
        fun same(a: MessageSummary) = a.uid == m.uid && a.folder == m.folder && a.accountId == m.accountId
        _list.update { st -> st.copy(messages = st.messages.filterNot(::same), total = (st.total - 1).coerceAtLeast(0)) }
        viewModelScope.launch {
            runCatching { call(acc) }
                .onSuccess { say(done) }
                .onFailure { e ->
                    // Put just this message back (other changes since then stay)
                    _list.update { st ->
                        if (st.messages.any(::same)) st
                        else st.copy(messages = (st.messages + m).sortedByDescending { it.date }, total = st.total + 1)
                    }
                    _messages.tryEmit(tr(e.message ?: "Something went wrong"))
                }
        }
    }

    /** Downloads an attachment into the cache and returns a VIEW intent for it. */
    suspend fun attachmentIntent(att: AttachmentInfo): Intent? {
        val m = _reader.value.summary ?: return null
        val acc = accountOf(m) ?: return null
        return runCatching {
            val bytes = repo.attachment(acc, m, att.index)
            val dir = File(getApplication<Application>().cacheDir, "attachments").apply { mkdirs() }
            val safe = att.fileName.replace(Regex("[/\\\\:*?\"<>|]"), "_")
            val file = File(dir, safe).apply { writeBytes(bytes) }
            val ctx = getApplication<Application>()
            val uri: Uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", file)
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, att.mimeType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }.onFailure { _messages.tryEmit(tr("Download failed: ${it.message}")) }.getOrNull()
    }

    // ── Composing ───────────────────────────────────────────────────────────

    private fun startDraft(d: Draft) {
        draftJob?.cancel()
        draftVersion = 0
        savedVersion = 0
        _draft.value = d
    }

    fun newDraft(to: String = "", cc: String = "", subject: String = "", body: String = "") {
        startDraft(Draft(accountId = if (isUnified) accounts.value.firstOrNull()?.id else activeAccount?.id,
            to = to, cc = cc, subject = subject, body = body))
    }

    fun reply(all: Boolean) {
        val m = _reader.value.summary ?: return
        val acc = accountOf(m) ?: return
        val b = _reader.value.body
        val me = acc.email.lowercase()
        val seen = mutableSetOf(me)
        fun uniq(list: List<String>) = list.filter { it.isNotBlank() && seen.add(it.lowercase()) }
        val from = b?.from?.email ?: m.fromEmail
        val to = uniq(listOf(from) + if (all) b?.to.orEmpty().map { it.email } else emptyList())
        val cc = if (all) uniq(b?.cc.orEmpty().map { it.email }) else emptyList()
        startDraft(Draft(
            accountId = acc.id, to = to.joinToString(", "), cc = cc.joinToString(", "),
            subject = Subjects.reply(m.subject), quoted = quote(m, b),
            inReplyTo = b?.messageId, references = listOfNotNull(b?.references, b?.messageId).joinToString(" ").ifBlank { null },
            title = if (all) "Reply all" else "Reply",
            sourceFrom = m.fromName, sourceText = b?.text ?: Snippets.of(null, b?.html, Int.MAX_VALUE),
        ))
    }

    fun forward() {
        val m = _reader.value.summary ?: return
        val b = _reader.value.body
        startDraft(Draft(
            accountId = accountOf(m)?.id, subject = Subjects.forward(m.subject), title = "Forward",
            quoted = "---------- Forwarded message ----------\nFrom: ${m.fromName} <${m.fromEmail}>\n" +
                "Date: ${formatFull(m)}\nSubject: ${m.subject}\n\n${b?.text ?: Snippets.of(null, b?.html, Int.MAX_VALUE)}",
        ))
    }

    /** A message from the Drafts folder, back in the composer (keeps its server copy until the next save). */
    fun openDraft(m: MessageSummary, onReady: () -> Unit) {
        val acc = accountOf(m) ?: return
        viewModelScope.launch {
            runCatching { repo.body(acc, m) }
                .onSuccess { b ->
                    startDraft(Draft(
                        accountId = acc.id, to = b.to.joinToString(", ") { it.display }, cc = b.cc.joinToString(", ") { it.display },
                        subject = b.subject, body = b.text ?: Snippets.of(null, b.html, Int.MAX_VALUE), title = "Draft",
                        saved = DraftRef(m.folder, m.uid), savedAccountId = acc.id,
                    ))
                    onReady()
                }
                .onFailure { e -> _messages.tryEmit(tr(e.message ?: "Something went wrong")) }
        }
    }

    fun updateDraft(change: (Draft) -> Draft) {
        _draft.update(change)
        draftVersion++
        scheduleDraftSave()
    }

    fun addAttachments(uris: List<Uri>) {
        val ctx = getApplication<Application>()
        viewModelScope.launch {
            val added = withContext(Dispatchers.IO) {
                uris.mapNotNull { uri ->
                    runCatching {
                        var name = "attachment"
                        var size = -1L
                        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                            if (c.moveToFirst()) {
                                name = c.getString(0) ?: name
                                if (!c.isNull(1)) size = c.getLong(1)
                            }
                        }
                        if (size > MAX_ATTACHMENT) { say("Files over 20 MB can’t be attached"); return@runCatching null }
                        val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@runCatching null
                        if (bytes.size > MAX_ATTACHMENT) { say("Files over 20 MB can’t be attached"); return@runCatching null }
                        OutgoingAttachment(name, ctx.contentResolver.getType(uri) ?: "application/octet-stream", bytes)
                    }.getOrNull()
                }
            }
            if (added.isNotEmpty()) updateDraft { it.copy(attachments = it.attachments + added) }
        }
    }

    fun removeAttachment(index: Int) = updateDraft { d -> d.copy(attachments = d.attachments.filterIndexed { i, _ -> i != index }) }

    private fun scheduleDraftSave() {
        draftJob?.cancel()
        draftJob = viewModelScope.launch {
            delay(2500)
            saveDraftNow()
        }
    }

    /** Writes the draft to the server's Drafts folder when it changed since the last save. */
    private suspend fun saveDraftNow(): Boolean {
        val d = _draft.value
        if (!d.hasContent || d.sending || draftVersion == savedVersion) return false
        val acc = accounts.value.firstOrNull { it.id == d.accountId } ?: activeAccount ?: return false
        val version = draftVersion
        _draft.update { it.copy(saveState = "Saving…") }
        return runCatching {
            // Changed the sender: the old account's copy goes, the new one starts fresh
            val replace = d.saved?.takeIf { d.savedAccountId == acc.id }
            if (d.saved != null && d.savedAccountId != acc.id) {
                accounts.value.firstOrNull { it.id == d.savedAccountId }?.let { old -> runCatching { repo.deleteDraft(old, d.saved) } }
            }
            repo.saveDraft(acc, outgoing(d, acc), replace)
        }.fold(
            onSuccess = { ref ->
                savedVersion = version
                _draft.update { it.copy(saved = ref, savedAccountId = acc.id, saveState = "Saved") }
                true
            },
            onFailure = {
                _draft.update { it.copy(saveState = "Not saved") }
                false
            },
        )
    }

    /** Close the composer: whatever was written stays in Drafts. */
    fun closeDraft() {
        draftJob?.cancel()
        viewModelScope.launch {
            if (saveDraftNow()) {
                say("Saved to Drafts")
                if (_list.value.isDrafts) loadMessages(reset = true)
            }
        }
    }

    /** Throw the message away, including its saved copy. */
    fun discardDraft() {
        draftJob?.cancel()
        val d = _draft.value
        startDraft(Draft())
        val ref = d.saved ?: return
        val acc = accounts.value.firstOrNull { it.id == d.savedAccountId } ?: return
        viewModelScope.launch {
            runCatching { repo.deleteDraft(acc, ref) }
            _list.update { st -> st.copy(messages = st.messages.filterNot { it.folder == ref.folder && it.uid == ref.uid && it.accountId == acc.id }) }
            say("Draft discarded")
        }
    }

    fun send(onSent: () -> Unit) {
        val d = _draft.value
        val acc = accounts.value.firstOrNull { it.id == d.accountId } ?: activeAccount ?: return
        val invalid = app.mailplane.core.Addresses.firstInvalid(d.to) ?: app.mailplane.core.Addresses.firstInvalid(d.cc)
            ?: app.mailplane.core.Addresses.firstInvalid(d.bcc)
        if (d.to.isBlank()) { _draft.update { it.copy(error = tr("Add a recipient")) }; return }
        if (invalid != null) { _draft.update { it.copy(error = tr("Invalid address: $invalid")) }; return }
        draftJob?.cancel()
        _draft.update { it.copy(sending = true, error = null) }
        viewModelScope.launch {
            runCatching { repo.send(acc, outgoing(d, acc)) }
                .onSuccess {
                    // The message is out — its saved draft has done its job
                    val ref = d.saved
                    val owner = accounts.value.firstOrNull { it.id == d.savedAccountId }
                    if (ref != null && owner != null) runCatching { repo.deleteDraft(owner, ref) }
                    startDraft(Draft())
                    say("Sent")
                    onSent()
                    if (_list.value.isDrafts) loadMessages(reset = true)
                }
                .onFailure { e -> _draft.update { it.copy(sending = false, error = e.message) } }
        }
    }

    private fun outgoing(d: Draft, acc: Account): OutgoingMessage {
        val text = buildString {
            append(d.body.trimEnd())
            if (acc.signature.isNotBlank() && !d.body.contains(acc.signature.trim())) append("\n\n-- \n").append(acc.signature)
            if (d.quoted.isNotBlank()) append("\n\n").append(d.quoted)
        }
        return OutgoingMessage(to = d.to, cc = d.cc, bcc = d.bcc, subject = d.subject, text = text,
            inReplyTo = d.inReplyTo, references = d.references, attachments = d.attachments)
    }

    // ── AI (optional; nothing is sent until the user taps an AI button) ─────

    val ai: StateFlow<AiSettings> = settings.ai
    private fun aiConfig(): AiClient.Config? {
        val s = settings.ai.value
        if (!s.enabled) return null
        return AiClient.Config(s.provider, s.baseUrl, s.model, mplane.credentials.get(AI_KEY_ID))
    }
    fun hasAiKey(): Boolean = mplane.credentials.get(AI_KEY_ID) != null

    /** Saves the AI choice; [apiKey] null keeps the stored key, "" removes it. */
    fun saveAi(settings: AiSettings, apiKey: String?) {
        if (apiKey != null) {
            if (apiKey.isBlank()) mplane.credentials.remove(AI_KEY_ID) else mplane.credentials.put(AI_KEY_ID, apiKey.trim())
        }
        this.settings.setAi(settings)
    }

    suspend fun aiModels(provider: String, baseUrl: String, apiKey: String?): Result<List<String>> = withContext(Dispatchers.IO) {
        runCatching { AiClient.listModels(AiClient.Config(provider, baseUrl, "", apiKey?.ifBlank { null } ?: mplane.credentials.get(AI_KEY_ID))) }
    }

    private suspend fun runAi(task: AiClient.Task): Result<String> {
        val cfg = aiConfig() ?: return Result.failure(IllegalStateException(tr("AI is off")))
        return withContext(Dispatchers.IO) { runCatching { AiClient.complete(cfg, task) } }
    }

    fun summarize() {
        val r = _reader.value
        val m = r.summary ?: return
        val b = r.body ?: return
        _reader.update { it.copy(aiBusy = true) }
        viewModelScope.launch {
            runAi(AiClient.summarize(m.fromName, m.subject, b.text ?: Snippets.of(null, b.html, Int.MAX_VALUE)))
                .onSuccess { text -> if (_reader.value.summary == m) _reader.update { it.copy(aiSummary = text, aiBusy = false) } }
                .onFailure { e -> _reader.update { it.copy(aiBusy = false) }; _messages.tryEmit(tr(e.message ?: "Something went wrong")) }
        }
    }

    /** Writes a reply (when answering) or an email from [instruction] into the body. */
    fun aiWrite(instruction: String) {
        val d = _draft.value
        val acc = accounts.value.firstOrNull { it.id == d.accountId } ?: activeAccount
        val task = if (d.sourceText != null) AiClient.reply(acc?.name, d.sourceFrom, d.subject, d.sourceText, instruction)
        else if (instruction.isBlank()) { say("Write something first."); return }
        else AiClient.write(acc?.name, d.subject, instruction)
        aiApply(task)
    }

    /** Rewrites the body: improve / shorter / formal / friendly / fix. */
    fun aiRewrite(mode: String) {
        val body = _draft.value.body
        if (body.isBlank()) { say("Write something first."); return }
        aiApply(AiClient.rewrite(mode, body))
    }

    private fun aiApply(task: AiClient.Task) {
        _draft.update { it.copy(aiBusy = true) }
        viewModelScope.launch {
            runAi(task)
                .onSuccess { text -> _draft.update { it.copy(aiBusy = false) }; updateDraft { it.copy(body = text) } }
                .onFailure { e -> _draft.update { it.copy(aiBusy = false) }; _messages.tryEmit(tr(e.message ?: "Something went wrong")) }
        }
    }

    // ── Accounts ────────────────────────────────────────────────────────────

    fun onAccountAdded(id: String) {
        _activeId.value = id
        _list.value = ListState(loading = true)
        reloadAll()
    }

    fun removeAccount(id: String) {
        repo.disconnect(id)
        mplane.accounts.remove(id)
        _unread.update { it - id }
        if (_activeId.value == id || (isUnified && accounts.value.size < 2)) {
            _activeId.value = accounts.value.firstOrNull()?.id
            _list.value = ListState()
            reloadAll()
        }
    }

    private fun quote(m: MessageSummary, b: MessageBody?): String {
        val body = b?.text ?: Snippets.of(null, b?.html, Int.MAX_VALUE)
        return "On ${formatFull(m)}, ${m.fromName} wrote:\n" + body.lines().joinToString("\n") { "> $it" }
    }

    private fun formatFull(m: MessageSummary) =
        m.date?.let { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date.from(it)) } ?: ""

    private companion object {
        const val MAX_ATTACHMENT = 20L * 1024 * 1024
    }
}
