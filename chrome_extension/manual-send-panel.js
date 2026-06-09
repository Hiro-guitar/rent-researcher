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
      if (rowEl[ASSIGN_KEY]) {
        // ページ再描画対策: 既存チェックボックスの prop を最新化
        selectedMap.set(rowEl[ASSIGN_KEY], prop);
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
      cb.addEventListener('change', updateCount);
      cb.addEventListener('click', function (ev) { ev.stopPropagation(); });
      // 行に相対位置を付与してチェックボックスを重ねる
      var pos = window.getComputedStyle(rowEl).position;
      if (pos === 'static' || !pos) rowEl.style.position = 'relative';
      rowEl.appendChild(cb);
      rowEl[ASSIGN_KEY] = cb;
      selectedMap.set(cb, prop);
    });
    updateCount();
  }

  function getCheckedProps() {
    var props = [];
    selectedMap.forEach(function (prop, cb) {
      if (cb.checked && document.body.contains(cb)) props.push(prop);
    });
    return props;
  }

  function setAllChecked(checked) {
    selectedMap.forEach(function (prop, cb) {
      if (document.body.contains(cb)) cb.checked = checked;
    });
    updateCount();
  }

  function updateCount() {
    if (countEl) countEl.textContent = getCheckedProps().length + '件選択中';
    if (sendBtn) sendBtn.disabled = (getCheckedProps().length === 0);
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
    var btnRescan = mkSmallBtn('再スキャン', function () { injectCheckboxes(); });
    selRow.appendChild(btnAll);
    selRow.appendChild(btnNone);
    selRow.appendChild(btnRescan);

    // 件数表示
    countEl = document.createElement('div');
    countEl.style.cssText = 'font-size:12px;color:#666;';
    countEl.textContent = '0件選択中';

    // 送信ボタン
    sendBtn = document.createElement('button');
    sendBtn.textContent = '選択した物件をLINEで送る';
    sendBtn.style.cssText = 'width:100%;padding:10px;background:#1a7f37;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:bold;cursor:pointer;';
    sendBtn.disabled = true;
    sendBtn.addEventListener('click', onSendClick);

    // ステータス
    statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:12px;color:#666;min-height:16px;white-space:pre-wrap;';

    body.appendChild(selLabel);
    body.appendChild(selectEl);
    body.appendChild(selRow);
    body.appendChild(countEl);
    body.appendChild(sendBtn);
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
    var useApproval = src === 'reins' || src === 'ielove';
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
        setAllChecked(false);
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
  // background からの進捗通知を受信（REINS詳細取得の進捗）
  // ─────────────────────────────────────────────
  function onRuntimeMessage(msg) {
    if (!msg || msg.type !== 'MANUAL_SEND_PROGRESS') return;
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
