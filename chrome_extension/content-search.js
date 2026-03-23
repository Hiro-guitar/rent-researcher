/**
 * content-search.js
 * REINS検索結果ページから物件一覧を抽出する
 *
 * REINSの検索結果ページ（GBK001*）で動作
 * 検索結果の各行から物件番号と概要情報を取得し、
 * background.js に返す
 *
 * 注意: REINSの検索結果ページのDOM構造は実際にログインして確認・調整が必要
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

    if (msg.type === 'CLICK_PROPERTY_ROW') {
      // 指定されたインデックスの物件行をクリックして詳細ページに遷移
      try {
        clickPropertyRow(msg.index);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return;
    }

    if (msg.type === 'GET_TOTAL_PAGES') {
      try {
        const totalPages = getTotalPages();
        sendResponse({ success: true, totalPages });
      } catch (err) {
        sendResponse({ success: false, error: err.message, totalPages: 1 });
      }
      return;
    }
  });

  // ページロード時にログイン状態を通知
  chrome.runtime.sendMessage({ type: 'LOGIN_STATUS', loggedIn: isLoggedIn() });

  // --- ログイン検出 ---
  function isLoggedIn() {
    // 検索結果ページが表示できていればログイン済み
    // ログアウト状態ではログインページにリダイレクトされる
    return !location.href.includes('login') && document.body.textContent.length > 100;
  }

  // --- 検索結果から物件一覧を抽出 ---
  function extractSearchResults() {
    const results = [];

    // REINSの検索結果はテーブル形式で表示される
    // 以下は推定DOM構造 — 実際のREINSページで調整が必要

    // パターン1: テーブル行ベース
    const rows = document.querySelectorAll('table.list-table tbody tr, .search-result-row, .bukken-row');
    if (rows.length > 0) {
      rows.forEach((row, index) => {
        const result = extractFromTableRow(row, index);
        if (result) results.push(result);
      });
      return results;
    }

    // パターン2: カード/リストベース（REINSのSPA的な構造）
    const cards = document.querySelectorAll('.card.bukken, .property-card, .result-item');
    if (cards.length > 0) {
      cards.forEach((card, index) => {
        const result = extractFromCard(card, index);
        if (result) results.push(result);
      });
      return results;
    }

    // パターン3: p-label-title ベース（詳細ページと同じ構造の場合）
    // 検索結果にも .p-label-title が使われている可能性
    const propertyNumbers = [];
    const labels = document.querySelectorAll('.p-label-title');
    labels.forEach(label => {
      if (label.textContent.trim() === '\u7269\u4ef6\u756a\u53f7') { // 物件番号
        const container = label.closest('.p-label')?.parentElement;
        const value = container?.querySelector('.row .col')?.textContent.trim();
        if (value && !propertyNumbers.includes(value)) {
          propertyNumbers.push(value);
        }
      }
    });

    if (propertyNumbers.length > 0) {
      propertyNumbers.forEach((num, index) => {
        results.push({
          index,
          propertyNumber: num,
          summary: `\u7269\u4ef6\u756a\u53f7: ${num}` // 物件番号: XXX
        });
      });
      return results;
    }

    // 結果が取得できなかった場合
    console.warn('REINS検索結果の抽出に失敗: DOM構造を確認してください');
    return results;
  }

  function extractFromTableRow(row, index) {
    const cells = row.querySelectorAll('td');
    if (cells.length < 3) return null;

    // テーブル構造は推定 — 実際のREINSで調整
    const propertyNumber = cells[0]?.textContent.trim() || '';
    const buildingName = cells[1]?.textContent.trim() || '';
    const rentText = cells[2]?.textContent.trim() || '';

    if (!propertyNumber) return null;

    return {
      index,
      propertyNumber,
      summary: `${buildingName} ${rentText}`.trim()
    };
  }

  function extractFromCard(card, index) {
    // カード内のテキストから物件番号を探す
    const text = card.textContent;
    const numMatch = text.match(/\u7269\u4ef6\u756a\u53f7[:\s]*([A-Z0-9\-]+)/i); // 物件番号: XXX
    if (!numMatch) return null;

    return {
      index,
      propertyNumber: numMatch[1],
      summary: text.substring(0, 100).trim()
    };
  }

  // --- 物件行クリック（詳細ページへ遷移） ---
  function clickPropertyRow(index) {
    // 検索結果の行をクリックして詳細ページに遷移
    const clickables = document.querySelectorAll(
      'table.list-table tbody tr, .search-result-row, .bukken-row, .card.bukken, .property-card, .result-item'
    );

    if (index < clickables.length) {
      // リンクがあればクリック
      const link = clickables[index].querySelector('a');
      if (link) {
        link.click();
        return;
      }
      // リンクがなければ行自体をクリック
      clickables[index].click();
      return;
    }

    throw new Error(`\u884c ${index} \u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093`); // 行 N が見つかりません
  }

  // --- ページネーション ---
  function getTotalPages() {
    // ページネーション要素からの総ページ数取得
    // REINSの具体的な構造に合わせて調整が必要
    const paginationLinks = document.querySelectorAll('.pagination a, .pager a, nav[aria-label="pagination"] a');
    if (paginationLinks.length === 0) return 1;

    let maxPage = 1;
    paginationLinks.forEach(link => {
      const num = parseInt(link.textContent.trim(), 10);
      if (!isNaN(num) && num > maxPage) maxPage = num;
    });

    return maxPage;
  }
})();
