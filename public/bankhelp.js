// Helpers for the banking form (used by form.html and vendor.html):
//  - looks up the bank from a typed routing number and fills "Bank name" when it is empty
//  - Show/Hide on number boxes so the person can check what they typed
//  - "Re-enter to confirm" on account numbers
//  - a "Review" summary of everything entered, before saving or signing
(function () {
  function esc(s) { return s === null || s === undefined ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  var ROUTING = ['ach_routing', 'wire_aba'], ACCOUNT = ['ach_account', 'wire_account'];

  function attach(host, lookupUrl) {
    host.querySelectorAll('[data-secret]').forEach(function (inp) {
      var k = inp.getAttribute('data-secret');
      if (inp.getAttribute('data-bh')) return;
      inp.setAttribute('data-bh', '1');
      var row = inp.parentNode;
      var tog = document.createElement('button');
      tog.type = 'button'; tog.className = 'fm-btn fm-btn-small'; tog.textContent = 'Show'; tog.style.marginLeft = '6px';
      tog.addEventListener('click', function () { var show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; tog.textContent = show ? 'Hide' : 'Show'; });
      inp.style.width = 'calc(100% - 64px)'; inp.after(tog);
      if (ROUTING.indexOf(k) >= 0) {
        var res = document.createElement('div'); res.className = 'fm-help'; res.setAttribute('data-bh-result', k); res.style.fontWeight = '600'; row.appendChild(res);
        inp.addEventListener('input', function () {
          var rn = inp.value.replace(/\D/g, '');
          if (rn.length < 9) { res.textContent = rn.length ? 'Keep typing: ' + rn.length + ' of 9 digits' : ''; res.style.color = ''; return; }
          fetch(lookupUrl(rn)).then(function (r) { return r.json(); }).then(function (j) {
            if (!j.valid) { res.textContent = '✗ ' + (j.reason || 'Not a valid routing number.'); res.style.color = '#B3261E'; return; }
            if (j.bank) {
              res.textContent = '✓ ' + j.bank.name + ' — ' + j.bank.city + ', ' + j.bank.state; res.style.color = '#1B7A3A';
              var bn = host.querySelector('[data-key="bank_name"]');
              if (bn && !bn.disabled && (!bn.value || bn.getAttribute('data-auto'))) { bn.value = j.bank.name; bn.setAttribute('data-auto', '1'); }
            } else { res.textContent = '? ' + (j.reason || 'Bank not found.'); res.style.color = '#8A5A00'; }
          }).catch(function () { res.textContent = ''; });
        });
      }
      if (ACCOUNT.indexOf(k) >= 0) {
        var c = document.createElement('div'); c.style.marginTop = '6px';
        c.innerHTML = '<input type="password" autocomplete="off" data-bh-confirm="' + k + '" placeholder="Re-enter to confirm" style="width:calc(100% - 64px)">';
        row.appendChild(c);
      }
    });
    var bn = host.querySelector('[data-key="bank_name"]');
    if (bn) bn.addEventListener('input', function () { bn.removeAttribute('data-auto'); });
  }

  // '' when fine, else a message. Only checks boxes the person has typed into.
  function mismatch(host) {
    var bad = '';
    host.querySelectorAll('[data-bh-confirm]').forEach(function (c) {
      var k = c.getAttribute('data-bh-confirm'), main = host.querySelector('[data-secret="' + k + '"]');
      if (main && main.value.trim() && main.value.trim() !== c.value.trim()) bad = 'The two account numbers do not match. Re-type the confirmation.';
    });
    return bad;
  }

  // What is on the screen now: typed numbers in full (it is the person's own screen), saved ones masked.
  function reviewHtml(host, F) {
    var rows = [], fields = [];
    F.spec.sections.forEach(function (s) { s.fields.forEach(function (f) { fields.push({ f: f, hidden: s.showIf && !s.showIf.in.some(function (v) { var src = host.querySelector('[data-key="' + s.showIf.key + '"]'); return src && src.value === v; }) }); }); });
    fields.forEach(function (x) {
      var f = x.f; if (x.hidden || f.kind === 'attest') return;
      var val = '';
      if (f.kind === 'secret') {
        var el = host.querySelector('[data-secret="' + f.key + '"]');
        if (el && el.value.trim()) val = el.value.trim() + '  (typed now)';
        else if (F.secrets[f.key] && F.secrets[f.key].set) val = F.secrets[f.key].masked + '  (saved)';
      } else { var e2 = host.querySelector('[data-key="' + f.key + '"]'); val = e2 ? e2.value : (F.values[f.key] || ''); }
      rows.push('<tr><td style="padding:4px 12px 4px 0;color:#5f6b7a;font-size:12px;white-space:nowrap;vertical-align:top">' + esc(f.label.replace(/\s*\(.*$/, '')) + '</td><td style="font-size:13px;font-weight:600;font-family:' + (f.kind === 'secret' ? 'ui-monospace,Menlo,monospace' : 'inherit') + '">' + (val ? esc(val) : '<span style="color:#B3261E;font-weight:400">— empty —</span>') + '</td></tr>');
    });
    var rr = host.querySelector('[data-bh-result]');
    var bankLine = rr && rr.textContent ? '<tr><td style="padding:4px 12px 4px 0;color:#5f6b7a;font-size:12px">Bank (from routing number)</td><td style="font-size:13px;font-weight:600">' + esc(rr.textContent) + '</td></tr>' : '';
    return '<div class="fm-card" id="bh-review" style="border-color:#0875E1"><h2>Review your details</h2><table>' + rows.join('') + bankLine + '</table>' +
      '<p class="fm-help" style="margin:10px 0 0">Check every number against your bank statement or a voided check. Once you save, numbers are encrypted and only the last 4 digits are shown again.</p>' +
      '<button class="fm-btn fm-btn-small" type="button" data-bh-close style="margin-top:10px">Close review</button></div>';
  }
  window.BankHelp = { attach: attach, mismatch: mismatch, reviewHtml: reviewHtml };
})();
