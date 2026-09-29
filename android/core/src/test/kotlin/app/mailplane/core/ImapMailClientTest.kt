package app.mailplane.core

import com.icegreen.greenmail.junit5.GreenMailExtension
import com.icegreen.greenmail.util.ServerSetupTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.extension.RegisterExtension
import java.util.Date
import javax.activation.DataHandler
import javax.mail.Flags
import javax.mail.Folder
import javax.mail.Message
import javax.mail.Session
import javax.mail.internet.InternetAddress
import javax.mail.internet.MimeBodyPart
import javax.mail.internet.MimeMessage
import javax.mail.internet.MimeMultipart
import javax.mail.util.ByteArrayDataSource
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Runs the real engine against GreenMail's in-memory IMAP + SMTP servers. */
class ImapMailClientTest {

    companion object {
        @JvmField
        @RegisterExtension
        val greenMail: GreenMailExtension = GreenMailExtension(ServerSetupTest.SMTP_IMAP)
    }

    private val email = "alice@example.com"
    private val password = "secret"
    private lateinit var account: Account
    private lateinit var client: ImapMailClient
    private val session = Session.getInstance(java.util.Properties())

    @BeforeEach fun setUp() {
        greenMail.setUser(email, email, password)
        account = Account(
            id = "a", name = "Alice", email = email,
            imap = ServerConfig("127.0.0.1", ServerSetupTest.IMAP.port, Security.NONE),
            smtp = ServerConfig("127.0.0.1", ServerSetupTest.SMTP.port, Security.NONE),
        )
        client = ImapMailClient(account, password)
        // Standard folders (GreenMail has no special-use flags → exercised via name heuristics)
        val store = client.connect()
        listOf("Sent", "Trash", "Archive", "Projects").forEach { store.getFolder(it).create(Folder.HOLDS_MESSAGES) }
    }

    @AfterEach fun tearDown() = client.close()

    private fun deliver(subject: String, text: String = "Body of $subject", minutesAgo: Long = 0, html: String? = null,
                        attachment: Pair<String, ByteArray>? = null, from: String = "carol@sender.test") {
        val msg = MimeMessage(session).apply {
            setFrom(InternetAddress(from, "Carol Sender"))
            setRecipient(Message.RecipientType.TO, InternetAddress(email))
            setSubject(subject)
            sentDate = Date(System.currentTimeMillis() - minutesAgo * 60_000)
            val alt = MimeMultipart("alternative").apply {
                addBodyPart(MimeBodyPart().apply { setText(text, "UTF-8", "plain") })
                if (html != null) addBodyPart(MimeBodyPart().apply { setText(html, "UTF-8", "html") })
            }
            if (attachment == null) setContent(alt) else setContent(MimeMultipart("mixed").apply {
                addBodyPart(MimeBodyPart().apply { setContent(alt) })
                addBodyPart(MimeBodyPart().apply {
                    dataHandler = DataHandler(ByteArrayDataSource(attachment.second, "application/pdf"))
                    fileName = attachment.first
                    disposition = MimeBodyPart.ATTACHMENT
                })
            })
            saveChanges()
        }
        greenMail.userManager.getUser(email).deliver(msg)
    }

    @Test fun `lists folders with roles, inbox first, unread counts`() {
        deliver("One")
        val folders = client.listFolders()
        assertEquals("INBOX", folders.first().path)
        assertEquals("Inbox", folders.first().name)
        assertEquals(1, folders.first().unread)
        assertEquals(FolderRole.SENT, folders.first { it.path == "Sent" }.role)
        assertEquals(FolderRole.TRASH, folders.first { it.path == "Trash" }.role)
        assertEquals(FolderRole.ARCHIVE, folders.first { it.path == "Archive" }.role)
        assertEquals(null, folders.first { it.path == "Projects" }.role)
        assertEquals("Projects", folders.last().path) // custom folders after the system ones
    }

    @Test fun `pages newest first with total and unread`() {
        (1..7).forEach { deliver("Mail $it") }
        val first = client.fetchMessages("INBOX", limit = 5)
        assertEquals(7, first.total)
        assertEquals(7, first.unread)
        assertEquals(listOf("Mail 7", "Mail 6", "Mail 5", "Mail 4", "Mail 3"), first.messages.map { it.subject })
        val second = client.fetchMessages("INBOX", limit = 5, offset = 5)
        assertEquals(listOf("Mail 2", "Mail 1"), second.messages.map { it.subject })
        assertEquals("Carol Sender", first.messages[0].fromName)
        assertEquals("carol@sender.test", first.messages[0].fromEmail)
        assertTrue(client.fetchMessages("INBOX", offset = 50).messages.isEmpty())
    }

    @Test fun `reads html, text and attachments without marking as read`() {
        deliver("Report", text = "Plain version", html = "<p>Rich <b>version</b></p>", attachment = "report.pdf" to "%PDF-1.4".toByteArray())
        val summary = client.fetchMessages("INBOX").messages.single()
        assertTrue(summary.hasAttachments)
        val body = client.fetchBody("INBOX", summary.uid)
        assertEquals("Plain version", body.text?.trim())
        assertTrue(body.html!!.contains("<b>version</b>"))
        assertEquals("report.pdf", body.attachments.single().fileName)
        assertEquals("application/pdf", body.attachments.single().mimeType)
        assertEquals("%PDF-1.4", String(client.fetchAttachment("INBOX", summary.uid, 0)))
        assertNotNull(body.messageId)
        assertFalse(client.fetchMessages("INBOX").messages.single().seen, "reading must not set \\Seen")
    }

    @Test fun `inline cid images are embedded as data uris`() {
        val msg = MimeMessage(session).apply {
            setFrom(InternetAddress("carol@sender.test"))
            setRecipient(Message.RecipientType.TO, InternetAddress(email))
            subject = "Logo"
            setContent(MimeMultipart("related").apply {
                addBodyPart(MimeBodyPart().apply { setText("<img src=\"cid:logo1\">", "UTF-8", "html") })
                addBodyPart(MimeBodyPart().apply {
                    dataHandler = DataHandler(ByteArrayDataSource(byteArrayOf(1, 2, 3), "image/png"))
                    contentID = "<logo1>"
                    disposition = MimeBodyPart.INLINE
                })
            })
            saveChanges()
        }
        greenMail.userManager.getUser(email).deliver(msg)
        val uid = client.fetchMessages("INBOX").messages.single().uid
        val body = client.fetchBody("INBOX", uid)
        assertTrue(body.html!!.contains("src=\"data:image/png;base64,AQID\""), body.html)
        assertTrue(body.attachments.isEmpty(), "inline images are not attachments")
    }

    @Test fun `seen and flagged flags round-trip`() {
        deliver("Flag me")
        val uid = client.fetchMessages("INBOX").messages.single().uid
        client.setSeen("INBOX", uid, true)
        client.setFlagged("INBOX", uid, true)
        val m = client.fetchMessages("INBOX").messages.single()
        assertTrue(m.seen)
        assertTrue(m.flagged)
        assertEquals(0, client.fetchMessages("INBOX").unread)
    }

    @Test fun `delete moves to trash, deleting in trash removes for good`() {
        deliver("Bye")
        val uid = client.fetchMessages("INBOX").messages.single().uid
        client.delete("INBOX", uid)
        assertEquals(0, client.fetchMessages("INBOX").total)
        val inTrash = client.fetchMessages("Trash").messages.single()
        assertEquals("Bye", inTrash.subject)
        client.delete("Trash", inTrash.uid)
        assertEquals(0, client.fetchMessages("Trash").total)
    }

    @Test fun `archive and move`() {
        deliver("Keep"); deliver("File me")
        val msgs = client.fetchMessages("INBOX").messages
        client.archive("INBOX", msgs.first { it.subject == "Keep" }.uid)
        client.move("INBOX", msgs.first { it.subject == "File me" }.uid, "Projects")
        assertEquals(listOf("Keep"), client.fetchMessages("Archive").messages.map { it.subject })
        assertEquals(listOf("File me"), client.fetchMessages("Projects").messages.map { it.subject })
        assertEquals(0, client.fetchMessages("INBOX").total)
        val archived = client.fetchMessages("Archive").messages.single().uid
        assertFailsWith<MailException> { client.archive("Archive", archived) }
    }

    @Test fun `search matches subject and sender`() {
        deliver("Invoice #42"); deliver("Lunch?", from = "dave@friend.test")
        assertEquals(listOf("Invoice #42"), client.search("INBOX", "invoice").map { it.subject })
        // RFC 3501 FROM is a substring match on real servers; GreenMail only matches whole addresses
        assertEquals(listOf("Lunch?"), client.search("INBOX", "dave@friend.test").map { it.subject })
    }

    @Test fun `latest uid grows with new mail`() {
        assertEquals(0L, client.latestUid("INBOX"))
        deliver("First")
        val a = client.latestUid("INBOX")
        deliver("Second")
        assertTrue(client.latestUid("INBOX") > a)
    }

    @Test fun `wrong password gives a friendly error`() {
        val bad = ImapMailClient(account, "wrong")
        val e = assertFailsWith<MailException> { bad.verify() }
        assertTrue(e.message!!.contains("password"), e.message)
    }

    @Test fun `smtp send delivers to to, cc and bcc with threading headers`() {
        greenMail.setUser("bob@work.test", "bob@work.test", "pw")
        greenMail.setUser("cc@work.test", "cc@work.test", "pw")
        greenMail.setUser("hidden@work.test", "hidden@work.test", "pw")
        val id = SmtpSender.send(account, password, OutgoingMessage(
            to = "Bob <bob@work.test>", cc = "cc@work.test", bcc = "hidden@work.test",
            subject = "Grüße", text = "Hi Bob", html = "<p>Hi <b>Bob</b></p>",
            inReplyTo = "<orig@x>", references = "<root@x> <orig@x>",
            attachments = listOf(OutgoingAttachment("a.txt", "text/plain", "hello".toByteArray())),
        ))
        assertTrue(id.isNotBlank())
        assertTrue(greenMail.waitForIncomingEmail(5000, 3))
        val received = greenMail.receivedMessages
        assertEquals(3, received.size)
        val m = received.first()
        assertEquals("Grüße", m.subject)
        assertEquals("<orig@x>", m.getHeader("In-Reply-To")[0])
        assertEquals(null, m.getHeader("Bcc"), "Bcc must not leak into headers")
        val parsed = MimeParser.parse(m)
        assertEquals("Hi Bob", parsed.text?.trim())
        assertTrue(parsed.html!!.contains("<b>Bob</b>"))
        assertEquals("a.txt", parsed.attachments.single().fileName)
    }

    @Test fun `smtp verify checks the login`() {
        SmtpSender.verify(account, password)
    }

    @Test fun `smtp rejects invalid recipients before connecting`() {
        val e = assertFailsWith<MailException> {
            SmtpSender.send(account, password, OutgoingMessage(to = "not-an-address", subject = "x", text = "x"))
        }
        assertTrue(e.message!!.contains("not-an-address"))
    }
}
