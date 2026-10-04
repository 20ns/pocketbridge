package dev.pocketbridge

import android.annotation.SuppressLint
import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView

/**
 * The platform's own haptic vocabulary. View.performHapticFeedback honours the system's touch feedback setting;
 * older Android versions get the nearest constant they have.
 */
enum class Haptic { Confirm, Reject, ToggleOn, ToggleOff, LongPress, Tick, Threshold, KeyTap }

// Each newer constant is only returned when [sdk] says the device has it.
@SuppressLint("InlinedApi")
fun hapticConstant(haptic: Haptic, sdk: Int = Build.VERSION.SDK_INT): Int = when (haptic) {
    Haptic.Confirm -> if (sdk >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
    Haptic.Reject -> if (sdk >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
    Haptic.ToggleOn -> if (sdk >= 34) HapticFeedbackConstants.TOGGLE_ON else HapticFeedbackConstants.CLOCK_TICK
    Haptic.ToggleOff -> if (sdk >= 34) HapticFeedbackConstants.TOGGLE_OFF else HapticFeedbackConstants.CLOCK_TICK
    Haptic.LongPress -> HapticFeedbackConstants.LONG_PRESS
    Haptic.Tick -> HapticFeedbackConstants.CLOCK_TICK
    Haptic.Threshold -> if (sdk >= 34) HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE else HapticFeedbackConstants.CLOCK_TICK
    Haptic.KeyTap -> HapticFeedbackConstants.KEYBOARD_TAP
}

@Stable class Haptics(private val view: View) {
    fun perform(haptic: Haptic) { view.performHapticFeedback(hapticConstant(haptic)) }
    fun toggle(on: Boolean) = perform(if (on) Haptic.ToggleOn else Haptic.ToggleOff)
}

@Composable fun rememberHaptics(): Haptics {
    val view = LocalView.current
    return remember(view) { Haptics(view) }
}

/** Pull to refresh that ticks once as a pull passes the point where letting go refreshes. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable fun RefreshBox(refreshing: Boolean, onRefresh: () -> Unit, modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    val state = rememberPullToRefreshState()
    val haptics = rememberHaptics()
    val busy by rememberUpdatedState(refreshing)
    // A refresh started elsewhere (Retry) also moves the indicator; only a pull by hand ticks.
    LaunchedEffect(state) { snapshotFlow { state.distanceFraction >= 1f }.collect { armed -> if (armed && !busy) haptics.perform(Haptic.Threshold) } }
    PullToRefreshBox(refreshing, onRefresh, modifier, state = state, content = content)
}
