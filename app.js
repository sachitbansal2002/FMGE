/* FMGE Baseline — app logic (v4.0.0)
   Preserves the original app's flows (exam, navigator, flags, confidence, notes, goals, report, CSV, backup)
   and replaces localStorage with IndexedDB (+ synchronous localStorage mirror) for durable progress. */
(function () {
'use strict';

/* ───────────────────────── constants ───────────────────────── */
var IS_ARTIFACT = !!window.__ARTIFACT__;
var APP = { version: '4.0.0', idbVersion: 1, backupFormat: 2, db: 'fmge-baseline',
            mirrorKey: 'fmge-baseline:mirror:v1', safetyKey: 'fmge-baseline:safety:v1', dismissKey: 'fmge-baseline:dismiss:v1' };
var BANK = window.FMGE_BANK, Q = BANK.questions, N = Q.length;
var OPT = ['A', 'B', 'C', 'D'];
var SUBJECTS = ['Unmapped','Anatomy','Physiology','Biochemistry','Pathology','Pharmacology','Microbiology','Forensic Medicine','Community Medicine','Medicine','Surgery','Obstetrics & Gynaecology','Paediatrics','Ophthalmology','ENT','Orthopaedics','Dermatology','Psychiatry','Radiology','Anaesthesiology'];
var KINDS = ['Clinical vignette','Concept / direct recall','Visual / interpretation','Calculation / interpretation','Direct recall','Image / diagram','Management / next step','Investigation / diagnosis','Other'];
var KIND_CLASS = { 'Clinical vignette':'Clinical', 'Management / next step':'Clinical', 'Investigation / diagnosis':'Clinical',
  'Concept / direct recall':'Theoretical / recall', 'Direct recall':'Theoretical / recall', 'Calculation / interpretation':'Theoretical / recall', 'Other':'Theoretical / recall',
  'Visual / interpretation':'Image / data interpretation', 'Image / diagram':'Image / data interpretation' };
var CONF = { high: 'High', medium: 'Medium', low: 'Low / guessed' };
var RX = {
  fig: /(diagram|figure|image|graph|curve|trace|loop|photograph|radiograph|ECG|X-ray|picture)\s+(below|shown|given|above)|shown (below|above)|below shows|following (image|figure|diagram)/i,
  mgmt: /next step|initial management|immediate management|treatment of choice|most appropriate (management|treatment|therapy)|best (treatment|management)|drug of choice|first-line|should be (given|started|administered)|management/i,
  inv: /investigation|diagnostic test|test of choice|best initial test|most appropriate (test|investigation)|screening test|confirm(s|ed)? the diagnosis|imaging/i,
  dx: /(most likely|probable|likely) (diagnosis|cause|condition|etiology)|diagnosis (is|would be)|what is the diagnosis/i
};
function hasOptions(q) { return OPT.every(function (a) { return q.options && q.options[a]; }); }
var UNSCORABLE = {}; Q.forEach(function (q) { if (!hasOptions(q)) UNSCORABLE[q.n] = true; });
var UNSCORABLE_LIST = Object.keys(UNSCORABLE).map(Number);
var MAXSCORE = N - UNSCORABLE_LIST.length;
var SECTIONS = []; Q.forEach(function (q) { if (SECTIONS.indexOf(q.section) < 0) SECTIONS.push(q.section); });

/* ───────────────────────── helpers ───────────────────────── */
function $(s, r) { return (r || document).querySelector(s); }
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function pct(a, b) { return b ? Math.round(a / b * 100) : 0; }
function fmt(ms) { var s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0'); }
function fmtTime(t) { var d = new Date(t); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function fmtDate(t) { return new Date(t).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function stamp() { var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()); }
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
function figureQ(q) { return RX.fig.test(q.stem); }
function isStandalone() { return !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)); }

/* ───────────────────────── state ───────────────────────── */
var meta, answers = {}, sessions = [], sess = null, REVIEW = null;
var screenName = 'home', idx = 0, paused = false, navOpen = false;
var navFilter = 'all', reviewFilter = 'incorrect', reviewLimit = 40;
var Store = { db: null, mode: 'memory', persisted: null, notice: '' };
var saveState = { s: 'saved', at: 0, err: '' };
var dirty = {};
var running = false, lastTick = 0, tickCount = 0, noteTimer = null, updateReg = null;

function freshMeta() { var t = Date.now(); return { schema: APP.idbVersion, bankId: BANK.id, createdAt: t, status: 'active', idx: 0, activeMs: 0, goal: null, submittedAt: null, lastBackupAt: null, answeredAtBackup: 0, savedAt: t }; }
function entry(n) { return answers[n] || {}; }
function answeredCount() { var c = 0; for (var k in answers) if (answers[k].choice) c++; return c; }
function flaggedCount() { var c = 0; for (var k in answers) if (answers[k].flag) c++; return c; }
function submitted() { return meta.status === 'submitted'; }

/* ───────────────────────── IndexedDB layer ───────────────────────── */
function openDB() {
  return new Promise(function (res, rej) {
    if (!window.indexedDB) return rej(new Error('IndexedDB unavailable'));
    var r;
    try { r = indexedDB.open(APP.db, APP.idbVersion); } catch (e) { return rej(e); }
    r.onupgradeneeded = function (e) { migrateDB(r.result, e.oldVersion); };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
    r.onblocked = function () { rej(new Error('IndexedDB blocked')); };
  });
}
/* Version-safe schema migrations: add one `if (old < n)` block per future version; never drop stores. */
function migrateDB(db, old) {
  if (old < 1) {
    db.createObjectStore('kv');
    db.createObjectStore('answers', { keyPath: 'n' });
    db.createObjectStore('sessions', { keyPath: 'id' });
    db.createObjectStore('safety', { keyPath: 'id' });
  }
}
function rq(r) { return new Promise(function (a, b) { r.onsuccess = function () { a(r.result); }; r.onerror = function () { b(r.error); }; }); }
function idbLoadAll() {
  var t = Store.db.transaction(['kv', 'answers', 'sessions'], 'readonly');
  return Promise.all([rq(t.objectStore('kv').get('meta')), rq(t.objectStore('answers').getAll()), rq(t.objectStore('sessions').getAll())])
    .then(function (r) { return { meta: r[0], answers: r[1], sessions: r[2] }; });
}
function idbWrite(ops) {
  return new Promise(function (res, rej) {
    var names = []; ops.forEach(function (o) { if (names.indexOf(o[0]) < 0) names.push(o[0]); });
    var t = Store.db.transaction(names, 'readwrite');
    ops.forEach(function (o) {
      var st = t.objectStore(o[0]);
      if (o[1] === 'put') { if (o[3] !== undefined) st.put(o[2], o[3]); else st.put(o[2]); }
      else if (o[1] === 'delete') st.delete(o[2]);
      else if (o[1] === 'clear') st.clear();
    });
    t.oncomplete = function () { res(); };
    t.onerror = function () { rej(t.error); };
    t.onabort = function () { rej(t.error || new Error('Transaction aborted')); };
  });
}
function readMirror() { try { var s = lsGet(APP.mirrorKey); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function writeMirror() {
  var ok = lsSet(APP.mirrorKey, JSON.stringify({ meta: meta, answers: answers, sessions: sessions }));
  return ok;
}

/* All writes go through commit(): updates meta.savedAt, writes the synchronous mirror, then queues the IndexedDB transaction. */
var chain = Promise.resolve(), pending = 0;
function commit(ops) {
  meta.savedAt = Date.now();
  var mirrorOk = writeMirror();
  var all = [['kv', 'put', clone(meta), 'meta']].concat(ops || []);
  pending++; setSave('saving');
  chain = chain.then(function () {
    if (!Store.db) { if (!mirrorOk) throw new Error('No storage available in this browser'); return; }
    return idbWrite(all);
  }).then(function () { setSave('saved'); }, function (e) {
    console.error('save failed', e);
    if (mirrorOk) setSave('saved'); else setSave('error', e && e.message);
  }).then(function () { pending--; });
  return chain;
}
function setSave(s, err) {
  if (s === 'saved' && pending > 1) return;
  saveState = { s: s, at: s === 'saved' ? Date.now() : saveState.at, err: err || '' };
  renderSaveChip();
}
function renderSaveChip() {
  var el = $('#savechip'); if (!el) return;
  var cls = 'chip', html;
  if (Store.mode === 'memory') { cls += ' error'; html = '<i></i><span class="l">Not saving</span>'; }
  else if (saveState.s === 'saving') { cls += ' saving'; html = '<i></i><span class="l">Saving…</span>'; }
  else if (saveState.s === 'error') { cls += ' error'; html = '<i></i><span class="l">Save failed — export a backup</span>'; }
  else { cls += ' saved'; html = '<i></i><span class="l">Saved</span>' + (saveState.at ? ' <span class="t">· ' + fmtTime(saveState.at) + '</span>' : ''); }
  el.className = cls; el.innerHTML = html;
  el.title = Store.mode === 'memory' ? 'This browser blocks storage. Progress will be lost when you close the page.' : 'Stored in ' + Store.mode + ' on this device';
}

/* ───────────────────────── load / normalise / migrate ───────────────────────── */
function cleanEntry(n, e) {
  if (!e || typeof e !== 'object') return null;
  var o = { n: n };
  o.choice = OPT.indexOf(e.choice) >= 0 && !UNSCORABLE[n] ? e.choice : null;
  o.confidence = (e.confidence === 'high' || e.confidence === 'medium' || e.confidence === 'low') ? e.confidence : '';
  o.flag = !!e.flag;
  o.notes = typeof e.notes === 'string' ? e.notes.slice(0, 5000) : '';
  o.topic = typeof e.topic === 'string' ? e.topic.slice(0, 120) : '';
  if (typeof e.subject === 'string' && SUBJECTS.indexOf(e.subject) >= 0 && e.subject !== Q[n - 1].subject) o.subject = e.subject;
  if (typeof e.kind === 'string' && KINDS.indexOf(e.kind) >= 0 && e.kind !== Q[n - 1].kind) o.kind = e.kind;
  o.ms = typeof e.ms === 'number' && isFinite(e.ms) && e.ms >= 0 ? Math.round(e.ms) : 0;
  o.at = typeof e.at === 'number' ? e.at : 0;
  return o;
}
function normalizeMeta(m) {
  var f = freshMeta(); m = m || {};
  f.createdAt = +m.createdAt || f.createdAt;
  f.status = m.status === 'submitted' ? 'submitted' : 'active';
  f.submittedAt = f.status === 'submitted' ? (+m.submittedAt || Date.now()) : null;
  f.idx = Math.max(0, Math.min(N - 1, parseInt(m.idx, 10) || 0));
  f.activeMs = Math.max(0, +m.activeMs || 0);
  f.goal = m.goal && m.goal.target > 0 ? { target: Math.min(N, m.goal.target | 0), startCount: Math.max(0, m.goal.startCount | 0) } : null;
  f.lastBackupAt = +m.lastBackupAt || null;
  f.answeredAtBackup = Math.max(0, +m.answeredAtBackup || 0);
  f.savedAt = +m.savedAt || f.createdAt;
  return f;
}
function normalizeSessions(list) {
  return (Array.isArray(list) ? list : []).filter(function (s) { return s && typeof s.id === 'number'; })
    .map(function (s) { return { id: s.id, startedAt: +s.startedAt || s.id, endedAt: +s.endedAt || 0, activeMs: Math.max(0, +s.activeMs || 0), answeredStart: +s.answeredStart || 0, answeredEnd: +s.answeredEnd || 0 }; })
    .sort(function (a, b) { return a.id - b.id; });
}
function arrToAnswers(arr) {
  var o = {};
  (Array.isArray(arr) ? arr : Object.keys(arr || {}).map(function (k) { return Object.assign({ n: +k }, arr[k]); })).forEach(function (e) {
    var n = parseInt(e && e.n, 10); if (n >= 1 && n <= N) { var c = cleanEntry(n, e); if (c) o[n] = c; }
  });
  return o;
}
function applyLoaded(m, a, s) { meta = normalizeMeta(m); answers = arrToAnswers(a); sessions = normalizeSessions(s); idx = meta.idx; }

function boot() {
  return openDB().then(function (db) { Store.db = db; Store.mode = 'IndexedDB'; }, function () { Store.db = null; Store.mode = lsSet('fmge-baseline:probe', '1') ? 'localStorage' : 'memory'; })
    .then(function () { return Store.db ? idbLoadAll().catch(function () { return null; }) : null; })
    .then(function (fromIdb) {
      var mirror = readMirror(), idbHas = !!(fromIdb && fromIdb.meta), mirHas = !!(mirror && mirror.meta);
      /* The mirror is written synchronously before each IndexedDB transaction, so if it is newer at all, an
         IndexedDB write was cut short (page closed mid-save). Newer copy always wins; nothing is lost. */
      if (idbHas && mirHas && (+mirror.meta.savedAt || 0) > (+fromIdb.meta.savedAt || 0)) {
        var gap = (+mirror.meta.savedAt || 0) - (+fromIdb.meta.savedAt || 0);
        applyLoaded(mirror.meta, mirror.answers, mirror.sessions);
        if (gap > 5000) Store.notice = 'Restored a newer copy of your progress from the secondary browser copy.';
        return resyncIdb();
      }
      if (idbHas) { applyLoaded(fromIdb.meta, fromIdb.answers, fromIdb.sessions); return; }
      if (mirHas) { applyLoaded(mirror.meta, mirror.answers, mirror.sessions); Store.notice = 'Your main database was empty, so progress was recovered from the secondary browser copy.'; return resyncIdb(); }
      applyLoaded(freshMeta(), {}, []);
    })
    .then(function () {
      if (Store.mode === 'localStorage' && !IS_ARTIFACT) Store.notice = Store.notice || 'IndexedDB is unavailable here; using the browser\'s localStorage instead.';
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().then(function (p) { Store.persisted = p; if (screenName === 'settings') render(); }).catch(function () {});
      if (submitted()) return loadReview().catch(function () {});
    });
}
function resyncIdb() {
  if (!Store.db) return Promise.resolve();
  var ops = [['answers', 'clear'], ['sessions', 'clear'], ['kv', 'put', clone(meta), 'meta']];
  Object.keys(answers).forEach(function (k) { ops.push(['answers', 'put', answers[k]]); });
  sessions.forEach(function (s) { ops.push(['sessions', 'put', s]); });
  return idbWrite(ops).catch(function (e) { console.error(e); });
}

/* ───────────────────────── review data (answer key) — loaded only after submission ───────────────────────── */
function loadReview() {
  if (REVIEW) return Promise.resolve(REVIEW);
  return new Promise(function (res, rej) {
    var take = function () {
      try { var b = window.FMGE_REVIEW_B64; window.FMGE_REVIEW_B64 = undefined; var bin = atob(b), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); REVIEW = JSON.parse(new TextDecoder('utf-8').decode(u)); res(REVIEW); } catch (e) { rej(new Error('The answer key file is damaged: ' + e.message)); }
    };
    if (window.FMGE_REVIEW_B64) return take();
    var inline = document.getElementById('reviewData');
    if (inline) { window.FMGE_REVIEW_B64 = inline.textContent.trim(); return take(); }
    var s = document.createElement('script'); s.src = './review.js';
    s.onload = take;
    s.onerror = function () { rej(new Error('Could not load the answer key. Check your connection and try again.')); };
    document.head.appendChild(s);
  });
}

/* ───────────────────────── clock & per-question timing ───────────────────────── */
function shouldRun() { return screenName === 'exam' && !paused && !document.hidden && !submitted() && !document.querySelector('.overlay'); }
function ensureSession() {
  if (sess) return;
  sess = { id: Date.now(), startedAt: Date.now(), endedAt: 0, activeMs: 0, answeredStart: answeredCount(), answeredEnd: answeredCount() };
  sessions.push(sess);
}
function accumulate() {
  if (!running) return;
  var now = Date.now(), d = now - lastTick; lastTick = now;
  if (d <= 0) return; if (d > 30000) d = 1000;
  meta.activeMs += d;
  if (sess) { sess.activeMs += d; sess.endedAt = now; sess.answeredEnd = answeredCount(); }
  var n = idx + 1, e = answers[n] || (answers[n] = { n: n, choice: null, confidence: '', flag: false, notes: '', topic: '', ms: 0, at: 0 });
  e.ms = (e.ms || 0) + d; dirty[n] = 1;
}
function syncClock() {
  var should = shouldRun();
  if (should && !running) { ensureSession(); running = true; lastTick = Date.now(); }
  else if (!should && running) { accumulate(); running = false; flush(); }
}
function flush(sync) {
  if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
  if (running) accumulate();
  var ops = [];
  Object.keys(dirty).forEach(function (k) { if (answers[k]) ops.push(['answers', 'put', clone(answers[k])]); });
  dirty = {};
  if (sess) ops.push(['sessions', 'put', clone(sess)]);
  return commit(ops);
}
setInterval(function () {
  if (running) { accumulate(); tickCount++; var t = $('#timer'); if (t) t.textContent = 'Active ' + fmt(meta.activeMs); var g = $('#sessTime'); if (g && sess) g.textContent = fmt(sess.activeMs); if (tickCount % 10 === 0) flush(); }
}, 1000);
document.addEventListener('visibilitychange', function () { if (document.hidden) { syncClock(); flush(); } else syncClock(); });
window.addEventListener('pagehide', function () { if (running) accumulate(); flush(); });

/* ───────────────────────── mutations ───────────────────────── */
function setEntry(n, patch) {
  accumulate();
  var e = answers[n] || { n: n, choice: null, confidence: '', flag: false, notes: '', topic: '', ms: 0, at: 0 };
  Object.assign(e, patch); e.at = Date.now();
  ['subject', 'kind'].forEach(function (k) { if (e[k] === Q[n - 1][k] || e[k] === '' || e[k] == null) delete e[k]; });
  answers[n] = e;
  if (sess) { sess.answeredEnd = answeredCount(); sess.endedAt = Date.now(); }
  delete dirty[n];
  var ops = [['answers', 'put', clone(e)]]; if (sess) ops.push(['sessions', 'put', clone(sess)]);
  return commit(ops);
}
function go(i) {
  i = Math.max(0, Math.min(N - 1, i));
  if (screenName === 'exam') { accumulate(); }
  idx = i; meta.idx = i;
  flush();
  if (screenName === 'exam') { renderQuestion(); renderNav(); window.scrollTo(0, 0); }
}
function answer(c) {
  if (submitted() || UNSCORABLE[idx + 1]) return;
  setEntry(idx + 1, { choice: c });
  renderQuestion(); renderNav(); updateGoalText();
  if (navigator.storage && navigator.storage.persist && Store.persisted === null) navigator.storage.persist().then(function (p) { Store.persisted = p; }).catch(function () {});
}

/* ───────────────────────── backup / import / safety ───────────────────────── */
function buildBackup() {
  if (running) accumulate();
  var a = {}; Object.keys(answers).forEach(function (k) { a[k] = clone(answers[k]); delete a[k].n; });
  return { app: 'fmge-baseline', format: APP.backupFormat, appVersion: APP.version, bankId: BANK.id, bankCount: N, exportedAt: new Date().toISOString(),
    meta: { status: meta.status, submittedAt: meta.submittedAt, idx: meta.idx, activeMs: meta.activeMs, goal: meta.goal, createdAt: meta.createdAt }, answers: a, sessions: clone(sessions) };
}
/* Accepts format 2 (this app) and format 1 (the original single-file app: {questions, answers, finished, elapsed}). */
function parseBackup(text) {
  var d; try { d = JSON.parse(text); } catch (e) { throw new Error('That is not valid JSON. Choose the .json backup file exported from this app.'); }
  if (!d || typeof d !== 'object' || !d.answers || typeof d.answers !== 'object') throw new Error('This file does not look like an FMGE Baseline backup (no answers found).');
  var out = { meta: {}, answers: {}, sessions: [], warnings: [], from: '' };
  if (d.format > APP.backupFormat) throw new Error('This backup was made by a newer version of the app (format ' + d.format + '). Update the app, then try again.');
  if (d.bankId && d.bankId !== BANK.id) throw new Error('This backup belongs to a different question bank (' + d.bankId + ').');
  if (d.format === 2) {
    out.from = 'format 2'; out.meta = d.meta || {}; out.sessions = d.sessions || [];
  } else if (Array.isArray(d.questions) || d.finished !== undefined || d.elapsed !== undefined) {
    out.from = 'original single-file app (format 1)';
    out.meta = { status: d.finished ? 'submitted' : 'active', activeMs: Math.round((+d.elapsed || 0) * 1000), createdAt: +d.started || Date.now() };
    out.warnings.push('Converted from the original app backup. Per-question timing and session history were not recorded in that format.');
  } else throw new Error('Unrecognised backup format.');
  var bad = 0, n = 0;
  Object.keys(d.answers).forEach(function (k) {
    var num = parseInt(k, 10);
    if (!(num >= 1 && num <= N)) { bad++; return; }
    var raw = d.answers[k]; if (raw && typeof raw.choice === 'string' && OPT.indexOf(raw.choice) < 0) { bad++; return; }
    var c = cleanEntry(num, raw); if (c) { out.answers[num] = c; n++; }
  });
  if (bad) out.warnings.push(bad + ' invalid entr' + (bad === 1 ? 'y was' : 'ies were') + ' skipped.');
  if (UNSCORABLE_LIST.some(function (q) { return d.answers[q] && d.answers[q].choice; })) out.warnings.push('An answer for an unanswerable question (Q' + UNSCORABLE_LIST.join(', Q') + ') was dropped.');
  out.exportedAt = d.exportedAt || '';
  return out;
}
function safetySnapshot(reason) {
  var snap = { id: Date.now(), reason: reason, createdAt: Date.now(), payload: buildBackup() };
  lsSet(APP.safetyKey, JSON.stringify(snap));
  if (!Store.db) return Promise.resolve(snap);
  return idbWrite([['safety', 'put', snap]]).then(function () {
    return rq(Store.db.transaction('safety').objectStore('safety').getAllKeys());
  }).then(function (keys) {
    keys.sort(function (a, b) { return b - a; });
    var old = keys.slice(5); if (!old.length) return;
    return idbWrite(old.map(function (k) { return ['safety', 'delete', k]; }));
  }).then(function () { return snap; }, function () { return snap; });
}
function latestSafety() {
  var fromLs = null; try { fromLs = JSON.parse(lsGet(APP.safetyKey) || 'null'); } catch (e) {}
  if (!Store.db) return Promise.resolve(fromLs);
  return rq(Store.db.transaction('safety').objectStore('safety').getAll()).then(function (all) {
    all.sort(function (a, b) { return b.id - a.id; });
    return all[0] || fromLs;
  }, function () { return fromLs; });
}
function replaceAll(parsed) {
  var m = normalizeMeta(Object.assign({}, parsed.meta, { savedAt: Date.now() }));
  m.lastBackupAt = meta.lastBackupAt; m.answeredAtBackup = meta.answeredAtBackup;
  meta = m; answers = parsed.answers; sessions = normalizeSessions(parsed.sessions); sess = null; idx = meta.idx; paused = false;
  var ops = [['answers', 'clear'], ['sessions', 'clear']];
  Object.keys(answers).forEach(function (k) { ops.push(['answers', 'put', clone(answers[k])]); });
  sessions.forEach(function (s) { ops.push(['sessions', 'put', clone(s)]); });
  REVIEW = null; window.FMGE_REVIEW_B64 = undefined;
  return (submitted() ? loadReview().catch(function () {}) : Promise.resolve()).then(function () { return commit(ops); });
}
function noteBackup() { meta.lastBackupAt = Date.now(); meta.answeredAtBackup = answeredCount(); return commit([]); }

/* ───────────────────────── modal / toast ───────────────────────── */
var modalActions = {};
function openModal(title, bodyHtml, buttons) {
  closeModal(true);
  modalActions = {};
  var btns = (buttons || []).map(function (b, i) { modalActions['m' + i] = b.onClick; return '<button class="btn ' + (b.cls || '') + '" id="mbtn' + i + '" data-act="modal" data-v="m' + i + '"' + (b.disabled ? ' disabled' : '') + '>' + esc(b.label) + '</button>'; }).join('');
  var root = $('#modalRoot');
  root.innerHTML = '<div class="overlay" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="sheet"><h3>' + esc(title) + '</h3>' + bodyHtml + '<div class="actions">' + btns + '</div></div></div>';
  syncClock();
  var f = root.querySelector('input,textarea'); if (f) setTimeout(function () { try { f.focus({ preventScroll: true }); } catch (e) {} }, 60);
}
function closeModal(silent) { var r = $('#modalRoot'); if (r) r.innerHTML = ''; modalActions = {}; if (!silent) syncClock(); }
function toast(msg) {
  var r = $('#toastRoot'); if (!r) return;
  r.innerHTML = '<div class="toast" role="status">' + esc(msg) + '</div>';
  clearTimeout(toast.t); toast.t = setTimeout(function () { r.innerHTML = ''; }, 2800);
}

/* ───────────────────────── analytics ───────────────────────── */
function taskOf(q, e) {
  if ((e.kind || q.kind) === 'Management / next step') return 'Management';
  if (RX.mgmt.test(q.stem)) return 'Management';
  if (RX.inv.test(q.stem)) return 'Investigation';
  if (RX.dx.test(q.stem)) return 'Diagnosis';
  if ((e.kind || q.kind) === 'Investigation / diagnosis') return 'Diagnosis / investigation (tagged together)';
  return 'Not classified';
}
function computeRows() {
  return Q.map(function (q) {
    var e = answers[q.n] || {}, rv = REVIEW && REVIEW[q.n], choice = e.choice || null, scorable = !UNSCORABLE[q.n];
    var kind = e.kind || q.kind;
    return { q: q, n: q.n, subject: e.subject || q.subject, kind: kind, klass: KIND_CLASS[kind] || 'Theoretical / recall', task: taskOf(q, e), topic: (e.topic || '').trim(), conf: e.confidence || '', flag: !!e.flag, notes: e.notes || '',
      choice: choice, ms: e.ms || 0, scorable: scorable, key: rv ? rv.key : null, explanation: rv ? rv.explanation : '', correct: (choice && rv && scorable) ? choice === rv.key : null };
  });
}
function group(rows, keyFn) {
  var m = {}, order = [];
  rows.forEach(function (r) {
    var k = keyFn(r); if (k === '' || k == null) return;
    var g = m[k]; if (!g) { g = m[k] = { name: k, total: 0, attempted: 0, correct: 0, wrong: 0, unanswered: 0, highWrong: 0, ms: 0 }; order.push(k); }
    if (!r.scorable) return;
    g.total++;
    if (r.choice) { g.attempted++; g.ms += r.ms; if (r.correct) g.correct++; else { g.wrong++; if (r.conf === 'high') g.highWrong++; } } else g.unanswered++;
  });
  return order.map(function (k) { var g = m[k]; g.acc = g.attempted ? g.correct / g.attempted : null; g.lost = g.wrong + g.unanswered; return g; });
}
function bars(groups, scored, sortBy) {
  if (!groups.length) return '<p class="muted">Nothing to show yet.</p>';
  var g = groups.slice();
  if (sortBy === 'acc') g.sort(function (a, b) { return (a.acc == null ? 2 : a.acc) - (b.acc == null ? 2 : b.acc); });
  else g.sort(function (a, b) { return b.total - a.total; });
  return g.map(function (x) {
    var v = scored ? (x.acc == null ? 0 : Math.round(x.acc * 100)) : pct(x.attempted, x.total);
    var lab = scored ? (x.acc == null ? 'no attempts' : v + '% accuracy') : v + '% answered';
    return '<div class="barrow"><div class="barline"><span>' + esc(x.name) + ' <small class="muted">(' + x.attempted + '/' + x.total + ' answered' + (scored ? ', ' + x.correct + ' correct' : '') + ')</small></span><b>' + lab + '</b></div><div class="bar"><i class="' + (scored ? '' : 'lav') + '" style="width:' + v + '%"></i></div></div>';
  }).join('');
}

/* ───────────────────────── views ───────────────────────── */
function icon(name) {
  var p = { home: '<path d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>', exam: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>', report: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>', flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>' };
  return '<svg viewBox="0 0 24 24" aria-hidden="true">' + p[name] + '</svg>';
}
function stats(items) { return items.map(function (i) { return '<div class="stat"><small>' + esc(i[0]) + '</small><b>' + esc(i[1]) + '</b></div>'; }).join(''); }
function backupNudge() {
  var a = answeredCount(); if (!a) return '';
  var since = a - (meta.answeredAtBackup || 0), age = meta.lastBackupAt ? Date.now() - meta.lastBackupAt : Infinity;
  if (since >= 20 || (since > 0 && age > 3 * 864e5)) return '<div class="note"><b>Back up your progress.</b> ' + (meta.lastBackupAt ? since + ' answers since your last backup file (' + fmtDate(meta.lastBackupAt) + ').' : 'You have not made a backup file yet.') + ' <button class="btn sm" data-act="export" style="margin-left:6px">Back up now</button></div>';
  return '';
}
function installTip() {
  if (IS_ARTIFACT || isStandalone() || lsGet(APP.dismissKey) === '1') return '';
  return '<div class="note lav"><b>Using Safari?</b> Add this app to your Home Screen (Share → Add to Home Screen) and always start your exam from that icon. On iPhone, the Home Screen app and Safari keep <em>separate</em> storage, so progress made in one will not appear in the other. <button class="btn sm" data-act="dismiss-tip" style="margin-left:6px">Got it</button></div>';
}

function renderHome() {
  var a = answeredCount(), rem = MAXSCORE - a, last = sessions.slice().reverse().slice(0, 6);
  var resumeLbl = submitted() ? 'View my results →' : (a || meta.activeMs ? 'Resume exam at Q' + (idx + 1) + ' →' : 'Start exam →');
  $('#screen').innerHTML =
    (Store.notice ? '<div class="note lav">' + esc(Store.notice) + '</div>' : '') +
    (Store.mode === 'memory' ? '<div class="note err"><b>Progress is not being saved here.</b> This browser is blocking storage' + (IS_ARTIFACT ? ' inside this Claude view' : '') + '. Use Settings → Back up progress before you leave, or use the installed app.</div>' : '') +
    '<div class="stack">' + installTip() + backupNudge() +
    '<div class="card hero"><span class="pill">BASELINE 01</span><h1 style="margin:12px 0 8px">300 questions. Your pace.<br><span style="color:var(--rose)">Discover where you stand.</span></h1>' +
    '<p class="muted">A calm, distraction-free space to understand your clinical strengths and blind spots. Pause whenever you need. Every answer is saved on this device the moment you tap it.</p>' +
    '<div class="grid" style="margin:16px 0">' + stats([['Questions', N], ['Answered', a], ['Remaining', rem < 0 ? 0 : rem], ['Study time', fmt(meta.activeMs)]]) + '</div>' +
    '<div class="meter" style="margin:0 0 16px"><div style="width:' + pct(a, MAXSCORE) + '%"></div></div>' +
    '<div class="row"><button class="btn primary" data-act="' + (submitted() ? 'tab' : 'resume') + '" data-v="' + (submitted() ? 'report' : 'exam') + '">' + resumeLbl + '</button><button class="btn" data-act="tab" data-v="settings">Question bank &amp; settings</button></div>' +
    '<p class="muted small" style="margin:12px 0 0">' + N + ' questions loaded · ' + (N - UNSCORABLE_LIST.length) + ' answerable · stored in ' + esc(Store.mode) + '</p></div>' +
    (last.length ? '<div class="card"><h3>Session history</h3><p class="muted small">Each time you open the exam and work on it counts as one session.</p><div class="tablewrap"><table><thead><tr><th>Started</th><th>Active time</th><th>Answered in session</th></tr></thead><tbody>' +
      last.map(function (s) { return '<tr><td>' + fmtDate(s.startedAt) + '</td><td>' + fmt(s.activeMs) + '</td><td>' + Math.max(0, s.answeredEnd - s.answeredStart) + '</td></tr>'; }).join('') + '</tbody></table></div></div>' : '') +
    '<div class="card"><h3>Your study workflow</h3><div class="dash" style="margin-top:12px"><div><strong>Bring your focus</strong><span>All 300 questions are already loaded. 19 mention a diagram: the text is included, the original figure is not.</span></div><div><strong>Make it manageable</strong><span>Answer a few questions, flag uncertainties, set a session goal, and pause without a ticking deadline.</span></div><div><strong>Learn from the result</strong><span>Submit once, when you are done, to unlock your score, subject patterns and confidence insights.</span></div></div>' +
    '<div class="note">This is a diagnostic practice tool, not an official FMGE exam. The source\'s editorial answer key has not been independently medical-fact-checked.</div></div></div>';
}

function goalText() {
  var g = meta.goal; if (!g) return 'No session target set';
  var done = Math.max(0, answeredCount() - g.startCount);
  return done + ' / ' + g.target + ' new answers toward your session goal' + (done >= g.target ? ' ✓' : '');
}
function updateGoalText() { var el = $('#goalText'); if (el) el.textContent = goalText(); }

function renderExam() {
  $('#screen').innerHTML =
    '<div class="exam"><div class="stack">' +
    '<div class="banner"><span><strong>Focus mode</strong> · saves automatically · <span id="goalText">' + esc(goalText()) + '</span></span><button class="btn sm" data-act="goal">Set session goal</button></div>' +
    '<div class="tools"><button class="btn sm opennav" data-act="navopen">☰ Navigator <span class="num" id="navCount"></span></button><button class="btn sm" data-act="pause" id="pauseBtn">Pause</button><span class="timer" id="timer">Active ' + fmt(meta.activeMs) + '</span></div>' +
    '<div id="qcard" class="card"></div>' +
    '<div class="card"><details><summary style="cursor:pointer;font-weight:700;min-height:28px">Original question paper (online)</summary><p class="muted small" style="margin-top:8px">Diagrams and images from the source paper are not stored in this app. Open the source PDF at this question\'s approximate page. This link needs an internet connection.</p><a class="btn sm" id="pdfLink" target="_blank" rel="noopener" href="#">Open source PDF ↗</a></details></div>' +
    '<div class="card mobonly"><div class="row"><button class="btn" data-act="savepause">Save &amp; pause</button>' + (submitted() ? '' : '<button class="btn primary" data-act="submit">Review &amp; submit…</button>') + '</div></div></div>' +
    '<aside class="navpanel' + (navOpen ? ' open' : '') + '" id="navpanel"><div class="card">' +
    '<div class="row" style="justify-content:space-between"><b>Question navigator</b><span class="row"><span class="muted num" id="count"></span><button class="btn sm closeonly" data-act="navclose">Close</button></span></div>' +
    '<div class="meter" style="margin-top:12px"><div id="examProgress"></div></div>' +
    '<div class="fields two" style="margin-top:12px"><select id="filter" aria-label="Filter questions" data-field="filter"><option value="all">All questions</option><option value="unanswered">Unanswered</option><option value="flagged">Marked</option><option value="answered">Answered</option></select>' +
    '<select id="jumpSection" aria-label="Jump to section" data-field="section"><option value="0">All sections</option><option value="1">Pre-clinical</option><option value="51">Para-clinical</option><option value="121">Clinical medicine</option><option value="201">Surgery &amp; specialties</option></select></div>' +
    '<div class="qgrid" id="qgrid"></div>' +
    '<div class="legend"><span><b style="background:var(--blush-2);border:1px solid #e6b6c9"></b>Answered</span><span><b style="background:var(--peach-d);border-radius:50%"></b>Marked</span><span><b style="outline:2px solid var(--lav)"></b>Current</span><span><b style="border:1px dashed #b0a0aa"></b>Unanswerable</span></div>' +
    '</div><div class="card" style="margin-top:16px"><h3>End this session</h3><p class="muted small">You can close the app right now. Everything is already saved on this device.</p><div class="row"><button class="btn" data-act="savepause">Save &amp; pause</button><button class="btn" data-act="tab" data-v="report">Progress analytics</button>' + (submitted() ? '' : '<button class="btn primary" data-act="submit">Review &amp; submit…</button>') + '</div></div></aside></div>';
  $('#filter').value = navFilter;
  renderQuestion(); renderNav();
}

function renderQuestion() {
  var q = Q[idx], n = q.n, e = entry(n), sub = submitted(), rv = sub && REVIEW ? REVIEW[n] : null, un = !!UNSCORABLE[n];
  var card = $('#qcard'); if (!card) return;
  var changed = renderQuestion.last !== idx; renderQuestion.last = idx;
  var pb = $('#pauseBtn'); if (pb) pb.textContent = paused ? 'Resume' : 'Pause';
  var pl = $('#pdfLink'); if (pl) pl.href = BANK.source.url + '#page=' + ((q.page || 0) + 1);
  if (paused && !sub) {
    card.innerHTML = '<div class="paused"><h2>Paused</h2><p>The question is hidden and your timer is stopped. Your progress is saved.</p><button class="btn primary" data-act="pause">Resume exam</button></div>';
    return;
  }
  var subjOpts = SUBJECTS.map(function (x) { return '<option' + ((e.subject || q.subject) === x ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('');
  var kindOpts = KINDS.map(function (x) { return '<option' + ((e.kind || q.kind) === x ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('');
  var choices = un ? '<div class="note err"><b>Options missing in the source data.</b> Question ' + n + ' has no answer options, so it cannot be answered. It is excluded from scoring (maximum score ' + MAXSCORE + ').</div>' :
    '<div class="choices" role="radiogroup" aria-label="Answer choices">' + OPT.map(function (a) {
      var cls = e.choice === a ? ' selected' : '', extra = '';
      if (sub && rv) { if (a === rv.key) { cls = ' correct'; extra = '<small>✓ Correct answer' + (e.choice === a ? ' · your answer' : '') + '</small>'; } else if (e.choice === a) { cls = ' wrong'; extra = '<small>✗ Your answer</small>'; } else cls = ''; }
      return '<button class="choice' + cls + '" data-act="answer" data-v="' + a + '" role="radio" aria-checked="' + (e.choice === a) + '"' + (sub ? ' disabled' : '') + '><span class="letter">' + a + '</span><span>' + esc(q.options[a]) + extra + '</span></button>';
    }).join('') + '</div>';
  var last = idx === N - 1;
  card.className = 'card' + (changed ? ' qenter' : '');
  card.innerHTML =
    '<div class="qhead"><span class="tag">Question ' + n + ' / ' + N + '</span><span class="tag lav">' + esc(e.subject || q.subject) + '</span><span class="tag peach">' + esc(e.kind || q.kind) + '</span></div>' +
    '<h2 class="stem">' + esc(q.stem) + '</h2>' +
    (figureQ(q) ? '<div class="note lav small">This question refers to a diagram. Its text is included here; the original figure is not stored in the app (see the source PDF link below).</div>' : '') +
    choices +
    '<div class="qnav"><button class="btn" data-act="prev"' + (idx === 0 ? ' disabled' : '') + '>← Previous</button>' + (sub || un ? '<span></span>' : '<button class="btn mid" data-act="clear">Clear</button>') +
    (last && !sub ? '<button class="btn primary" data-act="submit">Review &amp; submit</button>' : '<button class="btn primary" data-act="next"' + (last ? ' disabled' : '') + '>Next →</button>') + '</div>' +
    (sub && rv ? '<details class="explain" open><summary>Source explanation</summary><p>' + esc(rv.explanation) + '</p></details>' : '') +
    '<div class="divider"></div>' +
    '<div class="row" style="justify-content:space-between;align-items:flex-end"><div><span class="lbl">Confidence</span><div class="seg" role="group" aria-label="Confidence">' + ['high', 'medium', 'low'].map(function (k) { return '<button class="' + (e.confidence === k ? 'on ' : '') + k + '" data-act="conf" data-v="' + k + '"' + (sub ? ' disabled' : '') + ' aria-pressed="' + (e.confidence === k) + '">' + (k === 'low' ? 'Low' : CONF[k]) + '</button>'; }).join('') + '</div></div>' +
    '<button class="flag' + (e.flag ? ' on' : '') + '" data-act="flag" aria-pressed="' + !!e.flag + '"' + (sub ? ' disabled' : '') + '>' + icon('flag') + (e.flag ? 'Marked for review' : 'Mark for review') + '</button></div>' +
    '<div class="fields two" style="margin-top:14px"><div><label class="lbl" for="subject">Subject</label><select id="subject" data-field="subject"' + (sub ? ' disabled' : '') + '>' + subjOpts + '</select></div><div><label class="lbl" for="kind">Type</label><select id="kind" data-field="kind"' + (sub ? ' disabled' : '') + '>' + kindOpts + '</select></div></div>' +
    '<div style="margin-top:12px"><label class="lbl" for="topic">Topic (optional — enables topic-wise analytics)</label><input type="text" id="topic" data-field="topic" maxlength="120" autocomplete="off" placeholder="e.g. Brachial plexus" value="' + esc(e.topic || '') + '"' + (sub ? ' disabled' : '') + '></div>' +
    '<div style="margin-top:12px"><label class="lbl" for="notes">Notes</label><textarea id="notes" data-field="notes" placeholder="Quick thought, why you guessed, topic to revise…"' + (sub ? ' disabled' : '') + '>' + esc(e.notes || '') + '</textarea></div>' +
    '<div class="kbd">Shortcuts: <kbd>1</kbd>–<kbd>4</kbd> select · <kbd>←</kbd> <kbd>→</kbd> navigate · <kbd>F</kbd> mark</div>';
}

function cellState(r, n) { return ''; }
function renderNav() {
  var grid = $('#qgrid'); if (!grid) return;
  var a = answeredCount(); $('#count').textContent = a + '/' + MAXSCORE; $('#examProgress').style.width = pct(a, MAXSCORE) + '%';
  var nc = $('#navCount'); if (nc) nc.textContent = a + '/' + MAXSCORE;
  var html = '';
  for (var j = 0; j < N; j++) {
    var e = answers[j + 1] || {}, un = !!UNSCORABLE[j + 1];
    if (navFilter === 'answered' && !e.choice) continue; if (navFilter === 'unanswered' && (e.choice || un)) continue; if (navFilter === 'flagged' && !e.flag) continue;
    var cls = '';
    if (submitted() && REVIEW && e.choice) cls += REVIEW[j + 1].key === e.choice ? ' ok' : ' bad'; else if (e.choice) cls += ' answered';
    if (e.flag) cls += ' flagged'; if (idx === j) cls += ' current'; if (un) cls += ' skip';
    html += '<button class="' + cls.trim() + '" data-act="jump" data-v="' + j + '" aria-label="Question ' + (j + 1) + (e.choice ? ', answered' : un ? ', unanswerable' : ', unanswered') + (e.flag ? ', marked' : '') + '"' + (idx === j ? ' aria-current="true"' : '') + '>' + (j + 1) + '</button>';
  }
  grid.innerHTML = html || '<span class="muted">No matches</span>';
}

function renderReport() {
  var rows = computeRows(), sub = submitted() && !!REVIEW, a = rows.filter(function (r) { return r.choice; });
  var correct = sub ? a.filter(function (r) { return r.correct; }).length : 0, wrong = a.length - correct, unans = MAXSCORE - a.length;
  var bySubj = group(rows.filter(function (r) { return r.subject !== 'Unmapped'; }), function (r) { return r.subject; });
  var mapped = rows.filter(function (r) { return r.subject !== 'Unmapped'; }).length, topics = rows.filter(function (r) { return r.topic; }).length;
  var klass = group(rows, function (r) { return r.klass; }), kinds = group(rows, function (r) { return r.kind; });
  var task = group(rows, function (r) { return r.task; }), taskClassified = rows.filter(function (r) { return r.task !== 'Not classified'; }).length;
  var sect = group(rows, function (r) { return r.q.section; });
  var conf = group(rows, function (r) { return r.conf || 'Not rated'; });
  var html = '<div class="stack">';

  html += '<div class="card"><div class="row" style="justify-content:space-between;align-items:flex-start"><div><span class="pill">BASELINE REPORT</span><h1 style="margin:10px 0 4px;font-size:30px">Your performance</h1></div>' +
    '<div class="row"><button class="btn sm" data-act="csv">Export report CSV</button><button class="btn sm" data-act="export">Back up progress</button>' + (submitted() ? '' : '<button class="btn sm primary" data-act="submit">Review &amp; submit…</button>') + '</div></div>' +
    '<div class="note ' + (sub ? 'lav' : '') + '">' + (!submitted() ? 'Exam in progress. Scores and correctness stay hidden until you submit. Coverage and time are shown below.' : sub ? 'Submitted ' + fmtDate(meta.submittedAt) + '. Accuracy is based on the source paper\'s answer key, which has not been independently fact-checked.' : 'Submitted, but the answer key could not be loaded. <button class="btn sm" data-act="reloadkey">Retry</button>') + '</div>' +
    '<div class="grid">' + (sub ? stats([['Score', correct + ' / ' + N], ['Accuracy (attempted)', pct(correct, a.length) + '%'], ['Answered', a.length + ' / ' + MAXSCORE], ['Unanswered', unans]]) :
      stats([['Answered', a.length + ' / ' + MAXSCORE], ['Unanswered', unans], ['Marked', flaggedCount()], ['Study time', fmt(meta.activeMs)]])) + '</div>' +
    (sub ? '<div class="grid" style="margin-top:10px">' + stats([['Incorrect', wrong], ['Marked', flaggedCount()], ['Study time', fmt(meta.activeMs)], ['Low confidence', a.filter(function (r) { return r.conf === 'low'; }).length]]) + '</div>' : '') +
    (UNSCORABLE_LIST.length ? '<p class="muted small" style="margin-top:10px">Q' + UNSCORABLE_LIST.join(', Q') + ' has no option text in the source data. It cannot be answered, scores 0, and is left out of every percentage (maximum realistic score ' + MAXSCORE + ').</p>' : '') + '</div>';

  html += '<div class="card"><h3>Data completeness</h3><p class="muted small">Missing classifications are reported here, not guessed.</p><ul class="tight">' +
    '<li>Subject mapped: <b>' + mapped + ' / ' + N + '</b></li>' +
    '<li>Topic mapped: <b>' + topics + ' / ' + N + '</b>' + (topics ? '' : ' · the question bank has no topic field. Add topics yourself under each question to enable topic-wise analytics.') + '</li>' +
    '<li>Question type tagged: <b>' + N + ' / ' + N + '</b> (from the source mapping, editable)</li>' +
    '<li>Diagnosis / management / investigation: <b>' + taskClassified + ' / ' + N + '</b> detected from question wording (heuristic). The rest are shown as “Not classified”.</li>' +
    '<li>Questions mentioning a diagram without the figure: <b>' + rows.filter(function (r) { return figureQ(r.q); }).length + '</b></li></ul></div>';

  html += '<div class="card"><h3>Subject-wise performance</h3><p class="muted small">Untagged (“Unmapped”) questions are excluded. ' + (sub ? 'Weakest first.' : 'Showing answer coverage until you submit.') + '</p>' + bars(bySubj, sub, sub ? 'acc' : 'count') + '</div>';

  if (sub) {
    var ranked = bySubj.filter(function (g) { return g.attempted >= 3; }).sort(function (x, y) { return x.acc - y.acc || y.attempted - x.attempted; });
    var weak = ranked.slice(0, 3), strong = ranked.slice().reverse().slice(0, 3);
    html += '<div class="card"><h3>Strongest and weakest subjects</h3><p class="muted small">Needs at least 3 attempted questions in a subject to be ranked.</p><div class="cols two">' +
      '<div class="mini"><h4>Weakest</h4>' + (weak.length ? '<ul class="tight">' + weak.map(function (g) { return '<li>' + esc(g.name) + ' — ' + Math.round(g.acc * 100) + '% (' + g.correct + '/' + g.attempted + ')</li>'; }).join('') + '</ul>' : '<span class="muted">Not enough attempts.</span>') + '</div>' +
      '<div class="mini"><h4>Strongest</h4>' + (strong.length ? '<ul class="tight">' + strong.map(function (g) { return '<li>' + esc(g.name) + ' — ' + Math.round(g.acc * 100) + '% (' + g.correct + '/' + g.attempted + ')</li>'; }).join('') + '</ul>' : '<span class="muted">Not enough attempts.</span>') + '</div></div></div>';

    var pri = bySubj.slice().sort(function (x, y) { return y.lost - x.lost || (x.acc == null ? 0 : x.acc) - (y.acc == null ? 0 : y.acc); }).filter(function (g) { return g.lost > 0; }).slice(0, 6);
    html += '<div class="card"><h3>Recommended revision priorities</h3><p class="muted small">Ranked by marks lost (incorrect + unanswered) in each subject. Overconfident errors are wrong answers you rated High confidence.</p>' +
      (pri.length ? '<ol class="tight" style="padding-left:22px">' + pri.map(function (g) { return '<li><b>' + esc(g.name) + '</b> — ' + g.lost + ' marks lost (' + g.wrong + ' incorrect, ' + g.unanswered + ' unanswered' + (g.highWrong ? ', ' + g.highWrong + ' overconfident' : '') + '), accuracy ' + (g.acc == null ? 'n/a' : Math.round(g.acc * 100) + '%') + '</li>'; }).join('') + '</ol>' : '<p class="muted">No marks lost.</p>') + '</div>';
  }

  html += '<div class="card"><h3>Topic-wise performance</h3>' + (topics ? '<p class="muted small">Based on the ' + topics + ' question' + (topics === 1 ? '' : 's') + ' you tagged with a topic.</p>' + bars(group(rows.filter(function (r) { return r.topic; }), function (r) { return r.topic; }), sub, 'acc') : '<div class="note"><b>Topic mapping is incomplete (0 / ' + N + ').</b> The source question bank has no topic field and none was invented. Type a topic under any question to start building this view.</div>') + '</div>';

  html += '<div class="card"><h3>Clinical vs theoretical</h3><p class="muted small">Grouped from each question\'s type tag.</p>' + bars(klass, sub, 'count') + '<h4>By question type</h4>' + bars(kinds, sub, 'count') + '</div>';
  html += '<div class="card"><h3>Diagnosis vs management vs investigation</h3><div class="note">Detected from question wording only (' + taskClassified + ' / ' + N + ' classified). Treat as indicative, not complete.</div>' + bars(task, sub, 'count') + '</div>';
  html += '<div class="card"><h3>By exam section</h3>' + bars(sect, sub, 'count') + '</div>';

  /* confidence */
  var ids = { high: 'High', medium: 'Medium', low: 'Low / guessed' };
  var cf = ['high', 'medium', 'low'].map(function (k) { var g = group(rows, function (r) { return r.conf === k ? ids[k] : ''; })[0]; return g || { name: ids[k], total: 0, attempted: 0, correct: 0, wrong: 0, unanswered: 0, acc: null, highWrong: 0 }; });
  var unrated = a.filter(function (r) { return !r.conf; }).length;
  html += '<div class="card"><h3>Confidence calibration</h3>';
  if (!sub) {
    html += '<p class="muted small">After submission this compares how sure you felt with how often you were right.</p>' + bars(conf, false, 'count');
  } else {
    var ok = cf[0].attempted >= 3 && cf[1].attempted >= 3 && cf[2].attempted >= 3 && cf[0].acc >= cf[1].acc && cf[1].acc >= cf[2].acc;
    html += '<div class="tablewrap"><table><thead><tr><th>Confidence</th><th>Attempted</th><th>Correct</th><th>Accuracy</th></tr></thead><tbody>' + cf.map(function (g) { return '<tr><td>' + esc(g.name) + '</td><td>' + g.attempted + '</td><td>' + g.correct + '</td><td>' + (g.acc == null ? '—' : Math.round(g.acc * 100) + '%') + '</td></tr>'; }).join('') + '<tr><td>Not rated</td><td colspan="3">' + unrated + ' attempted</td></tr></tbody></table></div>' +
      '<ul class="tight"><li>Overconfident errors (High confidence, wrong): <b>' + cf[0].wrong + '</b></li><li>Shaky or lucky (Low confidence, correct): <b>' + cf[2].correct + '</b></li></ul>' +
      '<div class="note lav">' + (ok ? 'Your confidence tracks your accuracy: High ≥ Medium ≥ Low.' : (cf[0].attempted < 3 || cf[1].attempted < 3 || cf[2].attempted < 3) ? 'Too few rated answers in at least one level (need 3 each) to judge calibration. Rate your confidence on more questions next time.' : 'Your confidence does not consistently track accuracy (High, Medium and Low are not in descending order). Slow down on questions you feel sure about.') + '</div>';
  }
  html += '</div>';

  /* time */
  var timed = a.filter(function (r) { return r.ms > 0; });
  html += '<div class="card"><h3>Time per question</h3>';
  if (!timed.length) html += '<p class="muted">No per-question timing recorded yet. Time counts while a question is on screen and the timer is running.</p>';
  else {
    var avg = function (l) { return l.length ? fmt(l.reduce(function (s, r) { return s + r.ms; }, 0) / l.length) : '—'; };
    html += '<div class="grid">' + stats([['Average / question', avg(timed)], ['Questions timed', timed.length + ' / ' + a.length]].concat(sub ? [['Avg · correct', avg(timed.filter(function (r) { return r.correct; }))], ['Avg · incorrect', avg(timed.filter(function (r) { return r.correct === false; }))]] : [])) + '</div>' +
      '<h4>Slowest questions</h4><ul class="tight">' + timed.slice().sort(function (x, y) { return y.ms - x.ms; }).slice(0, 5).map(function (r) { return '<li><button class="btn sm" data-act="jumpexam" data-v="' + (r.n - 1) + '">Q' + r.n + '</button> ' + fmt(r.ms) + ' · ' + esc(r.subject) + '</li>'; }).join('') + '</ul>';
  }
  html += '</div>';

  /* review list */
  if (sub) {
    var filters = [['incorrect', 'Incorrect'], ['unanswered', 'Unanswered'], ['marked', 'Marked'], ['overconf', 'Overconfident errors'], ['shaky', 'Shaky correct'], ['all', 'All attempted']];
    var list = rows.filter(function (r) {
      if (!r.scorable) return false;
      switch (reviewFilter) { case 'incorrect': return r.choice && !r.correct; case 'unanswered': return !r.choice; case 'marked': return r.flag; case 'overconf': return r.choice && !r.correct && r.conf === 'high'; case 'shaky': return r.correct && r.conf === 'low'; default: return !!r.choice; }
    });
    html += '<div class="card"><h3>Incorrect-answer analysis</h3><div class="chips">' + filters.map(function (f) { return '<button class="' + (reviewFilter === f[0] ? 'on' : '') + '" data-act="rfilter" data-v="' + f[0] + '">' + f[1] + '</button>'; }).join('') + '</div>' +
      '<p class="muted small">' + list.length + ' question' + (list.length === 1 ? '' : 's') + '</p>' +
      list.slice(0, reviewLimit).map(function (r) {
        return '<div class="review"><div class="row"><b>Q' + r.n + '</b><span class="tag lav">' + esc(r.subject) + '</span><span class="pill ' + (r.choice ? (r.correct ? 'lav' : 'red') : 'peach') + '">' + (r.choice ? (r.correct ? '✓ Correct' : '✗ Incorrect') : 'Unanswered') + '</span>' + (r.conf ? '<span class="tag">' + esc(CONF[r.conf]) + '</span>' : '') + '<span class="spacer"></span><button class="btn sm" data-act="jumpexam" data-v="' + (r.n - 1) + '">Open</button></div>' +
          '<p style="margin:8px 0 4px">' + esc(r.q.stem.length > 260 ? r.q.stem.slice(0, 260) + '…' : r.q.stem) + '</p>' +
          '<p class="muted small" style="margin:0">You: <b>' + (r.choice ? r.choice + '. ' + esc(r.q.options[r.choice]) : '—') + '</b><br>Key: <b>' + r.key + '. ' + esc(r.q.options[r.key]) + '</b></p>' +
          (r.notes ? '<p class="muted small" style="margin:6px 0 0">Your note: ' + esc(r.notes) + '</p>' : '') +
          '<details class="explain"><summary>Source explanation</summary><p>' + esc(r.explanation) + '</p></details></div>';
      }).join('') + (list.length > reviewLimit ? '<button class="btn" data-act="rmore" style="width:100%">Show more (' + (list.length - reviewLimit) + ' left)</button>' : '') + '</div>';
  }
  html += '</div>';
  $('#screen').innerHTML = html;
}

function renderSettings() {
  var bankBad = Q.filter(function (q) { return !hasOptions(q); }).map(function (q) { return q.n; });
  var consec = Q.every(function (q, i) { return q.n === i + 1; });
  $('#screen').innerHTML = '<div class="stack">' +
    (IS_ARTIFACT ? '<div class="note lav"><b>You are using the Claude Artifact version.</b> Your progress is stored only in this browser, for this artifact, in this viewer. It does not sync between devices or to Claude, it can come back empty (private windows, cleared site data, some embedded views), and file downloads are disabled here, so backups are shown as text you copy. For a durable, installable copy, use the PWA.</div>' : '') +
    '<div class="card"><h2>Storage &amp; progress</h2><div class="grid" style="margin:12px 0">' + stats([['Storage', Store.mode], ['Last saved', saveState.at ? fmtTime(saveState.at) : '—'], ['Answers stored', answeredCount()], ['Last backup', meta.lastBackupAt ? fmtDate(meta.lastBackupAt).split(',')[0] : 'Never']]) + '</div>' +
    '<ul class="tight small muted"><li>Persistent storage: <b id="persistState">' + (Store.persisted === true ? 'granted' : Store.persisted === false ? 'not granted (the browser may clear data under storage pressure)' : 'not requested yet') + '</b></li>' +
    '<li>Installed as an app: <b>' + (IS_ARTIFACT ? 'n/a (Claude view)' : isStandalone() ? 'yes' : 'no — running in a browser tab') + '</b></li><li id="quota"></li></ul>' +
    '<div class="note"><b>Browser storage is not permanent.</b> Clearing website data, “Offline website data”, deleting the app, switching Safari ↔ Home Screen app, or changing this site\'s web address can erase your progress. Export a backup file regularly and keep it somewhere safe (Files, iCloud, email to yourself).</div></div>' +
    '<div class="card"><h3>Back up &amp; restore</h3><p class="muted small">The backup contains all answers, marks, confidence ratings, notes, topics, timing and session history. It does not contain the question bank.</p>' +
    '<div class="row"><button class="btn primary" data-act="export">Back up progress (JSON)</button><button class="btn" data-act="csv">Download question-level CSV</button></div>' +
    '<h4>Restore from a backup</h4><div class="row"><label class="btn" for="restoreFile" style="cursor:pointer">Choose backup file…</label><input id="restoreFile" type="file" accept="application/json,.json,text/plain" data-field="restore" style="position:absolute;opacity:0;width:1px;height:1px"></div>' +
    '<label class="lbl" for="pasteBackup" style="margin-top:12px">…or paste backup text</label><textarea id="pasteBackup" placeholder="Paste the JSON here" style="min-height:70px"></textarea><div class="row" style="margin-top:8px"><button class="btn sm" data-act="pastecheck">Check pasted backup</button></div></div>' +
    '<div class="card"><h3>Safety copies &amp; reset</h3><p class="muted small">A safety copy is saved automatically before every import, reset and submission.</p><div class="row"><button class="btn" data-act="safety">Restore last safety copy…</button><button class="btn danger" data-act="reset">Erase this baseline…</button></div></div>' +
    '<div class="card"><h3>Question bank check</h3><ul class="tight small"><li>Questions loaded: <b>' + N + '</b>' + (consec ? ' (numbered 1–' + N + ')' : ' — numbering irregular') + '</li><li>Questions with four options: <b>' + (N - bankBad.length) + ' / ' + N + '</b>' + (bankBad.length ? ' — missing in source: <b>Q' + bankBad.join(', Q') + '</b> (excluded from scoring)' : '') + '</li><li>Answer key: sealed until you submit (loaded on demand)</li><li>Source: ' + esc(BANK.source.name) + '</li></ul>' +
    (IS_ARTIFACT ? '' : '<h4>Install on iPhone</h4><ol class="tight small"><li>Open this page in Safari (not inside another app).</li><li>Tap Share → <b>Add to Home Screen</b> → Add.</li><li>Close Safari and start from the new icon.</li></ol>') + '</div>' +
    '<div class="card"><h3>About</h3><p class="muted small">FMGE / BASELINE · Blush Edition · app v' + APP.version + ' · question bank v' + BANK.version + ' · data schema ' + APP.idbVersion + '. Independent study tool.</p></div></div>';
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(function (est) { var q = $('#quota'); if (q && est) q.innerHTML = 'Space used by this app: <b>' + (est.usage / 1024).toFixed(0) + ' KB</b> of about ' + Math.round(est.quota / 1048576) + ' MB available'; }).catch(function () {});
}

var SCREENS = { home: renderHome, exam: renderExam, report: renderReport, settings: renderSettings };
function render(anim) {
  var s = $('#screen'); if (!s) return;
  s.className = 'screen' + (anim ? ' enter' : '');
  SCREENS[screenName]();
  [].forEach.call(document.querySelectorAll('[data-tab]'), function (b) { var on = b.dataset.tab === screenName; b.classList.toggle('active', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  renderSaveChip(); syncClock();
}
function setScreen(s) {
  if (screenName === 'exam') { accumulate(); flush(); }
  screenName = s; navOpen = false; paused = false;
  if (s === 'report' && submitted() && !REVIEW) loadReview().then(function () { if (screenName === 'report') render(); }).catch(function () {});
  render(true); window.scrollTo(0, 0);
}

/* ───────────────────────── CSV ───────────────────────── */
function csvCell(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }
function buildCsv() {
  var rows = computeRows(), sub = submitted() && !!REVIEW;
  var out = [['Question', 'Section', 'Subject', 'Type', 'Topic', 'Chosen', 'Confidence', 'Marked', 'Seconds on question', 'Correct answer (after submission)', 'Correct (after submission)', 'Notes', 'Question preview']];
  rows.forEach(function (r) { out.push([r.n, r.q.section, r.subject, r.kind, r.topic, r.choice || '', r.conf, r.flag, Math.round(r.ms / 1000), sub ? r.key : '', sub && r.choice && r.scorable ? (r.correct ? 'Yes' : 'No') : '', r.notes, r.q.stem]); });
  return out.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
}
function download(name, content, mime) {
  var a = document.createElement('a'), url = URL.createObjectURL(new Blob([content], { type: mime }));
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
}
function copyText(text, el) {
  var done = function (ok) { toast(ok ? 'Copied to clipboard' : 'Copy blocked — select the text and copy manually'); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); }); else fallback();
  function fallback() { try { el.focus(); el.select(); el.setSelectionRange(0, text.length); done(document.execCommand('copy')); } catch (e) { done(false); } }
}

/* ───────────────────────── dialogs ───────────────────────── */
function dlgExport() {
  var text = JSON.stringify(buildBackup(), null, 2), name = 'fmge-baseline-backup-' + stamp() + '.json';
  var file = null; try { file = new File([text], name, { type: 'application/json' }); } catch (e) {}
  var canShare = !IS_ARTIFACT && file && navigator.canShare && navigator.canShare({ files: [file] });
  var body = '<p class="muted small">' + answeredCount() + ' answers · ' + (text.length / 1024).toFixed(0) + ' KB. ' + (IS_ARTIFACT ? 'Downloads are disabled in Claude artifacts: copy this text and save it in a note or file.' : 'Save the file somewhere outside this app (Files, iCloud Drive, email).') + '</p><textarea class="code" id="backupText" readonly spellcheck="false"></textarea>';
  var btns = [{ label: 'Copy backup text', cls: 'primary', onClick: function () { copyText(text, $('#backupText')); noteBackup(); } }];
  if (!IS_ARTIFACT) btns.push({ label: 'Download file', onClick: function () { download(name, text, 'application/json'); noteBackup().then(function () { toast('Backup file created'); }); } });
  if (canShare) btns.push({ label: 'Share / Save to Files', onClick: function () { navigator.share({ files: [file], title: 'FMGE Baseline backup' }).then(function () { noteBackup(); }, function () {}); } });
  btns.push({ label: 'Close', onClick: function () { closeModal(); if (screenName !== 'exam') render(); } });
  openModal('Back up your progress', body, btns);
  $('#backupText').value = text;
}
function dlgImport(text) {
  var p; try { p = parseBackup(text); } catch (e) { openModal('Cannot restore this file', '<div class="note err">' + esc(e.message) + '</div>', [{ label: 'OK', onClick: closeModal }]); return; }
  var n = Object.keys(p.answers).filter(function (k) { return p.answers[k].choice; }).length, cur = answeredCount();
  var body = '<ul class="tight"><li>Answers in backup: <b>' + n + '</b> (you currently have <b>' + cur + '</b>)</li><li>Marked: <b>' + Object.keys(p.answers).filter(function (k) { return p.answers[k].flag; }).length + '</b> · Notes: <b>' + Object.keys(p.answers).filter(function (k) { return p.answers[k].notes; }).length + '</b></li><li>Status: <b>' + (p.meta.status === 'submitted' ? 'submitted' : 'in progress') + '</b>' + (p.exportedAt ? ' · exported ' + esc(fmtDate(p.exportedAt)) : '') + '</li><li>Format: ' + esc(p.from) + '</li></ul>' +
    (n < cur ? '<div class="note err"><b>This backup has fewer answers than you have now.</b> Restoring replaces your current progress.</div>' : '') +
    p.warnings.map(function (w) { return '<div class="note">' + esc(w) + '</div>'; }).join('') + '<p class="muted small">A safety copy of your current progress is saved first, so you can undo this.</p>';
  openModal('Restore this backup?', body, [{ label: 'Cancel', onClick: closeModal }, { label: 'Replace my progress', cls: 'primary', onClick: function () {
    safetySnapshot('before-import').then(function () { return replaceAll(p); }).then(function () { closeModal(); toast('Backup restored'); setScreen('home'); }, function (e) { toast('Restore failed: ' + e.message); });
  } }]);
}
function dlgSubmit() {
  var a = answeredCount(), un = [], fl = [];
  for (var i = 1; i <= N; i++) { if (!UNSCORABLE[i] && !(answers[i] && answers[i].choice)) un.push(i); if (answers[i] && answers[i].flag) fl.push(i); }
  var list = function (arr) { return arr.length ? arr.slice(0, 40).map(function (n) { return '<button class="btn sm" data-act="jumpexam-close" data-v="' + (n - 1) + '" style="margin:2px">' + n + '</button>'; }).join('') + (arr.length > 40 ? ' …' : '') : '<span class="muted">none</span>'; };
  openModal('Submit the examination?',
    '<div class="note err"><b>This locks all answers and reveals the score and answer key. It cannot be undone.</b> You can leave the app at any time without submitting.</div>' +
    '<ul class="tight"><li>Answered: <b>' + a + ' / ' + MAXSCORE + '</b></li><li>Unanswered: <b>' + un.length + '</b></li><li>Marked for review: <b>' + fl.length + '</b></li></ul>' +
    '<span class="lbl">Unanswered (tap to go back)</span><div>' + list(un) + '</div><span class="lbl" style="margin-top:10px">Marked</span><div>' + list(fl) + '</div>' +
    '<label class="lbl" for="confirmText" style="margin-top:14px">Type SUBMIT to confirm</label><input type="text" id="confirmText" data-field="confirm" data-word="SUBMIT" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="SUBMIT">',
    [{ label: 'Keep working', cls: 'primary', onClick: closeModal }, { label: 'Submit exam', cls: 'danger solid', disabled: true, onClick: doSubmit }]);
}
function doSubmit() {
  accumulate();
  loadReview().then(function () { return safetySnapshot('before-submit'); }).then(function () {
    meta.status = 'submitted'; meta.submittedAt = Date.now(); running = false; closeModal(true);
    return flush();
  }).then(function () { toast('Exam submitted'); setScreen('report'); }, function (e) { openModal('Could not submit', '<div class="note err">' + esc(e.message) + '</div><p class="muted small">Nothing was changed. Your answers are still saved.</p>', [{ label: 'OK', onClick: closeModal }]); });
}
function dlgReset() {
  openModal('Erase this baseline?', '<div class="note err"><b>This deletes all answers, notes, marks and session history on this device.</b></div><p class="muted small">A safety copy is saved first, and you can restore it from Settings. Export a backup file if you want a copy outside the app.</p><label class="lbl" for="confirmText">Type RESET to confirm</label><input type="text" id="confirmText" data-field="confirm" data-word="RESET" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="RESET">',
    [{ label: 'Cancel', cls: 'primary', onClick: closeModal }, { label: 'Erase everything', cls: 'danger solid', disabled: true, onClick: function () {
      safetySnapshot('before-reset').then(function () { return replaceAll({ meta: freshMeta(), answers: {}, sessions: [] }); }).then(function () { closeModal(); toast('Baseline erased. A safety copy was kept.'); setScreen('home'); });
    } }]);
}
function dlgSafety() {
  latestSafety().then(function (s) {
    if (!s) { openModal('No safety copy yet', '<p>Safety copies are created automatically before an import, reset or submission.</p>', [{ label: 'OK', onClick: closeModal }]); return; }
    var n = Object.keys(s.payload.answers || {}).filter(function (k) { return s.payload.answers[k].choice; }).length;
    openModal('Restore safety copy?', '<ul class="tight"><li>Saved: <b>' + fmtDate(s.createdAt) + '</b> (' + esc(String(s.reason).replace('before-', 'before ')) + ')</li><li>Answers: <b>' + n + '</b> · you have <b>' + answeredCount() + '</b> now</li></ul><p class="muted small">Your current progress is saved as a new safety copy first.</p>',
      [{ label: 'Cancel', onClick: closeModal }, { label: 'Restore it', cls: 'primary', onClick: function () {
        var p; try { p = parseBackup(JSON.stringify(s.payload)); } catch (e) { toast(e.message); return; }
        safetySnapshot('before-restore').then(function () { return replaceAll(p); }).then(function () { closeModal(); toast('Safety copy restored'); setScreen('home'); });
      } }]);
  });
}
function dlgGoal() {
  openModal('Session goal', '<p class="muted small">How many new questions would you like to answer in this session? Leave blank to clear.</p><label class="lbl" for="goalInput">Questions</label><input type="number" inputmode="numeric" id="goalInput" min="1" max="' + N + '" value="' + (meta.goal ? meta.goal.target : 25) + '">',
    [{ label: 'Cancel', onClick: closeModal }, { label: 'Save goal', cls: 'primary', onClick: function () {
      var v = $('#goalInput').value.trim();
      if (v === '') meta.goal = null;
      else { var n = Number(v); if (!Number.isInteger(n) || n < 1 || n > N) { toast('Enter a whole number from 1 to ' + N); return; } meta.goal = { target: n, startCount: answeredCount() }; }
      commit([]); closeModal(); updateGoalText();
    } }]);
}

/* ───────────────────────── events ───────────────────────── */
var ACT = {
  tab: function (t) { setScreen(t.dataset.v); },
  resume: function () { setScreen('exam'); },
  answer: function (t) { answer(t.dataset.v); },
  prev: function () { go(idx - 1); }, next: function () { go(idx + 1); },
  clear: function () { if (!submitted()) { setEntry(idx + 1, { choice: null }); renderQuestion(); renderNav(); updateGoalText(); } },
  conf: function (t) { var v = t.dataset.v, e = entry(idx + 1); setEntry(idx + 1, { confidence: e.confidence === v ? '' : v }); renderQuestion(); },
  flag: function () { setEntry(idx + 1, { flag: !entry(idx + 1).flag }); renderQuestion(); renderNav(); },
  pause: function () { if (paused) { paused = false; } else { accumulate(); paused = true; } syncClock(); renderQuestion(); },
  savepause: function () { setScreen('home'); toast('Saved. You can close the app.'); },
  navopen: function () { navOpen = true; $('#navpanel').classList.add('open'); },
  navclose: function () { navOpen = false; $('#navpanel').classList.remove('open'); },
  jump: function (t) { navOpen = false; var p = $('#navpanel'); if (p) p.classList.remove('open'); go(+t.dataset.v); },
  jumpexam: function (t) { idx = +t.dataset.v; meta.idx = idx; setScreen('exam'); },
  'jumpexam-close': function (t) { closeModal(); idx = +t.dataset.v; meta.idx = idx; setScreen('exam'); },
  goal: dlgGoal, submit: dlgSubmit, export: dlgExport, reset: dlgReset, safety: dlgSafety,
  csv: function () { var t = buildCsv(); if (IS_ARTIFACT) { openModal('Question-level CSV', '<p class="muted small">Downloads are disabled in Claude artifacts. Copy this text into a .csv file.</p><textarea class="code" id="csvText" readonly></textarea>', [{ label: 'Copy CSV', cls: 'primary', onClick: function () { copyText(t, $('#csvText')); } }, { label: 'Close', onClick: closeModal }]); $('#csvText').value = t; } else { download('fmge-baseline-report-' + stamp() + '.csv', t, 'text/csv'); toast('CSV downloaded'); } },
  modal: function (t) { var f = modalActions[t.dataset.v]; if (f) f(); },
  rfilter: function (t) { reviewFilter = t.dataset.v; reviewLimit = 40; renderReport(); },
  rmore: function () { reviewLimit += 40; renderReport(); },
  reloadkey: function () { loadReview().then(function () { render(); }).catch(function (e) { toast(e.message); }); },
  pastecheck: function () { var v = $('#pasteBackup').value.trim(); if (!v) { toast('Paste your backup text first'); return; } dlgImport(v); },
  'dismiss-tip': function () { lsSet(APP.dismissKey, '1'); render(); },
  'reload-update': function () { if (updateReg && updateReg.waiting) { updateReg.waiting.postMessage('SKIP_WAITING'); } }
};
document.addEventListener('click', function (e) {
  var t = e.target.closest('[data-act]'); if (!t || t.disabled) return;
  var f = ACT[t.dataset.act]; if (f) f(t, e);
});
document.addEventListener('click', function (e) { var t = e.target.closest('[data-tab]'); if (t) setScreen(t.dataset.tab); });
document.addEventListener('input', function (e) {
  var f = e.target.dataset && e.target.dataset.field;
  if (f === 'notes') { setEntryQuiet({ notes: e.target.value.slice(0, 5000) }); }
  else if (f === 'topic') { setEntryQuiet({ topic: e.target.value }); }
  else if (f === 'confirm') { var ok = e.target.value.trim().toUpperCase() === e.target.dataset.word; var b = $('#mbtn1'); if (b) b.disabled = !ok; }
});
function setEntryQuiet(patch) {
  if (submitted()) return;
  var n = idx + 1, e = answers[n] || { n: n, choice: null, confidence: '', flag: false, notes: '', topic: '', ms: 0, at: 0 };
  Object.assign(e, patch); e.at = Date.now(); answers[n] = e; dirty[n] = 1; writeMirror(); setSave('saving');
  if (noteTimer) clearTimeout(noteTimer); noteTimer = setTimeout(function () { noteTimer = null; flush(); }, 600);
}
document.addEventListener('change', function (e) {
  var f = e.target.dataset && e.target.dataset.field;
  if (f === 'subject' || f === 'kind') { setEntry(idx + 1, (function () { var o = {}; o[f] = e.target.value; return o; })()); var tags = document.querySelectorAll('.qhead .tag'); if (tags[1] && f === 'subject') tags[1].textContent = e.target.value; if (tags[2] && f === 'kind') tags[2].textContent = e.target.value; }
  else if (f === 'filter') { navFilter = e.target.value; renderNav(); }
  else if (f === 'section') { var n = +e.target.value; if (n) go(n - 1); e.target.value = '0'; navOpen = false; var p = $('#navpanel'); if (p && window.innerWidth < 900) p.classList.remove('open'); }
  else if (f === 'restore') { var file = e.target.files && e.target.files[0]; if (!file) return; file.text().then(function (t) { dlgImport(t); e.target.value = ''; }, function () { toast('Could not read that file'); }); }
});
document.addEventListener('focusout', function (e) { if (e.target.dataset && (e.target.dataset.field === 'notes' || e.target.dataset.field === 'topic')) flush(); });
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && document.querySelector('.overlay')) { closeModal(); return; }
  if (screenName !== 'exam' || e.altKey || e.ctrlKey || e.metaKey || document.querySelector('.overlay') || paused || /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')) return;
  var keys = { 1: 'A', 2: 'B', 3: 'C', 4: 'D' };
  if (keys[e.key]) { e.preventDefault(); answer(keys[e.key]); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); go(idx + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); go(idx - 1); }
  else if (e.key.toLowerCase() === 'f' && !submitted()) { e.preventDefault(); ACT.flag(); }
});
window.addEventListener('online', updateNet); window.addEventListener('offline', updateNet);
function updateNet() { var el = $('#netchip'); if (el) el.hidden = navigator.onLine !== false; }

/* ───────────────────────── service worker ───────────────────────── */
function registerSW() {
  if (IS_ARTIFACT || !('serviceWorker' in navigator)) return;
  if (!(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;
  navigator.serviceWorker.register('./sw.js').then(function (reg) {
    updateReg = reg;
    var show = function () { var b = $('#updateRoot'); if (b) b.innerHTML = '<div class="updatebar"><span>A new version is ready. Your progress is already saved.</span><button class="btn sm" data-act="reload-update">Update now</button></div>'; };
    if (reg.waiting && navigator.serviceWorker.controller) show();
    reg.addEventListener('updatefound', function () { var w = reg.installing; if (w) w.addEventListener('statechange', function () { if (w.state === 'installed' && navigator.serviceWorker.controller) show(); }); });
  }).catch(function (e) { console.warn('SW registration failed', e); });
  var reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () { if (reloading || !updateReg) return; if (updateReg.__userAsked) { reloading = true; location.reload(); } });
  document.addEventListener('click', function (e) { if (e.target.closest('[data-act="reload-update"]') && updateReg) updateReg.__userAsked = true; }, true);
}

/* ───────────────────────── start ───────────────────────── */
function start() {
  boot().then(function () {
    if (!submitted() && (answeredCount() > 0 || meta.activeMs > 0)) screenName = 'exam';
    else if (submitted()) screenName = 'home';
    render(); updateNet(); registerSW();
    if (Store.mode === 'IndexedDB' || Store.mode === 'localStorage') commit([]);
    window.__fmge = { get state() { return { meta: meta, answers: answers, sessions: sessions, mode: Store.mode, idx: idx, paused: paused, screen: screenName }; }, ready: true };
  }).catch(function (e) {
    console.error(e);
    var s = $('#screen'); if (s) s.innerHTML = '<div class="note err"><b>The app could not start.</b> ' + esc(e && e.message) + '</div>';
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
