package app.mailplane.android.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

enum class ThemeMode { SYSTEM, LIGHT, DARK }

/** Same accent presets as the desktop app (Settings → Appearance). */
object Accents {
    data class Accent(val id: String, val label: String, val hex: Long)
    val all = listOf(
        Accent("lime", "Lime", 0xFFE2F47C),
        Accent("mint", "Mint", 0xFFB9EAD0),
        Accent("sky", "Sky", 0xFFBCDCF5),
        Accent("lilac", "Lilac", 0xFFD8D0F5),
        Accent("peach", "Peach", 0xFFF6CFB4),
        Accent("sand", "Sand", 0xFFE8DCBC),
        Accent("graphite", "Graphite", 0xFF3A3F3C),
    )
    val default = all.first()
}

class AppSettings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    private val _theme = MutableStateFlow(runCatching { ThemeMode.valueOf(prefs.getString("theme", "SYSTEM")!!) }.getOrDefault(ThemeMode.SYSTEM))
    val theme: StateFlow<ThemeMode> = _theme

    private val _accent = MutableStateFlow(prefs.getLong("accent", Accents.default.hex))
    val accent: StateFlow<Long> = _accent

    private val _notifications = MutableStateFlow(prefs.getBoolean("notifications", true))
    val notifications: StateFlow<Boolean> = _notifications

    private val _blockImages = MutableStateFlow(prefs.getBoolean("blockImages", true))
    val blockImages: StateFlow<Boolean> = _blockImages

    private val _compact = MutableStateFlow(prefs.getBoolean("compact", false))
    /** Compact list: one line per message, no avatars. */
    val compact: StateFlow<Boolean> = _compact

    private val _recentSearches = MutableStateFlow(prefs.getString("recentSearches", "").orEmpty().split('\n').filter { it.isNotBlank() })
    val recentSearches: StateFlow<List<String>> = _recentSearches

    fun setCompact(on: Boolean) { prefs.edit().putBoolean("compact", on).apply(); _compact.value = on }
    fun rememberSearch(q: String) {
        val list = (listOf(q) + _recentSearches.value.filter { it != q }).take(5)
        prefs.edit().putString("recentSearches", list.joinToString("\n")).apply()
        _recentSearches.value = list
    }
    fun clearRecentSearches() { prefs.edit().remove("recentSearches").apply(); _recentSearches.value = emptyList() }

    fun setTheme(mode: ThemeMode) { prefs.edit().putString("theme", mode.name).apply(); _theme.value = mode }
    fun setAccent(argb: Long) { prefs.edit().putLong("accent", argb).apply(); _accent.value = argb }
    fun setNotifications(on: Boolean) { prefs.edit().putBoolean("notifications", on).apply(); _notifications.value = on }
    fun setBlockImages(on: Boolean) { prefs.edit().putBoolean("blockImages", on).apply(); _blockImages.value = on }

    /** Highest inbox UID seen per account, for new-mail notifications. */
    fun lastSeenUid(accountId: String): Long = prefs.getLong("lastUid.$accountId", -1)
    fun setLastSeenUid(accountId: String, uid: Long) = prefs.edit().putLong("lastUid.$accountId", uid).apply()
}
