package app.mailplane.android

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.mailplane.android.ui.theme.Frost
import app.mailplane.android.data.AppRelease
import app.mailplane.android.data.ThemeMode
import app.mailplane.android.ui.Draft
import app.mailplane.android.ui.ListState
import app.mailplane.android.ui.ReaderState
import app.mailplane.android.ui.STARRED
import app.mailplane.android.ui.compose.ComposeContent
import app.mailplane.android.ui.inbox.InboxActions
import app.mailplane.android.ui.inbox.InboxContent
import app.mailplane.android.ui.inbox.InboxUi
import app.mailplane.android.ui.message.MessageContent
import app.mailplane.android.ui.onboarding.Welcome
import app.mailplane.android.ui.theme.MailplaneTheme
import app.mailplane.core.Account
import app.mailplane.core.AttachmentInfo
import app.mailplane.core.FolderRole
import app.mailplane.core.MailAddress
import app.mailplane.core.MailFolder
import app.mailplane.core.MessageBody
import app.mailplane.core.MessageSummary
import app.mailplane.core.Security
import app.mailplane.core.ServerConfig
import app.mailplane.core.StorageQuota
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Duration
import java.time.Instant

/**
 * Renders every main screen with sample data (light + dark) into
 * PNG files in build/outputs/roborazzi — the Android equivalent of the desktop
 * README screenshots, and a visual check in CI.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w393dp-h852dp-xxhdpi", application = android.app.Application::class)
class ScreenshotTest {

    private val server = ServerConfig("imap.example.com", 993, Security.SSL)
    private val maurice = Account("a", "Maurice", "maurice@mailplane.app", server, server, color = "#6fa665")
    private val studio = Account("b", "Studio", "hello@studio.test", server, server, color = "#6f93c4")

    private fun ago(minutes: Long): Instant = Instant.now().minus(Duration.ofMinutes(minutes))
    private var uid = 100L
    private fun msg(from: String, email: String, subject: String, minutes: Long, seen: Boolean = true,
                    flagged: Boolean = false, attach: Boolean = false, folder: String = "INBOX") =
        MessageSummary(uid++, folder, from, email, "maurice@mailplane.app", subject, ago(minutes), seen, flagged, attach)

    private val folders = listOf(
        MailFolder("INBOX", "Inbox", FolderRole.INBOX, 3), MailFolder("Sent", "Sent", FolderRole.SENT),
        MailFolder("Drafts", "Drafts", FolderRole.DRAFTS), MailFolder("Archive", "Archive", FolderRole.ARCHIVE),
        MailFolder("Trash", "Trash", FolderRole.TRASH), MailFolder("Projects", "Projects", null, 1),
        MailFolder("Receipts", "Receipts", null),
    )
    private val inbox = listOf(
        msg("Design Weekly", "newsletter@designweekly.io", "Issue 112 · Quiet interfaces", 12, seen = false),
        msg("TAP Air Portugal", "no-reply@flytap.com", "Flights to Lisbon confirmed", 70, seen = false, attach = true),
        msg("Lena Hoffmann", "lena@hoffmann.me", "Dinner on Friday?", 140),
        msg("Hetzner Online", "billing@hetzner.com", "Your invoice for September", 400, seen = false, flagged = true, attach = true),
        msg("Jonas Weber", "jonas@weber.io", "Re: Photos from the weekend", 60 * 26),
        msg("GitHub", "noreply@github.com", "Security alert: new sign-in", 60 * 30),
        msg("Figma", "support@figma.com", "Comments on Mailplane", 60 * 75, flagged = true),
    )
    private val ui = InboxUi(
        accounts = listOf(maurice, studio), activeId = "a", unread = mapOf("a" to 3, "b" to 2),
        list = ListState(folders = folders, folderPath = "INBOX", messages = inbox, total = inbox.size),
        quota = StorageQuota(usedKb = 6_100_000, limitKb = 15_728_640),
    )

    private fun shot(name: String, dark: Boolean = false, content: @Composable () -> Unit) =
        captureRoboImage("build/outputs/roborazzi/$name.png") {
            MailplaneTheme(if (dark) ThemeMode.DARK else ThemeMode.LIGHT, 0xFFE2F47C) { content() }
        }

    @Test fun inbox() {
        shot("inbox-light") { InboxContent(ui, InboxActions()) }
        shot("inbox-dark", dark = true) { InboxContent(ui, InboxActions()) }
    }

    @Test fun inboxVariants() {
        shot("inbox-compact") { InboxContent(ui.copy(compact = true), InboxActions()) }
        shot("inbox-update") {
            InboxContent(ui.copy(update = AppRelease("0.2.0", "https://example.test/a.apk", "https://example.test", "")), InboxActions())
        }
        shot("starred") {
            val starred = inbox.filter { it.flagged }.mapIndexed { i, m -> if (i == 1) m.copy(folder = "Projects") else m }
            InboxContent(ui.copy(list = ui.list.copy(folderPath = STARRED, messages = starred)), InboxActions())
        }
        shot("drawer") { InboxContent(ui, InboxActions(), initialDrawerOpen = true) }
        shot("search") { InboxContent(ui.copy(recentSearches = listOf("invoice", "lisbon", "figma")), InboxActions(), initialSearchOpen = true) }
        shot("empty") { InboxContent(ui.copy(list = ui.list.copy(messages = emptyList(), total = 0)), InboxActions()) }
        shot("loading") { InboxContent(ui.copy(list = ui.list.copy(messages = emptyList(), loading = true)), InboxActions()) }
    }

    @Test fun message() {
        val m = inbox[3]
        val body = MessageBody(
            subject = m.subject, from = MailAddress("Hetzner Online", m.fromEmail), to = listOf(MailAddress("Maurice", "maurice@mailplane.app")),
            cc = emptyList(), date = m.date,
            text = "Dear Maurice,\n\nyour invoice R0023719 for September is now available in your account.\n\nAmount: €12.40\nDue: 14 October\n\nKind regards\nHetzner Online",
            html = null, attachments = listOf(AttachmentInfo(0, "Invoice-R0023719.pdf", "application/pdf", 48_000)),
            messageId = null, references = null, unsubscribe = null,
        )
        val thread = listOf(msg("Hetzner Online", "billing@hetzner.com", "Your invoice for August", 60 * 24 * 31))
        shot("message") { MessageContent(ReaderState(summary = m, body = body, thread = thread)) }
        shot("message-dark", dark = true) { MessageContent(ReaderState(summary = m, body = body, thread = thread)) }
    }

    @Test fun compose() {
        val d = Draft(accountId = "a", to = "Lena Hoffmann <lena@hoffmann.me>, jonas@weber.io, not-an-address",
            subject = "Re: Dinner on Friday?", body = "Friday works for me — 8:30?",
            quoted = "On Tue, Lena Hoffmann wrote:\n> The new place near the river finally opened — 8pm?", title = "Reply")
        shot("compose") { ComposeContent(d, listOf(maurice, studio)) }
        shot("compose-dark", dark = true) { ComposeContent(d, listOf(maurice, studio)) }
    }

    @Test fun newFeatures() {
        // Every account's inbox in one list, with the account on each row
        val mixed = inbox.mapIndexed { i, m -> m.copy(accountId = if (i % 3 == 1) "b" else "a") }
        shot("unified") {
            InboxContent(ui.copy(activeId = app.mailplane.android.ui.ALL_ACCOUNTS,
                list = ui.list.copy(messages = mixed, unified = true)), InboxActions())
        }
        shot("search-all-folders") {
            InboxContent(ui.copy(list = ui.list.copy(query = "invoice", searching = true, searchAllFolders = true,
                messages = inbox.filter { it.hasAttachments }.mapIndexed { i, m -> if (i == 0) m.copy(folder = "Receipts") else m })),
                InboxActions(), initialSearchOpen = true)
        }
        val d = Draft(accountId = "a", to = "lena@hoffmann.me", subject = "Photos from Lisbon", body = "Here are the best ones!",
            attachments = listOf(app.mailplane.core.OutgoingAttachment("lisbon-01.jpg", "image/jpeg", ByteArray(2_400_000)),
                app.mailplane.core.OutgoingAttachment("itinerary.pdf", "application/pdf", ByteArray(48_000))),
            saveState = "Saved")
        shot("compose-attachments") { ComposeContent(d, listOf(maurice, studio), aiEnabled = true) }
        val m = inbox[1]
        shot("message-summary") {
            MessageContent(ReaderState(summary = m, body = MessageBody(m.subject, MailAddress("TAP", m.fromEmail), emptyList(), emptyList(),
                m.date, "Your flights are confirmed.", null, emptyList(), null, null, null),
                aiSummary = "Your flights to Lisbon on 12 Oct are confirmed.\n• Check-in opens 24 h before\n• One bag included"), aiEnabled = true)
        }
    }

    @Test fun german() {
        app.mailplane.android.ui.I18n.apply("de")
        try {
            shot("de-inbox") { InboxContent(ui, InboxActions()) }
            shot("de-drawer") { InboxContent(ui, InboxActions(), initialDrawerOpen = true) }
            shot("de-compose") {
                ComposeContent(Draft(accountId = "a", to = "lena@hoffmann.me", subject = "Freitag?", body = "Passt 20:30?", title = "Reply"),
                    listOf(maurice, studio))
            }
            shot("de-empty") { InboxContent(ui.copy(list = ui.list.copy(messages = emptyList(), total = 0)), InboxActions()) }
        } finally {
            app.mailplane.android.ui.I18n.apply("en")
        }
    }

    @Test fun onboarding() {
        shot("onboarding-welcome") {
            Column(Modifier.fillMaxSize().background(Frost.colors.canvas).padding(horizontal = 24.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)) { Welcome(onStart = {}) }
        }
    }
}
