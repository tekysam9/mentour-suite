# Mentour Suite

Two dashboards — **Ledger** (subvendor payments) and **Margin** (consultant
roster & gross margin) — behind accounts, with each company's data kept
separate. Built on Node.js + Express + MySQL.

See **README-DEPLOY.md** for Hostinger-specific deployment steps.

## How it works

- Excel parsing happens **in the browser** (the same SheetJS-based logic
  from the original standalone tools, unchanged) — the raw `.xlsx` file
  never touches the server.
- Once parsed, the resulting dataset (JSON) is sent to the backend and
  saved against your company's account, so the dashboard loads instantly
  next time without re-uploading.
- Every request is scoped to the signed-in user's organization — see
  `src/routes/imports.js` and `src/auth.js`.

## Project layout

```
server.js              Express app entry point
src/
  db.js                 MySQL connection pool
  auth.js                Session config, password hashing, requireAuth guard
  routes/
    auth.js               signup / join / login / logout / me
    imports.js             shared save/load logic for ledger + margin data
db/
  schema.sql             Run once against your database (see README-DEPLOY.md)
scripts/
  init-db.js              Convenience script: applies schema.sql
public/
  index.html              Landing page (dashboard picker, invite code)
  login.html, signup.html
  ledger.html              Subvendor payments dashboard
  margin.html              Consultant roster / gross margin dashboard
  shared.css               Styles for the account pages
tests/
  e2e_test.js              Full API test: auth, invites, cross-tenant isolation
  static_integration_test.js   Confirms routing/static files serve correctly
```

## Local development

Requires Node 18+ and a MySQL server.

```bash
npm install
cp .env.example .env      # then fill in your local MySQL credentials
npm run init-db           # creates the tables
npm start                 # http://localhost:3000
```

## Running the tests

These spin up the real server against whatever database is configured in
`.env` and exercise the actual HTTP API (not mocks) — including a check
that one company genuinely cannot read another company's data.

```bash
node tests/e2e_test.js
node tests/static_integration_test.js
```

Both should print `RESULTS: N passed, 0 failed`.

## Adding features later

- **Billing/subscriptions**: not built yet, since it wasn't needed for
  "just Mentour Corp for now." When you're ready to charge other
  companies, that's a Stripe integration keyed off `organizations.id` —
  the multi-tenant structure is already there to support it.
- **More dashboards**: follow the pattern in `src/routes/imports.js` — it's
  a generic save/load-by-organization router already; a third dashboard
  just needs its own table (copy the `ledger_imports` / `margin_imports`
  shape) and a new mount point in `server.js`.
