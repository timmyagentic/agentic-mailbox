# Forwarding diagnostics

## IMAP/SMTP instance

Sign in to your own settings page to see the time of the last check and the most recent SMTP acceptance. To distinguish an IMAP problem from a scheduler delay, click **立即检查新信** after sending a fresh message to the relay's INBOX from a different account. Address changes send a confirmation through SMTP. Check the destination inbox and spam folder for that message. An IMAP connection or Google authorization failure is reported separately from an SMTP rejection.

For custom hosts, match the provider's TLS and port settings on both connections. For incoming mail filtered into other folders, move the test message to INBOX or adjust the source provider's rules. Recovery choices apply to the indicated IMAP UID. If SMTP was disconnected after submitting the message, search the destination first. Skip the UID when the mail has arrived, or explicitly retry it when appropriate. After a UIDVALIDITY change, check the source mailbox before choosing to resume from the current end.

## Cloudflare domain routing

The Worker records an opaque processing ID for `email_forwarded`, `email_resent`, `email_rejected` and `email_forward_failed`. The first two indicate that Cloudflare accepted native forwarding or a new message from the relay, respectively. Final inbox placement belongs to the destination provider. Application logs omit message content, confirmation codes and addresses.

For missing mail, first check that the source provider has enabled its forwarding rule and that its verification step has finished. Check the destination's spam folder and Cloudflare Email Routing activity. For domain mail, check the SMTP envelope recipient, exact alias status, effective routing rule and active destination. An unrecognized, disabled or unconfigured address is rejected. A forwarding transport or database failure fails the email event.

For destination setup, verify the account ID, the account-specific Email Routing Addresses Write permission and the EMAIL binding. A pending Cloudflare verification can be resent from Destination Addresses in the Cloudflare dashboard. A service confirmation code lasts 15 minutes. Settings can request a new code after one minute. Changing or cancelling a pending address invalidates the previous code.

HTTP errors include an opaque request ID for correlation. The health endpoint checks D1. The local `npm run check` verifies routing decisions without real external delivery.
