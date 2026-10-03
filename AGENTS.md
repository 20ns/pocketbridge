# PocketBridge

Build a reliable personal Android controller for Claude Code running on the user's
MacBook. The phone should open recent chats, start chats in registered Mac projects,
send prompts, show streamed replies and tool activity, answer questions and stop work.
Pairing should persist. The Mac keeps working when the phone disconnects or closes.

## Structure

- `android/`: native Kotlin and Jetpack Compose app, targeting Android 16 API 36.
- `mac/service/`: Node.js service, local SQLite state and the official Claude CLI.
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
- Claude login stays inside the unmodified official CLI. Never extract subscription
  credentials or replace its authentication with direct API calls.
- Use private Tailscale access. No public exposure, cloud database or old-chat import.
- Keep this a simple chat controller. Code review and IDE features are outside scope.

## Working here

Read the shared protocol and relevant component README before editing. Use PNPM for
Mac dependencies and the Gradle wrapper for Android. Reuse existing code and platform
features; keep changes small and readable. Test non-trivial behaviour, especially
delivery, reconnects and recovery. Distinguish emulator checks from physical phone tests.

Mac checks: `cd mac && pnpm test`.
Android checks: `cd android && ./gradlew assembleDebug testDebugUnitTest lintDebug`.
