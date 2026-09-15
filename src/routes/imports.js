const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');

// tableName is always one of the two hardcoded literals passed by server.js
// below (never derived from user input), so building the query string with
// it is safe.
function createImportRouter(tableName) {
  const router = express.Router();
  router.use(requireAuth);

  // Save a freshly-parsed workbook for this organization.
  router.post('/', async (req, res, next) => {
    const { fileName, data } = req.body || {};
    if (!fileName || !data) return res.status(400).json({ error: 'Missing fileName or data.' });
    try {
      const [result] = await pool.query(
        `INSERT INTO ${tableName} (organization_id, uploaded_by, file_name, data) VALUES (?, ?, ?, CAST(? AS JSON))`,
        [req.user.organization_id, req.user.id, String(fileName).slice(0, 255), JSON.stringify(data)]
      );
      const [rows] = await pool.query(`SELECT id, file_name, imported_at FROM ${tableName} WHERE id = ?`, [result.insertId]);
      res.status(201).json({ import: rows[0] });
    } catch (err) {
      next(err);
    }
  });

  // Most recent import for this organization (what the dashboard loads by default).
  router.get('/latest', async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT id, file_name, imported_at, data FROM ${tableName} WHERE organization_id = ? ORDER BY imported_at DESC LIMIT 1`,
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
         WHERE i.organization_id = ? ORDER BY i.imported_at DESC LIMIT 50`,
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
