# Agentic Mailbox mobile

The iOS and Android clients share one React Native source tree. The initial screen is the on-device inbox. Add a QQ, Foxmail or 163 address and its provider-issued IMAP/SMTP authorization code. The phone stores the code in device-only secure storage and connects to the provider over TLS (IMAP 993, SMTP 465). Refresh shows the latest 40 messages per account. Choose a sender when composing.

To import one account, choose **从 Mac 导入** on the phone. In the native Mac launcher choose **导入到手机**, verify the Mac owner, choose the account and enter the pairing code displayed on the phone. Scan the encrypted QR within two minutes, confirm the address, and connect. The transfer is offline. No mailbox codes are put in links or sent to a relay.

For the hosted edition, choose **进入托管邮箱**. Register or sign in to a hosted mailbox space, then connect QQ, Foxmail, 163, Gmail or Outlook. The client uses the Worker for account sync, conversations, search, attachments, drafts, replies, forwards, send and AI drafting. The server must include the native session and OAuth callback support from this checkout.

## Development

Install Node, Go 1.26.4 or newer, and the native tools for your platform. Android requires its SDK/NDK and JDK, iOS requires Xcode and CocoaPods. The npm platform scripts compile the shared transport before starting Expo. For a manual Expo prebuild or CI build, first run `bash modules/direct-mail/build.sh android` or `bash modules/direct-mail/build.sh ios` from this directory. Run these commands from this directory.

```bash
npm ci
npm run typecheck
npm run android
# On a Mac with Xcode and an iOS simulator
npm run ios
```

The hosted mode defaults to `https://mailbox.timmyagentic.si`. Set `EXPO_PUBLIC_MAILBOX_ORIGIN` to use another instance over HTTPS. A debug Android build can use a loopback fixture over `adb reverse`. Production builds require HTTPS.

Gmail and Outlook use the existing server callback URIs in the provider console. The Worker returns to the app through `agentic-mailbox://oauth`, and the original mobile session completes the exchange. Account authorization and sending need an instance with the relevant provider configured.

The app uses device keychain storage for the hosted session. A signed Mac DMG runs the separate local edition.
