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

### Update: Import history (multi-year workbook) and the Year & month view

Two new Fin-Module tabs. **Import hours** (the recent-upload tab above) is
unchanged. **Import history** loads the whole "New hire hours by month" workbook
(one sheet per month, any number of years; sheet-name typos like "March2020" are
tolerated; "Total…" and "review" sheets are skipped) via
`POST /api/invoices/import-workbook`. From each row it reads Name, Start Date,
Hours/{Month}, Client, Payment Terms and Date, if left. Preview first, then Apply
(one transaction; safe to re-run).

* Billing is one month in arrears like the rest of Fin-Module: Jul 2019 hours →
  Aug 2019 invoice, issued on the 1st, NET terms from there. (Untick "Bill one
  month in arrears" to invoice the hours month itself.) Hours of a month after
  the current month are held back.
* Rate = the billing rate already on the consultant's pairing in Directory (the
  file's Bill rate column is not read). A pairing with no rate still gets an
  invoice at $0 flagged "no rate"; once the rate is set (e.g. by a Margin upload)
  use **Apply Directory rates** in the Year & month view. Saved client-name
  matches (client_text_aliases) are honoured.
* Missing consultants (no status), clients, programs and pairings are created.
  "Program/Client" splits at the first "/" like the Margin file. A new pairing
  with a left date is created as left. "-1 / -2" name suffixes mean the same person.
* Payment Terms: W2 / W-2 / W-2 Canada / W2/SMBA → W2; anything with 1099 → 1099;
  anything else → Subvendor. Stored on each invoice with the text as written.
  Subvendor rows also get a Subvendor-payments invoice (month = hours month; hours
  from the file; the Ledger/Margin $/hr if known, else $0) when the subvendor
  exists in Directory, or when "Also add subvendor companies…" is ticked. Months
  already paid in Ledger are skipped.
* Hours outside Start Date … Date-if-left are skipped and listed (untick the box to
  include them; some dates in the file look mistyped). Text in the hours cell
  ("no timesheets", "157/140 approved") is listed, not guessed; "155 hours 30
  minutes" is read as 155.5. The same consultant+client twice in a month is listed.
* Invoices are created Unpaid; an invoice that already has hours is never
  touched, one at 0 hours is filled in.
* **Year & month view** tab: invoice-year chips, 12 month tiles, search, filters
  (paid via, status, hours, rate, client), sortable paged table, bulk "mark paid"
  for a chosen year, CSV download.

Schema change (re-run `db/schema.sql`): `invoices.payment_category`,
`payment_terms`, `subvendor_id`, `source`; `subvendor_invoices.rate_source` gains
`hours_file`. To undo an import: `npm run undo-hours-import` (dry run), then
`npm run undo-hours-import -- --yes` (Directory records it added are kept).

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

## Consultant / Client / Vendor profile forms

Every Directory name is now a link to a full CRM-style profile (`/record.html`), and each Directory tab has a
**+ Add** button for a blank intake form. "Programs" are labelled **Vendors** everywhere (stored data and
links are unchanged); the old supplier-company list is labelled **Supplier companies**.

**Before using SSN / tax ID / bank fields you must set an encryption key** (otherwise saving them is refused and
nothing is stored):

1. Generate one: `openssl rand -base64 32`
2. Hostinger → Node.js app → Environment variables → add `FIELD_ENCRYPTION_KEY` = that value, restart the app.
3. Keep a copy somewhere safe. **If the key is lost, stored SSNs/bank numbers cannot be recovered**; do not change
   it once data is saved.
4. Re-run `db/schema.sql` (adds `record_profiles`, `record_secrets`, `record_notes`).

SSN, tax ID, routing and account numbers are AES-256-GCM encrypted, write-only, and only ever shown as the last 4
characters. Only the account owner can set or change them. `/api/version` reports `fieldEncryptionConfigured`.

## Fillable forms (W-9, W-4, I-9)

Open a record's profile → **Forms & documents**. Vendors get a W-9; consultants get a W-4 and an I-9.
Fields are pre-filled from the directory, SSN / TIN / A-number / document numbers are encrypted (last 4 shown),
and each signature section is signed with a typed name + consent (name, time, user and IP are recorded) and then
locked. Only the owner can reopen a signature (a reason is required and logged). Re-run `db/schema.sql` once
(adds `record_forms`). The forms follow the IRS / USCIS field layout but are an in-app record: confirm the
current editions at irs.gov and uscis.gov.

**Update:** "Sub-vendors" are now labelled **Vendors**; Supplier companies have the same profile form (re-run
`db/schema.sql` to allow them); Directory tabs open filtered to **Active**.

**Supplier payments:** every field is editable (supplier, month, rate, hours, amount, dates, paid date, invoice no., notes);
payments-file rows get an **Edit** button (makes a copy that replaces the file's row; **Revert** restores it); payments can be
added by hand; generating invoices now asks "Yes, generate / Cancel" first. Re-run `db/schema.sql` (adds `paid_date`,
`overrides_ledger`, and the `manual` rate source).

## Onboarding (recruiter → HR admin)

**People → Onboarding** replaces the "PLACEMENT INFORMATION" e-mail.

- **Recruiters** (every non-HR user) choose W-2 / C2C / 1099, fill in the placement (or paste the old e-mail and the form fills itself), and **Send to HR for approval**. They see only their own requests and can follow their status.
- **HR admins** (the account owner, plus anyone the owner marks under *People and roles* on the Onboarding page) see every request. New ones appear under **Waiting for your approval** and as a badge on the menu. HR can change any detail, **Approve & start onboarding**, **Send back to recruiter** (with a note) or reject.
- After approval HR works the paperwork checklist for that type (W-2: W-4, I-9, direct deposit, benefits…; C2C: the company's W-9, subcontract/MSA, certificate of insurance…; 1099: contractor agreement, W-9, I-9…). Form items tick themselves when the form is fully signed. **Create directory records** makes the consultant, supplier company (C2C), client, vendor and billing pairing from the placement.
- W-9 is now also available on Consultants (1099) and Supplier companies (C2C).

Deploy: re-run `db/schema.sql` (new `onboardings` table, `users.role` gains `hr`). `/api/version` reports `schema.onboardingTable` and `schema.hrRole`.

**Recruiter-only logins:** the owner adds them under *People and roles → Add a person* on the Onboarding page (role *Recruiter (Onboarding only)*). That login sees only the Onboarding module and only its own requests; every other page redirects to Onboarding and every other API answers 403. Re-run `db/schema.sql` first (`users.role` gains `recruiter`).

**Invite codes carry a role.** *People and roles → Invite codes* creates a code for Recruiter, HR admin or Team member; whoever joins with it gets exactly that role (and a recruiter lands in Onboarding). Codes can be revoked. The original company-wide code still works and gives Team member (full access). Re-run `db/schema.sql` (new `invite_codes` table).

**Rates are HR-only.** On an onboarding request the bill rate, pay rate, final cost and margin are visible only to HR admins (and the owner). A recruiter can type them in, but after saving they only see "Entered — only HR can see it"; they can overwrite a value but never read it back. The same applies to the list, the activity log and the "Copy as e-mail" text. No database change.

### Update: personal invites, checklist documents, ACH / Wire banking form (October 2026)

**Redeploying needs `db/schema.sql` re-run.** It is additive and safe to re-run: it adds
`email`, `invitee_name`, `created_by_id`, `used_at`, `used_by_user_id` and `revoked_at` to
`invite_codes`, and a new `onboarding_documents` table. `/api/version` reports
`schema.personalInvites` and `schema.onboardingDocuments`.

- **Personal invites** (Onboarding > People and roles): the owner (any role) or an HR admin
  (Recruiter / Team member) enters an email and role and gets a one-time sign-up link tied to
  that email. The app has no mail server configured, so the link is copied or opened in your
  own mail app (`mailto:`); automatic emailing would need an SMTP provider.
- **Checklist documents** are stored in the database (not on disk, which is replaced on
  deploy), encrypted with `FIELD_ENCRYPTION_KEY`. PDF / JPG / PNG / DOCX, 10 MB max. The
  database's `max_allowed_packet` must be at least 16 MB (the MariaDB default).
- **ACH / Wire banking authorization** is a new fillable form (form type `banking`) on supplier
  companies and consultants; bank numbers go to `record_secrets` (last 4 shown).

## Look and feel
The UI uses a Workday-style theme: Roboto (self-hosted in `public/fonts`), blue primary, soft grey canvas, white cards, pill buttons. All overrides live in `public/theme.css`, linked last on every page.

## Consultants on several projects
A consultant can have any number of client/vendor pairings, each with its own billing and pay rate (Directory > Consultants > Billing > "Paste several projects…", or add one at a time). Re-run `db/schema.sql` once to add the `pay_rate` column.

## Margin runs from the database
The Margin dashboard reads and edits placements (consultant + client + vendor, billing and pay rates, supplier, recruiter, status) straight from the database via `/api/roster`; no file is needed. "Import from file" is optional and only fills or refreshes placements that came from a file; placements edited in the app are never overwritten. Re-run `db/schema.sql` first (adds placement columns); existing placements are backfilled automatically from the latest Margin file on first load.

## Modules run from the database (no files needed)
- **Margin**: placements (`/api/roster`) are added/edited in the page.
- **Ledger**: built from supplier payment lines; **+ Add payment** records one (supplier and consultant can be typed; new names are created).
- **Fin-Module**: client invoices and supplier payments generate from placements (billing rate / pay rate per project); supplier payments need no Ledger or Margin file. Hours are typed into each invoice.
- File imports (Margin workbook, Ledger workbook, Import hours) are optional one-time shortcuts. Re-run `db/schema.sql` on deploy (adds placement columns and the per-project supplier-payment key).

## Confirmation before changes
`public/confirm.js` (loaded by `shell.js`) asks "are you sure?" with the details before any add, edit, delete or generate request to `/api` goes out. Cancel sends nothing. Sign-in/out, previews (`apply:false`) and email parsing are not asked about.

## New vendors and supplier paperwork (secure link)
When a C2C request names a company that is not a supplier in the Directory (or lacks a completed W-9, banking form or company details), HR sees a highlighted banner on the request, with an editable email and a button that creates a private, no-login link (copy it or open the pre-filled email). The vendor gives company details, signs the W-9 and banking forms and uploads the insurance certificate and agreement. They appear in the Directory as inactive until the vendor presses "Everything is done". Needs `FIELD_ENCRYPTION_KEY` and a re-run of `db/schema.sql` (new `vendor_requests` table). Routing numbers are matched to banks from `src/data/aba.json` (rebuild with `scripts/build-aba.js`).

### Nightly duplicate check

The app checks the whole Directory for possible duplicate names every night at 02:00 (server time) and flags new pairs in the Directory's duplicate review. It only flags; nothing is merged automatically, and dismissed pairs stay dismissed. Optional environment variables: `DUP_SCAN_HOUR` (0-23), `DUP_SCAN_ENABLED=false` to turn it off, `DUP_SCAN_ON_START=true` to also run once at startup. No extra setup on Hostinger.

### Emailing onboarding links (suppliers, consultants, invites)

HR/admins can invite a **supplier** (C2C company) or the **consultant** (1099 and C2C) to fill in their own details through a private, no-login link: contact details, W-9, I-9 Section 1 (the employer's sections stay with HR), banking, signed NDA, certificates. When the server has mail settings, the link is **emailed straight to them**; otherwise it is shown to copy or open as a draft in your own mail program.

Set these in Hostinger → Node.js app → Environment variables, then restart:

| Variable | Example |
|---|---|
| `SMTP_HOST` | `smtp.hostinger.com` |
| `SMTP_PORT` | `465` (SSL) or `587` |
| `SMTP_USER` | the mailbox, e.g. `onboarding@yourdomain.com` (create it under Hostinger → Emails) |
| `SMTP_PASS` | that mailbox's password |
| `SMTP_FROM` | `Mentour Suite <onboarding@yourdomain.com>` |

Use **People → Send me a test email** (Onboarding page) to check delivery. For best inbox placement, send from a mailbox on your own domain (it needs the SPF/DKIM records Hostinger shows for that domain). Re-run `db/schema.sql` (the secure-link table gains `party` and `consultant_id`) and run `npm install` (adds `nodemailer`).

HR admins (not only the owner) can now edit SSN, tax ID and bank numbers on forms and reopen signed forms. On C2C and 1099 onboardings, HR can **upload a completed W-9, I-9 or banking form instead of filling it in**.

Emails show the signed-in HR user's name as the sender ("Jane Doe (via Mentour Suite)"), replies go to that user's own email, and they receive a hidden copy. The technical sending address stays your onboarding mailbox: mail servers reject, or send to spam, messages that claim to come from an address they do not host.

### My email: send from each user's own address

Each owner / HR admin opens **Settings → My email**, picks their provider (Gmail, iCloud, Outlook/Microsoft 365, Yahoo, Hostinger or other), enters their app password and clicks Save, then **Send me a test email**. From then on, onboarding links and invites they send go out **from their registered address** and replies come straight back to them (they also get a hidden copy). Gmail, iCloud, Yahoo and 2-step Outlook accounts need an *app password*, created in the provider's security settings; the normal password will not work.

If a user has not connected a mailbox, the company mailbox (`SMTP_*` above) is used with their name on it and replies going to them. If their own mailbox fails, the company mailbox sends it and the page says so. With neither, the page offers a draft for the person's mail program, as before.

Needs: `FIELD_ENCRYPTION_KEY` (passwords are stored encrypted), and a re-run of `db/schema.sql` (new `user_mail_settings` table). The app refuses mail servers that point inside the hosting network (`ALLOW_PRIVATE_SMTP=true` is for tests only).

## Security checklist (Hostinger "security threat" alerts)
- Dependencies: `npm audit` is clean (express/body-parser updated; the Excel reader `public/lib/xlsx.full.min.js` is SheetJS 0.20.3, which fixes the known prototype-pollution and ReDoS issues in older copies).
- Set `SESSION_SECRET` to a long random value (32+ characters, not "changeme"), `NODE_ENV=production`, and `FIELD_ENCRYPTION_KEY`; the server logs a warning at start-up if the secret is weak.
- The server sends security headers (nosniff, frame-deny, referrer policy, HSTS in production) and refuses writes whose Origin is another website.
- After pulling: run `npm install`, re-run `db/schema.sql`, restart.

## Importing details into the Directory
Directory → "Import details from a file" (HR/owner only). Upload the contact-card workbook; the page matches people to existing Directory records, shows every proposed change, and saves only what is ticked. Blank fields are filled; different values are replaced only when ticked; nobody is added or deleted; missing supplier companies are created only when ticked. No schema change needed.

## Placement rules (client, vendor, supplier)
- Every consultant placement needs a **client**; the **vendor** is optional.
- Supplier company: **W2** none, **Corp-to-Corp (Subvendor)** required, **1099** optional. Enforced when a placement or profile is created or when its worker type / supplier is changed (Margin, Directory, Onboarding, profile form).
- HR and owners edit client, vendor, supplier and worker type in Directory → Consultants → Billing → Edit. Margin rows follow a client/vendor change; invoices and supplier payments already created are left as they are. Changes are written to the consultant's change log.
- Directory → Consultants shows a fix-it list (HR/owner) for existing records that break the rules, with "Clear supplier" for W2 consultants. No schema change needed.

## Fixing client/vendor and ending a consultant (HR / owner)
- Directory → consultant row → **Edit** now opens the contact fields, a **Status** selector with an **End date**, and the placements panel (client, vendor, worker type, supplier, status, end date).
- **Swap client ↔ vendor** fixes a placement entered the wrong way round (e.g. Client HCL / Vendor T-Mobile becomes Client T-Mobile / Vendor HCL). The consultant's margin rows follow; invoices and supplier payments already created are not changed.
- Making a consultant **Inactive** closes all their open placements on the end date; **Active** reopens the latest one. The same control is on the person's own page. No database changes.

## Data check (owner / HR): when records seem to be missing
Settings → **Data check** is a read-only report: every saved Ledger and Margin upload with its row counts, which one the app is showing, payments/lines that an earlier upload had and the one in use does not, and Margin lines whose placement is no longer in the app. Earlier uploads are never deleted; **Use this upload again** saves one as the newest (same as re-uploading that file). No database changes.

## Payment history import (owner / HR): bringing in older supplier payments
**Before deploying:** run `db/schema.sql` once on the live database (safe to re-run). It adds two tables, `payment_history_imports` and `supplier_payment_history`. Until then the page shows a "run the schema" message and nothing else changes.

Fin-Module → **Payment history import**: choose the decade payment workbook (read in the browser, nothing is sent to the database yet). The app reads it with rules for its quirks (columns without years, "2400-216.55bgv" deductions, split payments, supplier alias cells, W2 "Employee" rows, two corporations, duplicate rows), then asks about everything it is unsure of: which year each column is, what a deduction means, which existing consultant/supplier a spelling is, duplicates, doubtful dates, unreadable cells. Months already in the app are skipped (the app's figure wins), so nothing is doubled.

Nothing is written until **Save**. Saved payments go into `supplier_payment_history`, so a newer Ledger upload can never hide them; they appear on Supplier payments labelled "Payment history". Each import can be **undone** (removes only its payments; Directory records it created stay). Only the owner or HR can use it.

## Security checklist for production (this data is sensitive)
Already built in: passwords stored hashed (bcrypt, cost 12); HTTP-only, same-site, secure session cookies; a fresh session id at every sign-in; sign-in/sign-up rate limiting; cross-site write blocking; security headers; every query scoped to your organization; HR-only pages for payments/margins; encrypted storage for sensitive personal fields; `npm audit` clean.

Do these in Hostinger (they cannot be done from the code):
1. `NODE_ENV=production`, a long random `SESSION_SECRET` (32+ chars), and `FIELD_ENCRYPTION_KEY` set. Keep them out of GitHub (`.env` is already ignored).
2. Once your owner account exists, add the variable **`ALLOW_SIGNUP=false`** and restart: nobody can then create a new company from the sign-up page (teammates still join with the invite code). Keep the invite code private; ask for a new one if it leaks.
3. Turn on **automatic daily database backups** in Hostinger and also download a manual export (phpMyAdmin → Export) before big imports. Test a restore once.
4. Use strong, unique passwords (12+ characters) for every login and a password manager; remove logins for people who have left.
5. Use a database user that only has access to this one database, with a strong password; never reuse your Hostinger account password.
6. Keep dependencies current: run `npm audit` now and then and act on Hostinger's security notices (as with the `qs` fix).
7. Only owner/HR logins should see payments; check Settings for who has which role.

## Activity log, two-step sign-in and request limits
**After deploying, run `db/schema.sql` once** (safe to re-run). It adds the `audit_log` table and four `users` columns for two-step sign-in. Until you do, the app works as before: the log just stays empty and the Security page says it needs the database update.

- **Settings → Activity log** (owner/HR only): every sign-in, failed sign-in and change (who, what, when, from which IP). Entries can't be edited or deleted from the app. Request bodies, passwords and personal IDs are never stored; only a short list of non-secret fields (amounts, dates, status). Payment-history imports and undos are logged with a summary line.
- **Settings → Security (two-step)** (every login): turn on a 6-digit authenticator-app code (Google/Microsoft Authenticator, 1Password, Authy). Eight one-time recovery codes are shown once; save them in a password manager. Turning it off needs the password and a code. The secret is stored encrypted (with `FIELD_ENCRYPTION_KEY` when set, otherwise a key derived from `SESSION_SECRET`: if you later change `SESSION_SECRET` without `FIELD_ENCRYPTION_KEY`, two-step codes stop working, so set `FIELD_ENCRYPTION_KEY` and keep it).
- **Everyone with access to payments should turn two-step on** (owner and HR first).
- **If someone loses their phone and recovery codes** (run in phpMyAdmin, replacing the email):
  `UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery = NULL, totp_last_step = NULL WHERE email = 'person@example.com';`
  They can then sign in with just the password and set it up again. (The owner can also use `POST /api/auth/2fa/reset` with `{"userId": …}`.)
- **Request size:** requests are limited to 1 MB. Only the spreadsheet/document upload routes accept up to 15 MB, and only for signed-in people (plus the vendor portal's token-checked document upload).

## Stricter sign-in and browser protection
- **Account lockout:** 10 wrong passwords/codes for one account within 15 minutes locks that account for 15 minutes, from any IP (counted from the Activity log, so it survives restarts; a successful sign-in resets it). Tunable with `LOGIN_MAX_FAILS` and `LOGIN_LOCK_MINUTES`. Trade-off: someone who knows an email address could keep it locked; two-step sign-in and the Activity log (look for "Sign-in blocked") are your answer to that.
- **Sessions:** signed out after 2 hours without activity (`SESSION_IDLE_MINUTES`) and after 12 hours in any case (`SESSION_MAX_HOURS`). **Settings → Security → Sign out of all devices** ends every session for that person.
- **Require two-step for owner and HR:** add the variable **`REQUIRE_2FA=true`** in Hostinger and restart. Owner/HR logins without two-step are then sent to Settings → Security and can't open company data until it is on. Turn on your own two-step and save your recovery codes *before* setting this. If the database update hasn't been run, nobody is locked out.
- **Browser policy (CSP):** pages may only load scripts, styles, images, fonts and make requests to this site itself, and can't be framed or load plug-ins. Injected content can therefore neither pull in a script from, nor send data to, another website. (Inline scripts are still allowed because the pages are written that way.)

## Password rule and security emails
- **New passwords** (sign-up, joining, a login created by HR, and the new Change password card under Settings → Security) must be at least 12 characters, must not contain very common words (like "password" or "qwerty") or your own name or email, and must not be repetitive (111111, abcdef). A few unrelated words, like `plum-harbor-clock-seven`, are fine. **Existing passwords keep working, but must be upgraded at their next sign-in:** the typed password is checked against the rule, and a weak one (under 12 characters, a common word, their name or email) lets the person in only to Settings → Security until they set a new one (`FORCE_PASSWORD_UPGRADE=off` turns this off). It is checked at sign-in because only the typed password reveals its strength; stored passwords are unreadable hashes. Changing a password signs out every other device.
- **Security emails** go to the person (and, for a lockout, also the account owner) from the company mailbox (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, the same settings used for onboarding emails) when: an account is locked, someone signs in after several failed attempts, two-step is turned on or off, a recovery code is used, or a password is changed. At most one email of each kind per person every 30 minutes. If the company mailbox isn't set up, nothing is sent (everything is still in the Activity log). Set `SECURITY_ALERTS=off` to turn them off.

## Partial payments on supplier invoices
- Each unpaid supplier invoice has a **Paid so far** box. Type what has been paid (for example 5,000 on a 10,000 invoice); the row shows **Partial** and **Still due $5,000**, and only that balance is added to Unpaid in Supplier payments and on the Ledger dashboard.
- The balance is never stored: it is always invoice amount minus paid so far. Typing the full amount marks the invoice Paid; setting it back to Unpaid clears the part payment.
- Older payments-file or history rows are legacy: on their own they still replace a generated invoice as before. If you have typed a part payment and a file row for the same supplier, consultant and month also exists, the app uses the larger of the two figures, so nothing is counted twice.
- **One step on deploy:** re-run `db/schema.sql` once (it adds an `amount_paid` column; safe to re-run). Until then, saving a part payment shows a message asking for that.

## Deductions and voiding supplier invoices
- **Deductions:** under the Amount on each unpaid supplier invoice, "+ Deduction" adds a fixed $ fee or a % of the invoice amount. A reason is required, every deduction is listed on the invoice with its reason, and the amount owed is shown as "Owed after deductions". Paid so far, Still due and the Unpaid totals all use that owed amount. A % is always worked out from the invoice amount (never stored).
- Deductions cannot be more than the invoice, cannot leave less owed than is already paid, and cannot be added or removed on an invoice marked Paid or Void.
- **Void:** the owner or an HR admin can void an unpaid invoice (reason required). It stays on the list, greyed with a VOID badge, reason and who voided it, and is left out of Total, Paid and Unpaid on Supplier payments and the Ledger page. Use the "Voided only" filter to see them. A voided invoice can't be edited until it is restored. Voiding is blocked while any payment is recorded on it. Both actions appear in the Activity log.
- **One step on deploy:** re-run `db/schema.sql` once (adds `voided_at`, `void_reason`, `voided_by` and a `subvendor_invoice_deductions` table; safe to re-run).

## Pre-placement (People menu)
- Collects the vendor and consultant details **while a candidate is being interviewed**: paste the Pre-Placement table from the e-mail (the app reads the labels, including the repeated Phone / E-mail rows for vendor, signer and consultant) or type it in.
- Stages: Collecting details -> Interviewing -> Selected, or Not selected. Only a **Selected** candidate can be sent to onboarding ("Send to onboarding" creates a prefilled Onboarding draft and links it; nothing else is touched).
- **Date of birth and SSN digits** are stored encrypted (needs `FIELD_ENCRYPTION_KEY`; without it everything else still saves), never shown in lists, and never copied to onboarding. The eye icon beside them shows what you just typed so you can check it; showing an already-saved value is owner / HR only and is written to the Activity log. Only the last 4-5 SSN digits are ever kept. Marking a candidate **Not selected** erases both values.
- Recruiters, HR and the owner can use it. Everyone with access sees all candidates (there is an "Only mine" filter). Only the recruiter who added a candidate, an HR admin or the owner can change one; DOB / SSN can be revealed by HR or the owner only. This is a deliberate setting for now and may change.
- **One step on deploy:** re-run `db/schema.sql` once (adds the `pre_placements` table; safe to re-run).
- **Vendor → Directory.** The vendor on a pre-placement becomes a supplier company in the Directory: **Add vendor to Directory** on the pre-placement (any stage before "not selected"), and automatically when a selected candidate is sent to onboarding. It copies the name, address, e-mail and phone, plus (on the supplier profile) the incorporated state, fax and signing authority (name, designation, phone, e-mail; the signer is also the primary contact). The Fed tax ID is copied only by the owner / HR, encrypted (needs `FIELD_ENCRYPTION_KEY`). If a supplier with that name already exists, only its **blank** fields are filled — nothing is overwritten and no duplicate is made. Run `db/schema.sql` once (adds `pre_placements.supplier_id`).

- **Catch-up for older pre-placements.** If any saved pre-placement has a vendor that is not in the Directory, the owner / HR see a banner on the Pre-placement list with **Add the missing vendors to the Directory** (one click; same rules as above, candidates who were not selected are skipped, repeated runs change nothing).
- **Resume (optional, with versions).** Each pre-placement can carry resumes (PDF or Word, up to 10 MB each), stored encrypted in the database. A candidate can send a different resume later: every upload is kept as a new **version** (the newest is the current one; the same file twice is refused; up to 20 versions; older ones stay viewable until removed). Anyone who can see the candidate can open them; only the recruiter who added the candidate, HR or the owner can add or remove. **When the candidate is sent to onboarding, the current resume is copied to the onboarding's new optional "Resume" checklist item** (it never blocks completing the onboarding). Not mandatory for now; to make it mandatory (a candidate cannot move to interviewing without one) set `PREPLACEMENT_RESUME_REQUIRED=1` and restart. Run `db/schema.sql` once (adds `pre_placement_resume_files` and moves any earlier single resume into it); resumes need `FIELD_ENCRYPTION_KEY`.

## Pre-placement merged into Onboarding

Pre-placement is retired from the menu and home page (old records and `/pre-placement.html` still work, with a banner). Onboarding now does it all, started once a consultant is selected:

- **Paste** a pre-placement or placement e-mail; vendor, signer, visa and laptop details are read, and date of birth / SSN go to the sensitive box (encrypted, shown only behind an eye icon, reveal for owner/HR is logged).
- **Resume** with versions (PDF/Word, 10 MB, up to 20), optional.
- **Withdrawn** (consultant backed out) sits beside Cancelled (we stopped). A reason from a list is required ("Other" needs an explanation). Withdrawing erases date of birth and SSN; everything else is kept until HR deletes the record on request. HR can optionally mark Directory records *that onboarding created* inactive. HR can restore a withdrawn record to draft. Completed onboardings cannot be withdrawn.
- Recruiters still see only the onboardings they created.
- Deploy: push `main`, run `db/schema.sql` once (status ENUM, `secrets`, `withdrawn_reason`, `withdrawn_at`), keep `FIELD_ENCRYPTION_KEY` set.
