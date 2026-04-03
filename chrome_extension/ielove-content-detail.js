/**
 * ielove-content-detail.js
 * いえらぶBB 詳細ページ用 content script
 * Python ielove_search/parsers.py の parse_detail_page() を JS DOM に移植
 *
 * 対象URL: https://bb.ielove.jp/ielovebb/rent/detail/*
 */

(() => {
  'use strict';

  const IELOVE_BASE_URL = 'https://bb.ielove.jp';

  // ラベル → フィールド名マッピング
  const DETAIL_FIELD_MAP = {
    '敷引金': 'shikibiki',
    '敷引': 'shikibiki',
    '償却金': 'shikibiki',
    '償却': 'shikibiki',
    '保証金': 'guarantee_deposit',
    '敷金積増し金': 'additional_deposit',
    '敷金積増し': 'additional_deposit',
    'フリーレント': 'free_rent',
    '鍵交換代': 'key_exchange_fee',
    '鍵交換費': 'key_exchange_fee',
    '鍵交換費用': 'key_exchange_fee',
    '室内清掃費用': 'cleaning_fee',
    '室内清掃費': 'cleaning_fee',
    'その他初期費用': '_other_initial_fees',
    'その他月額費用': 'other_monthly_fee',
    '保証会社': 'guarantee_info',
    '構造': 'structure',
    '階建': 'story_text',
    '向き': 'sunlight',
    '総戸数': 'total_units',
    '契約期間': 'contract_period',
    '更新料': 'renewal_fee',
    '契約内容': 'lease_type',
    '更新事務手数料': 'renewal_admin_fee',
    '間取り': 'layout_detail',
    '間取り/専有面積': '',  // ヘッダーテーブルの複合ラベル（部分一致で間取りにマッチさせない）
    '保険': 'fire_insurance',
    '現況': 'listing_status',
    '退去予定日': 'move_out_date',
    '駐車場': '',  // 駐車場の有無情報であり、駐車場代（金額）ではないため除外
    'バルコニー面積': '',
    'その他交通': 'other_stations',
    '備考': '',
    '特優賃': '',
    '入居時期': 'move_in_date',
    '所在階': 'floor_text',
    '所在階/階建': 'story_text',
    '建物構造': 'structure',
    '敷金/礼金': '_deposit_key_money',
    '敷金': 'deposit',
    '礼金': 'key_money',
  };

  const CLEANING_KEYWORDS = ['クリーニング', '清掃'];

  // 画像URLサイズパターン: {base}_{number}_{width}_{height}.{ext}
  const IMG_SIZE_RE = /^(.+_\d+)_(\d+)_(\d+)(\.\w+)$/;
  const FULL_WIDTH = '550';
  const FULL_HEIGHT = '413';

  // === メッセージハンドラ ===
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'IELOVE_EXTRACT_DETAIL') {
      try {
        const detail = parseDetailPage();
        // DEBUG: image_categories の状態をconsoleに出力
        console.log('[ielove-content-debug] detail keys:', Object.keys(detail).join(','));
        console.log('[ielove-content-debug] image_urls:', (detail.image_urls || []).length);
        console.log('[ielove-content-debug] image_categories:', (detail.image_categories || []).length);
        if (detail.image_categories && detail.image_categories.length > 0) {
          console.log('[ielove-content-debug] categories sample:', detail.image_categories.slice(0, 5));
        }
        sendResponse({ ok: true, detail });
      } catch (err) {
        console.error('[ielove-content-debug] parseDetailPage error:', err.message);
        sendResponse({ ok: false, error: err.message });
      }
      return true;
    }

    if (msg.type === 'IELOVE_CHECK_LOGIN') {
      const isLoggedIn = !window.location.href.includes('/login');
      sendResponse({ ok: true, isLoggedIn });
      return true;
    }
  });

  // === 詳細ページパーサー ===
  function parseDetailPage() {
    const result = {};

    // 物件名・部屋番号を抽出（p.bkn_name または table.estate-name から）
    extractBuildingNameAndRoom(result);

    // 住所・駅情報を抽出
    extractAddressAndStation(result);

    // 賃料・管理費を .bb-detail-info のSPAN要素から抽出
    extractRentAndManagementFee(result);

    // テーブルからkey-valueペアを抽出
    parseDetailTables(result);

    // 間取り・面積を複合ラベルから抽出
    extractLayoutAndArea(result);

    // 設備情報を抽出
    const facilities = extractFacilities();
    if (facilities) result.facilities = facilities;

    // 画像URLとカテゴリを抽出
    const { urls: imageUrls, categories: imageCategories } = extractDetailImages();
    if (imageUrls.length > 0) {
      result.image_urls = imageUrls;
      result.image_categories = imageCategories;
    }

    return result;
  }

  // === 物件名・部屋番号抽出 ===
  function extractBuildingNameAndRoom(result) {
    // パターン1: p.bkn_name（「クレール２１鷹番  101」形式）
    const bknName = document.querySelector('p.bkn_name');
    if (bknName) {
      const raw = bknName.textContent.trim();
      const parts = raw.split(/\s{2,}/);
      if (parts.length >= 2) {
        result.building_name = parts.slice(0, -1).join(' ');
        result.room_number = parts[parts.length - 1];
      } else if (parts.length === 1 && raw) {
        result.building_name = raw;
      }
      return;
    }

    // パターン2: table.estate-name > span.large-font
    const nameTable = document.querySelector('table.estate-name');
    if (nameTable) {
      const nameSpan = nameTable.querySelector('span.large-font');
      if (nameSpan) {
        const textParts = [];
        for (const child of nameSpan.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            const t = child.textContent.trim();
            if (t) textParts.push(t);
          } else {
            break;
          }
        }
        const raw = textParts.join(' ');
        const parts = raw.trim().split(/\s{2,}/);
        if (parts.length >= 2) {
          result.building_name = parts.slice(0, -1).join(' ');
          result.room_number = parts[parts.length - 1];
        } else if (parts.length > 0) {
          result.building_name = parts[0];
        }
      }
    }
  }

  // === 住所・駅情報抽出 ===
  function extractAddressAndStation(result) {
    const bodyText = document.body.innerText || '';

    // 住所: 東京都〜 を含む短い行
    for (const line of bodyText.split('\n')) {
      const t = line.trim();
      if (/^東京都.{3,50}$/.test(t) && !t.includes('管理費')) {
        result.address = t;
        break;
      }
    }

    // 駅情報: 路線名「駅名」駅 徒歩N分
    const LINE_CHARS = '[ぁ-んァ-ヶー\u4E00-\u9FFFA-Za-zＡ-Ｚａ-ｚ]';
    const stationRe = new RegExp(`(${LINE_CHARS}{2,20}線「[^」]+」駅\\s*徒歩\\d+分)`);
    const sm = bodyText.match(stationRe);
    if (sm) {
      result.station_info = sm[1].replace(/\s+/g, ' ').replace(/^[丁目番地号]+/, '');
    }
  }

  // === 間取り・面積抽出（「2LDK /壁芯60.58㎡」形式の複合ラベル） ===
  function extractLayoutAndArea(result) {
    for (const table of document.querySelectorAll('table')) {
      for (const row of table.querySelectorAll('tr')) {
        const ths = row.querySelectorAll('th');
        if (ths.length > 0 && row.querySelectorAll('td').length === 0) {
          for (let i = 0; i < ths.length; i++) {
            if (ths[i].textContent.trim() === '間取り/専有面積') {
              const nextRow = row.nextElementSibling;
              if (nextRow) {
                const tds = nextRow.querySelectorAll('td');
                if (i < tds.length) {
                  const text = tds[i].textContent.trim();
                  // 「2LDK /壁芯60.58㎡」
                  const lm = text.match(/^(\d[RSLDK]+|ワンルーム)/);
                  if (lm && !result.layout) {
                    result.layout = lm[1] === 'ワンルーム' ? '1R' : lm[1];
                  }
                  const am = text.match(/([\d.]+)\s*[㎡m²]/);
                  if (am && !result.area) {
                    result.area = parseFloat(am[1]);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // === 賃料・管理費抽出（テーブル外のSPAN要素から） ===
  function extractRentAndManagementFee(result) {
    const detailInfo = document.querySelector('.bb-detail-info');
    if (!detailInfo) return;

    // 賃料: <span class="rent_cost ...">95,000</span>（円単位の数値）
    const rentSpan = detailInfo.querySelector('span.rent_cost');
    if (rentSpan) {
      const rentText = rentSpan.textContent.trim().replace(/,/g, '');
      const rentYen = parseInt(rentText, 10);
      if (rentYen > 0) {
        result.rent = rentYen;
      }
    }

    // 管理費・共益費: <span>管理費・共益費：1万5,000円</span>
    // 注意: 親spanのtextContentは子spanのテキストを含むため、
    // 子spanを持たないリーフspanのみを対象にする
    for (const span of detailInfo.querySelectorAll('span')) {
      if (span.querySelectorAll('span').length > 0) continue; // 親spanはスキップ
      const text = span.textContent.trim();
      if (text.includes('管理費') || text.includes('共益費')) {
        const fee = parseJapaneseYen(text);
        if (fee > 0) {
          result.management_fee = fee;
        }
        break;
      }
    }
  }

  /**
   * 「1万5,000円」「15,000円」「1万円」等の日本語金額表記を円単位の数値に変換
   */
  function parseJapaneseYen(text) {
    if (!text) return 0;
    // 全角数字を半角に変換
    const normalized = text.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    // 「X万Y円」パターン（例: 1万5,000円、1万5000円、1万円）
    const manMatch = normalized.match(/(\d+)\s*万\s*([\d,]*)\s*円/);
    if (manMatch) {
      const manPart = parseInt(manMatch[1], 10) * 10000;
      const senPart = manMatch[2] ? parseInt(manMatch[2].replace(/,/g, ''), 10) || 0 : 0;
      return manPart + senPart;
    }
    // 「X円」パターン（例: 15,000円、5500円）
    const yenMatch = normalized.match(/([\d,]+)\s*円/);
    if (yenMatch) {
      return parseInt(yenMatch[1].replace(/,/g, ''), 10) || 0;
    }
    return 0;
  }

  // === テーブル解析 ===
  function parseDetailTables(result) {
    for (const table of document.querySelectorAll('table')) {
      const rows = table.querySelectorAll('tr');
      let pendingHeaders = null;

      for (const row of rows) {
        const ths = row.querySelectorAll('th');
        const tds = row.querySelectorAll('td');

        // ヘッダ行+データ行パターン
        if (ths.length > 0 && tds.length === 0) {
          pendingHeaders = Array.from(ths).map(th => th.textContent.trim());
          continue;
        }

        if (tds.length > 0 && ths.length === 0 && pendingHeaders) {
          for (let i = 0; i < pendingHeaders.length && i < tds.length; i++) {
            const value = tds[i].textContent.trim();
            mapDetailField(result, pendingHeaders[i], value);
          }
          pendingHeaders = null;
          continue;
        }

        pendingHeaders = null;

        if (ths.length === 0 || tds.length === 0) continue;

        // 2カラム構成: th1 td1 th2 td2
        for (let i = 0; i < ths.length; i++) {
          const label = ths[i].textContent.trim();
          if (i >= tds.length) continue;

          const td = tds[i];
          let value;

          // <br/>や複数<p>を含むTDはセパレーター付き
          if (td.querySelector('br') || td.querySelectorAll('p').length > 1) {
            value = getTextWithSeparator(td);
          } else {
            value = td.textContent.trim();
          }

          mapDetailField(result, label, value);
        }
      }
    }

    // 「所在階/階建」パターンの処理
    if (result.floor_text && result.floor_text.includes('/')) {
      const m = result.floor_text.match(/(\d+)\s*階\s*\/\s*(\d+)\s*階建/);
      if (m) {
        result.floor = parseInt(m[1], 10);
        result.story_text = `地上${m[2]}階建`;
      }
    }
  }

  // <br/>区切りのテキスト取得
  function getTextWithSeparator(td) {
    let text = '';
    const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.trim();
        if (t) text += (text ? ' ' : '') + t;
      } else if (node.nodeName === 'BR' || node.nodeName === 'P') {
        if (text && !text.endsWith(' / ')) text += ' / ';
      }
    }
    // 連続区切りを整理
    text = text.replace(/(\s*\/\s*)+/g, ' / ').replace(/^\s*\/\s*|\s*\/\s*$/g, '').trim();
    return text;
  }

  // === フィールドマッピング ===
  function mapDetailField(result, label, value) {
    if (!value || ['-', '−', '―', 'ー', 'なし', '無', ''].includes(value)) return;

    // 連続空白を圧縮
    value = value.replace(/\s{2,}/g, ' ').trim();

    let field = DETAIL_FIELD_MAP[label] || '';

    if (!field) {
      // 部分一致で探す
      for (const [key, fld] of Object.entries(DETAIL_FIELD_MAP)) {
        if (key === label && fld) { field = fld; break; }
      }
      if (!field) {
        for (const [key, fld] of Object.entries(DETAIL_FIELD_MAP)) {
          if (key.length >= 3 && label.includes(key) && fld) { field = fld; break; }
        }
      }
    }

    if (!field) return;

    // 特殊処理
    if (field === '_deposit_key_money') {
      // 「1ヶ月/0.5ヶ月」→ deposit, key_money に分割
      const parts = value.split('/').map(s => s.trim());
      if (parts.length >= 2) {
        if (!result.deposit) result.deposit = parts[0];
        if (!result.key_money) result.key_money = parts[1];
      } else if (parts.length === 1 && !result.deposit) {
        result.deposit = parts[0];
      }
      return;
    }

    if (field === '_other_initial_fees') {
      splitOtherInitialFees(result, value);
      return;
    }

    if (field === 'other_stations') {
      const found = value.match(/[^\s]+線「[^」]+」駅\s*徒歩\d+分/g);
      if (found) {
        result.other_stations = found.map(s => s.replace(/\s+/g, ' ').trim());
      } else {
        result.other_stations = value.split(/[,、/／\n]/).map(s => s.trim()).filter(Boolean);
      }
      return;
    }

    if (field === 'fire_insurance') {
      // 保険情報を整形: 「加入義務：有名称：旭化成...金額：1万8,400円期間：2年」
      // → 「加入義務：有 / 名称：旭化成... / 金額：1万8,400円 / 期間：2年」
      let formatted = value;
      // すでに " / " 区切りの場合はそのまま処理
      if (!value.includes(' / ')) {
        // キーワード前に区切りを挿入（名称・金額・期間・詳細）
        formatted = value.replace(/(名称|金額|期間|詳細)[：:]/g, ' / $1：');
        formatted = formatted.replace(/^\s*\/\s*/, '').trim();
      }
      const genericNames = ['火災保険', '少額短期保険'];
      const parts = formatted.split(' / ').map(p => p.trim())
        .filter(p => p && !/^.+[：:]\s*$/.test(p))
        .filter(p => {
          // 「名称：火災保険」「名称：少額短期保険」など汎用名称は除去
          const m = p.match(/名称[：:]\s*(.+)/);
          return !(m && genericNames.includes(m[1].trim()));
        });
      if (parts.length > 0) result.fire_insurance = parts.join('\n');
      return;
    }

    if (field === 'lease_type') {
      // 「普通借家権(更新：可)」→「普通借家権」（括弧内の更新情報を除去）
      result.lease_type = value.replace(/\s*[\(（][^)）]*[\)）]\s*$/, '');
      return;
    }

    if (field === 'layout_detail') {
      if (value.includes('帖') || value.includes('畳')) {
        // 「1LDK LDK 8.2帖 洋室 4.3帖」→「LDK 8.2帖 / 洋室 4.3帖」
        // 先頭の間取りタイプ（1R, 1K, 2LDK 等）を除去し、各部屋を " / " で区切る
        const rooms = value.match(/(?:[A-Za-z]+|洋室|和室|DK|LDK|K|サービスルーム|納戸)\s*[\d.]+\s*(?:帖|畳)/g);
        if (rooms && rooms.length > 0) {
          result.layout_detail = rooms.map(r => r.trim()).join(' / ');
        } else {
          result.layout_detail = value;
        }
      }
      return;
    }

    if (field === 'floor_text') {
      result.floor_text = value;
      const m = value.match(/(\d+)\s*階/);
      if (m) result.floor = parseInt(m[1], 10);
      return;
    }

    if (field === 'story_text') {
      // 「1階/5階建」パターン
      const m = value.match(/(\d+)\s*階\s*\/\s*(\d+)\s*階建/);
      if (m) {
        result.floor = parseInt(m[1], 10);
        result.floor_text = `${m[1]}階`;
        result.story_text = `地上${m[2]}階建`;
      } else {
        result.story_text = value;
      }
      return;
    }

    if (field === 'structure') {
      result.structure = value;
      return;
    }

    if (field === 'move_in_date') {
      result.move_in_date = value.replace(/^(予定|期日指定)\s*/, '');
      return;
    }

    if (field === 'guarantee_info') {
      // 保証会社情報を整形: 「加入義務：必加入会社：旭化成...利用料：初回保証料：...」
      // → 「加入義務：必加入 / 会社：旭化成... / 利用料：初回保証料：...」
      let formatted = value;
      if (!value.includes(' / ')) {
        formatted = value.replace(/(会社|利用料|詳細)[：:]/g, ' / $1：');
        formatted = formatted.replace(/^\s*\/\s*/, '').trim();
      }
      const formattedValue = formatted.split(' / ').map(p => p.trim())
        .filter(p => p && !/^.+[：:]\s*$/.test(p))
        .join('\n');
      // 保証会社1〜N を全て連結して保存
      if (result.guarantee_info) {
        result.guarantee_info += '\n---\n' + formattedValue;
      } else {
        result.guarantee_info = formattedValue;
      }
      return;
    }

    // 通常のフィールド設定（既に値がある場合は上書きしない）
    if (!result[field]) {
      result[field] = value;
    }
  }

  // === その他初期費用分割 ===
  function splitOtherInitialFees(result, value) {
    const items = value.match(/[^：:]+?[：:]\s*[\d,万]+円/g);
    if (!items) {
      if (!result.other_onetime_fee) result.other_onetime_fee = value;
      return;
    }

    const cleaningParts = [];
    const otherParts = [];
    for (const item of items) {
      // getTextWithSeparator 由来の " / " プレフィクスを除去
      const trimmed = item.replace(/^\s*\/\s*/, '').trim();
      if (!trimmed) continue;
      if (CLEANING_KEYWORDS.some(kw => trimmed.includes(kw))) {
        cleaningParts.push(trimmed);
      } else {
        otherParts.push(trimmed);
      }
    }

    if (cleaningParts.length > 0 && !result.cleaning_fee) {
      result.cleaning_fee = cleaningParts.join(' / ');
    }
    if (otherParts.length > 0 && !result.other_onetime_fee) {
      result.other_onetime_fee = otherParts.join(' / ');
    }
  }

  // === 設備情報抽出 ===
  function extractFacilities() {
    const categorized = {};

    for (const table of document.querySelectorAll('table')) {
      const tableText = table.textContent;
      if (!tableText.includes('基本設備') && !tableText.includes('キッチン')) continue;

      let inFacilitySection = false;

      for (const row of table.querySelectorAll('tr')) {
        const th = row.querySelector('th');
        const td = row.querySelector('td');
        if (!th || !td) continue;

        const category = th.textContent.trim();
        if (!category) continue;

        if (category.includes('基本設備')) inFacilitySection = true;
        if (!inFacilitySection) continue;

        let tdText = td.textContent.trim();
        if (!tdText) continue;

        // li要素がある場合はliごとに取得
        const liItems = td.querySelectorAll('li');
        if (liItems.length > 0) {
          const rawItems = [];
          for (const li of liItems) {
            const liText = li.textContent.trim();
            if (!liText) continue;
            // 電話番号を含むli（備考・連絡先情報）を除外
            if (/\d{3,4}-\d{3,4}-\d{3,4}/.test(liText)) continue;
            // 2文字以下の断片的なli（「契約」等）を除外
            if (liText.length <= 2) continue;
            rawItems.push(liText);
          }
          if (rawItems.length > 0) tdText = rawItems.join('、');
        }

        // カンマ・スラッシュで個別アイテムに分割
        const items = tdText.split(/[、,]\s*|\s*\/\s*/).map(s => s.trim()).filter(Boolean);
        // 設備名は通常短いが、「BELS/省エネ基準適合認定」等もあるため緩めに設定
        const filtered = items.filter(s => s.length <= 40);
        if (filtered.length > 0) categorized[category] = filtered;
      }
    }

    if (Object.keys(categorized).length > 0) {
      return Object.entries(categorized)
        .map(([cat, items]) => `【${cat}】${items.join(' / ')}`)
        .join('\n');
    }

    // フォールバック
    const flatParts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.includes('設備')) {
        const parent = node.parentElement;
        if (parent) {
          const sibling = parent.nextElementSibling;
          if (sibling) {
            const text = sibling.textContent.trim();
            if (text && text.length > 5) flatParts.push(text);
          }
        }
      }
    }

    return flatParts.length > 0 ? flatParts.join(' / ') : '';
  }

  // === 画像抽出 ===
  function normalizeImageUrl(src) {
    if (src.startsWith('//')) return 'https:' + src;
    if (src.startsWith('/')) return IELOVE_BASE_URL + src;
    return src;
  }

  function toFullSizeUrl(url) {
    const m = url.match(IMG_SIZE_RE);
    if (m) return `${m[1]}_${FULL_WIDTH}_${FULL_HEIGHT}${m[4]}`;
    return url;
  }

  function extractDetailImages() {
    const urls = [];
    const categories = [];
    const seen = new Set();

    const add = (url, cat = '') => {
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
        categories.push(cat);
      }
    };

    // Strategy 1: bxSlider 構造
    const thumbSlider = document.querySelector('ul.bxslider');
    const largeSlider = document.querySelector('ul.bxLargeslider');

    if (thumbSlider || largeSlider) {
      let baseUrlTemplate = null;
      let ext = '.jpg';

      // (a) サムネイルからベースURL取得
      const loadedNumbers = new Set();
      if (thumbSlider) {
        for (const li of thumbSlider.querySelectorAll('li.thumbImage:not(.bx-clone)')) {
          const img = li.querySelector('img');
          if (!img) continue;
          const src = img.src || '';
          if (src.startsWith('data:')) continue;
          const normalized = normalizeImageUrl(src);
          const m = normalized.match(IMG_SIZE_RE);
          if (m) {
            const lastUnderscore = m[1].lastIndexOf('_');
            baseUrlTemplate = m[1].substring(0, lastUnderscore);
            ext = m[4];
            const num = parseInt(m[1].substring(lastUnderscore + 1), 10);
            loadedNumbers.add(num);
          }
        }
      }

      // (b) 大画像からベースURL取得（サムネがなかった場合）
      if (!baseUrlTemplate && largeSlider) {
        for (const li of largeSlider.querySelectorAll('li.largeImage:not(.bx-clone)')) {
          const img = li.querySelector('img');
          if (!img) continue;
          const src = img.src || '';
          if (src.startsWith('data:')) continue;
          const normalized = normalizeImageUrl(src);
          const m = normalized.match(IMG_SIZE_RE);
          if (m) {
            const lastUnderscore = m[1].lastIndexOf('_');
            baseUrlTemplate = m[1].substring(0, lastUnderscore);
            ext = m[4];
            const num = parseInt(m[1].substring(lastUnderscore + 1), 10);
            loadedNumbers.add(num);
          }
        }
      }

      // (c) カテゴリ情報を収集
      const numToCategory = {};
      if (largeSlider) {
        const largeItems = largeSlider.querySelectorAll('li.largeImage:not(.bx-clone)');
        largeItems.forEach((li, idx) => {
          let cat = li.textContent.trim();
          if (cat === 'カテゴリ未選択') cat = '';
          numToCategory[idx + 1] = cat;
        });
      }

      // (d) 全画像番号を収集
      const allNumbers = new Set(loadedNumbers);
      const sliderContainer = thumbSlider || largeSlider;
      if (sliderContainer) {
        for (const li of sliderContainer.querySelectorAll('li:not(.bx-clone)')) {
          const img = li.querySelector('img');
          if (!img) continue;
          const onclick = img.getAttribute('onclick') || '';
          const clickMatch = onclick.match(/jumpBxSlider\((\d+)\)/);
          if (clickMatch) allNumbers.add(parseInt(clickMatch[1], 10));
        }
      }

      // (e) 大画像スライダーの非クローンli数から総画像数を推測
      if (largeSlider) {
        const nonCloneCount = largeSlider.querySelectorAll('li.largeImage:not(.bx-clone)').length;
        for (let n = 1; n <= nonCloneCount; n++) allNumbers.add(n);
      }

      // (f) URLリスト構築
      if (baseUrlTemplate && allNumbers.size > 0) {
        const sorted = Array.from(allNumbers).sort((a, b) => a - b);
        for (const num of sorted) {
          const fullUrl = `${baseUrlTemplate}_${num}_${FULL_WIDTH}_${FULL_HEIGHT}${ext}`;
          const cat = numToCategory[num] || '';
          add(fullUrl, cat);
        }
        return { urls, categories };
      }
    }

    // Strategy 2: フォールバック
    const excludeIds = new Set();
    for (const section of document.querySelectorAll(
      '.similaLists, .similar, .recommend, .other_room, .pickup, [class*="similar"], [class*="recommend"]'
    )) {
      for (const img of section.querySelectorAll('img')) {
        excludeIds.add(img);
      }
    }

    for (const img of document.querySelectorAll('img')) {
      if (excludeIds.has(img)) continue;
      const src = img.dataset.src || img.src || '';
      if (!src || src.startsWith('data:') || /logo|icon|favicon|badge|noimage|dummy|loading/i.test(src)) continue;
      const full = toFullSizeUrl(normalizeImageUrl(src));
      add(full);
      if (urls.length >= 30) break;
    }

    return { urls, categories };
  }

})();
