/* Sincroniza os dados com a nuvem (Supabase).
   O aparelho continua sendo o principal: tudo salva aqui primeiro e sobe quando der.
   Ao abrir, ao voltar para o app e a cada minuto, ele baixa o que mudou no outro aparelho.
   Se o mesmo item mudar nos dois aparelhos, fica a mudanca mais recente. */
(function (g) {
  'use strict';
  var BASE = 'https://jjaqgtdvmyzflouckvxp.supabase.co';
  var CHAVE = 'sb_publishable_ms1EukRfkT9kgsnYQitd9A_8Z_75vLo'; // chave publica: os dados sao protegidos pelo login
  var CART = 'meta/cartucho';
  var V = g.Vida;
  if (!V || typeof document === 'undefined') return;

  /* Guarda as funcoes originais: a nuvem grava por elas sem marcar nada para subir de novo. */
  var cru = { set: V.set, update: V.update, del: V.del, replaceAll: V.replaceAll, metaGet: V.metaGet, metaSet: V.metaSet, all: V.all };

  var P = null, fila = Promise.resolve(), rodando = null, timer = null, msgAtual = '';

  /* ---- o que falta subir (fica salvo, entao sobrevive a fechar o app sem internet) ---- */
  async function pend() { if (!P) P = (await cru.metaGet('nuvem_pend')) || {}; return P; }
  function marcar(paths) {
    fila = fila.then(async function () {
      var p = await pend(), n = Date.now();
      paths.forEach(function (k) { p[k] = n; });
      await cru.metaSet('nuvem_pend', p);
    }).catch(function () { });
    agendar(1500);
    return fila;
  }
  function limpar(enviados) {
    fila = fila.then(async function () {
      var p = await pend();
      Object.keys(enviados).forEach(function (k) { if (p[k] === enviados[k]) delete p[k]; });
      await cru.metaSet('nuvem_pend', p);
    }).catch(function () { });
    return fila;
  }

  /* Toda gravacao do app passa a avisar a nuvem. */
  V.set = async function (path, d) { await cru.set(path, d); marcar([path]); };
  V.update = async function (path, d) { await cru.update(path, d); marcar([path]); };
  V.del = async function (path) { await cru.del(path); marcar([path]); };
  V.replaceAll = async function (map, cart) {
    var antes = Object.keys(await cru.all());
    await cru.replaceAll(map, cart);
    var todos = {}; antes.concat(Object.keys(map)).forEach(function (k) { todos[k] = 1; });
    var l = Object.keys(todos); if (cart) l.push(CART);
    marcar(l);
  };
  V.metaSet = async function (k, v) { await cru.metaSet(k, v); if (k === 'cartucho') marcar([CART]); };

  /* ---- login ---- */
  function agora() { return Math.floor(Date.now() / 1000); }
  async function guardarSessao(j) {
    var s = { at: j.access_token, rt: j.refresh_token, exp: agora() + (+j.expires_in || 3600), uid: j.user && j.user.id, email: j.user && j.user.email };
    await cru.metaSet('nuvem_sessao', s);
    return s;
  }
  async function sessao() {
    var s = await cru.metaGet('nuvem_sessao');
    if (!s) return null;
    if (s.exp - agora() > 60) return s;
    var r = await fetch(BASE + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: CHAVE, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.rt }) });
    if (r.status === 400 || r.status === 401) { await cru.metaSet('nuvem_sessao', null); return null; }
    if (!r.ok) throw new Error('rede');
    return guardarSessao(await r.json());
  }
  async function api(caminho, op) {
    var s = await sessao();
    if (!s) throw new Error('sem login');
    op = op || {};
    op.headers = Object.assign({ apikey: CHAVE, Authorization: 'Bearer ' + s.at, 'Content-Type': 'application/json' }, op.headers || {});
    var r = await fetch(BASE + '/rest/v1/' + caminho, op);
    if (!r.ok) throw new Error('nuvem ' + r.status);
    return r;
  }
  async function pedirLink(email) {
    var volta = location.origin + location.pathname;
    var r = await fetch(BASE + '/auth/v1/otp?redirect_to=' + encodeURIComponent(volta), { method: 'POST', headers: { apikey: CHAVE, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, create_user: true }) });
    if (!r.ok) { var j = {}; try { j = await r.json(); } catch (e) { } throw new Error(j.msg || j.error_description || ('erro ' + r.status)); }
  }
  /* O link do e-mail volta com o login no endereco: le e apaga antes do jogo abrir. */
  var retorno = null;
  (function () {
    var h = location.hash || '';
    if (h.indexOf('access_token=') < 0 && h.indexOf('error_description=') < 0) return;
    var q = {}; h.slice(1).split('&').forEach(function (p) { var i = p.indexOf('='); if (i > 0) q[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1).replace(/\+/g, ' ')); });
    retorno = q;
    history.replaceState(null, '', location.pathname + location.search);
  })();
  async function usuario(at) {
    var r = await fetch(BASE + '/auth/v1/user', { headers: { apikey: CHAVE, Authorization: 'Bearer ' + at } });
    return r.ok ? r.json() : null;
  }

  /* ---- subir e baixar ---- */
  async function subir() {
    var p = Object.assign({}, await pend()), ks = Object.keys(p);
    if (!ks.length) return 0;
    var s = await sessao(), docs = await cru.all(), lotes = [[]], tam = 0;
    for (var i = 0; i < ks.length; i++) {
      var k = ks[i], d = k === CART ? ((await cru.metaGet('cartucho')) || null) : (docs[k] === undefined ? null : docs[k]);
      var row = { user_id: s.uid, path: k, data: d }, t = JSON.stringify(row).length;
      if (tam + t > 300000 && lotes[lotes.length - 1].length) { lotes.push([]); tam = 0; }
      lotes[lotes.length - 1].push(row); tam += t;
    }
    for (var j = 0; j < lotes.length; j++) {
      await api('vida_docs?on_conflict=user_id,path', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(lotes[j]) });
      var ok = {}; lotes[j].forEach(function (r) { ok[r.path] = p[r.path]; });
      await limpar(ok);
    }
    return ks.length;
  }
  async function linhas(desde) {
    var out = [], c = desde || '1970-01-01T00:00:00Z';
    for (; ;) {
      var r = await api('vida_docs?select=path,data,updated_at&updated_at=gt.' + encodeURIComponent(c) + '&order=updated_at.asc&limit=500');
      var l = await r.json(); out = out.concat(l);
      if (l.length < 500) break;
      c = l[l.length - 1].updated_at;
    }
    return out;
  }
  async function baixar() {
    var cursor = await cru.metaGet('nuvem_cursor'), l = await linhas(cursor);
    if (!l.length) return 0;
    var p = await pend(), docs = await cru.all(), mud = [], novoCart = null;
    for (var i = 0; i < l.length; i++) {
      var r = l[i];
      if (p[r.path]) continue; // tem mudanca daqui esperando para subir: ela vence
      if (r.path === CART) {
        var cur = await cru.metaGet('cartucho');
        if (r.data && typeof r.data.js === 'string' && (!cur || cur.js !== r.data.js)) novoCart = r.data;
        continue;
      }
      if (!V.valid(r.path)) continue;
      if (JSON.stringify(docs[r.path]) === JSON.stringify(r.data === null ? undefined : r.data)) continue;
      if (r.data === null) await cru.del(r.path); else await cru.set(r.path, r.data);
      mud.push(r.path);
    }
    await cru.metaSet('nuvem_cursor', l[l.length - 1].updated_at);
    if (mud.length) g.dispatchEvent(new CustomEvent('vida-nuvem', { detail: { paths: mud } }));
    if (novoCart) { await cru.metaSet('cartucho', novoCart); msg('Chegou uma versão nova do jogo. Recarregando...'); setTimeout(function () { location.reload(); }, 900); }
    return mud.length;
  }

  /* ---- primeira vez neste aparelho ---- */
  async function ligarAparelho(s) {
    var r = await api('vida_docs?select=path&limit=1'), temNuvem = (await r.json()).length > 0;
    var local = Object.keys(await cru.all()).length;
    if (!temNuvem) {
      if (!confirm('A nuvem está vazia. Enviar os ' + local + ' registros deste aparelho para lá?')) return false;
      var l = Object.keys(await cru.all()); if (await cru.metaGet('cartucho')) l.push(CART);
      await cru.metaSet('nuvem_ok', s.uid);
      await marcar(l);
      msg('Enviando seus dados para a nuvem...');
      await sincronizar(true);
      return true;
    }
    if (local && !confirm('A nuvem já tem seus dados. Trocar os ' + local + ' registros deste aparelho pelos da nuvem? Os daqui serão substituídos.')) return false;
    msg('Baixando seus dados da nuvem...');
    var todas = await linhas(null), map = {}, cart = null, ult = null;
    todas.forEach(function (x) { ult = x.updated_at; if (x.path === CART) cart = x.data; else if (x.data !== null && V.valid(x.path)) map[x.path] = x.data; });
    await cru.replaceAll(map, cart);
    P = {}; await cru.metaSet('nuvem_pend', P);
    await cru.metaSet('nuvem_cursor', ult);
    await cru.metaSet('nuvem_ok', s.uid);
    location.reload();
    return true;
  }

  /* ---- ciclo ---- */
  async function ligado() { var s = await cru.metaGet('nuvem_sessao'), ok = await cru.metaGet('nuvem_ok'); return !!(s && ok && ok === s.uid); }
  function sincronizar(forcar) {
    if (rodando) return rodando;
    rodando = (async function () {
      try {
        if (!(await ligado())) return;
        if (!navigator.onLine && !forcar) { pintar('Sem internet. As mudanças sobem quando a conexão voltar.'); return; }
        await subir(); await baixar();
        await cru.metaSet('nuvem_ultima', Date.now());
        pintar();
      } catch (e) {
        if (String(e.message) === 'sem login') pintar('O login venceu. Entre de novo para voltar a sincronizar.');
        else pintar('Não consegui falar com a nuvem agora. Tento de novo sozinho.');
      } finally { rodando = null; }
    })();
    return rodando;
  }
  function agendar(ms) { clearTimeout(timer); timer = setTimeout(sincronizar, ms); }

  /* ---- painel ---- */
  function el(id) { return document.getElementById(id); }
  function msg(t) { var m = el('pwa-msg'); if (m) m.textContent = t; }
  async function pintar(aviso) {
    var s = await cru.metaGet('nuvem_sessao'), on = await ligado(), p = Object.keys(await pend()).length, ult = await cru.metaGet('nuvem_ultima');
    var st = el('nv-st'); if (!st) return;
    el('nv-login').hidden = !!s; el('nv-on').hidden = !s;
    if (!s) st.textContent = 'Nuvem desligada. Entre com seu e-mail para usar os mesmos dados no PC e no celular.';
    else if (!on) st.textContent = 'Conectado como ' + s.email + ', mas este aparelho ainda não está sincronizando.';
    else st.textContent = 'Sincronizando como ' + s.email + '. ' + (p ? p + ' mudança(s) esperando para subir. ' : 'Tudo em dia. ') + (ult ? 'Última vez: ' + new Date(ult).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + '.' : '');
    el('nv-ligar').hidden = !s || on;
    if (aviso) msg(aviso);
  }
  async function entrar() {
    var e = (el('nv-email').value || '').trim();
    if (!/^\S+@\S+\.\S+$/.test(e)) { msg('Digite um e-mail válido.'); return; }
    try { await pedirLink(e); msg('Mandei um link para ' + e + '. Abra o e-mail neste aparelho e toque no link.'); }
    catch (x) { msg('Não consegui mandar o link: ' + x.message); }
  }
  async function sair() {
    if (!confirm('Sair da nuvem neste aparelho? Os dados daqui continuam aqui, só param de sincronizar.')) return;
    var s = await cru.metaGet('nuvem_sessao');
    try { if (s) await fetch(BASE + '/auth/v1/logout', { method: 'POST', headers: { apikey: CHAVE, Authorization: 'Bearer ' + s.at } }); } catch (e) { }
    await cru.metaSet('nuvem_sessao', null); await cru.metaSet('nuvem_ok', null); await cru.metaSet('nuvem_cursor', null);
    pintar('Nuvem desligada neste aparelho.');
  }
  async function ligar() {
    try { var s = await sessao(); if (!s) { pintar('Entre de novo.'); return; } if (await ligarAparelho(s)) pintar(); else pintar('Nada foi alterado.'); }
    catch (e) { pintar('Não consegui falar com a nuvem: ' + e.message); }
  }

  document.addEventListener('DOMContentLoaded', async function () {
    if (!el('nv-st')) return;
    el('nv-entrar').onclick = entrar;
    el('nv-email').addEventListener('keydown', function (e) { if (e.key === 'Enter') entrar(); });
    el('nv-sair').onclick = sair;
    el('nv-ligar').onclick = ligar;
    el('nv-agora').onclick = function () { msg('Sincronizando...'); sincronizar(true).then(function () { msg('Sincronizado.'); }); };
    if (retorno) {
      if (retorno.access_token) {
        var u = await usuario(retorno.access_token);
        await guardarSessao({ access_token: retorno.access_token, refresh_token: retorno.refresh_token, expires_in: retorno.expires_in, user: u || {} });
        el('pwa').open = true;
        if (!(await ligado())) await ligar(); else pintar('Login feito.');
      } else { el('pwa').open = true; pintar('O link não funcionou: ' + (retorno.error_description || 'tente pedir outro.')); }
    }
    pintar();
    sincronizar();
    setInterval(function () { if (!document.hidden) sincronizar(); }, 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) sincronizar(); });
    g.addEventListener('online', function () { sincronizar(); });
  });

  g.VidaNuvem = { sincronizar: sincronizar, subir: subir, baixar: baixar };
})(self);
