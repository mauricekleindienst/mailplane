package app.mailplane.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URI
import java.net.UnknownHostException

/**
 * Optional AI assistant — the same providers, wire formats and prompts as the
 * desktop app (src/ai-client.js). Two protocols cover every provider:
 * OpenAI-compatible chat completions and Anthropic's Messages API.
 * Blocking; call off the main thread. Nothing is sent unless the user asks.
 */
object AiClient {

    enum class Kind { OPENAI, ANTHROPIC }

    data class Provider(val id: String, val label: String, val kind: Kind, val baseUrl: String, val needsKey: Boolean, val local: Boolean)

    val providers = listOf(
        Provider("openai", "OpenAI", Kind.OPENAI, "https://api.openai.com/v1", needsKey = true, local = false),
        Provider("anthropic", "Anthropic (Claude)", Kind.ANTHROPIC, "https://api.anthropic.com/v1", needsKey = true, local = false),
        // A phone can't run these itself — they point at a computer on the same network
        Provider("ollama", "Ollama (on your network)", Kind.OPENAI, "http://192.168.1.10:11434/v1", needsKey = false, local = true),
        Provider("lmstudio", "LM Studio (on your network)", Kind.OPENAI, "http://192.168.1.10:1234/v1", needsKey = false, local = true),
        Provider("custom", "Other (OpenAI-compatible)", Kind.OPENAI, "", needsKey = false, local = false),
    )

    fun provider(id: String?): Provider? = providers.firstOrNull { it.id == id }

    data class Config(val provider: String, val baseUrl: String = "", val model: String = "", val apiKey: String? = null) {
        val info: Provider? get() = provider(provider)
        val base: String get() = (baseUrl.ifBlank { info?.baseUrl.orEmpty() }).trim().trimEnd('/')
    }

    data class Request(val url: String, val headers: Map<String, String>, val body: JSONObject)
    data class Task(val system: String, val prompt: String, val maxTokens: Int = 1024)

    private const val TIMEOUT_MS = 120_000
    private const val MAX_INPUT_CHARS = 12_000

    private fun headers(kind: Kind, key: String?): Map<String, String> = buildMap {
        put("content-type", "application/json")
        if (kind == Kind.ANTHROPIC) {
            put("anthropic-version", "2023-06-01")
            if (!key.isNullOrBlank()) put("x-api-key", key)
        } else if (!key.isNullOrBlank()) put("authorization", "Bearer $key")
    }

    /** The HTTP request for a completion. Pure — tested. */
    fun buildRequest(cfg: Config, task: Task): Request {
        val info = cfg.info ?: throw MailException("Choose an AI provider first")
        if (cfg.base.isBlank()) throw MailException("Enter the server address")
        if (cfg.model.isBlank()) throw MailException("Choose a model")
        val h = headers(info.kind, cfg.apiKey)
        return if (info.kind == Kind.ANTHROPIC) {
            Request("${cfg.base}/messages", h, JSONObject()
                .put("model", cfg.model).put("max_tokens", task.maxTokens).put("system", task.system)
                .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", task.prompt))))
        } else {
            Request("${cfg.base}/chat/completions", h, JSONObject()
                .put("model", cfg.model)
                .put("messages", JSONArray()
                    .put(JSONObject().put("role", "system").put("content", task.system))
                    .put(JSONObject().put("role", "user").put("content", task.prompt))))
        }
    }

    /** The answer text from a provider response. Pure — tested. */
    fun parseCompletion(kind: Kind, json: JSONObject): String {
        if (kind == Kind.ANTHROPIC) {
            val blocks = json.optJSONArray("content") ?: return ""
            return (0 until blocks.length()).map { blocks.getJSONObject(it) }
                .filter { it.optString("type") == "text" }.joinToString("") { it.optString("text") }.trim()
        }
        val msg = json.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message") ?: return ""
        val content = msg.opt("content")
        return when (content) {
            is JSONArray -> (0 until content.length()).joinToString("") { content.optJSONObject(it)?.optString("text").orEmpty() }.trim()
            null, JSONObject.NULL -> ""
            else -> content.toString().trim()
        }
    }

    fun complete(cfg: Config, task: Task): String {
        val req = buildRequest(cfg, task)
        val json = http(req.url, "POST", req.headers, req.body.toString())
        return parseCompletion(cfg.info!!.kind, json).ifBlank { throw MailException("The AI returned an empty answer.") }
    }

    /** Models the provider offers — doubles as the connection test. */
    fun listModels(cfg: Config): List<String> {
        val info = cfg.info ?: throw MailException("Choose an AI provider first")
        if (cfg.base.isBlank()) throw MailException("Enter the server address")
        if (info.needsKey && cfg.apiKey.isNullOrBlank()) throw MailException("Enter your API key")
        val json = http("${cfg.base}/models", "GET", headers(info.kind, cfg.apiKey), null)
        val arr = json.optJSONArray("data") ?: json.optJSONArray("models") ?: JSONArray()
        return (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { o -> o.optString("id").ifBlank { o.optString("name") }.ifBlank { null } }
        }.distinct().sortedBy { it.lowercase() }
    }

    private fun http(url: String, method: String, headers: Map<String, String>, body: String?): JSONObject {
        val host = runCatching { URI(url).host ?: url }.getOrDefault(url)
        val conn = try {
            (URI(url).toURL().openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 15_000
                readTimeout = TIMEOUT_MS
                headers.forEach { (k, v) -> setRequestProperty(k, v) }
                if (body != null) { doOutput = true; outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) } }
            }
        } catch (e: IllegalArgumentException) {
            throw MailException("That server address isn't valid.")
        } catch (e: IOException) {
            throw MailException(networkError(e, host), e)
        }
        try {
            val status = try { conn.responseCode } catch (e: IOException) { throw MailException(networkError(e, host), e) }
            val text = (if (status in 200..299) conn.inputStream else conn.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
            val json = runCatching { JSONObject(text) }.getOrNull()
            if (status !in 200..299) throw MailException(httpError(status, host, json))
            return json ?: throw MailException("The AI provider sent an answer Mailplane can't read.")
        } finally {
            conn.disconnect()
        }
    }

    private fun networkError(e: IOException, host: String): String = when (e) {
        is ConnectException -> "Couldn't reach $host. Is the AI app running and reachable from this phone?"
        is UnknownHostException -> "The address $host couldn't be found."
        is SocketTimeoutException -> "The AI took too long to answer."
        else -> e.message ?: "The AI request failed."
    }

    private fun httpError(status: Int, host: String, body: JSONObject?): String {
        if (status == 401 || status == 403) return "The API key was rejected. Check it and try again."
        if (status == 404) return "The server at $host doesn't know this model or address."
        if (status == 429) return "The provider is rate-limiting requests or your quota is used up. Try again later."
        val apiMsg = body?.optJSONObject("error")?.optString("message")?.ifBlank { null }
            ?: body?.optString("message")?.ifBlank { null }
            ?: body?.optString("error")?.takeIf { it.isNotBlank() && !it.startsWith("{") }
        return if (apiMsg != null) "The AI provider returned an error: $apiMsg" else "The AI provider returned HTTP $status."
    }

    // ── Tasks (same prompts as the desktop) ──────────────────────────────────

    private const val PLAIN = "Answer with plain text only: no Markdown, no headings, no code fences."
    val rewrites = linkedMapOf(
        "improve" to "Improve the clarity, flow and grammar. Keep the meaning, tone and length about the same.",
        "shorter" to "Make it noticeably shorter and more direct. Keep every important fact and request.",
        "formal" to "Make it more formal and professional.",
        "friendly" to "Make it warmer and more friendly, without becoming long.",
        "fix" to "Fix spelling, grammar and punctuation only. Change nothing else.",
    )

    private fun clip(s: String?): String {
        val t = s.orEmpty().trim()
        return if (t.length > MAX_INPUT_CHARS) t.take(MAX_INPUT_CHARS) + "\n[…]" else t
    }

    fun summarize(from: String?, subject: String?, text: String?) = Task(
        system = "You summarize emails for a busy reader. Use the language the email is written in. Start with one sentence saying what the email is about, then list up to four short points with the key facts, dates, amounts and anything the reader is asked to do, each on its own line starting with \"• \". $PLAIN",
        prompt = "From: ${from ?: "unknown"}\nSubject: ${subject ?: "(no subject)"}\n\n${clip(text)}",
        maxTokens = 400,
    )

    fun reply(me: String?, from: String?, subject: String?, text: String?, notes: String?) = Task(
        system = "You write email replies on behalf of ${me ?: "the user"}. Write only the body of the reply: no subject line, no signature, no quoted original. Use the language of the original email unless the notes ask for another. Match the tone of the original. $PLAIN",
        prompt = "Original email from ${from ?: "unknown"} with subject \"${subject.orEmpty()}\":\n\n${clip(text)}\n\n" +
            (notes?.trim()?.takeIf { it.isNotEmpty() }?.let { "What my reply should say: $it" } ?: "Write a helpful, concise reply."),
    )

    fun write(me: String?, subject: String?, instruction: String) = Task(
        system = "You write emails on behalf of ${me ?: "the user"}. Write only the body: no subject line and no signature. Use the language of the instructions. $PLAIN",
        prompt = (subject?.takeIf { it.isNotBlank() }?.let { "Subject: $it\n" } ?: "") + "Write an email that does this: ${clip(instruction)}",
    )

    fun rewrite(mode: String, text: String): Task {
        val how = rewrites[mode] ?: throw MailException("Say how the text should change")
        return Task(system = "You edit email text. $how Keep the language of the text. Return only the rewritten text. $PLAIN", prompt = clip(text))
    }
}
