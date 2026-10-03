# PocketBridge Android

Native phone client for your PocketBridge Mac service. Kotlin, Jetpack Compose, Android 16 target API 36. Minimum Android 8 API 26.

## Build

Use Android Studio's bundled JDK 21 and an Android SDK with platform 36. Set `sdk.dir` in untracked `local.properties`, or export `ANDROID_HOME`.

```sh
./gradlew assembleDebug testDebugUnitTest lintDebug
```

Install `app/build/outputs/apk/debug/app-debug.apk` on your Android phone. Open Tailscale on both devices, open the Mac client's pairing screen, then scan the QR using your phone camera or enter its HTTPS address and one-time code in PocketBridge. The app stores its own credential with Android Keystore encryption. It never reads Claude credentials. Android backups are disabled.

Production pairing should use the Mac's private HTTPS Tailscale Serve URL. HTTP is accepted only for localhost, the emulator gateway, and Tailscale addresses where the tunnel encrypts traffic. Redirects are disabled, and credentials are only sent in the authorization header.

## Behaviour

The Mac continues Claude tasks when the phone locks or disconnects. The app receives SSE change notifications only while foregrounded, coalesces snapshot fetches at 250 milliseconds, and reconciles on every reconnection. It caches recent chats and selected messages for offline reading. Prompt drafts use native asynchronous preferences. Unconfirmed delivery UUIDs are committed on an IO thread before any HTTP send, and survive app restarts. Snapshot serialization and disk writes stay off the typing path. If a response is lost, Retry sends the same ID, permission mode, model and effort. HTTP 5xx responses preserve the ID too. HTTP mutations are single-attempt, including 503 Retry-After responses. GET snapshots and streams can recover a stale pooled connection. Mutations open a fresh connection, so idle keepalive sockets cannot spoil the first tap. A definitive 4xx rejection keeps the draft editable. The Mac's durable idempotency ledger prevents duplicate execution. Confirmed deletion commits the cached list, selected chat and delivery-state removal together, serialized with snapshot reconciliation.

Projects open first. Select a project to start or reopen one of its chats. Conversation Back returns to Recent chats. Only managed chats appear. Project folders are discovered from existing Claude Code session metadata without importing old chats; new folders can be registered in the Mac client. Latest covers the past seven days; All includes older and unused folders. Project lists offer Newest, Oldest and Name sorting; recent chats offer Newest and Oldest. New chat remains a local draft until the first prompt is sent. Typed drafts and unconfirmed first prompts stay in Recent chats; untouched blank drafts do not. Draft previews use the prompt text. Local unsent drafts can be deleted offline; an unconfirmed delivery remains protected until the Mac resolves it. Long press or the chat menu offers Rename and Delete; active chats must be stopped before deletion. Bypass permissions is the default. The Options sheet chooses permission mode, model and effort for the next prompt between turns; Haiku uses default effort. A new prompt during work can be drafted but must wait for the turn to finish or be stopped.

Markdown supports paragraphs, headings, nested lists, quotes, rules, bold, italic, links (web addresses only), inline code, fenced code with Copy, and pipe tables as aligned scrollable columns. Raw HTML stays text. Consecutive tool activity collapses into one "N steps" row; each step expands to its command or input and result. Questions use native radio/checkbox options with a free-text choice, preserve unfinished choices and text across activity recreation, plan approvals render the plan, and permission requests show the full wrapped command before Allow.

A lost connection reconciles automatically and shows a persistent banner with Retry; one-off failures appear as snackbars. Unconfirmed delivery appears below its bubble with Retry. Status uses one vocabulary on both clients: Ready, Working, Needs your answer, Stopping, Interrupted, Failed.

Settings offers Check latest, Download and Install for public GitHub APK releases. Downloads use a separate unauthenticated client, bounded streaming and SHA256 verification. Before Android installation, the APK must match this app's package and signing certificate and have a newer version code. Installation is confirmed by Android; update in place to preserve pairing.

## Checks

Fifty JVM tests cover address boundaries, authorization, SSE cursor and headers, error responses, cancellation, stale GET recovery, single-attempt mutations, disconnect/pair races, persisted prompt ID/text/mode/model/effort, draft recovery and deduplication, durable deletion, project activity ordering, bounded GitHub update streams, release selection, tool activity grouping, and Markdown parsing and link safety. `lintDebug` checks Android platform usage. Emulator and real-device findings belong in the root test report; no physical S25 Ultra was attached during development.
