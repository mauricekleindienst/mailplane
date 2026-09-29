package app.mailplane.core

/** Server settings for well-known providers, keyed by e-mail domain (mirrors the desktop app). */
object ProviderPresets {
    data class Preset(
        val provider: String,
        val imap: ServerConfig,
        val smtp: ServerConfig,
        /** Shown before the password step, e.g. that an app password is required. */
        val note: String? = null,
        /** Where the user creates that app password. */
        val helpUrl: String? = null,
    )

    private fun imap(host: String) = ServerConfig(host, 993, Security.SSL)
    private fun submission(host: String) = ServerConfig(host, 587, Security.STARTTLS)
    private fun smtps(host: String) = ServerConfig(host, 465, Security.SSL)

    private fun appPassword(provider: String) =
        "$provider doesn't accept your normal password here. Create an app password " +
            "(it takes a minute) and paste it on the next screen."

    private val gmail = Preset("Gmail", imap("imap.gmail.com"), submission("smtp.gmail.com"),
        appPassword("Gmail") + " You need 2-Step Verification turned on.", "https://myaccount.google.com/apppasswords")
    private val outlook = Preset("Outlook", imap("outlook.office365.com"), submission("smtp.office365.com"),
        "If sign-in fails, your Microsoft account may only allow modern sign-in (OAuth), which isn't supported yet. " +
            "With 2-step verification on, an app password works.", "https://account.microsoft.com/security")
    private val yahoo = Preset("Yahoo", imap("imap.mail.yahoo.com"), smtps("smtp.mail.yahoo.com"),
        appPassword("Yahoo"), "https://login.yahoo.com/myaccount/security/app-password")
    private val icloud = Preset("iCloud", imap("imap.mail.me.com"), submission("smtp.mail.me.com"),
        appPassword("iCloud Mail") + " Look for “App-Specific Passwords”.", "https://account.apple.com/account/manage")
    private val fastmail = Preset("Fastmail", imap("imap.fastmail.com"), submission("smtp.fastmail.com"),
        appPassword("Fastmail"), "https://app.fastmail.com/settings/security/apps")
    private val gmxNet = Preset("GMX", imap("imap.gmx.net"), submission("mail.gmx.net"))
    private val zoho = Preset("Zoho", imap("imap.zoho.com"), submission("smtp.zoho.com"))

    private val byDomain: Map<String, Preset> = buildMap {
        listOf("gmail.com", "googlemail.com").forEach { put(it, gmail) }
        listOf("outlook.com", "hotmail.com", "hotmail.co.uk", "hotmail.fr", "hotmail.de", "live.com", "msn.com")
            .forEach { put(it, outlook) }
        listOf("yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "ymail.com").forEach { put(it, yahoo) }
        listOf("icloud.com", "me.com", "mac.com").forEach { put(it, icloud) }
        listOf("fastmail.com", "fastmail.fm").forEach { put(it, fastmail) }
        listOf("gmx.net", "gmx.de").forEach { put(it, gmxNet) }
        put("gmx.com", Preset("GMX", imap("imap.gmx.com"), submission("mail.gmx.com")))
        put("web.de", Preset("WEB.DE", imap("imap.web.de"), submission("smtp.web.de")))
        put("aol.com", Preset("AOL", imap("imap.aol.com"), submission("smtp.aol.com"), appPassword("AOL"), "https://login.aol.com/account/security"))
        listOf("zoho.com", "zohomail.com").forEach { put(it, zoho) }
        put("yandex.com", Preset("Yandex", imap("imap.yandex.com"), smtps("smtp.yandex.com")))
        put("t-online.de", Preset("T-Online", imap("secureimap.t-online.de"), smtps("securesmtp.t-online.de")))
        put("mail.com", Preset("Mail.com", imap("imap.mail.com"), submission("smtp.mail.com")))
    }

    fun forEmail(email: String): Preset? = byDomain[Addresses.domainOf(email)]

    /** Best guess for unknown domains: imap.<domain> / smtp.<domain>. */
    fun guess(email: String): Preset? {
        val domain = Addresses.domainOf(email) ?: return null
        return Preset(domain, imap("imap.$domain"), submission("smtp.$domain"))
    }
}
