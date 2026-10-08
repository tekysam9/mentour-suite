# Deploying Mentour Suite to Hostinger

This is a normal Node.js + MySQL web app. It was built and tested locally
against a real MySQL database before being handed to you (see `tests/`) —
the steps below are just about getting those same files running on
Hostinger's Node.js hosting.

You'll need a Hostinger plan that includes Node.js apps (Business Web
Hosting or any Cloud hosting plan — not available on the base Single Shared
Hosting plan).

---

## 1. Create the MySQL database

1. In **hPanel**, go to **Websites → [your site] → Databases → Management**.
2. Fill in a database name, a database username, and a password. Click
   **Create**, and save the password somewhere safe — Hostinger won't show
   it again.
3. Note the three values: database name, username, password. The host is
   almost always `localhost` on Hostinger (the app and database run on the
   same machine), which is why `.env.example` defaults `DB_HOST` to that.

You do **not** need to enable "Remote MySQL" — that's only for connecting
from *outside* Hostinger (e.g. your laptop). The app talks to the database
from the same server, so it just needs `localhost`.

## 2. Prepare the project for upload

On your own computer:

1. Make sure `node_modules/` and `.env` are **not** included in what you
   upload (`.gitignore` already excludes both if you use Git).
2. Zip the project folder: `package.json`, `package-lock.json`, `server.js`,
   `src/`, `public/`, `db/`, `scripts/`, `.env.example`.

## 3. Deploy the Node.js app

1. In hPanel: **Websites → Add Website → Node.js web app** (also labeled
   "Deploy Web App" in some accounts).
2. Choose **Upload your files**, and upload the `.zip` from step 2 — or
   choose **Import Git repository** if you'd rather push this to a GitHub
   repo first and deploy from there (this also gives you auto-redeploy on
   every push, which is convenient later).
3. Hostinger will detect it's a Node app from `package.json`. Confirm:
   - **Application root**: the folder containing `package.json`
   - **Entry file / startup file**: `server.js`
   - **Node version**: 18 or newer
   - **Install/build command**: default (`npm install`) is fine — there's
     no separate build step.
4. Don't click Deploy yet — first add the environment variables in the next
   step (there's a spot for this on the same screen, or you can add them
   after deploying and redeploy).

## 4. Set environment variables

Either on the deploy screen, or afterward via **your site's dashboard →
Environment variables**, add:

| Key | Value |
|---|---|
| `DB_HOST` | `localhost` |
| `DB_PORT` | `3306` |
| `DB_NAME` | the database name from step 1 |
| `DB_USER` | the database username from step 1 |
| `DB_PASSWORD` | the database password from step 1 |
| `SESSION_SECRET` | a long random string (see below) |
| `NODE_ENV` | `production` |

Generate a `SESSION_SECRET` once, on your own machine:

```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Paste the output in as the value. This is what signs login session
cookies — treat it like a password; don't reuse the one from `.env.example`.

You don't need to set `PORT` — Hostinger sets that automatically, and
`server.js` already reads `process.env.PORT`.

Click **Deploy**. Hostinger runs `npm install` and starts the app.

## 5. Create the database tables

The app's tables don't exist yet — the schema needs to run once. Easiest
way, no terminal needed:

1. In hPanel, open **Databases → phpMyAdmin** and select your database.
2. Go to the **Import** tab, choose the `db/schema.sql` file from this
   project, and run it.

(If your plan gives you SSH/terminal access to the app, you can instead run
`npm run init-db` from the project folder — it does the same thing.)

## 6. Point your domain at it

If you're using a domain you already have on Hostinger, attach it to this
website from **Websites → [your site] → Domain**. Hostinger issues a free
SSL certificate automatically — give it a few minutes after attaching the
domain, then confirm the site loads over `https://`.

## 7. First login

Visit your domain. You'll land on the sign-in page — there's no account
yet, so click **Create an account**, choose **New company**, and sign up as
Mentour Corp. That first signup becomes the account **owner**. From the
home page afterward, the owner sees an invite code to share with teammates
(they use **Join with invite code** on the signup page).

Each of the two dashboards (Ledger, Margin) will show the upload screen the
first time — after that first import, they'll auto-load whatever was last
saved, for anyone signed in to that company.

---

## Redeploying after you change something

- **Git-connected**: push to the branch you deployed from; it redeploys
  automatically.
- **Zip upload**: re-zip and upload again from the site dashboard.

Either way, environment variables and the database persist across
redeploys — you only did steps 1, 4, and 5 once.

If an update adds new tables or columns, re-run `db/schema.sql` the same
way you did in step 5 (phpMyAdmin import, or `npm run init-db`) — it's
written so running it again is always safe and never erases existing data,
it only adds what's missing.

### One-time fix: Client/Program swap (October 2026)

This update corrected how the Directory reads the Margin file's "Client /
Account" column: for a value like "Wipro/TD Bank", "TD Bank" is now
correctly treated as the Client and "Wipro" as the Program (it used to be
the other way round). After redeploying this update and re-running
`db/schema.sql`, also run this once to fix up data from files uploaded
before the correction:

```
npm run backfill-client-program-swap
```

It re-reads the original upload data already stored in the database (no
need to re-upload any files), fixes the Client/Program links — including
rows from uploads made before the Client column fix, whose stored client
text still reads like "Wipro/TD Bank" — and rebuilds the upload-sourced
billing assignments to match (stale ones on the old reversed pairings are
removed; billing rows added by hand are never touched). It then prints the
old Client/Program records nothing points at any more, so you can clean them
up by hand on the Directory page; it never deletes a Directory record
itself. Safe to run more than once: a second run changes nothing.

### New: Fin-Module (October 2026)

Adds a fourth dashboard, "Fin-Module.", for monthly invoicing: one invoice
per consultant/client/program billing combination, generated from the rate
already on file in Directory, billed to the Program (or the Client when a
pairing has no program). This only adds a new `invoices` table — re-run
`db/schema.sql` the same way as any other update; there's no data to
backfill.

### New: Fin-Module "Subvendor payments" (October 2026)

A second tab inside Fin-Module lists what each subvendor invoices for each
consultant, month by month. Months already on your latest sub vendor
payments (Ledger) upload are shown read-only. For every month after the
file's last month you can generate invoices at the consultant's Ledger rate
(or the Gross Margin cost rate when Ledger has none), then enter hours,
NET terms, paid/unpaid, timesheet status and notes -- same as client
invoices. This adds a `subvendor_invoices` table -- re-run `db/schema.sql`
(it also upgrades the table if you already ran the earlier version);
nothing to backfill.

**Update (Year column).** Subvendor payments now read the cleaned payments
file: the invoice month is the month named in the Subvendor label plus the
"Year" column (the sheet name is only shown as "paid in"), and rows whose
Amount cell is red/yellow (unpaid) are left out. Generation opens per
consultant, from the month after their own last month on the file. Re-run
`db/schema.sql` (adds `year_text` and `unpaid` to `ledger_roster_entries`),
then **re-upload the cleaned file in Ledger once** so those columns fill in.

### Update: left client/program pairings (October 2026)

Each consultant/client/program billing pairing now has a status. A pairing
that the latest Margin file lists only with Left rows is marked **left** (with
its left date), shown struck-through in Directory, and skipped when generating
client invoices (tick "Include inactive consultants" to bill it anyway).
Directory also shows Client and Program as separate columns. After deploying,
re-run `db/schema.sql`, then either re-upload the Margin file or run
`npm run backfill-assignment-status` once to mark the existing pairings.
Invoices already generated are not touched.

### New: Fin-Module "Import hours" (October 2026)

A third tab in Fin-Module creates client invoices from an Excel hours sheet
(upload it again whenever there are new months). The sheet needs a Name
column, a Client column ("Program/Client" or just the client) and one
`Hours/<month>` column per month (e.g. `Hours/Jan`). Each consultant is matched
by name and billing pairing by the Client column; the invoice is the hours
times the billing rate already on file, issued on the last day of the month.
You get a preview first (to create / already invoiced / not matched); months
that already have an invoice are never changed, and nothing is guessed. No
schema change.

### Update: Import hours — per-column years, billing in arrears, invoice-month picker

- Each `Hours/<month>` column gets its own year. A heading with a year
  (`Hours/Dec 2025`, `Hours/Dec-25`, `Hours/Dec'25`) uses it; otherwise the
  year comes from column order — when the month goes down (Dec → Jan) the
  year moves forward, and the "Hours year" box is the year of the last run.
  So `Hours/Dec, Hours/Jan … Hours/Sep` with 2026 is Dec 2025, Jan–Sep 2026.
- Billing is one month in arrears: a month's hours go on the next month's
  invoice (Dec 2025 hours → Jan 2026 invoice). `period_month`, the
  `INV-YYYYMM` number and the month filter are the invoice month; the invoice
  is issued on the 1st of the invoice month and NET terms count from there.
- Hours for a month after the current month are never invoiced (shown as
  "month is in the future"); the server enforces this too.
- Client invoices shows one invoice month at a time (month picker, ‹ › to step,
  starts on the newest month with invoices) with an "Hours for" column.
- No schema change; no `db/schema.sql` re-run needed.
- Every sheet of the workbook is read (the W2 Payroll file has one sheet per
  month, "December 2025" … "September 2026", each with one
  `Hours/<Month YYYY>` column) and hours are combined per consultant + client.
  A heading without a year takes it from a "<Month> <YYYY>" sheet name. The
  same month twice for one consultant/client is skipped and listed. A second
  "Name" header row below the table (pay batches) ends that sheet's table.

### Update: Client invoices list — all months grouped, totals, multi-month selector

The Client invoices list now shows every invoice month by default, grouped
newest first: a month header ("Jan 2026 · Hours for Dec 2025 · N invoices"),
the invoices, a subtotal (hours, amount) per month and a grand total at the
bottom. "Invoice months" is a checkbox dropdown (with counts, All months,
Clear) to show only some months. `GET /api/invoices?months=2026-01,2026-02`
(`periodMonth=` still works) returns `totals` for exactly the invoices listed,
so totals follow Show inactive / payment / timesheet filters. No schema change.

### Update: Import hours — merge or add an unrecognised Client (schema re-run needed)

**Redeploying needs `db/schema.sql` re-run.** It adds one table,
`client_text_aliases` (`CREATE TABLE IF NOT EXISTS`; additive, safe to run
again). Until it is re-run, imports work exactly as before and only the
"Merge" button reports that the database update is needed.

When an hours row names a known consultant but its Client text doesn't match
one of their pairings (or matches more than one), the preview lists it under
"Client / program not recognised" with two fixes:
- **Same as … → Merge**: pick one of the consultant's pairings. The text is
  saved as another name for that client/program (Directory keeps one name per
  record, so this is stored in `client_text_aliases`), and this and every later
  import of the same text (case/spacing ignored) matches it. E.g.
  "International Resource Group/State of RI" → State of RI / IRG.
- **Add as a new pairing**: creates the client/program from the text (split like
  the Margin file: Program/Client) and the consultant's pairing at the billing
  rate entered (pre-filled from the sheet's Bill Rate column).
Either way the preview re-runs and nothing is invoiced until Apply. Saved
matches are listed under the preview with a Remove button. Directory merges
repoint saved matches to the surviving client/program.

### Update: client invoices start at 0 hours; clearing client invoices

Generated client invoices now start at **0 hours / $0** until hours are typed
in or imported (Import hours). An existing invoice still at 0 hours is filled
in by an import; one that already has hours is never changed.

To remove every client invoice and start over (nothing else is touched):

```
npm run delete-client-invoices                # dry run, shows counts only
npm run delete-client-invoices -- --yes       # deletes them
```

Add `--org <id>` to limit it to one organization, or
`--include-subvendor-generated` to also clear invoices generated on the
Subvendor payments tab. This cannot be undone.

## If you outgrow Cloud/Node.js hosting

The "other companies down the line" case is already handled in the data
model — a new company just signs up and creates its own organization; its
data is isolated from Mentour Corp's automatically (this was the main thing
tested before handing this off — see `tests/e2e_test.js`). What Cloud
hosting *won't* give you later is things like background jobs, staged
environments, or per-tenant subdomains — if you get there, that's a VPS
(CloudPanel) conversation, not a rebuild.

## Security notes

- Passwords are hashed with bcrypt before storage — the database never
  holds a plain password.
- Every data query is scoped by `organization_id`, enforced server-side,
  not just hidden in the UI — a signed-in user literally cannot query
  another company's data through this API, confirmed in `tests/e2e_test.js`.
- Login and signup are rate-limited (20 attempts per 15 minutes per IP) to
  slow down brute-force guessing.
- `SESSION_SECRET` and database credentials live only in environment
  variables — never commit a real `.env` file.
