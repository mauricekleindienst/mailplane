package app.mailplane.android.sync

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import app.mailplane.android.MailplaneApplication
import app.mailplane.android.ui.tr
import app.mailplane.core.SnoozedRef
import java.time.Duration
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Brings a snoozed message back: WorkManager keeps the schedule across reboots,
 * the message waits in the server's "Snoozed" folder and returns unread.
 */
class UnsnoozeWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext as MailplaneApplication
        val accountId = inputData.getString(KEY_ACCOUNT) ?: return Result.failure()
        val account = app.accounts.accounts.value.firstOrNull { it.id == accountId } ?: return Result.success()
        val ref = SnoozedRef(inputData.getString(KEY_FOLDER) ?: return Result.failure(), inputData.getString(KEY_MESSAGE_ID) ?: return Result.failure())
        val back = runCatching { app.mail.unsnooze(account, ref, inputData.getString(KEY_RETURN_TO) ?: "INBOX") }
            .getOrElse { return if (runAttemptCount < 12) Result.retry() else Result.failure() }
        if (back) {
            Notifications.show(
                applicationContext, id = (accountId + ref.messageId).hashCode(), accountId = accountId,
                title = tr("Back from snooze"),
                text = listOfNotNull(inputData.getString(KEY_FROM), inputData.getString(KEY_SUBJECT)).joinToString(" — "),
            )
        }
        return Result.success()
    }

    companion object {
        private const val KEY_ACCOUNT = "account"
        private const val KEY_FOLDER = "folder"
        private const val KEY_MESSAGE_ID = "messageId"
        private const val KEY_RETURN_TO = "returnTo"
        private const val KEY_SUBJECT = "subject"
        private const val KEY_FROM = "from"

        fun schedule(context: Context, accountId: String, ref: SnoozedRef, returnTo: String, until: Instant, subject: String, from: String) {
            val delay = Duration.between(Instant.now(), until).toMillis().coerceAtLeast(0)
            val request = OneTimeWorkRequestBuilder<UnsnoozeWorker>()
                .setInitialDelay(delay, TimeUnit.MILLISECONDS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setInputData(workDataOf(
                    KEY_ACCOUNT to accountId, KEY_FOLDER to ref.folder, KEY_MESSAGE_ID to ref.messageId,
                    KEY_RETURN_TO to returnTo, KEY_SUBJECT to subject, KEY_FROM to from,
                ))
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("unsnooze:$accountId:${ref.messageId}", ExistingWorkPolicy.REPLACE, request)
        }
    }
}
