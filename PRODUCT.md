# PocketBridge

Personal remote control for the user's official Claude Code installation on their MacBook, from a Galaxy S25 Ultra running Android 16. This is an operating tool, not an IDE or public service.

## Confirmed scope
- New chats only, started through this app or Mac launcher. Register project directories on the Mac.
- Persistent pairing, private networking, Mac service starts at user login.
- Recent chats, prompts, formatted replies, streamed tool activity, Stop, questions when needed.
- Bypass permissions is the preferred mode; Auto is also offered. Never silently change modes.
- Mac stays awake, plugged in, lid open. Phone disconnection must not stop work.
- Official unmodified Claude CLI owns its subscription login. No reading/extracting OAuth credentials, no Anthropic API reimplementation.
- Mac owns sessions; save delivery/recovery state locally. No cloud database or historical import.
- User delegated implementation, technology and aesthetic choices. Build directly and test with available emulator; physical phone validation remains distinct.

## Stack
Native Kotlin/Compose Android app, Node.js 22 JavaScript Mac service with built-in SQLite, local browser Mac client and launcher. PNPM for Node packages; Gradle for Android.

## UI
Operate mode. Open to projects, choose a project, then start or reopen a chat.
Conversation uses right-aligned user bubbles and left-aligned replies, with no
role labels or logo. Back opens the project's Recent chats. Keep the composer
fixed and useful, with streamed replies, accurate formatting and expandable steps.
Use native controls and readable light/dark themes. Project registration stays on
the Mac. No decorative dashboard metrics or review interface.
