# Agentic Mailbox product site

Source for the React and HeroUI interface lives in `interface/`. Run `npm ci && npm run build` there after editing components. Commit the generated HTML and local assets with their source.

This directory contains the static product page at agentic-mailbox.timmyagentic.si. The download and workbench links point to the independently deployed mailbox app. The screen capture uses a local fixture of the mailbox UI with example mail and the Agentic Mailbox Skill.

Deploy from the repository root with the project's Wrangler CLI.

```sh
npx --no-install wrangler deploy --config website/wrangler.jsonc
```
