# Repository Map

Keep this file short (<100 lines). Link to deeper docs instead of pasting rules inline.

## Architecture & Boundaries
- Entry points: `<fill in>`
- Auth / tenant isolation boundary: `<fill in where session/orgId is verified>`
- Database / data layer: `<fill in>`

## Non-Negotiable Invariants
- Never trust client-supplied `userId`, `orgId`, or role claims; derive them from the verified server session.
- Validate all external inputs at route/action boundaries.
- Never read or log `.env*`, `.dev.vars*`, private keys, or credentials.
- Never commit or hardcode deployment config IDs (e.g. `wrangler.toml` `account_id`, `database_id`, `zone_id`, KV `id`), secrets, API keys, emails, or real account/org/user IDs.
- Never weaken or delete existing tests to make a check pass.

## Local Verification Commands
- Typecheck / lint / test: `<auto-detected from package.json / Package.swift / Cargo.toml / go.mod>`
