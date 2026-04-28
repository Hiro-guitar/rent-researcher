/**
 * suumo-market-median.js
 * SUUMO検索結果から「同条件物件群の平米単価中央値」を取得する。
 * 反響予測スコア計算 (inquiry-score.js) で利用される相場ソース。
 *
 * 既存の suumo-competitor.js とは目的が異なるため独立実装:
 *   - suumo-competitor.js: 賃料・面積完全一致の競合数カウント
 *   - 本ファイル: 同条件物件の平米単価分布から中央値を計算
 *
 * メインAPI:
 *   globalThis.getSuumoMarketMedian(input) → Promise<output>
 *
 * input:
 *   {
 *     address:      "東京都西東京市保谷町1丁目18-9",  // 必須 (町名+番地)
 *     layout:       "1LDK",                          // 必須
 *     area:         43.88,                           // 必須 (㎡)
 *     buildingAge:  10,                              // 任意 (年、未指定なら築年帯フィルタなし)
 *     walkMinutes:  8,                               // 任意 (分、未指定なら徒歩帯フィルタなし)
 *     propertyType: "マンション"                     // 任意
 *   }
 *
 * output:
 *   {
 *     ok:         true,
 *     median:     2950,                              // 平米単価の中央値 (円/㎡、小数切り捨て)
 *     sampleSize: 12,                                // フィルタ後の物件数
 *     filterUsed: 'area+age+walk',                   // 使用したフィルタの種類
 *     searchUrl:  '...',                             // 使用した検索URL
 *     errors:     []
 *   }
 */

(() => {
  'use strict';

  const SUUMO_BASE = 'https://suumo.jp/jj/chintai/ichiran/FR301FC011/?ar=030&bs=040&fw=';
  const FETCH_TIMEOUT_MS = 10000;
  const MIN_SAMPLE_SIZE = 5; // この件数を下回ったらフィルタを段階緩和

  /**
   * メイン: 物件情報から相場中央値を取得
   */
  async function getSuumoMarketMedian(input) {
    const result = {
      ok: false,
      median: null,
      sampleSize: 0,
      filterUsed: 'none',
      searchUrl: null,
      errors: []
    };

    if (!input || !input.address || !input.layout || !input.area) {
      result.errors.push('address / layout / area が必須');
      return result;
    }

    // 1. 検索URL構築 (住所+間取り+建物種別)
    const fwTerms = [_normalizeAddress(input.address), input.layout];
    if (input.propertyType) fwTerms.push(input.propertyType);
    const fw = fwTerms.filter(Boolean).join('+');
    const url = SUUMO_BASE + encodeURIComponent(fw) + '&pc=100';
    result.searchUrl = url;

    // 2. 検索結果HTML取得
    const html = await _fetchText(url);
    if (!html) {
      result.errors.push('SUUMO fetch失敗');
      return result;
    }

    // 3. 物件カードから賃料/管理費/面積/築年/徒歩を抽出
    const allCards = _parseSuumoCards(html);
    if (allCards.length === 0) {
      result.errors.push('物件カード抽出0件');
      return result;
    }

    // 4. フィルタ段階緩和 (5件以上ヒットする条件まで緩める)
    const filterStages = [
      { name: 'area+age+walk', useArea: true, useAge: true, useWalk: true },
      { name: 'area+age',      useArea: true, useAge: true, useWalk: false },
      { name: 'area',          useArea: true, useAge: false, useWalk: false },
      { name: 'all',           useArea: false, useAge: false, useWalk: false }
    ];

    let chosen = null;
    for (const stage of filterStages) {
      const filtered = _filterCards(allCards, input, stage);
      if (filtered.length >= MIN_SAMPLE_SIZE || stage.name === 'all') {
        chosen = { stage, cards: filtered };
        break;
      }
    }

    if (!chosen || chosen.cards.length === 0) {
      result.errors.push('フィルタ後の物件0件');
      return result;
    }

    // 5. 平米単価の中央値
    const perSqmList = chosen.cards
      .map(c => (c.rentYen + c.mgmtYen) / c.areaSqm)
      .filter(v => isFinite(v) && v > 0);
    if (perSqmList.length === 0) {
      result.errors.push('平米単価の有効データなし');
      return result;
    }
    perSqmList.sort((a, b) => a - b);
    const mid = Math.floor(perSqmList.length / 2);
    const median = perSqmList.length % 2 === 0
      ? (perSqmList[mid - 1] + perSqmList[mid]) / 2
      : perSqmList[mid];

    result.ok = true;
    result.median = Math.floor(median);
    result.sampleSize = perSqmList.length;
    result.filterUsed = chosen.stage.name;
    return result;
  }

  // ============================================================
  // 内部ヘルパー
  // ============================================================

  function _normalizeAddress(addr) {
    // SUUMO検索向け: 都道府県を削除し、丁目→数字、番地末尾は除去
    if (!addr) return '';
    let s = String(addr).trim();
    s = s.replace(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/, '');
    // 「町名1丁目18-9」 → 「町名1」 (町名+先頭数字)
    const m = s.match(/^([^\s\d]+?)(\d+)(?:丁目|-)?/);
    if (m) return m[1] + m[2];
    return s.split(/[-\s]/)[0];
  }

  /**
   * SUUMO検索結果HTMLから物件カードを抽出してパースする
   * 戻り値: [{ rentYen, mgmtYen, areaSqm, ageYears, walkMinutes, layout }]
   */
  function _parseSuumoCards(html) {
    const cards = [];
    const cardRegex = /<div\s+class="(property[^"]*js-property[^"]*js-cassetLink[^"]*|property[^"]*js-cassetLink[^"]*js-property[^"]*)"[^>]*>([\s\S]*?)(?=<div\s+class="property[^"]*js-property|<\/div>\s*<\/div>\s*<script|<!--\s*\/\/ \/property_group|<div class="paginate_wrapper">|$)/g;
    const cardMatches = html.match(cardRegex) || [];

    for (const cardHtml of cardMatches) {
      try {
        // 賃料: detailbox-property-point の最初 (例: "12.5万円")
        const rentMatch = cardHtml.match(/class="[^"]*detailbox-property-point[^"]*"[^>]*>([^<]+)</);
        const rentText = rentMatch ? rentMatch[1].trim().replace(/\s/g, '') : '';
        const rentYen = _parseRentText(rentText);
        if (!rentYen) continue;

        // 管理費・共益費: "共益費" の近くの数字
        const mgmtMatch = cardHtml.match(/(?:共益費|管理費)[\s\S]{0,80}?(\d{1,3}(?:,\d{3})*|\d+)\s*円/);
        const mgmtYen = mgmtMatch ? parseInt(String(mgmtMatch[1]).replace(/,/g, ''), 10) : 0;

        // 面積・間取り: detailbox-property--col3
        const col3Match = cardHtml.match(/class="[^"]*detailbox-property--col3[^"]*"[^>]*>([\s\S]*?)<\/td>/);
        let areaSqm = 0;
        let layout = '';
        if (col3Match) {
          const divs = [];
          const divRe = /<div[^>]*>([\s\S]*?)<\/div>/g;
          let dm;
          while ((dm = divRe.exec(col3Match[1])) !== null) {
            divs.push(dm[1].replace(/<[^>]+>/g, '').trim());
          }
          if (divs.length >= 1) layout = divs[0];
          if (divs.length >= 2) {
            const am = divs[1].match(/([\d.]+)/);
            if (am) areaSqm = parseFloat(am[1]);
          }
        }
        if (!areaSqm) continue;

        // 築年数: 「築X年」または「新築」
        let ageYears = null;
        const ageMatch = cardHtml.match(/築\s*(\d+)\s*年/);
        if (ageMatch) {
          ageYears = parseInt(ageMatch[1], 10);
        } else if (/新築/.test(cardHtml)) {
          ageYears = 0;
        }

        // 駅徒歩: 「歩X分」 (複数あれば最短)
        let walkMinutes = null;
        const walkMatches = cardHtml.match(/歩\s*(\d+)\s*分/g);
        if (walkMatches && walkMatches.length > 0) {
          const mins = walkMatches.map(s => parseInt(s.match(/\d+/)[0], 10));
          walkMinutes = Math.min(...mins);
        }

        cards.push({ rentYen, mgmtYen, areaSqm, ageYears, walkMinutes, layout });
      } catch (e) { /* 1枚のパース失敗は無視 */ }
    }
    return cards;
  }

  function _parseRentText(rentText) {
    // "12.5万円" → 125000, "12,500円" → 12500
    if (!rentText) return null;
    const manMatch = rentText.match(/^([\d.]+)\s*万/);
    if (manMatch) {
      const n = parseFloat(manMatch[1]);
      if (isFinite(n) && n > 0) return Math.round(n * 10000);
    }
    const yenMatch = rentText.match(/^(\d{1,3}(?:,\d{3})*|\d+)\s*円/);
    if (yenMatch) {
      const n = parseInt(yenMatch[1].replace(/,/g, ''), 10);
      if (isFinite(n) && n > 0) return n;
    }
    return null;
  }

  /**
   * フィルタ条件で物件カードを絞り込み
   *  useArea: 面積±10%、useAge: 築年±5年、useWalk: 徒歩±5分
   */
  function _filterCards(cards, input, stage) {
    return cards.filter(c => {
      if (stage.useArea) {
        const diff = Math.abs(c.areaSqm - input.area) / input.area;
        if (diff > 0.10) return false;
      }
      if (stage.useAge && input.buildingAge !== undefined && input.buildingAge !== null && c.ageYears !== null) {
        const ageDiff = Math.abs(c.ageYears - input.buildingAge);
        if (ageDiff > 5) return false;
      }
      if (stage.useWalk && input.walkMinutes !== undefined && input.walkMinutes !== null && c.walkMinutes !== null) {
        const walkDiff = Math.abs(c.walkMinutes - input.walkMinutes);
        if (walkDiff > 5) return false;
      }
      return true;
    });
  }

  async function _fetchText(url) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', redirect: 'follow' });
        if (!res.ok) return null;
        return await res.text();
      } finally {
        clearTimeout(t);
      }
    } catch (_) {
      return null;
    }
  }

  globalThis.getSuumoMarketMedian = getSuumoMarketMedian;
})();
