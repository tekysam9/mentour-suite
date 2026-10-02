require('dotenv').config();
const path = require('path');
const express = require('express');

const { sessionMiddleware } = require('./src/auth');
const authRoutes = require('./src/routes/auth');
const createImportRouter = require('./src/routes/imports');
const { saveMarginRoster } = require('./src/routes/marginRoster');
const { saveLedgerRoster } = require('./src/routes/ledgerRoster');
const directoryRoutes = require('./src/routes/directory');
const invoiceRoutes = require('./src/routes/invoices');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // Hostinger sits behind a proxy/load balancer

app.use(express.json({ limit: '15mb' }));
app.use(sessionMiddleware);

app.use('/api/auth', authRoutes);
app.use('/api/ledger', createImportRouter('ledger_imports', { onSave: saveLedgerRoster }));
app.use('/api/margin', createImportRouter('margin_imports', { onSave: saveMarginRoster }));
app.use('/api/directory', directoryRoutes);
app.use('/api/invoices', invoiceRoutes);

app.use(express.static(path.join(__dirname, 'public')));

// Fallback 404 for unknown API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Central error handler
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mentour Suite listening on port ${PORT}`);
});
