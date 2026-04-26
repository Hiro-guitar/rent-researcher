/**
 * essquare-content-detail.js
 * いい生活Square 物件詳細ページから情報をスクレイピングするコンテンツスクリプト
 * Python essquare_search/parsers.py:parse_detail_page() の移植
 *
 * 対象URL: https://rent.es-square.net/bukken/chintai/search/detail/*
 */

(() => {
  'use strict';

  // 重複注入防止（SPA遷移で手動注入されるため）
  // 重要: 一度ロードされたら __essquareContentDetailLoaded を絶対に false に戻さない。
  // false に戻すと、background.jsの chrome.scripting.executeScript({files: [...]}) で
  // 再注入されたときにIIFEが再実行されて onMessage.addListener が重複登録される。
  // 重複登録されると同じメッセージに複数のリスナーが反応してデータの混濁が起きる。
  if (window.__essquareContentDetailLoaded) return;
  window.__essquareContentDetailLoaded = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'ESSQUARE_EXTRACT_DETAIL') {
      try {
        const result = extractDetail();
        // 画像はbackground.jsからMAIN worldで別途取得する
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
    '現況': 'current_status',
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

  // ─── ヘルパー: sleep ───
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ─── Performance APIから画像URLを収集 ───
  function collectPerfImageUrls() {
    const SKIP = /logo|icon|favicon|avatar|badge|chatbot|miibo|okbiz|es-service\.net|onetop|placeholder|spinner|loading|e_square_logo|sfa_main_banner|line\.me|liff/i;
    const SKIP_EXT = /\.(js|css|woff|woff2|ttf|eot|svg|gif)$/i;
    const urls = [];
    const seen = new Set();
    try {
      const entries = performance.getEntriesByType('resource');
      for (const entry of entries) {
        const name = entry.name;
        if (seen.has(name) || SKIP.test(name) || SKIP_EXT.test(name)) continue;
        if (!name.startsWith('http')) continue;
        const isImageExt = /\.(jpg|jpeg|png|webp|bmp|avif)/i.test(name);
        const init = entry.initiatorType;
        const size = (entry.transferSize || 0) + (entry.decodedBodySize || 0);
        // 画像拡張子 OR fetch/XHRで10KB以上（物件画像は通常大きい）
        if (isImageExt || ((init === 'fetch' || init === 'xmlhttprequest') && size > 10000)) {
          urls.push(name);
          seen.add(name);
        }
      }
    } catch (e) {}
    return urls;
  }

  // ─── ギャラリー操作で画像をblob→base64変換しながら収集 ───
  // 参考: 別Chrome拡張の実績あるロジックを移植

  // img要素からcanvas経由でbase64を取得（blob URL fetch不要）
  function imgToBase64(img) {
    try {
      if (!img || !img.complete || img.naturalWidth === 0) return null;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return canvas.toDataURL('image/jpeg', 0.92);
    } catch (e) {
      return null;
    }
  }

  // blob URLをfetchしてbase64に変換（canvas失敗時のフォールバック）
  async function convertBlobToBase64(blobUrl) {
    try {
      const response = await fetch(blobUrl);
      const blob = await response.blob();
      if (!blob || blob.size === 0) return null;
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      return null;
    }
  }

  // NO_IMAGE（SVGプレースホルダー）の判定用
  const NO_IMAGE_BASE64_START = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTI4IiBoZWlnaHQ9Ijk2IiB2aWV3Qm94PSIwIDAgMTI4IDk2IiBmaWxsPSJub25lI";

  async function extractImagesViaGallery() {
    const images = []; // base64画像を直接収集
    let galleryLog = '';

    // サムネイルをクリックしてモーダルを開く
    const thumbnail = document.querySelector('.css-tx2s10 img');
    if (!thumbnail) {
      const fallbackImg = document.querySelector('.swiper img, [class*="swiper"] img');
      if (fallbackImg && fallbackImg.naturalWidth > 0) {
        fallbackImg.click();
      } else {
        return { images: [], galleryLog: 'no_thumbnail' };
      }
    } else {
      thumbnail.click();
    }

    // モーダル表示待ち
    for (let i = 0; i < 50; i++) {
      const img = document.querySelector('.swiper-slide-active img');
      if (img && img.complete && img.naturalWidth > 0) break;
      await sleep(100);
    }

    // === 現在のアクティブスライドの画像をcanvasで取得 ===
    const seenBase64 = new Set();

    function captureActiveImage() {
      const img = document.querySelector('.swiper-slide-active img');
      if (!img || !img.complete || img.naturalWidth === 0) return null;
      let base64 = imgToBase64(img);
      if (!base64) return null;
      if (base64.startsWith(NO_IMAGE_BASE64_START)) return null;
      return base64;
    }

    // 最初の1枚を取得
    const firstBase64 = captureActiveImage();
    let initCount = 0;
    if (firstBase64) {
      seenBase64.add(firstBase64);
      images.push(firstBase64);
      initCount = 1;
    }
    galleryLog += `init:${initCount}`;

    // === ナビゲーションで全画像を収集 ===
    let navCount = 0;
    let dupCount = 0;

    // 次へボタンを探すヘルパー
    function findNextButton() {
      const icon = document.querySelector('svg[data-testid="keyboardArrowRight"]');
      if (!icon) return null;
      let el = icon;
      for (let i = 0; i < 6; i++) {
        el = el.parentElement;
        if (!el) return null;
        const style = window.getComputedStyle(el);
        if (style.pointerEvents === 'none' || el.hasAttribute('disabled')) return null;
        if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button'
            || style.cursor === 'pointer' || el.onclick) {
          return el;
        }
      }
      return icon.parentElement;
    }

    for (let n = 0; n < 60; n++) {
      const btn = findNextButton();
      if (!btn) {
        galleryLog += ` →noBtn@${n}`;
        break;
      }

      // クリック前の画像srcを記録
      const prevImg = document.querySelector('.swiper-slide-active img');
      const prevSrc = prevImg ? prevImg.src : '';

      btn.click();

      // srcが変わるまで待つ（スライドアニメーション+lazy-load対応）
      let newImg = null;
      let changed = false;
      for (let w = 0; w < 40; w++) {
        await sleep(120);
        newImg = document.querySelector('.swiper-slide-active img');
        if (!newImg) continue;
        // src自体が変わった OR 別のimg要素になった
        if (newImg.src && newImg.src !== prevSrc) {
          // ロード完了を待つ
          for (let lw = 0; lw < 20; lw++) {
            if (newImg.complete && newImg.naturalWidth > 0) break;
            await sleep(100);
          }
          changed = true;
          break;
        }
        // 同じsrcでも別のDOM要素（Swiperのクローンスライド）の場合
        if (newImg !== prevImg && newImg.complete && newImg.naturalWidth > 0) {
          changed = true;
          break;
        }
      }

      if (!changed || !newImg) {
        galleryLog += ` →noChg@${n}`;
        continue;
      }

      // canvas描画でbase64取得
      const base64 = imgToBase64(newImg);
      if (!base64 || base64.startsWith(NO_IMAGE_BASE64_START)) {
        continue;
      }

      if (seenBase64.has(base64)) {
        dupCount++;
        if (dupCount >= 5) {
          galleryLog += ` →dup5@${n}`;
          break;
        }
        continue;
      }

      dupCount = 0;
      seenBase64.add(base64);
      images.push(base64);
      navCount++;
    }
    galleryLog += ` nav:${navCount} total:${images.length}`;

    // モーダルを閉じる
    const closeBtn = document.querySelector('.MuiBox-root.css-11p4x25');
    if (closeBtn) {
      closeBtn.click();
      await sleep(300);
    } else {
      // フォールバック: ESCキー
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      await sleep(300);
    }

    console.log(`[ES-Square] ギャラリー画像収集完了: ${images.length}件 (base64) ${galleryLog}`);
    // base64画像とデバッグログを返す
    return { images, galleryLog };
  }

  // ─── 画像をfetchしてbase64化（認証付きコンテキストで実行） ───
  async function fetchImagesAsBase64(imageUrls, maxCount = 10) {
    const results = [];
    for (const url of imageUrls.slice(0, maxCount)) {
      try {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) continue;
        const contentType = resp.headers.get('content-type') || 'image/jpeg';
        if (!contentType.startsWith('image/')) continue;
        const blob = await resp.blob();
        // サイズ制限: 500KB以上はスキップ（GAS送信サイズ考慮）
        if (blob.size > 500000) continue;
        // 小さすぎるものも除外（アイコン等）
        if (blob.size < 5000) continue;
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
        results.push(dataUrl);
      } catch (e) {
        // 認証エラー等は無視
      }
    }
    return results;
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

    // 画像はギャラリー操作後にPerformance APIで取得（メッセージハンドラ側で実施）

    // === 1. KVペア収集 ===
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
    // 「当社管理物件」という設備値は不要なので除去
    if (detail.facilities) {
      detail.facilities = detail.facilities
        // 区切り文字に挟まれたケース（前の区切りごと削除）
        .replace(/([,，、\/])\s*当社管理物件/g, '')
        // 先頭にあるケース（後ろの区切りごと削除）
        .replace(/当社管理物件\s*[,，、\/]\s*/g, '')
        // 単独のケース
        .replace(/当社管理物件/g, '')
        .split('\n')
        .filter(line => line.trim().length > 0)
        .join('\n')
        .trim();
    }

    // === 5. 内見開始日 ===
    const previewDate = extractPreviewStartDate();
    if (previewDate && !detail.preview_start_date) {
      detail.preview_start_date = previewDate;
    }

    // === 5.5. AD広告料（ラベル+値のボックス型） ===
    // 例: <div><p>AD</p><p>1ヶ月</p></div>
    if (!detail.ad_fee) {
      const adPs = document.querySelectorAll('p');
      for (const p of adPs) {
        if (p.textContent.trim() === 'AD') {
          const next = p.nextElementSibling;
          if (next && next.tagName === 'P') {
            const val = next.textContent.trim();
            if (val && val !== 'AD') {
              detail.ad_fee = val;
              break;
            }
          }
        }
      }
    }

    // === 6. ステータス ===
    // 旧実装: ページ全体をDOM走査して「申込あり」「募集中」等のリーフ要素を拾っていたが、
    // 詳細モーダルは検索画面の上に重なる構造で、背景の検索フィルタUI等に混在する
    // 「申込あり」ラベルまで誤って拾ってしまい、全物件が「申込あり」判定される不具合があった。
    // listing_status は一覧ページ側(essquare-background.js の .eds-tag__label 判定)で
    // 正確に取れているため、詳細モーダル側の判定は削除。

    // === 7. 所在階パース ===
    if (detail.floor_text) {
      const m = detail.floor_text.match(/(\d+)/);
      if (m) detail.floor = parseInt(m[1]);
    }

    // ── 元付会社名・元付電話番号 ──
    // ES-Square SPA では前の物件のモーダルDOMが残ったまま新しいモーダルが追加される
    // ことがあり、document.querySelector で取ると初回物件の情報を拾い続ける問題が
    // 発生していた。「現在表示されている要素のうち最後のもの」を採用する。
    const pickLatestVisible = (selector) => {
      const all = Array.from(document.querySelectorAll(selector));
      if (all.length === 0) return null;
      // offsetParent !== null なら可視
      const visible = all.filter(el => el.offsetParent !== null);
      return visible.length > 0 ? visible[visible.length - 1] : all[all.length - 1];
    };

    // 方法①: data-testid="resultItemMotoduke" から取得
    const motoduke = pickLatestVisible('[data-testid="resultItemMotoduke"]');
    if (motoduke) {
      const children = motoduke.children;
      // children[3] = 元付会社名, children[4] = 元付電話番号
      if (children[3]) detail.owner_company = children[3].textContent.trim();
      if (children[4]) detail.owner_phone = children[4].textContent.trim();
    }
    // 方法②フォールバック: 「不動産会社様向け情報」タブ内の「お問合せ先」
    if (!detail.owner_company || !detail.owner_phone) {
      // 可視な MUIグリッドで「お問合せ先」ラベルを探す(後ろから検索 = 最新モーダル優先)
      const allGrids = Array.from(document.querySelectorAll('.MuiGrid-container'))
        .filter(el => el.offsetParent !== null);
      for (let gi = allGrids.length - 1; gi >= 0; gi--) {
        const grid = allGrids[gi];
        const label = grid.querySelector('div');
        if (label && label.textContent.trim() === 'お問合せ先') {
          const valueDiv = grid.querySelectorAll(':scope > div')[1];
          if (valueDiv) {
            const inner = valueDiv.querySelector('div > div:first-child');
            if (inner && !detail.owner_company) {
              detail.owner_company = inner.textContent.trim();
            }
            const telEl = Array.from(valueDiv.querySelectorAll('div'))
              .find(el => el.textContent.includes('TEL:'));
            if (telEl && !detail.owner_phone) {
              const m = telEl.textContent.match(/TEL:\s*([\d-]+)/);
              if (m) detail.owner_phone = m[1];
            }
          }
          break;
        }
      }
    }

    // ── 広告可否（「不動産会社様向け情報」タブ内） ──
    // 必要ならタブをクリックして切り替え
    try {
      const tabs = document.querySelectorAll('[role="tab"]');
      let targetTab = null;
      for (const t of tabs) {
        if (t.textContent.trim() === '不動産会社様向け情報') {
          targetTab = t;
          break;
        }
      }
      if (targetTab && targetTab.getAttribute('aria-selected') !== 'true') {
        targetTab.click();
        // タブ切替のレンダリング待ち（同期的に短く待つ）
        const start = Date.now();
        while (Date.now() - start < 1500) {
          if (document.body.textContent.includes('広告可否')) break;
        }
      }
      // 「広告可否」ラベル行を走査
      const allGrids = document.querySelectorAll('.MuiGrid-container');
      for (const grid of allGrids) {
        const firstDiv = grid.querySelector(':scope > div');
        if (firstDiv && firstDiv.textContent.trim() === '広告可否') {
          const valueDiv = grid.querySelectorAll(':scope > div')[1];
          if (valueDiv) {
            const text = valueDiv.textContent.trim();
            detail.ad_approval_text = text;
            // SUUMOが含まれているかで判定
            detail.suumo_allowed = /SUUMO/i.test(text);
          }
          break;
        }
      }
    } catch (e) {
      console.warn('[ES-Square] 広告可否抽出エラー:', e.message);
    }

    return { ok: true, detail };
  }
})();
