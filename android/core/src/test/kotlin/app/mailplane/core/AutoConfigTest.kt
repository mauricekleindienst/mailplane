package app.mailplane.core

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AutoConfigTest {
    private lateinit var server: HttpServer
    private val served = mutableMapOf<String, String>()
    private val base get() = "http://127.0.0.1:${server.address.port}"

    @BeforeTest fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            val body = served[ex.requestURI.path]
            if (body == null) { ex.sendResponseHeaders(404, -1); ex.close(); return@createContext }
            val bytes = body.toByteArray()
            ex.sendResponseHeaders(200, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
    }

    @AfterTest fun stop() = server.stop(0)

    private fun autoConfig() = AutoConfig(ispdbBase = "$base/ispdb/", domainUrl = { "$base/domain/$it.xml" }, timeoutMs = 2000)

    private val xml = """
        <clientConfig version="1.1"><emailProvider id="corp.example">
          <displayShortName>Corp Mail</displayShortName>
          <incomingServer type="pop3"><hostname>pop.corp.example</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
          <incomingServer type="imap"><hostname>plain.%EMAILDOMAIN%</hostname><port>143</port><socketType>plain</socketType></incomingServer>
          <incomingServer type="imap"><hostname>imap.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
          <outgoingServer type="smtp"><hostname>smtp.corp.example</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
        </emailProvider></clientConfig>
    """.trimIndent()

    @Test fun `built-in presets win without any network`() {
        val r = autoConfig().discover("me@gmail.com")!!
        assertEquals(AutoConfig.Source.BUILT_IN, r.source)
        assertEquals("imap.gmail.com", r.preset.imap.host)
    }

    @Test fun `ispdb result is parsed, preferring encrypted imap`() {
        served["/ispdb/corp.example"] = xml
        val r = autoConfig().discover("me@corp.example")!!
        assertEquals(AutoConfig.Source.ISPDB, r.source)
        assertEquals("Corp Mail", r.preset.provider)
        assertEquals(ServerConfig("imap.corp.example", 993, Security.SSL), r.preset.imap)
        assertEquals(ServerConfig("smtp.corp.example", 587, Security.STARTTLS), r.preset.smtp)
    }

    @Test fun `falls back to the domain's own autoconfig`() {
        served["/domain/corp.example.xml"] = xml
        assertEquals(AutoConfig.Source.DOMAIN, autoConfig().discover("me@corp.example")!!.source)
    }

    @Test fun `nothing found returns null`() {
        assertNull(autoConfig().discover("me@nowhere.example"))
    }
}
