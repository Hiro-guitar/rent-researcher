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
  var metricsBtn = null;
  var publishBtn = null;
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
    if (src === 'reins') {
      // REINSは表示中に詳細取得（取得後に結果一覧へ自動で戻る）
      cb.disabled = true;
      setStatus('REINS詳細を取得中…（取得後に結果一覧へ戻ります）', '#666');
      sendToBackground({ type: 'CAPTURE_REINS_DETAIL', property: prop }).then(function (resp) {
        if (resp && resp.ok && resp.detail) {
          selection[key] = { source: 'reins', enriched: resp.detail, prop: prop };
          saveSelection();
          setStatus('カートに追加しました（REINS）', '#1a7f37');
        } else {
          cb.checked = false;
          setStatus('REINS詳細の取得に失敗しました: ' + ((resp && resp.error) || ''), '#c0392b');
        }
      }).catch(function (e) {
        cb.checked = false;
        setStatus('REINS取得エラー: ' + e.message, '#c0392b');
      }).finally(function () {
        cb.disabled = false;
        updateCount();
      });
    } else {
      // いえらぶ/itandi等は一覧情報のみカートへ（詳細は送信時に取得）
      if (prop && !prop.source) prop.source = src;
      selection[key] = { source: src, enriched: null, prop: prop };
      saveSelection();
      updateCount();
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
    if (src !== 'reins') {
      targets.forEach(function (t) {
        if (t.prop && !t.prop.source) t.prop.source = src;
        selection[t.key] = { source: src, enriched: null, prop: t.prop };
        t.cb.checked = true;
      });
      saveSelection();
      updateCount();
      return;
    }
    // REINS: 順次キャプチャ（並列で詳細ページを開くとREINSが壊れるため1件ずつ）
    var i = 0;
    function next() {
      if (i >= targets.length) { setStatus('全選択の取得が完了しました', '#1a7f37'); updateCount(); return; }
      var t = targets[i];
      t.cb.disabled = true;
      setStatus('REINS詳細を取得中…（' + (i + 1) + '/' + targets.length + '）', '#666');
      sendToBackground({ type: 'CAPTURE_REINS_DETAIL', property: t.prop }).then(function (resp) {
        if (resp && resp.ok && resp.detail) {
          selection[t.key] = { source: 'reins', enriched: resp.detail, prop: t.prop };
          t.cb.checked = true;
          saveSelection();
        } else {
          t.cb.checked = false;
        }
      }).catch(function () { t.cb.checked = false; })
        .finally(function () { t.cb.disabled = false; updateCount(); i++; next(); });
    }
    if (targets.length === 0) { updateCount(); return; }
    setStatus('REINS詳細を順番に取得します…（' + targets.length + '件）', '#666');
    next();
  }

  function updateCount() {
    var items = getCartItems();
    var n = items.length;
    if (countEl) {
      var label = countBySourceLabel(items);
      countEl.textContent = n + '件選択中（全サイト' + (label ? ': ' + label : '') + '）';
    }
    if (sendBtn) sendBtn.disabled = (n === 0);
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

    // 競合数・順位を調べるボタン
    metricsBtn = mkActionBtn('競合数・順位を調べる', '#0b66c3', onCheckMetricsClick);
    // SUUMOに掲載ボタン
    publishBtn = mkActionBtn('SUUMOに掲載', '#e67e22', onPublishSuumoClick);

    // ステータス
    statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:12px;color:#666;min-height:16px;white-space:pre-wrap;';

    body.appendChild(selLabel);
    body.appendChild(selectEl);
    body.appendChild(selRow);
    body.appendChild(countEl);
    body.appendChild(sendBtn);
    body.appendChild(metricsBtn);
    body.appendChild(publishBtn);
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
    var compTotal = m.competitor ? m.competitor.total : null;
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
    // 2行目: 競合数（withName/withoutName はHL込みの総数。total = 名 + 無）。
    //        URLがあればSUUMO競合一覧を新タブで開けるリンクにする。
    if (compTotal === null || compTotal === undefined) {
      htmlLines.push('<div>競合 —</div>');
    } else {
      var wn = m.competitor.withName || 0;
      var wo = m.competitor.withoutName || 0;
      var compText = '競合 ' + compTotal + '（名' + wn + '/無' + wo + '）';
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
