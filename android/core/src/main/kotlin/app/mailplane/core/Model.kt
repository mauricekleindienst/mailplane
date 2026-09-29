package app.mailplane.core

import java.time.Instant

/** How a connection to a mail server is secured. */
enum class Security { SSL, STARTTLS, NONE }

data class ServerConfig(
    val host: String,
    val port: Int,
    val security: Security,
)

/** A configured mailbox. Credentials are stored separately (see the app's CredentialStore). */
data class Account(
    val id: String,
    val name: String,
    val email: String,
    val imap: ServerConfig,
    val smtp: ServerConfig,
    /** Login name if it differs from [email]. */
    val username: String = email,
    /** Account colour as #rrggbb, shown as a small dot. */
    val color: String = "#5f8fc4",
    val signature: String = "",
)

enum class FolderRole { INBOX, SENT, DRAFTS, TRASH, SPAM, ARCHIVE }

data class MailFolder(
    /** Full server path, used for all operations. */
    val path: String,
    /** Display name (last path segment, Gmail's "[Gmail]/" prefix removed). */
    val name: String,
    val role: FolderRole?,
    val unread: Int = 0,
)

data class MessageSummary(
    val uid: Long,
    val folder: String,
    val fromName: String,
    val fromEmail: String,
    val to: String,
    val subject: String,
    val date: Instant?,
    val seen: Boolean,
    val flagged: Boolean,
    val hasAttachments: Boolean,
)

data class MessagePage(
    /** Newest first. */
    val messages: List<MessageSummary>,
    val total: Int,
    val unread: Int,
)

data class MailAddress(val name: String?, val email: String) {
    /** "Name <email>" or just "email". */
    val display: String get() = if (name.isNullOrBlank()) email else "$name <$email>"
}

data class AttachmentInfo(
    /** Position in MIME walk order — pass back to [ImapMailClient.fetchAttachment]. */
    val index: Int,
    val fileName: String,
    val mimeType: String,
    val size: Long,
)

data class MessageBody(
    val subject: String,
    val from: MailAddress?,
    val to: List<MailAddress>,
    val cc: List<MailAddress>,
    val date: Instant?,
    val text: String?,
    /** HTML with inline cid: images already resolved to data: URIs. */
    val html: String?,
    val attachments: List<AttachmentInfo>,
    val messageId: String?,
    val references: String?,
    /** https: or mailto: target from List-Unsubscribe, if any. */
    val unsubscribe: String?,
) {
    val snippet: String get() = Snippets.of(text, html)
}

data class OutgoingAttachment(val fileName: String, val mimeType: String, val bytes: ByteArray) {
    override fun equals(other: Any?) = other is OutgoingAttachment &&
        fileName == other.fileName && mimeType == other.mimeType && bytes.contentEquals(other.bytes)
    override fun hashCode() = 31 * (31 * fileName.hashCode() + mimeType.hashCode()) + bytes.contentHashCode()
}

data class OutgoingMessage(
    val to: String,
    val cc: String = "",
    val bcc: String = "",
    val subject: String,
    val text: String,
    val html: String? = null,
    val inReplyTo: String? = null,
    val references: String? = null,
    val attachments: List<OutgoingAttachment> = emptyList(),
)

/** Mailbox storage in kilobytes, as IMAP QUOTA reports it. */
data class StorageQuota(val usedKb: Long, val limitKb: Long) {
    val fraction: Float get() = if (limitKb <= 0) 0f else (usedKb.toFloat() / limitKb).coerceIn(0f, 1f)
}

class MailException(message: String, cause: Throwable? = null) : Exception(message, cause)
