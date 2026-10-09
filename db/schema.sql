-- Mentour Suite schema
-- Run this once against your MySQL database (see README-DEPLOY.md).

CREATE TABLE IF NOT EXISTS organizations (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  invite_code   VARCHAR(32) NOT NULL UNIQUE,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  email           VARCHAR(255) NOT NULL UNIQUE,
  password_hash   VARCHAR(255) NOT NULL,
  name            VARCHAR(255) NOT NULL,
  role            ENUM('owner', 'member') NOT NULL DEFAULT 'member',
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ledger_imports (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  uploaded_by     INT NOT NULL,
  file_name       VARCHAR(255) NOT NULL,
  imported_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  data            JSON NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_ledger_org_date (organization_id, imported_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS margin_imports (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  uploaded_by     INT NOT NULL,
  file_name       VARCHAR(255) NOT NULL,
  imported_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  data            JSON NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_margin_org_date (organization_id, imported_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per consultant, per Margin upload. margin_imports keeps the raw
-- upload (full JSON blob, what the dashboard loads instantly) so nothing
-- about that flow changes; this table is the same data broken out into
-- real columns so it can be queried directly with SQL instead of unpacked
-- from JSON in application code (e.g. totals by program, trends across
-- uploads, filtering by status). Rows are tied to the import that produced
-- them, so a roster "as of" any past upload stays queryable; for the
-- current roster, filter to each org's latest margin_imports.id.
CREATE TABLE IF NOT EXISTS margin_roster_entries (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  import_id       INT NOT NULL,
  organization_id INT NOT NULL,
  name            VARCHAR(255) NOT NULL,
  client          VARCHAR(255),
  program         VARCHAR(255),
  client_detail   VARCHAR(255),
  cost            DECIMAL(12,2),
  billing         DECIMAL(12,2),
  margin          DECIMAL(12,2),
  status          VARCHAR(32),
  joined_text     VARCHAR(64),
  left_text       VARCHAR(255),
  left_date       DATE,
  recruiter       VARCHAR(255),
  subvendor_text  VARCHAR(255),
  employment_type VARCHAR(64),
  source_sheet    VARCHAR(255),
  FOREIGN KEY (import_id) REFERENCES margin_imports(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  INDEX idx_margin_roster_import (import_id),
  INDEX idx_margin_roster_org_program (organization_id, program),
  INDEX idx_margin_roster_org_status (organization_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Directory: consultants, clients, programs, subvendors as real records with
-- their own contact details (email/phone/address), instead of just names
-- copied out of a spreadsheet. Populated automatically the first time a name
-- is seen in an upload (Ledger or Margin) and left alone after that — a save
-- never overwrites details someone has filled in through the Directory page.
--
-- Consultants and subvendors are shared between Ledger and Margin (the same
-- person/vendor uploaded through either tool resolves to one record, matched
-- on name, case/whitespace-insensitive, per organization). Clients and
-- programs only come from Margin — Ledger has no equivalent concept (its
-- "client" is just an HCL / Non-HCL tag, not a named account).
--
-- In Margin's own data, the "Client / Account" column holds values like
-- "Wipro/TD Bank": the text after the "/" (e.g. "TD Bank") is the real
-- end-client, and the dashboard's "Program" value (e.g. "Wipro") is the
-- specific engagement/program under that client. So: `clients` is keyed on
-- that post-slash detail, and `programs` is keyed on the Program value,
-- linked under its client. (When there's no "/", the whole value is both
-- the client and has no separate program.)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS consultants (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  name            VARCHAR(255) NOT NULL,
  status          ENUM('active', 'inactive') NULL DEFAULT NULL, -- NULL = not set yet (see below)
  email           VARCHAR(255),
  phone           VARCHAR(64),
  address         VARCHAR(500),
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_consultants_org_name (organization_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS subvendors (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  name            VARCHAR(255) NOT NULL,
  status          ENUM('active', 'inactive') NULL DEFAULT NULL, -- NULL = not set yet (see below)
  email           VARCHAR(255),
  phone           VARCHAR(64),
  address         VARCHAR(500),
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_subvendors_org_name (organization_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS clients (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  name            VARCHAR(255) NOT NULL,
  status          ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  email           VARCHAR(255),
  phone           VARCHAR(64),
  address         VARCHAR(500),
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_clients_org_name (organization_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS programs (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  client_id       INT NOT NULL,
  name            VARCHAR(255) NOT NULL,
  status          ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  email           VARCHAR(255),
  phone           VARCHAR(64),
  address         VARCHAR(500),
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  UNIQUE KEY uq_programs_client_name (client_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Upgrade path for a database that already has these tables from before
-- Active/Inactive existed. New rows get it from the CREATE TABLE default
-- above; this ALTER adds it to already-deployed tables (defaulting every
-- existing record to 'active' until its next upload resolves the real
-- status -- see directoryUpsert.js).
ALTER TABLE consultants ADD COLUMN IF NOT EXISTS status ENUM('active', 'inactive') NOT NULL DEFAULT 'active' AFTER name;
ALTER TABLE subvendors ADD COLUMN IF NOT EXISTS status ENUM('active', 'inactive') NOT NULL DEFAULT 'active' AFTER name;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS status ENUM('active', 'inactive') NOT NULL DEFAULT 'active' AFTER name;
ALTER TABLE programs ADD COLUMN IF NOT EXISTS status ENUM('active', 'inactive') NOT NULL DEFAULT 'active' AFTER name;

-- Only Margin uploads set Active/Inactive. A consultant or subvendor first
-- seen in a Ledger (sub vendor payments) upload has no status yet: NULL,
-- shown as "Not set" in the Directory, until a Margin upload names it.
-- (Clients/programs only ever come from Margin, so they keep NOT NULL.)
-- Existing values are kept; safe to re-run.
ALTER TABLE consultants MODIFY COLUMN status ENUM('active', 'inactive') NULL DEFAULT NULL;
ALTER TABLE subvendors MODIFY COLUMN status ENUM('active', 'inactive') NULL DEFAULT NULL;

-- Link margin_roster_entries rows to the directory records they resolved to.
-- Nullable: a W2/1099/direct-employment row has no real subvendor, and a row
-- with no "/" in Client / Account has no program detail, so those stay NULL.
ALTER TABLE margin_roster_entries ADD COLUMN IF NOT EXISTS consultant_id INT NULL AFTER name;
ALTER TABLE margin_roster_entries ADD COLUMN IF NOT EXISTS client_id INT NULL AFTER program;
ALTER TABLE margin_roster_entries ADD COLUMN IF NOT EXISTS program_id INT NULL AFTER client_detail;
ALTER TABLE margin_roster_entries ADD COLUMN IF NOT EXISTS subvendor_id INT NULL AFTER subvendor_text;

-- One row per consultant per Ledger upload (same pattern as
-- margin_roster_entries). Ledger's natural grain is a subvendor payment
-- line, not a roster snapshot, so one row here is one consultant's payment
-- for one subvendor in one month of one upload, not "the current roster."
CREATE TABLE IF NOT EXISTS ledger_roster_entries (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  import_id       INT NOT NULL,
  organization_id INT NOT NULL,
  consultant_id   INT NULL,
  subvendor_id    INT NULL,
  name            VARCHAR(255) NOT NULL,
  subvendor_text  VARCHAR(255),
  client_tag      VARCHAR(32),
  month_label     VARCHAR(64),
  period_text     VARCHAR(255),
  amount          DECIMAL(12,2),
  rate            DECIMAL(12,2),
  hours           DECIMAL(10,2),
  paid_date       DATE,
  notes           VARCHAR(500),
  FOREIGN KEY (import_id) REFERENCES ledger_imports(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  INDEX idx_ledger_roster_import (import_id),
  INDEX idx_ledger_roster_org_name (organization_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Foreign keys for the directory links, added after both sides exist.
ALTER TABLE margin_roster_entries ADD CONSTRAINT fk_margin_roster_consultant FOREIGN KEY IF NOT EXISTS (consultant_id) REFERENCES consultants(id) ON DELETE SET NULL;
ALTER TABLE margin_roster_entries ADD CONSTRAINT fk_margin_roster_client FOREIGN KEY IF NOT EXISTS (client_id) REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE margin_roster_entries ADD CONSTRAINT fk_margin_roster_program FOREIGN KEY IF NOT EXISTS (program_id) REFERENCES programs(id) ON DELETE SET NULL;
ALTER TABLE margin_roster_entries ADD CONSTRAINT fk_margin_roster_subvendor FOREIGN KEY IF NOT EXISTS (subvendor_id) REFERENCES subvendors(id) ON DELETE SET NULL;
ALTER TABLE ledger_roster_entries ADD CONSTRAINT fk_ledger_roster_consultant FOREIGN KEY IF NOT EXISTS (consultant_id) REFERENCES consultants(id) ON DELETE SET NULL;
ALTER TABLE ledger_roster_entries ADD CONSTRAINT fk_ledger_roster_subvendor FOREIGN KEY IF NOT EXISTS (subvendor_id) REFERENCES subvendors(id) ON DELETE SET NULL;
-- The cleaned payments file has a "Year" column (the year of the hours the
-- payment covers) and marks unpaid rows with a red Amount cell.
ALTER TABLE ledger_roster_entries ADD COLUMN IF NOT EXISTS year_text VARCHAR(32) NULL;
ALTER TABLE ledger_roster_entries ADD COLUMN IF NOT EXISTS unpaid TINYINT(1) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Assignments: a consultant's billing rate on a specific client/program.
-- One consultant can be billed on more than one client/program at once (or
-- over time), so this is its own table rather than a field on `consultants`
-- -- each row is one (consultant, client, program) pairing and its current
-- billing $/hr. `program_id` is nullable (a Margin row with no "/" in its
-- Client / Account value has no program detail); `client_id` is nullable too
-- so a manually-added assignment doesn't have to specify one up front.
--
-- Populated automatically from every Margin upload (one row per distinct
-- pairing seen, billing kept in sync with the file -- see
-- src/routes/assignmentUpsert.js) and also addable/editable by hand from
-- the Directory's Consultants tab, e.g. for a pairing not yet in any
-- upload. Unlike email/phone/address, a later upload DOES overwrite the
-- billing on a matching pairing -- same reasoning as `status` elsewhere in
-- this file: billing is meant to track the latest file, not a fact a
-- person is expected to maintain by hand once it's covered by uploads.
CREATE TABLE IF NOT EXISTS consultant_assignments (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  consultant_id   INT NOT NULL,
  client_id       INT NULL,
  program_id      INT NULL,
  billing         DECIMAL(12,2) NULL,
  source          ENUM('upload', 'manual') NOT NULL DEFAULT 'manual',
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (consultant_id) REFERENCES consultants(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
  INDEX idx_assignment_org_consultant (organization_id, consultant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A pairing is 'active' while the latest Margin file that names it has an
-- Active row for it, and 'left' once the file only has Left rows for it
-- (left_date = the date that row gives, when it gives one). Left pairings
-- stay as history but are never invoiced.
ALTER TABLE consultant_assignments ADD COLUMN IF NOT EXISTS status ENUM('active', 'left') NOT NULL DEFAULT 'active';
ALTER TABLE consultant_assignments ADD COLUMN IF NOT EXISTS left_date DATE NULL;

-- Alternate names for a client/program as an hours file writes them in its
-- Client column (Fin-Module > Import hours). The directory keeps one name per
-- client/program, so when a file says "International Resource Group/State of RI"
-- for the IRG program under State of RI, a person merges that text into the
-- existing pairing once and it is saved here; later imports of the same text
-- match automatically (see src/routes/clientAliases.js). alias_key is the text
-- lower-cased with spaces collapsed and none around "/". Added October 2026;
-- additive and safe to re-run.
CREATE TABLE IF NOT EXISTS client_text_aliases (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  alias_key       VARCHAR(255) NOT NULL,
  alias_text      VARCHAR(255) NOT NULL,
  client_id       INT NOT NULL,
  program_id      INT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
  UNIQUE KEY uq_client_alias (organization_id, alias_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- "Smart parser" duplicate detection. An exact name match (case/whitespace
-- insensitive, see directoryUpsert.js) always resolves to the same record
-- and never creates a second one. This table is for the close-but-not-exact
-- case -- a likely typo or formatting slip ("Jon Smith" vs "John Smith") --
-- which is never merged automatically, since two different people can
-- genuinely share a very similar name. Instead it's logged here the moment
-- a brand-new record is created, for a person to confirm or dismiss from
-- the Directory page (see directoryDedup.js and the /api/directory/duplicates
-- routes).
--
-- table_name is one of 'consultants' | 'subvendors' | 'clients' | 'programs'.
-- No FK on record_id/matched_record_id -- which table they point into
-- depends on table_name, so the app is responsible for cleaning up a flag
-- when either side of the pair is deleted or merged.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS directory_duplicate_candidates (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  organization_id   INT NOT NULL,
  table_name        VARCHAR(32) NOT NULL,
  record_id         INT NOT NULL,
  matched_record_id INT NOT NULL,
  similarity        DECIMAL(4,3) NOT NULL,
  status            ENUM('open', 'dismissed', 'merged') NOT NULL DEFAULT 'open',
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at       TIMESTAMP NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_dup_pair (table_name, record_id, matched_record_id),
  INDEX idx_dup_org_status (organization_id, table_name, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Fin-Module: monthly invoices. One invoice per (consultant, client, program)
-- billing pairing per calendar month -- that three-field combination is the
-- uniqueness key (see src/routes/invoices.js's generate route, which enforces
-- it with a NULL-safe lookup before inserting, the same pattern
-- assignmentUpsert.js uses for consultant_assignments; a plain UNIQUE KEY
-- can't do this on its own because MySQL treats two NULLs as distinct).
--
-- Generated from consultant_assignments: rate is copied from that pairing's
-- billing ($/hr, see the comment on consultant_assignments above) at the
-- moment of generation, and the invoice is always billed to the Program on
-- that pairing -- falling back to the Client when the pairing has no program
-- (no "/" in the original Client / Account value), since that's the nearest
-- billable party. A pairing with neither a client nor a program, or with no
-- billing rate set, has nothing to invoice and is skipped.
--
-- hours and amount are both nullable and independently editable after
-- generation (see PATCH /api/invoices/:id) -- hours has no system of record
-- (see the comment on margin_roster_entries / consultant_assignments: Margin
-- carries a $/hr rate but no hours-worked field), so this leaves it to
-- whoever fills in the invoice, by typing hours (amount auto-computes as
-- rate x hours) or by typing a dollar amount directly.
--
-- bill_to_* columns are a snapshot of the Program's (or Client's) contact
-- details as of generation time, so a later edit to that directory record
-- doesn't silently rewrite an already-issued invoice.
CREATE TABLE IF NOT EXISTS invoices (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  organization_id     INT NOT NULL,
  invoice_number      VARCHAR(64) NOT NULL,
  consultant_id       INT NOT NULL,
  client_id           INT NULL,
  program_id          INT NULL,
  assignment_id       INT NULL,
  period_month        DATE NOT NULL, -- always the 1st of the month
  rate                DECIMAL(12,2) NULL,
  hours               DECIMAL(8,2) NULL,
  amount              DECIMAL(12,2) NULL,
  bill_to_name        VARCHAR(255),
  bill_to_email       VARCHAR(255),
  bill_to_phone       VARCHAR(64),
  bill_to_address     VARCHAR(500),
  net_terms           VARCHAR(16) NOT NULL DEFAULT 'NET30', -- e.g. NET15/30/45/60/90
  issue_date          DATE NOT NULL,
  due_date            DATE NOT NULL,
  payment_status      ENUM('unpaid', 'paid') NOT NULL DEFAULT 'unpaid',
  timesheet_submitted ENUM('yes', 'no') NOT NULL DEFAULT 'no',
  notes               VARCHAR(1000),
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (consultant_id) REFERENCES consultants(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
  FOREIGN KEY (assignment_id) REFERENCES consultant_assignments(id) ON DELETE SET NULL,
  UNIQUE KEY uq_invoice_number (organization_id, invoice_number),
  INDEX idx_invoice_org_period (organization_id, period_month),
  INDEX idx_invoice_combo (organization_id, consultant_id, client_id, program_id, period_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Hours-file import (public/invoices.html "Import hours"): how the consultant is
-- paid (W2 / 1099 / Subvendor, plus the Payment Terms text as written and the
-- subvendor when it is a known one) and where the invoice came from.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_category VARCHAR(16) NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(255) NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subvendor_id INT NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source VARCHAR(32) NULL;

-- ---------------------------------------------------------------------------
-- Fin-Module, "Subvendor payments": invoices from subvendors to Mentour for
-- each consultant they supply, one per (subvendor, consultant, month).
--
-- Months already paid (the "2026 sub vendor payments" Ledger file) are NOT
-- stored here -- they're read straight from ledger_roster_entries for the
-- latest Ledger import and shown read-only, so they can never drift from
-- the file. This table only holds invoices *generated* for future months
-- (December 2026 onwards, see src/routes/subvendorInvoices.js), from the $/hr
-- rate on the Ledger file (rate_source 'ledger') or, when a pairing has no
-- Ledger rate, the Margin file's cost rate for that subvendor consultant
-- (rate_source 'margin' -- Margin's "billing" is what Mentour charges the
-- client, not what the subvendor charges Mentour; its "cost" is).
--
-- Generated invoices are editable like client invoices (hours/amount, NET
-- terms, due date, paid/unpaid, timesheet submitted, notes) via PATCH
-- /api/subvendor-invoices/:id; only the months read from the Ledger file
-- are read-only. The four key columns are NOT NULL, so the unique key is a
-- real DB-level guard here. Generation is only offered for months after the
-- payments file's last month.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subvendor_invoices (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  invoice_number  VARCHAR(64) NOT NULL,
  subvendor_id    INT NOT NULL,
  consultant_id   INT NOT NULL,
  period_month    DATE NOT NULL, -- always the 1st of the month
  rate            DECIMAL(12,2) NOT NULL,
  hours           DECIMAL(8,2) NULL,
  amount          DECIMAL(12,2) NULL,
  rate_source     ENUM('ledger', 'margin') NOT NULL,
  net_terms       VARCHAR(16) NOT NULL DEFAULT 'NET30',
  issue_date      DATE NOT NULL,
  due_date        DATE NOT NULL,
  payment_status      ENUM('unpaid', 'paid') NOT NULL DEFAULT 'unpaid',
  timesheet_submitted ENUM('yes', 'no') NOT NULL DEFAULT 'no',
  notes           VARCHAR(1000),
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (subvendor_id) REFERENCES subvendors(id) ON DELETE CASCADE,
  FOREIGN KEY (consultant_id) REFERENCES consultants(id) ON DELETE CASCADE,
  UNIQUE KEY uq_subvendor_invoice (organization_id, subvendor_id, consultant_id, period_month),
  UNIQUE KEY uq_subvendor_invoice_number (organization_id, invoice_number),
  INDEX idx_subvendor_invoice_period (organization_id, period_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Upgrade path for a database that already created subvendor_invoices before
-- it became editable. Safe to re-run.
ALTER TABLE subvendor_invoices ADD COLUMN IF NOT EXISTS payment_status ENUM('unpaid', 'paid') NOT NULL DEFAULT 'unpaid' AFTER due_date;
ALTER TABLE subvendor_invoices ADD COLUMN IF NOT EXISTS timesheet_submitted ENUM('yes', 'no') NOT NULL DEFAULT 'no' AFTER payment_status;
ALTER TABLE subvendor_invoices ADD COLUMN IF NOT EXISTS notes VARCHAR(1000) NULL AFTER timesheet_submitted;
ALTER TABLE subvendor_invoices MODIFY COLUMN hours DECIMAL(8,2) NULL;
ALTER TABLE subvendor_invoices MODIFY COLUMN rate_source ENUM('ledger', 'margin', 'hours_file') NOT NULL;
ALTER TABLE subvendor_invoices MODIFY COLUMN amount DECIMAL(12,2) NULL;

-- Session store table (used by express-mysql-session; it will create/manage
-- this automatically, but it's listed here for visibility). No action needed.
