# OpenPostway

OpenPostway collects new mail from a mailbox you own and re-sends it to the inbox you choose. Your relay appears in From, your destination is the only To recipient, and Reply-To points to the original reply address or author. Subject, text, HTML and attachments travel with the message. Read and reply in your usual mail app.

**[中文自部署指南](docs/self-host.zh-CN.md)** · [Product site](https://openpostway.timmyagentic.si/) · [Hosted domain settings](https://mailbox.timmyagentic.si/)

## Self-host

The default installation runs a single administrator's IMAP/SMTP relay on Cloudflare Workers. It uses one Worker with static assets, one D1 database and a once-a-minute Cron Trigger that supervises overlapping IMAP connections. A mailbox offering IMAP IDLE announces new mail over its connection. Other mailboxes are checked every ten seconds on the same connection. The settings page uses a workers.dev URL. Your existing mailbox supplies both incoming and outgoing mail. Gmail, QQ and NetEase 163 have presets. Other providers, including mailboxes on your own domain, support custom servers.

### 1. Deploy your instance

You need Node.js 24, a Cloudflare account with Workers and D1, an IMAP/SMTP-enabled mailbox, and a **different** destination mailbox. Pick an unused Worker and database name in your account. The examples use `my-postway`. Run commands from the root of the clone.

```sh
git clone https://github.com/timmyagentic/open-postway.git
cd open-postway
npm ci
npx wrangler login
npx wrangler d1 create my-postway --no-update-config
```

Copy the database ID printed by Wrangler. Replace `YOUR_D1_UUID` and use the same instance name throughout.

```sh
npm run init:self-hosted -- my-postway YOUR_D1_UUID
npm run db:migrate:remote
npm run deploy:self-hosted
```

Complete the workers.dev subdomain prompt if this is your first Worker. Save the URL printed by the deploy. Before opening it, set the admin password and generate **two different secrets** once. The last two commands use OpenSSL on macOS/Linux. On another system, enter a random signing secret and a Base64-encoded 32-byte encryption key using the corresponding Wrangler prompts.

```sh
npx wrangler secret put ADMIN_PASSWORD --config wrangler.self-hosted.jsonc
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET --config wrangler.self-hosted.jsonc
openssl rand -base64 32 | npx wrangler secret put MAIL_ACCOUNT_KEY --config wrangler.self-hosted.jsonc
```

For an existing IMAP installation, keep its Worker, D1 database and secrets. In your local `wrangler.self-hosted.jsonc`, change the old `*/5 * * * *` trigger to `* * * * *`. Apply D1 migrations before deploying the new Worker. Run `npm ci`, `npm run db:migrate:remote`, then `npm run deploy:self-hosted` on the updated checkout. Replacing the encryption key requires reconnecting the mailbox.

### 2. Connect a mailbox

Open your instance URL and sign in with the administrator password. Choose a preset and enter your relay address, a sender display name if desired, and your destination. The settings page authenticates to IMAP and sends a confirmation code through the configured SMTP account. Enter the 12-character code from the destination mailbox to activate forwarding.

| Preset | IMAP / SMTP | How to authorize |
| --- | --- | --- |
| Gmail | `imap.gmail.com:993` / `smtp.gmail.com:465` | Use an [app password](https://support.google.com/accounts/answer/185833) when your account allows it and has two-step verification. For OAuth, follow the Google setup below. |
| QQ Mail | `imap.qq.com:993` / `smtp.qq.com:465` | Enable IMAP/SMTP in mailbox security settings and generate a [client authorization code](https://help.mail.qq.com/detail/106/985). |
| NetEase 163 | `imap.163.com:993` / `smtp.163.com:465` | In the [web mailbox](https://mail.163.com/), open Settings → POP3/SMTP/IMAP, enable IMAP/SMTP and generate a client authorization password. |
| Other / own-domain mailbox | Your provider's hostnames and ports | Choose implicit TLS or required STARTTLS for each server. Common SMTP submission ports are 465 (TLS) and 587 (STARTTLS). The login defaults to the relay address. Separate incoming/outgoing usernames and an outgoing password are available under advanced settings. |

**Google OAuth.** On a desktop with a browser, create a Google Cloud project, enable Gmail API, configure the OAuth consent screen and grant the Gmail IMAP/SMTP scope `https://mail.google.com/`. For an external app in testing, add the relay account as a test user. Create and download a **Desktop app** OAuth client JSON outside the repository. Run the following from the same clone used for deployment:

```sh
npm run authorize:gmail -- /absolute/path/to/desktop-client.json
```

Open the printed Google link **on that computer**, authorize the relay account, then select Gmail and Google OAuth in your instance. The helper stores the client credentials and refresh token directly as Worker secrets. The Google account and the relay address must match. External apps in Testing can receive refresh tokens that expire after seven days. Use a consent configuration appropriate to your account for continuous operation. [Google IMAP/SMTP OAuth](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol) · [Google token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)

### 3. Receive the first relayed message

1. After activation, send a **new** message from a third address to your **relay mailbox**. Give it a distinct subject and attach a small file. Send only to the relay.
2. Open the settings page and check the receiving mode. **IMAP IDLE** means new-mail announcements trigger delivery. **每 10 秒** means the mailbox uses a ten-second check while connected. You can also click **立即检查新信** for an immediate manual check. New Cloudflare Cron configurations can take several minutes to propagate.
3. Open the target mailbox, including spam if needed. Check the From address and display name, the single To recipient, the Reply-To address and the attachment. Send future source mail to the same relay, or configure automatic forwarding at other source providers.

The initial connection records the current end of INBOX. Mail received after that point is eligible once the destination is confirmed. The relay preserves source read flags and stores encrypted credentials, configuration and processing state in D1. Each listener catches up from the committed IMAP UID, including messages received during a disconnect. A new listener is eligible every five minutes. The predecessor stays available for up to 90 seconds beyond the nominal boundary, covering the seconds offset of the minute trigger and connection setup. The outgoing delivery claim is shared by old and new listeners and manual checks. A bounded invocation can yield early on heavy traffic, and the minute supervisor resumes the backlog. Connection failures, SMTP delays or a backlog can increase delivery time. SMTP acceptance is visible in settings. If an acknowledgment is lost, check the destination before choosing to retry or skip. Mail above 12 MiB of source MIME or a changed IMAP UID validity appears in settings for an explicit decision. [Troubleshooting](docs/diagnostics.md)

## Optional Cloudflare domain routing

A domain with an existing IMAP/SMTP service can use the custom preset above. To have Cloudflare receive addresses on a domain and deliver incoming events directly to a Worker, use the separate [domain routing setup](docs/domain-routing.md). Existing domain deployments should keep their configuration, databases and bindings. The [Codex plugin](plugins/open-postway/skills/open-postway/SKILL.md) manages the domain-routing edition.

## Development

Copy `.dev.vars.example` to `.dev.vars`, set a local administrator password and the two random keys shown above, run `npm ci` and `npm run db:migrate:local`, then `npm start`. Use **立即检查新信** for local checks. `npm run check` exercises both editions, including a fresh D1 database and isolated IMAP/SMTP delivery over TLS in workerd. Node 24 and OpenSSL with `req -addext` are required to run the protocol fixture. [License](LICENSE)
