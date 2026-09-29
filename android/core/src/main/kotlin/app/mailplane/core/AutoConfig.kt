package app.mailplane.core

import java.net.HttpURLConnection
import java.net.URL

/**
 * Finds IMAP/SMTP settings for a domain, in this order:
 *  1. built-in [ProviderPresets]
 *  2. Mozilla ISPDB (autoconfig.thunderbird.net — covers thousands of providers)
 *  3. the domain's own autoconfig endpoint (autoconfig.<domain>/mail/config-v1.1.xml)
 * Returns null when nothing is found; callers then fall back to [ProviderPresets.guess]
 * and let the user edit the servers. Blocking — call off the main thread.
 */
class AutoConfig(
    private val ispdbBase: String = "https://autoconfig.thunderbird.net/v1.1/",
    private val domainUrl: (String) -> String = { "https://autoconfig.$it/mail/config-v1.1.xml" },
    private val timeoutMs: Int = 5000,
) {
    enum class Source { BUILT_IN, ISPDB, DOMAIN }

    data class Result(val preset: ProviderPresets.Preset, val source: Source)

    fun discover(email: String): Result? {
        ProviderPresets.forEmail(email)?.let { return Result(it, Source.BUILT_IN) }
        val domain = Addresses.domainOf(email) ?: return null
        fetch(ispdbBase + domain)?.let { parse(it, domain) }?.let { return Result(it, Source.ISPDB) }
        fetch(domainUrl(domain))?.let { parse(it, domain) }?.let { return Result(it, Source.DOMAIN) }
        return null
    }

    private fun fetch(url: String): String? = runCatching {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = timeoutMs
        conn.readTimeout = timeoutMs
        conn.instanceFollowRedirects = true
        try {
            if (conn.responseCode !in 200..299) null else conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }.getOrNull()

    companion object {
        private fun block(xml: String, tag: String, type: String): List<String> =
            Regex("<$tag[^>]*type=[\"']$type[\"'][^>]*>([\\s\\S]*?)</$tag>", RegexOption.IGNORE_CASE)
                .findAll(xml).map { it.groupValues[1] }.toList()

        private fun field(block: String, name: String): String? =
            Regex("<$name>\\s*([^<]+?)\\s*</$name>", RegexOption.IGNORE_CASE).find(block)?.groupValues?.get(1)

        private fun server(block: String, domain: String, defaultPort: Int): ServerConfig? {
            val host = field(block, "hostname")?.replace("%EMAILDOMAIN%", domain) ?: return null
            val port = field(block, "port")?.toIntOrNull() ?: defaultPort
            val security = when (field(block, "socketType")?.uppercase()) {
                "SSL" -> Security.SSL
                "STARTTLS" -> Security.STARTTLS
                "PLAIN" -> Security.NONE
                else -> if (port == 993 || port == 465) Security.SSL else Security.STARTTLS
            }
            return ServerConfig(host, port, security)
        }

        /** Parses Mozilla autoconfig XML; prefers SSL/STARTTLS entries over plain ones. */
        internal fun parse(xml: String, domain: String): ProviderPresets.Preset? {
            fun pick(blocks: List<String>, port: Int) = blocks.mapNotNull { server(it, domain, port) }
                .sortedBy { if (it.security == Security.NONE) 1 else 0 }.firstOrNull()
            val imap = pick(block(xml, "incomingServer", "imap"), 993) ?: return null
            val smtp = pick(block(xml, "outgoingServer", "smtp"), 587) ?: ProviderPresets.guess("x@$domain")!!.smtp
            val name = field(xml, "displayShortName") ?: field(xml, "displayName") ?: domain
            return ProviderPresets.Preset(name, imap, smtp)
        }
    }
}
