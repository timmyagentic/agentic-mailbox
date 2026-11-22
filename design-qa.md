# Design QA — Agentic Mailbox

## Visual truth and implementation evidence

- Source visual truth: `/Users/timmy/.codex/visualizations/2026/07/19/019f79d0-42b0-7cc3-be35-4b071ec9aeec/five-site-redesign/selected/mailbox-vault.png`
- Desktop implementation: `/Users/timmy/.codex/visualizations/2026/07/19/019f79d0-42b0-7cc3-be35-4b071ec9aeec/five-site-redesign/local/mailbox-vault/desktop-1440x1024.png`
- Mobile implementation: `/Users/timmy/.codex/visualizations/2026/07/19/019f79d0-42b0-7cc3-be35-4b071ec9aeec/five-site-redesign/local/mailbox-vault/mobile-390x844.png`
- Desktop full-view comparison: `/Users/timmy/.codex/visualizations/2026/07/19/019f79d0-42b0-7cc3-be35-4b071ec9aeec/five-site-redesign/comparisons/local/mailbox-vault-desktop.png`
- Mobile full-view comparison: `/Users/timmy/.codex/visualizations/2026/07/19/019f79d0-42b0-7cc3-be35-4b071ec9aeec/five-site-redesign/comparisons/local/mailbox-vault-mobile.png`
- Focused form comparison: `/Users/timmy/.codex/visualizations/2026/07/19/019f79d0-42b0-7cc3-be35-4b071ec9aeec/five-site-redesign/comparisons/local/mailbox-vault-focus-form.png`

## Viewport and state

| Surface | Requested viewport | Captured bitmap | State |
| --- | --- | --- | --- |
| Desktop | 1440 × 1024 | 1440 × 1024 | Unauthenticated login; empty password; submit disabled |
| Mobile | 390 × 844 | 375 × 812 content surface after in-app browser chrome | Unauthenticated login; empty password; submit disabled |

The main-agent browser pass found no horizontal overflow on either surface. At the mobile target, the browser reported `innerWidth = 390` and `documentElement.scrollWidth = 375`, so the page remained within the available content width.

The main agent also tested the password interaction locally: entering a dummy password enabled the submit button, and the single visibility control toggled the input from `password` to `text`. No login request was submitted.

## Comparison findings

- The implementation preserves the selected concept's high-contrast vault vestibule, two-column desktop composition, restrained teal palette, visual hierarchy, capability list, and prominent administrator form.
- The mobile layout deliberately collapses the explanatory capability list while retaining identity, service status, form context, and a complete tap-friendly login path.
- The generated source depicts an error/active-submit example, while the captured implementation is the idle/disabled-submit state. The focused board is therefore used to compare typography, spacing, controls, and hierarchy rather than to claim state parity.
- The generated language selector was intentionally not implemented because the product has no language-switching behavior. Adding a decorative, non-functional selector would reduce trust.
- Product claims were calibrated to the real authentication, plain-text rendering, D1, and R2 behavior instead of copying unsupported security claims from the concept.

Final visual assessment: no open P0, P1, or P2 findings. Desktop and mobile are legible, balanced, and free of horizontal overflow.

## Release-readiness fixes

### React and accessibility

- Reformatted the login form hierarchy for readable JSX.
- Connected login errors to the password input through `aria-invalid` and `aria-describedby`.
- Added `aria-busy` to the form and `aria-pressed` to the password visibility toggle.
- Marked decorative icons and the status dot as hidden from assistive technology, and identified the English kicker with `lang="en"`.
- Preserved semantic `main`, `aside`, `section`, `form`, `nav`, and native button elements. The mobile navigation trigger retains `aria-controls` and `aria-expanded`; the current navigation item retains `aria-current="page"`.

### Motion review

| Before | After | Why |
| --- | --- | --- |
| Login entrance ran for 520 ms; workspace content re-entered for 420 ms on navigation | Login-only entrance runs for 260 ms; recurring workspace entrance was removed | Keeps occasional orientation motion while making frequent navigation immediate |
| Entrance moved 10 px with delays up to 260 ms | Entrance moves 6 px with 40–60 ms stagger steps and delays up to 200 ms | Produces a quieter, faster cascade without blocking interaction |
| Enhanced hover lift applied without pointer capability gating | Lift is inside `@media (hover: hover) and (pointer: fine)` | Prevents sticky touch hover motion |
| New transitions used built-in `ease` | New transitions use `cubic-bezier(0.23, 1, 0.32, 1)`; the mobile drawer uses `cubic-bezier(0.32, 0.72, 0, 1)` | Provides responsive, consistent easing and an origin-appropriate drawer feel |
| Reduced motion collapsed every transition to 0.001 ms | Entrances are removed, the drawer snaps, press transforms are removed, and useful color/focus feedback remains at 100 ms | Honors reduced-motion preference without deleting all state feedback |

Motion verdict: Approve — no feel-breaking regressions, no high-frequency decorative entrance, all new UI motion stays below 300 ms, pointer hover is gated, and reduced-motion/reduced-transparency preferences are handled.

## Verification

- `npm run check`: passed (ESLint, TypeScript, 8 Vitest tests, Vite production build, Wrangler dry-run)
- `git diff --check`: passed
- Open P0 findings: 0
- Open P1 findings: 0
- Open P2 findings: 0

final result: passed
