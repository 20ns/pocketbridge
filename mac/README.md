# PocketBridge on your Mac

The service runs your official Claude Code or Codex CLI in registered project folders. It also adds folders it finds from Claude Code and Codex session metadata on this Mac. Those older conversations are not imported. Discovery reads each Claude project directory on its own: the session index and the current session files. It checks at most 8 of the newest session files in that directory, and the first 256KB of each, then stops once that directory's folder is known. A project with hundreds of chats still leaves room for an older folder. A main session under `.claude/worktrees` is included. Sidechain sessions, agent transcripts, subagent files, and Claude desktop scratch workspaces are skipped. For Codex it reads only the first line of the newest 300 files in `~/.codex/sessions` and skips subagent threads and Codex desktop task folders under `~/Documents/Codex/<date>`. Project folders named scratchpad or subagents are included when their metadata describes a main session. The Mac keeps chats and delivery state locally. Phone and browser disconnections do not stop a task. Start managed chats here or on Android. An unrelated terminal session stays separate.

## Run

Install Node.js 22.13 or newer, PNPM and the official Claude Code CLI. Run `claude` once in Terminal and sign in through Claude's own login. Codex is optional: install the official Codex CLI and run `codex login`. PocketBridge does not read or copy either CLI's credentials.

Plan usage comes from the same place: Claude's `get_usage` request (5-hour session, weekly and per-model weekly limits) and Codex's `account/rateLimits/read` (its windows and credit balance). The service asks at most once a minute and again after a turn ends. The browser header shows the fullest limit; click it for all of them. Claude and Codex chats also show how full their context window was after the last turn.

Model lists come from each CLI on this Mac. Claude's comes from its stream-json `initialize` handshake and Codex's from `codex app-server`. Neither call starts a turn or uses your quota. The service asks at startup and every 30 minutes, and keeps the last list it got.

From `mac/`, run `pnpm install`. Double-click `launcher/PocketBridge.command` to start the service and open the local browser client. Claude Code and Codex each have an on/off switch, in the browser sidebar under Agents and in the phone's Settings. Turn off the one you don't pay for: it stops being offered for new chats, its usage and model checks stop, and its folders are no longer discovered. Its chats stay readable and continue once it's back on.

Paste, drop or pick screenshots into the message box; they upload at once (large ones shrink to 2048 px) and go to Claude as image blocks or to Codex as image files. While a turn runs, Enter steers it: the message joins the running turn at the agent's next step. **Send now** stops the current step and runs the message next in the same run. Stop still ends the turn. Typing "/" lists the project's Claude commands and skills or Codex skills. A line above the message box shows the project's git branch and lines added and removed. Sub-agents appear as a card in their turn with type, model, effort, time and what each is doing, and each finished turn shows how long it took. **On this Mac** in the sidebar lists recent Terminal and desktop sessions in the chosen project; picking one forks it into a new chat that carries only its last exchange.

Register a folder, create a chat and send a prompt. Model, effort and permission mode sit under the message box. A new chat can switch between Claude and Codex until its first prompt. Bypass permissions is the default. Claude's Auto depends on your installed Claude configuration. Codex offers Bypass permissions, Auto (writes only inside the project folder, never asks) and Read only. Changing a mode never silently falls back to another mode.

The launcher uses your installed Node executable. Installing startup records absolute executable paths for Node, Claude and Codex, so launchd does not depend on an interactive shell or an open Terminal window. If you install Codex after startup, add `codexPath` to `config.json` or run the installer again.

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
  "codexPath": "/Users/you/Library/pnpm/codex",
  "port": 8787,
  "keepAwake": true
}
```

With `keepAwake` enabled, `caffeinate -s` prevents system sleep while on AC power. Set it to `false` and restart to turn this off. It does not bypass a closed lid. `POCKETBRIDGE_DATA_DIR`, `POCKETBRIDGE_PUBLIC_URL`, `POCKETBRIDGE_CLAUDE_PATH`, `POCKETBRIDGE_CODEX_PATH`, `POCKETBRIDGE_PORT`, `POCKETBRIDGE_CLAUDE_PROJECTS_DIR` and `POCKETBRIDGE_CODEX_SESSIONS_DIR` environment variables override the corresponding settings. The projects directories default to `~/.claude/projects` and `~/.codex/sessions`.

Lifecycle logs are `service.log` and `service-error.log`. On startup, logs larger than 5 MB move to a single `.previous` file. Chat text is kept in SQLite and Claude's conversation files, not copied into those logs.

## Recovery and boundaries

- Pending prompts use a persistent delivery ID. After a failed request, Retry reuses that ID, so a lost acknowledgement does not start another task.
- Streaming events are hints to fetch saved state. Reconnect fetches current chats and messages, then resumes events. The browser retains unsent drafts on that device.
- A second service cannot take over the same data directory or interrupt the first service. A service restart marks active turns interrupted for both agents. It never automatically repeats file edits or commands. Inspect the project and continue with a new prompt. A Codex chat resumes its saved Codex thread on the next prompt.
- Stop interrupts current work and cleans up remaining processes in that Claude turn's process group. Completed edits remain. Explicitly detached processes in another group are outside that cleanup.
- Editing files manually does not break chat sync. Editing the same file simultaneously with Claude can still produce a filesystem conflict.
- The service binds to loopback. Tailscale Serve supplies private remote HTTPS access. API tokens are never put in a URL. The browser gets its token only from a same-origin loopback bootstrap. Do not expose port 8787 publicly or enable arbitrary CORS.
- Bypass permissions gives Claude or Codex broad access within your Mac account. Use it for your own paired devices and trusted tasks.

The app wraps an unmodified official CLI. It does not guarantee Anthropic's approval of this controller or permanent subscription authentication. Review Anthropic's current terms before sharing this app with others.

## Checks

Run the 61 service and browser-helper tests with `pnpm test` from `mac/`. They use fake Claude and Codex CLIs and never touch your real installs. Browser stream parsing and safe text formatting checks are also available directly:

```sh
node --test mac/scripts/*.test.mjs
```

That command runs from the project root. Physical phone networking, sleep behaviour and real account permissions still need a device trial.
