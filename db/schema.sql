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

-- Session store table (used by express-mysql-session; it will create/manage
-- this automatically, but it's listed here for visibility). No action needed.
