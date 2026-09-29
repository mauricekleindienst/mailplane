package app.mailplane.android.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.mailplane.android.BuildConfig
import app.mailplane.core.Versions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** A newer Mailplane release on GitHub with an APK to install. */
data class AppRelease(val version: String, val apkUrl: String, val pageUrl: String, val notes: String)

sealed interface UpdateState {
    data object Idle : UpdateState
    data object Checking : UpdateState
    data object UpToDate : UpdateState
    data class Available(val release: AppRelease) : UpdateState
    data class Downloading(val release: AppRelease, val percent: Int) : UpdateState
    data class Failed(val message: String, val release: AppRelease? = null) : UpdateState
}

/**
 * Updates straight from GitHub Releases: checks the latest release, downloads
 * its APK into the app's cache and hands it to the system installer.
 * Android asks the user to confirm every install, and to allow Mailplane to
 * install apps the first time.
 */
class AppUpdater(private val context: Context) {
    private val prefs = context.getSharedPreferences("updates", Context.MODE_PRIVATE)
    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state: StateFlow<UpdateState> = _state

    /** Checks at most once a day unless [force] is set. */
    suspend fun check(force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - prefs.getLong("lastCheck", 0) < DAY_MS) return
        _state.value = UpdateState.Checking
        _state.value = try {
            val release = withContext(Dispatchers.IO) { fetchLatest() }
            prefs.edit().putLong("lastCheck", now).apply()
            if (release != null && Versions.isNewer(release.version, BuildConfig.VERSION_NAME)) UpdateState.Available(release)
            else UpdateState.UpToDate
        } catch (e: Exception) {
            UpdateState.Failed("Couldn't check for updates: ${e.message ?: "network error"}")
        }
    }

    fun dismissed(release: AppRelease) = prefs.getString("dismissed", null) == release.version
    fun dismiss(release: AppRelease) { prefs.edit().putString("dismissed", release.version).apply() }

    /** Downloads the APK and opens the system installer. */
    suspend fun install(release: AppRelease) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            // First time: the user has to allow installs from Mailplane
            context.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            _state.value = UpdateState.Available(release)
            return
        }
        try {
            val apk = withContext(Dispatchers.IO) { download(release) }
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", apk)
            context.startActivity(
                Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            _state.value = UpdateState.Available(release)
        } catch (e: Exception) {
            _state.value = UpdateState.Failed("The download failed: ${e.message ?: "network error"}", release)
        }
    }

    private fun fetchLatest(): AppRelease? {
        val conn = (URL(LATEST_URL).openConnection() as HttpURLConnection).apply {
            setRequestProperty("Accept", "application/vnd.github+json")
            setRequestProperty("User-Agent", "Mailplane-Android")
            connectTimeout = 15_000
            readTimeout = 15_000
        }
        try {
            if (conn.responseCode == 404) return null          // nothing published yet
            if (conn.responseCode !in 200..299) throw IllegalStateException("GitHub answered HTTP ${conn.responseCode}")
            val json = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
            val assets = json.optJSONArray("assets")
            var apkUrl: String? = null
            for (i in 0 until (assets?.length() ?: 0)) {
                val a = assets!!.getJSONObject(i)
                if (a.optString("name").endsWith(".apk")) { apkUrl = a.optString("browser_download_url"); break }
            }
            return AppRelease(
                version = json.optString("tag_name").removePrefix("v"),
                apkUrl = apkUrl ?: return null,
                pageUrl = json.optString("html_url"),
                notes = json.optString("body").take(2000),
            )
        } finally {
            conn.disconnect()
        }
    }

    private fun download(release: AppRelease): File {
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }                  // keep only the newest APK
        val out = File(dir, "Mailplane-${release.version}.apk")
        var url = URL(release.apkUrl)
        var conn: HttpURLConnection
        // GitHub redirects release downloads to its CDN
        var hops = 0
        while (true) {
            conn = (url.openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", "Mailplane-Android")
                connectTimeout = 15_000
                readTimeout = 30_000
            }
            val code = conn.responseCode
            if (code in 300..399 && hops++ < 5) { url = URL(url, conn.getHeaderField("Location")); conn.disconnect(); continue }
            if (code !in 200..299) throw IllegalStateException("HTTP $code")
            break
        }
        val total = conn.contentLengthLong
        conn.inputStream.use { input ->
            out.outputStream().use { output ->
                val buf = ByteArray(64 * 1024)
                var done = 0L
                var lastPercent = -1
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    output.write(buf, 0, n)
                    done += n
                    val percent = if (total > 0) ((done * 100) / total).toInt() else 0
                    if (percent != lastPercent) { lastPercent = percent; _state.value = UpdateState.Downloading(release, percent) }
                }
            }
        }
        conn.disconnect()
        return out
    }

    companion object {
        private const val LATEST_URL = "https://api.github.com/repos/mauricekleindienst/mailplane/releases/latest"
        private const val DAY_MS = 24L * 60 * 60 * 1000
    }
}
