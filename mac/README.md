# PocketBridge on your Mac

The service runs your official Claude Code CLI in registered project folders. It also adds folders it finds from Claude Code session metadata on this Mac. Those older conversations are not imported. Discovery reads each Claude project directory on its own: the session index and the current session files. It checks at most 8 of the newest session files in that directory, and the first 256KB of each, then stops once that directory's folder is known. A project with hundreds of chats still leaves room for an older folder. A main session under `.claude/worktrees` is included. Sidechain sessions, agent transcripts, subagent files, and Claude desktop scratch workspaces are skipped. Project folders named scratchpad or subagents are included when their metadata describes a main session. The Mac keeps chats and delivery state locally. Phone and browser disconnections do not stop a task. Start managed chats here or on Android. An unrelated terminal session stays separate.

## Run

Install Node.js 22 or newer, PNPM and the official Claude Code CLI. Run `claude` once in Terminal and sign in through Claude's own login. PocketBridge does not read or copy Claude credentials.

From `mac/`, run `pnpm install`. Double-click `launcher/PocketBridge.command` to start the service and open the local browser client. Register a folder, create a chat and send a prompt. Bypass permissions is the default. Auto availability depends on your installed Claude configuration. Changing a mode never silently falls back to another mode.

The launcher uses your installed Node executable. Installing startup records absolute executable paths, so launchd does not depend on an interactive shell or an open Terminal window.

When rebuilding from source, copy `android/app/build/outputs/apk/release/app-release.apk` to `mac/public/PocketBridge.apk` to enable the built-in phone download link. Use the personal signing key described in the root README; the installed build already includes the signed APK.

## Connect Android privately

1. Install Tailscale on the Mac and Android phone. Sign in to the same tailnet.
2. Double-click `launcher/Setup private connection.command`. It locates either the Tailscale CLI or the installed Mac app, starts private Serve and saves your HTTPS address. It tells you how to finish Tailscale sign-in or VPN approval if needed. Use **Serve**, not **Funnel**. Funnel publishes a service to the internet.
3. The helper restarts an installed idle service. If PocketBridge is running manually or has active tasks, finish those tasks and restart it before pairing. For an installed service, run `launchctl kickstart -k gui/$(id -u)/com.pocketbridge.mac`.
4. Download the Android APK from this release, or open your private HTTPS address followed by `/PocketBridge.apk` in your phone browser. Install it. Open the local Mac client, click **Connect phone**, then **Create pairing code**. Scan the QR with your phone camera, or enter the address and code in PocketBridge.

If you already configured private Serve, you can save its address with `mac/scripts/configure-url.sh https://your-mac.your-tailnet.ts.net` from the project root, then restart PocketBridge.

The app stores its connection until you clear its data or revoke its token. The short-lived pairing code is used once. Claude login is independent and may need renewal. Tailscale device key expiry can be disabled for your own two devices if you want to avoid scheduled reconnection. Keep the Mac connected to power, online, awake and logged in with its lid open.

## Start at login

Double-click `launcher/Install startup.command`. It installs a user LaunchAgent at `~/Library/LaunchAgents/com.pocketbridge.mac.plist`, starts PocketBridge and restarts it if it exits. This runs after macOS login, not before unlocking FileVault. Moving the project requires running the installer again.

Use `launcher/Remove startup.command` to stop and remove the LaunchAgent. It leaves chats, pairing and settings intact.

The service normally saves data in `~/Library/Application Support/PocketBridge`. `config.json` in that directory keeps settings across updates:

```json
{
  "publicUrl": "https://your-mac.your-tailnet.ts.net",
  "claudePath": "/Users/you/.local/bin/claude",
  "port": 8787,
  "keepAwake": true
}
```

With `keepAwake` enabled, `caffeinate -s` prevents system sleep while on AC power. Set it to `false` and restart to turn this off. It does not bypass a closed lid. `POCKETBRIDGE_DATA_DIR`, `POCKETBRIDGE_PUBLIC_URL`, `POCKETBRIDGE_CLAUDE_PATH`, `POCKETBRIDGE_PORT` and `POCKETBRIDGE_CLAUDE_PROJECTS_DIR` environment variables override the corresponding settings. The projects directory defaults to `~/.claude/projects`.

Lifecycle logs are `service.log` and `service-error.log`. On startup, logs larger than 5 MB move to a single `.previous` file. Chat text is kept in SQLite and Claude's conversation files, not copied into those logs.

## Recovery and boundaries

- Pending prompts use a persistent delivery ID. After a failed request, Retry reuses that ID, so a lost acknowledgement does not start another task.
- Streaming events are hints to fetch saved state. Reconnect fetches current chats and messages, then resumes events. The browser retains unsent drafts on that device.
- A second service cannot take over the same data directory or interrupt the first service. A service restart marks active turns interrupted. It never automatically repeats file edits or commands. Inspect the project and continue with a new prompt.
- Stop interrupts current work and cleans up remaining processes in that Claude turn's process group. Completed edits remain. Explicitly detached processes in another group are outside that cleanup.
- Editing files manually does not break chat sync. Editing the same file simultaneously with Claude can still produce a filesystem conflict.
- The service binds to loopback. Tailscale Serve supplies private remote HTTPS access. API tokens are never put in a URL. The browser gets its token only from a same-origin loopback bootstrap. Do not expose port 8787 publicly or enable arbitrary CORS.
- Bypass permissions gives Claude broad access within your Mac account. Use it for your own paired devices and trusted tasks.

The app wraps an unmodified official CLI. It does not guarantee Anthropic's approval of this controller or permanent subscription authentication. Review Anthropic's current terms before sharing this app with others.

## Checks

Run the 29 service and browser-helper tests with `pnpm test` from `mac/`. Browser stream parsing and safe text formatting checks are also available directly:

```sh
node --test mac/scripts/*.test.mjs
```

That command runs from the project root. Physical phone networking, sleep behaviour and real account permissions still need a device trial.
