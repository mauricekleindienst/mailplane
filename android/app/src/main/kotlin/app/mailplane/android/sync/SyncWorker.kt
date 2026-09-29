package app.mailplane.android.sync

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.mailplane.android.MailplaneApplication
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
                    Notifications.newMail(applicationContext, account.id, account.email, fresh)
                }
                app.settings.setLastSeenUid(account.id, latest)
            }
        }
        return Result.success()
    }

    companion object {
        const val CHANNEL_ID = Notifications.CHANNEL_ID
        private const val WORK_NAME = "mailplane-sync"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
