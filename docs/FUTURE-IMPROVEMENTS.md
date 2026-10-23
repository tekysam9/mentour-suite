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

## Working rule
Before any change: find everything else that reads or writes the same data, keep moves and renames transactional and re-runnable, add tests, run the full suite, then push.
