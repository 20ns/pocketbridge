---
version: 1
slug: "ain-java-dev-pocketbridge-conversation-kt-848fbbd8"
primary_target: "android/app/src/main/java/dev/pocketbridge/Conversation.kt"
related_targets: ["android/app/src/main/java/dev/pocketbridge/MainActivity.kt","android/app/src/main/java/dev/pocketbridge/Screens.kt","android/app/src/main/java/dev/pocketbridge/Theme.kt"]
---

# Android phone chat

Mode: Operate. Personal use on a Galaxy S25 Ultra running Android 16, on the move
or at home. The phone controls Claude Code tasks on the user's awake MacBook.

## Direction contract

THESIS: Choose a project and have a conversation. Keep the task in the foreground
with plain messaging bubbles and a fixed composer. The user explicitly chose this
familiar structure and delegated implementation.

OWN-WORLD: Material 3 controls, platform typography and native font scaling.
Neutral light and dark surfaces, one restrained accent for the user's messages
and primary actions. No branding panel, logo, role labels or dashboard cards.

STORY: Select a project, start or reopen a chat, send a prompt, read streamed
replies and expandable steps. Answer a question or stop work. Reconnect restores
the Mac's saved history and preserves unsent drafts.

FIRST VIEWPORT: Projects is the opening screen. Conversation has a compact header,
left assistant messages and right user bubbles. Its bottom composer holds text,
mode and send or Stop. Back leads to Recent chats for the current project.

FORM: User-pinned familiar messaging layout. The brief fixes the navigation and
bubble arrangement; no concept seed replaces those choices. Use system appearance
because the same phone is used under daylight and indoor night lighting.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Constraints: No phone folder registration or code-review interface. Show useful
connection/turn state without extra explanatory copy. Keep questions, permission
modes, Stop, uncertain delivery and offline reading usable. Validate on an Android
16 emulator with dark mode, font scale and IME. Physical-device claims remain separate.
