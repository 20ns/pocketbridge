# PocketBridge

A personal Android controller for Claude Code running on your MacBook.
The Mac keeps the project, Claude login and chat history. Your phone sends prompts,
reads streamed replies and activity, answers questions and stops a turn.

Start with [START-HERE.txt](START-HERE.txt). Source structure and working rules are
in [AGENTS.md](AGENTS.md). The phone app is in `android/`; the Mac service,
browser client and launchers are in `mac/`.

## Downloads and updates

APK downloads live in this private repository's [Releases](https://github.com/20ns/pocketbridge/releases).
Sign into GitHub in your phone browser to download. Install newer APKs over the
existing app to preserve pairing and drafts. You can also download the current
Mac-hosted APK at your private Tailscale address followed by `/PocketBridge.apk`.

Every push runs Mac tests and Android build, unit tests and lint. To publish an
update, increase `versionCode` and `versionName` in `android/app/build.gradle.kts`,
edit RELEASE-NOTES.md, push, and manually run "Checks and APK release" in Actions.
The signed release is published after the Mac and Android checks pass.

The repository secret `APK_SIGNING_KEY` holds the original personal signing key,
so updates preserve the installed app's certificate. The local copy remains at
`~/.android/debug.keystore`; keep a private backup. It retains the existing
personal debug certificate for compatibility, while release APKs disable debugging.
This distribution is for personal sideloading. A Play Store release would need
its own signing and publication setup.

Local release build:

```sh
cd android
POCKETBRIDGE_SIGNING_KEY="$HOME/.android/debug.keystore" ./gradlew assembleRelease testDebugUnitTest lintRelease
```

Claude and Tailscale can each require account renewal independently of saved
PocketBridge pairing. The Mac must be awake, online, plugged in and lid open.
Actual phone/network verification is recorded separately in TEST-REPORT.txt.
