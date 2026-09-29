package app.mailplane.core

import com.sun.mail.imap.IMAPFolder
import com.sun.mail.imap.IMAPStore
import java.io.Closeable
import javax.mail.FetchProfile
import javax.mail.Flags
import javax.mail.Folder
import javax.mail.Message
import javax.mail.MessagingException
import javax.mail.UIDFolder
import javax.mail.internet.InternetAddress
import javax.mail.search.BodyTerm
import javax.mail.search.FlagTerm
import javax.mail.search.FromStringTerm
import javax.mail.search.HeaderTerm
import javax.mail.internet.MimeMessage
import javax.mail.search.OrTerm
import javax.mail.search.SubjectTerm

/**
 * One IMAP connection for one account. All calls are blocking and synchronised —
 * run them off the main thread (the app wraps them in Dispatchers.IO).
 * The connection is opened lazily and re-opened when the server drops it.
 */
class ImapMailClient(
    private val account: Account,
    private val password: String,
) : Closeable {

    private var store: IMAPStore? = null
    private var folderCache: List<MailFolder>? = null

    @Synchronized
    fun connect(): IMAPStore {
        store?.takeIf { it.isConnected }?.let { return it }
        val (session, protocol) = MailSessions.imap(account.imap)
        val s = session.getStore(protocol) as IMAPStore
        try {
            s.connect(account.imap.host, account.imap.port, account.username, password)
        } catch (e: MessagingException) {
            throw MailException(friendlyError(e), e)
        }
        store = s
        return s
    }

    /** Opens and immediately closes a connection — for the account setup screen. */
    fun verify() { connect(); close() }

    @Synchronized
    fun listFolders(withUnreadCounts: Boolean = true): List<MailFolder> {
        val s = connect()
        val folders = s.defaultFolder.list("*")
            .filter { (it.type and Folder.HOLDS_MESSAGES) != 0 }
            .map { f ->
                val attrs = (f as? IMAPFolder)?.attributes?.map { it.lowercase() }?.toSet() ?: emptySet()
                if ("\\noselect" in attrs || "\\nonexistent" in attrs) return@map null
                val role = roleOf(f.fullName, f.name, attrs)
                val unread = if (withUnreadCounts) runCatching { f.unreadMessageCount }.getOrDefault(0) else 0
                MailFolder(f.fullName, displayName(f.fullName, f.name), role, unread.coerceAtLeast(0))
            }
            .filterNotNull()
            .sortedWith(compareBy<MailFolder>({ it.role?.ordinal ?: Int.MAX_VALUE }, { it.name.lowercase() }))
        folderCache = folders
        return folders
    }

    /** Page of messages, newest first. [offset] counts from the newest message. */
    @Synchronized
    fun fetchMessages(folderPath: String, limit: Int = 50, offset: Int = 0): MessagePage =
        withFolder(folderPath, Folder.READ_ONLY) { folder ->
            val total = folder.messageCount
            val unread = folder.unreadMessageCount.coerceAtLeast(0)
            if (total == 0 || offset >= total) return@withFolder MessagePage(emptyList(), total, unread)
            val end = total - offset
            val start = (end - limit + 1).coerceAtLeast(1)
            val msgs = folder.getMessages(start, end)
            folder.fetch(msgs, FetchProfile().apply {
                add(FetchProfile.Item.ENVELOPE)
                add(FetchProfile.Item.FLAGS)
                add(FetchProfile.Item.CONTENT_INFO)
                add(UIDFolder.FetchProfileItem.UID)
            })
            MessagePage(msgs.reversed().map { summarize(folder, it) }, total, unread)
        }

    /** Full body. Uses PEEK, so the message is not marked as read. */
    @Synchronized
    fun fetchBody(folderPath: String, uid: Long): MessageBody = withFolder(folderPath, Folder.READ_ONLY) { folder ->
        val msg = folder.getMessageByUID(uid) ?: throw MailException("Message no longer exists")
        MimeParser.parse(msg)
    }

    @Synchronized
    fun fetchAttachment(folderPath: String, uid: Long, index: Int): ByteArray =
        withFolder(folderPath, Folder.READ_ONLY) { folder ->
            val msg = folder.getMessageByUID(uid) ?: throw MailException("Message no longer exists")
            MimeParser.attachmentBytes(msg, index) ?: throw MailException("Attachment not found")
        }

    @Synchronized
    fun setSeen(folderPath: String, uid: Long, seen: Boolean) = setFlag(folderPath, uid, Flags.Flag.SEEN, seen)

    @Synchronized
    fun setFlagged(folderPath: String, uid: Long, flagged: Boolean) = setFlag(folderPath, uid, Flags.Flag.FLAGGED, flagged)

    /** Moves to Trash; deletes permanently only when already in Trash (or there is no Trash). */
    @Synchronized
    fun delete(folderPath: String, uid: Long) {
        val trash = folderFor(FolderRole.TRASH)
        if (trash != null && trash.path != folderPath) move(folderPath, uid, trash.path)
        else expungeOne(folderPath, uid)
    }

    @Synchronized
    fun archive(folderPath: String, uid: Long) {
        val archive = folderFor(FolderRole.ARCHIVE) ?: throw MailException("No archive folder on this server")
        if (archive.path == folderPath) throw MailException("Message is already archived")
        move(folderPath, uid, archive.path)
    }

    @Synchronized
    fun move(folderPath: String, uid: Long, destination: String) {
        withFolder(folderPath, Folder.READ_WRITE) { folder ->
            val msg = folder.getMessageByUID(uid) ?: throw MailException("Message no longer exists")
            val dest = connect().getFolder(destination)
            if (connect().hasCapability("MOVE")) {
                folder.moveMessages(arrayOf(msg), dest)
            } else {
                folder.copyMessages(arrayOf(msg), dest)
                msg.setFlag(Flags.Flag.DELETED, true)
                expunge(folder, msg)
            }
        }
    }

    @Synchronized
    fun search(folderPath: String, query: String, limit: Int = 50): List<MessageSummary> =
        withFolder(folderPath, Folder.READ_ONLY) { folder ->
            val term = OrTerm(arrayOf(SubjectTerm(query), FromStringTerm(query), BodyTerm(query)))
            val hits = folder.search(term).takeLast(limit).toTypedArray()
            folder.fetch(hits, FetchProfile().apply {
                add(FetchProfile.Item.ENVELOPE)
                add(FetchProfile.Item.FLAGS)
                add(FetchProfile.Item.CONTENT_INFO)
                add(UIDFolder.FetchProfileItem.UID)
            })
            hits.reversed().map { summarize(folder, it) }
        }

    /**
     * Starred (flagged) mail from every folder except Trash, Spam and Drafts,
     * newest first. Powers the "Starred" smart folder.
     */
    @Synchronized
    fun flagged(limit: Int = 200): List<MessageSummary> {
        val folders = (folderCache ?: listFolders(withUnreadCounts = false))
            .filter { it.role != FolderRole.TRASH && it.role != FolderRole.SPAM && it.role != FolderRole.DRAFTS }
            .take(25)
        val out = mutableListOf<MessageSummary>()
        for (f in folders) {
            runCatching {
                withFolder(f.path, Folder.READ_ONLY) { folder ->
                    val hits = folder.search(FlagTerm(Flags(Flags.Flag.FLAGGED), true)).takeLast(limit).toTypedArray()
                    folder.fetch(hits, FetchProfile().apply {
                        add(FetchProfile.Item.ENVELOPE)
                        add(FetchProfile.Item.FLAGS)
                        add(FetchProfile.Item.CONTENT_INFO)
                        add(UIDFolder.FetchProfileItem.UID)
                    })
                    hits.forEach { out += summarize(folder, it) }
                }
            }
        }
        return out.sortedByDescending { it.date }.take(limit)
    }

    /**
     * Searches every folder except Trash and Spam (subject, sender, body), newest
     * first — "search all folders". At most [perFolder] hits per folder.
     */
    @Synchronized
    fun searchAll(query: String, perFolder: Int = 30, limit: Int = 100): List<MessageSummary> {
        val folders = (folderCache ?: listFolders(withUnreadCounts = false))
            .filter { it.role != FolderRole.TRASH && it.role != FolderRole.SPAM }
            .take(30)
        val out = mutableListOf<MessageSummary>()
        for (f in folders) runCatching { out += search(f.path, query, perFolder) }
        return out.sortedByDescending { it.date }.take(limit)
    }

    // ── Drafts ───────────────────────────────────────────────────────────────

    /**
     * Saves [message] into the Drafts folder (created if the server has none),
     * then removes the previous copy [replace]. Returns where the new copy is.
     */
    @Synchronized
    fun saveDraft(message: MimeMessage, replace: DraftRef? = null): DraftRef {
        val path = replace?.folder ?: folderFor(FolderRole.DRAFTS)?.path ?: ensureFolder("Drafts")
        message.setFlag(Flags.Flag.DRAFT, true)
        message.setFlag(Flags.Flag.SEEN, true)
        if (message.messageID == null) message.saveChanges()
        val messageId = message.messageID
        val uid = withFolder(path, Folder.READ_WRITE) { folder ->
            val appended = folder.appendUIDMessages(arrayOf(message)).firstOrNull()?.uid
            val uid = appended ?: messageId?.let { id ->
                folder.search(HeaderTerm("Message-ID", id)).lastOrNull()?.let { folder.getUID(it) }
            }
            if (replace?.uid != null && replace.uid != uid) {
                folder.getMessageByUID(replace.uid)?.let { old ->
                    old.setFlag(Flags.Flag.DELETED, true)
                    expunge(folder, old)
                }
            }
            uid
        }
        return DraftRef(path, uid)
    }

    /** Removes a saved draft for good (sent or discarded). Missing drafts are ignored. */
    @Synchronized
    fun deleteDraft(ref: DraftRef) {
        val uid = ref.uid ?: return
        withFolder(ref.folder, Folder.READ_WRITE) { folder ->
            folder.getMessageByUID(uid)?.let { msg ->
                msg.setFlag(Flags.Flag.DELETED, true)
                expunge(folder, msg)
            }
        }
    }

    // ── Snooze ───────────────────────────────────────────────────────────────

    /** Moves the message into "Snoozed" (created on first use). UIDs change on move, so it is tracked by Message-ID. */
    @Synchronized
    fun snooze(folderPath: String, uid: Long): SnoozedRef {
        val snoozed = (folderCache ?: listFolders(withUnreadCounts = false))
            .firstOrNull { it.name.equals("Snoozed", ignoreCase = true) }?.path ?: ensureFolder("Snoozed")
        val messageId = withFolder(folderPath, Folder.READ_ONLY) { folder ->
            (folder.getMessageByUID(uid) ?: throw MailException("Message no longer exists")).getHeader("Message-ID")?.firstOrNull()
        } ?: throw MailException("This message can't be snoozed")
        move(folderPath, uid, snoozed)
        return SnoozedRef(snoozed, messageId)
    }

    /** Brings a snoozed message back to [destination], unread. False when it is gone (moved by hand). */
    @Synchronized
    fun unsnooze(ref: SnoozedRef, destination: String = "INBOX"): Boolean {
        val uids = withFolder(ref.folder, Folder.READ_WRITE) { folder ->
            folder.search(HeaderTerm("Message-ID", ref.messageId)).map { msg ->
                msg.setFlag(Flags.Flag.SEEN, false)
                folder.getUID(msg)
            }
        }
        if (uids.isEmpty()) return false
        uids.forEach { move(ref.folder, it, destination) }
        return true
    }

    /** Creates a top-level folder and returns its path. */
    @Synchronized
    fun ensureFolder(name: String): String {
        val s = connect()
        val f = s.getFolder(name)
        if (!f.exists() && !f.create(Folder.HOLDS_MESSAGES)) throw MailException("Couldn't create the folder \"$name\"")
        folderCache = null
        return f.fullName
    }

    /** Mailbox storage from IMAP QUOTA, or null when the server doesn't report it. */
    @Synchronized
    fun quota(): StorageQuota? = runCatching {
        val s = connect()
        if (!s.hasCapability("QUOTA")) return@runCatching null
        s.getQuota("INBOX").flatMap { it.resources?.toList().orEmpty() }
            .firstOrNull { it.name.equals("STORAGE", ignoreCase = true) && it.limit > 0 }
            ?.let { StorageQuota(usedKb = it.usage, limitKb = it.limit) }
    }.getOrNull()

    /** Highest UID in the folder — used by background sync to detect new mail. */
    @Synchronized
    fun latestUid(folderPath: String): Long = withFolder(folderPath, Folder.READ_ONLY) { folder ->
        val count = folder.messageCount
        if (count == 0) 0L else folder.getUID(folder.getMessage(count))
    }

    @Synchronized
    override fun close() {
        runCatching { store?.close() }
        store = null
    }

    // ── internals ────────────────────────────────────────────────────────────

    private fun <T> withFolder(path: String, mode: Int, block: (IMAPFolder) -> T): T {
        return try {
            runOnFolder(path, mode, block)
        } catch (e: javax.mail.StoreClosedException) {
            // Connection dropped (sleep, network change) — reconnect once and retry
            store = null
            runOnFolder(path, mode, block)
        } catch (e: javax.mail.FolderClosedException) {
            store = null
            runOnFolder(path, mode, block)
        } catch (e: MessagingException) {
            throw MailException(friendlyError(e), e)
        }
    }

    private fun <T> runOnFolder(path: String, mode: Int, block: (IMAPFolder) -> T): T {
        val folder = connect().getFolder(path) as IMAPFolder
        if (!folder.exists()) throw MailException("Folder \"$path\" doesn't exist")
        folder.open(mode)
        try {
            return block(folder)
        } finally {
            runCatching { if (folder.isOpen) folder.close(false) }
        }
    }

    private fun setFlag(folderPath: String, uid: Long, flag: Flags.Flag, value: Boolean) {
        withFolder(folderPath, Folder.READ_WRITE) { folder ->
            val msg = folder.getMessageByUID(uid) ?: throw MailException("Message no longer exists")
            msg.setFlag(flag, value)
        }
    }

    private fun expungeOne(folderPath: String, uid: Long) {
        withFolder(folderPath, Folder.READ_WRITE) { folder ->
            val msg = folder.getMessageByUID(uid) ?: throw MailException("Message no longer exists")
            msg.setFlag(Flags.Flag.DELETED, true)
            expunge(folder, msg)
        }
    }

    /** Expunges just [msg] when the server supports UIDPLUS, otherwise the whole folder. */
    private fun expunge(folder: IMAPFolder, msg: Message) {
        if (connect().hasCapability("UIDPLUS")) folder.expunge(arrayOf(msg)) else folder.expunge()
    }

    private fun folderFor(role: FolderRole): MailFolder? =
        (folderCache ?: listFolders(withUnreadCounts = false)).firstOrNull { it.role == role }

    private fun summarize(folder: UIDFolder, m: Message): MessageSummary {
        val from = m.from?.firstOrNull() as? InternetAddress
        return MessageSummary(
            uid = folder.getUID(m),
            folder = (folder as Folder).fullName,
            fromName = from?.personal?.takeIf { it.isNotBlank() } ?: from?.address ?: "Unknown",
            fromEmail = from?.address ?: "",
            to = m.getRecipients(Message.RecipientType.TO)?.joinToString(", ") { (it as? InternetAddress)?.address ?: it.toString() } ?: "",
            subject = m.subject?.takeIf { it.isNotBlank() } ?: "(no subject)",
            date = (m.receivedDate ?: m.sentDate)?.toInstant(),
            seen = m.isSet(Flags.Flag.SEEN),
            flagged = m.isSet(Flags.Flag.FLAGGED),
            hasAttachments = m.isMimeType("multipart/mixed"),
            accountId = account.id,
        )
    }

    companion object {
        private val ROLE_BY_NAME = mapOf(
            "inbox" to FolderRole.INBOX,
            "sent" to FolderRole.SENT, "sent mail" to FolderRole.SENT, "sent items" to FolderRole.SENT,
            "sent messages" to FolderRole.SENT, "gesendet" to FolderRole.SENT, "gesendete objekte" to FolderRole.SENT,
            "drafts" to FolderRole.DRAFTS, "draft" to FolderRole.DRAFTS, "entwürfe" to FolderRole.DRAFTS,
            "trash" to FolderRole.TRASH, "deleted items" to FolderRole.TRASH, "deleted messages" to FolderRole.TRASH,
            "bin" to FolderRole.TRASH, "papierkorb" to FolderRole.TRASH, "gelöschte elemente" to FolderRole.TRASH,
            "spam" to FolderRole.SPAM, "junk" to FolderRole.SPAM, "junk email" to FolderRole.SPAM, "junk e-mail" to FolderRole.SPAM,
            "archive" to FolderRole.ARCHIVE, "archives" to FolderRole.ARCHIVE, "all mail" to FolderRole.ARCHIVE, "archiv" to FolderRole.ARCHIVE,
        )

        internal fun roleOf(fullName: String, name: String, attrs: Set<String>): FolderRole? = when {
            fullName.equals("INBOX", ignoreCase = true) -> FolderRole.INBOX
            "\\sent" in attrs -> FolderRole.SENT
            "\\drafts" in attrs -> FolderRole.DRAFTS
            "\\trash" in attrs -> FolderRole.TRASH
            "\\junk" in attrs -> FolderRole.SPAM
            "\\archive" in attrs || "\\all" in attrs -> FolderRole.ARCHIVE
            else -> ROLE_BY_NAME[name.lowercase()]
        }

        internal fun displayName(fullName: String, name: String): String =
            if (fullName.equals("INBOX", ignoreCase = true)) "Inbox" else name

        internal fun friendlyError(e: Exception): String {
            val msg = (e.message ?: "").lowercase()
            val cause = generateSequence(e.cause) { it.cause }.joinToString(" ") { (it.message ?: "") + it.javaClass.simpleName }.lowercase()
            return when {
                "authenticat" in msg || "login" in msg || "credentials" in msg || "password" in msg ->
                    "Wrong e-mail or password. Gmail, iCloud and Yahoo need an app password."
                "unknownhost" in cause || "unknown host" in msg -> "Server not found — check the server address."
                "timed out" in msg || "timeout" in cause -> "The server didn't respond. Check your connection."
                "refused" in cause || "refused" in msg -> "Connection refused — check the port and security settings."
                "ssl" in cause || "certificate" in cause || "handshake" in cause -> "Secure connection failed — check the security setting."
                else -> e.message ?: "Mail server error"
            }
        }
    }
}
