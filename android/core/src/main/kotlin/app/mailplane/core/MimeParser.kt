package app.mailplane.core

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.Base64
import javax.mail.Address
import javax.mail.Message
import javax.mail.Multipart
import javax.mail.Part
import javax.mail.internet.InternetAddress
import javax.mail.internet.MimeMessage
import javax.mail.internet.MimeUtility

/** Turns a javax.mail message into a [MessageBody] (text/html alternatives, attachments, inline images). */
object MimeParser {
    private const val MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024

    private class Walk {
        var text: String? = null
        var html: String? = null
        val attachments = mutableListOf<AttachmentInfo>()
        val inlineImages = mutableMapOf<String, String>() // content-id → data: URI
        var index = 0
    }

    fun parse(message: Message): MessageBody {
        val walk = Walk()
        visit(message, walk)
        var html = walk.html
        if (html != null && walk.inlineImages.isNotEmpty()) {
            for ((cid, dataUri) in walk.inlineImages) html = html!!.replace("cid:$cid", dataUri, ignoreCase = true)
        }
        val mime = message as? MimeMessage
        return MessageBody(
            subject = message.subject ?: "",
            from = message.from?.firstOrNull()?.toMailAddress(),
            to = message.getRecipients(Message.RecipientType.TO).toMailAddresses(),
            cc = message.getRecipients(Message.RecipientType.CC).toMailAddresses(),
            date = (message.sentDate ?: message.receivedDate)?.toInstant(),
            text = walk.text,
            html = html,
            attachments = walk.attachments,
            messageId = mime?.messageID,
            references = mime?.getHeader("References", " "),
            unsubscribe = unsubscribeTarget(mime?.getHeader("List-Unsubscribe", ",")),
        )
    }

    /** Returns the bytes of the attachment with the given walk index, or null. */
    fun attachmentBytes(message: Message, index: Int): ByteArray? {
        val walk = Walk()
        var found: ByteArray? = null
        fun find(part: Part) {
            if (found != null) return
            if (part.isMimeType("multipart/*")) {
                val mp = part.content as Multipart
                for (i in 0 until mp.count) find(mp.getBodyPart(i))
                return
            }
            // Same traversal as visit(): forwarded messages shown inline are walked into
            if (part.isMimeType("message/rfc822") && !isAttachment(part)) {
                find(part.content as Part)
                return
            }
            if (isAttachment(part)) {
                if (walk.index == index) found = part.inputStream.use { it.readAllBytesCompat() }
                walk.index++
            }
        }
        find(message)
        return found
    }

    private fun visit(part: Part, walk: Walk) {
        when {
            part.isMimeType("multipart/alternative") -> {
                val mp = part.content as Multipart
                // Later parts are the richer representations; visit all so both text and html are captured
                for (i in 0 until mp.count) visit(mp.getBodyPart(i), walk)
            }
            part.isMimeType("multipart/*") -> {
                val mp = part.content as Multipart
                for (i in 0 until mp.count) visit(mp.getBodyPart(i), walk)
            }
            part.isMimeType("message/rfc822") && !isAttachment(part) -> visit(part.content as Part, walk)
            isAttachment(part) -> {
                val name = decodeFileName(part.fileName) ?: "attachment"
                walk.attachments += AttachmentInfo(walk.index++, name, baseType(part.contentType), part.size.toLong().coerceAtLeast(0))
            }
            part.isMimeType("text/plain") && walk.text == null -> walk.text = part.content?.toString()
            part.isMimeType("text/html") && walk.html == null -> walk.html = part.content?.toString()
            part.isMimeType("image/*") -> inlineImage(part, walk)
        }
    }

    private fun isAttachment(part: Part): Boolean {
        if (part.isMimeType("multipart/*")) return false
        val disposition = part.disposition?.lowercase()
        if (disposition == Part.ATTACHMENT) return true
        if (disposition == Part.INLINE) return false
        // No disposition: a named non-text part (e.g. application/pdf) is an attachment
        return part.fileName != null && !part.isMimeType("text/*") && contentId(part) == null
    }

    private fun inlineImage(part: Part, walk: Walk) {
        val cid = contentId(part) ?: return
        if (part.size > MAX_INLINE_IMAGE_BYTES) return
        val bytes = part.inputStream.use { it.readAllBytesCompat() }
        walk.inlineImages[cid] = "data:${baseType(part.contentType)};base64," + Base64.getEncoder().encodeToString(bytes)
    }

    private fun contentId(part: Part): String? =
        (part as? javax.mail.internet.MimePart)?.contentID?.trim()?.removePrefix("<")?.removeSuffix(">")

    private fun baseType(contentType: String?): String =
        contentType?.substringBefore(';')?.trim()?.lowercase() ?: "application/octet-stream"

    private fun decodeFileName(name: String?): String? =
        name?.let { runCatching { MimeUtility.decodeText(it) }.getOrDefault(it) }

    private fun unsubscribeTarget(header: String?): String? {
        if (header.isNullOrBlank()) return null
        val targets = Regex("<([^>]+)>").findAll(header).map { it.groupValues[1].trim() }.toList()
        return targets.firstOrNull { it.startsWith("https://", ignoreCase = true) }
            ?: targets.firstOrNull { it.startsWith("mailto:", ignoreCase = true) }
    }

    private fun Address.toMailAddress(): MailAddress? = (this as? InternetAddress)?.let {
        MailAddress(it.personal?.takeIf { p -> p.isNotBlank() }, it.address ?: return null)
    }

    private fun Array<Address>?.toMailAddresses(): List<MailAddress> = this?.mapNotNull { it.toMailAddress() } ?: emptyList()

    // InputStream.readAllBytes needs API 33 on Android — keep a portable version
    private fun InputStream.readAllBytesCompat(): ByteArray {
        val out = ByteArrayOutputStream()
        copyTo(out)
        return out.toByteArray()
    }
}
