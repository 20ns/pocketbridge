package dev.pocketbridge

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlin.random.Random
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Emits whenever Android's default network appears, goes, or becomes usable: Wi-Fi to cellular, airplane mode off,
 * Tailscale switched back on. Reconnect loops use it to try again at once instead of sitting out their backoff.
 */
fun networkChanges(context: Context): Flow<Unit> = callbackFlow {
    val manager = context.getSystemService(ConnectivityManager::class.java)
    val callback = object : ConnectivityManager.NetworkCallback() {
        private var validated: Boolean? = null
        override fun onAvailable(network: Network) { trySend(Unit) }
        override fun onLost(network: Network) { validated = null; trySend(Unit) }
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            val now = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            if (now != validated) { validated = now; trySend(Unit) }
        }
    }
    runCatching { manager.registerDefaultNetworkCallback(callback) }.onFailure { close() }
    awaitClose { runCatching { manager.unregisterNetworkCallback(callback) } }
}

/** The network Android sends traffic over now, to tell a real change from a callback about the same one. */
fun activeNetwork(context: Context): Network? = runCatching { context.getSystemService(ConnectivityManager::class.java).activeNetwork }.getOrNull()

/** Whether Android has any network to try. Without one, reconnect loops wait for [networkChanges] instead of counting failures. */
fun hasNetwork(context: Context) = runCatching {
    val manager = context.getSystemService(ConnectivityManager::class.java)
    manager.getNetworkCapabilities(manager.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
}.getOrDefault(true)

/**
 * Reconnect delays that double from [first] to [max], each spread by up to a fifth either way so a phone and a
 * browser don't knock on a restarting Mac in step. [reset] belongs after a stream has proven itself, not after any
 * one request worked, or a stream that fails at once would be retried every second for ever.
 */
class Backoff(private val first: Long, private val max: Long, private val random: Random = Random.Default) {
    private var next = first
    fun take(): Long {
        val base = next
        next = (next * 2).coerceAtMost(max)
        return base + (base * (random.nextDouble() * 0.4 - 0.2)).toLong()
    }
    fun reset() { next = first }
}

/** Waits up to [millis], or less when [wake] fires first. Answers whether it was woken. */
suspend fun Channel<Unit>.waitOr(millis: Long) = withTimeoutOrNull(millis) { receive() } != null
