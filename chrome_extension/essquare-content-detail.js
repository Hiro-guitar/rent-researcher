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

  // ─── 画像URL抽出 ───
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
      'noimage', 'no_image', 'no-image', 'dummy',
      'e_square_logo',
    ];

    function addUrl(src) {
      if (!src || seen.has(src)) return;
      const lower = src.toLowerCase();
      if (SKIP_PATTERNS.some(p => lower.includes(p))) return;
      if (lower.endsWith('.svg') || lower.endsWith('.gif')) return;
      if (src.startsWith('http')) {
        urls.push(src);
        seen.add(src);
      }
    }

    // 1. computedStyle全走査 — ES-SquareはCSS-in-JS(Emotion/MUI)で
    //    background-imageをクラスに設定するためinline styleでは取得不可
    const allDivs = document.querySelectorAll('div, span, a, figure, li');
    for (const el of allDivs) {
      try {
        const bg = window.getComputedStyle(el).backgroundImage;
        if (bg && bg !== 'none') {
          // 複数のurl()がある場合も対応
          const re = /url\(['"]?(https?:\/\/[^'")\s]+)['"]?\)/g;
          let m;
          while ((m = re.exec(bg)) !== null) {
            addUrl(m[1]);
          }
        }
      } catch (e) {}
    }

    // 2. img src / data-src
    for (const img of document.querySelectorAll('img')) {
      addUrl(img.src);
      addUrl(img.getAttribute('data-src'));
      addUrl(img.getAttribute('data-original'));
      const srcset = img.getAttribute('srcset') || '';
      if (srcset) {
        for (const part of srcset.split(',')) {
          addUrl(part.trim().split(' ')[0]);
        }
      }
    }

    // 3. <picture> > <source>
    for (const source of document.querySelectorAll('source')) {
      const srcset = source.getAttribute('srcset') || '';
      if (srcset) {
        for (const part of srcset.split(',')) {
          addUrl(part.trim().split(' ')[0]);
        }
      }
    }

    // 4. React Fiber props走査（ルート要素から）
    try {
      const root = document.getElementById('root') || document.getElementById('__next') || document.querySelector('[data-reactroot]');
      if (root) {
        const fiberKey = Object.keys(root).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        if (fiberKey) {
          const visited = new Set();
          function walkFiber(fiber, depth) {
            if (!fiber || depth > 30 || visited.has(fiber)) return;
            visited.add(fiber);
            const props = fiber.memoizedProps || fiber.pendingProps || {};
            // 画像URLフィールドを探索
            if (typeof props.src === 'string' && props.src.startsWith('http')) addUrl(props.src);
            if (props.style?.backgroundImage) {
              const m = props.style.backgroundImage.match(/url\(['"]?(https?:\/\/[^'")\s]+)['"]?\)/);
              if (m) addUrl(m[1]);
            }
            // 配列プロパティ内の画像URL（image_url, photo_url等）
            for (const [key, val] of Object.entries(props)) {
              if (typeof val === 'string' && /^https?:\/\/.+\.(jpg|jpeg|png|webp)/i.test(val)) {
                addUrl(val);
              }
              if (Array.isArray(val)) {
                for (const item of val) {
                  if (typeof item === 'string' && /^https?:\/\/.+\.(jpg|jpeg|png|webp)/i.test(item)) {
                    addUrl(item);
                  }
                  if (item && typeof item === 'object') {
                    for (const v of Object.values(item)) {
                      if (typeof v === 'string' && /^https?:\/\/.+\.(jpg|jpeg|png|webp)/i.test(v)) {
                        addUrl(v);
                      }
                    }
                  }
                }
              }
            }
            // stateKeyも確認
            if (fiber.memoizedState) {
              let state = fiber.memoizedState;
              for (let i = 0; i < 5 && state; i++) {
                if (state.memoizedState && typeof state.memoizedState === 'object') {
                  const s = state.memoizedState;
                  for (const val of Object.values(s)) {
                    if (typeof val === 'string' && /^https?:\/\/.+\.(jpg|jpeg|png|webp)/i.test(val)) {
                      addUrl(val);
                    }
                  }
                }
                state = state.next;
              }
            }
            walkFiber(fiber.child, depth + 1);
            walkFiber(fiber.sibling, depth + 1);
          }
          walkFiber(root[fiberKey], 0);
        }
      }
    } catch (e) {}

    return urls.slice(0, 20);
  }

  // ─── 設備情報抽出（H2/H3 + MUI Grid pairs ベース） ───
  // ES-Squareの設備セクション構造:
  //   H2: 設備詳細
  //     H3: 区画設備
  //       DIV(MuiGrid container):
  //         DIV(MuiGrid-item xs-4): "キッチン"      ← サブカテゴリラベル
  //         DIV(MuiGrid-item xs-8): "ガスコンロ，..." ← 値
  //     H3: 建物設備 / H3: セキュリティ / H3: 屋外設備 ...

  function parseMuiGridPairs(container) {
    // MUI Grid pairs: children[0]=label, children[1]=value, children[2]=label, ...
    const children = Array.from(container.children).filter(c => c.nodeType === 1);
    const pairs = [];
    for (let i = 0; i < children.length - 1; i += 2) {
      const label = children[i].textContent.trim();
      const value = children[i + 1].textContent.trim();
      if (label && value) {
        pairs.push({ label, value });
      }
    }
    return pairs;
  }

  function extractFacilities() {
    // H3ベースで設備セクション内のカテゴリ・サブカテゴリを抽出
    const facilityH3s = [];
    for (const h3 of document.querySelectorAll('h3')) {
      const text = h3.textContent.trim();
      if (['区画設備', '建物設備', 'セキュリティ', '屋外設備', '共用設備',
           '室内設備', 'キッチン設備', '水回り設備'].includes(text)) {
        facilityH3s.push(h3);
      }
    }

    if (facilityH3s.length > 0) {
      const allParts = [];
      for (const h3 of facilityH3s) {
        const nextEl = h3.nextElementSibling;
        if (!nextEl) continue;

        // MUI Grid pairs からサブカテゴリ＋値を取得
        const pairs = parseMuiGridPairs(nextEl);
        if (pairs.length > 0) {
          for (const { label, value } of pairs) {
            allParts.push(`【${label}】${value}`);
          }
        } else {
          // Grid構造でない場合はフラットテキスト
          const text = nextEl.textContent.trim();
          if (text) {
            allParts.push(`【${h3.textContent.trim()}】${text}`);
          }
        }
      }
      if (allParts.length > 0) return allParts.join('\n');
    }

    // フォールバック: H2「設備詳細」から辿る
    for (const h2 of document.querySelectorAll('h2')) {
      const h2Text = h2.textContent.trim();
      if (!h2Text.includes('設備詳細') && !h2Text.includes('設備情報')) continue;

      // H2の後続要素をすべて走査
      let el = h2.nextElementSibling;
      const parts = [];
      while (el) {
        if (el.tagName === 'H2') break;
        if (el.tagName === 'H3') {
          // H3の次の兄弟がGrid container
          const gridEl = el.nextElementSibling;
          if (gridEl) {
            const pairs = parseMuiGridPairs(gridEl);
            for (const { label, value } of pairs) {
              parts.push(`【${label}】${value}`);
            }
          }
        }
        el = el.nextElementSibling;
      }
      if (parts.length > 0) return parts.join('\n');
    }

    // フォールバック: キーワード検索
    const keywords = ['設備', '設備・条件', '主な設備'];
    for (const keyword of keywords) {
      const walker = document.createTreeWalker(
        document.body, NodeFilter.SHOW_TEXT,
        { acceptNode: (node) => node.textContent.trim() === keyword ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT }
      );
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent) continue;
        const nextSib = parent.nextElementSibling;
        if (nextSib) {
          const text = nextSib.textContent.trim();
          if (text && text.length > 5) return text;
        }
      }
    }

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

    // デバッグ情報
    const _headings = [];
    for (const el of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const t = el.textContent.trim();
      if (t && t.length < 30) _headings.push(`${el.tagName}:${t}`);
    }
    // H3:区画設備 の内部構造をダンプ（サブカテゴリ検出用）
    let _h3ChildDump = '';
    for (const h3 of document.querySelectorAll('h3')) {
      if (h3.textContent.trim() === '区画設備') {
        let nextEl = h3.nextElementSibling;
        if (nextEl) {
          const kids = [];
          // nextElの直下子要素を列挙
          for (const child of nextEl.children) {
            const tag = child.tagName;
            const text = child.textContent.trim().substring(0, 40);
            const childCount = child.children.length;
            const cls = (child.className || '').substring(0, 30);
            kids.push(`${tag}(${childCount})[${cls}]:"${text}"`);
            if (kids.length >= 10) break;
          }
          _h3ChildDump = `parent=${nextEl.tagName},children=${nextEl.children.length}: ${kids.join(' | ')}`;
          // 1階層深くも見る
          if (nextEl.children.length <= 2 && nextEl.children[0]?.children?.length > 2) {
            const inner = nextEl.children[0];
            const innerKids = [];
            for (const child of inner.children) {
              const tag = child.tagName;
              const text = child.textContent.trim().substring(0, 30);
              const cc = child.children.length;
              innerKids.push(`${tag}(${cc}):"${text}"`);
              if (innerKids.length >= 10) break;
            }
            _h3ChildDump += ` | INNER: ${innerKids.join(' | ')}`;
          }
        }
        break;
      }
    }
    // chinshaku_bukken_view のキーをReact Fiberから取得（画像キー調査用）
    let _bvKeys = '';
    try {
      const root = document.getElementById('root');
      if (root) {
        const fiberKey = Object.keys(root).find(k => k.startsWith('__reactFiber'));
        if (fiberKey) {
          const visited = new Set();
          function findBV(fiber, depth) {
            if (!fiber || depth > 20 || visited.has(fiber)) return null;
            visited.add(fiber);
            const props = fiber.memoizedProps || {};
            if (props.specBukkenView) return props.specBukkenView;
            if (props.bukkenDetail) return props.bukkenDetail;
            if (props.detail) return props.detail;
            if (props.property) return props.property;
            return findBV(fiber.child, depth+1) || findBV(fiber.sibling, depth+1);
          }
          const bvData = findBV(root[fiberKey], 0);
          if (bvData) {
            _bvKeys = Object.keys(bvData).sort().join(',');
          }
        }
      }
    } catch(e) {}

    detail._debug = {
      imageCount: detail.image_urls?.length || 0,
      sampleImageUrls: (detail.image_urls || []).slice(0, 3),
      facilitiesLength: detail.facilities?.length || 0,
      facilitiesPreview: (detail.facilities || '').substring(0, 200),
      headings: _headings.slice(0, 15),
      h3ChildDump: _h3ChildDump,
      bvKeys: _bvKeys,
      fieldCount: Object.keys(detail).filter(k => !k.startsWith('_')).length,
    };

    return { ok: true, detail };
  }
})();
