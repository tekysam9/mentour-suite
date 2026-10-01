const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');

// tableName is always one of the two hardcoded literals passed by server.js
// below (never derived from user input), so building the query string with
// it is safe.
//
// options.onSave, when given, runs inside the same transaction as the
// insert into `tableName` — use it to also break the payload out into
// normalized rows elsewhere (see src/routes/marginRoster.js for the one
// real use: populating margin_roster_entries from a Margin upload). It's
// called as onSave(conn, { organizationId, uploadedBy, importId, data })
// and any error it throws rolls back the whole save, so a partial/garbled
// upload can never leave the blob and the normalized rows out of sync.
function createImportRouter(tableName, options) {
  const onSave = options && options.onSave;
  const router = express.Router();
  router.use(requireAuth);

  // Save a freshly-parsed workbook for this organization.
  router.post('/', async (req, res, next) => {
    const { fileName, data } = req.body || {};
    if (!fileName || !data) return res.status(400).json({ error: 'Missing fileName or data.' });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO ${tableName} (organization_id, uploaded_by, file_name, data) VALUES (?, ?, ?, ?)`,
        [req.user.organization_id, req.user.id, String(fileName).slice(0, 255), JSON.stringify(data)]
      );
      const importId = result.insertId;
      if (onSave) {
        await onSave(conn, {
          organizationId: req.user.organization_id,
          uploadedBy: req.user.id,
          importId,
          data,
        });
      }
      await conn.commit();
      const [rows] = await pool.query(`SELECT id, file_name, imported_at FROM ${tableName} WHERE id = ?`, [importId]);
      res.status(201).json({ import: rows[0] });
    } catch (err) {
      await conn.rollback();
      next(err);
    } finally {
      conn.release();
    }
  });

  // Most recent import for this organization (what the dashboard loads by default).
  router.get('/latest', async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        // id DESC breaks ties: imported_at is a TIMESTAMP with only
        // second precision, so two saves in the same second would
        // otherwise sort unpredictably instead of newest-first.
        `SELECT id, file_name, imported_at, data FROM ${tableName} WHERE organization_id = ? ORDER BY imported_at DESC, id DESC LIMIT 1`,
        [req.user.organization_id]
      );
      if (!rows.length) return res.json({ import: null });
      res.json({ import: rows[0] });
    } catch (err) {
      next(err);
    }
  });

  // List of past imports (without the full payload) so the UI can offer a history picker.
  router.get('/history', async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT i.id, i.file_name, i.imported_at, u.name AS uploaded_by_name
         FROM ${tableName} i JOIN users u ON u.id = i.uploaded_by
         WHERE i.organization_id = ? ORDER BY i.imported_at DESC, i.id DESC LIMIT 50`,
        [req.user.organization_id]
      );
      res.json({ history: rows });
    } catch (err) {
      next(err);
    }
  });

  // Fetch one specific historical import (scoped to this organization).
  router.get('/:id', async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT id, file_name, imported_at, data FROM ${tableName} WHERE id = ? AND organization_id = ? LIMIT 1`,
        [req.params.id, req.user.organization_id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found.' });
      res.json({ import: rows[0] });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createImportRouter;
