# PocketBridge

Build a reliable personal Android controller for Claude Code and Codex running on the user's
MacBook. The phone should open recent chats, start chats in discovered or registered Mac projects,
send prompts, show streamed replies and tool activity, answer questions and stop work.
Pairing should persist. The Mac keeps working when the phone disconnects or closes.

## Structure

- `android/`: native Kotlin and Jetpack Compose app, targeting Android 16 API 36.
- `mac/service/`: Node.js service, local SQLite state and the official Claude and Codex CLIs.
- `mac/public/`: browser client for Mac chats, project registration and phone pairing.
- `mac/scripts/` and `mac/launcher/`: launchers, login startup and private Tailscale setup.
- `PROTOCOL.md`: shared HTTP and streaming contract. Keep both clients compatible.
- `PRODUCT.md`, component `README.md` files and `TEST-REPORT.txt`: scope, setup and verification.
- `work/` and `releases/`: ignored scratch files and generated downloads.

## Preserve these behaviours

- The Mac owns sessions and saved state. Reconnect reconciles persisted history.
- Persist prompt delivery IDs before sending; retries must not execute a prompt twice.
- Service crashes mark work interrupted, without automatically repeating commands.
- Bypass permissions is the preferred mode. Offer Auto and never silently switch modes.
- Claude and Codex logins stay inside their unmodified official CLIs. Never extract subscription
  credentials or replace their authentication with direct API calls. Model lists come from
  each CLI's own local handshake.
- Keep the Mac service private through Tailscale. Source and signed APK releases
  are public; credentials, runtime data and signing keys stay private and ignored.
- Discover project folders from Claude and Codex session metadata. Old sessions are never imported
  wholesale; the owner can explicitly continue one, which forks it and copies only its last exchange.
- New chats stay local drafts until their first prompt. Preserve agent, model, effort and
  permission mode with the immutable delivery ID. Deleted chats cannot be recreated by a retry.
- Show real model names from the catalog. Model, effort and mode sit in the composer, not a
  separate panel. New chats start from the last options used with that agent.
- Navigation is the system back gesture. No back buttons or "back to" labels.
- A prompt sent while a turn runs steers it by default; "send now" interrupts and runs next.
- Keep this a simple chat controller. A compact git branch and line count is fine; diffs,
  code review and IDE features are outside scope.

## Working here

Read the shared protocol and relevant component README before editing. Use PNPM for
Mac dependencies and the Gradle wrapper for Android. Reuse existing code and platform
features; keep changes small and readable. Test non-trivial behaviour, especially
delivery, reconnects and recovery. Distinguish emulator checks from physical phone tests.

Mac checks: `cd mac && pnpm test`.
Android checks: `cd android && ./gradlew assembleDebug testDebugUnitTest lintDebug`.
