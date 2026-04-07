/**
 * content-search.js
 * REINS検索結果ページ（GBK002200）／条件検索フォーム（GBK001310）／物件番号検索（GBK004100）で動作
 *
 * DOM構造:
 *   .p-table > .p-table-body > .p-table-body-row（各物件、32カラム）
 *   各カラム: .p-table-body-item
 *     [0] No, [3] 物件番号, [4] 物件種目, [5] 面積, [6] 所在地,
 *     [8] 賃料, [11] 建物名, [12] 所在階, [13] 間取, [15] 管理費,
 *     [18] 沿線駅, [19] 徒歩, [24] 商号, [26] 築年月, [28] 電話
 *   ボタン: 概要(0), 詳細(1), 図面(2) — 各行内のbutton要素
 *   ページネーション: .page-link
 */

(function () {
  'use strict';

  // background.js からのメッセージを受信
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CHECK_LOGIN') {
      sendResponse({ loggedIn: isLoggedIn() });
      return;
    }

    if (msg.type === 'EXTRACT_SEARCH_RESULTS') {
      try {
        const results = extractSearchResults();
        sendResponse({ success: true, results });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return;
    }

    if (msg.type === 'CLICK_DETAIL_BUTTON') {
      try {
        clickDetailButton(msg.index);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return;
    }

    if (msg.type === 'GET_TOTAL_PAGES') {
      try {
        const info = getPageInfo();
        sendResponse({ success: true, ...info });
      } catch (err) {
        sendResponse({ success: false, error: err.message, totalPages: 1, currentPage: 1 });
      }
      return;
    }

    if (msg.type === 'GO_TO_PAGE') {
      try {
        goToPage(msg.page);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return;
    }

    // 検索フォーム操作（GBK001310用）
    if (msg.type === 'FILL_SEARCH_FORM') {
      try {
        fillSearchForm(msg.criteria);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return;
    }

    if (msg.type === 'SUBMIT_SEARCH') {
      try {
        submitSearch();
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return;
    }
  });

  // ページロード時にログイン状態を通知
  chrome.runtime.sendMessage({ type: 'LOGIN_STATUS', loggedIn: isLoggedIn() });

  // 物件番号オートサーチは background.js 側で処理する（content scriptからは行わない）

  // --- ログイン検出 ---
  function isLoggedIn() {
    return !location.href.includes('login') &&
           !location.href.includes('GKG001') &&
           document.body.textContent.length > 100;
  }

  // --- 検索結果から物件一覧を抽出 ---
  function extractSearchResults() {
    const rows = document.querySelectorAll('.p-table-body-row');
    if (rows.length === 0) {
      return [];
    }

    const results = [];
    rows.forEach((row, index) => {
      const items = row.querySelectorAll(':scope > .p-table-body-item');
      if (items.length < 20) return;

      const propertyNumber = getText(items[3]);
      if (!propertyNumber) return;

      const rent = getText(items[8]);
      const rentYen = parseRent(rent);

      results.push({
        index,
        propertyNumber,
        propertyType: getText(items[4]),
        area: getText(items[5]),
        address: getText(items[6]),
        rent,
        rentYen,
        managementFee: getText(items[15]),
        buildingName: getText(items[11]),
        floor: getText(items[12]),
        layout: normalizeLayout(getText(items[13])),
        line: getText(items[18]),
        walk: getText(items[19]),
        builtDate: getText(items[26]),
        shougo: getText(items[24]),
        tel: getText(items[28])
      });
    });

    return results;
  }

  // --- 詳細ボタンクリック ---
  function clickDetailButton(index) {
    const rows = document.querySelectorAll('.p-table-body-row');
    if (index >= rows.length) {
      throw new Error(`行 ${index} が見つかりません（全${rows.length}行）`);
    }

    const buttons = rows[index].querySelectorAll('button');
    // buttons[0]=概要, buttons[1]=詳細, buttons[2]=図面
    const detailBtn = buttons[1];
    if (!detailBtn) {
      throw new Error(`行 ${index} に詳細ボタンがありません`);
    }
    // el.click() は Vue ハンドラに届かない場合があるため、完全なマウスシーケンスを dispatch
    detailBtn.scrollIntoView({ block: 'center' });
    const r = detailBtn.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0
    };
    try {
      detailBtn.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', pointerId: 1, isPrimary: true }));
    } catch (e) {}
    detailBtn.dispatchEvent(new MouseEvent('mousedown', opts));
    try {
      detailBtn.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse', pointerId: 1, isPrimary: true }));
    } catch (e) {}
    detailBtn.dispatchEvent(new MouseEvent('mouseup', opts));
    detailBtn.dispatchEvent(new MouseEvent('click', opts));
  }

  // --- ページネーション ---
  function getPageInfo() {
    const pageLinks = document.querySelectorAll('.page-link');
    let maxPage = 1;
    let currentPage = 1;

    pageLinks.forEach(link => {
      const num = parseInt(link.textContent.trim(), 10);
      if (!isNaN(num)) {
        if (num > maxPage) maxPage = num;
        // アクティブなページを検出
        const li = link.closest('li');
        if (li && li.classList.contains('active')) {
          currentPage = num;
        }
      }
    });

    // テキストからも情報取得: "1～50件 ／ 500件"
    const pageText = document.body.textContent.match(/(\d+)～(\d+)件\s*／\s*(\d+)件/);
    let totalItems = 0;
    if (pageText) {
      totalItems = parseInt(pageText[3], 10);
      const perPage = parseInt(pageText[2], 10) - parseInt(pageText[1], 10) + 1;
      if (perPage > 0) {
        maxPage = Math.ceil(totalItems / perPage);
      }
    }

    return { totalPages: maxPage, currentPage, totalItems };
  }

  function goToPage(page) {
    const pageLinks = document.querySelectorAll('.page-link');
    for (const link of pageLinks) {
      if (link.textContent.trim() === String(page)) {
        link.click();
        return;
      }
    }
    throw new Error(`ページ ${page} のリンクが見つかりません`);
  }

  // --- 検索フォーム操作（GBK001310用） ---
  function fillSearchForm(criteria) {
    // 物件種別1: 賃貸マンション(03)
    const typeSelect = document.querySelectorAll('select');
    for (const sel of typeSelect) {
      const options = [...sel.options];
      if (options.find(o => o.value === '03' && o.text.includes('賃貸マンション'))) {
        sel.value = '03';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }
    }

    // テキスト入力フィールド: ラベルテキストで特定
    const textInputs = document.querySelectorAll('input[type="text"]');

    // 都道府県名
    if (criteria.prefecture) {
      const prefInput = findInputByLabel('都道府県名', textInputs);
      if (prefInput) setInputValue(prefInput, criteria.prefecture);
    }

    // 所在地名1（市区町村）
    if (criteria.city) {
      const cityInput = findInputByLabel('所在地名１', textInputs);
      if (cityInput) setInputValue(cityInput, criteria.city);
    }

    // 沿線名
    if (criteria.lineName) {
      const lineInput = findInputByLabel('沿線名', textInputs);
      if (lineInput) setInputValue(lineInput, criteria.lineName);
    }

    // 駅名
    if (criteria.stationName) {
      const stationInputs = findInputsByLabel('駅名', textInputs);
      if (stationInputs.length > 0) setInputValue(stationInputs[0], criteria.stationName);
    }

    // 賃料の範囲入力（あれば）
    // TODO: 賃料フィルタの入力フィールドを特定して設定
  }

  function submitSearch() {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.trim() === '検索') {
        btn.click();
        return;
      }
    }
    throw new Error('検索ボタンが見つかりません');
  }

  // --- ユーティリティ ---
  function getText(el) {
    return el ? el.textContent.trim() : '';
  }

  function normalizeLayout(text) {
    if (!text) return '';
    return text
      .replace(/\s/g, '')
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, s =>
        String.fromCharCode(s.charCodeAt(0) - 0xFEE0)
      );
  }

  function parseRent(rentStr) {
    if (!rentStr) return 0;
    const normalized = rentStr.replace(/[０-９]/g, s =>
      String.fromCharCode(s.charCodeAt(0) - 0xFEE0)
    );
    const num = parseFloat(normalized.match(/[\d.]+/)?.[0] || '0');
    if (normalized.includes('万')) return Math.round(num * 10000);
    return Math.round(num);
  }

  function findInputByLabel(labelText, inputs) {
    for (const input of inputs) {
      const parent = input.closest('div, td');
      if (!parent) continue;
      const container = parent.parentElement;
      if (!container) continue;
      if (container.textContent.includes(labelText)) {
        return input;
      }
    }
    return null;
  }

  function findInputsByLabel(labelText, inputs) {
    const found = [];
    for (const input of inputs) {
      const parent = input.closest('div, td');
      if (!parent) continue;
      const container = parent.parentElement;
      if (!container) continue;
      if (container.textContent.includes(labelText)) {
        found.push(input);
      }
    }
    return found;
  }

  function setInputValue(input, value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
})();
