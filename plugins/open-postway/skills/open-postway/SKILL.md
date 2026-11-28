---
name: open-postway
description: Inspect or change OpenPostway forwarding settings, relay addresses and managed domain aliases for an authorized user.
---

Run `python3 <skill-directory>/scripts/mailbox.py` with one of the commands below. Output is JSON. Keep credentials and confirmation codes in the user's terminal.

- Use `profiles` to find saved profiles. Put `--profile NAME` before a command to select one. In their own terminal the user can run `login --origin https://mailbox.example.com --username USER`, or `--admin` for the domain administrator. `logout` removes the saved local session.
- `forwarding` shows the active destination, pending change and relay address. `sources` lists previously connected hosted mailboxes to migrate. The user enables automatic forwarding in each source provider.
- When the user specifies a new destination, `set-destination ADDRESS` starts enrollment. If the result says `provider`, the user clicks Cloudflare's verification link in that mailbox and then runs `verify-destination ADDRESS`. For `code`, the user runs `confirm-destination` and enters the emailed code in their private terminal. `cancel-change` cancels a pending switch. Automatic forwarding starts once verification finishes.
- Administrators can use `aliases --query TEXT`, `create-alias LOCAL_PART --label LABEL` and `set-alias-status ID active|disabled`. The administrator's managed aliases share one destination.

Mail reading, search, composition and replies take place in the user's destination mail app.
