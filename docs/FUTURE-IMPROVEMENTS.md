# Mentour Suite: improvements to revisit

Last updated 2026-10-23. Tick items off as they are done.

## Speed and weak-signal follow-ups (from the 2026-10-23 quality check)
- [ ] **Offline saving.** Queue saves made without signal and send them when the connection returns. Needs conflict handling so nothing double-saves or overwrites newer data. Today saves are deliberately not retried.
- [ ] **Split the large pages.** invoices.html (about 100 KB), ledger.html, onboarding.html and margin.html load everything up front. Move the tabs and rarely used panels into separate scripts loaded on demand.
- [ ] **Per-row queries in import and save loops** (Margin roster save, invoice generate, hours import). Fine today, but batch them if imports get large or slow.
- [ ] **Sign-in check on the record, form and help pages.** They still redirect to the sign-in page on any failed check; give them the same "Can't reach the server" handling as the other pages.
- [ ] **Load the spreadsheet library only when a file is chosen.** It is 880 KB and is currently loaded on Ledger, Margin and invoices at page open.

## Open setup and decisions
- [ ] Set `FIELD_ENCRYPTION_KEY` on Hostinger (needed for supplier secure links and sensitive fields).
- [ ] Re-run `db/schema.sql` on the live database (new `vendor_requests` table).
- [ ] Run `npm install` after deploy (new `compression` package).
- [ ] Confirm billing in arrears.
- [ ] Review the 44 roster rows skipped because of start/left dates.
- [ ] Margin and invoice previews could follow per-project rates.
- [ ] Payments are edited in Fin-Module, not Ledger.
- [ ] Import hours and Import workbook stay optional.
- [ ] Nightly duplicate scan only runs while the Hostinger app is awake; set `DUP_SCAN_ON_START=true` if it sleeps overnight.

## Added 2026-10-23 (onboarding links and email)
- [ ] Set the `SMTP_*` variables on Hostinger and use "Send me a test email" to confirm delivery (see README-DEPLOY.md). Add SPF/DKIM for the sending domain so emails reach inboxes, not spam.
- [ ] Re-run `db/schema.sql` (secure links gain `party` and `consultant_id`) and `npm install` (`nodemailer`).
- [ ] W-2 employees: offer the same consultant link and "upload instead" (currently C2C and 1099 only).
- [ ] Reminder emails for links that have not been opened, and an email to HR when a supplier/consultant finishes.
- [ ] HR editing of SSN/tax ID is open to all HR admins "for now"; revisit if you want it limited again.

- [ ] "Sign in with Google / Microsoft" (OAuth) for My email instead of app passwords. Needs an OAuth app registered with Google and Microsoft by the company (client ID/secret); safer and easier for users than app passwords.
- [ ] Re-run `db/schema.sql` for the `user_mail_settings` table; each HR user then connects their mailbox under Settings → My email.

## Working rule
Before any change: find everything else that reads or writes the same data, keep moves and renames transactional and re-runnable, add tests, run the full suite, then push.

## Payments (on hold, decided 2026-10-27)
The app tracks supplier payments (paid/unpaid, dates) but does not move money. Parked for now.
- Agreed starting point when resumed: suppliers only first; payment runs prepared by HR and approved by the owner; a payment log of every run.
- Step 1 (no provider needed): bank-file export (NACHA/CSV) of unpaid supplier payments using the saved bank details, then mark paid.
- Step 2: direct send through an ACH service (e.g. Dwolla, Modern Treasury, Bill.com) with status updates back into the app. Check that service's current fees and approval steps first. Stripe Connect was priced (0.25% + 25¢ per payout, $2 per active account per month) but needs each supplier to set up a Stripe account.
- Consultants: keep W-2 payroll with a payroll service (export hours and rates); 1099 consultants can follow suppliers.
