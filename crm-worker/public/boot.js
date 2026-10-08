// Cloudflare版CRMの起動。写し（D1）を受け取り、今の GAS のコードで樹形図を組み立てて、GAS版と同じ画面を動かす。
// 画面の google.script.run は、読むもの（樹形図・一覧・中身）は手元で、書くもの（記録・送信・保存）は GAS（/api/call）へ。
(function () {
  'use strict';
  var SHEETS = ['検索条件', 'LINE Users', '対応ログ', 'タスク', '問い合わせ', 'CRMグループ', 'CRMメモ', 'LINE家族', 'LINE要返信',
    '樹形図の対象外（旧顧客）', 'LINE友だち追加', 'LINEブロック（名前なし）', '通知済み物件', 'アクションログ', '閲覧ログ', '継続確認',
    '引越し時期の確認', '電話のお願い', '初回配信フォロー', '初回検索の確認', '配信停止', 'LINE登録メール', 'LINE Activity', 'メール送信履歴',
    'CRM送信候補', '承認待ち物件'];
  var HOLIDAYS = 'https://holidays-jp.github.io/api/v1/date.json';
  var lastU = 0;

  function say(t) { var el = document.getElementById('bootMsg'); if (el) el.textContent = t; }

  // 写しの差分を取り込む（書いたあと・読み直すとき）
  var deltaP = null;
  function refreshDelta() {
    if (deltaP) return deltaP;
    deltaP = fetch('/api/delta?since=' + lastU, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      (d.rows || []).forEach(function (x) { GasShim.patchRow(x[0], x[1], x[2]); });
      (d.meta || []).forEach(function (m) { GasShim.truncate(m.sheet, m.rows); });
      lastU = d.now;
      GasShim.clearCache();
      deltaP = null;
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
    getCrmVersion: function () {
      return fetch('/api/ver', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (v) {
        return { ver: v.ver, whys: v.whys || {}, now: Date.now() };
      });
    }
  };

  // シートを書くだけの操作は、まず手元の写しで同じ処理を動かして、画面（段の移動まで）をすぐ変える。
  // 本当の保存は GAS（lite: 1人分の作り直しを省いて早く返す）。あとで写しの差分を取り込んで、手元と本物をそろえる。
  // ⚠️ LINE を送るもの・条件の保存（リッチメニュー等で外に行く）はここに入れない
  var LOCAL_WRITE = {
    setCrmGroup: 1, recordCrmTreeContact: 1, setCrmNextContact: 1, setCrmStage: 1, planCrmViewing: 1, saveCrmMemo: 1,
    setCrmCandidates: 1, skipCrmProperty: 1, skipCrmProperties: 1, unskipCrmProperty: 1, setCrmWatch: 1, addCrmWatchFromPending: 1,
    recordCrmTalk: 1, setCrmClosed: 1
  };
  function callFn(name, args) {
    if (LOCAL_WRITE[name]) {
      var t0 = Date.now(), localRes = null;
      try { localRes = GAS_FN(name).apply(null, JSON.parse(JSON.stringify(args))); }
      catch (e) { console.warn('[CRM] 手元で先に動かせませんでした（保存はGASでします）: ' + name + ' / ' + e.message); }
      if (localRes && window.__applyLocal) { try { window.__applyLocal(localRes); } catch (e2) {} }
      if (localRes) console.log('[CRM] 手元で先に反映 ' + name + ' ' + (Date.now() - t0) + 'ms');
      return gasCall(name, args, !!localRes).then(function (r) {
        refreshDelta().catch(function () {});
        // 手元の結果に GAS のひとこと（savedMessage）だけ足して返す。画面はもう変わっている
        if (r && r.lite) return { savedMessage: r.savedMessage || (localRes && localRes.savedMessage) };
        return r;
      }, function (e) {
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
    var sheetsP = fetch('/api/sheets?s=' + encodeURIComponent(SHEETS.join(',')), { cache: 'no-store' }).then(function (r) {
      if (r.status === 401) throw new Error('ログインが切れています。GAS版の顧客管理の ☰ から「Cloudflare版を開く」で入り直してください。');
      return r.json();
    });
    Promise.all([sheetsP, holP, consts ? Promise.resolve(consts) : constsP]).then(function (all) {
      var d = all[0], c = all[2];
      GasShim.loadSheets(d.sheets);
      lastU = d.now;
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
