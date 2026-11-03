// Turns the parsed workbook into a PLAN: which payments would be saved, which Directory people / suppliers
// they belong to, and the QUESTIONS a person has to answer first. Pure (no database): the route hands in a
// snapshot of the Directory and of the payments the app already shows. Nothing here writes anything.
const crypto = require('crypto');
const { clean, titleCase, monthOf } = require('./parse');

const nameKey = (s) => clean(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const LEGAL = /\b(inc|incorporated|llc|l l c|ltd|limited|corp|corporation|co|company|pvt|llp|lp)\b/g;
const INDUSTRY = /\b(technologies|technology|tech|solutions|solution|systems|system|services|service|consulting|consultants|consultancy|group|software|infotech|info|infosoft|global|it|labs|enterprises|partners)\b/g;
const legalKey = (s) => nameKey(s).replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
const coreKey = (s) => legalKey(s).replace(INDUSTRY, ' ').replace(/\s+/g, ' ').trim();
const tok = (s) => nameKey(s).split(' ').filter(Boolean);

function lev(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let cur = [i]; let min = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); min = Math.min(min, cur[j]); }
    if (min > cap) return cap + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function personMatches(name, list) {
  const k = nameKey(name); const t = tok(name);
  const exact = []; const near = [];
  for (const d of list) {
    const dk = nameKey(d.name); const dt = tok(d.name);
    if (!dk) continue;
    if (dk === k) { exact.push({ id: d.id, name: d.name, why: 'same name' }); continue; }
    const common = t.filter((x) => dt.includes(x));
    let why = null; let score = 0;
    if (t.length > 1 && dt.length > 1 && common.length === Math.min(t.length, dt.length) && common.length >= 2) { why = 'same words, one has an extra name'; score = 0.9; }
    else if (t.length > 1 && dt.length > 1 && t[0] === dt[0] && t[t.length - 1] === dt[dt.length - 1]) { why = 'first and last name match'; score = 0.88; }
    else if (k.length >= 8 && lev(k, dk, 2) <= 2) { why = 'spelled almost the same'; score = 0.85; }
    else if ((t.length === 1 || dt.length === 1) && t[0] === dt[0]) { why = 'first name matches'; score = 0.7; }
    else if (t.length > 1 && dt.length > 1 && common.length >= 1 && lev(t[0], dt[0], 1) <= 1 && t[t.length - 1] === dt[dt.length - 1]) { why = 'last name matches, first name spelled differently'; score = 0.8; }
    if (why) near.push({ id: d.id, name: d.name, why, score });
  }
  near.sort((a, b) => b.score - a.score);
  return { exact, near: near.slice(0, 4) };
}
function supplierMatches(name, list) {
  const lk = legalKey(name); const ck = coreKey(name);
  const exact = []; const near = [];
  for (const d of list) {
    const dl = legalKey(d.name); const dc = coreKey(d.name);
    if (!dl) continue;
    if (dl === lk) { exact.push({ id: d.id, name: d.name, why: 'same name' }); continue; }
    let why = null; let score = 0;
    if (ck && dc && ck === dc) { why = 'same name apart from words like Technologies / Solutions'; score = 0.92; }
    else if (ck && dc && (ck.startsWith(dc + ' ') || dc.startsWith(ck + ' '))) { why = 'one name starts with the other'; score = 0.85; }
    else if (lk.length >= 6 && lev(lk, dl, 2) <= 2) { why = 'spelled almost the same'; score = 0.85; }
    if (why) near.push({ id: d.id, name: d.name, why, score });
  }
  near.sort((a, b) => b.score - a.score);
  return { exact, near: near.slice(0, 4) };
}

const money = (n) => Math.round(Number(n) * 100) / 100;
const ymCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function resolveSupplierName(payment, cell, mode, rowRange) {
  const names = cell.names.filter(Boolean);
  if (cell.kind === 'single' || names.length < 2) return names[0] || '';
  if (cell.kind === 'slash') return mode === 'second' ? names[1] : mode === 'one' ? names.join(' / ') : names[0];
  // switch: names[0] is the supplier from the date on, names[1] the one before it
  if (mode === 'first') return names[0];
  if (mode === 'second') return names[1];
  if (mode === 'one') return names.join(' / ');
  const f = cell.from; if (!f) return names[0];
  let fy = f.year;
  if (!fy && rowRange.min) { fy = Number(rowRange.min.slice(0, 4)); if (f.month < Number(rowRange.min.slice(5, 7))) fy += 1; }
  if (!fy || !payment.hoursMonth) return names[0];
  const fromYM = fy + '-' + String(f.month).padStart(2, '0');
  return ymCompare(payment.hoursMonth, fromYM) >= 0 ? names[0] : names[1];
}

function chooseDisplay(names) { const c = new Map(); names.forEach((n) => c.set(n, (c.get(n) || 0) + 1)); return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0]; }

// parsed: parse.js output. directory: { consultants:[{id,name}], suppliers:[{id,name}] }.
// existing: [{ consultant, supplier, period_month 'YYYY-MM-01', amount }] already shown in the app.
function buildPlan({ parsed, directory, existing, answers }) {
  const A = answers || {};
  const questions = [];
  const sheetInfo = parsed.sheets.map((s) => ({ sheet: s.sheet, layout: s.layout, payments: s.payments.length, statuses: s.statuses.length, unreadable: s.unreadable.length,
    columns: s.columns ? { first: s.columns.cols && s.columns.cols[0] ? s.columns.cols[0].label + ' ' + s.columns.cols[0].year : null, last: s.columns.cols && s.columns.cols.length ? s.columns.cols[s.columns.cols.length - 1].label + ' ' + s.columns.cols[s.columns.cols.length - 1].year : null, borrowedFrom: s.columns.borrowedFrom || null, gaps: s.columns.gaps || [], error: s.columns.error || null } : null }));

  // ---- flatten ----
  const flat = [];
  for (const s of parsed.sheets) for (const p of s.payments) {
    if (!p.hoursMonth) continue;
    flat.push({ ...p, layout: s.layout, left: /left/i.test(s.sheet), consultant: titleCase(p.consultantRaw).replace(/[.,]+$/, ''), rowId: s.sheet + '!' + p.row });
  }
  const noMonth = parsed.sheets.flatMap((s) => s.payments.filter((p) => !p.hoursMonth).map((p) => ({ sheet: s.sheet, row: p.row, consultant: p.consultantRaw, amount: p.part.amount, text: p.hoursLabel || '' })));

  // ---- row ranges (for supplier switch dates without a year) ----
  const rowRange = new Map();
  for (const p of flat) { const r = rowRange.get(p.rowId) || { min: null }; if (!r.min || p.hoursMonth < r.min) r.min = p.hoursMonth; rowRange.set(p.rowId, r); }

  // ---- supplier cells ----
  const { parseSupplierCell } = require('./parse');
  const cellInfo = new Map();
  for (const p of flat) { if (!cellInfo.has(p.supplierRaw)) cellInfo.set(p.supplierRaw, parseSupplierCell(p.supplierRaw)); }
  const aliasQs = [];
  for (const [raw, ci] of cellInfo) {
    if (ci.kind === 'single') continue;
    const users = flat.filter((p) => p.supplierRaw === raw);
    const def = ci.kind === 'slash' ? 'first' : 'smart';
    const mode = (A.aliases && A.aliases[raw]) || def;
    const sample = users.slice(0, 1)[0];
    const names = ci.names;
    const options = ci.kind === 'slash'
      ? [{ value: 'first', label: 'The supplier is “' + names[0] + '” (the other name is just how it was also written)' }, { value: 'second', label: 'The supplier is “' + names[1] + '”' }, { value: 'one', label: 'It is one company called “' + names.join(' / ') + '”' }]
      : [{ value: 'smart', label: '“' + names[0] + '” from ' + (ci.from ? (ci.from.year ? ci.from.month + '/' + ci.from.day + '/' + ci.from.year : 'month ' + ci.from.month + ' day ' + ci.from.day) : 'that date') + ' on, and “' + names[1] + '” before it (recommended)' }, { value: 'first', label: 'Always “' + names[0] + '”' }, { value: 'second', label: 'Always “' + names[1] + '”' }, { value: 'one', label: 'One company called “' + names.join(' / ') + '”' }];
    aliasQs.push({ key: raw, label: raw, consultants: [...new Set(users.map((u) => u.consultant))].slice(0, 3), payments: users.length, kind: ci.kind, options, value: mode, default: def });
  }
  if (aliasQs.length) questions.push({ id: 'aliases', type: 'aliases', title: aliasQs.length + ' supplier cell(s) name more than one company', detail: 'For example “Creta Logic from 9/1/24/Magicforce”. Say which company each payment belongs to. The recommended choice splits the payments at the date written in the cell.', items: aliasQs });

  // ---- payments with resolved supplier names and amounts ----
  const deductionCount = flat.filter((p) => p.part.deduction != null).length;
  const dedMode = A.deduction || (deductionCount ? null : 'net');
  if (deductionCount) {
    const ex = flat.filter((p) => p.part.deduction != null).slice(0, 4).map((p) => p.raw);
    questions.push({ id: 'deduction', type: 'choice', required: true, title: deductionCount + ' payments have a second number taken off (like “Feb 24=2400-216.55bgv”)', detail: 'Examples: ' + ex.join(' · ') + '. What should the saved amount be?', value: A.deduction || null,
      options: [{ value: 'net', label: 'The amount actually paid: the first number minus the second (the deduction is kept in the note)' }, { value: 'gross', label: 'The first number (the full invoice); keep the deduction in the note' }] });
  }
  const dateFlagged = flat.filter((p) => (p.part.flags || []).some((f) => ['paid_before_hours', 'long_lag', 'bad_date', 'year_run_on'].includes(f)));
  const dateMode = A.dates || 'blank';
  if (dateFlagged.length) questions.push({ id: 'dates', type: 'choice', title: dateFlagged.length + ' payment dates look doubtful', detail: 'Most payments are made 2 to 5 months after the month worked. These are paid before it, or more than 9 months after, or the year was run into the day (like “Oct182021”). The month and amount are always kept.', value: dateMode,
    options: [{ value: 'blank', label: 'Leave the paid date empty on these and keep the text in the note (recommended)' }, { value: 'keep', label: 'Use the date as read' }],
    items: dateFlagged.slice(0, 40).map((p) => ({ consultant: p.consultant, month: p.hoursMonth, text: p.raw, read: p.part.paidDate || '—' })) });

  const rowsAll = [];
  for (const p of flat) {
    const ci = cellInfo.get(p.supplierRaw);
    const mode = (A.aliases && A.aliases[p.supplierRaw]) || (ci.kind === 'slash' ? 'first' : 'smart');
    const supplier = titleSupplier(resolveSupplierName(p, ci, mode, rowRange.get(p.rowId) || {}));
    let amount = p.part.amount;
    if (p.part.deduction != null && dedMode === 'net') amount = money(p.part.amount - p.part.deduction);
    const doubtful = (p.part.flags || []).some((f) => ['paid_before_hours', 'long_lag', 'bad_date', 'year_run_on'].includes(f));
    const keepDate = !doubtful || dateMode === 'keep';
    const noteBits = [];
    if (p.part.deduction != null) noteBits.push('deduction ' + p.part.deduction + (dedMode === 'net' ? ' taken off ' + p.part.amount : ' not taken off'));
    if (p.part.note) noteBits.push(p.part.note);
    if (doubtful && !keepDate) noteBits.push('date in file: ' + p.raw);
    if (p.part.second != null) noteBits.push('second number in cell: ' + p.part.second);
    rowsAll.push({ ...p, supplier, amount, deduction: p.part.deduction, paidDate: keepDate ? (p.part.paidDate || null) : null, method: p.part.method || null, note: noteBits.join('; '), flags: p.part.flags || [] });
  }

  // ---- unreadable cells: a person can type the amount ----
  const unreadable = parsed.sheets.flatMap((s) => s.unreadable.map((u) => ({ id: u.id || (s.sheet + '!' + u.row), sheet: s.sheet, row: u.row, consultant: u.consultant || '', supplier: u.supplier || '', hoursMonth: u.hoursMonth || '', text: u.text, why: u.why })));
  const fixes = A.fixes || {};
  if (unreadable.length) questions.push({ id: 'unreadable', type: 'fixes', title: unreadable.length + ' cells could not be read', detail: 'They are skipped unless you type an amount (and a paid date if known) for them.', items: unreadable.map((u) => ({ ...u, fix: fixes[u.id] || null })) });
  for (const u of unreadable) {
    const f = fixes[u.id];
    if (f && Number(f.amount) > 0 && u.hoursMonth && u.consultant) {
      const row = flat.find((p) => p.sheet === u.sheet && p.row === u.row);
      const ref = row || { supplierRaw: u.supplier, client: '', layout: 'matrix', left: /left/i.test(u.sheet), sheet: u.sheet, row: u.row, rowId: u.sheet + '!' + u.row, id: u.id };
      const sraw = (parsed.sheets.find((s) => s.sheet === u.sheet).rows.find((r) => r.row === u.row) || {}).supplierRaw || ref.supplierRaw || '';
      const ci = parseSupplierCell(sraw); const mode = (A.aliases && A.aliases[sraw]) || (ci.kind === 'slash' ? 'first' : 'smart');
      rowsAll.push({ ...ref, id: u.id, consultant: titleCase(u.consultant), consultantRaw: u.consultant, supplierRaw: sraw, supplier: titleSupplier(resolveSupplierName({ hoursMonth: u.hoursMonth }, ci, mode, rowRange.get(u.sheet + '!' + u.row) || {})), hoursMonth: u.hoursMonth, raw: u.text, amount: money(f.amount), deduction: null, paidDate: /^\d{4}-\d{2}-\d{2}$/.test(f.paidDate || '') ? f.paidDate : null, method: null, note: 'typed in by hand from the cell “' + u.text + '”', flags: ['typed'], part: {} });
    }
  }

  // ---- statuses (info) ----
  const statusCounts = {};
  parsed.sheets.forEach((s) => s.statuses.forEach((x) => { statusCounts[x.tag] = (statusCounts[x.tag] || 0) + 1; }));

  // ---- special groups that need a decision ----
  const employeeRows = rowsAll.filter((r) => /^(employee|w-?2|employees)$/i.test(r.supplier));
  const decide = (id, fallback) => (A.groups && A.groups[id]) || fallback;
  const corpNames = [...new Set(rowsAll.filter((r) => r.corp && !/mentour/i.test(r.corp)).map((r) => r.corp))];
  const directRows = rowsAll.filter((r) => (r.flags || []).includes('paid_direct'));
  const groupQs = [];
  if (employeeRows.length) groupQs.push({ id: 'g:employee', label: employeeRows.length + ' payments are listed against supplier “Employee” (W2 staff paid through payroll)', detail: 'W2 staff have no supplier, so these are not supplier payments.', value: decide('g:employee', 'skip'), options: [{ value: 'skip', label: 'Do not import them (recommended)' }, { value: 'import', label: 'Import them under a supplier called “Employee”' }] });
  for (const c of corpNames) { const n = rowsAll.filter((r) => r.corp === c).length; groupQs.push({ id: 'g:corp:' + c, required: true, label: n + ' payments sit under “' + c + '”, a different company from Mentour Corporation', detail: 'Are they Mentour’s own payments?', value: A.groups && A.groups['g:corp:' + c] || null, options: [{ value: 'import', label: 'Yes, import them' }, { value: 'skip', label: 'No, leave them out' }] }); }
  if (directRows.length) groupQs.push({ id: 'g:direct', label: directRows.length + ' payments say “paid to <consultant>” (paid to the person, not the supplier)', detail: directRows.slice(0, 4).map((r) => r.consultant + ': ' + r.raw).join(' · '), value: decide('g:direct', 'skip'), options: [{ value: 'skip', label: 'Do not import them (recommended)' }, { value: 'import', label: 'Import them under the supplier on that row' }] });
  const noDate = rowsAll.filter((r) => !r.paidDate && !(r.flags || []).includes('typed')).length;
  if (groupQs.length) questions.push({ id: 'groups', type: 'groups', title: 'A few groups of payments need a decision', items: groupQs });

  const skipReason = new Map();
  const skip = (r, why) => { if (!skipReason.has(r)) skipReason.set(r, why); };
  for (const r of rowsAll) {
    if (/^(employee|w-?2|employees)$/i.test(r.supplier) && decide('g:employee', 'skip') === 'skip') skip(r, 'Paid to “Employee” (W2), not a supplier');
    if (r.corp && !/mentour/i.test(r.corp) && (A.groups && A.groups['g:corp:' + r.corp]) !== 'import') skip(r, r.corp + ' is a different company');
    if ((r.flags || []).includes('paid_direct') && decide('g:direct', 'skip') === 'skip') skip(r, 'Paid to the consultant directly');
    if (!r.supplier) skip(r, 'No supplier named on the row');
  }

  // ---- duplicate blocks (same consultant + supplier on two rows) ----
  const blocks = new Map();
  for (const r of rowsAll) { if (skipReason.has(r)) continue; const bk = nameKey(r.consultant) + '|' + legalKey(r.supplier); const rows = blocks.get(bk) || new Map(); const arr = rows.get(r.rowId) || []; arr.push(r); rows.set(r.rowId, arr); blocks.set(bk, rows); }
  const dupItems = [];
  for (const [bk, rows] of blocks) {
    const ids = [...rows.keys()]; if (ids.length < 2) continue;
    for (let i = 1; i < ids.length; i++) {
      const a = rows.get(ids[0]); const b = rows.get(ids[i]);
      const sig = (list) => list.map((x) => x.hoursMonth + '|' + x.amount).sort().join(',');
      const same = sig(a) === sig(b);
      const aMonths = new Set(a.map((x) => x.hoursMonth)); const overlap = b.filter((x) => aMonths.has(x.hoursMonth)).length;
      if (!same && !overlap) continue; // different months: a genuine second stretch of work
      const id = 'dupe:' + ids[0] + '~' + ids[i];
      const def = same ? 'once' : 'both';
      dupItems.push({ id, kind: same ? 'identical' : 'overlap', consultant: a[0].consultant, supplier: a[0].supplier, rowA: ids[0], rowB: ids[i], countA: a.length, countB: b.length, overlapMonths: overlap, value: (A.dupes && A.dupes[id]) || def, default: def,
        options: same ? [{ value: 'once', label: 'Same payments listed twice: import them once (recommended)' }, { value: 'both', label: 'Import both copies' }] : [{ value: 'both', label: 'Import both rows (they are separate payments)' }, { value: 'first', label: 'Import only the first row' }, { value: 'second', label: 'Import only the second row' }] });
    }
  }
  if (dupItems.length) questions.push({ id: 'dupes', type: 'dupes', title: dupItems.length + ' consultant + supplier pair(s) appear on more than one row', detail: 'This is how one payment gets counted twice. Say what each pair is.', items: dupItems });
  for (const d of dupItems) {
    if (d.value === 'once' || d.value === 'first') rowsAll.filter((r) => r.rowId === d.rowB && nameKey(r.consultant) + '|' + legalKey(r.supplier) === nameKey(d.consultant) + '|' + legalKey(d.supplier)).forEach((r) => skip(r, 'Same payment listed twice (row ' + d.rowB + ')'));
    if (d.value === 'second') rowsAll.filter((r) => r.rowId === d.rowA && nameKey(r.consultant) + '|' + legalKey(r.supplier) === nameKey(d.consultant) + '|' + legalKey(d.supplier)).forEach((r) => skip(r, 'Same payment listed twice (row ' + d.rowA + ')'));
  }

  // ---- entities: consultants and suppliers ----
  const active = rowsAll.filter((r) => !skipReason.has(r));
  function entityGroup(kind) {
    const map = new Map();
    for (const r of active) {
      const name = kind === 'c' ? r.consultant : r.supplier;
      const k = kind === 'c' ? nameKey(name) : legalKey(name);
      if (!k) continue;
      const g = map.get(k) || { key: kind + ':' + k, kind, names: [], payments: 0, total: 0, months: [], left: false, sheets: new Set() };
      g.names.push(name); g.payments++; g.total += r.amount || 0; g.months.push(r.hoursMonth); if (r.left) g.left = true; g.sheets.add(r.sheet);
      map.set(k, g);
    }
    return [...map.values()];
  }
  const cGroups = entityGroup('c'); const sGroups = entityGroup('s');
  const ent = A.entities || {};
  const items = [];
  const resolution = new Map(); // group key -> { action, id?, name? }
  function resolve(groups, dirList, matcher) {
    for (const g of groups) {
      g.name = chooseDisplay(g.names);
      const m = matcher(g.name, dirList);
      const a = ent[g.key];
      // Other spellings of the same name elsewhere in this file
      const sibling = groups.filter((o) => o !== g && (g.kind === 'c' ? personMatches(g.name, [{ id: o.key, name: chooseDisplay(o.names) }]).near.length : supplierMatches(g.name, [{ id: o.key, name: chooseDisplay(o.names) }]).near.length));
      const cands = m.near.map((x) => ({ type: 'dir', id: x.id, name: x.name, why: x.why })).concat(sibling.slice(0, 3).map((o) => ({ type: 'file', key: o.key, name: chooseDisplay(o.names), why: 'written differently elsewhere in this file' })));
      let value = null; let needs = false;
      if (m.exact.length) value = { action: 'existing', id: m.exact[0].id, name: m.exact[0].name, auto: true };
      else if (a) value = a;
      else if (cands.length || (g.kind === 's' && coreKey(g.name).length <= 2)) needs = true;
      else value = { action: 'new', name: g.name, auto: true };
      resolution.set(g.key, value);
      if (needs || (a && !m.exact.length)) {
        const sorted = g.months.slice().sort();
        items.push({ key: g.key, kind: g.kind, name: g.name, spellings: [...new Set(g.names)].slice(0, 4), payments: g.payments, total: money(g.total), from: sorted[0], to: sorted[sorted.length - 1], left: g.left,
          candidates: cands, suggestion: cands.length && cands[0].type === 'dir' && matcher === personMatches ? { action: 'existing', id: cands[0].id, name: cands[0].name } : cands.length && cands[0].type === 'dir' && m.near[0].score >= 0.9 ? { action: 'existing', id: cands[0].id, name: cands[0].name } : { action: 'new', name: g.name }, value, needs });
      }
    }
  }
  resolve(cGroups, directory.consultants || [], personMatches);
  resolve(sGroups, directory.suppliers || [], supplierMatches);
  const unresolved = items.filter((i) => i.needs && !i.value);
  const listAll = (groups) => groups.map((g) => ({ key: g.key, name: g.name, payments: g.payments, total: money(g.total), value: resolution.get(g.key) }));
  if (items.length) questions.push({ id: 'entities', type: 'entities', required: unresolved.length > 0, title: items.filter((i) => i.kind === 'c').length + ' consultant(s) and ' + items.filter((i) => i.kind === 's').length + ' supplier(s) may already exist, or are spelled in more than one way', detail: 'Pick the existing record, or say it is new. Nothing is merged or created until you apply.', items });

  // Final target for a group (following "same as another spelling in this file")
  function target(key, depth = 0) {
    const v = resolution.get(key);
    if (!v) return null;
    if (v.action === 'merge' && depth < 5) return target(v.key, depth + 1) || null;
    return { ...v, key: v.action === 'merge' ? v.key : key };
  }
  const final = [];
  for (const r of active) {
    const ck = 'c:' + nameKey(r.consultant); const sk = 's:' + legalKey(r.supplier);
    const ct = target(ck); const st = target(sk);
    if (!ct || !st) { skip(r, 'Waiting for your answer about ' + (!ct ? r.consultant : r.supplier)); continue; }
    if (ct.action === 'skip') { skip(r, 'You chose to skip consultant ' + r.consultant); continue; }
    if (st.action === 'skip') { skip(r, 'You chose to skip supplier ' + r.supplier); continue; }
    final.push({ ...r, cRef: ct.action === 'existing' ? { id: ct.id, name: ct.name } : { newName: ct.action === 'merge' ? ct.name : (ct.name || r.consultant), key: ct.key }, sRef: st.action === 'existing' ? { id: st.id, name: st.name } : { newName: st.name || r.supplier, key: st.key } });
  }

  // ---- already in the app? ----
  // Same consultant + month already in the app? A different spelling of the supplier ("Isaac Sosa Tech." vs
  // "Isaac Sosa Technologies LLC") still counts, and so does the same amount under another supplier name.
  const exBy = new Map(); // consultant|YYYY-MM -> Map(supplierLegal -> { core, amount })
  for (const e of existing || []) {
    const ck = nameKey(e.consultant) + '|' + String(e.period_month).slice(0, 7);
    const m = exBy.get(ck) || new Map(); const sl = legalKey(e.supplier);
    const cur = m.get(sl) || { core: coreKey(e.supplier), amount: 0 }; cur.amount += Number(e.amount) || 0; m.set(sl, cur); exBy.set(ck, m);
  }
  const groupsByKey = new Map();
  for (const r of final) { const k = nameKey(r.cRef.name || r.cRef.newName) + '|' + r.hoursMonth + '|' + legalKey(r.sRef.name || r.sRef.newName); const g = groupsByKey.get(k) || []; g.push(r); groupsByKey.set(k, g); }
  const overlapSame = []; const overlapDiff = []; const toSave = [];
  for (const [k, list] of groupsByKey) {
    const [ck, pm, sl] = k.split('|').length === 3 ? k.split('|') : [k, '', ''];
    const cands = exBy.get(ck + '|' + pm);
    const fileSum = money(list.reduce((t, r) => t + r.amount, 0));
    let hit = null;
    if (cands) {
      const sc = coreKey(list[0].sRef.name || list[0].sRef.newName);
      const bySupplier = [...cands.entries()].filter(([l, v]) => l === sl || (sc && v.core && (sc === v.core || sc.startsWith(v.core + ' ') || v.core.startsWith(sc + ' '))));
      const byAmount = [...cands.entries()].filter(([, v]) => Math.abs(v.amount - fileSum) <= 1);
      const pick = bySupplier.length ? bySupplier : byAmount;
      if (pick.length) hit = money(pick.reduce((t, [, v]) => t + v.amount, 0));
    }
    if (hit !== null) {
      const rec = { consultant: list[0].consultant, supplier: list[0].supplier, month: list[0].hoursMonth, fileAmount: fileSum, appAmount: hit };
      if (Math.abs(fileSum - hit) <= 1) overlapSame.push(rec); else overlapDiff.push(rec);
      list.forEach((r) => skip(r, Math.abs(fileSum - hit) <= 1 ? 'Already in the app' : 'The app already has a different amount for this month'));
    } else list.forEach((r) => toSave.push(r));
  }
  if (overlapSame.length || overlapDiff.length) questions.push({ id: 'overlap', type: 'info', title: overlapSame.length + ' payment month(s) are already in the app' + (overlapDiff.length ? ', and ' + overlapDiff.length + ' have a different amount' : ''), detail: 'They are not imported again, so nothing is doubled. Where the amounts differ the app’s figure is kept; edit it on Supplier payments if the file is right.', items: overlapDiff.slice(0, 60).concat(overlapSame.slice(0, 20)) });

  // ---- years ----
  const lagBuckets = {}; toSave.concat(overlapSame.length ? [] : []).forEach((r) => { if (r.part && r.part.lag != null) lagBuckets[r.part.lag] = (lagBuckets[r.part.lag] || 0) + 1; });
  const matchedLedger = overlapSame.length;
  questions.unshift({ id: 'years', type: 'choice', required: true, title: 'Check which year each column belongs to', value: A.years || null,
    detail: sheetInfo.filter((s) => s.layout === 'matrix').map((s) => '“' + s.sheet + '”: columns run from ' + (s.columns && s.columns.first) + ' to ' + (s.columns && s.columns.last) + (s.columns && s.columns.borrowedFrom ? ' (this sheet has no years on its headings, so its columns are lined up with “' + s.columns.borrowedFrom + '”)' : '')).join('. ') + '. The year is worked out from the headings that carry one (like Jan\'25), counting back and forward. ' + (matchedLedger ? matchedLedger + ' payment month(s) match what the app already holds exactly, which supports this.' : ''),
    options: [{ value: 'ok', label: 'Yes, those years are right' }, { value: 'no', label: 'No, something is off (stop here)' }] });

  // ---- client / vendor text (kept as written; order differences asked about) ----
  const clientSets = new Map();
  for (const r of toSave) { const t = clean(r.client); if (!t) continue; const sk = t.split('/').map(nameKey).filter(Boolean).sort().join('|'); const m = clientSets.get(sk) || new Map(); m.set(t, (m.get(t) || 0) + 1); clientSets.set(sk, m); }
  const clientItems = [];
  for (const [sk, m] of clientSets) if (m.size > 1) { const opts = [...m.entries()].sort((a, b) => b[1] - a[1]); clientItems.push({ id: 'client:' + sk, options: opts.map(([t, n]) => ({ value: t, label: t + ' (' + n + ' payments)' })), value: (A.clients && A.clients['client:' + sk]) || opts[0][0], default: opts[0][0] }); }
  if (clientItems.length) questions.push({ id: 'clients', type: 'clients', title: clientItems.length + ' client / vendor combination(s) are written in different orders', detail: 'For example “JnJ/BI Technologies” and “BI Technologies/JnJ”. Pick the one to show on all of those payments. (This is only a label on each payment; no clients or vendors are created or changed.)', items: clientItems });
  const clientFix = new Map(); for (const ci of clientItems) { const sk = ci.id.slice(7); clientFix.set(sk, ci.value); }
  for (const r of toSave) { const t = clean(r.client); if (!t) { r.clientText = null; continue; } const sk = t.split('/').map(nameKey).filter(Boolean).sort().join('|'); r.clientText = clientFix.get(sk) || t; }

  // ---- result ----
  const byYear = {}; toSave.forEach((r) => { const y = r.hoursMonth.slice(0, 4); byYear[y] = byYear[y] || { payments: 0, total: 0 }; byYear[y].payments++; byYear[y].total = money(byYear[y].total + r.amount); });
  const skipped = {}; for (const [r, why] of skipReason) { skipped[why.replace(/ \(row .*\)$/, '')] = (skipped[why.replace(/ \(row .*\)$/, '')] || 0) + 1; }
  const newConsultants = new Map(); const newSuppliers = new Map();
  toSave.forEach((r) => { if (r.cRef.newName) { const g = newConsultants.get(r.cRef.newName) || { name: r.cRef.newName, payments: 0, left: false }; g.payments++; if (r.left) g.left = true; newConsultants.set(r.cRef.newName, g); } if (r.sRef.newName) { const g = newSuppliers.get(r.sRef.newName) || { name: r.sRef.newName, payments: 0 }; g.payments++; newSuppliers.set(r.sRef.newName, g); } });
  const requiredOpen = questions.filter((q) => q.required && (q.type === 'entities' ? q.items.some((i) => i.needs && !i.value) : q.type === 'groups' ? q.items.some((i) => i.required && !i.value) : !q.value)).map((q) => q.id);
  return {
    sheets: sheetInfo, skippedSheets: parsed.skipped, questions, requiredOpen, canApply: requiredOpen.length === 0 && toSave.length > 0,
    stats: { read: flat.length, willSave: toSave.length, willSaveTotal: money(toSave.reduce((t, r) => t + r.amount, 0)), byYear, skipped, statuses: statusCounts, unreadable: unreadable.length, noMonth: noMonth.length, noPaidDate: toSave.filter((r) => !r.paidDate).length,
      newConsultants: [...newConsultants.values()], newSuppliers: [...newSuppliers.values()], alreadyInApp: overlapSame.length, differentInApp: overlapDiff.length },
    rows: toSave, noMonth, all: { consultants: listAll(cGroups), suppliers: listAll(sGroups) },
  };
}

function titleSupplier(s) { const t = clean(s).replace(/\s*\/\s*1099\s*$/i, ''); return t; }

function sourceKey(orgId, cId, sId, period, paidDate, amount, n) {
  return crypto.createHash('sha1').update([orgId, cId, sId, period, paidDate || '', Number(amount).toFixed(2), n].join('|')).digest('hex');
}

module.exports = { buildPlan, personMatches, supplierMatches, nameKey, legalKey, coreKey, sourceKey, lev };
