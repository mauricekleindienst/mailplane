package app.mailplane.core

import java.util.Properties
import javax.mail.Session

/** Builds javax.mail sessions with sane timeouts and TLS settings. */
internal object MailSessions {
    private const val CONNECT_TIMEOUT_MS = "15000"
    private const val IO_TIMEOUT_MS = "30000"

    fun imap(config: ServerConfig): Pair<Session, String> {
        val protocol = if (config.security == Security.SSL) "imaps" else "imap"
        val p = Properties()
        p["mail.store.protocol"] = protocol
        p["mail.$protocol.host"] = config.host
        p["mail.$protocol.port"] = config.port.toString()
        p["mail.$protocol.connectiontimeout"] = CONNECT_TIMEOUT_MS
        p["mail.$protocol.timeout"] = IO_TIMEOUT_MS
        p["mail.$protocol.writetimeout"] = IO_TIMEOUT_MS
        p["mail.$protocol.partialfetch"] = "false"          // fetch bodies in one go (faster over mobile)
        p["mail.$protocol.peek"] = "true"                  // reading a body never sets \Seen implicitly
        tls(p, protocol, config)
        return Session.getInstance(p) to protocol
    }

    fun smtp(config: ServerConfig): Pair<Session, String> {
        val protocol = if (config.security == Security.SSL) "smtps" else "smtp"
        val p = Properties()
        p["mail.transport.protocol"] = protocol
        p["mail.$protocol.host"] = config.host
        p["mail.$protocol.port"] = config.port.toString()
        p["mail.$protocol.auth"] = "true"
        p["mail.$protocol.connectiontimeout"] = CONNECT_TIMEOUT_MS
        p["mail.$protocol.timeout"] = IO_TIMEOUT_MS
        p["mail.$protocol.writetimeout"] = IO_TIMEOUT_MS
        tls(p, protocol, config)
        return Session.getInstance(p) to protocol
    }

    private fun tls(p: Properties, protocol: String, config: ServerConfig) {
        when (config.security) {
            Security.SSL -> {
                p["mail.$protocol.ssl.enable"] = "true"
                p["mail.$protocol.ssl.checkserveridentity"] = "true"
            }
            Security.STARTTLS -> {
                p["mail.$protocol.starttls.enable"] = "true"
                p["mail.$protocol.starttls.required"] = "true"
                p["mail.$protocol.ssl.checkserveridentity"] = "true"
            }
            Security.NONE -> Unit
        }
        p["mail.$protocol.ssl.protocols"] = "TLSv1.2 TLSv1.3"
    }
}
