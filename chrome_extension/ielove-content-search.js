/**
 * ielove-content-search.js
 * いえらぶBB 検索結果ページ用 content script
 * Python ielove_search/parsers.py の parse_search_results() を JS DOM に移植
 *
 * 対象URL: https://bb.ielove.jp/ielovebb/rent/index/*
 */

(() => {
  'use strict';

  const IELOVE_BASE_URL = 'https://bb.ielove.jp';

  // === メッセージハンドラ ===
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'IELOVE_EXTRACT_SEARCH_RESULTS') {
      try {
        const properties = parseSearchResults();
        sendResponse({ ok: true, properties });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return true;
    }

    if (msg.type === 'IELOVE_GET_TOTAL_COUNT') {
      try {
        const count = parseTotalCount();
        sendResponse({ ok: true, count });
      } catch (err) {
        sendResponse({ ok: false, error: err.message, count: 0 });
      }
      return true;
    }

    if (msg.type === 'IELOVE_CHECK_LOGIN') {
      const isLoggedIn = !window.location.href.includes('/login');
      sendResponse({ ok: true, isLoggedIn });
      return true;
    }
  });

  // === 検索結果パーサー ===
  function parseSearchResults() {
    const properties = [];
    const cards = document.querySelectorAll('table.estate_list');

    for (const card of cards) {
      const prop = parseEstateCard(card);
      if (prop) properties.push(prop);
    }

    return properties;
  }

  // === 総件数パーサー ===
  function parseTotalCount() {
    const bodyText = document.body.innerText || '';
    // 「1,150 件中 1 - 30」
    let m = bodyText.match(/([\d,]+)\s*件中/);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10);

    // フォールバック: 「○件」
    m = bodyText.match(/([\d,]+)\s*件/);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10);

    return 0;
  }

  // === 物件カードパーサー ===
  function parseEstateCard(card) {
    // 物件ID (詳細リンクから)
    const link = card.querySelector('a[href*="/ielovebb/rent/detail/id/"]');
    if (!link) return null;
    const idMatch = link.href.match(/\/detail\/id\/(\d+)\//);
    if (!idMatch) return null;
    const propId = idMatch[1];

    // 物件名・部屋番号
    let buildingName = '';
    let roomNumber = '';
    const nameTable = card.querySelector('table.estate-name');
    if (nameTable) {
      const nameSpan = nameTable.querySelector('span.large-font');
      if (nameSpan) {
        // span 直下のテキストノードだけ取得（子要素のテキストは除外）
        const textParts = [];
        for (const child of nameSpan.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            const t = child.textContent.trim();
            if (t) textParts.push(t);
          } else {
            break; // <a> 等の子要素に到達したら停止
          }
        }
        const raw = textParts.join(' ');
        // 2つ以上の空白で分割 → 物件名 + 部屋番号
        const parts = raw.trim().split(/\s{2,}/);
        if (parts.length >= 2 && parts[parts.length - 1]) {
          buildingName = parts.slice(0, -1).join(' ');
          roomNumber = parts[parts.length - 1];
        } else if (parts.length > 0) {
          buildingName = parts[0];
        }
      }
    }

    // 賃料・管理費・住所・駅 (管理費を含むTD)
    let rent = 0;
    let managementFee = 0;
    let address = '';
    let stationInfo = '';

    for (const td of card.querySelectorAll('td')) {
      const text = td.textContent.trim();
      if (text.includes('管理費') && text.includes('円')) {
        [rent, managementFee, address, stationInfo] = parseRentTd(text);
        break;
      }
    }

    if (rent === 0) return null;

    // 詳細情報 (table.detail-info)
    let deposit = '';
    let keyMoney = '';
    let layout = '';
    let area = 0;
    let buildingAge = '';
    let moveOutDate = '';
    let previewStartDate = '';
    let moveInDate = '';

    const detailInfo = card.querySelector('table.detail-info');
    if (detailInfo) {
      for (const row of detailInfo.querySelectorAll('tr')) {
        const tds = row.querySelectorAll('td');
        const ths = row.querySelectorAll('th');
        if (tds.length > 0 && ths.length === 0) {
          const vals = Array.from(tds).map(td => td.textContent.trim());
          if (vals.length >= 4) {
            [deposit, keyMoney] = splitDepositKey(vals[0]);
            [layout, area] = splitLayoutArea(vals[1]);
            [buildingAge, moveOutDate] = splitAgeDate(vals[2]);
            [previewStartDate, moveInDate] = splitPreviewMovein(vals[3]);
          }
        }
      }
    }

    // 募集状況
    let listingStatus = '';
    const leasing = card.querySelector('table.leasing-detail-info');
    if (leasing) {
      for (const td of leasing.querySelectorAll('td')) {
        const text = td.textContent.trim();
        if (['募集中', '申込あり', '募集中（要確認）'].includes(text) || /^申込\d+件$/.test(text)) {
          listingStatus = text;
          break;
        }
      }
    }

    // 画像
    const imageUrl = extractCardImage(card);

    const detailUrl = `${IELOVE_BASE_URL}/ielovebb/rent/detail/id/${propId}/`;

    return {
      building_id: propId,
      room_id: `ielove_${propId}`,
      building_name: buildingName,
      room_number: roomNumber,
      address,
      rent,
      management_fee: managementFee,
      deposit,
      key_money: keyMoney,
      layout,
      area,
      building_age: buildingAge,
      station_info: stationInfo,
      listing_status: listingStatus,
      move_in_date: moveInDate,
      move_out_date: moveOutDate,
      preview_start_date: previewStartDate,
      image_url: imageUrl,
      url: detailUrl,
      source: 'ielove',
    };
  }

  // === 賃料TDパーサー ===
  function parseRentTd(rawText) {
    let rent = 0;
    let mgmt = 0;
    let address = '';
    let station = '';

    // HTMLのtextContentは大量の空白・改行を含むため正規化
    const text = rawText.replace(/\s+/g, ' ').trim();

    // 賃料
    const rm = text.match(/^([\d,]+)\s*円/);
    if (rm) {
      rent = parseInt(rm[1].replace(/,/g, ''), 10);
    }

    // 管理費 — 「1万5,000円」形式
    let mm = text.match(/管理費[・共益費]*[：:]\s*(\d+)\s*万\s*([\d,]+)\s*円/);
    if (mm) {
      mgmt = parseInt(mm[1], 10) * 10000 + parseInt(mm[2].replace(/,/g, ''), 10);
    } else {
      // 「10,000円」形式
      mm = text.match(/管理費[・共益費]*[：:]\s*([\d,]+)\s*円/);
      if (mm) {
        mgmt = parseInt(mm[1].replace(/,/g, ''), 10);
      } else {
        // 「1.5万円」形式
        mm = text.match(/管理費[・共益費]*[：:]\s*([\d,.]+)\s*万\s*円/);
        if (mm) {
          mgmt = Math.floor(parseFloat(mm[1].replace(/,/g, '')) * 10000);
        }
      }
    }

    // 駅情報
    const LINE_CHARS = '[ぁ-んァ-ヶー\u4E00-\u9FFFA-Za-zＡ-Ｚａ-ｚ]';
    const stationRe = new RegExp(`(${LINE_CHARS}{2,20}線「[^」]+」駅\\s*徒歩\\d+分)`);
    const sm = text.match(stationRe);
    if (sm) {
      let rawStation = sm[1];
      // 余分な空白を圧縮（「駅　　　　徒歩」→「駅 徒歩」）
      rawStation = rawStation.replace(/\s+/g, ' ');
      // 住所末尾（丁目・番地・号）が路線名に混入するのを除去
      station = rawStation.replace(/^[丁目番地号]+/, '');

      // 住所: 東京都〜駅マッチ開始位置
      const strippedLen = rawStation.length - station.length;
      const addrEnd = text.indexOf(rawStation) + strippedLen;
      const am = text.indexOf('東京都');
      if (am >= 0) {
        address = text.substring(am, addrEnd).trim();
        address = address.replace(/^\(税込\)\s*/, '');
      }
    }

    if (!address) {
      // 駅情報がない場合のフォールバック
      const am = text.match(/(東京都[^\s]{3,50})/);
      if (am) {
        address = am[1].trim().split(/広告費/)[0].trim();
      }
    }

    return [rent, mgmt, address, station];
  }

  // === 敷金・礼金分割 ===
  function splitDepositKey(text) {
    if (!text || text === '-') return ['', ''];
    if (text === 'なしなし') return ['なし', 'なし'];

    const valPattern = '([\\d,万.]+\\s*[ヶか月円]+|なし|-)';
    const re = new RegExp(`${valPattern}\\s*${valPattern}`);
    const m = text.match(re);
    if (m) return [m[1].trim(), m[2].trim()];

    return [text, ''];
  }

  // === 間取り・面積分割 ===
  function splitLayoutArea(text) {
    let layout = '';
    let area = 0;

    const lm = text.match(/^(\d[RSLDK]+|ワンルーム)/);
    if (lm) {
      layout = lm[1];
      if (layout === 'ワンルーム') layout = '1R';
    }

    const am = text.match(/([\d.]+)\s*[㎡m²]/);
    if (am) {
      area = parseFloat(am[1]);
    }

    return [layout, area];
  }

  // === 築年数・退去予定日分割 ===
  function splitAgeDate(text) {
    let buildingAge = '';
    let moveOut = '';

    const m = text.match(/^(築\d+年|新築)/);
    if (m) {
      buildingAge = m[1];
      const rest = text.substring(m[0].length);
      if (rest && rest !== '-') moveOut = rest;
    } else {
      moveOut = (text && text !== '-') ? text : '';
    }

    return [buildingAge, moveOut];
  }

  // === 内見開始日・入居時期分割 ===
  function splitPreviewMovein(text) {
    if (!text) return ['', ''];

    const stripPrefix = (val) => val.replace(/^(予定|期日指定)\s*/, '');

    if (text.startsWith('-')) {
      const rest = text.substring(1);
      const movein = (rest && rest !== '-') ? rest : '';
      return ['', stripPrefix(movein)];
    }

    const m = text.match(/^(\d{4}\/\d{1,2}\/\d{1,2}|\d{4}\/\d{1,2}|-)/);
    if (m) {
      const preview = (m[1] !== '-') ? m[1] : '';
      const rest = text.substring(m[0].length);
      const movein = (rest && rest !== '-') ? rest : '';
      return [preview, stripPrefix(movein)];
    }

    return ['', stripPrefix(text)];
  }

  // === カード画像抽出 ===
  function extractCardImage(card) {
    const img = card.querySelector('img');
    if (!img) return null;
    const src = img.src || img.dataset.src || '';
    if (!src || isIcon(src) || src.startsWith('data:')) return null;
    if (src.startsWith('//')) return 'https:' + src;
    if (src.startsWith('/')) return IELOVE_BASE_URL + src;
    return src;
  }

  function isIcon(url) {
    return /logo|icon|favicon|badge|noimage|dummy|loading/i.test(url);
  }

})();
