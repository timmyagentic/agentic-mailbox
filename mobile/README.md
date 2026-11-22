# Agentic Mailbox mobile

The iOS and Android clients share one React Native source tree. Register or sign in to a hosted mailbox space, then connect QQ, Foxmail, 163, Gmail or Outlook. The client uses the Worker for account sync, conversations, search, attachments, drafts, replies, forwards, send and AI drafting. The server must include the native session and OAuth callback support from this checkout.

## Development

Install Node and the native tools for your platform. Run these commands from this directory.

```bash
npm ci
npm run typecheck
npm run android
# On a Mac with Xcode and an iOS simulator
npm run ios
```

The app defaults to `https://mailbox.timmyagentic.si`. Set `EXPO_PUBLIC_MAILBOX_ORIGIN` to use another instance over HTTPS. A debug Android build can use a loopback fixture over `adb reverse`. Production builds require HTTPS.

Gmail and Outlook use the existing server callback URIs in the provider console. The Worker returns to the app through `agentic-mailbox://oauth`, and the original mobile session completes the exchange. Account authorization and sending need an instance with the relevant provider configured.

The app uses device keychain storage for the hosted session. A signed Mac DMG runs the separate local edition.
