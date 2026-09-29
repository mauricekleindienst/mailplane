package app.mailplane.android

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import app.mailplane.android.data.AccountRepository
import app.mailplane.android.data.AppSettings
import app.mailplane.android.data.CredentialStore
import app.mailplane.android.data.MailRepository
import app.mailplane.android.sync.SyncWorker

/** Tiny service locator — the app is small enough not to need a DI framework. */
class MailplaneApplication : Application() {
    lateinit var settings: AppSettings private set
    lateinit var accounts: AccountRepository private set
    lateinit var mail: MailRepository private set

    override fun onCreate() {
        super.onCreate()
        settings = AppSettings(this)
        accounts = AccountRepository(this, CredentialStore(this))
        mail = MailRepository(accounts)

        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(SyncWorker.CHANNEL_ID, getString(R.string.channel_new_mail), NotificationManager.IMPORTANCE_DEFAULT)
        )
        SyncWorker.schedule(this)
    }
}
