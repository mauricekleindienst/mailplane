package app.mailplane.android.sync

import android.Manifest
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import app.mailplane.android.MailplaneApplication
import app.mailplane.android.MainActivity
import app.mailplane.android.R
import app.mailplane.android.ui.tr
import app.mailplane.core.MessageSummary
import app.mailplane.core.OutgoingMessage
import app.mailplane.core.Subjects
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * New-mail notifications. Each message gets its own notification with
 * Archive / Mark read / Reply (inline reply via RemoteInput) — handled by
 * [NotificationActionReceiver] without opening the app.
 */
object Notifications {
    const val CHANNEL_ID = "new_mail"
    private const val GROUP = "app.mailplane.NEW_MAIL"

    private fun allowed(ctx: Context) = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun openIntent(ctx: Context, accountId: String): PendingIntent = PendingIntent.getActivity(
        ctx, accountId.hashCode(),
        Intent(ctx, MainActivity::class.java).putExtra(MainActivity.EXTRA_ACCOUNT_ID, accountId),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    fun notificationId(accountId: String, m: MessageSummary) = "$accountId:${m.folder}:${m.uid}".hashCode()

    /** A plain notification (e.g. "Back from snooze"). */
    fun show(ctx: Context, id: Int, accountId: String, title: String, text: String) {
        if (!allowed(ctx)) return
        val n = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title).setContentText(text)
            .setContentIntent(openIntent(ctx, accountId)).setAutoCancel(true)
            .build()
        runCatching { NotificationManagerCompat.from(ctx).notify(id, n) }
    }

    /** One notification per new message (newest five), grouped under a summary. */
    fun newMail(ctx: Context, accountId: String, email: String, messages: List<MessageSummary>) {
        if (!allowed(ctx) || messages.isEmpty()) return
        val nm = NotificationManagerCompat.from(ctx)
        messages.take(5).forEach { m ->
            val id = notificationId(accountId, m)
            fun action(kind: String) = PendingIntent.getBroadcast(
                ctx, "$kind:$id".hashCode(),
                Intent(ctx, NotificationActionReceiver::class.java).setAction(kind)
                    .putExtra(EXTRA_ACCOUNT, accountId).putExtra(EXTRA_FOLDER, m.folder).putExtra(EXTRA_UID, m.uid)
                    .putExtra(EXTRA_ID, id),
                // Inline reply writes into the intent, so that one must stay mutable
                if (kind == ACTION_REPLY) PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                else PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val reply = NotificationCompat.Action.Builder(0, tr("Reply"), action(ACTION_REPLY))
                .addRemoteInput(RemoteInput.Builder(KEY_REPLY_TEXT).setLabel(tr("Reply…")).build())
                .setAllowGeneratedReplies(true)
                .build()
            val n = NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(m.fromName)
                .setContentText(m.subject)
                .setSubText(email)
                .setWhen(m.date?.toEpochMilli() ?: System.currentTimeMillis())
                .setGroup(GROUP)
                .setContentIntent(openIntent(ctx, accountId))
                .setAutoCancel(true)
                .addAction(0, tr("Archive"), action(ACTION_ARCHIVE))
                .addAction(0, tr("Mark read"), action(ACTION_READ))
                .addAction(reply)
                .build()
            runCatching { nm.notify(id, n) }
        }
        if (messages.size > 1) {
            val style = NotificationCompat.InboxStyle().setSummaryText(email)
            messages.take(5).forEach { style.addLine("${it.fromName}  ${it.subject}") }
            val summary = NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(tr("${messages.size} new messages"))
                .setStyle(style)
                .setGroup(GROUP).setGroupSummary(true)
                .setContentIntent(openIntent(ctx, accountId)).setAutoCancel(true)
                .build()
            runCatching { nm.notify(accountId.hashCode(), summary) }
        }
    }

    const val ACTION_ARCHIVE = "app.mailplane.action.ARCHIVE"
    const val ACTION_READ = "app.mailplane.action.READ"
    const val ACTION_REPLY = "app.mailplane.action.REPLY"
    const val EXTRA_ACCOUNT = "account"
    const val EXTRA_FOLDER = "folder"
    const val EXTRA_UID = "uid"
    const val EXTRA_ID = "notificationId"
    const val KEY_REPLY_TEXT = "replyText"
}

/** Archive / Mark read / Reply straight from a notification. */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as MailplaneApplication
        val accountId = intent.getStringExtra(Notifications.EXTRA_ACCOUNT) ?: return
        val folder = intent.getStringExtra(Notifications.EXTRA_FOLDER) ?: return
        val uid = intent.getLongExtra(Notifications.EXTRA_UID, -1).takeIf { it >= 0 } ?: return
        val id = intent.getIntExtra(Notifications.EXTRA_ID, 0)
        val account = app.accounts.accounts.value.firstOrNull { it.id == accountId } ?: return
        val replyText = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifications.KEY_REPLY_TEXT)?.toString()
        val m = MessageSummary(uid, folder, "", "", "", "", null, seen = false, flagged = false, hasAttachments = false, accountId = accountId)
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                when (intent.action) {
                    Notifications.ACTION_ARCHIVE -> app.mail.archive(account, m)
                    Notifications.ACTION_READ -> app.mail.setSeen(account, m, true)
                    Notifications.ACTION_REPLY -> if (!replyText.isNullOrBlank()) {
                        val body = app.mail.body(account, m)
                        val to = body.from?.email ?: throw IllegalStateException("No sender")
                        app.mail.send(account, OutgoingMessage(
                            to = to, subject = Subjects.reply(body.subject), text = replyText,
                            inReplyTo = body.messageId,
                            references = listOfNotNull(body.references, body.messageId).joinToString(" ").ifBlank { null },
                        ))
                        app.mail.setSeen(account, m, true)
                    }
                }
                NotificationManagerCompat.from(context).cancel(id)
            } catch (e: Exception) {
                Notifications.show(context, id, accountId, "Mailplane", e.message ?: tr("Something went wrong"))
            } finally {
                pending.finish()
            }
        }
    }
}
