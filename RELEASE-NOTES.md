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
