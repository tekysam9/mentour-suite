// Mentour Suite user manual. One source for the in-app Help page (help.html) and the Word manuals.
// Each section and each block lists the roles it applies to: owner (Administrator), hr (HR admin),
// recruiter, member (Team member). help.html shows only the parts for the signed-in user's role.
(function (root) {
  var ALL = ['owner', 'hr', 'recruiter', 'member'];
  var OFFICE = ['owner', 'hr', 'member']; // everyone with the full suite
  var HR = ['owner', 'hr'];
  var ROLE_NAMES = { owner: 'Administrator', hr: 'HR admin', recruiter: 'Recruiter', member: 'Team member' };

  var SECTIONS = [
    { id: 'roles', title: 'Who can do what', roles: ALL, body: [
      { p: 'Mentour Suite has three main kinds of login. What you see depends on yours.' },
      { table: [['Role', 'What it covers'],
        ['Administrator (account owner)', 'Everything: all modules, every onboarding request, changing anyone’s role, inviting any role (including HR admins), adding people directly, shared invite codes, entering SSN / tax ID / bank numbers on any form or profile, and reopening a signed form.'],
        ['HR admin', 'All modules (Ledger, Margin, Directory, Fin-Module, Onboarding). Sees and approves every onboarding request, works the paperwork checklist, uploads documents, sends secure links to suppliers, and can enter bank numbers on the ACH / Wire banking form. Can invite Recruiters and Team members (not other HR admins). Cannot change roles, cannot enter SSN or tax ID numbers, cannot reopen a signed form.'],
        ['Recruiter', 'Only the Onboarding module, and only their own requests. Can type in bill rate, pay rate and final cost but never sees them again after saving. Never sees the banking form or any bank details. Cannot work the checklist or upload documents.']] },
      { p: 'There is also a Team member role (full access to the suite, with only their own onboarding requests). Your role is shown in People and roles on the Onboarding page.', roles: HR },
    ] },

    { id: 'signin', title: 'Signing in and registering', roles: ALL, body: [
      { h: 'Sign in' },
      { steps: ['Go to utils.mentourcorp.com.', 'Type your email and password on the “Sign in.” page.', 'Click Sign in. You land on Home (Recruiters land straight on Onboarding).'] },
      { shot: 'login', caption: 'The sign-in page' },
      { h: 'Register with an invite link' },
      { p: 'You need an invite to join. The app does not send emails itself, so the person who invited you sends the link from their own email.' },
      { steps: ['Open the invite link you were sent. The sign-up page opens on “Join with invite code”, with the code and your email already filled in.', 'Type your name and choose a password (at least 8 characters).', 'Click Join company. Your role comes from the invite: you don’t pick it yourself.'] },
      { shot: 'signup', caption: 'Joining with an invite link' },
      { note: 'A personal invite link works once, and only for the email it was sent to. If it has been used or revoked, ask for a new one.' },
      { h: 'Moving around' },
      { bullets: ['The menu on the left lists every module you can open. Click the panel icon at the top of the menu to collapse it.', 'Compact tables (top right) fits more columns on the screen. Wide tables also get a sideways scrollbar on top.', 'Help (in the menu) opens this guide, showing only what applies to your role.', 'Log out is at the bottom of the menu.'] },
    ] },

    { id: 'confirm', title: 'Confirmation prompts', roles: ALL, body: [
      { p: 'Every add, edit, delete, generate or send asks “are you sure?” first, with Yes and No buttons. Click Yes to go ahead. Click No and nothing is saved or sent.' },
      { shot: 'confirm', caption: 'A confirmation prompt before sending a request to HR' },
      { p: 'Just looking at pages, previews and signing in or out never ask.' },
    ] },

    { id: 'home', title: 'Home', roles: OFFICE, body: [
      { p: 'Home has a card for each module: Ledger, Margin, Directory, Fin-Module and Onboarding. Click a card (or use the menu) to open it.' },
      { shot: 'home', caption: 'Home' },
      { p: 'As the Administrator you also see “Invite your team” with the company-wide invite code. Anyone who joins with that code becomes a Team member with full access, so prefer the role-specific invites in Onboarding → People and roles.', roles: ['owner'] },
    ] },

    { id: 'directory', title: 'Directory', roles: OFFICE, body: [
      { p: 'The Directory keeps every consultant, client, vendor and supplier company in one place. Use the menu entries Consultants, Clients, Vendors and Supplier companies.' },
      { shot: 'dir-consultants', caption: 'Directory: Consultants' },
      { steps: ['Use the filter at the top right to show Active, Inactive or all records.', 'Click + Add to create a record, or Edit on a row to change its email, phone or address.', 'On Consultants, open Billing to see or add their client / vendor pairings and rates.', 'Seen in shows which uploads named the record.', 'Click a name to open the full profile, with “Forms & documents” and “Notes & activity”.'] },
      { shot: 'record', caption: 'A consultant profile' },
      { note: 'Active / Inactive is set by Margin uploads, not by the Ledger.' },
      { p: 'Only the Administrator can enter or change SSN, tax ID or bank numbers on a profile. Once saved, the app only ever shows the last 4 digits.', roles: OFFICE },
    ] },

    { id: 'margin', title: 'Margin (placements)', roles: OFFICE, body: [
      { p: 'Margin is the consultant roster: every placement with its client, vendor, cost (pay) and billing per hour, and the margin between them.' },
      { shot: 'margin', caption: 'The Margin dashboard' },
      { steps: ['Click + Add placement, fill in the consultant, client, vendor, employment type, supplier, cost and billing, then save.', 'Click a row to edit it, close it out (mark it Left) or delete it.', 'Use the search box and filters (status, vendor, employment type) to narrow the list. Reset clears them.', 'Export CSV downloads what you see. Import from file loads a gross-margin workbook; uploads set each consultant’s Active / Inactive status.'] },
      { shot: 'margin-add', caption: 'Adding a placement' },
    ] },

    { id: 'ledger', title: 'Ledger', roles: OFFICE, body: [
      { p: 'The Ledger is payments only: what Mentour pays each supplier for each consultant, month by month.' },
      { shot: 'ledger', caption: 'The Ledger' },
      { steps: ['+ Add payment records a payment line.', 'Click a row to see it month by month.', 'Filter by status, client, supplier or month; Reset clears the filters.', 'Export CSV downloads the list; Import from file loads a supplier-payments workbook.'] },
      { note: 'Supplier payment lines are generated, edited and marked paid in Fin-Module → Supplier payments.' },
    ] },

    { id: 'invoices', title: 'Fin-Module: client invoices', roles: OFFICE, body: [
      { p: 'One invoice per consultant / client / vendor billing pairing, using the rate on file in the Directory. Clients are billed one month in arrears: hours worked in September go on the October invoice. The “Hours for” column shows which month the hours are for.' },
      { shot: 'inv-client', caption: 'Client invoices, grouped by month with subtotals and a total' },
      { h: 'Generate a month’s invoices' },
      { steps: ['Choose the Invoice month, Net terms and Issue date.', 'Tick “Include inactive consultants” only if you need them.', 'Click Generate invoices and confirm. New invoices start at 0 hours.'] },
      { h: 'Fill in hours and track payment' },
      { steps: ['Type the hours in a row; amount = rate × hours (both stay editable).', 'Click the Paid / Unpaid badge to switch it, and set the timesheet status.', 'Use the month picker: All periods, a year, Whole year, single months (click several to combine), or a Custom date range.'] },
      { p: 'Year & month view shows totals by year and month.' },
      { shot: 'inv-history', caption: 'Year & month view' },
    ] },

    { id: 'import', title: 'Fin-Module: Import hours', roles: OFFICE, body: [
      { p: 'Upload an Excel sheet with a Name column, a Client column (“Vendor/Client” or just the client) and one or more Hours/<month> columns. Every sheet in the workbook is read.' },
      { steps: ['Open Fin-Module → Import hours.', 'Check the Hours year, Net terms, Create as (Paid / Unpaid) and Timesheet boxes.', 'Choose the hours file. A preview appears; nothing is saved yet.', 'Check the preview: invoices to create, 0-hour invoices to fill in, ones already with hours (left untouched), and rows not matched.', 'Click Apply and confirm.'] },
      { shot: 'import-preview', caption: 'Import preview with an unrecognised client name' },
      { h: 'Merge or add a client name' },
      { p: 'If a client / vendor in the file isn’t recognised, the row shows a fix: pick the right pairing under “Same as” and click Merge to save the file’s spelling as another name for it (future imports then match it too), or click “Add as a new pairing”.' },
      { p: 'Import history lists past imports.' },
    ] },

    { id: 'supplier', title: 'Fin-Module: supplier payments', roles: OFFICE, body: [
      { p: 'What each supplier company invoices Mentour for each consultant, month by month.' },
      { shot: 'inv-subvendor', caption: 'Supplier payments' },
      { steps: ['+ Add supplier payment adds a line by hand.', 'Generate invoices creates a month’s lines from the rate on file.', 'Every field can be changed by typing in the cell: supplier, month, rate, hours, amount, dates, payment and notes. It saves as you go; changing the rate re-prices the hours.', 'Rows from the payments file keep an editable copy the first time you change them; Revert brings back the original.'] },
    ] },

    { id: 'onb-recruiter', title: 'Onboarding: sending a placement to HR', roles: ['recruiter', 'member'], body: [
      { p: 'Onboarding is where you send a new placement to HR. You see only the requests you created.' },
      { shot: 'onb-list', caption: 'Your onboarding requests', roles: ['recruiter'] },
      { steps: ['Click + New onboarding request.', 'Choose how the person is engaged: W-2 employee, Corp-to-corp (C2C) or 1099 contractor.', 'Fill in the details. If you have the placement e-mail, paste it and click “Fill the form from this e-mail”.', 'Click Save draft. You can come back and change a draft any time.', 'When it’s ready, click Send to HR for approval and confirm. The app tells you if any required field is missing.'] },
      { shot: 'onb-new', caption: 'A new request', roles: ['recruiter'] },
      { h: 'After you send it' },
      { bullets: ['While it waits for HR you can click Withdraw to edit to take it back.', 'If HR sends it back, you’ll see their note; fix it and send it again.', 'Cancel request cancels it; Delete draft removes a draft for good.', 'Copy as e-mail copies the placement as e-mail text.', 'Once HR approves it, you can follow the checklist progress, but only HR ticks items or uploads documents.'] },
      { h: 'What stays hidden from you' },
      { bullets: ['Bill rate, pay rate and final cost: you can type them in, but after saving they show as “Entered — only HR can see it”. You can replace them but not read or clear them.', 'Banking: the ACH / Wire banking form and all bank details are never shown. That checklist item just says “Handled by HR”.', 'Margin, the vendor check and other people’s requests.'], roles: ['recruiter'] },
      { shot: 'onb-own', caption: 'A request with HR: rates hidden, banking “Handled by HR”', roles: ['recruiter'] },
    ] },

    { id: 'onb-hr', title: 'Onboarding: reviewing and approving', roles: HR, body: [
      { p: 'Requests from recruiters appear under “Waiting for your approval”, and the menu shows a red count. The list below shows every request; filter by status or type, or search by name.' },
      { shot: 'onb-list', caption: 'Onboarding list with a request waiting' },
      { steps: ['Click Review on a waiting request.', 'Check the details. You can change anything, including the rates, and you see the margin.', 'Click Approve & start onboarding, or Send back to recruiter… (you must say what to fix), or Reject / cancel.'] },
      { p: 'You can also start one yourself with + New onboarding request, and Start onboarding now skips the approval step.' },
    ] },

    { id: 'checklist', title: 'Onboarding: the paperwork checklist', roles: HR, body: [
      { p: 'Each engagement type has its own checklist (W2, C2C or 1099). The count shows how many required items are done; optional items never block completion.' },
      { shot: 'onb-c2c', caption: 'A C2C onboarding being worked' },
      { bullets: ['Tick items: click the box. Add a note in the Note field (for example a certificate’s expiry date).', 'Not applicable: removes an item from the count; “Applies after all” brings it back.', 'Yes / No items: Background check (attach the report if you like, optional), Rate confirmation, and Timesheet process. The item counts once answered.', 'Upload items: Vendor agreement, Certificate of insurance, Work authorization and NDA. Click Upload document and pick a PDF, JPG, PNG or Word file up to 10 MB. Files are encrypted.', 'Form items: W-9, W-4, I-9 and the ACH / Wire banking form open a fillable form. They tick themselves once the form is fully signed.', '“Client onboarding paperwork, badge and equipment” is optional.'] },
      { h: 'Directory records and finishing' },
      { steps: ['Click Create directory records to make the consultant, supplier company, client, vendor and billing pairing from the request (Update directory records later re-syncs it).', 'If the vendor is new, a highlighted banner says so: click “Just add to the Directory now” or send the vendor a secure link.', 'When everything is done, click Mark onboarding complete. Reopen brings it back if needed.'] },
    ] },

    { id: 'forms', title: 'Fillable forms: W-9, W-4, I-9 and ACH / Wire banking', roles: HR, body: [
      { p: 'Open a form from the checklist or from a profile’s “Forms & documents”. Fill it in, click Save draft, then each signer types their full legal name, ticks the consent box and clicks Sign electronically. Print / save as PDF makes a copy.' },
      { shot: 'banking', caption: 'The ACH / Wire banking authorization form' },
      { bullets: ['Banking: choose ACH or Wire, then enter the bank details. The bank name fills in from the routing number; account numbers are typed twice to confirm, and only the last 4 digits are shown afterwards.', 'Signing the banking form ticks “Direct deposit details collected” (W2), “Payment (ACH) details collected” (1099) or “Company banking / remittance details collected” (C2C).'] },
      { p: 'You can enter bank numbers on the banking form. SSN, tax ID and other ID numbers on the W-9, W-4 and I-9 can only be entered by the Administrator, and only the Administrator can reopen a signed form.', roles: ['hr'] },
      { p: 'As Administrator you can enter every sensitive number on every form, and Reopen a signed form (give a reason).', roles: ['owner'] },
    ] },

    { id: 'vendor-link', title: 'Requesting documents from a supplier (secure link)', roles: HR, body: [
      { p: 'For C2C placements you can ask the supplier company to fill in its own paperwork through a private link. No login is needed on their side.' },
      { steps: ['On the onboarding, find “Request from the supplier”.', 'Tick what you need: Company details, Form W-9, Bank / ACH / remittance details, Certificate of insurance, Signed vendor agreement. Add a note if you like.', 'Check the supplier’s email and how long the link works, then click Create secure link and confirm.', 'Click Copy link or Copy as e-mail, and send it from your own email.', 'Progress shows “x of y received”. Cancel this link stops it working; Create a new link replaces it.'] },
      { shot: 'vendor-link', caption: 'What the supplier sees' },
      { note: 'The supplier activates in the Directory when they finish. Bank and tax numbers they enter are encrypted.' },
    ] },

    { id: 'people', title: 'People, roles and invites', roles: HR, body: [
      { p: 'Open Onboarding and expand People and roles at the bottom.' },
      { shot: 'people', caption: 'People and roles' },
      { h: 'Invite someone by email' },
      { steps: ['Under “Invite people to register”, enter their email and name and choose their role.', 'Click Create invite and confirm.', 'Click Copy link or Open in email and send it yourself (the app does not send email yet).', 'The list shows each invite as Pending or Used. Revoke cancels one that hasn’t been used.'] },
      { p: 'As HR admin you can invite Recruiters and Team members. Only the Administrator can invite an HR admin or change someone’s role.', roles: ['hr'] },
      { h: 'Administrator only', roles: ['owner'] },
      { bullets: ['Change anyone’s role with the drop-down next to their name (the owner always stays Administrator).', 'Invite any role, including HR admin.', 'Shared invite codes: a reusable code that gives the role it carries; people join on the “Join with invite code” tab.', 'Add a person: create a login directly with a name, email, password and role.'], roles: ['owner'] },
    ] },
  ];

  var HELP = { ROLE_NAMES: ROLE_NAMES, SECTIONS: SECTIONS,
    forRole: function (role) {
      var keep = function (x) { return !x.roles || x.roles.indexOf(role) !== -1; };
      return SECTIONS.filter(keep).map(function (s) { return Object.assign({}, s, { body: s.body.filter(keep) }); });
    } };
  if (typeof module !== 'undefined' && module.exports) module.exports = HELP; else root.MS_HELP = HELP;
})(this);
