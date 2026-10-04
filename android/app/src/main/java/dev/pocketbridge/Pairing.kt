package dev.pocketbridge

import android.Manifest
import android.content.Intent
import android.os.Build
import android.text.format.DateUtils
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.json.JSONObject

@Composable fun Pairing(model: BridgeModel) {
    val focus = LocalFocusManager.current
    val colors = MaterialTheme.colorScheme
    val ready = !model.busy && model.pairUrl.isNotBlank() && model.pairCode.isNotBlank()
    val connect = { if (ready) { focus.clearFocus(); model.pair() } }
    val field = RoundedCornerShape(Corners.groupInner * 4)
    Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = Spacing.xxl, vertical = Spacing.xxxl)) {
        Spacer(Modifier.height(Spacing.huge))
        Box(Modifier.size(56.dp).background(colors.primaryContainer, RoundedCornerShape(Corners.groupOuter)), contentAlignment = Alignment.Center) {
            Icon(PocketIcons.Laptop, null, Modifier.size(28.dp), tint = colors.onPrimaryContainer)
        }
        Spacer(Modifier.height(Spacing.xxl))
        Text("Pair with your Mac", Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(Spacing.sm))
        Text("In PocketBridge on your Mac, choose Connect phone. Scan its QR code, or enter the address and code.", style = MaterialTheme.typography.bodyLarge, color = colors.onSurfaceVariant)
        Spacer(Modifier.height(Spacing.xxxl))
        OutlinedTextField(
            model.pairUrl, { model.pairUrl = it }, Modifier.fillMaxWidth(), shape = field,
            label = { Text("Mac address") }, placeholder = { Text("https://mac.tailnet.ts.net") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false, imeAction = ImeAction.Next),
        )
        Spacer(Modifier.height(Spacing.md))
        OutlinedTextField(
            model.pairCode, { model.pairCode = it.uppercase().filter { c -> !c.isWhitespace() } }, Modifier.fillMaxWidth(), shape = field,
            label = { Text("Pairing code") }, supportingText = { Text("Valid for 10 minutes") }, singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, keyboardType = KeyboardType.Ascii, autoCorrectEnabled = false, imeAction = ImeAction.Go),
            keyboardActions = KeyboardActions(onGo = { connect() }),
        )
        if (model.error.isNotEmpty()) Notice(model.error, Modifier.padding(top = Spacing.md), isError = true)
        Spacer(Modifier.height(Spacing.xl))
        Button(onClick = connect, enabled = ready, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
            if (model.busy) { CircularProgressIndicator(Modifier.size(Sizes.smallIcon), strokeWidth = 2.dp, color = LocalContentColor.current); Spacer(Modifier.width(Spacing.md)); Text("Connecting…") }
            else Text("Connect", style = MaterialTheme.typography.titleSmall)
        }
        Spacer(Modifier.height(Spacing.xl))
        Text("Tailscale on both devices. Claude and Codex sign-in stays on the Mac.", style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
    }
}
