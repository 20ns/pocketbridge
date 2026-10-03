PocketBridge 0.3.0 improves Android chat navigation and connection recovery.

Choose a Mac project, start or reopen a chat, and send prompts from your phone.
Replies and tool activity stream while the app is open. Reopening catches up
with work that continued on the Mac.

Install the APK while signed into this private repository. Keep Tailscale running
on both devices and finish the one-time pairing described in START-HERE.txt.
This APK updates earlier PocketBridge builds in place using the same certificate.

Android 16 emulator verification is separate from testing on the physical S25 Ultra.

The phone interface now uses project navigation, plain messaging bubbles and a fixed
composer. Recovery preserves drafts, question answers and delivery IDs. Idle mutations
use fresh connections and never silently resend. Mac ownership and tool cleanup
prevent a second service from disturbing a running turn.

Validation: 24 Mac tests and 33 Android tests passed, plus Android debug/release
builds, lint and real-Claude checks from the Android 16 emulator.
