package app.mailplane.android.sync

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.mailplane.android.MailplaneApplication
import app.mailplane.android.MainActivity
import app.mailplane.android.R
import java.util.concurrent.TimeUnit

/**
 * Checks every account's inbox in the background (every 15 min — Android's
 * minimum for periodic work) and posts a notification for new mail.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext as MailplaneApplication
        if (!app.settings.notifications.value) return Result.success()
        for (account in app.accounts.accounts.value) {
            runCatching {
                val latest = app.mail.latestInboxUid(account)
                val last = app.settings.lastSeenUid(account.id)
                if (last >= 0 && latest > last) {
                    val fresh = app.mail.messages(account, "INBOX", limit = 10).messages
                        .filter { it.uid > last && !it.seen }
                    if (fresh.isNotEmpty()) notify(account.id, account.email, fresh.map { it.fromName to it.subject })
                }
                app.settings.setLastSeenUid(account.id, latest)
            }
        }
        return Result.success()
    }

    private fun notify(accountId: String, email: String, items: List<Pair<String, String>>) {
        val ctx = applicationContext
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            android.os.Build.VERSION.SDK_INT >= 33
        ) return
        val open = PendingIntent.getActivity(
            ctx, accountId.hashCode(),
            Intent(ctx, MainActivity::class.java).putExtra(MainActivity.EXTRA_ACCOUNT_ID, accountId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val title = if (items.size == 1) items[0].first else "${items.size} new messages"
        val text = if (items.size == 1) items[0].second else items.joinToString(" · ") { it.first }
        val style = NotificationCompat.InboxStyle().setSummaryText(email)
        items.take(5).forEach { (from, subject) -> style.addLine("$from  $subject") }
        val notification = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(style)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        runCatching { NotificationManagerCompat.from(ctx).notify(accountId.hashCode(), notification) }
    }

    companion object {
        const val CHANNEL_ID = "new_mail"
        private const val WORK_NAME = "mailplane-sync"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
