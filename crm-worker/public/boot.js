// Cloudflare版CRMの起動。写し（D1）を受け取り、今の GAS のコードで樹形図を組み立てて、GAS版と同じ画面を動かす。
// 画面の google.script.run は、読むもの（樹形図・一覧・中身）は手元で、書くもの（記録・送信・保存）は GAS（/api/call）へ。
(function () {
  'use strict';
  var SHEETS = ['検索条件', 'LINE Users', '対応ログ', 'タスク', '問い合わせ', 'CRMグループ', 'CRMメモ', 'LINE家族', 'LINE要返信',
    '樹形図の対象外（旧顧客）', 'LINE友だち追加', 'LINEブロック（名前なし）', '通知済み物件', 'アクションログ', '閲覧ログ', '継続確認',
    '引越し時期の確認', '電話のお願い', '初回配信フォロー', '初回検索の確認', '配信停止', 'LINE登録メール', 'LINE Activity', 'メール送信履歴',
    'CRM送信候補', '空室確認依頼', '承認待ち物件'];
  var HOLIDAYS = 'https://holidays-jp.github.io/api/v1/date.json';
  var lastU = 0, lastVer = 0, lastCheckAt = 0, inflightSince = 0;
  // 外で変わったか確かめて、変わっていれば取り込んで組み立て直す（Discordから送った・検索の新着・条件変更・LINEの返信など）
  // ⚠️ 2026-10-09: 開いたままの画面で取り込みが止まっていた。保存待ちが戻らないと止まる作りだったので、
  //   2分以上たった保存待ちは終わったとみなす。タブに戻ったときにもすぐ確かめる。最終更新の時刻を画面に出す
  function checkNow(force) {
    if (!lastU) return;
    if (inflight > 0) {
      if (inflightSince && Date.now() - inflightSince > 120000) { console.warn('[CRM] 保存待ちが2分以上戻らないので、取り込みを再開します'); inflight = 0; }
      else return;
    }
    fetch('/api/ver', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (v) {
      lastCheckAt = Date.now(); showFresh();
      if (force || (v && v.ver > lastVer)) refreshDelta().catch(function () {});
    }).catch(function () {});
  }
  function showFresh() {
    var el = document.getElementById('freshAt');
    if (!el) {
      var h = document.querySelector('header'); if (!h) return;
      el = document.createElement('span'); el.id = 'freshAt'; el.className = 'meta'; el.style.cursor = 'pointer'; el.title = '押すと今すぐ取り込みます';
      el.onclick = function () { checkNow(true); };
      h.insertBefore(el, h.children[1] || null);
    }
    var d = new Date(lastCheckAt || Date.now());
    el.textContent = '最終更新 ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
  }
  setInterval(function () { if (document.visibilityState === 'visible') checkNow(false); }, 30000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') checkNow(false); });
  window.addEventListener('focus', function () { checkNow(false); });

  function say(t) { var el = document.getElementById('bootMsg'); if (el) el.textContent = t; }

  // 写しの差分を取り込む（書いたあと・読み直すとき）
  var deltaP = null;
  // ⚠️ 手元で先に書いた保存が GAS に届くまでは、写しの差分を取り込まない（2026-10-08）。
  //   取り込むと、まだ本物に無い「LINEした」などの記録を消してしまい、次に組み立てると赤に戻った。
  //   保存が全部終わってから取り込む（GAS は返す前に写しへ送っているので、そのときには本物と手元がそろう）。
  var inflight = 0, deltaWanted = false;
  function savedOne() {
    inflight = Math.max(0, inflight - 1);
    if (inflight === 0 && deltaWanted) { deltaWanted = false; refreshDelta().catch(function () {}); }
  }
  function refreshDelta() {
    if (inflight > 0) { deltaWanted = true; return Promise.resolve({}); }
    if (deltaP) return deltaP;
    deltaP = fetch('/api/delta?since=' + lastU, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      (d.rows || []).forEach(function (x) { GasShim.patchRow(x[0], x[1], x[2]); });
      (d.meta || []).forEach(function (m) { GasShim.truncate(m.sheet, m.rows); });
      lastU = d.now;
      lastVer = Math.max(lastVer, d.ver || 0);
      GasShim.clearCache();
      deltaP = null;
      // 変わった行があったら、画面を組み立て直す（ブラウザの中なので一瞬）。
      // ⚠️ 以前は取り込むだけで組み立て直しておらず、条件を保存しても「引越しまで◯日」が古いままだった（2026-10-08）
      if ((d.rows || []).length && window.__recomputeAll) { try { window.__recomputeAll(); } catch (eR) { console.warn(eR); } }
      if ((d.rows || []).length) saveSnapSoon();
      return d;
    }, function (e) { deltaP = null; throw e; });
    return deltaP;
  }

  function gasCall(fn, args, lite) {
    return fetch('/api/call', { method: 'POST', body: JSON.stringify({ fn: fn, args: args, lite: !!lite }), headers: { 'content-type': 'text/plain' } })
      .then(function (r) { return r.json(); })
      .then(function (o) {
        if (!o || !o.ok) throw new Error((o && o.error) || 'GASから答えがありません');
        return o.result;
      });
  }

  // 手元で答える関数（写しを読むだけ）
  var LOCAL = {
    getCrmTreeForPage: function () { return refreshDelta().then(function () { return GAS_FN('_crmTreeForPage_')(); }); },
    getCrmOne: function (name) { return refreshDelta().then(function () { return GAS_FN('_crmTreeForPage_')(name); }); },
    getCrmPropListsAll: function (names) { return Promise.resolve(GAS_FN('getCrmPropListsAll')(names)); },
    getCrmPropLists: function (name) { return refreshDelta().then(function () { return GAS_FN('getCrmPropLists')(name); }); },
    getCrmPropertyDetails: function (name, ids) { return Promise.resolve(GAS_FN('getCrmPropertyDetails')(name, ids)); },
    // Cloudflare版は自分で30秒ごとに取り込むので、「新しい動きがあります」の知らせは出さない
    getCrmVersion: function () { return Promise.resolve({ ver: 0, whys: {}, now: Date.now() }); }
  };

  // シートを書くだけの操作は、まず手元の写しで同じ処理を動かして、画面（段の移動まで）をすぐ変える。
  // 本当の保存は GAS（lite: 1人分の作り直しを省いて早く返す）。あとで写しの差分を取り込んで、手元と本物をそろえる。
  // ⚠️ LINE を送るもの・条件の保存（リッチメニュー等で外に行く）はここに入れない
  // LINE を送る・条件を保存するものも、手元では「送ったふり」で先に済ませる（gas-shim の simulate）。本当に送るのは GAS。
  var LOCAL_WRITE = {
    setCrmGroup: 1, recordCrmTreeContact: 1, setCrmNextContact: 1, setCrmStage: 1, planCrmViewing: 1, saveCrmMemo: 1,
    setCrmCandidates: 1, skipCrmProperty: 1, skipCrmProperties: 1, unskipCrmProperty: 1, setCrmWatch: 1, addCrmWatchFromPending: 1,
    recordCrmTalk: 1, setCrmClosed: 1,
    sendCrmProperties: 1, saveCrmCriteria: 1, logCrmManualMessage: 1, copyCrmPropertyTo: 1, resendCrmToFamily: 1,
    addCrmCustomer: 1, renameCrmCustomer: 1, linkCrmLine: 1, linkCrmFamily: 1, unlinkCrmFamily: 1, nameCrmLineOnly: 1,
    saveCrmPropertyEdit: 1, addCrmTask: 1, doneCrmTask: 1, setCrmTaskDue: 1, deleteCrmTask: 1, setCrmTaskOwner: 1, setCrmViewingWish: 1
  };
  // 押した瞬間に画面の順番待ちの列から呼ばれる。手元で先に動かした結果を覚えておき、列の番が来たら保存だけする
  var preApplied = [];
  function runLocal(name, args) {
    var t0 = Date.now(), localRes = null;
    GasShim.simulate = true;
    try { localRes = GAS_FN(name).apply(null, JSON.parse(JSON.stringify(args))); }
    catch (e) { console.warn('[CRM] 手元で先に動かせませんでした（保存はGASでします）: ' + name + ' / ' + e.message); }
    finally { GasShim.simulate = false; }
    if (localRes && window.__applyLocal) { try { window.__applyLocal(localRes); } catch (e2) {} }
    if (localRes) console.log('[CRM] 手元で先に反映 ' + name + ' ' + (Date.now() - t0) + 'ms');
    return localRes;
  }
  window.__localFirst = function (name, args) {
    if (!LOCAL_WRITE[name]) return;
    if (inflight === 0) inflightSince = Date.now();
    inflight++;
    preApplied.push({ name: name, res: runLocal(name, args) });
  };
  function callFn(name, args) {
    if (LOCAL_WRITE[name]) {
      var pre = (preApplied.length && preApplied[0].name === name) ? preApplied.shift() : null;
      if (!pre) { if (inflight === 0) inflightSince = Date.now(); inflight++; }
      var localRes = pre ? pre.res : runLocal(name, args);
      return gasCall(name, args, !!localRes).then(function (r) {
        savedOne();
        refreshDelta().catch(function () {});
        // 手元の結果に GAS のひとこと（savedMessage）だけ足して返す。画面はもう変わっている
        if (r && r.lite) return { savedMessage: r.savedMessage || (localRes && localRes.savedMessage) };
        return r;
      }, function (e) {
        savedOne();
        refreshDelta().then(function () { if (window.__applyLocal && localRes && localRes.onlyName) window.__applyLocal(GAS_FN('_crmTreeForPage_')(localRes.onlyName)); }).catch(function () {});
        throw e;
      });
    }
    if (LOCAL[name]) return new Promise(function (res, rej) { setTimeout(function () { try { LOCAL[name].apply(null, args).then(res, rej); } catch (e) { rej(e); } }, 0); });
    // 書くもの: GAS で書く → 写しにはGASがすぐ送る → 手元の写しも取り直しておく
    return gasCall(name, args).then(function (r) { refreshDelta().catch(function () {}); return r; });
  }

  function runner() {
    var ok = function () {}, ng = function (e) { console.error(e); };
    var p = new Proxy({}, {
      get: function (_, k) {
        if (k === 'withSuccessHandler') return function (f) { ok = f; return p; };
        if (k === 'withFailureHandler') return function (f) { ng = f; return p; };
        if (k === 'withUserObject') return function () { return p; };
        return function () {
          var args = Array.prototype.slice.call(arguments);
          callFn(k, args).then(function (r) { ok(r); }, function (e) { ng(e instanceof Error ? e : new Error(String(e))); });
        };
      }
    });
    return p;
  }
  window.google = { script: { get run() { return runner(); }, host: { close: function () {} } } };

  // ── 前回の写しをブラウザ（IndexedDB）に取っておく。次に開くときは差分だけ受け取る ──
  // ⚠️ 開くたびに全部（約1万7千行）を読むと、Cloudflare の1日の読み取り上限（500万行）を圧迫する（2026-10-08）
  var IDB = 'crmMirror', IDB_STORE = 'snap';
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(IDB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(IDB_STORE); };
      r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
    });
  }
  function loadSnap() {
    return idb().then(function (db) { return new Promise(function (res) {
      var q = db.transaction(IDB_STORE).objectStore(IDB_STORE).get('v1');
      q.onsuccess = function () { res(q.result || null); }; q.onerror = function () { res(null); };
    }); }).catch(function () { return null; });
  }
  var snapTimer = null;
  function saveSnapSoon() {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(function () {
      if (inflight > 0) return;   // 手元だけの書き込みが残っている間は取っておかない
      var snap = { sheets: GasShim.exportSheets(), lastU: lastU, lastVer: lastVer, at: Date.now(), names: SHEETS };
      idb().then(function (db) { db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(snap, 'v1'); }).catch(function () {});
    }, 3000);
  }

  var constsKey = 'crmConsts';
  function cachedConsts() { try { return JSON.parse(localStorage.getItem(constsKey) || 'null'); } catch (e) { return null; } }

  // 起動
  window.__bootCrm = function () {
    say('写しを読み込んでいます…');
    var t0 = Date.now();
    var consts = cachedConsts();
    var constsP = gasCall('getCrmPageConsts', []).then(function (c) {
      try { localStorage.setItem(constsKey, JSON.stringify(c)); } catch (e) {}
      return c;
    });
    var holP = fetch(HOLIDAYS).then(function (r) { return r.text(); }).then(function (t) { GasShim.setFetch(HOLIDAYS, t); }, function () {});
    var fullP = function (names) {
      return fetch('/api/sheets?s=' + encodeURIComponent(names.join(',')), { cache: 'no-store' }).then(function (r) {
        if (r.status === 401) throw new Error('ログインが切れています。GAS版の顧客管理の ☰ から「Cloudflare版を開く」で入り直してください。');
        return r.json();
      });
    };
    // 前回の写しがあれば、それに差分だけ足す（3日より古い・差分が多すぎるときは全部取り直す）
    var sheetsP = loadSnap().then(function (snap) {
      if (!snap || !snap.sheets || Date.now() - snap.at > 3 * 86400000) return fullP(SHEETS).then(function (d) { d.full = true; return d; });
      GasShim.loadSheets(snap.sheets);
      lastU = snap.lastU; lastVer = snap.lastVer || 0;
      var missing = SHEETS.filter(function (n) { return !snap.sheets[n]; });
      return (missing.length ? fullP(missing).then(function (d) { GasShim.loadSheets(d.sheets); }) : Promise.resolve()).then(function () {
        return fetch('/api/delta?since=' + lastU, { cache: 'no-store' }).then(function (r) { return r.json(); });
      }).then(function (dd) {
        if ((dd.rows || []).length >= 20000) return fullP(SHEETS).then(function (d) { d.full = true; return d; });
        (dd.rows || []).forEach(function (x) { GasShim.patchRow(x[0], x[1], x[2]); });
        (dd.meta || []).forEach(function (m) { GasShim.truncate(m.sheet, m.rows); });
        console.log('[CRM] 前回の写し＋差分 ' + (dd.rows || []).length + '行');
        return { cached: true, now: dd.now, ver: dd.ver };
      });
    });
    Promise.all([sheetsP, holP, consts ? Promise.resolve(consts) : constsP]).then(function (all) {
      var d = all[0], c = all[2];
      if (d.full) { GasShim.loadSheets(d.sheets); saveSnapSoon(); }
      lastU = d.now; lastVer = d.ver || lastVer || 0;
      say('組み立てています…');
      var tree = GAS_FN('_crmTreeForPage_')();
      window.__boot = {
        tree: tree,
        consts: c,
        master: {
          routeCompanies: GAS_FN('ROUTE_COMPANIES'), stations: GAS_FN('STATION_DATA'), cities: GAS_FN('TOKYO_CITIES'),
          equipment: GAS_FN('EQUIPMENT_CATEGORIES'), listings: c.listings || []
        }
      };
      console.log('[CRM] 起動 ' + (Date.now() - t0) + 'ms / ' + tree.customers.length + '人');
      lastCheckAt = Date.now(); setTimeout(showFresh, 0);
      var main = document.getElementById('crmMain');
      var s = document.createElement('script');
      s.textContent = main.textContent;
      document.body.appendChild(s);
      var bm = document.getElementById('bootMsg'); if (bm) bm.remove();
      // 古い覚えで開いた場合は、新しい値が届いたら入れ替える
      if (consts) constsP.then(function (c2) {
        window.customerPageUrl = c2.customerPageUrl; window.adminUrl = c2.adminUrl; window.approveBaseUrl = c2.approveBaseUrl; window.mobileSearchUrl = c2.mobileSearchUrl;
      }, function () {});
    }).catch(function (e) { say('開けませんでした: ' + e.message); console.error(e); });
  };
})();
