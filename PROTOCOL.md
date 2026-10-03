# PocketBridge v1 contract

HTTP JSON plus Server-Sent Events. All /api routes except /api/health and /api/pair require Authorization: Bearer <app token>. JSON errors: {error: string}. Service binds 127.0.0.1 by default; Tailscale Serve proxies it privately. Only local browser bootstrap may obtain an app token through /api/local-session, and must require actual loopback peer and same-origin request. Browser token never in URL. No arbitrary CORS.

- GET /api/health -> {ok:true, version:1}
- GET /api/local-session -> {token:string} (loopback browser only; Origin/Host validation)
- GET /api/pairing (authorized) -> {code:string, expiresAt:number, url:string, link:string}; issue short-lived one-time code. url uses configured publicUrl, default local server. link: pocketbridge://pair?url=<encoded url>&code=<encoded code>. QR SVG endpoint /api/pairing/qr can be authenticated, or QR encoded locally.
- POST /api/pair {code} -> {token:string}; one-time code exchange. Rate-limit attempts. Pairing persisted until revoked; never return Claude credentials.
- GET /api/state -> {projects:Project[], chats:Chat[], lastSeq:number, capabilities:{modes:string[]}, server:{claudeAvailable:boolean, publicUrl:string}}
- POST /api/projects {path,name?} -> Project. Canonical existing directory. Registration requires the local Mac master token; paired phone tokens cannot register arbitrary paths.
- POST /api/chats {projectId,title?,mode?} -> Chat. mode defaults bypassPermissions; modes bypassPermissions,auto,plan,acceptEdits,default.
- GET /api/chats/:id/messages -> {messages:Message[], approvals:Approval[]}
- POST /api/chats/:id/prompts {id:<client UUID>,text:string,mode?:string} -> {accepted:true,duplicate:boolean}. One active turn per chat; reject a new prompt while running with 409, preserve client draft. Changing mode between turns only. Persist client id before executing; no automatic re-execution after crash.
- POST /api/chats/:id/stop -> {ok:true}. Idempotent; interrupt active turn; don't undo edits.
- POST /api/approvals/:id {decision:'allow'|'deny',answers?:object} -> {ok:true}. Check current pending state and owning chat.
- GET /api/events?after=<seq> -> SSE `id: <seq>`, `event: change`, `data: {seq,chatId?,type}`. Types state,message,approval. Clients fetch current state/messages on events (coalesce at ~250ms). Keep alive comments; resume cursors and replay durable changes. Initial snapshot then stream; on reconnect fetch state and selected messages to reconcile. No token query parameter.

Project={id:string,name:string,path:string}
Chat={id:string,projectId:string,title:string,mode:string,status:'idle'|'running'|'stopping'|'interrupted'|'error'|'waiting',updatedAt:number,error?:string}
Message={id:string,chatId:string,role:'user'|'assistant'|'activity',text:string,createdAt:number}
Approval={id:string,chatId:string,tool:string,input:object,status:'pending'|'allow'|'deny',createdAt:number}

Mac service owns official `claude -p` subprocesses with --output-format stream-json --verbose --include-partial-messages and --session-id for first turn, --resume for later turns. Bypass mode uses official flag; don't use --bare (it bypasses subscription auth). Avoid ambient API credential overrides. Chat id is UUID and is Claude session id. Use supported hooks or structured controls for approvals, test actual CLI behavior. Record raw events/normalized messages. SQLite save before broadcasting, capture stderr, buffer partial NDJSON, bound request sizes, handle missing/deleted directories, subprocess spawn failure, results/error/exit, stop/restart. Mark in-flight sessions interrupted after service restart; never auto-repeat side effects. Protocol implementation changes must be coordinated with other agents.
