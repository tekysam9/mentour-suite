// "Import hours" for the Fin-Module: turns the multi-year "New hire hours by
// month" workbook into client invoices (and, for subvendor consultants,
// subvendor invoices). The browser reads the workbook (public/invoices.html)
// and sends one flat row per consultant / client / month:
//
//   { sheet, name, client, year, month, hours, hoursNote, paymentTerms, startDate, leftDate }
//
// Rules (agreed with the owner of the data):
//   * Billing is one month in arrears, like the rest of Fin-Module: the hours of
//     a month go on the NEXT month's invoice (Jul 2019 hours -> Aug 2019
//     invoice), issued on the 1st of the invoice month. Hours of a month after
//     the current month are held back. `arrears: false` bills the hours month itself.
//   * Rate = the billing rate already on the consultant's pairing in the
//     Directory. The file's Bill rate column is NOT read. A pairing without a
//     rate still gets its invoice, with no rate and $0, flagged in the notes.
//   * Missing consultants, clients, programs and pairings ARE created (a
//     consultant with no status -- only a Margin upload sets Active/Inactive;
//     a new pairing is marked left when the file gives a left date).
//   * "Program/Client" in the Client column is split at the FIRST "/" exactly
//     like the Margin file (pre-slash = Program, post-slash = Client).
//   * Payment Terms: W2 / W-2 / W-2 Canada / W2/SMBA -> category W2, 1099 ->
//     1099, anything else is a subvendor company name -> category Subvendor.
//     Category + the raw text are stored on the client invoice. Subvendor
//     rows also get a Subvendor-payments invoice (hours from the file, the
//     best known $/hr or none) when the subvendor is in Directory (or the
//     caller asks to create it).
//   * Hours hours outside the consultant's Start Date .. Date-if-left are
//     skipped and reported. Non-numeric hours cells are reported, never guessed.
//   * Existing invoices that already have hours are never touched; one still
//     at 0 / blank hours is filled in.
//   * Nothing is written unless apply=true, and then it is one transaction.
//     The apply step re-derives the plan on the server.

const { normalizeName, findOrCreateDirectoryRecord } = require('./directoryUpsert');
const { aliasKey, loadAliasMap } = require('./clientAliases');

const MAX_ROWS = 30000;
const LIST_CAP = 200;
const ISSUE_CAP = 3000;
const BATCH = 400;

function pad2(n) { return String(n).padStart(2, '0'); }
function toDateOnly(d) { return d.toISOString().slice(0, 10); }
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days));
  return toDateOnly(d);
}
function round2(n) { return Math.round(n * 100) / 100; }
function dateOnlyValue(v) {
  if (!v) return null;
  if (v instanceof Date) return toDateOnly(v);
  return String(v).slice(0, 10);
}
function nameKey(v) {
  const n = normalizeName(v);
  return n ? n.toLowerCase() : null;
}
// Looser key for matching a subvendor company written a little differently
// ("MOURI Tech LLC" vs "Mouri Tech, LLC"): letters and digits only, with a
// trailing legal suffix dropped.
function companyKey(v) {
  const n = nameKey(v);
  if (!n) return null;
  const k = n.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|pvt|private|incorporated)\b\s*$/g, '').trim()
    .replace(/\s+/g, '');
  return k || null;
}

// "Abdul Vasi-2", "Jinqing Huang -1": the numeric suffix only tells apart one
// person's second engagement in the same month. Same person.
function cleanConsultantName(raw) {
  const n = normalizeName(raw);
  if (!n) return null;
  const m = /^(.*\S)\s*-\s*\d{1,2}$/.exec(n);
  if (m && /[A-Za-z]/.test(m[1])) return { name: m[1].trim(), stripped: n };
  return { name: n, stripped: null };
}

// Same split as the Margin file: pre-slash = Program, post-slash = Client.
function splitClient(text) {
  const i = text.indexOf('/');
  if (i < 0) return { client: text, program: null };
  const p = normalizeName(text.slice(0, i));
  const c = normalizeName(text.slice(i + 1));
  if (!c) return { client: p || text, program: null };
  if (!p) return { client: c, program: null };
  return { client: c, program: p };
}

function classifyTerms(raw) {
  const t = normalizeName(raw);
  if (!t) return { category: null, text: null };
  if (/^w[\s-]?2(\b|$)/i.test(t)) return { category: 'W2', text: t };
  if (/\b1099\b/.test(t)) return { category: '1099', text: t }; // "1099", "Shyam 1099", "Veetridyn 1099 - CANADA"
  return { category: 'Subvendor', text: t };
}

function periodOf(year, month) { return year + '-' + pad2(month) + '-01'; }
// Hours month -> invoice month 'YYYY-MM' (one month later unless arrears is off).
function invoiceMonthFor(year, month, arrears) {
  if (!arrears) return year + '-' + pad2(month);
  return month === 12 ? (year + 1) + '-01' : year + '-' + pad2(month + 1);
}
// 'YYYY-MM' of today in the business's time zone.
function currentMonthKeyNY(now) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit' })
    .formatToParts(now || new Date());
  const get = (t) => parts.find((x) => x.type === t).value;
  return get('year') + '-' + get('month');
}
function monthEnd(year, month) { return toDateOnly(new Date(Date.UTC(year, month, 0))); }

function sanitizeDate(v) {
  const s = String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

async function planImport(conn, organizationId, body) {
  const rows = body.rows;
  const arrears = body.arrears !== false && body.arrears !== 'false';
  const nowKey = currentMonthKeyNY();
  const enforceDates = body.enforceDates !== false && body.enforceDates !== 'false';
  const createSubvendors = body.createSubvendors === true || body.createSubvendors === 'true' || body.createSubvendors === 1;

  // ---- Directory snapshot ------------------------------------------------
  const [consultants] = await conn.query('SELECT id, name FROM consultants WHERE organization_id = ?', [organizationId]);
  const consByKey = new Map();
  for (const c of consultants) {
    const k = nameKey(c.name);
    consByKey.set(k, consByKey.has(k) ? null : c); // null = two consultants share the name
  }
  const [clientRows] = await conn.query('SELECT id, name, email, phone, address FROM clients WHERE organization_id = ?', [organizationId]);
  const clientByKey = new Map(clientRows.map((c) => [nameKey(c.name), c]));
  const clientById = new Map(clientRows.map((c) => [c.id, c]));
  const [programRows] = await conn.query('SELECT id, client_id, name, email, phone, address FROM programs WHERE organization_id = ?', [organizationId]);
  const programByKey = new Map(programRows.map((p) => [p.client_id + '|' + nameKey(p.name), p]));
  const programById = new Map(programRows.map((p) => [p.id, p]));
  const [assignRows] = await conn.query(
    `SELECT id, consultant_id, client_id, program_id, billing FROM consultant_assignments WHERE organization_id = ?`, [organizationId]);
  const assignsByConsultant = new Map();
  for (const a of assignRows) {
    if (!assignsByConsultant.has(a.consultant_id)) assignsByConsultant.set(a.consultant_id, []);
    assignsByConsultant.get(a.consultant_id).push(a);
  }
  const [subRows] = await conn.query('SELECT id, name FROM subvendors WHERE organization_id = ?', [organizationId]);
  const subByKey = new Map();
  for (const s of subRows) {
    for (const k of [nameKey(s.name), companyKey(s.name)]) {
      if (!k) continue;
      subByKey.set(k, subByKey.has(k) && subByKey.get(k).id !== s.id ? null : s);
    }
  }

  const aliases = await loadAliasMap(conn, organizationId);

  const issues = []; // every row-level problem, grouped in the UI by `kind`
  const issue = (kind, r, reason, extra) => issues.push(Object.assign({
    kind, sheet: r.sheet, row: r.rowNo, name: r.nameText, client: r.clientText,
    period: r.year && r.month ? r.year + '-' + pad2(r.month) : null, reason,
  }, extra || {}));

  // ---- 1. Clean the rows -------------------------------------------------
  const items = [];
  const spanRows = []; // every named row, even with blank hours: a left date is often typed on a month with none
  const suffixNames = new Map(); // stripped -> clean
  let noHours = 0;
  rows.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') return;
    const cn = cleanConsultantName(raw.name);
    if (!cn) return;
    const year = Number(raw.year);
    const month = Number(raw.month);
    const r = {
      rowNo: idx + 1, sheet: raw.sheet ? String(raw.sheet).slice(0, 64) : null,
      nameText: cn.name, consKey: cn.name.toLowerCase(),
      clientText: normalizeName(raw.client) || '',
      year, month,
      hours: raw.hours === null || raw.hours === undefined || raw.hours === '' ? null : Number(raw.hours),
      hoursNote: raw.hoursNote ? String(raw.hoursNote).slice(0, 80) : null,
      terms: classifyTerms(raw.paymentTerms),
      start: sanitizeDate(raw.startDate), left: sanitizeDate(raw.leftDate),
    };
    if (cn.stripped) suffixNames.set(cn.stripped, cn.name);
    if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
      issue('sheet', r, 'sheet has no readable month/year'); return;
    }
    spanRows.push(r);
    r.hoursYm = year + '-' + pad2(month);
    r.invoiceYm = invoiceMonthFor(year, month, arrears);
    if (r.hoursYm > nowKey) { if (r.hours > 0) issue('future', r, 'month is in the future', { hours: r.hours }); return; }
    if (r.hoursNote && !(r.hours > 0)) { issue('hours-text', r, 'hours cell says "' + r.hoursNote + '"'); return; }
    if (!(r.hours > 0) || !Number.isFinite(r.hours)) { noHours++; return; }
    items.push(r);
  });

  // ---- 2. Start / left dates per consultant + client ---------------------
  const span = new Map();
  for (const r of spanRows) {
    const k = r.consKey + '|' + r.clientText.toLowerCase();
    let s = span.get(k);
    if (!s) { s = { starts: [], lefts: [] }; span.set(k, s); }
    if (r.start) s.starts.push(r.start);
    if (r.left) s.lefts.push(r.left);
  }
  for (const s of span.values()) {
    s.start = s.starts.length ? s.starts.reduce((a, b) => (a < b ? a : b)) : null;
    let left = s.lefts.length ? s.lefts.reduce((a, b) => (a > b ? a : b)) : null;
    // A Start Date after the left date means they came back: no left limit.
    if (left && s.starts.some((d) => d > left)) left = null;
    s.left = left;
  }
  const inRange = [];
  for (const r of items) {
    const s = span.get(r.consKey + '|' + r.clientText.toLowerCase());
    r.spanLeft = s.left;
    if (!enforceDates) { inRange.push(r); continue; }
    if (s.start && monthEnd(r.year, r.month) < s.start) { issue('outside-range', r, 'before Start Date ' + s.start, { hours: r.hours }); continue; }
    if (s.left && periodOf(r.year, r.month) > s.left) { issue('outside-range', r, 'after Date-if-left ' + s.left, { hours: r.hours }); continue; }
    inRange.push(r);
  }

  // ---- 3. Resolve consultant + pairing ----------------------------------
  const newCons = new Map();   // consKey -> display name
  const newPairs = new Map();  // pairKey -> { consKey, client, program, left }
  const resolved = new Map();  // consKey|clientLower -> resolution
  const planned = new Map();   // pairRef|year|month -> item
  const dup = new Set();

  function resolvePairing(r) {
    const rk = r.consKey + '|' + r.clientText.toLowerCase();
    if (resolved.has(rk)) return resolved.get(rk);
    let res;
    const cons = consByKey.get(r.consKey);
    if (cons === null) res = { bad: ['consultant', 'two consultants share this name in Directory'] };
    else if (!r.clientText) res = { bad: ['client', 'no client on this row'] };
    else {
      let cands = [];
      if (cons) {
        const mine = assignsByConsultant.get(cons.id) || [];
        const whole = nameKey(r.clientText);
        const sp = splitClient(r.clientText);
        const progKey = sp.program ? nameKey(sp.program) : null;
        const clientKey = nameKey(sp.client);
        const nameOf = (a) => (a.client_id && clientById.get(a.client_id) ? nameKey(clientById.get(a.client_id).name) : null);
        const progOf = (a) => (a.program_id && programById.get(a.program_id) ? nameKey(programById.get(a.program_id).name) : null);
        const alias = aliases.get(aliasKey(r.clientText));
        if (alias) cands = mine.filter((a) => a.client_id === alias.client_id && (a.program_id || null) === (alias.program_id || null));
        if (!cands.length) cands = mine.filter((a) => nameOf(a) === whole && !a.program_id);
        if (!cands.length) cands = mine.filter((a) => nameOf(a) === clientKey && (progKey === null || progOf(a) === progKey));
      }
      if (cands.length > 1) res = { bad: ['client', 'matches more than one program — put "Program/Client" in the Client column'] };
      else if (cands.length === 1) res = { cons, a: cands[0], ref: 'a' + cands[0].id };
      else {
        const sp = splitClient(r.clientText);
        const pairKey = r.consKey + '|' + nameKey(sp.client) + '|' + (sp.program ? nameKey(sp.program) : '');
        if (!newPairs.has(pairKey)) newPairs.set(pairKey, { consKey: r.consKey, client: sp.client, program: sp.program, left: enforceDates ? (r.spanLeft || null) : null });
        res = { cons, pairKey, ref: 'n' + pairKey, client: sp.client, program: sp.program };
        if (!cons && !newCons.has(r.consKey)) newCons.set(r.consKey, r.nameText);
      }
    }
    resolved.set(rk, res);
    return res;
  }

  for (const r of inRange) {
    const res = resolvePairing(r);
    if (res.bad) { issue(res.bad[0], r, res.bad[1], { hours: r.hours }); continue; }
    const key = res.ref + '|' + r.invoiceYm;
    const conflictNote = 'this consultant/client appears on more than one row for the month';
    if (planned.has(key)) {
      // Report the first row too, then drop both: which one is right is the owner's call.
      const first = planned.get(key).r;
      issue('conflict', first, conflictNote, { hours: first.hours });
      planned.delete(key); dup.add(key);
      issue('conflict', r, conflictNote, { hours: r.hours });
      continue;
    }
    if (dup.has(key)) { issue('conflict', r, conflictNote, { hours: r.hours }); continue; }
    planned.set(key, { r, res });
  }

  // ---- 4. Existing invoices ----------------------------------------------
  const [invRows] = await conn.query(
    `SELECT id, consultant_id, client_id, program_id, period_month, hours, rate, payment_category
     FROM invoices WHERE organization_id = ?`, [organizationId]);
  const invByKey = new Map();
  for (const i of invRows) {
    invByKey.set(i.consultant_id + '|' + (i.client_id || 0) + '|' + (i.program_id || 0) + '|' + dateOnlyValue(i.period_month).slice(0, 7), i);
  }

  function idsFor(res) {
    if (res.a) return { consultantId: res.cons.id, clientId: res.a.client_id, programId: res.a.program_id };
    const cl = clientByKey.get(nameKey(res.client));
    const pr = cl && res.program ? programByKey.get(cl.id + '|' + nameKey(res.program)) : null;
    return {
      consultantId: res.cons ? res.cons.id : null,
      clientId: cl ? cl.id : null,
      programId: pr ? pr.id : null,
      clientMissing: !cl, programMissing: !!res.program && !pr,
    };
  }

  // ---- 5. Subvendors ------------------------------------------------------
  const unrecognized = new Map(); // text -> count
  const newSubs = new Map();      // companyKey -> name
  function subvendorFor(terms) {
    if (!terms || terms.category !== 'Subvendor') return null;
    const s = subByKey.get(nameKey(terms.text)) || subByKey.get(companyKey(terms.text));
    if (s) return { id: s.id, name: s.name };
    if (s === null) return null; // two subvendors collide on this name
    if (createSubvendors) {
      const ck = companyKey(terms.text) || nameKey(terms.text);
      if (!newSubs.has(ck)) newSubs.set(ck, terms.text);
      return { newKey: ck, name: terms.text };
    }
    return null;
  }

  // ---- 6. Plan the client invoices ---------------------------------------
  const willCreate = [];
  const willFill = [];
  const skippedExisting = [];
  let noRate = 0;
  const subAgg = new Map(); // consKey|subKey|YYYY-MM -> { r, sub, hours }
  for (const { r, res } of planned.values()) {
    const ids = idsFor(res);
    const ym = r.invoiceYm; // the invoice month
    const hym = r.hoursYm;  // the hours month
    const rate = res.a && res.a.billing !== null && res.a.billing !== undefined ? Number(res.a.billing) : null;
    const base = {
      consultant: res.cons ? res.cons.name : r.nameText, client: res.a ? (clientById.get(res.a.client_id) || {}).name : res.client,
      program: res.a ? (res.a.program_id ? (programById.get(res.a.program_id) || {}).name : null) : res.program,
      periodMonth: ym, hoursMonth: hym, hours: r.hours, category: r.terms.category, terms: r.terms.text,
    };
    const existing = ids.consultantId && !ids.clientMissing && !ids.programMissing
      ? invByKey.get(ids.consultantId + '|' + (ids.clientId || 0) + '|' + (ids.programId || 0) + '|' + ym) : null;
    const sub = subvendorFor(r.terms);
    if (r.terms.category === 'Subvendor' && !sub) unrecognized.set(r.terms.text, (unrecognized.get(r.terms.text) || 0) + 1);

    if (existing) {
      const eh = existing.hours === null || existing.hours === undefined ? null : Number(existing.hours);
      if (eh > 0) { skippedExisting.push(Object.assign(base, { invoiceId: existing.id, existingHours: eh })); continue; }
      const erate = existing.rate === null || existing.rate === undefined ? null : Number(existing.rate);
      willFill.push(Object.assign(base, {
        invoiceId: existing.id, rate: erate, amount: erate === null ? 0 : round2(erate * r.hours),
        _sub: sub, _terms: r.terms,
      }));
    } else {
      if (rate === null) noRate++;
      willCreate.push(Object.assign(base, {
        rate, amount: rate === null ? 0 : round2(rate * r.hours),
        _res: res, _ids: ids, _r: r, _sub: sub,
      }));
    }
    if (sub) {
      const sk = r.consKey + '|' + (sub.id || sub.newKey) + '|' + hym;
      const a = subAgg.get(sk);
      if (a) a.hours = round2(a.hours + r.hours);
      else subAgg.set(sk, { r, res, sub, hours: r.hours, ym: hym });
    }
  }
  willCreate.sort((x, y) => x.periodMonth.localeCompare(y.periodMonth) || x.consultant.localeCompare(y.consultant));

  // ---- 7. Plan the subvendor invoices ------------------------------------
  const svc = require('./subvendorInvoices');
  const { records } = await svc.ledgerMonthlyRecords(conn, organizationId);
  const paidKeys = new Set(records.filter((x) => x.subvendor_id && x.consultant_id)
    .map((x) => x.subvendor_id + '|' + x.consultant_id + '|' + x.period_month.slice(0, 7)));
  const knownRate = new Map(); // subId|consultantId -> { rate, source }
  const ratePeriod = new Map();
  for (const x of records) {
    if (!x.subvendor_id || !x.consultant_id || x.rate === null) continue;
    const k = x.subvendor_id + '|' + x.consultant_id;
    if (!(ratePeriod.get(k) >= x.period_month)) { knownRate.set(k, { rate: x.rate, source: 'ledger' }); ratePeriod.set(k, x.period_month); }
  }
  const marginImp = await svc.latestImport(conn, 'margin_imports', organizationId);
  if (marginImp) {
    const [mRows] = await conn.query(
      `SELECT subvendor_id, consultant_id, cost FROM margin_roster_entries
       WHERE import_id = ? AND organization_id = ? AND employment_type = 'Subvendor'
         AND subvendor_id IS NOT NULL AND consultant_id IS NOT NULL AND cost IS NOT NULL`,
      [marginImp.id, organizationId]);
    for (const m of mRows) {
      const k = m.subvendor_id + '|' + m.consultant_id;
      if (!knownRate.has(k)) knownRate.set(k, { rate: Number(m.cost), source: 'margin' });
    }
  }
  const [svExisting] = await conn.query('SELECT subvendor_id, consultant_id, period_month FROM subvendor_invoices WHERE organization_id = ?', [organizationId]);
  const svExistingKeys = new Set(svExisting.map((x) => x.subvendor_id + '|' + x.consultant_id + '|' + dateOnlyValue(x.period_month).slice(0, 7)));
  const svCreate = [];
  let svSkipped = 0;
  for (const a of subAgg.values()) {
    const consId = a.res.cons ? a.res.cons.id : null;
    if (consId && a.sub.id) {
      const k = a.sub.id + '|' + consId + '|' + a.ym;
      if (paidKeys.has(k) || svExistingKeys.has(k)) { svSkipped++; continue; }
    }
    const kr = consId && a.sub.id ? knownRate.get(a.sub.id + '|' + consId) : null;
    svCreate.push({
      consultant: a.res.cons ? a.res.cons.name : a.r.nameText, subvendor: a.sub.name, periodMonth: a.ym, hours: a.hours,
      rate: kr ? kr.rate : 0, rateSource: kr ? kr.source : 'hours_file', _a: a,
    });
  }

  // ---- 8. Totals ----------------------------------------------------------
  const byYear = new Map();
  for (const w of willCreate) {
    const y = w.periodMonth.slice(0, 4);
    const e = byYear.get(y) || { year: Number(y), invoices: 0, hours: 0, amount: 0 };
    e.invoices++; e.hours = round2(e.hours + w.hours); e.amount = round2(e.amount + w.amount);
    byYear.set(y, e);
  }
  const used = new Set(); // pairings that actually get an invoice are the only ones created
  for (const w of willCreate) if (w._res.pairKey) used.add(w._res.pairKey);
  const pairsToCreate = [...newPairs.entries()].filter(([k]) => used.has(k));
  // Consultants/clients/programs are created only for pairings that get an
  // invoice (or a subvendor invoice), so a skipped row leaves no stray record.
  const newConsFinal = new Map();
  const newClientFinal = new Set();
  const newProgFinal = new Set();
  for (const [, p] of pairsToCreate) {
    if (!consByKey.get(p.consKey) && newCons.has(p.consKey)) newConsFinal.set(p.consKey, newCons.get(p.consKey));
    const ck = nameKey(p.client);
    if (!clientByKey.has(ck)) newClientFinal.add(ck);
    if (p.program) {
      const cl = clientByKey.get(ck);
      if (!cl || !programByKey.has(cl.id + '|' + nameKey(p.program))) newProgFinal.add(ck + '|' + nameKey(p.program));
    }
  }

  const issueCounts = {};
  for (const i of issues) issueCounts[i.kind] = (issueCounts[i.kind] || 0) + 1;
  const summary = {
    rowsRead: rows.length,
    willCreate: willCreate.length, willFill: willFill.length, skippedExisting: skippedExisting.length,
    totalHours: round2(willCreate.concat(willFill).reduce((t, w) => t + w.hours, 0)),
    totalAmount: round2(willCreate.concat(willFill).reduce((t, w) => t + w.amount, 0)),
    noRate, noHours,
    issues: issues.length, issueCounts,
    newConsultants: newConsFinal.size, newClients: newClientFinal.size, newPrograms: newProgFinal.size,
    newPairings: pairsToCreate.length, newSubvendors: createSubvendors ? [...newSubs.keys()].length : 0,
    subvendorInvoices: svCreate.length, subvendorInvoicesSkipped: svSkipped,
  };
  const notes = {
    nameSuffixes: [...suffixNames.entries()].slice(0, 100).map(([from, to]) => ({ from, to })),
    nameSuffixCount: suffixNames.size,
    unrecognizedTerms: [...unrecognized.entries()].sort((a, b) => b[1] - a[1]).map(([text, count]) => ({ text, count })),
    newConsultants: [...newConsFinal.values()].sort().slice(0, 500),
    newClients: [...newClientFinal].slice(0, 500),
  };

  return {
    summary, notes, issues, willCreate, willFill, skippedExisting, svCreate,
    byYear: [...byYear.values()].sort((a, b) => a.year - b.year),
    internals: {
      pairsToCreate, newConsFinal, newSubs, createSubvendors,
      clientByKey, programByKey, clientById, programById, consByKey,
    },
  };
}

function publicView(plan, extra) {
  const clean = (list) => list.slice(0, LIST_CAP).map((w) => {
    const { _res, _ids, _r, _sub, _terms, _a, ...rest } = w; return rest;
  });
  return Object.assign({
    summary: plan.summary, notes: plan.notes, byYear: plan.byYear,
    issues: plan.issues.slice(0, ISSUE_CAP), issuesTruncated: plan.issues.length > ISSUE_CAP,
    willCreate: clean(plan.willCreate), willFill: clean(plan.willFill), skippedExisting: clean(plan.skippedExisting),
    subvendorInvoices: clean(plan.svCreate), listCap: LIST_CAP,
  }, extra || {});
}

async function insertBatches(conn, sql, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await conn.query(sql, [rows.slice(i, i + BATCH)]);
  }
}

async function applyPlan(conn, organizationId, body, plan) {
  const { pairsToCreate, newSubs, createSubvendors, clientByKey, programByKey } = plan.internals;
  const netTerms = body._netTerms;
  const netDays = Number(/\d+/.exec(netTerms)[0]);
  const paymentStatus = body.paymentStatus === 'paid' ? 'paid' : 'unpaid';
  const timesheet = body.timesheetSubmitted === 'no' ? 'no' : 'yes';

  const consId = new Map(); // consKey -> id
  for (const [k, c] of plan.internals.consByKey.entries()) if (c) consId.set(k, c.id);
  for (const [k, display] of plan.internals.newConsFinal.entries()) {
    const rec = await findOrCreateDirectoryRecord(conn, 'consultants', { organizationId, name: display, status: null });
    consId.set(k, rec.id);
  }
  const clientRec = new Map(); // nameKey -> { id, name, email, phone, address }
  for (const [k, c] of clientByKey.entries()) clientRec.set(k, c);
  const programRec = new Map(); // clientId|nameKey -> row
  for (const [k, p] of programByKey.entries()) programRec.set(k, p);
  const assignId = new Map(); // pairKey -> assignment id

  for (const [pairKey, p] of pairsToCreate) {
    const ck = nameKey(p.client);
    let cl = clientRec.get(ck);
    if (!cl) {
      const rec = await findOrCreateDirectoryRecord(conn, 'clients', { organizationId, name: p.client, status: 'active' });
      cl = { id: rec.id, name: normalizeName(p.client), email: null, phone: null, address: null };
      clientRec.set(ck, cl);
    }
    let pr = null;
    if (p.program) {
      const pk = cl.id + '|' + nameKey(p.program);
      pr = programRec.get(pk);
      if (!pr) {
        const rec = await findOrCreateDirectoryRecord(conn, 'programs', { organizationId, clientId: cl.id, name: p.program, status: 'active' });
        pr = { id: rec.id, client_id: cl.id, name: normalizeName(p.program), email: null, phone: null, address: null };
        programRec.set(pk, pr);
      }
    }
    const cid = consId.get(p.consKey);
    const [found] = await conn.query(
      `SELECT id FROM consultant_assignments WHERE organization_id = ? AND consultant_id = ? AND client_id <=> ? AND program_id <=> ?`,
      [organizationId, cid, cl.id, pr ? pr.id : null]);
    if (found.length) { assignId.set(pairKey, found[0].id); continue; }
    const [ins] = await conn.query(
      `INSERT INTO consultant_assignments (organization_id, consultant_id, client_id, program_id, billing, source, status, left_date)
       VALUES (?, ?, ?, ?, NULL, 'upload', ?, ?)`,
      [organizationId, cid, cl.id, pr ? pr.id : null, p.left ? 'left' : 'active', p.left || null]);
    assignId.set(pairKey, ins.insertId);
  }

  const subId = new Map(); // newKey -> id
  if (createSubvendors) {
    for (const [k, name] of newSubs.entries()) {
      const rec = await findOrCreateDirectoryRecord(conn, 'subvendors', { organizationId, name, status: null });
      subId.set(k, rec.id);
    }
  }
  const resolveSub = (sub) => (sub ? (sub.id || subId.get(sub.newKey) || null) : null);

  // ---- client invoices ----
  const rowsToInsert = [];
  const tmp = 'TMP-' + Date.now().toString(36) + '-';
  let n = 0;
  for (const w of plan.willCreate) {
    const r = w._r;
    let cid; let clientId; let programId; let assignment;
    if (w._res.a) {
      cid = w._res.cons.id; clientId = w._res.a.client_id; programId = w._res.a.program_id; assignment = w._res.a.id;
    } else {
      cid = consId.get(r.consKey);
      assignment = assignId.get(w._res.pairKey);
      const cl = clientRec.get(nameKey(w._res.client));
      clientId = cl.id;
      programId = w._res.program ? programRec.get(cl.id + '|' + nameKey(w._res.program)).id : null;
    }
    const cl = clientRec.get(nameKey(w.client)) || [...clientRec.values()].find((c) => c.id === clientId);
    const pr = programId ? [...programRec.values()].find((p) => p.id === programId) : null;
    const billTo = pr || cl || {};
    const issue = r.invoiceYm + '-01'; // issued on the 1st of the invoice month, like generated invoices
    rowsToInsert.push([
      organizationId, tmp + (n++), cid, clientId, programId, assignment,
      issue, w.rate, w.hours, w.amount,
      billTo.name || null, billTo.email || null, billTo.phone || null, billTo.address || null,
      netTerms, issue, addDays(issue, netDays), paymentStatus, timesheet,
      w.rate === null ? 'Imported from hours file — no billing rate in Directory yet' : null,
      w.category, w.terms, resolveSub(w._sub), 'hours_file',
    ]);
  }
  await insertBatches(conn,
    `INSERT INTO invoices
       (organization_id, invoice_number, consultant_id, client_id, program_id, assignment_id,
        period_month, rate, hours, amount, bill_to_name, bill_to_email, bill_to_phone, bill_to_address,
        net_terms, issue_date, due_date, payment_status, timesheet_submitted, notes,
        payment_category, payment_terms, subvendor_id, source)
     VALUES ?`, rowsToInsert);
  if (rowsToInsert.length) {
    await conn.query(
      `UPDATE invoices SET invoice_number = CONCAT('INV-', DATE_FORMAT(period_month, '%Y%m'), '-', LPAD(id, 5, '0'))
       WHERE organization_id = ? AND invoice_number LIKE 'TMP-%'`, [organizationId]);
  }

  for (const w of plan.willFill) {
    await conn.query(
      `UPDATE invoices SET hours = ?, amount = ?,
         payment_category = COALESCE(payment_category, ?), payment_terms = COALESCE(payment_terms, ?),
         subvendor_id = COALESCE(subvendor_id, ?)
       WHERE id = ? AND organization_id = ? AND (hours IS NULL OR hours = 0)`,
      [w.hours, w.amount, w._terms.category, w._terms.text, resolveSub(w._sub), w.invoiceId, organizationId]);
  }

  // ---- subvendor invoices ----
  const svRows = [];
  const svTmp = 'TMP-' + Date.now().toString(36) + '-s';
  let m = 0;
  const seen = new Set();
  for (const s of plan.svCreate) {
    const a = s._a;
    const cid = a.res.cons ? a.res.cons.id : consId.get(a.r.consKey);
    const sid = resolveSub(a.sub);
    if (!cid || !sid) continue;
    const key = sid + '|' + cid + '|' + s.periodMonth;
    if (seen.has(key)) continue;
    seen.add(key);
    const [dupe] = await conn.query(
      'SELECT id FROM subvendor_invoices WHERE organization_id = ? AND subvendor_id = ? AND consultant_id = ? AND period_month = ?',
      [organizationId, sid, cid, s.periodMonth + '-01']);
    if (dupe.length) continue;
    const y = Number(s.periodMonth.slice(0, 4)); const mo = Number(s.periodMonth.slice(5, 7));
    const issue = monthEnd(y, mo);
    svRows.push([
      organizationId, svTmp + (m++), sid, cid, s.periodMonth + '-01', s.rate, s.hours, round2(s.rate * s.hours),
      s.rateSource, netTerms, issue, addDays(issue, netDays), paymentStatus, timesheet,
      s.rateSource === 'hours_file' ? 'Imported from hours file — no $/hr known yet' : null,
    ]);
  }
  await insertBatches(conn,
    `INSERT INTO subvendor_invoices
       (organization_id, invoice_number, subvendor_id, consultant_id, period_month, rate, hours, amount,
        rate_source, net_terms, issue_date, due_date, payment_status, timesheet_submitted, notes)
     VALUES ?`, svRows);
  if (svRows.length) {
    await conn.query(
      `UPDATE subvendor_invoices SET invoice_number = CONCAT('SVI-', DATE_FORMAT(period_month, '%Y%m'), '-', LPAD(id, 5, '0'))
       WHERE organization_id = ? AND invoice_number LIKE 'TMP-%'`, [organizationId]);
  }
  return { created: rowsToInsert.length, filled: plan.willFill.length, subvendorCreated: svRows.length };
}

module.exports = { planImport, applyPlan, publicView, MAX_ROWS, classifyTerms, splitClient, cleanConsultantName };
