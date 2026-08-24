/**
 * manual-send-panel.js
 * 検索結果一覧ページに「物件を選んで顧客LINEに送る」パネルを差し込む共通モジュール。
 *
 * 各サービスの content script から window.ManualSendPanel.init(adapter) を呼んで使う。
 *
 * adapter:
 *   - source: 'reins' | 'ielove' など（ログ用）
 *   - collect(): [{ rowEl: Element, prop: Object }] を返す関数。
 *       rowEl  … チェックボックスを重ねる物件行/カードの要素
 *       prop   … buildPropertyFlex 互換の正規化済み物件オブジェクト
 *                （buildingName, roomNumber, rent, managementFee, deposit, keyMoney,
 *                  layout, area, buildingAge, floor, stationInfo, address,
 *                  imageUrls[], imageUrl, url, source）
 *
 * 顧客の特定（自動＋手動の併用）:
 *   - 手動検索機能で開いたタブなら background がその顧客名を覚えており、
 *     初期表示でその顧客を自動選択する。
 *   - ただ普通に検索しただけのときは未選択。いずれもセレクトで顧客を選べる。
 */
(function () {
  'use strict';

  if (window.__manualSendPanelLoaded) return;
  window.__manualSendPanelLoaded = true;

  var ASSIGN_KEY = '__manualSendCb'; // rowEl にチェックボックス済みフラグ
  var selectedMap = new Map();       // checkbox 要素 -> prop
  var adapter = null;
  var panelEl = null;
  var selectEl = null;
  var statusEl = null;
  var countEl = null;
  var sendBtn = null;
  var watchBtn = null;
  var metricsBtn = null;
  var publishBtn = null;
  var docBtn = null;      // 依頼書を作るボタン
  var docFormEl = null;   // 依頼書の入力フォーム（開いている間だけ存在）
  var equipBtCb = null, equipWashCb = null; // 手動: 順位検索の設備条件(バストイレ別/独立洗面)
  var lastMetricItems = []; // 競合数・順位の計算対象（index→rowEl対応の保持）

  // ─────────────────────────────────────────────
  // 送信カート（全サイト横断・ページ跨ぎ）
  //  chrome.storage.local に選択を保持。REINS/いえらぶ/itandi をまたいで貯められる。
  //  各item = { source, enriched(REINSのみ詳細), prop }
  //  REINSは「選択した瞬間」に詳細取得して enriched を保存（表示中しか取得できないため）。
  //  送信成功時にクリアする。
  // ─────────────────────────────────────────────
  var CART_KEY = '__manualSendCart';
  var selection = {};            // propKey -> { source, enriched, prop }
  var suppressStorageSync = false;

  function curSource() { return (adapter && adapter.source) || ''; }

  function loadSelection(cb) {
    try {
      chrome.storage.local.get([CART_KEY], function (d) {
        selection = (d && d[CART_KEY]) || {};
        if (cb) cb();
      });
    } catch (e) { selection = {}; if (cb) cb(); }
  }
  function saveSelection() {
    try {
      suppressStorageSync = true;
      var payload = {}; payload[CART_KEY] = selection;
      chrome.storage.local.set(payload, function () {
        setTimeout(function () { suppressStorageSync = false; }, 0);
      });
    } catch (e) { suppressStorageSync = false; }
  }
  // 物件を一意に識別するキー（source + url or building）
  function propKey(p, src) {
    if (!p) return '';
    var s = src || p.source || curSource() || '';
    if (p.url) return s + '|u:' + p.url;
    var b = p.buildingName || p.building_name || '';
    var r = p.roomNumber || p.room_number || '';
    var rent = p.rent || '';
    var st = p.stationInfo || p.station_info || '';
    return s + '|k:' + b + '|' + r + '|' + rent + '|' + st;
  }

  // チェックボックスの変更をカートへ反映（REINSは詳細を即取得）
  function onCbChange(ev) {
    var cb = ev && ev.currentTarget;
    if (!cb) return;
    var key = cb.__propKey;
    var prop = selectedMap.get(cb);
    if (!key || !prop) return;
    var src = curSource();
    if (!cb.checked) {
      delete selection[key];
      saveSelection();
      updateCount();
      return;
    }
    // どのサイトも一覧の情報だけカートへ入れる。詳細（画像・費用など）は
    // 送信やSUUMO掲載を押した時にまとめて取る。
    //
    // REINSは以前ここで詳細を取っていた。REINSの詳細はURLで開けず、一覧に出ている行の
    // 「詳細」ボタンを押さないと取れないため、ページを移る前に取っておく必要があったから。
    // ただしチェックするだけで画面が詳細ページへ飛んでしまい邪魔なので、押した時に取る方式に変えた。
    // 代わりに、REINSはページを移ってしまうと詳細が取れない。移る前に実行すること。
    if (prop && !prop.source) prop.source = src;
    selection[key] = { source: src, enriched: null, prop: prop };
    saveSelection();
    updateCount();
    if (src === 'reins') {
      setStatus('カートに追加しました（REINSは結果一覧のページを移る前に実行してください）', '#1a7f37');
    }
  }

  // 全サイトの選択をクリア
  function clearAllSelection() {
    selection = {};
    saveSelection();
    selectedMap.forEach(function (prop, cb) {
      if (document.body.contains(cb)) cb.checked = false;
    });
    updateCount();
  }

  // 現在ページのチェック状態をカートに合わせて復元（他タブ更新時など）
  function syncCurrentPageChecks() {
    selectedMap.forEach(function (prop, cb) {
      if (!document.body.contains(cb)) return;
      var key = cb.__propKey || propKey(prop);
      cb.checked = !!selection[key];
    });
  }

  function log() {
    try { console.log.apply(console, ['[手動送信パネル]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  // ─────────────────────────────────────────────
  // background との通信（Promise ラッパー）
  // ─────────────────────────────────────────────
  function sendToBackground(message) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(message, function (resp) {
          var err = chrome.runtime.lastError;
          if (err) { reject(new Error(err.message)); return; }
          resolve(resp);
        });
      } catch (e) { reject(e); }
    });
  }

  // ─────────────────────────────────────────────
  // チェックボックスを各物件行に差し込む（冪等）
  // ─────────────────────────────────────────────
  function injectCheckboxes() {
    if (!adapter) return;
    var rows;
    try { rows = adapter.collect() || []; } catch (e) { log('collect失敗', e); return; }
    rows.forEach(function (item) {
      var rowEl = item && item.rowEl;
      var prop = item && item.prop;
      if (!rowEl || !prop) return;
      var key = propKey(prop);
      if (rowEl[ASSIGN_KEY]) {
        // ページ再描画対策: 既存チェックボックスの prop/キーを最新化し、選択状態をストアから復元
        var existCb = rowEl[ASSIGN_KEY];
        selectedMap.set(existCb, prop);
        existCb.__propKey = key;
        existCb.checked = !!selection[key];
        return;
      }
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = '__manual-send-cb';
      cb.style.cssText = [
        'position:absolute', 'top:6px', 'left:6px',
        'width:24px', 'height:24px', 'z-index:99998', 'cursor:pointer',
        'accent-color:#1a7f37', 'border-radius:4px', 'background:#fff',
        'box-shadow:0 0 0 2px #fff,0 1px 5px rgba(0,0,0,.35)', 'margin:0'
      ].join(';');
      cb.title = 'LINEで送る物件として選択';
      cb.__propKey = key;
      cb.checked = !!selection[key]; // 別ページで既に選択済みなら復元
      cb.addEventListener('change', onCbChange);
      cb.addEventListener('click', function (ev) { ev.stopPropagation(); });
      // 行に相対位置を付与してチェックボックスを重ねる
      var pos = window.getComputedStyle(rowEl).position;
      if (pos === 'static' || !pos) rowEl.style.position = 'relative';
      cb.__rowEl = rowEl; // 競合数・順位バッジ表示で行要素を辿るため保持
      rowEl.appendChild(cb);
      rowEl[ASSIGN_KEY] = cb;
      selectedMap.set(cb, prop);
    });
    updateCount();
  }

  // 送信対象は「カート全体（全サイト横断）」。各要素 = { source, enriched, prop }
  function getCartItems() {
    var items = [];
    Object.keys(selection).forEach(function (k) { if (selection[k]) items.push(selection[k]); });
    return items;
  }

  // 競合数・順位バッジ／SUUMO掲載は現在ページの選択のみ対象（off-pageや別サイトは不可）
  function getCurrentPageCheckedItems() {
    var items = [];
    selectedMap.forEach(function (prop, cb) {
      if (!document.body.contains(cb)) return;
      var key = cb.__propKey;
      if (key && selection[key]) items.push({ rowEl: cb.__rowEl || null, prop: prop });
    });
    return items;
  }

  // 件数のソース別内訳ラベル
  function countBySourceLabel(items) {
    var by = { reins: 0, ielove: 0, itandi: 0, other: 0 };
    items.forEach(function (it) { if (by[it.source] === undefined) by.other++; else by[it.source]++; });
    var parts = [];
    if (by.reins) parts.push('REINS' + by.reins);
    if (by.ielove) parts.push('いえらぶ' + by.ielove);
    if (by.itandi) parts.push('itandi' + by.itandi);
    if (by.other) parts.push('他' + by.other);
    return parts.join('/');
  }

  // 現在ページの物件をまとめて選択/解除（REINSは1件ずつ詳細取得して追加）
  function setAllChecked(checked) {
    if (!checked) {
      selectedMap.forEach(function (prop, cb) {
        if (!document.body.contains(cb)) return;
        var k = cb.__propKey || propKey(prop);
        if (selection[k]) { delete selection[k]; cb.checked = false; }
      });
      saveSelection();
      updateCount();
      return;
    }
    var targets = [];
    selectedMap.forEach(function (prop, cb) {
      if (!document.body.contains(cb)) return;
      var k = cb.__propKey || propKey(prop);
      if (!selection[k]) targets.push({ cb: cb, prop: prop, key: k });
    });
    var src = curSource();
    // 全選択でも詳細ページは開かない。競合チェックや順位は一覧の情報だけで動くし、
    // 詳細が要る操作（送信・SUUMO掲載・依頼書）はボタンを押した時にまとめて取る。
    // 以前はREINSだけ1件ずつ詳細ページを開いていて、全選択に何十秒もかかっていた。
    targets.forEach(function (t) {
      if (t.prop && !t.prop.source) t.prop.source = src;
      selection[t.key] = { source: src, enriched: null, prop: t.prop };
      t.cb.checked = true;
    });
    saveSelection();
    updateCount();
    if (src === 'reins' && targets.length) {
      setStatus(targets.length + '件を選択しました（REINSは結果一覧のページを移る前に実行してください）', '#1a7f37');
    }
  }

  function updateCount() {
    var items = getCartItems();
    var n = items.length;
    if (countEl) {
      var label = countBySourceLabel(items);
      countEl.textContent = n + '件選択中（全サイト' + (label ? ': ' + label : '') + '）';
    }
    if (sendBtn) sendBtn.disabled = (n === 0);
    if (watchBtn) watchBtn.disabled = (n === 0);
  }

  // ─────────────────────────────────────────────
  // パネル UI
  // ─────────────────────────────────────────────
  function buildPanel() {
    panelEl = document.createElement('div');
    panelEl.id = '__manual-send-panel';
    panelEl.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483646',
      'width:280px', 'background:#fff', 'border-radius:12px',
      'box-shadow:0 4px 20px rgba(0,0,0,.25)', 'font-family:sans-serif',
      'font-size:13px', 'color:#222', 'overflow:hidden'
    ].join(';');

    // ヘッダー
    var header = document.createElement('div');
    header.style.cssText = 'background:#1a7f37;color:#fff;padding:10px 12px;font-weight:bold;display:flex;justify-content:space-between;align-items:center;';
    var hTitle = document.createElement('span');
    hTitle.textContent = '物件をLINEで送る';
    var hToggle = document.createElement('span');
    hToggle.textContent = '－';
    hToggle.style.cssText = 'cursor:pointer;padding:0 6px;user-select:none;';
    header.appendChild(hTitle);
    header.appendChild(hToggle);

    // 本体
    var body = document.createElement('div');
    body.style.cssText = 'padding:12px;display:flex;flex-direction:column;gap:8px;';

    // 顧客セレクト
    var selLabel = document.createElement('label');
    selLabel.textContent = '送信先のお客さん';
    selLabel.style.cssText = 'font-size:12px;color:#666;';
    selectEl = document.createElement('select');
    selectEl.style.cssText = 'width:100%;padding:6px;border:1px solid #ccc;border-radius:6px;font-size:13px;box-sizing:border-box;';
    var optLoading = document.createElement('option');
    optLoading.value = '';
    optLoading.textContent = '読み込み中…';
    selectEl.appendChild(optLoading);

    // 選択操作
    var selRow = document.createElement('div');
    selRow.style.cssText = 'display:flex;gap:6px;';
    var btnAll = mkSmallBtn('全選択', function () { setAllChecked(true); });
    var btnNone = mkSmallBtn('全解除', function () { setAllChecked(false); });
    var btnClear = mkSmallBtn('クリア', function () { clearAllSelection(); });
    var btnRescan = mkSmallBtn('再スキャン', function () { injectCheckboxes(); });
    btnAll.title = '現在ページの物件を全選択';
    btnNone.title = '現在ページの選択を解除';
    btnClear.title = '全ページの選択をクリア';
    selRow.appendChild(btnAll);
    selRow.appendChild(btnNone);
    selRow.appendChild(btnClear);
    selRow.appendChild(btnRescan);

    // 件数表示
    countEl = document.createElement('div');
    countEl.style.cssText = 'font-size:12px;color:#666;';
    countEl.textContent = '0件選択中（全ページ）';

    // 送信ボタン
    sendBtn = document.createElement('button');
    sendBtn.textContent = '選択した物件をLINEで送る';
    sendBtn.style.cssText = 'width:100%;padding:10px;background:#1a7f37;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:bold;cursor:pointer;';
    sendBtn.disabled = true;
    sendBtn.addEventListener('click', onSendClick);

    // 送らずにキャンセル待ちだけ登録する。
    // 申込ありで今は送れない物件を「空きが出たら教えて」の状態にしておく用途。
    watchBtn = document.createElement('button');
    watchBtn.textContent = '⏳ 選択した物件をキャンセル待ちに追加';
    watchBtn.title = 'お客様には送りません。空きが出たらDiscordに通知され、自動検索でも拾えるようになります';
    watchBtn.style.cssText = 'width:100%;padding:8px;margin-top:6px;background:#2d2d2d;color:#ddd;border:1px solid #555;border-radius:8px;font-size:12px;cursor:pointer;';
    watchBtn.disabled = true;
    watchBtn.addEventListener('click', onWatchClick);

    // 競合数・順位を調べるボタン
    metricsBtn = mkActionBtn('競合数・順位を調べる', '#0b66c3', onCheckMetricsClick);
    // SUUMOに掲載ボタン
    publishBtn = mkActionBtn('SUUMOに掲載', '#e67e22', onPublishSuumoClick);
    // 内見依頼書・広告掲載依頼書をPDFで作るボタン
    docBtn = mkActionBtn('📄 内見 / 広告掲載 依頼書を作る', '#6b4fbb', onMakeDocClick);
    docBtn.title = '選択した物件の内見依頼書／広告掲載依頼書をPDFで作ります';

    // ステータス
    statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:12px;color:#666;min-height:16px;white-space:pre-wrap;';

    body.appendChild(selLabel);
    body.appendChild(selectEl);
    body.appendChild(selRow);
    body.appendChild(countEl);
    body.appendChild(sendBtn);
    body.appendChild(watchBtn);

    // 外部スクリプト（bulk-competitor-panel.js の「競合チェック」）がボタンを差し込むスロット。
    // 従来は画面右下に浮いていてパネルに隠れていたため、パネル内に統合する。
    var compSlot = document.createElement('div');
    compSlot.id = '__msp-comp-slot';
    compSlot.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    body.appendChild(compSlot);

    // 手動: 順位検索の設備条件（一覧に設備情報が無いため手動指定）。順位検索の tc に反映。
    var equipRow = document.createElement('div');
    equipRow.style.cssText = 'display:flex;gap:10px;font-size:11px;color:#444;align-items:center;flex-wrap:wrap;margin:2px 0 0;';
    var equipHint = document.createElement('span');
    equipHint.textContent = '順位の設備条件:';
    equipHint.style.color = '#888';
    equipRow.appendChild(equipHint);
    function _mkEquipCb(t) {
      var lbl = document.createElement('label');
      lbl.style.cssText = 'display:flex;align-items:center;gap:3px;cursor:pointer;';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.style.cursor = 'pointer';
      lbl.appendChild(cb); lbl.appendChild(document.createTextNode(t));
      equipRow.appendChild(lbl);
      return cb;
    }
    equipBtCb = _mkEquipCb('バス・トイレ別');
    equipWashCb = _mkEquipCb('独立洗面台');

    body.appendChild(equipRow);
    body.appendChild(metricsBtn);
    body.appendChild(publishBtn);
    body.appendChild(docBtn);
    body.appendChild(statusEl);

    panelEl.appendChild(header);
    panelEl.appendChild(body);
    document.body.appendChild(panelEl);

    // 折りたたみ
    hToggle.addEventListener('click', function () {
      var hidden = body.style.display === 'none';
      body.style.display = hidden ? 'flex' : 'none';
      hToggle.textContent = hidden ? '－' : '＋';
    });
  }

  function mkSmallBtn(label, onClick) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'flex:1;padding:5px 0;background:#f0f0f0;border:1px solid #ddd;border-radius:6px;font-size:12px;cursor:pointer;';
    b.addEventListener('click', onClick);
    return b;
  }

  // フルワイドのアクションボタン（送信ボタンと同サイズ）
  function mkActionBtn(label, color, onClick) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'width:100%;padding:9px;background:' + color + ';color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:bold;cursor:pointer;';
    b.addEventListener('click', onClick);
    return b;
  }

  function setStatus(text, color) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.style.color = color || '#666';
  }

  // ─────────────────────────────────────────────
  // 顧客一覧と検索コンテキスト顧客を取得してセレクトに反映
  // ─────────────────────────────────────────────
  function loadContext() {
    sendToBackground({ type: 'GET_MANUAL_SEND_CONTEXT' }).then(function (resp) {
      var customers = (resp && resp.customers) || [];
      var contextCustomer = (resp && resp.contextCustomer) || '';
      selectEl.innerHTML = '';
      var ph = document.createElement('option');
      ph.value = '';
      ph.textContent = customers.length ? '（お客さんを選択）' : '（顧客が取得できません）';
      selectEl.appendChild(ph);
      customers.forEach(function (name) {
        var o = document.createElement('option');
        o.value = name;
        o.textContent = name;
        if (name === contextCustomer) o.selected = true;
        selectEl.appendChild(o);
      });
      if (contextCustomer) setStatus('検索中のお客さん「' + contextCustomer + '」を選択しました', '#1a7f37');
    }).catch(function (e) {
      log('顧客取得失敗', e);
      selectEl.innerHTML = '';
      var o = document.createElement('option');
      o.value = '';
      o.textContent = '（顧客取得に失敗）';
      selectEl.appendChild(o);
      setStatus('顧客一覧の取得に失敗しました: ' + e.message, '#c0392b');
    });
  }

  // ─────────────────────────────────────────────
  // 送信
  // ─────────────────────────────────────────────
  function onSendClick() {
    var customerName = selectEl.value;
    if (!customerName) { setStatus('送信先のお客さんを選んでください', '#c0392b'); return; }
    var items = getCartItems(); // 全サイト横断のカート
    if (items.length === 0) { setStatus('送る物件を選んでください', '#c0392b'); return; }

    var label = countBySourceLabel(items);
    var confirmMsg = customerName + ' さん宛に ' + items.length + '件'
      + (label ? '（' + label + '）' : '')
      + 'を承認待ちに登録し、承認ページ（画像選択・追加）を開きます。\n'
      + 'いえらぶ/itandiは詳細取得のため少し時間がかかります。よろしいですか？';
    if (!window.confirm(confirmMsg)) return;

    sendBtn.disabled = true;
    setStatus('詳細取得・登録中…（' + items.length + '件）', '#666');
    sendToBackground({
      type: 'SEND_MANUAL_CART',
      customerName: customerName,
      items: items
    }).then(function (resp) {
      if (resp && resp.ok) {
        var color = (resp.skipped && resp.skipped > 0) ? '#b8860b' : '#1a7f37';
        setStatus(resp.message || ((resp.registered || 0) + '件を承認待ちに登録しました'), color);
        clearAllSelection(); // 送信成功 → カートをクリア
      } else {
        setStatus('失敗: ' + ((resp && (resp.message || resp.error)) || '不明なエラー'), '#c0392b');
      }
    }).catch(function (e) {
      setStatus('エラー: ' + e.message, '#c0392b');
    }).finally(function () {
      updateCount();
    });
  }

  // ─────────────────────────────────────────────
  // キャンセル待ちに追加（送らない）
  //
  // 申込ありなどで今は送れない物件を、空きが出たときに気づけるようにしておく。
  // お客様には何も届かない。通知済み物件シートに「送っていない印」つきで登録され、
  // 自動検索の対象からは外れない（募集中に戻れば通常どおり配信される）。
  // ─────────────────────────────────────────────
  function onWatchClick() {
    var customerName = selectEl.value;
    if (!customerName) { setStatus('お客さんを選んでください', '#c0392b'); return; }
    var items = getCartItems();
    if (items.length === 0) { setStatus('物件を選んでください', '#c0392b'); return; }

    var label = countBySourceLabel(items);
    if (!window.confirm(customerName + ' さんのキャンセル待ちに ' + items.length + '件'
      + (label ? '（' + label + '）' : '') + 'を追加します。\n'
      + 'お客様には送りません。空きが出たらDiscordに通知されます。\nよろしいですか？')) return;

    watchBtn.disabled = true;
    setStatus('キャンセル待ちに登録中…（' + items.length + '件）', '#666');
    sendToBackground({
      type: 'ADD_MANUAL_CART_TO_WATCH',
      customerName: customerName,
      items: items
    }).then(function (resp) {
      if (resp && resp.ok) {
        setStatus(resp.message || ((resp.added || 0) + '件をキャンセル待ちに追加しました'), '#1a7f37');
        clearAllSelection();
      } else {
        setStatus('失敗: ' + ((resp && (resp.message || resp.error)) || '不明なエラー'), '#c0392b');
      }
    }).catch(function (e) {
      setStatus('エラー: ' + e.message, '#c0392b');
    }).finally(function () {
      updateCount();
    });
  }

  // ─────────────────────────────────────────────
  // 競合数・順位を調べる
  // ─────────────────────────────────────────────
  function onCheckMetricsClick() {
    var items = getCurrentPageCheckedItems(); // バッジ表示は現在ページの選択のみ
    if (items.length === 0) { setStatus('調べる物件を選んでください', '#c0392b'); return; }
    lastMetricItems = items; // MANUAL_METRICS_PROGRESS の index→rowEl 対応に使う
    metricsBtn.disabled = true;
    setStatus('競合数・順位を計算中…（' + items.length + '件）', '#666');
    // 計算中はバッジを「計算中」に
    items.forEach(function (it) { if (it.rowEl) renderMetricBadge(it.rowEl, { pending: true }); });
    sendToBackground({
      type: 'CHECK_SUUMO_METRICS',
      source: adapter && adapter.source,
      equip: {
        btSeparate: !!(equipBtCb && equipBtCb.checked),
        washbasin: !!(equipWashCb && equipWashCb.checked)
      },
      properties: items.map(function (x) { return x.prop; })
    }).then(function (resp) {
      if (resp && resp.ok) {
        setStatus((resp.done || items.length) + '件の競合数・順位を表示しました', '#1a7f37');
      } else {
        setStatus('失敗: ' + ((resp && (resp.message || resp.error)) || '不明なエラー'), '#c0392b');
      }
    }).catch(function (e) {
      setStatus('エラー: ' + e.message, '#c0392b');
    }).finally(function () {
      if (metricsBtn) metricsBtn.disabled = false;
    });
  }

  // ─────────────────────────────────────────────
  // SUUMOに掲載（詳細取得→SUUMO候補登録→SUUMO承認ページを開く）
  // ─────────────────────────────────────────────
  function onPublishSuumoClick() {
    // SUUMO掲載は現在ページ（このサイト）の選択のみ対象
    var props = getCurrentPageCheckedItems().map(function (x) { return x.prop; });
    if (props.length === 0) { setStatus('掲載する物件を選んでください（このページの選択が対象）', '#c0392b'); return; }
    if (!window.confirm(props.length + '件の詳細を取得してSUUMO候補に登録し、SUUMO承認ページを開きます。\n各物件の詳細ページを開くため少し時間がかかります。よろしいですか？')) return;
    publishBtn.disabled = true;
    setStatus('詳細を取得してSUUMO候補に登録中…（' + props.length + '件）', '#666');
    sendToBackground({
      type: 'PUBLISH_TO_SUUMO',
      source: adapter && adapter.source,
      properties: props
    }).then(function (resp) {
      if (resp && resp.ok) {
        var color = (resp.skipped && resp.skipped > 0) ? '#b8860b' : '#1a7f37';
        setStatus(resp.message || ((resp.opened || 0) + '件のSUUMO承認ページを開きました'), color);
        setAllChecked(false); // 掲載した現在ページ分のみ選択解除（他サイトのカートは保持）
      } else {
        setStatus('失敗: ' + ((resp && (resp.message || resp.error)) || '不明なエラー'), '#c0392b');
      }
    }).catch(function (e) {
      setStatus('エラー: ' + e.message, '#c0392b');
    }).finally(function () {
      if (publishBtn) publishBtn.disabled = false;
      updateCount();
    });
  }


  // ─────────────────────────────────────────────
  // 内見依頼書・広告掲載依頼書をPDFで作る
  //
  // 元付会社名は一覧ページには出ていないので、詳細ページを開いて取ってくる
  // （SUUMO掲載と同じ仕組み）。取れた値をフォームに入れて、直せるようにしておく。
  // ─────────────────────────────────────────────
  function onMakeDocClick() {
    if (docFormEl) { closeDocForm(); return; }
    var items = getCartItems();
    if (items.length === 0) { setStatus('依頼書を作る物件を選んでください', '#c0392b'); return; }

    // 依頼書に要るのは 元付会社名 / 物件名 / 部屋番号 の3つだけ。
    // カートの時点で揃っていれば詳細ページを開く必要がない（REINSは一覧に商号がある。
    // 選択時に詳細を取っているソースも同様）。開くと1件あたり数秒かかるので、
    // 揃っているなら即フォームを出す。
    var quick = quickPrepFromCart(items);
    if (quick) { applyPrep(quick); return; }

    docBtn.disabled = true;
    setStatus('物件の詳細を取得中…（画像は取りません）', '#666');
    sendToBackground({ type: 'REQUEST_DOC_PREP', items: items }).then(function (resp) {
      if (!resp || !resp.ok) {
        setStatus('失敗: ' + ((resp && resp.error) || '不明なエラー'), '#c0392b');
        return;
      }
      applyPrep(resp);
    }).catch(function (e) {
      setStatus('エラー: ' + e.message, '#c0392b');
    }).finally(function () {
      if (docBtn) docBtn.disabled = false;
    });
  }

  // 取得できた内容をフォームに反映する（一覧から即・詳細取得後 のどちらでも通る）
  function applyPrep(resp) {
    if (resp.multiBuilding) {
      setStatus('別の建物が混ざっています（' + resp.buildings.join(' / ') + '）。依頼書は1建物ずつ作ってください。', '#c0392b');
      return;
    }
    if (!resp.company) {
      // 元付電話番号が取れているかで、DOMごと外したのか会社名だけ空なのかが分かる
      setStatus('元付会社名が取れませんでした（元付TEL: ' + (resp.ownerPhone || 'なし')
        + '）。手で入れてください。詳しくは拡張のログを見てください。', '#b8860b');
    } else {
      setStatus('');
    }
    openDocForm(resp);
  }

  // カートの中身だけで依頼書のフォームを埋められるか試す。
  // 埋められなければ null を返し、詳細取得にまわす。
  function quickPrepFromCart(items) {
    var companies = [];
    var buildings = [];
    var rooms = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var p = it.prop || {};
      var e = it.enriched || {};
      // REINSの一覧は「商号」を持っている。詳細取得済みなら owner_company。
      var company = String(e.owner_company || p.owner_company || e.reins_shougo || p.shougo || '').trim();
      var building = String(e.building_name || p.buildingName || p.building_name || '').trim();
      var room = String(e.room_number || p.roomNumber || p.room_number || '').trim();
      if (!company || !building) return null;   // 1件でも欠けたら詳細取得へ
      // REINSの一覧には部屋番号が無い。依頼書には要るので詳細を開くしかない。
      // （そのときも画像は取らないので、送信時の詳細取得よりはずっと速い）
      if (it.source === 'reins' && !room) return null;
      if (companies.indexOf(company) < 0) companies.push(company);
      if (buildings.indexOf(building) < 0) buildings.push(building);
      if (room && rooms.indexOf(room) < 0) rooms.push(room);
    }
    if (!buildings.length) return null;
    return {
      ok: true,
      company: companies[0],
      ownerPhone: '',
      building: buildings[0],
      rooms: rooms,
      multiBuilding: buildings.length > 1,
      buildings: buildings,
      failed: []
    };
  }

  function closeDocForm() {
    if (docFormEl && docFormEl.parentNode) docFormEl.parentNode.removeChild(docFormEl);
    docFormEl = null;
  }

  function openDocForm(prep) {
    closeDocForm();

    var wrap = document.createElement('div');
    wrap.style.cssText = 'border:1px solid #d9d2f0;background:#f7f5ff;border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:7px;';

    function mkLabel(t) {
      var l = document.createElement('div');
      l.textContent = t;
      l.style.cssText = 'font-size:11px;color:#666;';
      return l;
    }
    function mkInput(value) {
      var i = document.createElement('input');
      i.type = 'text';
      i.value = value || '';
      i.style.cssText = 'width:100%;padding:5px 6px;border:1px solid #ccc;border-radius:5px;font-size:12px;box-sizing:border-box;';
      return i;
    }

    // 種類
    var kindRow = document.createElement('div');
    kindRow.style.cssText = 'display:flex;gap:10px;font-size:12px;';
    var kindViewing = document.createElement('input'); kindViewing.type = 'radio'; kindViewing.name = '__msp_doc_kind'; kindViewing.checked = true;
    var kindAd = document.createElement('input'); kindAd.type = 'radio'; kindAd.name = '__msp_doc_kind';
    [[kindViewing, '内見依頼書'], [kindAd, '広告掲載依頼書']].forEach(function (pair) {
      var l = document.createElement('label');
      l.style.cssText = 'display:flex;align-items:center;gap:3px;cursor:pointer;';
      l.appendChild(pair[0]);
      l.appendChild(document.createTextNode(pair[1]));
      kindRow.appendChild(l);
    });

    // 宛先・物件
    var companyIn = mkInput(prep.company);
    if (!prep.company) companyIn.placeholder = '元付会社名が取れませんでした。入力してください';
    var buildingIn = mkInput(prep.building);

    // 部屋番号（同じ建物の別の部屋も一緒に内見することがあるので複数行）
    var roomsBox = document.createElement('div');
    roomsBox.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    function addRoomInput(value) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:4px;';
      var inp = mkInput(value);
      inp.className = '__msp-doc-room';
      var del = document.createElement('button');
      del.textContent = '×';
      del.title = 'この部屋を消す';
      del.style.cssText = 'width:26px;flex:0 0 26px;border:1px solid #ccc;background:#fff;border-radius:5px;cursor:pointer;color:#888;';
      del.addEventListener('click', function () { row.remove(); });
      row.appendChild(inp);
      row.appendChild(del);
      roomsBox.appendChild(row);
      return inp;
    }
    var initialRooms = (prep.rooms && prep.rooms.length) ? prep.rooms : [''];
    initialRooms.forEach(function (r) { addRoomInput(r); });
    var addRoomBtn = document.createElement('button');
    addRoomBtn.textContent = '＋ 部屋を追加';
    addRoomBtn.style.cssText = 'padding:4px;background:#fff;border:1px dashed #b3a6e0;color:#6b4fbb;border-radius:5px;font-size:11px;cursor:pointer;';
    addRoomBtn.addEventListener('click', function () { addRoomInput('').focus(); });

    // 内見日・時間
    var dateIn = document.createElement('input');
    dateIn.type = 'date';
    dateIn.style.cssText = 'flex:1;padding:5px 6px;border:1px solid #ccc;border-radius:5px;font-size:12px;box-sizing:border-box;';
    var timeIn = mkInput('');
    timeIn.placeholder = '例: 17時半';
    timeIn.style.flex = '1';
    var whenRow = document.createElement('div');
    whenRow.style.cssText = 'display:flex;gap:5px;';
    whenRow.appendChild(dateIn);
    whenRow.appendChild(timeIn);

    // 広告媒体
    var mediaSel = document.createElement('select');
    mediaSel.style.cssText = 'width:100%;padding:5px 6px;border:1px solid #ccc;border-radius:5px;font-size:12px;box-sizing:border-box;';
    ['SUUMO', 'ForRent', 'SUUMO・ForRent'].forEach(function (m) {
      var o = document.createElement('option'); o.value = m; o.textContent = m; mediaSel.appendChild(o);
    });

    // 種類ごとに出し入れする行
    var roomsLabel = mkLabel('部屋番号');
    var whenLabel = mkLabel('内見日・時間');
    var mediaLabel = mkLabel('広告媒体');
    function syncKind() {
      var viewing = kindViewing.checked;
      // 部屋番号は広告掲載依頼書でも使う（欄が無いので物件名に続けて入る）
      roomsLabel.textContent = viewing ? '部屋番号' : '部屋番号（物件名の後ろに入ります）';
      [whenLabel, whenRow].forEach(function (el) { el.style.display = viewing ? '' : 'none'; });
      whenRow.style.display = viewing ? 'flex' : 'none';
      [mediaLabel, mediaSel].forEach(function (el) { el.style.display = viewing ? 'none' : ''; });
    }
    kindViewing.addEventListener('change', syncKind);
    kindAd.addEventListener('change', syncKind);

    var makeBtn = document.createElement('button');
    makeBtn.textContent = 'PDFを作る';
    makeBtn.style.cssText = 'width:100%;padding:8px;background:#6b4fbb;color:#fff;border:none;border-radius:7px;font-size:12px;font-weight:bold;cursor:pointer;';

    var closeBtn = document.createElement('button');
    closeBtn.textContent = '閉じる';
    closeBtn.style.cssText = 'width:100%;padding:5px;background:transparent;border:none;color:#888;font-size:11px;cursor:pointer;';
    closeBtn.addEventListener('click', closeDocForm);

    makeBtn.addEventListener('click', function () {
      var kind = kindViewing.checked ? 'viewing' : 'ad';
      var company = companyIn.value.trim();
      var building = buildingIn.value.trim();
      if (!company) { setStatus('会社名を入れてください', '#c0392b'); companyIn.focus(); return; }
      if (!building) { setStatus('物件名を入れてください', '#c0392b'); buildingIn.focus(); return; }

      var vals = [];
      roomsBox.querySelectorAll('.__msp-doc-room').forEach(function (i) {
        var v = i.value.trim();
        if (v && vals.indexOf(v) < 0) vals.push(v);
      });
      var rooms = vals.join('、');
      var date = '';
      var time = '';
      if (kind === 'viewing') {
        // 「8月26日」の形にする。テンプレートがこの書式で印刷される。
        if (dateIn.value) {
          var d = dateIn.value.split('-');
          date = Number(d[1]) + '月' + Number(d[2]) + '日';
        }
        time = timeIn.value.trim();
        if (!date) { setStatus('内見日を入れてください', '#c0392b'); dateIn.focus(); return; }
        if (!time) { setStatus('時間を入れてください', '#c0392b'); timeIn.focus(); return; }
      }

      makeBtn.disabled = true;
      setStatus('PDFを作成中…', '#666');
      sendToBackground({
        type: 'REQUEST_DOC_MAKE',
        kind: kind,
        company: company,
        building: building,
        rooms: rooms,
        date: date,
        time: time,
        media: mediaSel.value
      }).then(function (resp) {
        if (!resp || !resp.ok) {
          setStatus('失敗: ' + ((resp && resp.error) || '不明なエラー'), '#c0392b');
          return;
        }
        setStatus(resp.label + 'をダウンロードしました：' + resp.fileName, '#1a7f37');
        closeDocForm();
      }).catch(function (e) {
        setStatus('エラー: ' + e.message, '#c0392b');
      }).finally(function () {
        makeBtn.disabled = false;
      });
    });

    wrap.appendChild(kindRow);
    wrap.appendChild(mkLabel('宛先（元付会社名）'));
    wrap.appendChild(companyIn);
    wrap.appendChild(mkLabel('物件名'));
    wrap.appendChild(buildingIn);
    wrap.appendChild(roomsLabel);
    wrap.appendChild(roomsBox);
    wrap.appendChild(addRoomBtn);
    wrap.appendChild(whenLabel);
    wrap.appendChild(whenRow);
    wrap.appendChild(mediaLabel);
    wrap.appendChild(mediaSel);
    wrap.appendChild(makeBtn);
    wrap.appendChild(closeBtn);

    docBtn.parentNode.insertBefore(wrap, docBtn.nextSibling);
    docFormEl = wrap;
    syncKind();
  }


  // ─────────────────────────────────────────────
  // 競合数・順位バッジを行要素に表示（冪等）
  // ─────────────────────────────────────────────
  function renderMetricBadge(rowEl, m) {
    if (!rowEl) return;
    var pos = window.getComputedStyle(rowEl).position;
    if (pos === 'static' || !pos) rowEl.style.position = 'relative';
    var badge = rowEl.querySelector('.__metric-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = '__metric-badge';
      badge.style.cssText = [
        'position:absolute', 'top:6px', 'right:6px', 'z-index:99998',
        'background:#fff', 'border-radius:6px', 'padding:3px 7px',
        'font-size:11px', 'font-weight:bold', 'line-height:1.4',
        'box-shadow:0 1px 5px rgba(0,0,0,.35)', 'white-space:nowrap',
        'pointer-events:none', 'text-align:right'
      ].join(';');
      rowEl.appendChild(badge);
    }
    if (m.pending) {
      badge.style.color = '#888';
      badge.textContent = '計算中…';
      return;
    }
    if (m.error) {
      badge.style.color = '#c0392b';
      badge.textContent = '取得失敗';
      badge.title = m.error;
      return;
    }
    var esc = function (s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };
    var htmlLines = [];
    // 1行目: ポテンシャル順位（同条件・安い順での順位/母数。✅=1ページ目内 ⚠️=圏外）。
    //        URLがあればクリックで安い順検索を開ける。
    var rankTxt = (m.rank === null || m.rank === undefined)
      ? '—'
      : (m.rank + '位/' + (m.sampleSize != null ? m.sampleSize : '?') + '件');
    var badgeMark = (m.inPage1 === true) ? ' ✅' : (m.inPage1 === false ? ' ⚠️圏外' : '');
    var rankLineText = '順位 ' + rankTxt + badgeMark;
    if (m.rankUrl && m.rank !== null && m.rank !== undefined) {
      htmlLines.push('<div><a href="' + esc(m.rankUrl) + '" target="_blank" rel="noopener" ' +
        'style="color:inherit;text-decoration:underline;pointer-events:auto;cursor:pointer;">' +
        esc(rankLineText) + ' ↗</a></div>');
    } else {
      htmlLines.push('<div>' + esc(rankLineText) + '</div>');
    }
    // 2行目: 競合数（ハイライト=有料上位掲載のみカウント）。
    //        URLがあればSUUMO競合一覧を新タブで開けるリンクにする。
    var hlTotal = m.competitor ? ((m.competitor.withNameHighlighted || 0) + (m.competitor.withoutNameHighlighted || 0)) : null;
    if (hlTotal === null || hlTotal === undefined) {
      htmlLines.push('<div>競合 —</div>');
    } else {
      var wn = m.competitor.withNameHighlighted || 0;
      var wo = m.competitor.withoutNameHighlighted || 0;
      var compText = '競合 ' + hlTotal + '（名' + wn + '/無' + wo + '）';
      if (m.competitor.url) {
        htmlLines.push('<div><a href="' + esc(m.competitor.url) + '" target="_blank" rel="noopener" ' +
          'style="color:inherit;text-decoration:underline;pointer-events:auto;cursor:pointer;">' +
          esc(compText) + ' ↗</a></div>');
      } else {
        htmlLines.push('<div>' + esc(compText) + '</div>');
      }
    }
    badge.innerHTML = htmlLines.join('');
    // リンククリックが物件カードのクリックに伝播しないように
    var links = badge.querySelectorAll('a');
    for (var li = 0; li < links.length; li++) {
      links[li].addEventListener('click', function (ev) { ev.stopPropagation(); });
    }
    badge.title = '順位=同条件・安い順での順位/母数（✅1ページ目内 ⚠️圏外）。順位/競合をクリックでSUUMO検索を開く';
    // 1ページ目内=緑 / 圏外=赤 / 不明=グレー
    if (m.inPage1 === true) badge.style.color = '#1a7f37';
    else if (m.inPage1 === false) badge.style.color = '#c0392b';
    else badge.style.color = '#555';
  }

  // ─────────────────────────────────────────────
  // background からの進捗通知を受信（REINS詳細取得の進捗 / 競合数・順位）
  // ─────────────────────────────────────────────
  function onRuntimeMessage(msg) {
    if (!msg) return;
    if (msg.type === 'MANUAL_METRICS_PROGRESS') {
      var it = lastMetricItems[msg.index];
      if (it && it.rowEl) renderMetricBadge(it.rowEl, msg);
      var doneN = (msg.index || 0) + 1, totalN = msg.total || lastMetricItems.length;
      setStatus('競合数・順位を計算中… ' + doneN + '/' + totalN + '件', '#666');
      return;
    }
    if (msg.type !== 'MANUAL_SEND_PROGRESS') return;
    var done = msg.done || 0, total = msg.total || 0, skipped = msg.skipped || 0;
    var txt = '取得中… ' + done + '/' + total + '件';
    if (skipped > 0) txt += '（失敗' + skipped + '件）';
    setStatus(txt, '#666');
  }

  // ─────────────────────────────────────────────
  // DOM 変化を監視してチェックボックスを再差し込み（ページネーション/再描画対策）
  // ─────────────────────────────────────────────
  var rescanTimer = null;
  function observeMutations() {
    var observer = new MutationObserver(function () {
      if (rescanTimer) clearTimeout(rescanTimer);
      rescanTimer = setTimeout(injectCheckboxes, 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─────────────────────────────────────────────
  // 公開 API
  // ─────────────────────────────────────────────
  window.ManualSendPanel = {
    init: function (a) {
      adapter = a;
      var start = function () {
        // カート（全サイト横断）を読み込んでからUI構築
        loadSelection(function () {
          buildPanel();
          loadContext();
          injectCheckboxes();
          observeMutations();
          try { chrome.runtime.onMessage.addListener(onRuntimeMessage); } catch (e) {}
          // 他タブ/他サイトでカートが更新されたら同期（自分の保存はスキップ）
          try {
            chrome.storage.onChanged.addListener(function (changes, area) {
              if (area !== 'local' || !changes[CART_KEY]) return;
              if (suppressStorageSync) return;
              selection = changes[CART_KEY].newValue || {};
              syncCurrentPageChecks();
              updateCount();
            });
          } catch (e) {}
          log('初期化完了 source=' + (adapter && adapter.source));
        });
      };
      if (document.body) start();
      else window.addEventListener('DOMContentLoaded', start);
    },
    rescan: injectCheckboxes
  };
})();
