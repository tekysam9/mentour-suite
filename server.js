require('dotenv').config();
const path = require('path');
const express = require('express');

const { sessionMiddleware } = require('./src/auth');
const authRoutes = require('./src/routes/auth');
const createImportRouter = require('./src/routes/imports');
const { saveMarginRoster } = require('./src/routes/marginRoster');
const { saveLedgerRoster } = require('./src/routes/ledgerRoster');
const rosterRoutes = require('./src/routes/roster');
const directoryRoutes = require('./src/routes/directory');
const directoryImportRoutes = require('./src/routes/directoryImport');
const invoiceRoutes = require('./src/routes/invoices');
const subvendorInvoiceRoutes = require('./src/routes/subvendorInvoices');
const onboardingRoutes = require('./src/routes/onboarding');
const prePlacementRoutes = require('./src/routes/prePlacement');
const profileRoutes = require('./src/routes/profiles');
const formRoutes = require('./src/routes/forms');
const versionRoutes = require('./src/routes/version');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // Hostinger sits behind a proxy/load balancer

// Security headers on every response.
const PROD = process.env.NODE_ENV === 'production';
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    // Only this site's own scripts, styles, images, fonts and connections: injected content cannot pull in a script from, or send data to, another site.
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-src 'none'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'",
  });
  if (PROD) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});
// A browser sends Origin on every cross-site write: refuse writes that come from another site.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch (e) { /* bad header */ }
    if (host !== req.get('host')) return res.status(403).json({ error: 'This request came from another website and was blocked.' });
  }
  next();
});
if (PROD && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 24 || /^(changeme|secret|password)/i.test(process.env.SESSION_SECRET))) {
  console.error('SECURITY WARNING: SESSION_SECRET is missing, short or a placeholder. Set it to a long random value (at least 32 characters) in the hosting environment variables, then restart. Everyone will have to sign in again.');
}
app.use(require('compression')()); // smaller pages/JSON on slow connections
app.use(sessionMiddleware);
// Request size: 1 MB everywhere. Only the spreadsheet/document upload routes take up to 15 MB, and (apart from the
// vendor portal's token-checked document upload) only for a signed-in person, so strangers cannot make the server read big bodies.
const BIG_SIGNED_IN = /^\/api\/(ledger|margin|directory-import|payment-history|invoices\/import-hours|onboarding\/[^/]+\/documents|pre-placement\/\d+\/resume)(\/|$)/;
const BIG_VENDOR_UPLOAD = /^\/api\/vendor-portal\/[^/]+\/documents$/;
const jsonSmall = express.json({ limit: '1mb' });
const jsonBig = express.json({ limit: '15mb' });
app.use((req, res, next) => {
  const signedIn = !!(req.session && req.session.userId);
  const big = (signedIn && BIG_SIGNED_IN.test(req.path)) || BIG_VENDOR_UPLOAD.test(req.path);
  return (big ? jsonBig : jsonSmall)(req, res, next);
});

app.use('/api', require('./src/audit').auditWrites);
app.use('/api/version', versionRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/ledger', createImportRouter('ledger_imports', { onSave: saveLedgerRoster }));
app.use('/api/roster', rosterRoutes);
app.use('/api/margin', createImportRouter('margin_imports', { onSave: saveMarginRoster }));
app.use('/api/directory-import', directoryImportRoutes);
app.use('/api/data-check', require('./src/routes/dataCheck'));
app.use('/api/audit', require('./src/routes/auditLog'));
app.use('/api/payment-history', require('./src/routes/paymentHistory'));
app.use('/api/directory', directoryRoutes);
app.use('/api/profiles', profileRoutes);
app.use('/api/forms', formRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/subvendor-invoices', subvendorInvoiceRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/pre-placement', prePlacementRoutes);
app.use('/api/mail-settings', require('./src/routes/mailSettings'));
app.use('/api/vendor-portal', require('./src/routes/vendorPortal'));

// Pages/scripts/styles revalidate (ETag -> tiny 304) so a deploy shows up at
// once; fonts and the spreadsheet library never change, so they cache long.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders(res, file) {
    if (/[\\/](fonts|lib)[\\/]/.test(file)) res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    else res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Fallback 404 for unknown API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Central error handler
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request could not be read.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mentour Suite listening on port ${PORT}`);
  if (process.env.NODE_ENV !== 'test') require('./src/nightlyDuplicateScan').start();
});
