---
name: "PocketBridge"
description: "Native phone messaging for Claude Code tasks on your Mac."
colors:
  light-primary: "#006A60"
  light-on-primary: "#FFFFFF"
  light-secondary-container: "#D3E9E3"
  light-on-secondary-container: "#0B201C"
  light-tertiary: "#8A5100"
  light-tertiary-container: "#FFDDB8"
  light-on-tertiary-container: "#2C1600"
  light-error: "#BA1A1A"
  light-error-container: "#FFDAD6"
  light-on-error-container: "#410002"
  light-surface: "#FAF9F5"
  light-on-surface: "#1B1C1A"
  light-on-surface-variant: "#474B47"
  light-outline: "#767A76"
  light-outline-variant: "#C7CBC6"
  light-surface-container-lowest: "#FFFFFF"
  light-surface-container-low: "#F4F3EE"
  light-surface-container: "#EFEEE9"
  light-surface-container-high: "#E9E8E3"
  light-surface-container-highest: "#E3E3DE"
  dark-primary: "#81D5C8"
  dark-on-primary: "#003731"
  dark-secondary-container: "#234C46"
  dark-on-secondary-container: "#D3E9E3"
  dark-tertiary: "#FFB86E"
  dark-tertiary-container: "#693C00"
  dark-on-tertiary-container: "#FFDDB8"
  dark-error: "#FFB4AB"
  dark-error-container: "#93000A"
  dark-on-error-container: "#FFDAD6"
  dark-surface: "#101413"
  dark-on-surface: "#E0E3E0"
  dark-on-surface-variant: "#BEC9C4"
  dark-outline: "#89938F"
  dark-outline-variant: "#3F4945"
  dark-surface-container-lowest: "#0B0F0E"
  dark-surface-container-low: "#181C1B"
  dark-surface-container: "#1C201F"
  dark-surface-container-high: "#262B29"
  dark-surface-container-highest: "#313634"
  mac-light-bg: "#f7f7f2"
  mac-light-surface: "#fffefa"
  mac-light-sidebar: "#eeeee7"
  mac-light-sunken: "#f0f0e9"
  mac-light-ink: "#262b29"
  mac-light-muted: "#5a6058"
  mac-light-line: "#d9ddd3"
  mac-light-accent: "#23685b"
  mac-light-accent-ink: "#ffffff"
  mac-light-danger: "#a3332e"
  mac-light-attention: "#855400"
  mac-dark-bg: "#191e1b"
  mac-dark-surface: "#202622"
  mac-dark-sidebar: "#191e1b"
  mac-dark-sunken: "#171b19"
  mac-dark-ink: "#e6e9e1"
  mac-dark-muted: "#a9b2a8"
  mac-dark-line: "#36403a"
  mac-dark-accent: "#83c6b2"
  mac-dark-accent-ink: "#132821"
  mac-dark-danger: "#ffaba1"
  mac-dark-attention: "#f0c879"
typography:
  headline-medium:
    fontFamily: "sans-serif"
    fontSize: "28sp"
    fontWeight: 400
    lineHeight: "36sp"
    letterSpacing: "0sp"
  title-large:
    fontFamily: "sans-serif"
    fontSize: "22sp"
    fontWeight: 400
    lineHeight: "28sp"
    letterSpacing: "0sp"
  title-medium:
    fontFamily: "sans-serif"
    fontSize: "16sp"
    fontWeight: 500
    lineHeight: "24sp"
    letterSpacing: "0.2sp"
  title-small:
    fontFamily: "sans-serif"
    fontSize: "14sp"
    fontWeight: 500
    lineHeight: "20sp"
    letterSpacing: "0.1sp"
  body-large:
    fontFamily: "sans-serif"
    fontSize: "16sp"
    fontWeight: 400
    lineHeight: "24sp"
    letterSpacing: "0.5sp"
  body-medium:
    fontFamily: "sans-serif"
    fontSize: "14sp"
    fontWeight: 400
    lineHeight: "20sp"
    letterSpacing: "0.2sp"
  body-small:
    fontFamily: "sans-serif"
    fontSize: "12sp"
    fontWeight: 400
    lineHeight: "16sp"
    letterSpacing: "0.4sp"
  label-large:
    fontFamily: "sans-serif"
    fontSize: "14sp"
    fontWeight: 500
    lineHeight: "20sp"
    letterSpacing: "0.1sp"
  label-medium:
    fontFamily: "sans-serif"
    fontSize: "12sp"
    fontWeight: 500
    lineHeight: "16sp"
    letterSpacing: "0.5sp"
  code:
    fontFamily: "monospace"
    fontSize: "12sp"
    fontWeight: 400
    lineHeight: "1.5em"
  mac-body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, sans-serif"
    fontSize: "15px"
    lineHeight: 1.5
rounded:
  step: "8dp"
  detail: "10dp"
  container: "12dp"
  question: "18dp"
  bubble: "20dp"
  bubble-tail: "6dp"
  composer: "26dp"
  mac-small: "6px"
  mac-control: "8px"
  mac-container: "12px"
spacing:
  "4": "4dp"
  "6": "6dp"
  "8": "8dp"
  "10": "10dp"
  "12": "12dp"
  "14": "14dp"
  "16": "16dp"
  "24": "24dp"
  "32": "32dp"
  mac-4: "4px"
  mac-8: "8px"
  mac-12: "12px"
  mac-16: "16px"
  mac-24: "24px"
  mac-32: "32px"
components:
  button-primary:
    backgroundColor: "{colors.light-primary}"
    textColor: "{colors.light-on-primary}"
    typography: "{typography.label-large}"
    height: "48dp"
  button-tonal:
    backgroundColor: "{colors.light-secondary-container}"
    textColor: "{colors.light-on-secondary-container}"
    typography: "{typography.label-large}"
    height: "48dp"
  button-text:
    textColor: "{colors.light-primary}"
    typography: "{typography.label-large}"
    height: "48dp"
  composer-field:
    backgroundColor: "{colors.light-surface-container-highest}"
    textColor: "{colors.light-on-surface}"
    typography: "{typography.body-large}"
    rounded: "{rounded.composer}"
    height: "52dp"
  send-button:
    backgroundColor: "{colors.light-primary}"
    textColor: "{colors.light-on-primary}"
    size: "52dp"
  stop-button:
    backgroundColor: "{colors.light-error-container}"
    textColor: "{colors.light-on-error-container}"
    size: "52dp"
  user-bubble:
    backgroundColor: "{colors.light-primary}"
    textColor: "{colors.light-on-primary}"
    typography: "{typography.body-large}"
    padding: "10dp 16dp"
  assistant-bubble:
    backgroundColor: "{colors.light-surface-container-high}"
    textColor: "{colors.light-on-surface}"
    typography: "{typography.body-large}"
    padding: "12dp 16dp"
  question-card:
    backgroundColor: "{colors.light-surface-container-low}"
    textColor: "{colors.light-on-surface}"
    rounded: "{rounded.question}"
    padding: "16dp"
  code-block:
    backgroundColor: "{colors.light-surface-container-lowest}"
    textColor: "{colors.light-on-surface}"
    typography: "{typography.code}"
    rounded: "{rounded.container}"
  mac-button:
    backgroundColor: "{colors.mac-light-accent}"
    textColor: "{colors.mac-light-accent-ink}"
    rounded: "{rounded.mac-control}"
    padding: "8px 16px"
    height: "40px"
---

# Design System: PocketBridge

## Overview

**Creative North Star: "Native conversation log"**

PocketBridge follows a familiar messaging layout on Android. Projects and recent chats use native lists. Right-aligned user bubbles, left-aligned replies and a fixed composer keep the conversation readable while Claude works on the Mac.

The phone follows system light or dark appearance and font scaling. Warm light backgrounds and charcoal dark backgrounds carry most of the interface. Teal identifies user messages and primary actions. Amber marks a question or decision; red marks errors and Stop. The Mac keeps its existing two-column conversation layout and platform font stack.

**Key Characteristics:**

- Platform typography and Material 3 controls on Android.
- Tonal separation for messages, code and the composer.
- Expandable steps and questions stay inside the conversation.
- Separate visual signals for Mac connection and chat activity.

This document merges the finished Android messaging system with the confirmed Mac guidance. Android color truth is `android/app/src/main/java/dev/pocketbridge/Theme.kt`; component truth is `MainActivity.kt`, `Screens.kt`, `Conversation.kt` and `Markdown.kt` in that directory. `PocketTheme` inherits Material 3 typography and shapes from the installed `material3-android:1.3.2`. Mac tokens remain in `mac/public/style.css`.

Frontmatter uses Android dp and sp without converting them to CSS pixels. Light-prefixed component assignments show the light scheme; switch to the corresponding dark role when system appearance is dark. Native runtime tokens own disabled, pressed, focused and menu states. Sidecar HTML samples translate logical sizes to baseline CSS pixels solely for the documentation panel. They are previews of native components, not Android implementations. Their browser focus outline is a documentation-panel affordance; native focus uses Material state layers.

## Colors

The Android palette pairs teal with warm neutrals; amber and red carry attention and error states.

### Primary

The `primary` and `on-primary` pairs color user bubbles, Send, confirmation buttons and links in each scheme. Text selection inside a user bubble uses `onPrimary` with a translucent selection background so the selection remains visible. Tonal buttons use `secondary-container` and `on-secondary-container`.

### Tertiary

The `tertiary` role marks pending answers and the border of question cards. Notices use `tertiary-container` and `on-tertiary-container`. Error text uses `error`; Stop and error notices use the paired error container roles.

### Neutral

`surface` and `on-surface` are the page and main text. `on-surface-variant` is supporting text. The composer uses `surface-container`; its input uses `surface-container-highest`. Replies use `surface-container-high`. Code and tables inside replies use `surface-container-lowest`. Question cards use `surface-container-low`. Outline roles serve native field strokes and Markdown dividers.

Mac-prefixed tokens describe the existing browser client. Its accent is muted teal; sidebar and sunken fills distinguish navigation and code. Keep the Mac's separate values rather than substituting Android colors.

**The Sender Rule.** On Android, teal bubbles identify the user. Claude replies use neutral bubbles. Primary actions and links also use teal.

## Typography

Android uses the platform sans-serif through Material 3. Monospace is reserved for code and expanded tool details. There is no custom display face.

### Hierarchy

- `headline-medium` introduces pairing.
- `title-large` labels empty states and first-level Markdown headings; the native app bar also uses this role.
- `title-medium` labels questions and second-level Markdown headings.
- `title-small` labels individual questions, warning titles and deeper Markdown headings.
- `body-large` carries messages, option labels and the main input.
- `body-medium` carries notices, tables and step summaries.
- `body-small` carries supporting descriptions and tool output.
- `label-large` carries button labels, compact menu labels and step group titles.
- `label-medium` carries timestamps, connection subtitles and delivery status.
- `code` uses the body-small size with a 1.5em line height in fenced blocks. Inline code uses 0.9em of its surrounding text.

The Mac uses its existing system font stack with a 15px root. Conversation text has a 1.65 line height, and code uses its native monospace stack. Preserve the Mac's CSS type scale when adding browser controls.

**The Native Scale Rule.** Use the existing Material typography roles and keep Android text in sp so device font scaling applies.

## Layout

Android is a single-column stack inside a Material `Scaffold`. The app bar and persistent connection banner sit above content. The composer is the bottom bar, with navigation and keyboard insets. The transcript scrolls independently and anchors the newest content at the bottom. Its outer padding is 12dp and gaps are 10dp. User rows leave 48dp at the opposite edge; reply rows leave 24dp.

Projects and recent chats use native `ListItem` rows and pull to refresh. Projects filter with Latest (activity in the last 7 days) or All, and sort Newest, Oldest or Name. Recent chats sort Newest or Oldest. Those choices are compact menu chips. Recent chats leave 96dp below the last row for the New chat floating action. Pairing uses 24dp horizontal padding and a scrollable form. Interactive question rows and explicit text actions have a 48dp minimum height; Send, Stop and the composer field are 52dp. At font scales above 1.3, Back keeps the arrow and accessible destination name while hiding its visible text label. The chat options sheet scrolls at that scale.

The Mac keeps a 300px sidebar beside a flexible conversation. Messages have a 46rem maximum measure. Below 760px the sidebar becomes a drawer and header controls stack. At 560px and below, connection text becomes an accessible compact icon treatment, pairing details stack and composer controls wrap. Browser controls use their existing 40px baseline; principal conversation actions and navigation use the 44px target token.

## Elevation & Depth

Android messages, code, notices and composer containers use tonal separation without custom shadows. Buttons, floating actions, dropdown menus and dialogs retain Material 3 state and elevation behavior. The Mac uses borders and distinct fills for structural separation; its dialog and drawer use a translucent scrim. Neither client defines a decorative shadow vocabulary.

**The Tonal Depth Rule.** Conversation content uses flat tonal layers. Preserve native Material elevation for floating actions and menus.

Android navigation enters with a short horizontal slide and fade. Expanding steps use native expand and fade transitions; a chevron rotates with state. Three pulsing dots mark live work. The Mac keeps its existing brief control transitions and respects `prefers-reduced-motion`.

## Shapes

Android message bubbles have 20dp corners with the sender's bottom corner reduced to 6dp. User bubbles reduce the bottom-right corner; Claude bubbles reduce the bottom-left. The composer field uses a 26dp radius. Question cards use 18dp, code and notices use 12dp, expanded tool detail uses 10dp and step rows use 8dp. Native buttons and menus retain Material shapes.

The Mac retains its 6px small corners, 8px control corners and 12px container corners. Its connection badge is a capsule. Keep these browser shapes separate from the phone's message silhouettes.

## Components

### Buttons

Use native filled buttons for confirmation, tonal buttons for reconnect and text buttons for Back, Options and secondary decisions. Send is a circular filled icon button. While Claude is working, the same position holds a tonal Stop button using error-container colors. Material owns interaction and disabled treatments. Native icons carry accessible descriptions where the visible label is absent.

### Inputs / Fields

Pairing and question answers use native outlined fields. The composer uses a filled field without an underline, rounded corners and up to six visible lines. An Options text button, in supporting text color, sits above the input. The pending-delivery state locks the input and shows the outgoing prompt in the conversation with its confirmation status. Offline state preserves editable drafts while disabling Send and Stop.

### Navigation

The phone starts at Projects when there is no reopened chat. Project selection opens recent chats; Back from a conversation returns to that project's recent chats. The title names the chat and the subtitle names its project. Large-font Back uses an arrow with an accessible destination. The Mac retains its sidebar, selected chat border and narrow-window drawer.

### Messages and steps

User text is selectable inside the teal bubble, with 16dp horizontal and 10dp vertical padding. Replies use 16dp horizontal and 12dp vertical padding and selectable Markdown. Code has a labelled Copy control; wide code and tables scroll horizontally. Steps stay collapsed until opened. Expanded tool details scroll within a 280dp height cap and show up to 6,000 characters. This existing ceiling is a detail-view limit, not permission to truncate commands awaiting approval.

### Questions and notices

Question cards use a tonal fill, amber border and 16dp padding. Native radios or checkboxes make the whole option row selectable. Free-text answers use outlined fields. Confirm is enabled only when every question has an answer and the Mac is connected. Question drafts survive activity recreation. Persistent connection banners report connection failures; action failures use snackbars. An empty offline transcript says it is waiting for the Mac rather than claiming the chat has no history.

### Lists and chat options

New chat is an extended floating action. Long press or the overflow menu opens Rename and Delete in native dialogs. Delete stays unavailable while that chat is working. An untouched blank chat stays out of Recent chats. Typed drafts use their prompt text as the preview and show Draft; they can be deleted locally while offline. Unconfirmed first prompts show Not confirmed and stay openable without a Delete action until delivery resolves. Server rows replace local rows with the same ID. Options opens a native bottom sheet titled Next prompt. Permission, model and effort are compact menu chips: an assist chip at least 48dp tall shows the current value, and a dropdown lists the choices. Apply is a full-width filled button. Haiku keeps default effort, disables the effort chip and says it does not support effort levels. Pickers and Apply stay disabled while a prompt is unconfirmed or Claude is working.

### App updates

Connection settings offer Check latest, then Download and Install for the public signed APK. Install uses Android's package-installer permission. That permission is separate from Mac pairing.

### Mac controls

Keep project registration and Connect phone in the browser client. Its messages retain the current labels and neutral user-message treatment; the phone's bubble arrangement does not redefine the Mac layout. Model and effort stay those of the selected chat. The browser keeps its existing mode control and layout. Browser buttons, inputs and expandable activity keep their existing hover and keyboard-focus treatments. Use `mac/public/style.css` as the source for those states.

## Do's and Don'ts

### Do:

- **Do** reuse Theme.kt roles and the Material typography inherited by PocketTheme.
- **Do** keep connection status separate from the state of Claude's task.
- **Do** keep the composer outside the scrolling transcript and respect keyboard and navigation insets.
- **Do** preserve selectable replies, copyable code, labelled controls and native question selection.
- **Do** keep Mac project registration and phone pairing controls in the Mac client.
- **Do** keep filter, sort and chat-option choices on compact native menus.

### Don't:

- **Don't** add Android role labels, a logo panel, dashboard cards or phone folder registration.
- **Don't** use color alone to communicate a failure, pending answer or connection problem.
- **Don't** replace native font scaling with fixed pixel text on Android.
- **Don't** hide permission mode, model or effort, or treat an unconfirmed prompt as delivered.
