package app.mailplane.core

object Addresses {
    private val EMAIL = Regex("^[^\\s@<>,;\"]+@[^\\s@<>,;\"]+\\.[^\\s@<>,;\"]+$")
    private val NAME_ADDR = Regex("^\\s*\"?([^\"<]*?)\"?\\s*<([^>]+)>\\s*$")

    fun isValid(email: String): Boolean = EMAIL.matches(email.trim())

    fun domainOf(email: String): String? =
        email.substringAfterLast('@', "").lowercase().trim().takeIf { it.isNotEmpty() }

    /**
     * Parses "Name <a@b.c>, d@e.f; \"Last, First\" <g@h.i>" into addresses.
     * Commas inside quotes don't split.
     */
    fun parseList(input: String): List<MailAddress> =
        splitRespectingQuotes(input).mapNotNull { part ->
            val trimmed = part.trim()
            if (trimmed.isEmpty()) return@mapNotNull null
            NAME_ADDR.matchEntire(trimmed)?.let { m ->
                MailAddress(m.groupValues[1].trim().ifEmpty { null }, m.groupValues[2].trim())
            } ?: MailAddress(null, trimmed)
        }

    /** First invalid address in [input], or null when every entry is a valid address. */
    fun firstInvalid(input: String): String? = parseList(input).firstOrNull { !isValid(it.email) }?.email

    private fun splitRespectingQuotes(input: String): List<String> {
        val out = mutableListOf<String>()
        val cur = StringBuilder()
        var inQuotes = false
        for (c in input) {
            when {
                c == '"' -> { inQuotes = !inQuotes; cur.append(c) }
                (c == ',' || c == ';') && !inQuotes -> { out += cur.toString(); cur.clear() }
                else -> cur.append(c)
            }
        }
        out += cur.toString()
        return out
    }
}

object Subjects {
    private val PREFIXES = Regex("^((re|fwd?|aw|wg|sv|tr|vb)\\s*:\\s*)+", RegexOption.IGNORE_CASE)

    /** "Re: AW: Hello" → "Hello" */
    fun base(subject: String?): String = (subject ?: "").replace(PREFIXES, "").trim()

    fun reply(subject: String?): String = "Re: ${base(subject)}"
    fun forward(subject: String?): String = "Fwd: ${base(subject)}"
}

object Snippets {
    private val TAGS = Regex("<[^>]+>")
    private val BLOCKS = Regex("<(style|script|head)[\\s\\S]*?</\\1>", RegexOption.IGNORE_CASE)
    private val WS = Regex("\\s+")

    fun of(text: String?, html: String?, max: Int = 160): String {
        val raw = when {
            !text.isNullOrBlank() -> text
            !html.isNullOrBlank() -> decodeEntities(html.replace(BLOCKS, " ").replace(TAGS, " "))
            else -> ""
        }
        return raw.replace(WS, " ").trim().take(max)
    }

    private fun decodeEntities(s: String) = s
        .replace("&nbsp;", " ", ignoreCase = true)
        .replace("&lt;", "<", ignoreCase = true)
        .replace("&gt;", ">", ignoreCase = true)
        .replace("&quot;", "\"", ignoreCase = true)
        .replace("&#39;", "'")
        .replace("&apos;", "'", ignoreCase = true)
        .replace("&amp;", "&", ignoreCase = true)
}
