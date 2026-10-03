package dev.pocketbridge

import android.content.Context
import android.content.SharedPreferences
import java.util.concurrent.CancellationException
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import org.json.JSONArray
import org.json.JSONObject
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class Store internal constructor(private val prefs: SharedPreferences) {
    constructor(context: Context) : this(context.getSharedPreferences("pocketbridge", Context.MODE_PRIVATE))
    private var generation = 0
    @Synchronized fun session() = generation
    fun get(key: String) = prefs.getString(key, "").orEmpty()
    fun localDraftIds() = prefs.all.keys.mapNotNull { key -> key.removePrefix("draftChat:").takeIf { key.startsWith("draftChat:") && it.isNotEmpty() } }
    fun put(key: String, value: String) { prefs.edit().putString(key, value).apply() }
    fun remove(key: String) { prefs.edit().remove(key).apply() }
    fun removePrefixed(prefix: String) {
        val keys = prefs.all.keys.filter { it.startsWith(prefix) }
        if (keys.isNotEmpty()) prefs.edit().apply { keys.forEach(::remove) }.apply()
    }
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
        // Images sent with this prompt leave the composer with it; ones added since stay.
        if (accepted && decodeAttachments(get("attachments:$id")).map { it.upload } == prompt.attachments) edit.remove("attachments:$id")
        check(edit.commit()) { "Could not save prompt delivery state." }
    }
    /** Confirmed server deletion. Blank-draft cleanup stays on [removeChat] so typing never waits on disk. */
    @Synchronized fun commitChatRemoval(id: String, session: Int) {
        requireSession(session)
        val edit = chatRemoval(id)
        val raw = get("state")
        val cached = if (raw.isEmpty()) null else runCatching {
            val state = JSONObject(raw)
            val kept = JSONArray()
            state.getJSONArray("chats").objects().forEach { if (it.optString("id") != id) kept.put(it) }
            state.put("chats", kept).toString()
        }.getOrNull()
        if (cached == null) edit.remove("state") else edit.putString("state", cached)
        if (get("selected") == id) edit.remove("selected")
        check(edit.commit()) { "Could not save chat deletion." }
    }
    @Synchronized fun removeChat(id: String) { chatRemoval(id).apply() }
    private fun chatRemoval(id: String) = prefs.edit().remove("messages:$id").remove("draft:$id").remove("pending:$id").remove("draftChat:$id").remove("options:$id").remove("attachments:$id")
    /** Prepared image files some composer still holds, so the outbox can drop the rest. */
    fun attachmentFiles(): Set<String> = prefs.all.filterKeys { it.startsWith("attachments:") }.values.flatMap { decodeAttachments(it as? String ?: "").map(Attachment::file) }.toSet()
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
