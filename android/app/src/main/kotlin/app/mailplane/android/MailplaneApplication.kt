package app.mailplane.android

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import app.mailplane.android.data.AccountRepository
import app.mailplane.android.data.AppSettings
import app.mailplane.android.data.AppUpdater
import app.mailplane.android.data.CredentialStore
import app.mailplane.android.data.MailRepository
import app.mailplane.android.sync.SyncWorker

/** Tiny service locator — the app is small enough not to need a DI framework. */
class MailplaneApplication : Application() {
    lateinit var settings: AppSettings private set
    lateinit var accounts: AccountRepository private set
    lateinit var mail: MailRepository private set
    lateinit var updater: AppUpdater private set
    /** Passwords and the AI key, encrypted with an Android Keystore key. */
    lateinit var credentials: CredentialStore private set

    override fun onCreate() {
        super.onCreate()
        settings = AppSettings(this)
        updater = AppUpdater(this)
        credentials = CredentialStore(this)
        accounts = AccountRepository(this, credentials)
        mail = MailRepository(accounts)

        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(SyncWorker.CHANNEL_ID, getString(R.string.channel_new_mail), NotificationManager.IMPORTANCE_DEFAULT)
        )
        app.mailplane.android.ui.I18n.apply(settings.language.value)
        SyncWorker.schedule(this)
    }
}
