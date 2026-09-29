package app.mailplane.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.assertFalse

class LogicTest {
    @Test fun `parses address lists with names, quotes and separators`() {
        val list = Addresses.parseList("Zoe <zoe@test.dev>, yan@test.dev; \"Last, First\" <lf@x.io>")
        assertEquals(
            listOf(MailAddress("Zoe", "zoe@test.dev"), MailAddress(null, "yan@test.dev"), MailAddress("Last, First", "lf@x.io")),
            list,
        )
    }

    @Test fun `finds the first invalid address`() {
        assertNull(Addresses.firstInvalid("a@b.cd, C <c@d.ef>"))
        assertEquals("nope", Addresses.firstInvalid("a@b.cd, nope"))
        assertFalse(Addresses.isValid("a@b"))
        assertTrue(Addresses.isValid("first.last+tag@sub.example.co.uk"))
    }

    @Test fun `reply and forward subjects never stack prefixes`() {
        assertEquals("Re: Budget", Subjects.reply("Re: AW: Budget"))
        assertEquals("Fwd: Budget", Subjects.forward("FW: Re: Budget"))
        assertEquals("Re: ", Subjects.reply(null))
    }

    @Test fun `snippets prefer text and strip html`() {
        assertEquals("Hello there", Snippets.of("  Hello\n\n there ", "<b>ignored</b>"))
        assertEquals("Big sale & more", Snippets.of(null, "<style>p{}</style><p>Big <b>sale</b> &amp; more</p>"))
    }

    @Test fun `provider presets by domain, with a guess for the rest`() {
        val gmail = ProviderPresets.forEmail("Someone@GMail.com")!!
        assertEquals("imap.gmail.com", gmail.imap.host)
        assertEquals(Security.STARTTLS, gmail.smtp.security)
        assertNull(ProviderPresets.forEmail("me@unknown-corp.io"))
        assertEquals("imap.unknown-corp.io", ProviderPresets.guess("me@unknown-corp.io")!!.imap.host)
    }

    @Test fun `folder roles from special-use flags and common names`() {
        assertEquals(FolderRole.INBOX, ImapMailClient.roleOf("INBOX", "INBOX", emptySet()))
        assertEquals(FolderRole.SENT, ImapMailClient.roleOf("Foo", "Foo", setOf("\\sent")))
        assertEquals(FolderRole.ARCHIVE, ImapMailClient.roleOf("[Gmail]/All Mail", "All Mail", setOf("\\all")))
        assertEquals(FolderRole.TRASH, ImapMailClient.roleOf("Papierkorb", "Papierkorb", emptySet()))
        assertNull(ImapMailClient.roleOf("Projects", "Projects", emptySet()))
    }
}
