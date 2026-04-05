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

  // ─── ラベル→フィールド名マッピング（Python版 _DETAIL_FIELD_MAP 準拠） ───
  const FIELD_MAP = {
    '物件名': 'building_name',
    '物件所在地': 'address',
    '所在地': 'address',
    '交通機関': 'station_info',
    '最寄り駅': 'station_info',
    '交通': 'station_info',
    '間取り': 'layout',
    '面積': '_area_text',
    '専有面積': '_area_text',
    '所在階': 'floor_text',
    '階': 'floor_text',
    '部屋向き': 'sunlight',
    '向き': 'sunlight',
    '主要採光面': 'sunlight',
    '建物構造': 'structure',
    '構造・工法・仕様': '_construction_spec',
    '構造': 'structure',
    '築年月': 'building_age',
    '築年数': 'building_age',
    '総戸数': 'total_units',
    '賃貸借の種類': 'lease_type',
    '契約種別': 'lease_type',
    '契約形態': 'lease_type',
    '契約期間': 'contract_period',
    '解約予告': 'cancellation_notice',
    '解約通知期間': 'cancellation_notice',
    '更新・再契約': 'renewal_info',
    '契約更新': 'renewal_info',
    '入居可能日': 'move_in_date',
    '入居可能時期': 'move_in_date',
    '入居時期': 'move_in_date',
    '階建て': 'story_text',
    '階建': 'story_text',
    '敷引き': 'shikibiki',
    '償却': 'shikibiki',
    'ペット敷金': 'pet_deposit',
    'フリーレント': 'free_rent',
    'フリーレント詳細': 'free_rent_detail',
    '更新料': 'renewal_fee',
    '火災保険': 'fire_insurance',
    '火災保険料': 'fire_insurance',
    '損害保険': 'fire_insurance',
    '更新事務手数料': 'renewal_admin_fee',
    '保証会社': 'guarantee_info',
    '保証': 'guarantee_info',
    '鍵交換': 'key_exchange_fee',
    '鍵交換費用': 'key_exchange_fee',
    '鍵交換費': 'key_exchange_fee',
    '24時間サポート': 'support_fee_24h',
    '24時間サポート費': 'support_fee_24h',
    '敷金積み増し': 'additional_deposit',
    '敷金積増し': 'additional_deposit',
    '保証金': 'guarantee_deposit',
    '水道料金形態': 'water_billing',
    '水道料金': 'water_billing',
    '水道代': 'water_billing',
    '駐車場代': 'parking_fee',
    '駐車場': 'parking_fee',
    '駐輪場代': 'bicycle_parking_fee',
    '駐輪場': 'bicycle_parking_fee',
    'バイク置き場代': 'motorcycle_parking_fee',
    'バイク置場代': 'motorcycle_parking_fee',
    'バイク置き場': 'motorcycle_parking_fee',
    'その他月次費用': 'other_monthly_fee',
    'その他一時金': 'other_onetime_fee',
    '入居条件': 'move_in_conditions',
    '退去日': 'move_out_date',
    '退去予定日': 'move_out_date',
    '退去予定': 'move_out_date',
    '間取り詳細': 'layout_detail',
    '賃料': '_rent_text',
    '管理費': '_mgmt_text',
    '共益費': '_mgmt_text',
    '管理費/共益費/雑費': '_mgmt_text',
    '敷金': 'deposit',
    '礼金': 'key_money',
    '部屋番号': 'room_number',
    'クリーニング費用': 'cleaning_fee',
    'クリーニング': 'cleaning_fee',
    '室内抗菌': 'sanitization_fee',
    '室内消毒': 'sanitization_fee',
    '抗菌施工': 'sanitization_fee',
    '消毒費': 'sanitization_fee',
    '消毒施工': 'sanitization_fee',
    '権利金': 'rights_fee',
    '内見開始日': 'preview_start_date',
  };

  // ─── 所在階から階建てを分離 ───
  function splitFloorAndStory(value) {
    // "8階(地上12階)" → ["8階", "地上12階"]
    // "5階（地上10階建）" → ["5階", "地上10階建"]
    const m = value.match(/^(.+?階)\s*[（(](.+?)[）)]$/);
    if (m) return [m[1], m[2]];
    return [value, ''];
  }

  // ─── ラベル→フィールドマッピング適用 ───
  function mapDetailField(details, label, value) {
    if (!label || !value) return;

    // 住所末尾の「地図」リンクテキストを除去
    if (value.endsWith('地図')) {
      const stripped = value.slice(0, -2).trimEnd();
      if (stripped) value = stripped;
    }

    // 完全一致
    let fieldName = FIELD_MAP[label];
    // 完全一致がなければ部分一致
    if (!fieldName) {
      for (const [key, fn] of Object.entries(FIELD_MAP)) {
        if (label.includes(key)) {
          fieldName = fn;
          break;
        }
      }
    }
    if (!fieldName) return;

    // 所在階は階建て分離処理
    if (fieldName === 'floor_text') {
      const [floorPart, storyPart] = splitFloorAndStory(value);
      details.floor_text = floorPart;
      if (storyPart && !details.story_text) {
        details.story_text = storyPart;
      }
      return;
    }

    // 交通機関は改行区切りで保持（later分割用）
    if (fieldName === 'station_info' && details.station_info) {
      // 既にstation_infoがある場合は追記しない（MUI Gridで改行付きで取得済み）
      return;
    }

    // 既にセット済みなら上書きしない（最初に見つかった値を優先）
    if (!details[fieldName]) {
      details[fieldName] = value;
    }
  }

  // ─── 画像URL抽出（Python版 _extract_detail_images 準拠） ───
  function extractImages() {
    const urls = [];
    const seen = new Set();
    const SKIP_PATTERNS = [
      'placeholder', 'logo', 'icon', 'favicon',
      'avatar', 'profile', 'badge', 'data:',
      'blob:', 'svg+xml',
      'es-service.net', 'onetop',
      'okbiz', 'miibo', 'chatbot', 'faq-e-seikatsu',
      'e-bukken', 'sfa_main_banner', 'loading', 'spinner',
    ];

    function addUrl(src) {
      if (!src || seen.has(src)) return;
      if (SKIP_PATTERNS.some(p => src.toLowerCase().includes(p))) return;
      if (src.endsWith('.svg')) return;
      if (src.startsWith('http')) {
        urls.push(src);
        seen.add(src);
      }
    }

    // img src / data-src
    for (const img of document.querySelectorAll('img')) {
      addUrl(img.src);
      addUrl(img.getAttribute('data-src'));
      // srcset
      const srcset = img.getAttribute('srcset') || '';
      if (srcset) {
        for (const part of srcset.split(',')) {
          addUrl(part.trim().split(' ')[0]);
        }
      }
    }

    // <picture> > <source>
    for (const source of document.querySelectorAll('source')) {
      const srcset = source.getAttribute('srcset') || '';
      if (srcset) {
        for (const part of srcset.split(',')) {
          addUrl(part.trim().split(' ')[0]);
        }
      }
    }

    // CSS background-image
    for (const div of document.querySelectorAll('div[style*="background"]')) {
      const style = div.getAttribute('style') || '';
      const m = style.match(/url\(['"]?(https?:\/\/[^'")\s]+)['"]?\)/);
      if (m) addUrl(m[1]);
    }

    return urls.slice(0, 20);
  }

  // ─── 設備情報抽出（Python版 _extract_facilities 準拠） ───
  function extractFacilities() {
    const keywords = ['設備', '設備・条件', '主な設備'];
    for (const keyword of keywords) {
      // テキストノードからキーワードを含む要素を探す
      const walker = document.createTreeWalker(
        document.body, NodeFilter.SHOW_TEXT,
        { acceptNode: (node) => node.textContent.trim() === keyword ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT }
      );
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent) continue;

        // 次の兄弟要素からテキスト取得
        const nextSib = parent.nextElementSibling;
        if (nextSib) {
          const text = nextSib.textContent.trim();
          if (text && text.length > 5) return text;
        }

        // 親コンテナの全テキストからキーワード以降を抽出
        const grandparent = parent.parentElement;
        if (grandparent) {
          const fullText = grandparent.textContent.trim();
          const idx = fullText.indexOf(keyword);
          if (idx >= 0) {
            const rest = fullText.substring(idx + keyword.length).replace(/^[,: 、]+/, '');
            if (rest && rest.length > 5) return rest;
          }
        }
      }
    }

    // フォールバック: kvPairsベースの設備結合（後で呼び出し元で実施）
    return '';
  }

  // ─── 内見開始日抽出（Python版 _extract_preview_start_date 準拠） ───
  function extractPreviewStartDate() {
    for (const btn of document.querySelectorAll('button')) {
      const text = btn.textContent.trim();
      const m = text.match(/^(\d{1,2}\/\d{1,2})～?内見/);
      if (m) return m[1];
    }
    return '';
  }

  // ─── メイン抽出関数 ───
  function extractDetail() {
    const detail = {};

    // === 1. 画像URL取得 ===
    detail.image_urls = extractImages();

    // === 2. KVペア収集 ===
    // テーブル（th/td）
    for (const table of document.querySelectorAll('table')) {
      for (const row of table.querySelectorAll('tr')) {
        const th = row.querySelector('th');
        const td = row.querySelector('td');
        if (th && td) {
          mapDetailField(detail, th.textContent.trim(), td.textContent.trim());
        }
      }
    }

    // 定義リスト（dt/dd）
    for (const dl of document.querySelectorAll('dl')) {
      const dts = dl.querySelectorAll('dt');
      const dds = dl.querySelectorAll('dd');
      const len = Math.min(dts.length, dds.length);
      for (let i = 0; i < len; i++) {
        mapDetailField(detail, dts[i].textContent.trim(), dds[i].textContent.trim());
      }
    }

    // MUI Grid container パターン（Python版 _parse_mui_detail_layout 準拠）
    for (const container of document.querySelectorAll('div[class*="MuiGrid"][class*="container"]')) {
      const children = Array.from(container.children).filter(c => c.nodeType === 1);
      for (let i = 0; i < children.length - 1; i += 2) {
        const label = children[i].textContent.trim();
        const valueEl = children[i + 1];
        // 値セル内に複数の直下divがある場合は改行区切り（交通機関等）
        const innerDivs = valueEl.querySelectorAll(':scope > div');
        let value;
        if (innerDivs.length > 0) {
          value = Array.from(innerDivs)
            .map(d => d.textContent.trim())
            .filter(Boolean)
            .join('\n');
        } else {
          value = valueEl.textContent.trim();
        }
        if (label && value && value !== label) {
          mapDetailField(detail, label, value);
        }
      }
    }

    // MUI Grid item (xs-4/xs-8) フォールバック
    const gridItems = document.querySelectorAll('.MuiGrid-root.MuiGrid-item');
    for (let i = 0; i < gridItems.length - 1; i++) {
      const item = gridItems[i];
      const next = gridItems[i + 1];
      if (item.className.includes('xs-4') && next.className.includes('xs-8')) {
        const label = item.textContent.trim();
        // 値セル内の直下divを改行区切り
        const innerDivs = next.querySelectorAll(':scope > div');
        let value;
        if (innerDivs.length > 0) {
          value = Array.from(innerDivs)
            .map(d => d.textContent.trim())
            .filter(Boolean)
            .join('\n');
        } else {
          value = next.textContent.trim();
        }
        if (label && value && label.length < 30 && value.length < 500) {
          mapDetailField(detail, label, value);
        }
      }
    }

    // H3ラベル + 次の兄弟DIVから抽出
    for (const h3 of document.querySelectorAll('h3')) {
      const key = h3.textContent.trim();
      const nextDiv = h3.nextElementSibling;
      if (key && nextDiv && nextDiv.tagName === 'DIV') {
        const value = nextDiv.textContent.trim();
        if (value) mapDetailField(detail, key, value);
      }
    }

    // フォールバック: 2子要素divパターン
    for (const div of document.querySelectorAll('div')) {
      const children = div.children;
      if (children.length !== 2) continue;
      const label = children[0]?.textContent?.trim();
      const value = children[1]?.textContent?.trim();
      if (label && value && label.length < 20 && value.length < 200) {
        mapDetailField(detail, label, value);
      }
    }

    // === 3. 交通機関の分割 ===
    if (detail.station_info && detail.station_info.includes('\n')) {
      const lines = detail.station_info.split('\n').map(s => s.trim()).filter(Boolean);
      if (lines.length > 0) {
        detail.station_info = lines[0];
        if (lines.length > 1) {
          detail.other_stations = lines.slice(1);
        }
      }
    }

    // === 4. 設備情報 ===
    const facilities = extractFacilities();
    if (facilities) {
      detail.facilities = facilities;
    }
    // フォールバック: 設備が空ならkvベースで収集
    if (!detail.facilities) {
      const facilityParts = [];
      // 全てのキーワードベースで既にmapされなかった設備関連テキストを収集
      for (const el of document.querySelectorAll('h3, h4, b, strong')) {
        const text = el.textContent.trim();
        if (text.includes('設備') || text.includes('条件') || text.includes('こだわり')) {
          const nextEl = el.closest('div')?.nextElementSibling || el.nextElementSibling;
          if (nextEl) {
            const val = nextEl.textContent.trim();
            if (val && val.length > 3) facilityParts.push(val);
          }
        }
      }
      if (facilityParts.length > 0) {
        detail.facilities = facilityParts.join(' / ');
      }
    }

    // === 5. 内見開始日 ===
    const previewDate = extractPreviewStartDate();
    if (previewDate && !detail.preview_start_date) {
      detail.preview_start_date = previewDate;
    }

    // === 6. ステータス ===
    const allText = document.body.innerText || '';
    const knownStatuses = ['申込あり', '成約', '公開停止', '契約済み', '募集中'];
    for (const s of knownStatuses) {
      if (allText.includes(s)) {
        detail.listing_status = s;
        break;
      }
    }

    // === 7. 所在階パース ===
    if (detail.floor_text) {
      const m = detail.floor_text.match(/(\d+)/);
      if (m) detail.floor = parseInt(m[1]);
    }

    return { ok: true, detail };
  }
})();
