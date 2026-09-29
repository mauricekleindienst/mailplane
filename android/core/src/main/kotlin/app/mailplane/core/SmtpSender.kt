package app.mailplane.core

import javax.activation.DataHandler
import javax.mail.Message
import javax.mail.MessagingException
import javax.mail.internet.InternetAddress
import javax.mail.internet.MimeBodyPart
import javax.mail.internet.MimeMessage
import javax.mail.internet.MimeMultipart
import javax.mail.util.ByteArrayDataSource

object SmtpSender {

    /** Sends [message] from [account]; returns the Message-ID of the sent mail. */
    fun send(account: Account, password: String, message: OutgoingMessage): String {
        val (session, protocol) = MailSessions.smtp(account.smtp)
        val mime = build(session, account, message)
        try {
            session.getTransport(protocol).use { transport ->
                transport.connect(account.smtp.host, account.smtp.port, account.username, password)
                transport.sendMessage(mime, mime.allRecipients)
            }
        } catch (e: MessagingException) {
            throw MailException(ImapMailClient.friendlyError(e), e)
        }
        return mime.messageID
    }

    /** A draft copy of [message] for [ImapMailClient.saveDraft] — unfinished addresses are fine. */
    fun buildDraft(account: Account, message: OutgoingMessage): MimeMessage =
        build(MailSessions.smtp(account.smtp).first, account, message, draft = true)

    /** Connects and authenticates without sending — used by account setup. */
    fun verify(account: Account, password: String) {
        val (session, protocol) = MailSessions.smtp(account.smtp)
        try {
            session.getTransport(protocol).use { it.connect(account.smtp.host, account.smtp.port, account.username, password) }
        } catch (e: MessagingException) {
            throw MailException(ImapMailClient.friendlyError(e), e)
        }
    }

    /**
     * Builds the MIME message (exposed for tests, drafts and "save to Sent").
     * A [draft] may be unfinished: no recipient yet, or an address still being typed.
     */
    fun build(session: javax.mail.Session, account: Account, message: OutgoingMessage, draft: Boolean = false): MimeMessage {
        if (!draft) {
            val invalid = Addresses.firstInvalid(message.to)
                ?: Addresses.firstInvalid(message.cc)
                ?: Addresses.firstInvalid(message.bcc)
            if (invalid != null) throw MailException("Invalid address: $invalid")
        }
        fun parse(list: String) = if (draft) runCatching { Addresses.parseList(list) }.getOrDefault(emptyList())
            .filter { Addresses.firstInvalid(it.email) == null } else Addresses.parseList(list)
        val to = parse(message.to)
        if (to.isEmpty() && !draft) throw MailException("Add at least one recipient")

        return MimeMessage(session).apply {
            setFrom(InternetAddress(account.email, account.name.ifBlank { null }, "UTF-8"))
            if (to.isNotEmpty()) setRecipients(Message.RecipientType.TO, to.toInternet())
            parse(message.cc).takeIf { it.isNotEmpty() }?.let { setRecipients(Message.RecipientType.CC, it.toInternet()) }
            parse(message.bcc).takeIf { it.isNotEmpty() }?.let { setRecipients(Message.RecipientType.BCC, it.toInternet()) }
            setSubject(message.subject, "UTF-8")
            message.inReplyTo?.let { setHeader("In-Reply-To", it) }
            message.references?.let { setHeader("References", it) }
            sentDate = java.util.Date()

            val body = if (message.html != null) {
                MimeMultipart("alternative").apply {
                    addBodyPart(MimeBodyPart().apply { setText(message.text, "UTF-8", "plain") })
                    addBodyPart(MimeBodyPart().apply { setText(message.html, "UTF-8", "html") })
                }
            } else null

            if (message.attachments.isEmpty()) {
                if (body != null) setContent(body) else setText(message.text, "UTF-8", "plain")
            } else {
                val mixed = MimeMultipart("mixed")
                mixed.addBodyPart(MimeBodyPart().apply {
                    if (body != null) setContent(body) else setText(message.text, "UTF-8", "plain")
                })
                message.attachments.forEach { att ->
                    mixed.addBodyPart(MimeBodyPart().apply {
                        dataHandler = DataHandler(ByteArrayDataSource(att.bytes, att.mimeType))
                        fileName = att.fileName
                        disposition = javax.mail.Part.ATTACHMENT
                    })
                }
                setContent(mixed)
            }
            saveChanges()
        }
    }

    private fun List<MailAddress>.toInternet(): Array<InternetAddress> =
        map { InternetAddress(it.email, it.name, "UTF-8") }.toTypedArray()
}
