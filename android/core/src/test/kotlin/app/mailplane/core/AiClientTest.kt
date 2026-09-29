package app.mailplane.core

import com.sun.net.httpserver.HttpServer
import org.json.JSONObject
import java.net.InetSocketAddress
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** AI client against a local fake provider (JDK HttpServer). */
class AiClientTest {
    private lateinit var server: HttpServer
    private val seen = mutableListOf<Pair<String, String>>()   // path to body
    private var authHeader: String? = null
    private var status = 200
    private var answer = """{"choices":[{"message":{"content":"  Hello there  "}}]}"""

    private val base get() = "http://127.0.0.1:${server.address.port}/v1"

    @BeforeTest fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            val body = ex.requestBody.readBytes().toString(Charsets.UTF_8)
            seen += ex.requestURI.path to body
            authHeader = ex.requestHeaders.getFirst("authorization") ?: ex.requestHeaders.getFirst("x-api-key")
            val out = if (ex.requestURI.path.endsWith("/models")) """{"data":[{"id":"qwen2.5"},{"id":"llama3.2"},{"id":"qwen2.5"}]}""" else answer
            val bytes = out.toByteArray()
            ex.sendResponseHeaders(status, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
    }

    @AfterTest fun stop() = server.stop(0)

    @Test fun `openai-compatible completion sends system + user and trims the answer`() {
        val cfg = AiClient.Config("custom", base, "llama3.2", apiKey = "sk-1")
        val text = AiClient.complete(cfg, AiClient.summarize("Carol", "Report", "Numbers inside"))
        assertEquals("Hello there", text)
        val (path, body) = seen.single()
        assertEquals("/v1/chat/completions", path)
        val json = JSONObject(body)
        assertEquals("llama3.2", json.getString("model"))
        assertEquals("system", json.getJSONArray("messages").getJSONObject(0).getString("role"))
        assertTrue(json.getJSONArray("messages").getJSONObject(1).getString("content").contains("Numbers inside"))
        assertEquals("Bearer sk-1", authHeader)
    }

    @Test fun `anthropic uses the messages API and x-api-key`() {
        answer = """{"content":[{"type":"text","text":"Hi"},{"type":"text","text":" you"}]}"""
        val cfg = AiClient.Config("anthropic", base, "claude", apiKey = "k")
        assertEquals("Hi you", AiClient.complete(cfg, AiClient.rewrite("shorter", "long text")))
        assertEquals("/v1/messages", seen.single().first)
        assertEquals("k", authHeader)
        assertTrue(JSONObject(seen.single().second).has("max_tokens"))
    }

    @Test fun `models are listed, de-duplicated and sorted`() {
        assertEquals(listOf("llama3.2", "qwen2.5"), AiClient.listModels(AiClient.Config("ollama", base)))
    }

    @Test fun `errors are explained`() {
        status = 401
        val e = assertFailsWith<MailException> { AiClient.complete(AiClient.Config("custom", base, "m"), AiClient.write(null, null, "hi")) }
        assertTrue(e.message!!.contains("API key"))
        assertFailsWith<MailException> { AiClient.listModels(AiClient.Config("openai", base)) }   // needs a key
        assertFailsWith<MailException> { AiClient.complete(AiClient.Config("custom", base, ""), AiClient.write(null, null, "x")) }
        val down = assertFailsWith<MailException> { AiClient.listModels(AiClient.Config("custom", "http://127.0.0.1:1/v1")) }
        assertTrue(down.message!!.contains("Couldn't reach"))
    }
}
