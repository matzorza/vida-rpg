/* Guarda os dados no proprio aparelho e calcula os avisos de conta.
   Usado pela pagina e tambem pelo sw.js (que funciona com o app fechado). */
(function (g) {
  'use strict';
  var COLS = ['config', 'income', 'quests', 'accounts', 'shop', 'wish', 'timelog', 'guild', 'rewards', 'invoices', 'explore', 'orcamento', 'livros', 'filmes', 'data/users/me'];
  var conn = null;

  function open() {
    if (conn) return conn;
    conn = new Promise(function (ok, no) {
      var r = indexedDB.open('vida-rpg', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('docs'); r.result.createObjectStore('meta'); };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { conn = null; no(r.error); };
    });
    return conn;
  }
  // Abre uma gravacao, roda fn(store) e so confirma quando tudo foi salvo.
  async function tx(store, mode, fn) {
    var d = await open();
    return new Promise(function (ok, no) {
      var t = d.transaction(store, mode), out = fn(t.objectStore(store));
      t.oncomplete = function () { ok(out && 'result' in out ? out.result : undefined); };
      t.onerror = t.onabort = function () { no(t.error); };
    });
  }
  function split(path) { var i = path.lastIndexOf('/'); return { col: path.slice(0, i), id: path.slice(i + 1) }; }
  function valid(path) { var p = split(path); return COLS.indexOf(p.col) >= 0 && /^[\w-]+$/.test(p.id); }

  function get(path) { return tx('docs', 'readonly', function (s) { return s.get(path); }); }
  function set(path, data) { var c = JSON.parse(JSON.stringify(data)); return tx('docs', 'readwrite', function (s) { s.put(c, path); }); }
  function del(path) { return tx('docs', 'readwrite', function (s) { s.delete(path); }); }
  async function update(path, patch) {
    var d = await open(), c = JSON.parse(JSON.stringify(patch));
    return new Promise(function (ok, no) {
      var t = d.transaction('docs', 'readwrite'), s = t.objectStore('docs'), r = s.get(path);
      r.onsuccess = function () { if (r.result === undefined) t.abort(); else s.put(Object.assign({}, r.result, c), path); };
      t.oncomplete = function () { ok(); };
      t.onerror = t.onabort = function () { no(t.error || new Error('nao existe: ' + path)); };
    });
  }
  async function all() {
    var d = await open();
    return new Promise(function (ok, no) {
      var out = {}, r = d.transaction('docs').objectStore('docs').openCursor();
      r.onsuccess = function () { var c = r.result; if (c) { out[c.key] = c.value; c.continue(); } else ok(out); };
      r.onerror = function () { no(r.error); };
    });
  }
  // Troca tudo de uma vez: se algo falhar, o que havia antes continua la.
  async function replaceAll(map, cart) {
    var d = await open();
    return new Promise(function (ok, no) {
      var t = d.transaction(['docs', 'meta'], 'readwrite'), s = t.objectStore('docs');
      s.clear(); Object.keys(map).forEach(function (k) { s.put(map[k], k); });
      if (cart) t.objectStore('meta').put(cart, 'cartucho');
      t.oncomplete = function () { ok(); };
      t.onerror = t.onabort = function () { no(t.error); };
    });
  }
  function metaGet(k) { return tx('meta', 'readonly', function (s) { return s.get(k); }); }
  function metaSet(k, v) { return tx('meta', 'readwrite', function (s) { s.put(v, k); }); }

  /* ---- avisos de conta ---- */
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function iso(d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  // Mesma regra da pagina: o dia vira as 4h da manha.
  function hoje() { var d = new Date(Date.now() - 4 * 36e5); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function valor(docs, i, y, m) {
    for (var k = 0; k < 24; k++) { var ab = y * 12 + m - 1 - k, d = docs['orcamento/m_' + Math.floor(ab / 12) + '-' + p2(ab % 12 + 1)]; if (d && d.vals && d.vals[i.k] !== undefined) return d.vals[i.k]; }
    return i.v;
  }
  // Contas abertas do mes atual (inclusive atrasadas) e as que vencem em ate 3 dias, mesmo no mes seguinte.
  function pendentes(docs, dia) {
    var it = docs['orcamento/itens'], list = it && Array.isArray(it.list) ? it.list : [], out = [];
    [0, 1].forEach(function (add) {
      var a = new Date(dia.getFullYear(), dia.getMonth() + add, 1), y = a.getFullYear(), m = a.getMonth() + 1;
      var md = docs['orcamento/m_' + y + '-' + p2(m)], done = (md && md.done) || {}, last = new Date(y, m, 0).getDate();
      list.forEach(function (i) {
        if (done[i.k]) return;
        var venc = new Date(y, m - 1, Math.min(+i.d || 1, last));
        var falta = Math.round((Date.UTC(venc.getFullYear(), venc.getMonth(), venc.getDate()) - Date.UTC(dia.getFullYear(), dia.getMonth(), dia.getDate())) / 864e5);
        if (falta <= 3) out.push({ n: i.n, v: valor(docs, i, y, m), falta: falta });
      });
    });
    return out.sort(function (x, y) { return x.falta - y.falta; });
  }
  function texto(l) {
    return l.slice(0, 5).map(function (c) {
      var q = c.falta < 0 ? 'atrasada há ' + (-c.falta) + ' d' : c.falta === 0 ? 'vence hoje' : c.falta === 1 ? 'vence amanhã' : 'vence em ' + c.falta + ' dias';
      return c.n + (c.v > 0 ? ' (' + (+c.v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) + ')' : '') + ': ' + q;
    }).join('\n') + (l.length > 5 ? '\ne mais ' + (l.length - 5) : '');
  }
  // Mostra no maximo um aviso por dia.
  async function avisar(reg) {
    if (!(await metaGet('avisos')) || Notification.permission !== 'granted') return 0;
    var d = hoje(), k = iso(d);
    if ((await metaGet('ultimo')) === k) return 0;
    var l = pendentes(await all(), d);
    if (!l.length) return 0;
    await reg.showNotification(l.length === 1 ? '1 conta a pagar' : l.length + ' contas a pagar', { body: texto(l), icon: 'icone-192.png', badge: 'icone-192.png', tag: 'contas' });
    await metaSet('ultimo', k);
    return l.length;
  }

  /* Arquivo de agenda: repete todo mes, as 9h, sem valores. O UID fixo identifica cada conta. */
  function agenda(docs, dia) {
    var it = docs['orcamento/itens'], list = it && Array.isArray(it.list) ? it.list : [];
    function limpo(s) { return String(s).replace(/[\\;,]/g, '\\$&').replace(/[\r\n]+/g, ' '); }
    function junto(d) { return iso(d).replace(/-/g, ''); }
    var out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Vida RPG//Contas//PT', 'CALSCALE:GREGORIAN'];
    list.forEach(function (i) {
      var dd = Math.max(1, Math.min(31, +i.d || 1)), y = dia.getFullYear(), m = dia.getMonth(), v;
      for (; ; m++) { v = new Date(y, m, Math.min(dd, new Date(y, m + 1, 0).getDate())); if (v > dia) break; }
      var dias = []; for (var n = 28; n <= dd; n++) dias.push(n);
      out.push('BEGIN:VEVENT', 'UID:conta-' + String(i.k).replace(/[^\w-]/g, '') + '@vida-rpg', 'DTSTAMP:' + junto(dia) + 'T000000Z',
        'DTSTART:' + junto(v) + 'T090000', 'DTEND:' + junto(v) + 'T091500',
        'RRULE:FREQ=MONTHLY;BYMONTHDAY=' + (dd > 28 ? dias.join(',') + ';BYSETPOS=-1' : dd),
        'SUMMARY:Pagar ' + limpo(i.n),
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Vence amanhã', 'TRIGGER:-P1D', 'END:VALARM',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Vence hoje', 'TRIGGER:PT0S', 'END:VALARM', 'END:VEVENT');
    });
    return list.length ? out.concat('END:VCALENDAR', '').join('\r\n') : '';
  }

  g.Vida = { agenda: agenda, COLS: COLS, split: split, valid: valid, get: get, set: set, del: del, update: update, all: all, replaceAll: replaceAll, metaGet: metaGet, metaSet: metaSet, hoje: hoje, pendentes: pendentes, texto: texto, avisar: avisar };
})(self);
