/* ============================================================
   TCAS70 Progress Tracker  (v1)
   ------------------------------------------------------------
   Retrofit: แปะ <script defer src="tracker.js"></script> ก่อน </body>
             ในหน้า guide ใดก็ได้ที่มี array `problems` + <div id="qlist">
   โมเดล:    self-grade — หลังกด "ดูเฉลย" ผู้เรียนกด ได้ / ไม่ได้
   เก็บข้อมูล: localStorage (key เดียว) ผ่าน Store (ออกแบบรองรับ cloud sync ภายหลัง)
   เปิด API ผ่าน window.TCAS เพื่อให้ dashboard.html ใช้ logic ชุดเดียวกัน
   ============================================================ */
(function (global) {
  'use strict';

  var KEY = 'tcas70:v1';
  var SCHEMA = 1;
  var DAY = 86400000;

  /* ---------------- util ---------------- */
  function now() { return Date.now(); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // cyrb53 — string hash ที่กระจายดี → id base36 (ใช้ทำ qid ที่เสถียรแม้สลับลำดับข้อ)
  function cyrb53(str, seed) {
    seed = seed || 0;
    var h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (var i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    var n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return n.toString(36);
  }
  function qidOf(guideId, qText) { return cyrb53(guideId + '' + (qText || '')).slice(0, 10); }

  function guideIdFromPath() {
    var path = (global.location && global.location.pathname) || '';
    var f = path.split('/').pop() || '';
    f = f.replace(/\.html?$/i, '');
    return f || 'index';
  }

  /* ---------------- Store: funnel เดียวสำหรับ read/write ----------------
     ต่อ cloud (เช่น Supabase) ภายหลัง = ใส่ adapter ที่ Store.remote
     แล้วทุก UI ไม่ต้องแก้ เพราะวิ่งผ่าน load()/save() ที่เดียว */
  var Store = {
    remote: null, // future: { push(state), pull():Promise<state> }
    _blank: function () { return { version: SCHEMA, updatedAt: now(), catalog: {}, progress: {} }; },
    load: function () {
      try {
        var raw = global.localStorage.getItem(KEY);
        if (!raw) return this._blank();
        var s = JSON.parse(raw);
        if (!s || typeof s !== 'object') return this._blank();
        s.version = s.version || SCHEMA;
        s.catalog = s.catalog || {};
        s.progress = s.progress || {};
        return s;
      } catch (e) { return this._blank(); }
    },
    save: function (state) {
      state.updatedAt = now();
      try { global.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
      if (this.remote && this.remote.push) { try { this.remote.push(state); } catch (e) {} }
      return state;
    },
    reset: function () { try { global.localStorage.removeItem(KEY); } catch (e) {} },
    exportJSON: function () { return JSON.stringify(this.load(), null, 2); },
    importJSON: function (text) {
      var s = JSON.parse(text);
      if (!s || typeof s !== 'object' || !('progress' in s)) throw new Error('รูปแบบไฟล์ไม่ถูกต้อง');
      s.version = SCHEMA; s.catalog = s.catalog || {}; s.progress = s.progress || {};
      return this.save(s);
    }
  };

  /* ---------------- spaced repetition (SM-2 แบบย่อ) ---------------- */
  function newRec(guideId) {
    return { g: guideId, ok: 0, no: 0, streak: 0, last: 0, due: 0, ivl: 0, ease: 2.5, hist: [] };
  }
  function schedule(rec, ok) {
    var t = now();
    rec.last = t;
    if (ok) {
      rec.ok++; rec.streak++;
      if (rec.streak === 1) rec.ivl = 1;
      else if (rec.streak === 2) rec.ivl = 3;
      else rec.ivl = Math.max(1, Math.ceil(rec.ivl * rec.ease));
      rec.ease = clamp(rec.ease + 0.05, 1.3, 2.8);
      rec.due = t + rec.ivl * DAY;
    } else {
      rec.no++; rec.streak = 0; rec.ivl = 0;
      rec.ease = clamp(rec.ease - 0.2, 1.3, 2.8);
      rec.due = t; // พลาด → ครบกำหนดทวนทันที
    }
    rec.hist = (rec.hist || []).concat([{ t: t, ok: ok ? 1 : 0 }]).slice(-10);
    return rec;
  }
  function isMastered(rec) {
    if (!rec) return false;
    var tot = rec.ok + rec.no;
    return rec.streak >= 2 && tot > 0 && rec.ok / tot >= 0.7;
  }

  /* ---------------- catalog + progress ops ---------------- */
  function registerCatalog(state, guideId, meta, problems) {
    var qs = {};
    problems.forEach(function (p, i) {
      var id = qidOf(guideId, p.q);
      qs[id] = { idx: i, topic: p.topic || 'ทั่วไป', preview: String(p.q || '').slice(0, 80) };
    });
    state.catalog[guideId] = {
      title: meta.title || guideId,
      url: meta.url || (guideId + '.html'),
      total: problems.length,
      seenAt: now(),
      questions: qs
    };
    return state;
  }
  function recordAttempt(qid, guideId, ok) {
    var state = Store.load();
    var rec = state.progress[qid] || newRec(guideId);
    rec.g = guideId;
    schedule(rec, ok);
    state.progress[qid] = rec;
    Store.save(state);
    return rec;
  }

  /* ---------------- derived stats สำหรับ dashboard ---------------- */
  function deriveStats(state) {
    state = state || Store.load();
    var t = now();
    var guides = [], dueQueue = [];
    var allTotal = 0, allMastered = 0, allAttempted = 0;

    Object.keys(state.catalog).forEach(function (gid) {
      var cat = state.catalog[gid];
      var chapters = {};
      var gAtt = 0, gMast = 0;

      Object.keys(cat.questions).forEach(function (qid) {
        var meta = cat.questions[qid];
        var topic = meta.topic || 'ทั่วไป';
        var c = chapters[topic] || (chapters[topic] =
          { topic: topic, total: 0, attempted: 0, mastered: 0, ok: 0, no: 0, last: 0, due: 0 });
        c.total++;
        var rec = state.progress[qid];
        if (rec && (rec.ok + rec.no) > 0) {
          c.attempted++; gAtt++;
          c.ok += rec.ok; c.no += rec.no;
          c.last = Math.max(c.last, rec.last || 0);
          c.due = c.due ? Math.min(c.due, rec.due || 0) : (rec.due || 0);
          if (isMastered(rec)) { c.mastered++; gMast++; }
          if ((rec.due || 0) <= t) {
            dueQueue.push({ qid: qid, guide: gid, guideTitle: cat.title, url: cat.url,
              topic: topic, preview: meta.preview, due: rec.due, overdue: Math.floor((t - (rec.due || t)) / DAY) });
          }
        }
      });

      var chapterList = Object.keys(chapters).map(function (k) {
        var c = chapters[k];
        c.pct = c.total ? Math.round(c.mastered / c.total * 100) : 0;
        c.acc = (c.ok + c.no) ? Math.round(c.ok / (c.ok + c.no) * 100) : null;
        c.staleDays = c.last ? Math.floor((t - c.last) / DAY) : null;
        c.weak = (c.ok + c.no) >= 2 && c.acc !== null && c.acc < 60;
        c.stale = c.attempted > 0 && c.staleDays !== null && c.staleDays >= 7;
        return c;
      }).sort(function (a, b) { return a.pct - b.pct || b.total - a.total; });

      var gTotal = cat.total || Object.keys(cat.questions).length;
      allTotal += gTotal; allMastered += gMast; allAttempted += gAtt;
      guides.push({
        id: gid, title: cat.title, url: cat.url,
        total: gTotal, attempted: gAtt, mastered: gMast,
        pct: gTotal ? Math.round(gMast / gTotal * 100) : 0,
        chapters: chapterList, seenAt: cat.seenAt
      });
    });

    guides.sort(function (a, b) { return a.pct - b.pct; });
    dueQueue.sort(function (a, b) { return a.due - b.due; });
    return {
      guides: guides, dueQueue: dueQueue, dueCount: dueQueue.length,
      totals: { total: allTotal, mastered: allMastered, attempted: allAttempted,
                pct: allTotal ? Math.round(allMastered / allTotal * 100) : 0 },
      updatedAt: state.updatedAt
    };
  }

  /* ---------------- quiz-page enhancement ---------------- */
  function pageTitle(guideId) {
    var el = document.querySelector('[data-guide-title]');
    if (el) return el.getAttribute('data-guide-title').trim();
    var t = (document.title || '').trim();
    if (t) return t.replace(/\s*[|\-–—·].*$/, '').trim() || guideId;
    var h1 = document.querySelector('h1');
    return (h1 && h1.textContent.trim()) || guideId;
  }

  // ฉีด <link tracker.css> ให้เองถ้ายังไม่มี → guide แค่เพิ่ม <script> บรรทัดเดียวพอ
  function ensureCSS() {
    var has = [].some.call(document.querySelectorAll('link[rel="stylesheet"]'),
      function (l) { return /tracker\.css(\?|$)/.test(l.getAttribute('href') || ''); });
    if (has) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'tracker.css';
    document.head.appendChild(link);
  }

  function initQuizPage() {
    if (!Array.isArray(global.problems) || !global.problems.length) return;
    var qlist = document.getElementById('qlist');
    if (!qlist) return;
    ensureCSS();
    var qNodes = qlist.querySelectorAll('.q');
    if (!qNodes.length) return;

    var guideId = guideIdFromPath();
    var problems = global.problems;

    // 1) ลงทะเบียน catalog ของหน้านี้ (self-registering → dashboard เห็นเอง)
    var state = Store.load();
    registerCatalog(state, guideId, { title: pageTitle(guideId), url: guideId + '.html' }, problems);
    Store.save(state);

    var qids = problems.map(function (p) { return qidOf(guideId, p.q); });

    // 2) แถบ progress ของหน้า (วางก่อน #qlist)
    var bar = document.createElement('div');
    bar.className = 'tcas-pagebar';
    qlist.parentNode.insertBefore(bar, qlist);

    function chipState(rec) {
      if (rec && (rec.ok + rec.no) > 0) {
        if (isMastered(rec)) return { cls: 'mastered', label: 'แม่น ×' + rec.streak };
        if (rec.streak > 0)  return { cls: 'ok', label: 'ถูก ×' + rec.streak };
        return { cls: 'miss', label: 'ต้องทวน' };
      }
      return { cls: 'new', label: 'ยังไม่ทำ' };
    }
    function renderChip(qNode, rec) {
      var host = qNode.querySelector('.q-topic') || qNode.querySelector('.q-body') || qNode;
      var chip = qNode.querySelector('.tcas-chip');
      if (!chip) { chip = document.createElement('span'); host.insertBefore(chip, host.firstChild); }
      var s = chipState(rec);
      chip.className = 'tcas-chip tcas-' + s.cls;
      chip.textContent = s.label;
    }
    function renderBar() {
      var prog = Store.load().progress, done = 0, mastered = 0;
      qids.forEach(function (qid) {
        var r = prog[qid];
        if (r && (r.ok + r.no) > 0) done++;
        if (isMastered(r)) mastered++;
      });
      var total = qids.length;
      var pct = total ? Math.round(mastered / total * 100) : 0;
      bar.innerHTML =
        '<div class="tcas-pb-row"><span class="tcas-pb-label">ความเข้าใจหน้านี้</span>' +
        '<span class="tcas-pb-val">' + pct + '%</span></div>' +
        '<div class="tcas-pb-track"><div class="tcas-pb-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="tcas-pb-sub"><span>ทำแล้ว ' + done + '/' + total + ' · แม่น ' + mastered + ' ข้อ</span>' +
        '<a class="tcas-pb-link" href="dashboard.html">📊 ภาพรวมทุกวิชา</a></div>';
    }

    // 3) ฉีดปุ่ม self-grade เข้า .q-sol แต่ละข้อ + chip สถานะ
    var prog0 = state.progress;
    qNodes.forEach(function (qNode, i) {
      if (i >= qids.length) return;
      var qid = qids[i];
      renderChip(qNode, prog0[qid]);

      var sol = qNode.querySelector('.q-sol');
      if (!sol || sol.querySelector('.tcas-grade')) return;
      var g = document.createElement('div');
      g.className = 'tcas-grade';
      g.innerHTML =
        '<span class="tcas-grade-q">ทำข้อนี้ได้เองไหม?</span>' +
        '<div class="tcas-grade-btns">' +
          '<button type="button" class="tcas-btn tcas-no" data-ok="0">✗ ไม่ได้</button>' +
          '<button type="button" class="tcas-btn tcas-yes" data-ok="1">✓ ได้</button>' +
        '</div>' +
        '<div class="tcas-grade-done">บันทึกแล้ว — กดซ้ำเพื่อแก้ได้</div>';
      sol.appendChild(g);

      g.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-ok]');
        if (!b) return;
        var ok = b.getAttribute('data-ok') === '1';
        var rec = recordAttempt(qid, guideId, ok);
        g.classList.add('tcas-graded');
        g.setAttribute('data-result', ok ? 'ok' : 'no');
        renderChip(qNode, rec);
        renderBar();
      });
    });

    renderBar();
  }

  /* ---------------- expose API ---------------- */
  global.TCAS = {
    version: SCHEMA,
    Store: Store,
    schedule: schedule,
    isMastered: isMastered,
    deriveStats: deriveStats,
    recordAttempt: recordAttempt,
    registerCatalog: registerCatalog,
    qidOf: qidOf,
    util: { now: now, DAY: DAY, clamp: clamp, cyrb53: cyrb53 }
  };

  // auto-run เฉพาะเมื่อมี DOM (กันพังเวลา import ใน node/test)
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initQuizPage);
    else initQuizPage();
  }
})(typeof window !== 'undefined' ? window : this);
