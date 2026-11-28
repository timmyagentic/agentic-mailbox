# Forwarding diagnostics

The Worker records an opaque processing ID for `email_forwarded`, `email_rejected` and `email_forward_failed`. A forwarded event means the Cloudflare forwarding call succeeded. Final inbox placement belongs to the destination provider. Application logs omit message content, confirmation codes and addresses.

For missing mail, first check that the source provider has enabled its forwarding rule and that its verification step has finished. Check the destination's spam folder and Cloudflare Email Routing activity. For domain mail, check the SMTP envelope recipient, exact alias status, effective routing rule and active destination. An unrecognized, disabled or unconfigured address is rejected. A forwarding transport or database failure fails the email event.

For destination setup, verify the account ID, the account-specific Email Routing Addresses Write permission and the EMAIL binding. A pending Cloudflare verification can be resent from Destination Addresses in the Cloudflare dashboard. A service confirmation code lasts 15 minutes. Settings can request a new code after one minute. Changing or cancelling a pending address invalidates the previous code.

HTTP errors include an opaque request ID for correlation. The health endpoint checks D1. The local `npm run check` verifies routing decisions without real external delivery.
