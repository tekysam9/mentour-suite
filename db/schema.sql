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
  status          ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
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
  status          ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
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

-- Session store table (used by express-mysql-session; it will create/manage
-- this automatically, but it's listed here for visibility). No action needed.
