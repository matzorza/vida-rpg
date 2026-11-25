/* Substitui o armazenamento do Claude pelo do aparelho, e cuida do painel "Meu app". */
(function () {
  'use strict';
  var V = self.Vida, subs = [];
  function snap(id, v) { return { id: id, exists: v !== undefined, data: function () { return v; } }; }
  async function fire(path) {
    var p = V.split(path), docs = null;
    for (var i = 0; i < subs.length; i++) {
      var s = subs[i];
      if (s.col === p.col) { docs = docs || await V.all(); s.cb(colSnap(docs, s.col)); }
      else if (s.doc === path) { s.cb(snap(p.id, await V.get(path))); }
    }
  }
  function colSnap(docs, col) {
    return { docs: Object.keys(docs).filter(function (k) { return V.split(k).col === col; }).map(function (k) { return snap(V.split(k).id, docs[k]); }) };
  }
  var db = {
    doc: function (path) {
      return {
        set: async function (d) { await V.set(path, d); await fire(path); },
        update: async function (d) { await V.update(path, d); await fire(path); },
        delete: async function () { await V.del(path); await fire(path); },
        onSnapshot: function (cb, err) { subs.push({ doc: path, cb: cb }); V.get(path).then(function (v) { cb(snap(V.split(path).id, v)); }).catch(err); }
      };
    },
    collection: function (col) {
      return { onSnapshot: function (cb, err) { subs.push({ col: col, cb: cb }); V.all().then(function (d) { cb(colSnap(d, col)); }).catch(err); } };
    }
  };
  window.claude = { use: async function (n) { return n === 'db' ? db : n === 'user' ? { id: async function () { return 'me'; } } : null; } };

  /* ---- leitor de zip (o backup) ---- */
  async function lerZip(file) {
    var buf = await file.arrayBuffer(), v = new DataView(buf), e = buf.byteLength - 22, out = {}, td = new TextDecoder();
    while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('Este arquivo não é um zip válido.');
    var n = v.getUint16(e + 10, true), o = v.getUint32(e + 16, true);
    for (var i = 0; i < n; i++) {
      if (v.getUint32(o, true) !== 0x02014b50) throw new Error('Zip danificado.');
      var met = v.getUint16(o + 10, true), size = v.getUint32(o + 20, true), nl = v.getUint16(o + 28, true), xl = v.getUint16(o + 30, true), cl = v.getUint16(o + 32, true), lo = v.getUint32(o + 42, true);
      var name = td.decode(new Uint8Array(buf, o + 46, nl)).replace(/\\/g, '/');
      o += 46 + nl + xl + cl;
      if (!/\.json$/.test(name)) continue;
      var path = name.slice(0, -5);
      if (path !== 'cartucho' && !V.valid(path)) continue;
      var st = lo + 30 + v.getUint16(lo + 26, true) + v.getUint16(lo + 28, true);
      var blob = new Blob([new Uint8Array(buf, st, size)]);
      if (met === 8) blob = await new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      else if (met !== 0) throw new Error('Tipo de zip não aceito.');
      out[path] = JSON.parse((await blob.text()).replace(/^﻿/, ''));
    }
    return out;
  }
  async function lerBackup(file) {
    var map = {}, cart = null;
    if (/\.json$/i.test(file.name)) {
      var j = JSON.parse(await file.text()), d = (j && j.docs) || {};
      Object.keys(d).forEach(function (k) { if (V.valid(k)) map[k] = d[k]; });
      cart = j && j.cartucho;
    } else { map = await lerZip(file); cart = map.cartucho; delete map.cartucho; }
    if (!map['config/main']) throw new Error('Não achei os dados do jogo neste arquivo.');
    if (cart && typeof cart.js !== 'string') throw new Error('Cartucho inválido.');
    if (!cart && !(await V.metaGet('cartucho'))) throw new Error('Este backup não tem o cartucho do jogo.');
    return { map: map, cart: cart };
  }

  /* ---- som 8-bit e vibracao ---- */
  var ac = null, NOTAS = { conta: [523, 659, 784], fase: [523, 659, 784, 1047, 784, 1047], nivel: [392, 523, 659, 784, 1047] };
  function somOn() { try { return localStorage.getItem('vrpg_som') !== 'off'; } catch (e) { return true; } }
  window.VidaFx = function (k) {
    if (!somOn()) return;
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)(); ac.resume();
      NOTAS[k].forEach(function (f, i) {
        var o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + i * 0.09;
        o.type = 'square'; o.frequency.value = f; g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + 0.13);
      });
      if (navigator.vibrate) navigator.vibrate(k === 'conta' ? 60 : [60, 40, 120]);
    } catch (e) { }
  };

  /* ---- painel ---- */
  function el(id) { return document.getElementById(id); }
  function msg(t) { el('pwa-msg').textContent = t; }
  async function importar(file) {
    try {
      msg('Lendo o backup...');
      var bk = await lerBackup(file), old = Object.keys(await V.all()).length;
      if (old && !confirm('Isto troca os ' + old + ' registros deste aparelho pelos do backup. Continuar?')) { msg('Nada foi alterado.'); return; }
      if (bk.cart && !confirm('Este arquivo traz o código do jogo. Só continue se ele for seu. Continuar?')) { msg('Nada foi alterado.'); return; }
      await V.replaceAll(bk.map, bk.cart);
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
      location.reload();
    } catch (e) { msg('Não consegui importar. ' + e.message); }
  }
  async function exportar() {
    var b = new Blob([JSON.stringify({ app: 'vida-rpg', feito: new Date().toISOString(), docs: await V.all(), cartucho: await V.metaGet('cartucho') })], { type: 'application/json' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(b);
    a.download = 'vida-rpg-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    msg('Backup salvo nos downloads. Ele inclui o jogo e o diário: guarde em lugar seguro.');
  }
  async function agenda() {
    var txt = V.agenda(await V.all(), V.hoje());
    if (!txt) { msg('Cadastre contas no Orçamento primeiro.'); return; }
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/calendar' }));
    a.download = 'contas-vida-rpg.ics'; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    msg('Arquivo salvo nos downloads. Abra ou importe na sua agenda. Se mudar as contas, gere de novo.');
  }
  function pintarSom() { el('pwa-som').textContent = somOn() ? 'Som e vibração: ligados' : 'Som e vibração: desligados'; }
  async function pintar() {
    var on = (await V.metaGet('avisos')) && 'Notification' in window && Notification.permission === 'granted';
    el('pwa-av').textContent = on ? 'Desligar avisos' : 'Ligar avisos de contas';
    el('pwa-test').hidden = !on;
  }
  async function ligar() {
    if (!('Notification' in window) || !navigator.serviceWorker) { msg('Este navegador não aceita avisos.'); return; }
    if ((await V.metaGet('avisos')) && Notification.permission === 'granted') { await V.metaSet('avisos', false); msg('Avisos desligados.'); return pintar(); }
    if (await Notification.requestPermission() !== 'granted') { msg('O celular não liberou avisos. Libere nas configurações do site.'); return; }
    await V.metaSet('avisos', true);
    var reg = await navigator.serviceWorker.ready, fundo = false;
    try { await reg.periodicSync.register('contas', { minInterval: 12 * 36e5 }); fundo = true; } catch (e) { }
    await V.avisar(reg);
    msg(fundo ? 'Avisos ligados. Com o app fechado, o Android decide quando checar.' : 'Avisos ligados ao abrir o app. Para checar com ele fechado, instale e ligue de novo.');
    pintar();
  }
  async function testar() {
    var l = V.pendentes(await V.all(), V.hoje());
    var reg = await navigator.serviceWorker.ready;
    await reg.showNotification('Teste de aviso', { body: l.length ? V.texto(l) : 'Nenhuma conta vence nos próximos 3 dias.', icon: 'icone-192.png', tag: 'teste' });
    msg('Aviso de teste enviado.');
  }

  var convite = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); convite = e; var b = el('pwa-inst'); if (b) b.hidden = false; });
  document.addEventListener('DOMContentLoaded', async function () {
    el('pwa-file').addEventListener('change', function (e) { if (e.target.files[0]) importar(e.target.files[0]); e.target.value = ''; });
    el('pwa-imp').onclick = function () { el('pwa-file').click(); };
    el('pwa-exp').onclick = exportar;
    el('pwa-av').onclick = ligar;
    el('pwa-test').onclick = testar;
    el('pwa-ics').onclick = agenda;
    el('pwa-som').onclick = function () { try { localStorage.setItem('vrpg_som', somOn() ? 'off' : 'on'); } catch (e) { } pintarSom(); VidaFx('conta'); };
    pintarSom();
    el('pwa-inst').onclick = async function () { if (convite) { convite.prompt(); convite = null; el('pwa-inst').hidden = true; } };
    if (convite) el('pwa-inst').hidden = false;
    var cart = await V.metaGet('cartucho');
    if (cart) { var sc = document.createElement('script'); sc.textContent = cart.js; document.body.appendChild(sc); }
    else el('app').innerHTML = '<div class="empty">Console sem cartucho. Abra Meu app, aqui embaixo, e toque em Importar backup.</div>';
    if (!cart || !(await V.get('config/main'))) el('pwa').open = true;
    pintar();
    if (!navigator.serviceWorker) return;
    await navigator.serviceWorker.register('sw.js');
    var reg = await navigator.serviceWorker.ready;
    function checar() { V.avisar(reg).catch(function () { }); }
    if ('Notification' in window) { checar(); document.addEventListener('visibilitychange', function () { if (!document.hidden) checar(); }); }
  });
})();
