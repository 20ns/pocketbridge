package dev.pocketbridge

import android.content.Context
import android.content.SharedPreferences
import java.util.concurrent.CancellationException
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class Store internal constructor(private val prefs: SharedPreferences) {
    constructor(context: Context) : this(context.getSharedPreferences("pocketbridge", Context.MODE_PRIVATE))
    private var generation = 0
    @Synchronized fun session() = generation
    fun get(key: String) = prefs.getString(key, "").orEmpty()
    fun put(key: String, value: String) { prefs.edit().putString(key, value).apply() }
    fun remove(key: String) { prefs.edit().remove(key).apply() }
    @Synchronized fun commit(key: String, value: String, session: Int) {
        requireSession(session)
        check(prefs.edit().putString(key, value).commit()) { "Could not save prompt delivery state." }
    }
    @Synchronized fun completePrompt(id: String, prompt: PendingPrompt, session: Int, accepted: Boolean) {
        requireSession(session)
        val edit = prefs.edit().remove("pending:$id")
        if (accepted && get("draft:$id").trim() == prompt.text) edit.remove("draft:$id")
        if (accepted) edit.remove("draftChat:$id")
        if (accepted) edit.remove("options:$id")
        check(edit.commit()) { "Could not save prompt delivery state." }
    }
    @Synchronized fun removeChat(id: String) {
        prefs.edit()
            .remove("messages:$id")
            .remove("draft:$id")
            .remove("pending:$id")
            .remove("draftChat:$id")
            .remove("options:$id")
            .apply()
    }
    private fun requireSession(session: Int) {
        if (session != generation) throw CancellationException("Pairing changed.")
    }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return store.getKey("pocketbridge-pairing", null) as? SecretKey ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("pocketbridge-pairing", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    fun token(): String {
        val encrypted = get("token")
        if (encrypted.isEmpty()) return ""
        val parts = encrypted.split(':')
        return Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
            String(doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
        }
    }
    @Synchronized fun savePair(base: String, token: String, session: Int) {
        requireSession(session)
        val encrypted = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, key())
            val data = doFinal(token.toByteArray())
            Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(data, Base64.NO_WRAP)
        }
        check(prefs.edit().clear().putString("base", base).putString("token", encrypted).commit())
        generation++
    }
    @Synchronized fun clear() { generation++; prefs.edit().clear().apply() }
}
