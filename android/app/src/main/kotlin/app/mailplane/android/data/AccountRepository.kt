package app.mailplane.android.data

import android.content.Context
import app.mailplane.core.Account
import app.mailplane.core.Security
import app.mailplane.core.ServerConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject

/** Accounts (without passwords) as JSON in private SharedPreferences. */
class AccountRepository(context: Context, private val credentials: CredentialStore) {
    private val prefs = context.getSharedPreferences("accounts", Context.MODE_PRIVATE)
    private val _accounts = MutableStateFlow(load())
    val accounts: StateFlow<List<Account>> = _accounts

    fun password(accountId: String): String? = credentials.get(accountId)

    fun add(account: Account, password: String) {
        credentials.put(account.id, password)
        save(_accounts.value.filterNot { it.id == account.id } + account)
    }

    fun update(account: Account) = save(_accounts.value.map { if (it.id == account.id) account else it })

    fun remove(accountId: String) {
        credentials.remove(accountId)
        save(_accounts.value.filterNot { it.id == accountId })
    }

    private fun save(list: List<Account>) {
        prefs.edit().putString(KEY, JSONArray(list.map { it.toJson() }).toString()).apply()
        _accounts.value = list
    }

    private fun load(): List<Account> = runCatching {
        val arr = JSONArray(prefs.getString(KEY, "[]"))
        (0 until arr.length()).map { arr.getJSONObject(it).toAccount() }
    }.getOrDefault(emptyList())

    private companion object {
        const val KEY = "accounts"

        fun ServerConfig.toJson() = JSONObject().put("host", host).put("port", port).put("security", security.name)
        fun JSONObject.toServer() = ServerConfig(getString("host"), getInt("port"), Security.valueOf(getString("security")))

        fun Account.toJson() = JSONObject()
            .put("id", id).put("name", name).put("email", email).put("username", username)
            .put("color", color).put("signature", signature)
            .put("imap", imap.toJson()).put("smtp", smtp.toJson())

        fun JSONObject.toAccount() = Account(
            id = getString("id"),
            name = optString("name"),
            email = getString("email"),
            imap = getJSONObject("imap").toServer(),
            smtp = getJSONObject("smtp").toServer(),
            username = optString("username", getString("email")),
            color = optString("color", "#5f8fc4"),
            signature = optString("signature", ""),
        )
    }
}
