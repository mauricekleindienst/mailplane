package app.mailplane.android.data

import app.mailplane.core.Account
import app.mailplane.core.AutoConfig
import app.mailplane.core.DraftRef
import app.mailplane.core.SnoozedRef
import app.mailplane.core.ImapMailClient
import app.mailplane.core.MailException
import app.mailplane.core.MailFolder
import app.mailplane.core.MessageBody
import app.mailplane.core.MessagePage
import app.mailplane.core.MessageSummary
import app.mailplane.core.OutgoingMessage
import app.mailplane.core.SmtpSender
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap

/** Coroutine façade over the blocking :core engine. One IMAP connection per account. */
class MailRepository(private val accounts: AccountRepository) {
    private val clients = ConcurrentHashMap<String, ImapMailClient>()
    private val autoConfig = AutoConfig()

    private fun client(account: Account): ImapMailClient = clients.getOrPut(account.id) {
        ImapMailClient(account, accounts.password(account.id) ?: throw MailException("Password missing — sign in again"))
    }

    private suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }

    suspend fun discover(email: String): AutoConfig.Result? = io { autoConfig.discover(email) }
    suspend fun verifyIncoming(account: Account, password: String) = io { ImapMailClient(account, password).verify() }
    suspend fun verifyOutgoing(account: Account, password: String) = io { SmtpSender.verify(account, password) }

    suspend fun folders(account: Account): List<MailFolder> = io { client(account).listFolders() }
    suspend fun messages(account: Account, folder: String, offset: Int = 0, limit: Int = 40): MessagePage =
        io { client(account).fetchMessages(folder, limit, offset) }
    suspend fun search(account: Account, folder: String, query: String): List<MessageSummary> =
        io { client(account).search(folder, query) }
    suspend fun starred(account: Account): List<MessageSummary> = io { client(account).flagged() }
    suspend fun quota(account: Account): app.mailplane.core.StorageQuota? = io { client(account).quota() }
    suspend fun body(account: Account, m: MessageSummary): MessageBody = io { client(account).fetchBody(m.folder, m.uid) }
    suspend fun attachment(account: Account, m: MessageSummary, index: Int): ByteArray =
        io { client(account).fetchAttachment(m.folder, m.uid, index) }
    suspend fun setSeen(account: Account, m: MessageSummary, seen: Boolean) = io { client(account).setSeen(m.folder, m.uid, seen) }
    suspend fun setFlagged(account: Account, m: MessageSummary, flagged: Boolean) = io { client(account).setFlagged(m.folder, m.uid, flagged) }
    suspend fun delete(account: Account, m: MessageSummary) = io { client(account).delete(m.folder, m.uid) }
    suspend fun archive(account: Account, m: MessageSummary) = io { client(account).archive(m.folder, m.uid) }
    suspend fun latestInboxUid(account: Account): Long = io { client(account).latestUid("INBOX") }

    suspend fun send(account: Account, message: OutgoingMessage): String = io {
        SmtpSender.send(account, accounts.password(account.id) ?: throw MailException("Password missing"), message)
    }

    /** All folders except Trash and Spam. */
    suspend fun searchAll(account: Account, query: String): List<MessageSummary> = io { client(account).searchAll(query) }

    suspend fun move(account: Account, m: MessageSummary, destination: String) = io { client(account).move(m.folder, m.uid, destination) }

    /** Saves [message] as a draft (unfinished addresses allowed), replacing [replace]. */
    suspend fun saveDraft(account: Account, message: OutgoingMessage, replace: DraftRef?): DraftRef = io {
        client(account).saveDraft(SmtpSender.buildDraft(account, message), replace)
    }

    suspend fun deleteDraft(account: Account, ref: DraftRef) = io { client(account).deleteDraft(ref) }

    suspend fun snooze(account: Account, m: MessageSummary): SnoozedRef = io { client(account).snooze(m.folder, m.uid) }
    suspend fun unsnooze(account: Account, ref: SnoozedRef, destination: String): Boolean = io { client(account).unsnooze(ref, destination) }

    fun disconnect(accountId: String) {
        clients.remove(accountId)?.let { c -> Thread { c.close() }.start() }
    }
}
