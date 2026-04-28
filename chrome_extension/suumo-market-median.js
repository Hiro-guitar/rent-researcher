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

  // FR301FC001 = 物件単位 (重複排除済み、お客さん向け表示)
  // FR301FC011 (旧) = 広告単位 (同物件が複数広告会社で重複表示)
  const SUUMO_BASE_NEW = 'https://suumo.jp/jj/chintai/ichiran/FR301FC001/';
  const SUUMO_BASE_OLD = 'https://suumo.jp/jj/chintai/ichiran/FR301FC011/?ar=030&bs=040&fw=';

  // 東京都 市区町村JISコード (sc パラメータ用)
  const TOKYO_SC_MAP = {
    '千代田区': '13101', '中央区': '13102', '港区': '13103', '新宿区': '13104',
    '文京区': '13105', '台東区': '13106', '墨田区': '13107', '江東区': '13108',
    '品川区': '13109', '目黒区': '13110', '大田区': '13111', '世田谷区': '13112',
    '渋谷区': '13113', '中野区': '13114', '杉並区': '13115', '豊島区': '13116',
    '北区': '13117', '荒川区': '13118', '板橋区': '13119', '練馬区': '13120',
    '足立区': '13121', '葛飾区': '13122', '江戸川区': '13123',
    '八王子市': '13201', '立川市': '13202', '武蔵野市': '13203', '三鷹市': '13204',
    '青梅市': '13205', '府中市': '13206', '昭島市': '13207', '調布市': '13208',
    '町田市': '13209', '小金井市': '13210', '小平市': '13211', '日野市': '13212',
    '東村山市': '13213', '国分寺市': '13214', '国立市': '13215', '福生市': '13218',
    '狛江市': '13219', '東大和市': '13220', '清瀬市': '13221', '東久留米市': '13222',
    '武蔵村山市': '13223', '多摩市': '13224', '稲城市': '13225', '羽村市': '13227',
    'あきる野市': '13228', '西東京市': '13229',
    '瑞穂町': '13303', '日の出町': '13305', '檜原村': '13307', '奥多摩町': '13308',
    '大島町': '13361', '利島村': '13362', '新島村': '13363', '神津島村': '13364',
    '三宅村': '13381', '御蔵島村': '13382', '八丈町': '13401', '青ヶ島村': '13402',
    '小笠原村': '13421'
  };
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

    // 1. 検索URL構築
    //   - 東京都の住所なら新URL (FR301FC001、物件単位、重複排除済み)
    //   - それ以外は旧URL (FR301FC011) にフォールバック (重複あり)
    const sc = _findTokyoScCode(input.address);
    let url;
    let isNewUrl = false;
    if (sc) {
      // 新URL: ta=13(東京都)+sc=市区町村コード+fw2=町名+間取り
      // 注: SUUMOの mb/mt は㎡数値ではなく面積コード(1〜10等)を期待する仕様らしく
      //     不正値(33等)を渡すとエラーページが返る。よって mb=0/mt=9999999 で
      //     SUUMO側絞り込みは無効化し、面積±10%フィルタは _filterCards で自前処理。
      const fw2Terms = [];
      const banchi = _extractBanchiKeyword(input.address);
      if (banchi) fw2Terms.push(banchi);
      if (input.layout) fw2Terms.push(input.layout);
      if (input.propertyType) fw2Terms.push(input.propertyType);
      const fw2 = fw2Terms.filter(Boolean).join('+');
      url = SUUMO_BASE_NEW
        + '?ar=030&bs=040&ta=13&sc=' + sc
        + '&cb=0.0&ct=9999999&et=9999999&cn=9999999'
        + '&mb=0&mt=9999999'
        + '&shkr1=03&shkr2=03&shkr3=03&shkr4=03'
        + '&fw2=' + encodeURIComponent(fw2)
        + '&srch_navi=1';
      isNewUrl = true;
    } else {
      // フォールバック: 旧URL (重複あり)
      const fwTerms = [_normalizeAddress(input.address), input.layout];
      if (input.propertyType) fwTerms.push(input.propertyType);
      const fw = fwTerms.filter(Boolean).join('+');
      url = SUUMO_BASE_OLD + encodeURIComponent(fw) + '&pc=100';
    }
    result.searchUrl = url;

    // 2. 検索結果HTML取得
    const html = await _fetchText(url);
    if (!html) {
      result.errors.push('SUUMO fetch失敗');
      return result;
    }

    // 3. 物件カードから賃料/管理費/面積/築年/徒歩を抽出
    //   新URL(FR301FC001)と旧URL(FR301FC011)はHTML構造が違うので分岐
    const allCards = isNewUrl ? _parseSuumoCardsNew(html) : _parseSuumoCards(html);
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

  function _toHalfWidthDigits(s) {
    return String(s || '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  }

  function _normalizeAddress(addr) {
    // SUUMO検索向け: 全角数字を半角化 + 都道府県を削除 + 丁目→数字 + 番地末尾除去
    if (!addr) return '';
    let s = _toHalfWidthDigits(String(addr).trim());
    s = s.replace(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/, '');
    // 「町名1丁目18-9」 → 「町名1」 (町名+先頭数字)
    const m = s.match(/^([^\s\d]+?)(\d+)(?:丁目|-)?/);
    if (m) return m[1] + m[2];
    return s.split(/[-\s]/)[0];
  }

  /**
   * 住所文字列から東京都の市区町村JISコードを返す
   * 該当しなければ null (= 旧URLにフォールバック)
   */
  function _findTokyoScCode(addr) {
    if (!addr) return null;
    const s = String(addr);
    // 東京都以外なら null
    if (!/東京都/.test(s)) return null;
    for (const name in TOKYO_SC_MAP) {
      if (s.indexOf(name) >= 0) return TOKYO_SC_MAP[name];
    }
    return null;
  }

  /**
   * 住所から「町名+先頭数字」 (例: 北新宿1) を取り出す。fw2フリーワード用。
   * 都道府県・市区町村は sc コードで指定済みなので、町名以降だけ渡す。
   */
  function _extractBanchiKeyword(addr) {
    if (!addr) return '';
    // 全角数字を半角化 (HOME'S/SUUMO検索でハマる定番)
    let s = _toHalfWidthDigits(String(addr).trim());
    // 都道府県を削除
    s = s.replace(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/, '');
    // 市区町村 (TOKYO_SC_MAP に含まれる名前) を削除
    for (const name in TOKYO_SC_MAP) {
      if (s.indexOf(name) === 0) { s = s.slice(name.length); break; }
    }
    // 「町名1丁目18-9」 → 「町名1」 にトリム
    const m = s.match(/^([^\s\d]+?)(\d+)(?:丁目|-)?/);
    if (m) return m[1] + m[2];
    return s.split(/[-\s]/)[0];
  }

  /**
   * 新URL(FR301FC001 = 物件単位、重複排除済み)用のHTMLパーサ
   *  - .cassetteitem (建物単位) を反復
   *  - 各 cassetteitem 内の <tr class="js-cassette_link"> (部屋単位) を反復
   *  - 建物属性 (タイトル/住所/駅徒歩/築年) はヘッダから1度取得して各部屋に共通付与
   */
  function _parseSuumoCardsNew(html) {
    const cards = [];
    const cassetteRe = /<div class="cassetteitem"[^>]*>([\s\S]*?)(?=<div class="cassetteitem"[^>]*>|<div class="pagination_set-nav"|<\/section\s*>|$)/g;
    let cm;
    while ((cm = cassetteRe.exec(html)) !== null) {
      const cassetteHtml = cm[1];

      // 駅徒歩 (col2 内の各 div、最短)
      let walkMinutes = null;
      const col2Match = cassetteHtml.match(/<li class="cassetteitem_detail-col2[^"]*"[^>]*>([\s\S]*?)<\/li>/);
      if (col2Match) {
        const walks = col2Match[1].match(/歩\s*(\d+)\s*分/g) || [];
        const mins = walks.map(s => parseInt(s.match(/\d+/)[0], 10)).filter(v => isFinite(v) && v > 0);
        if (mins.length > 0) walkMinutes = Math.min(...mins);
      }

      // 築年数 (col3 の最初の div)
      let ageYears = null;
      const col3Match = cassetteHtml.match(/<li class="cassetteitem_detail-col3"[^>]*>\s*<div>([^<]+)<\/div>/);
      if (col3Match) {
        const ageText = col3Match[1].trim();
        if (/新築/.test(ageText)) ageYears = 0;
        else {
          const am = ageText.match(/築\s*(\d+)\s*年/);
          if (am) ageYears = parseInt(am[1], 10);
        }
      }

      // 部屋単位 (<tr class="js-cassette_link">) をループ
      const rowRe = /<tr class="js-cassette_link[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
      let rm;
      while ((rm = rowRe.exec(cassetteHtml)) !== null) {
        const rowHtml = rm[1];

        // 賃料 ("12.5万円")
        const rentMatch = rowHtml.match(/cassetteitem_price--rent[^>]*>[\s\S]*?<span[^>]*>([\d.]+)\s*万円/);
        const rentYen = rentMatch ? Math.round(parseFloat(rentMatch[1]) * 10000) : 0;
        if (!rentYen) continue;

        // 管理費 ("13000円" or "-")
        let mgmtYen = 0;
        const adminMatch = rowHtml.match(/cassetteitem_price--administration[^>]*>([^<]+)</);
        if (adminMatch) {
          const t = adminMatch[1].trim().replace(/[,円\s]/g, '');
          const n = parseInt(t, 10);
          if (isFinite(n) && n > 0) mgmtYen = n;
        }

        // 間取り
        const madoriMatch = rowHtml.match(/<span class="cassetteitem_madori">([^<]+)</);
        const layout = madoriMatch ? madoriMatch[1].trim() : '';

        // 専有面積 ("57.29m<sup>2</sup>")
        const areaMatch = rowHtml.match(/<span class="cassetteitem_menseki">([\d.]+)\s*m/);
        const areaSqm = areaMatch ? parseFloat(areaMatch[1]) : 0;
        if (!areaSqm) continue;

        cards.push({ rentYen, mgmtYen, areaSqm, ageYears, walkMinutes, layout });
      }
    }
    return cards;
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
