/**
 * essquare-content-detail.js
 * いい生活Square 物件詳細ページから情報をスクレイピングするコンテンツスクリプト
 * Python essquare_search/parsers.py:parse_detail_page() の移植
 *
 * 対象URL: https://rent.es-square.net/bukken/chintai/search/detail/*
 */

(() => {
  'use strict';

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'ESSQUARE_EXTRACT_DETAIL') {
      try {
        const result = extractDetail();
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return true;
    }

    if (msg.type === 'ESSQUARE_CHECK_LOGIN') {
      const isLoggedIn = !window.location.href.includes('/login');
      sendResponse({ ok: true, loggedIn: isLoggedIn });
      return true;
    }
  });

  function extractDetail() {
    const detail = {};
    const allText = document.body.innerText || '';

    // 1. 画像URL取得（物件画像、ジャンク画像を除外）
    const junkPattern = /okbiz|miibo|chatbot|faq-e-seikatsu|logo|icon|favicon|avatar|badge|placeholder|loading|spinner|es-service\.net|onetop|sfa_main_banner|e-bukken/i;
    const imgEls = document.querySelectorAll('img[src]');
    const seen = {};
    const imageUrls = [];
    for (const img of imgEls) {
      const src = img.src;
      if (!src || seen[src]) continue;
      if (junkPattern.test(src)) continue;
      // data URI やSVGを除外
      if (src.startsWith('data:') || src.endsWith('.svg')) continue;
      seen[src] = true;
      imageUrls.push(src);
    }
    detail.image_urls = imageUrls;

    // 2. テーブルベースの情報抽出（th/td パターン）
    const tables = document.querySelectorAll('table');
    const kvPairs = {};

    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      for (const row of rows) {
        const th = row.querySelector('th');
        const td = row.querySelector('td');
        if (th && td) {
          const key = th.textContent.trim();
          const value = td.textContent.trim();
          if (key && value) kvPairs[key] = value;
        }
      }
    }

    // 3. 定義リスト（dt/dd）からも抽出
    const dts = document.querySelectorAll('dt');
    for (const dt of dts) {
      const dd = dt.nextElementSibling;
      if (dd && dd.tagName === 'DD') {
        const key = dt.textContent.trim();
        const value = dd.textContent.trim();
        if (key && value) kvPairs[key] = value;
      }
    }

    // 4. MUIラベル付きdivからも抽出（ラベル + 値の隣接パターン）
    const allDivs = document.querySelectorAll('div');
    for (const div of allDivs) {
      const children = div.children;
      if (children.length !== 2) continue;
      const label = children[0]?.textContent?.trim();
      const value = children[1]?.textContent?.trim();
      if (label && value && label.length < 20 && value.length < 200) {
        if (!kvPairs[label]) kvPairs[label] = value;
      }
    }

    // 4.5. MUI Grid (xs-4ラベル + xs-8値) ペア抽出
    //   物件詳細のメイン情報（部屋向き、所在階、建物構造等）がこの構造
    const gridItems = document.querySelectorAll('.MuiGrid-root.MuiGrid-item');
    for (let i = 0; i < gridItems.length - 1; i++) {
      const item = gridItems[i];
      const next = gridItems[i + 1];
      if (item.className.includes('xs-4') && next.className.includes('xs-8')) {
        const label = item.textContent.trim();
        const value = next.textContent.trim();
        if (label && value && label.length < 30 && value.length < 500) {
          if (!kvPairs[label]) kvPairs[label] = value;
        }
      }
    }

    // 5. KVペアから各フィールドにマッピング
    const fieldMap = {
      '所在階': 'floor_text',
      '階数': 'floor_text',
      '構造': 'structure',
      '建物構造': 'structure',
      '総戸数': 'total_units',
      '契約種別': 'lease_type',
      '契約期間': 'contract_period',
      '更新料': 'renewal_fee',
      '入居可能日': 'move_in_date',
      '入居時期': 'move_in_date',
      '退去予定日': 'move_out_date',
      '退去予定': 'move_out_date',
      '内見開始日': 'preview_start_date',
      '日当たり': 'sunlight',
      '向き': 'sunlight',
      '方角': 'sunlight',
      '部屋向き': 'sunlight',
      '火災保険': 'fire_insurance',
      '鍵交換': 'key_exchange_fee',
      '鍵交換費': 'key_exchange_fee',
      '保証会社': 'guarantee_info',
      '保証金': 'guarantee_deposit',
      '駐車場': 'parking_fee',
      '駐輪場': 'bicycle_parking_fee',
      'バイク置場': 'motorcycle_parking_fee',
      'フリーレント': 'free_rent',
      '敷引き': 'shikibiki',
      '解約通知': 'cancellation_notice',
      '間取り詳細': 'layout_detail',
    };

    for (const [label, field] of Object.entries(fieldMap)) {
      if (kvPairs[label] && !detail[field]) {
        detail[field] = kvPairs[label];
      }
    }

    // 5.5. H3ラベル + 次の兄弟DIVから抽出（MUI Grid構造: 設備詳細セクション等）
    const h3s = document.querySelectorAll('h3');
    for (const h3 of h3s) {
      const key = h3.textContent.trim();
      const nextDiv = h3.nextElementSibling;
      if (key && nextDiv && nextDiv.tagName === 'DIV') {
        const value = nextDiv.textContent.trim();
        if (value && !kvPairs[key]) kvPairs[key] = value;
      }
    }

    // 6. 設備情報を結合（テーブルの「設備」系の値をまとめる）
    const facilityParts = [];
    for (const [key, value] of Object.entries(kvPairs)) {
      if (key.includes('設備') || key.includes('条件') || key.includes('その他') ||
          key.includes('備考') || key.includes('特徴') || key.includes('こだわり')) {
        facilityParts.push(value);
      }
    }
    // 設備以外にもページ全体から主要設備キーワードを抽出
    detail.facilities = facilityParts.join(' / ') || '';

    // 7. ステータス
    const knownStatuses = ['申込あり', '成約', '公開停止', '契約済み', '募集中'];
    let listingStatus = '';
    for (const s of knownStatuses) {
      if (allText.includes(s)) {
        listingStatus = s;
        break;
      }
    }
    detail.listing_status = listingStatus;

    // 8. 所在階をパース
    if (detail.floor_text) {
      const m = detail.floor_text.match(/(\d+)/);
      if (m) detail.floor = parseInt(m[1]);
    }

    return { ok: true, detail };
  }
})();
