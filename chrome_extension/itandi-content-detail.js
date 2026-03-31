/**
 * itandi-content-detail.js
 * itandi BB 物件詳細ページから情報をスクレイピングするコンテンツスクリプト
 * Python itandi_search/search.py:fetch_room_details() の移植
 *
 * 対象URL: https://itandibb.com/rent_rooms/*
 */

(() => {
  'use strict';

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'ITANDI_EXTRACT_DETAIL') {
      try {
        const result = extractDetail();
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return true;
    }

    if (msg.type === 'ITANDI_CHECK_LOGIN') {
      // ログインページにリダイレクトされていないかチェック
      const isLoggedIn = !window.location.href.includes('itandi-accounts.com/login')
                       && !window.location.href.includes('/login');
      sendResponse({ ok: true, loggedIn: isLoggedIn });
      return true;
    }
  });

  function extractDetail() {
    const detail = {};

    // 1. 画像URL取得: property-images ドメインの全画像
    const imgEls = document.querySelectorAll('img[src*="property-images"]');
    const seen = {};
    const imageUrls = [];
    for (const img of imgEls) {
      const src = img.src;
      if (src && !seen[src]) {
        seen[src] = true;
        imageUrls.push(src);
      }
    }
    detail.image_urls = imageUrls;

    // 2. ステータス・WEBバッジ取得
    const allText = document.body.innerText || '';

    // ステータス
    const knownStatuses = ['申込あり', '成約', '公開停止', '契約済み', '募集中'];
    let listingStatus = '';
    for (const s of knownStatuses) {
      if (allText.includes(s)) {
        listingStatus = s;
        break;
      }
    }
    detail.listing_status = listingStatus;

    // 要物確・要確認フラグ
    detail.needs_confirmation = allText.includes('要物確') || allText.includes('要確認');

    // WEBバッジカウント（3段階フォールバック）
    let webBadgeCount = -1;

    // Approach A: MuiBadge
    const badges = document.querySelectorAll('[class*="Badge-badge"], [class*="badge"]');
    for (const badge of badges) {
      const parent = badge.closest('[class*="Badge-root"]') || badge.parentElement;
      if (parent && parent.textContent.includes('WEB')) {
        const num = parseInt(badge.textContent.trim(), 10);
        webBadgeCount = isNaN(num) ? 0 : num;
        break;
      }
    }

    // Approach B: WEB テキスト＋兄弟バッジ
    if (webBadgeCount === -1) {
      const allEls = document.querySelectorAll('button, span, a');
      for (const el of allEls) {
        const txt = el.textContent.trim();
        if (txt === 'WEB' || txt.startsWith('WEB')) {
          const badgeEl = el.querySelector('[class*="badge"], [class*="Badge"]')
                       || (el.parentElement && el.parentElement.querySelector('[class*="badge"], [class*="Badge"]'));
          if (badgeEl) {
            const num = parseInt(badgeEl.textContent.trim(), 10);
            webBadgeCount = isNaN(num) ? 0 : num;
            break;
          }
        }
      }
    }

    // Approach C: テキスト正規表現
    if (webBadgeCount === -1) {
      const webMatch = allText.match(/WEB[\s\n]+(\d+)/);
      if (webMatch) {
        webBadgeCount = parseInt(webMatch[1], 10);
      }
    }
    detail.web_badge_count = webBadgeCount;

    // 3. 詳細テーブルから情報取得

    // アプローチ1: th/td
    const ths = document.querySelectorAll('th');
    const rawDetails = {};
    for (const th of ths) {
      const key = th.textContent.trim();
      const td = th.nextElementSibling;
      if (td) rawDetails[key] = td.textContent.trim();
    }

    // アプローチ2: テキストからラベル：値パターン
    const text = document.body.innerText || '';
    const labels = [
      '入居可能時期', '入居時期',
      '所在階', '構造', '総戸数',
      '賃貸借の種類', '賃貸借契約の種類', '賃貸借契約区分', '契約区分', '契約形態', '契約期間',
      '解約予告', '解約通知期間',
      '更新・再契約', '契約更新',
      '主要採光面', '向き', '方角',
      '敷引き・償却', '敷引き', '敷引', '償却',
      'ペット飼育時敷金追加', 'ペット',
      'フリーレント',
      '更新事務手数料',
      '更新料',
      '火災保険料', '火災保険', '保険',
      '鍵交換費用', '鍵交換',
      '24時間サポート', '24時間サポート費',
      '敷金積み増し', '敷金積増し',
      '保証金',
      '水道料金形態', '水道料金',
      '駐車場代', '駐輪場代',
      'バイク置き場代', 'バイク置場代',
      'その他月次費用', 'その他一時金',
      '入居条件', '入居者条件',
      '退去日',
      'フリーレント詳細',
      '間取り詳細',
      '内見開始日'
    ];

    const invalidValues = ['表示について', '図面ダウンロード', '物件資料', '物件概要', '入力なし', 'なし'];

    for (const label of labels) {
      const patterns = [
        new RegExp(label + '[：:\\s]+([^\\n|]+)'),
        new RegExp(label + '\\n([^\\n]+)')
      ];
      for (const pat of patterns) {
        const m = text.match(pat);
        if (m && m[1]) {
          let val = m[1].trim().replace(/[|｜].*$/, '').trim();
          if (invalidValues.includes(val)) break;
          if (val && val.length < 300 && val.length > 0 && !rawDetails[label]) {
            rawDetails[label] = val;
          }
          break;
        }
      }
    }

    // アプローチ3: React Label コンポーネント
    const labelEls = document.querySelectorAll('[class*="Label"], [class*="label"]');
    for (const el of labelEls) {
      const key = el.textContent.trim();
      const next = el.nextElementSibling;
      if (next && key && key.length < 30 && !rawDetails[key]) {
        const val = next.textContent.trim();
        if (val && val.length < 300) {
          rawDetails[key] = val;
        }
      }
    }

    // アプローチ4: 設備情報（行ベース・ステートマシン）
    const facilityCats = {
      '建物設備': true, 'バス・トイレ': true, 'キッチン': true,
      '室内設備': true, 'セキュリティ': true, '冷暖房': true,
      '収納': true, 'TV・通信': true, 'その他設備': true,
      '主な設備': true,
      'ライフライン': true, '空調': true, '通信設備': true,
      'その他': true, '入居者条件': true
    };
    const lines = text.split('\n');
    const facilityCategorized = {};
    let currentCat = '';
    let inFac = false;
    const facilitySet = {};

    for (const rawLine of lines) {
      const ln = rawLine.trim();
      if (!ln) continue;
      if (facilityCats[ln]) {
        inFac = true;
        currentCat = ln;
        if (!facilityCategorized[currentCat]) facilityCategorized[currentCat] = [];
        continue;
      }
      if (!inFac) continue;
      if (/^[\d,.]+万?円/.test(ln) || /^¥/.test(ln)) { inFac = false; continue; }
      if (/^(賃料|管理費|共益費|費用|契約|条件$|フリーレント|入居|現況|駐車場代|駐輪場代|バイク置き場代|水道|所在地|交通|物件概要|表示について|図面ダウンロード|物件資料|仲介|取引|敷金|礼金|保証会社|保証金|更新料|更新事務|解約|火災保険|備考|間取り|面積|専有|所在階|総戸数|方角|採光|入力なし|なし$|\d+年|\d+万|出稿|内見予約|WEB$|募集)/.test(ln)) {
        inFac = false; continue;
      }
      if (ln.length > 30) { inFac = false; continue; }
      if (ln === 'その他') continue;
      if (ln.length >= 2 && currentCat && !facilitySet[ln]) {
        facilitySet[ln] = true;
        facilityCategorized[currentCat].push(ln);
      }
    }

    // 空カテゴリ除去
    let hasFac = false;
    for (const cat in facilityCategorized) {
      if (facilityCategorized[cat].length === 0) {
        delete facilityCategorized[cat];
      } else {
        hasFac = true;
      }
    }

    // 設備を整形文字列に変換
    if (hasFac) {
      const parts = [];
      for (const cat in facilityCategorized) {
        if (facilityCategorized[cat].length) {
          parts.push(`【${cat}】${facilityCategorized[cat].join(' / ')}`);
        }
      }
      detail.facilities = parts.join('\n');
    }

    // アプローチ5: 保証情報
    let gIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '保証情報') { gIdx = i; break; }
    }
    if (gIdx >= 0) {
      const gParts = [];
      for (let i = gIdx + 1; i < Math.min(gIdx + 15, lines.length); i++) {
        let ln = lines[i].trim();
        if (!ln) continue;
        if (ln === '備考') break;
        if (/^(賃料|管理費|共益費|費用|契約|設備|物件概要|交通|所在地|間取り|面積|専有|所在階|総戸数|方角|採光|表示|図面|仲介|取引|条件$|建物設備|バス|キッチン|室内|セキュリティ|冷暖房|収納|TV|その他設備|主な設備|出稿|内見|WEB$|募集|火災保険|更新料|更新事務|解約|敷金|礼金|フリーレント|敷引|ペット|保険$)/.test(ln)) break;
        if (/^備考[：:]/.test(ln)) {
          ln = ln.replace(/^備考[：:]\s*/, '');
          if (ln && ln !== '入力なし' && ln !== 'なし') gParts.push(ln);
        } else if (ln !== '入力なし' && ln !== 'なし') {
          gParts.push(ln);
        }
      }
      if (gParts.length > 0) {
        detail.guarantee_info = gParts.join(' ');
      }
    }

    // 4. ラベル → 内部キーへのマッピング
    const labelMapList = [
      ['更新事務手数料', 'renewal_admin_fee'],
      ['更新料', 'renewal_fee'],
      ['更新・再契約', 'renewal_info'],
      ['契約更新', 'renewal_info'],
      ['入居可能時期', 'move_in_date'],
      ['入居時期', 'move_in_date'],
      ['所在階', 'floor_text'],
      ['構造', 'structure'],
      ['総戸数', 'total_units'],
      ['賃貸借契約の種類', 'lease_type'],
      ['賃貸借契約区分', 'lease_type'],
      ['賃貸借の種類', 'lease_type'],
      ['契約区分', 'lease_type'],
      ['契約形態', 'lease_type'],
      ['賃貸借契約期間', 'contract_period'],
      ['契約期間', 'contract_period'],
      ['解約通知期間', 'cancellation_notice'],
      ['解約予告', 'cancellation_notice'],
      ['主要採光面', 'sunlight'],
      ['向き', 'sunlight'],
      ['方角', 'sunlight'],
      ['敷引き・償却', 'shikibiki'],
      ['敷引き', 'shikibiki'],
      ['敷引', 'shikibiki'],
      ['償却', 'shikibiki'],
      ['ペット飼育時敷金追加', 'pet_deposit'],
      ['ペット', 'pet_deposit'],
      ['フリーレント', 'free_rent'],
      ['火災保険料', 'fire_insurance'],
      ['火災保険', 'fire_insurance'],
      ['保険', 'fire_insurance'],
      ['鍵交換費用', 'key_exchange_fee'],
      ['鍵交換', 'key_exchange_fee'],
      ['24時間サポート費', 'support_fee_24h'],
      ['24時間サポート', 'support_fee_24h'],
      ['敷金積み増し', 'additional_deposit'],
      ['敷金積増し', 'additional_deposit'],
      ['保証金', 'guarantee_deposit'],
      ['水道料金形態', 'water_billing'],
      ['水道料金', 'water_billing'],
      ['駐車場代', 'parking_fee'],
      ['駐輪場代', 'bicycle_parking_fee'],
      ['バイク置き場代', 'motorcycle_parking_fee'],
      ['バイク置場代', 'motorcycle_parking_fee'],
      ['その他月次費用', 'other_monthly_fee'],
      ['その他一時金', 'other_onetime_fee'],
      ['入居条件', 'move_in_conditions'],
      ['入居者条件', 'move_in_conditions'],
      ['退去日', 'move_out_date'],
      ['フリーレント詳細', 'free_rent_detail'],
      ['間取り詳細', 'layout_detail'],
      ['内見開始日', 'preview_start_date'],
    ];

    const skipValues = ['-', 'ー', '—', '―', '入力なし', 'なし', '表示について'];

    for (const [rawLabel, value] of Object.entries(rawDetails)) {
      if (!value || skipValues.includes(value)) continue;
      // 「入力なし」のみで構成される値をスキップ
      if (value.includes('入力なし') && value.replace(/入力なし/g, '').replace(/\s/g, '') === '') continue;

      for (const [label, key] of labelMapList) {
        if (rawLabel.includes(label) && !detail[key]) {
          detail[key] = value;
          break;
        }
      }
    }

    return { ok: true, detail };
  }
})();
