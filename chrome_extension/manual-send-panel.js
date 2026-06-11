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
  var lastMetricItems = []; // 競合数・点数の計算対象（index→rowEl対応の保持）

  // ─────────────────────────────────────────────
  // ページをまたいだ選択の保持
  //  sessionStorage に「選択した物件」を永続化する。これにより
  //  ・ページ送り（フルリロード/SPA）をしても選択が消えない
  //  ・別ページで選んだ物件もまとめて送れる
  //  キーはサイト（host）ごとに分離。送信成功時にクリアする。
  // ─────────────────────────────────────────────
  var STORE_KEY = '__manualSendSelection_' + (location.host || 'site');
  var selection = {}; // propKey -> prop（全ページ分の選択。これが送信対象の真実）

  function loadSelection() {
    try { selection = JSON.parse(sessionStorage.getItem(STORE_KEY) || '{}') || {}; }
    catch (e) { selection = {}; }
  }
  function saveSelection() {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(selection)); } catch (e) {}
  }
  // 物件を一意に識別するキー（camelCase/snake_case 両対応）
  function propKey(p) {
    if (!p) return '';
    if (p.url) return 'u:' + p.url;
    var b = p.buildingName || p.building_name || '';
    var r = p.roomNumber || p.room_number || '';
    var rent = p.rent || '';
    var st = p.stationInfo || p.station_info || '';
    return 'k:' + b + '|' + r + '|' + rent + '|' + st;
  }
  // チェックボックスの変更を選択ストアへ反映
  function onCbChange(ev) {
    var cb = ev && ev.currentTarget;
    if (!cb) return;
    var key = cb.__propKey;
    var prop = selectedMap.get(cb);
    if (!key) return;
    if (cb.checked) { if (prop) selection[key] = prop; }
    else { delete selection[key]; }
    saveSelection();
    updateCount();
  }
  // 全ページの選択をクリア
  function clearAllSelection() {
    selection = {};
    saveSelection();
    selectedMap.forEach(function (prop, cb) {
      if (document.body.contains(cb)) cb.checked = false;
    });
    updateCount();
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
      cb.__rowEl = rowEl; // 競合数・点数バッジ表示で行要素を辿るため保持
      rowEl.appendChild(cb);
      rowEl[ASSIGN_KEY] = cb;
      selectedMap.set(cb, prop);
    });
    updateCount();
  }

  // 送信対象は「全ページ分の選択ストア」。現在ページに無い物件も含む。
  function getCheckedProps() {
    var props = [];
    Object.keys(selection).forEach(function (k) { if (selection[k]) props.push(selection[k]); });
    return props;
  }

  // 競合数・点数バッジ表示用に行要素も一緒に返す（getCheckedProps と同じ並び）
  function getCheckedItems() {
    var items = [];
    selectedMap.forEach(function (prop, cb) {
      if (cb.checked && document.body.contains(cb)) {
        items.push({ rowEl: cb.__rowEl || null, prop: prop });
      }
    });
    return items;
  }

  // 現在ページに表示中の物件をまとめて選択/解除（ストアにも反映）
  function setAllChecked(checked) {
    selectedMap.forEach(function (prop, cb) {
      if (!document.body.contains(cb)) return;
      cb.checked = checked;
      var k = cb.__propKey || propKey(prop);
      if (checked) { if (prop) selection[k] = prop; }
      else { delete selection[k]; }
    });
    saveSelection();
    updateCount();
  }

  function updateCount() {
    var n = Object.keys(selection).length;
    if (countEl) countEl.textContent = n + '件選択中（全ページ）';
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

    // 競合数・反響予測点数を調べるボタン
    metricsBtn = mkActionBtn('競合数・反響点数を調べる', '#0b66c3', onCheckMetricsClick);
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
    var props = getCheckedProps();
    if (props.length === 0) { setStatus('送る物件を選んでください', '#c0392b'); return; }

    // REINS・いえらぶは詳細ページを開いて全情報を取得し、承認待ちに登録→承認ページを開く
    var src = adapter && adapter.source;
    var useApproval = src === 'reins' || src === 'ielove' || src === 'itandi';
    var confirmMsg = useApproval
      ? customerName + ' さん宛に ' + props.length + '件を承認待ちに登録し、承認ページ（画像選択・追加）を開きます。\n各物件の詳細ページを開いて情報を取得するため少し時間がかかります。よろしいですか？'
      : customerName + ' さんに ' + props.length + '件の物件をLINEで送信します。よろしいですか？';
    if (!window.confirm(confirmMsg)) return;

    sendBtn.disabled = true;
    setStatus(useApproval ? '詳細を取得して登録中…（' + props.length + '件）' : '送信中…（' + props.length + '件）', '#666');
    sendToBackground({
      type: 'SEND_MANUAL_PROPERTIES',
      customerName: customerName,
      source: src,
      fetchDetails: useApproval,
      properties: props
    }).then(function (resp) {
      if (resp && resp.ok) {
        var color = (resp.skipped && resp.skipped > 0) ? '#b8860b' : '#1a7f37';
        if (useApproval) {
          setStatus(resp.message || ((resp.registered || 0) + '件を承認待ちに登録しました'), color);
        } else {
          setStatus('送信しました: ' + (resp.message || (resp.sent + '件')), color);
        }
        clearAllSelection(); // 送信成功 → 全ページの選択をクリア
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
  // 競合数・反響予測点数を調べる
  // ─────────────────────────────────────────────
  function onCheckMetricsClick() {
    var items = getCheckedItems();
    if (items.length === 0) { setStatus('調べる物件を選んでください', '#c0392b'); return; }
    lastMetricItems = items; // MANUAL_METRICS_PROGRESS の index→rowEl 対応に使う
    metricsBtn.disabled = true;
    setStatus('競合数・反響点数を計算中…（' + items.length + '件）', '#666');
    // 計算中はバッジを「計算中」に
    items.forEach(function (it) { if (it.rowEl) renderMetricBadge(it.rowEl, { pending: true }); });
    sendToBackground({
      type: 'CHECK_SUUMO_METRICS',
      source: adapter && adapter.source,
      properties: items.map(function (x) { return x.prop; })
    }).then(function (resp) {
      if (resp && resp.ok) {
        setStatus((resp.done || items.length) + '件の競合数・点数を表示しました', '#1a7f37');
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
    var props = getCheckedProps();
    if (props.length === 0) { setStatus('掲載する物件を選んでください', '#c0392b'); return; }
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
        clearAllSelection(); // 掲載完了 → 全ページの選択をクリア
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
  // 競合数・点数バッジを行要素に表示（冪等）
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
    var scoreTxt = (m.score === null || m.score === undefined) ? '—' : String(m.score);
    var compTotal = m.competitor ? m.competitor.total : null;
    var htmlLines = [];
    // 1行目: 反響点数（相場が取れなかった場合は * を付け、駅徒歩・築年のみと示す）
    var scoreLine = '点 ' + scoreTxt + (m.scoreLabel ? ' ' + m.scoreLabel : '');
    var marketless = (!m.hasMarket && m.score !== null && m.score !== undefined);
    if (marketless) scoreLine += '*';
    htmlLines.push('<div>' + esc(scoreLine) + '</div>');
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
    var compLink = badge.querySelector('a');
    if (compLink) compLink.addEventListener('click', function (ev) { ev.stopPropagation(); });
    badge.title = marketless
      ? '＊相場データが取れず、駅徒歩・築年のみで算出（平米単価60%は未反映）／競合数をクリックでSUUMO競合一覧を開く'
      : '競合数をクリックでSUUMO競合一覧を開く';
    // スコア帯で色分け
    var sc = Number(m.score);
    if (isFinite(sc) && sc >= 80) badge.style.color = '#c0392b';
    else if (isFinite(sc) && sc >= 60) badge.style.color = '#1a7f37';
    else badge.style.color = '#555';
  }

  // ─────────────────────────────────────────────
  // background からの進捗通知を受信（REINS詳細取得の進捗 / 競合数・点数）
  // ─────────────────────────────────────────────
  function onRuntimeMessage(msg) {
    if (!msg) return;
    if (msg.type === 'MANUAL_METRICS_PROGRESS') {
      var it = lastMetricItems[msg.index];
      if (it && it.rowEl) renderMetricBadge(it.rowEl, msg);
      var doneN = (msg.index || 0) + 1, totalN = msg.total || lastMetricItems.length;
      setStatus('競合数・点数を計算中… ' + doneN + '/' + totalN + '件', '#666');
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
        loadSelection(); // 別ページで保存した選択を復元（ページ跨ぎ送付）
        buildPanel();
        loadContext();
        injectCheckboxes();
        observeMutations();
        try { chrome.runtime.onMessage.addListener(onRuntimeMessage); } catch (e) {}
        log('初期化完了 source=' + (adapter && adapter.source));
      };
      if (document.body) start();
      else window.addEventListener('DOMContentLoaded', start);
    },
    rescan: injectCheckboxes
  };
})();
