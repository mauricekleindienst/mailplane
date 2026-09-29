package app.mailplane.core

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

/**
 * What kind of sender an address belongs to — used for placeholder pictures
 * when there is no photo or logo (same rules as the desktop app).
 */
enum class SenderKind { PERSON, BILLING, SECURITY, SUPPORT, NEWS, NOTIFY }

object Senders {
    private val rules = listOf(
        SenderKind.BILLING to Regex("^(billing|invoices?|receipts?|payments?|orders?|accounts?|sales|shop|store)\\b"),
        SenderKind.SECURITY to Regex("^(security|verify|verification|auth|login|account-security)\\b"),
        SenderKind.SUPPORT to Regex("^(support|help|care|service|feedback|contact)\\b"),
        SenderKind.NEWS to Regex("^(news|newsletters?|digest|weekly|hello|hi|team|info|marketing|community|updates?)\\b"),
        SenderKind.NOTIFY to Regex("^(no-?reply|do-?not-?reply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|system|automated|robot|bot)\\b"),
    )

    fun kindOf(email: String): SenderKind {
        val local = email.substringBefore('@').lowercase()
        if (Regex("no-?reply").containsMatchIn(local)) return SenderKind.NOTIFY
        return rules.firstOrNull { it.second.containsMatchIn(local) }?.first ?: SenderKind.PERSON
    }

    /** Up to two initials from a name or address. */
    fun initials(nameOrEmail: String): String =
        nameOrEmail.substringBefore('@').split(Regex("[\\s._-]+")).filter { it.isNotBlank() }
            .take(2).joinToString("") { it.take(1) }.uppercase().ifEmpty { "?" }
}

/** Day headers for the message list: Today · Yesterday · Monday · 12 Sep · 12 Sep 2024. */
object Days {
    fun label(instant: Instant?, today: LocalDate = LocalDate.now(), zone: ZoneId = ZoneId.systemDefault(),
              locale: Locale = Locale.getDefault()): String {
        if (instant == null) return ""
        val d = instant.atZone(zone).toLocalDate()
        val days = java.time.temporal.ChronoUnit.DAYS.between(d, today)
        return when {
            days <= 0 -> "Today"
            days == 1L -> "Yesterday"
            days < 7 -> d.dayOfWeek.getDisplayName(TextStyle.FULL, locale)
            d.year == today.year -> d.format(DateTimeFormatter.ofPattern("d MMM", locale))
            else -> d.format(DateTimeFormatter.ofPattern("d MMM yyyy", locale))
        }
    }
}
