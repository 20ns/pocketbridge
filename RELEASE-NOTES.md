PocketBridge 0.4.1

- Typed new-chat drafts stay reachable in Recent chats after Back, app restarts and project navigation. Empty untouched chats remain unsaved.
- Unconfirmed first prompts stay reachable with their original delivery IDs. Draft previews distinguish multiple unfinished chats.
- Confirmed chat deletion atomically clears cached list and delivery state, including an offline restart immediately after deletion.
- A concurrency regression covers 60 first/resumed turns, triple deliveries, conflicting options and late sends after deletion.

Install over the existing app. Version 0.4.0 can download this update through Settings. The original signing certificate and pairing are retained.

Source and signed APKs: https://github.com/20ns/pocketbridge
