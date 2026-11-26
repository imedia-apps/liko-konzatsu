/* ============================================================
 * Liko 体験ガイド（Liko様作成のアプリ・2026-11-26受領）用の追加部品（guide-visit.js）
 *   本体のHTMLには手を入れず、この1ファイルを本体のあとに読み込むだけで動く
 *   設定：window.LIKO_VISIT = { api: '記録先のURL', liffId: 'LIFF ID' }
 *         api が空なら記録は送らない。liffId が空ならLINEにはつながない（ふつうのWebページとして動く）
 *
 * やること
 *   1. LINE（LIFF）につなぐ。LINEの名前とユーザーIDを受け取る
 *   2. 店頭QR（?store=店舗コード）から開いたら、その店舗に確定して体験選択画面から始める
 *      QRの形は今までと同じ。本体が持っている「#store-店舗ID」の受け口は使わない
 *      （LINEが最初に開くとき、URLの # 以降をLINE自身が使うため）
 *   3. 入店・体験の選択・退店を記録先へ送る。送りっぱなしで、失敗しても画面には何も出さない
 *
 * 本体に求めるもの（無ければ何もしない）：S / STORES / EXP / go(screen) / render() / save()
 *   画面の名前：exp＝体験選択、guide＝作り方ガイド、end＝お会計のあとの最終画面
 * ============================================================ */
(function () {
  'use strict';
  var CFG = window.LIKO_VISIT || {};
  var API = CFG.api || '';
  var LIFF_ID = CFG.liffId || '';
  var QR_VALID_MS = 4 * 60 * 60 * 1000;   // QRで確定した店舗を覚えておく時間（自動退店の上限240分に合わせる）
  var RESEND_MS = 30 * 60 * 1000;         // 同じ店舗の入店を送り直すまでの間隔（在店中の二重は記録先が防ぐ）
  var PROFILE_WAIT_MS = 2400;             // LINEの名前が取れるのを待つ上限
  var K_CID = 'liko_visit_cid_v1';        // 端末の識別子（今までのアプリと同じ鍵＝同じ端末は同じ人として続く）
  var K_QR = 'liko_visit_qr_v1';
  var K_ST = 'liko_visit_state_v2';

  /* 店舗コード（店舗マスタ・店頭QRと同じ）→ 本体の店舗ID（STORES の id） */
  var IDS = {
    'nakazakicho': 'nakazakicho', 'osaka-tenma': 'tenma', 'tsuruhashi': 'tsuruhashi', 'shinsaibashi': 'shinsaibashi',
    'amemura': 'amemura', 'minamihorie': 'minamihorie', 'nara': 'nara', 'kobe-motomachi': 'kobe', 'kyoto': 'kyoto', 'gion': 'gion',
    'shibuya-honten': 'shibuya-main', 'shibuya': 'shibuya', 'shibuya2': 'shibuya2', 'ikebukuro': 'ikebukuro',
    'asakusa': 'asakusa', 'asakusa2': 'asakusa2', 'omotesando': 'omotesando',
    'nagoya-sakae': 'sakae', 'nagoya-ekimae': 'nagoya-station', 'yokohama-2': 'yokohama2', 'yokohama-1': 'yokohama1',
    'hiroshima-hondori': 'hiroshima', 'fukuoka-tenjin': 'tenjin'
  };   // 本体で店舗の追加・ID変更があったらここも直す（gas/test/consistency-guide.test.js が見張る）
  var CODE_OF = {};
  Object.keys(IDS).forEach(function (c) { CODE_OF[IDS[c]] = c; });

  /* ---------- 保存（使えない端末でも止まらない） ---------- */
  var mem = {};
  function store(kind) { return kind === 's' ? window.sessionStorage : window.localStorage; }
  function get(kind, k) { try { var v = store(kind).getItem(k); return v == null ? (mem[k] || null) : v; } catch (e) { return mem[k] || null; } }
  function set(kind, k, v) { mem[k] = v; try { store(kind).setItem(k, v); } catch (e) {} }
  function uid() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function clientId() {
    var c = get('l', K_CID);
    if (!c) { c = 'c-' + uid(); set('l', K_CID, c); }
    return c;
  }

  /* ---------- URLから店舗コードを控える（LINEにつなぐ前に実行。つなぐとURLが書き換わる） ---------- */
  function storeFromUrl() {
    try {
      var q = new URLSearchParams(location.search);
      var s = q.get('store');
      if (!s && q.get('liff.state')) {
        var st = q.get('liff.state');
        var m = /[?&]store=([^&#]+)/.exec(st.charAt(0) === '?' || st.charAt(0) === '/' ? st : '?' + st);
        if (m) s = decodeURIComponent(m[1]);
      }
      s = s ? String(s).trim().toLowerCase() : '';
      return IDS[s] ? s : '';
    } catch (e) { return ''; }
  }
  var urlStore = storeFromUrl();
  if (urlStore) set('l', K_QR, JSON.stringify({ code: urlStore, at: Date.now() }));

  function qrStore() {   // QRで確定済みの店舗コード（有効時間内）
    try {
      var o = JSON.parse(get('l', K_QR) || 'null');
      if (o && o.code && IDS[o.code] && Date.now() - o.at < QR_VALID_MS) return o.code;
    } catch (e) {}
    return '';
  }

  /* ---------- 本体とのつなぎ ---------- */
  function appReady() {
    try { return typeof S === 'object' && !!S && Array.isArray(STORES) && typeof go === 'function' && typeof render === 'function' && typeof save === 'function'; }
    catch (e) { return false; }
  }
  function currentCode() { try { return CODE_OF[S.store] || ''; } catch (e) { return ''; } }
  function expectedMin() {   // 体験の目安時間（分）。時間で選ぶプラン（60分・180分）はプランの時間を使う
    try {
      var e = EXP[S.exp];
      var p = e && e.plans && e.plans[S.plan == null ? 0 : S.plan];
      var m = p && /^p_(\d+)$/.exec(p.k || '');
      if (m) return Number(m[1]);
      return (e && e.t && Number(e.t[1])) || '';
    } catch (e2) { return ''; }
  }

  /* ---------- LINE（LIFF） ---------- */
  var profile = { userId: '', displayName: '' };
  var profileP = Promise.resolve();
  function inLine() { try { return !!(window.liff && liff.isInClient && liff.isInClient()); } catch (e) { return false; } }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function initLiff() {
    if (!window.liff || !LIFF_ID) return;
    var p;
    try {
      p = liff.init({ liffId: LIFF_ID }).then(function () {
        if (liff.isLoggedIn && liff.isLoggedIn()) {
          return liff.getProfile().then(function (pf) { profile.userId = pf.userId || ''; profile.displayName = pf.displayName || ''; });
        }
      }).catch(function (err) { try { console.warn('LIFF init失敗（ふつうのブラウザでは無視してよい）:', err); } catch (e) {} });
    } catch (e) { return; }
    profileP = inLine() ? Promise.race([p, sleep(PROFILE_WAIT_MS)]) : Promise.resolve();   // LINEの外では待たない
  }
  function liffUrl(code) { return 'https://liff.line.me/' + LIFF_ID + (code ? '?store=' + encodeURIComponent(code) : ''); }

  /* ---------- 送信（送りっぱなし。順番だけ守る：入店→体験→退店） ---------- */
  var queue = Promise.resolve();
  function post(type, code, extra) {
    if (!code) return Promise.resolve();
    var body = { action: type, store: code, clientId: clientId(), userId: profile.userId, displayName: profile.displayName, eventId: uid(), source: (qrStore() === code ? 'qr' : 'select') };
    if (extra) for (var k in extra) body[k] = extra[k];
    try { (window.__likoVisitLog = window.__likoVisitLog || []).push(body); } catch (e) {}   // 動作確認用の控え
    if (!API) return Promise.resolve();
    try {
      var f = fetch(API, { method: 'POST', mode: 'no-cors', keepalive: true, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) }).catch(function () {});
      return Promise.race([f, sleep(1500)]);   // 次の送信を長く待たせない
    } catch (e) { return Promise.resolve(); }
  }
  function enqueue(fn) { queue = queue.then(fn).catch(function () {}); }

  /* いまの来店について、この画面で何を送ったかの控え（タブを閉じるまで） */
  var st = { code: '', at: 0, done: false, act: '' };
  try { var saved = JSON.parse(get('s', K_ST) || 'null'); if (saved && saved.code) st = saved; } catch (e) {}
  function saveSt() { set('s', K_ST, JSON.stringify(st)); }

  function enter(force) {
    var code = currentCode();
    if (!code) return;
    var now = Date.now();
    if (!force && st.code === code && !st.done && now - st.at < RESEND_MS) return;
    st = { code: code, at: now, done: false, act: '' }; saveSt();
    enqueue(function () { return profileP.then(function () { return post('enter', code); }); });   // LINEの名前が取れてから送る
  }
  function activity() {
    var code = currentCode();
    if (!code || !S.exp) return;
    if (st.code !== code || st.done) enter(true);
    var min = expectedMin();
    var key = S.exp + ':' + min;
    if (st.act === key) return;
    st.act = key; saveSt();
    var exp = S.exp;
    enqueue(function () { return post('activity', code, { activity: exp, expectedMin: min }); });
  }
  function exit() {
    var code = currentCode();
    if (!code || st.code !== code || st.done) return;
    st.done = true; saveSt();
    enqueue(function () { return post('exit', code); });
  }

  /* ---------- 画面を描いたあとの手直し（本体は描くたびに作り直すので、毎回あてる） ---------- */
  function after() {
    try {
      var code = currentCode();
      // QRで確定した店舗では、店舗一覧へ戻るボタンを出さない（QRの有効時間が過ぎたら戻れる）
      if (code && qrStore() === code) {
        var back = document.querySelectorAll('[data-a="toStore"]');
        for (var i = 0; i < back.length; i++) back[i].style.display = 'none';
      }
      // 「LINEで開く」ボタンに行き先を入れる（本体では未設定のまま）
      if (LIFF_ID) {
        var a = document.querySelector('[data-a="openLine"]');
        if (a) {
          a.setAttribute('href', liffUrl(code));
          var n = a.nextElementSibling;
          if (n && /未設定/.test(n.textContent || '')) n.parentNode.removeChild(n);
        }
      }
    } catch (e) {}
  }

  function boot() {
    if (!appReady()) return;   // 本体が無ければ何もしない

    // 「LINEで開く」は本体側で押しても動かないようになっている。行き先を入れたので、そのまま開かせる
    document.addEventListener('click', function (ev) {
      try { if (LIFF_ID && ev.target && ev.target.closest && ev.target.closest('[data-a="openLine"]')) ev.stopPropagation(); } catch (e) {}
    }, true);

    // 画面の切り替えに合わせて記録を送る
    var _render = render;
    window.render = render = function () { _render.apply(this, arguments); after(); };
    var _go = go;
    window.go = go = function (screen) {
      _go.apply(this, arguments);
      try {
        if (screen === 'exp') enter(false);      // 店舗が決まった（一覧から選択・最初からやり直すを含む）
        if (screen === 'guide') activity();      // 体験とプランが決まった
        if (screen === 'end') exit();            // お会計が終わった
      } catch (e) {}
    };

    if (inLine()) S.via = 'line';   // LINEの中では「LINEでまた開く」の案内を出さない
    initLiff();

    // 店頭QRから開いた：その店舗に確定する。同じ店舗で途中まで進んでいたら、その続きから
    var id = urlStore && IDS[urlStore];
    var fromQr = false;
    try { fromQr = !!id && STORES.some(function (s) { return s.id === id; }); } catch (e) {}
    if (fromQr) {
      if (S.store !== id) { S.store = id; S.exp = null; S.plan = null; S.step = 0; S.screen = 'exp'; }
      S.qr = true;
    }
    save();
    render();
    if (fromQr) enter(true);                    // QRを読むたびに送る（一覧から選んで入った人の入口をQRに直すため）
    else if (currentCode() && S.screen !== 'store' && S.screen !== 'end') enter(false);   // 途中から開き直した
  }
  boot();
})();
