# PocketBridge

Personal remote control for the user's official Claude Code and Codex installations on their MacBook, from a Galaxy S25 Ultra running Android 16. This is an operating tool, not an IDE or public service.

## Confirmed scope
- New chats started through this app or Mac launcher, or an explicit continue of a Terminal or
  desktop session in that project (forked; only its last exchange is copied in). Each chat runs on Claude Code
  or Codex; a draft can switch until its first prompt. Discover folders from local Claude Code
  and Codex session metadata, with manual registration on the Mac as a fallback.
- An on/off switch per agent, shared by phone and Mac, for when only one subscription is
  active. Off agents aren't offered, probed or used for discovery.
- Plan usage for Claude and Codex (session and weekly limits, reset times, credits) read from
  each CLI, plus context fill for each chat.
- Recent and All project views with search; newest, oldest and name ordering. Work in
  progress anywhere is listed first. Chat rows show the last reply and the model. Chats can be
  renamed or deleted. Empty conversations are not saved before the first prompt.
  Typed drafts and unconfirmed first prompts remain reachable in Recent chats.
- Send at reset: at a plan limit, a prompt can wait on the Mac and send itself once when that
  limit resets, with the phone off. It can be cancelled or sent now until it starts.
- Persistent pairing, private networking, Mac service starts at user login.
- Recent chats, prompts, formatted replies, streamed tool activity, Stop, questions when needed.
- Bypass permissions is the preferred mode; Auto is also offered. Never silently change modes.
- Model, effort and permission mode sit in the composer as one-tap choices with real model
  names from each CLI. They apply to the next prompt, persist per chat and with delivery
  state, and new chats reuse the last choice for that agent. "Default" is never offered.
- Public GitHub source and signed APK releases. Settings checks for updates and hands
  installation to Android. Keep the same package and signing certificate for saved pairing.
- Mac stays awake, plugged in, lid open. Phone disconnection must not stop work.
- Lock the Mac's screen from the phone, with its current lock state. No remote unlock.
- Official unmodified Claude and Codex CLIs own their subscription logins. No reading/extracting OAuth credentials, no API reimplementation.
- Mac owns sessions; save delivery/recovery state locally. No cloud database or historical import.
- User delegated implementation, technology and aesthetic choices. Build directly and test with available emulator; physical phone validation remains distinct.

## Stack
Native Kotlin/Compose Android app, Node.js 22.13 or newer JavaScript Mac service with built-in SQLite, local browser Mac client and launcher. PNPM for Node packages; Gradle for Android.

## UI
Operate mode. Open to projects, choose a project, then start or reopen a chat.
Conversation uses right-aligned user bubbles and left-aligned replies, with no
role labels or logo. The system back gesture returns to the project's chats; there are
no back buttons or labels, and the page follows the gesture. Keep the composer fixed and
useful: prompt, model, effort, permission mode and Send in one box. While work runs, the
conversation shows the step running now and the elapsed time. Use native controls and
readable light/dark themes. Project registration stays on the Mac. Don't explain what the
user can already see. No decorative dashboard metrics or review interface.
