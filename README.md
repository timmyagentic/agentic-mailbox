# Agentic Mailbox

Agentic Mailbox forwards new mail to one mailbox you choose. Read, search and reply in your usual mail app. Each account gets a stable relay address, so changing the destination updates every source that forwards to that relay.

[Open forwarding settings](https://mailbox.timmyagentic.si/) · [Product site](https://agentic-mailbox.timmyagentic.si/)

## Set up forwarding

1. Sign in or register. The administrator can also sign in with the existing password or registered device certificate.
2. Enter your destination address. For a new Cloudflare destination, open the verification message in that mailbox and click the link. Back in settings, request a confirmation code. Enter the code delivered to your destination to activate it. An address already verified by Cloudflare goes directly to the code step.
3. Copy your relay address. In each source mailbox's web settings, turn on automatic forwarding to that address. Complete any source-provider confirmation and save the forwarding rule. Keep the source mailbox's copy if you want one.
4. Open your destination mailbox in Gmail or your preferred app. Send a test message from a different address to each source. Replies follow your mail app's sending identity.

For QQ and NetEase 163, look for automatic forwarding or incoming mail rules in the web settings. Availability depends on the account. Gmail uses the forwarding section in its web settings. Outlook supports forwarding in its web mail settings. Some organizations block external forwarding. Set up only the source mailboxes and keep the final destination out of these rules. [Gmail instructions](https://support.google.com/mail/answer/10957) · [Outlook instructions](https://support.microsoft.com/en-us/outlook/mail/turn-automatic-forwarding-on-or-off-in-outlook)

The domain administrator can create or disable managed aliases. These aliases share the administrator’s destination. Members have their own relay and destination. Replacing a destination keeps the current one active until the replacement is confirmed. By default Cloudflare forwards the original message. To receive a newly addressed message, open the sender identity setting and save a display name. The service sends from that name with only your verified destination in To. The sender defaults to your stable relay. An operator can assign a separate outbound address from an authorized sending domain in the account’s `forwarding_settings.sender_address`. Sources continue to use the same inbound relay. For the domain administrator, the relay and all managed aliases use the same identity. The new mail carries the original subject, text, HTML and attachments. Replies go to the original reply address when available. Clear the display name to resume original-message forwarding. Neither mode archives incoming bodies or attachments.

## Upgrade from the inbox edition

- Back up the existing database, attachment bucket and any local mailbox data you want to keep. Apply the new additive D1 migration before deploying the Worker. Keep the existing Worker name, D1 binding, member Durable Object class and namespace, domain, login secrets and certificate settings.
- Existing active managed aliases continue using the operator's previous verified `FORWARD_TO` until the administrator confirms a replacement. New members start with an empty destination. Unknown and disabled aliases reject delivery.
- Inspect existing explicit Cloudflare routing rules when migrating. To bring a direct forwarding rule into the settings, register its exact address as an active managed alias, then change that rule’s action to this Worker. Leave rules owned by other applications on their original targets.
- Existing account identities remain usable. The settings show previously connected hosted sources so their owners can enable forwarding at each provider. Previously granted IMAP or OAuth access does not create a provider forwarding rule. Users of the former local edition should configure their sources directly at each provider.
- Historical mail, attachments and drafts remain in their original storage. The new service does not replay them. Existing Mac installations and historical release archives can be retained for local history. The standalone inbox, Mac packaging and mailbox content APIs have been retired.

## Self-host

Use Node 24 and `npm ci`. Copy `wrangler.jsonc` to `wrangler.self-hosted.jsonc`. Set your Worker name, custom HTTPS route, D1 database, `PRIMARY_DOMAIN` and `ADMIN_EMAIL`. Use a unique rate-limit namespace and retain the `MEMBERS` Durable Object and `EMAIL` binding. Set `ROUTING_ACCOUNT_ID` to the Cloudflare account that owns Email Routing for your domain. Supply secrets with the same Wrangler configuration.

```sh
npx wrangler secret put ADMIN_PASSWORD --config wrangler.self-hosted.jsonc
npx wrangler secret put SESSION_SECRET --config wrangler.self-hosted.jsonc
npx wrangler secret put ROUTING_API_TOKEN --config wrangler.self-hosted.jsonc
npm run db:migrate:remote
npm run deploy:self-hosted
```

Scope `ROUTING_API_TOKEN` to **Email Routing Addresses Write** on that account. It registers and checks destination addresses. The `EMAIL` binding sends confirmation codes to Cloudflare-verified destinations from `forwarding@PRIMARY_DOMAIN`. Enable Email Routing and direct the domain's catch-all to this Worker. Use a managed alias for each additional custom address you want it to accept. Optional `ADMIN_CERT_FINGERPRINTS` keeps the existing mTLS login. [Cloudflare destination addresses](https://developers.cloudflare.com/email-service/configuration/destination-addresses/) · [Email routing rules](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)

For local development, copy `.dev.vars.example` to `.dev.vars` and set an administrator password and a random session secret. Run `npm run db:migrate:local` and `npm start`. Registration, settings and local data are available at the address Wrangler prints. `npm run check` uses isolated providers for enrollment, identity and delivery tests and performs a Worker dry-run. A local test does not deliver to a public mailbox.

## Codex plugin

The optional plugin manages forwarding settings and aliases. Install the repository marketplace and plugin, then sign in to your instance using the bundled CLI. [Forwarding skill](plugins/agentic-mailbox/skills/agentic-mailbox/SKILL.md)

```sh
codex plugin marketplace add timmyagentic/agentic-mailbox
codex plugin add agentic-mailbox@agentic-mailbox-tools
```

The hosted Worker and product site are maintained in [personal-hub](https://github.com/timmyagentic/personal-hub). Version tags publish source releases. See [diagnostics](docs/diagnostics.md) for troubleshooting and [LICENSE](LICENSE) for the license.
