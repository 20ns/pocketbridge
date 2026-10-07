PocketBridge 0.8.2

- Long conversations stay responsive: turn summaries use one pass through history, and cached chats load off the UI thread.
- Switching chats replaces redundant refreshes, and old cached messages cannot overwrite a newer reply.
- Each chat opens at its latest message instead of inheriting another chat's scroll position.
- Offline transcript saves no longer mistake different replies for the same snapshot.
- Codex streaming keeps reused item IDs separate across turns and preserves completed replies when late events arrive.

The scrambled reply reported for this release was also present in Codex's own saved final output. PocketBridge cannot reconstruct text Codex never supplied. These fixes address verified app and streaming bugs; they do not rewrite that reply.

PocketBridge 0.8.1

- Fixed a flash when going back from a project or a chat: the page you leave no longer redraws empty while it animates away.

PocketBridge 0.8.0

- New chat from anywhere: a + next to Projects offers New project, General chat, or a chat in any project.
- New project creates a folder in ~/Desktop/experiments on your Mac and opens a chat in it.
- General chats belong to no project. They run in your home folder, so they can work across the Mac, and have their own place at the top of Projects.
- Lists keep their scroll position when you come back, even after the app restarts. The Recent/All filter and sort stick too.
- Haptic feedback on send, steer, stop, toggles, menus, Allow/Deny and errors, following your system setting.
- Deleting a chat shows Undo for a few seconds. The deletion is saved right away, so it still goes through if the app closes.
- Agents come first in Settings and switch instantly, for when you alternate subscriptions.
- Long-press the app icon for New chat. Pull to refresh in Settings. Ctrl+Enter sends on a hardware keyboard.
- The Mac browser gets New project, General chats and a remembered sidebar position.

PocketBridge 0.7.0

- Back arrows on every screen past Projects, alongside the back gesture. Headers are compact: "Projects" sits top-left, and a chat shows its project folder under the title.
- Newest models, automatically: the Mac uses the newest installed Claude and Codex CLI, so new models (like GPT-6.1-Sol) and options appear without an app update.
- Fast: a Codex speed toggle next to effort when the model offers it. It sticks per agent like the other options.
- Banked resets: the usage sheet shows Codex reset credits and lets you use one, after a confirmation.
- Usage rings show each enabled agent's weekly use, Claude in orange and Codex in blue. Chats carry a light tint of their agent's colour.
- Projects get their own colours, and their own logo when the folder has one (favicon, app icon and similar).
- Downloaded update APKs are deleted once installed, and caches for chats deleted elsewhere are cleared.
- Under the hood: the Mac service, browser client and app were split into smaller modules, with review fixes for icon file safety, per-prompt speed and options, and reset retries.

PocketBridge 0.6.2

- Open in Claude Desktop: a Claude chat's menu (and a button in the Mac browser) hands the chat to the Claude desktop app on your Mac, the same way `/desktop` does in the terminal. It then appears in Desktop's list with its full history. Wait for a turn to finish first; both apps shouldn't work on one chat at the same time.

PocketBridge 0.6.1

- A prompt the Mac accepted but whose confirmation got lost no longer leaves the phone stuck on "Not confirmed".
- Retrying a failed steer as Send now really interrupts. A prompt is never sent twice under the same ID with a different delivery.
- Steers Claude or Codex dropped, or couldn't confirm before stopping, show up in the chat instead of looking delivered. They are never re-run on their own.
- Alerts keep Allow and Deny when the Mac is briefly unreachable, pick up a second question in the same chat, and go away when you turn alerts off or disconnect.
- After a Mac restart, sub-agents and timers stop instead of ticking forever.
- Continuing a Codex session brings its last reply along. A session whose last prompt was never answered isn't paired with an older reply.
- "/" skills work right after the Mac restarts, duplicate command names no longer crash the list, and Codex skills refresh every ten minutes.
- Images the Mac no longer has upload again instead of failing every send. Typing while a message sends no longer re-attaches its images.
- Emoji and other multi-byte text can't be corrupted in transit, and the git line counts files with unusual names and ignores empty ones.
- A command's result stays with its command when a steer arrives mid-step. Nested lists indent correctly. "Default" never shows as a model name.

PocketBridge 0.6.0

- Screenshots: attach images from your photos or share them to PocketBridge from any app. Claude and Codex both see them. On the Mac, paste or drop them.
- Steer a running turn: send while it works and the agent picks your message up at its next step. Send now stops the current step and runs your message next.
- "/" lists your Claude commands and skills, or Codex skills, for the project.
- Continue a Terminal or desktop session from your Mac in a new chat. It forks the session, so the original stays untouched.
- Alerts while the app is closed: done, failed, or needs your answer, with Allow and Deny on permission requests.
- Sub-agents show what they're doing, their model and effort, and how long they've run. Every turn shows how long it took.
- A git line above the message box: branch and lines added and removed in the project folder.
- A chat started with only a screenshot is titled "Screenshot" instead of the text sent with it.
- Codex now runs through its app-server: replies stream, steering works, and context fill shows for Codex chats too.

PocketBridge 0.5.0

- Codex support. Pick any Claude or Codex model for a new chat from a compact panel that rises from the message box, newest first. Codex runs through the official Codex CLI on your Mac with its own login, resumes its thread on later prompts, and offers Bypass permissions, Auto and Read only.
- A redesigned app: collapsing large titles, rounded tonal lists, a new message box, full-width replies and spring motion, in light and dark.
- Model, effort and permission mode sit under the message box. One tap changes them. Models show their real names and versions (Opus 5.5, Fable 5.1, GPT-6-Astra…) straight from each CLI. "Default" is gone.
- New chats start with the last model, effort and mode you used for that agent.
- No back buttons or labels. Use the back gesture; the page follows your finger.
- Projects: search, work in progress at the top, cleaner filters. Chats show the last reply and model.
- While work runs you see what it's doing now and for how long. Copy a whole reply with one tap.
- Turn Claude or Codex off in Settings when you only have one subscription. New chats, usage and project discovery skip it, and a chat of an agent that's off has a one-tap Turn on.
- Usage: Claude's 5-hour and weekly limits and Codex's windows and credits, with reset times, plus how full a Claude chat's context is.
- Replies read better: highlighted code in common languages, coloured diffs and aligned tables.
- Faster syncing: streaming only refetches the open chat, responses are compressed and transcripts no longer rewrite app preferences on every update.

Install over the existing app. The Mac service must be updated too for Codex and the model list; older services still work with Claude.

Source and signed APKs: https://github.com/20ns/pocketbridge
