package app.mailplane.core

import java.time.LocalDate
import java.time.ZoneOffset
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals

class SendersTest {
    @Test fun `sender kinds follow the local part`() {
        assertEquals(SenderKind.BILLING, Senders.kindOf("billing@shop.test"))
        assertEquals(SenderKind.NOTIFY, Senders.kindOf("no-reply@github.com"))
        assertEquals(SenderKind.NOTIFY, Senders.kindOf("ci-noreply@build.test"))
        assertEquals(SenderKind.NEWS, Senders.kindOf("newsletter@digest.test"))
        assertEquals(SenderKind.SECURITY, Senders.kindOf("security@bank.test"))
        assertEquals(SenderKind.SUPPORT, Senders.kindOf("support@app.test"))
        assertEquals(SenderKind.PERSON, Senders.kindOf("lena@hoffmann.me"))
    }

    @Test fun `initials from names and addresses`() {
        assertEquals("LH", Senders.initials("Lena Hoffmann"))
        assertEquals("JW", Senders.initials("jonas.weber@mail.test"))
        assertEquals("?", Senders.initials(""))
    }

    @Test fun `day labels`() {
        val today = LocalDate.of(2026, 9, 29)
        fun at(y: Int, m: Int, d: Int) = LocalDate.of(y, m, d).atTime(12, 0).toInstant(ZoneOffset.UTC)
        fun label(y: Int, m: Int, d: Int) = Days.label(at(y, m, d), today, ZoneOffset.UTC, Locale.ENGLISH)
        assertEquals("Today", label(2026, 9, 29))
        assertEquals("Yesterday", label(2026, 9, 28))
        assertEquals("Friday", label(2026, 9, 25))
        assertEquals("12 Sep", label(2026, 9, 12))
        assertEquals("3 Dec 2025", label(2025, 12, 3))
    }
}
