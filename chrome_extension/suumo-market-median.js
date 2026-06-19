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
      const normalizedLayout = _normalizeLayoutForSuumo(input.layout);
      if (normalizedLayout) fw2Terms.push(normalizedLayout);
      // 注: propertyType (マンション/アパート) は fw2 に含めない。
      //     SUUMO の bs=040 は賃貸物件全般 (マンション+アパート) をカバーするため
      //     fw2 にキーワードで入れると、木造でもマンション名で掲載されている
      //     物件などがマッチせず0件になる。bs だけで分類可能。
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
      // propertyType は fw2 同様マッチを狭めすぎるため除外
      const fwTerms = [_normalizeAddress(input.address), _normalizeLayoutForSuumo(input.layout)];
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
   * 4サイト由来の間取り表記を SUUMO検索の fw2 用に正規化する。
   * SUUMO物件詳細テキストでは「ワンルーム」が主流のため、4サイト側で
   * 「1R」と保持されている場合に検索結果が0件になる問題を回避する。
   *
   * 例: 1R / 1ｒ / １Ｒ → ワンルーム
   *     1K / 1LDK / 2DK 等はそのまま (SUUMO物件テキストでも同表記)
   */
  function _normalizeLayoutForSuumo(layout) {
    if (!layout) return '';
    const s = String(layout).trim();
    if (!s) return '';
    // 全角英数を半角化してから判定
    const half = s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    if (/^1R$/i.test(half) || /ワンルーム/.test(s)) return 'ワンルーム';
    return s;
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

        // 階（部屋行の "1階"。"○階建" は建物ヘッダ側なので部屋行には来ない）
        const floorMatch = rowHtml.match(/(B?\d+)\s*階(?!建)/);
        const floor = floorMatch ? floorMatch[1] : '';

        cards.push({ rentYen, mgmtYen, areaSqm, ageYears, walkMinutes, layout, floor });
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

  // 物件の構造文字列 → SUUMO kz コード（鉄筋系=1 / 鉄骨系=2 / 木造=3 / ブロック他=4）
  // ※鉄筋系を先に判定（SRC=鉄骨鉄筋 も鉄筋系に入れる）
  function _suumoKzFromStructure(structure) {
    const s = String(structure || '');
    if (!s) return '';
    if (/鉄筋|鉄骨鉄筋|ＲＣ|RC|ＳＲＣ|SRC|ＲＣ造/.test(s)) return '1'; // 鉄筋系(RC/SRC)
    if (/鉄骨|軽量鉄骨|Ｓ造|S造/.test(s)) return '2';                  // 鉄骨系
    if (/木造|木質|Ｗ造|W造/.test(s)) return '3';                       // 木造
    if (/ブロック|ＰＣ|PC|その他/.test(s)) return '4';                  // ブロック・その他
    return ''; // 不明 → 構造で絞らない
  }

  // SUUMO こだわり条件 tc コード
  const SUUMO_TC_BT_SEPARATE = '0400301'; // バス・トイレ別
  const SUUMO_TC_WASHBASIN   = '0400502'; // 洗面所独立（独立洗面台）

  // 間取り → SUUMO md コード（標準コード。01=ワンルーム…）
  function _suumoMadoriCode(layout) {
    if (!layout) return '';
    const raw = String(layout);
    const s = raw.toUpperCase()
      .replace(/[０-９Ａ-Ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/\s/g, '');
    if (/ワンルーム/.test(raw) || s === '1R') return '01';
    const map = {
      '1K': '02', '1DK': '03', '1LDK': '04',
      '2K': '05', '2DK': '06', '2LDK': '07',
      '3K': '08', '3DK': '09', '3LDK': '10',
      '4K': '11', '4DK': '12', '4LDK': '13'
    };
    if (map[s]) return map[s];
    if (/^[5-9]/.test(s)) return '14'; // 5K以上
    return '';
  }

  // SUUMO 賃料プルダウンの実在バケット（万円）。DOM実測で確定。
  //   3.0〜20.0=0.5刻み / 20.0〜30.0=1.0刻み / 30.0以降=5万刻み(35,40,50) / 50→100。45は無い。
  //   中途半端な値(例7.6)はSUUMOがエラーページを返すため、必ずこの実在値に丸める。
  const SUUMO_RENT_BUCKETS = [
    3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5,
    10.0, 10.5, 11.0, 11.5, 12.0, 12.5, 13.0, 13.5, 14.0, 14.5, 15.0, 15.5,
    16.0, 16.5, 17.0, 17.5, 18.0, 18.5, 19.0, 19.5, 20.0,
    21.0, 22.0, 23.0, 24.0, 25.0, 26.0, 27.0, 28.0, 29.0, 30.0,
    35.0, 40.0, 50.0, 100.0
  ];
  // 賃料(円) → SUUMO ct（賃料上限・万円）。物件が含まれる一番タイトな実在バケットへ繰り上げ。
  function _suumoRentCt(totalYen) {
    if (!totalYen || totalYen <= 0) return '9999999';
    const man = totalYen / 10000;
    for (const b of SUUMO_RENT_BUCKETS) { if (man <= b) return b.toFixed(1); }
    return '9999999'; // 100万超 → 上限なし扱い
  }

  // 専有面積 → SUUMO mb（専有面積下限・㎡）。お客さんは「○㎡以上」で探すので、
  //   自分の広さ以下で一番大きいバケットに丸める（＝自分を含む一番タイトな「○㎡以上」）。
  const SUUMO_AREA_BUCKETS = [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90, 100];
  function _suumoAreaMb(areaSqm) {
    const a = Number(areaSqm);
    if (!isFinite(a) || a <= 0) return '0';
    let mb = 0;
    for (const b of SUUMO_AREA_BUCKETS) { if (b <= a) mb = b; else break; }
    return String(mb); // 20㎡未満なら 0（下限なし）
  }

  // 築年数 → SUUMO cn（築年数上限）。お客さんは「築○年以内」で探すので、
  //   自分の築年を含む一番タイトなバケットに切り上げ（築6→7年以内）。30年超は絞らない。
  const SUUMO_AGE_BUCKETS = [0, 1, 3, 5, 7, 10, 15, 20, 25, 30];
  function _suumoAgeCn(ageYears) {
    const a = Number(ageYears);
    if (!isFinite(a) || a < 0) return '9999999'; // 築年不明 → 絞らない
    // 築年数の推定は「完成年からの年差(月を無視)」で出すことがあり、SUUMOの数え方より
    //   1年低めに出ることがある。cn=自分の築年バケットだと自分自身が cn で除外され
    //   母数0になる(例: 築6年なのに cn=5 で検索されて0件)。+1年の安全マージンで防ぐ。
    const aSafe = a + 1;
    for (const b of SUUMO_AGE_BUCKETS) { if (aSafe <= b) return String(b); }
    return '9999999'; // 30年超 → 絞らない
  }

  // 徒歩分 → SUUMO et（徒歩分数上限）。物件が含まれる一番タイトなバケットに切り上げ。
  const SUUMO_WALK_BUCKETS = [1, 5, 7, 10, 15, 20];
  function _suumoWalkEt(walkMinutes) {
    const w = Number(walkMinutes);
    if (!isFinite(w) || w <= 0) return '9999999'; // 不明 → 徒歩で絞らない
    for (const b of SUUMO_WALK_BUCKETS) { if (w <= b) return String(b); }
    return '9999999'; // 20分超 → 指定なし扱い
  }

  // 路線名の正規化（findStationMatch と同等）
  function _normalizeLineName(name) {
    return String(name || '')
      .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/　/g, ' ')
      .replace(/^JR|^ＪＲ/, '')
      .replace(/線$/, '')
      .trim();
  }

  // 駅名+路線名 → SUUMO 路線コード(lineCode)/駅コード(stationCode)（station-data.js を使用）
  function _resolveStationCode(lineName, stationName) {
    const data = (typeof self !== 'undefined' && self.stationData) ? self.stationData
               : (typeof globalThis !== 'undefined' && globalThis.stationData) ? globalThis.stationData : null;
    if (!data || !stationName) return null;
    const normStation = String(stationName).replace(/駅$/, '').trim();
    const candidates = data.filter(s => s.stationName === normStation);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    const normLine = _normalizeLineName(lineName);
    if (normLine) {
      const lineMatch = candidates.find(s =>
        _normalizeLineName(s.lineName) === normLine ||
        s.lineName.includes(normLine) || normLine.includes(s.lineName));
      if (lineMatch) return lineMatch;
    }
    return candidates[0];
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

  // SUUMO検索結果HTMLから「総件数」を抽出する（1ページ目の件数ではなく全件）
  //   総件数は <div class="paginate_set-hit">465<span>件</span>...（上部）／
  //   <div class="pagination_set-hit">...（下部）に、数字が直下テキストノードで入る。
  //   ※「30件」(表示建物数プルダウン) 等を誤って拾わないよう、必ずこのクラスを起点にする。
  function _parseSuumoHitCount(html) {
    if (!html) return null;
    // SUUMOのエラーページ（不正な ct 値など）→ 件数として0や誤値を拾わないよう null を返す
    if (/必要な情報が不足|画面を表示することができません|エラーが発生しました/.test(html)) return null;
    // 0件ページ（SUUMOは結果数により文言が異なる）。これらを取りこぼすと「抽出失敗」になる。
    if (/条件にあう物件がありません|条件に(?:あう|合う|一致する)物件が(?:ありません|ございません|見つかりません)|該当する物件は(?:ございません|ありません|見つかりません)|物件が見つかりませんでした|該当(?:する)?物件が?0件/.test(html)) return 0;
    const toNum = (s) => {
      const n = parseInt(String(s).replace(/[，,]/g, '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)), 10);
      return isFinite(n) ? n : null;
    };
    // ① クラス paginate_set-hit / pagination_set-hit の直後の数値（最も確実）
    let m = html.match(/class="[^"]*paginat(?:e|ion)_set-hit[^"]*"[^>]*>\s*([0-9０-９,，]+)/);
    if (m) return toNum(m[1]);
    // ② フォールバック: タグ除去して「物件総数」アンカー
    const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ');
    m = text.match(/([0-9０-９,，]+)\s*件[\s\S]{0,40}?物件総数/);
    if (!m) m = text.match(/物件総数[\s\S]{0,40}?([0-9０-９,，]+)\s*件/);
    if (m) return toNum(m[1]);
    return null;
  }

  // ============================================================
  // 物件ポテンシャル = お客さんの実検索の中での「安い順の順位」
  //   土俵 = 駅(rn/ek) ＋ 徒歩○分以内(et) ＋ 構造(kz) ＋ 設備(tc) ＋ 間取り(md) ＋ 管理費込み(co=1)
  //   順位 = その土俵で「賃料(管理費込み) ≤ 自分」の件数（SUUMOの総件数で取得。小さいほど強い）
  //   ※全ページ取得は非現実的なので、ct(賃料上限)=自分の総額 にした検索の件数で位置を出す
  // ============================================================
  /**
   * @param {Object} input
   *   address, layout, area, rent, managementFee, walkMinutes,
   *   structure: string,    // 構造文字列 → kz に変換（鉄筋系1/鉄骨系2/木造3/他4）
   *   btSeparate: boolean,  // バス・トイレ別を持つか → tc=0400301
   *   washbasin: boolean,   // 独立洗面台(洗面所独立)を持つか → tc=0400502
   *   lineName, stationName // 最寄り駅（駅基準検索に使用。無ければ市区町村にフォールバック）
   *   ※設備は「持っているものだけ」絞る（SUUMOは「なし」では絞れない仕様）
   * @returns {Promise<{ok, rank, cheaperCount, sampleSize, searchMode, station, segment, searchUrl, rankUrl, errors}>}
   */
  async function getSuumoSegmentRank(input) {
    const result = {
      ok: false, rank: null, cheaperCount: null, sampleSize: 0,
      subjectPerSqm: null, median: null, filterUsed: 'none',
      searchUrl: null, searchMode: null, station: null,
      segment: { kz: null, tc: [] }, errors: []
    };
    if (!input || !input.address || !input.layout || !input.area) {
      result.errors.push('address / layout / area が必須'); return result;
    }
    const subjRent = Number(input.rent) || 0;
    const subjMgmt = Number(input.managementFee) || 0;
    const subjArea = Number(input.area) || 0;
    if (!(subjRent > 0 && subjArea > 0)) { result.errors.push('rent / area が必須'); return result; }
    const subjectPerSqm = (subjRent + subjMgmt) / subjArea;
    result.subjectPerSqm = Math.round(subjectPerSqm);

    // ── 階級（SUUMO正式パラメータ）を構築 ──
    //   構造: 物件の kz グループに固定（鉄筋系 vs 鉄骨系で土俵が変わる）
    //   設備: 物件が「持っている」設備だけ tc で絞る（SUUMOは「なし」では絞れない仕様）
    const kzCode = _suumoKzFromStructure(input.structure);
    const tcCodes = [];
    if (input.btSeparate) tcCodes.push(SUUMO_TC_BT_SEPARATE);
    if (input.washbasin) tcCodes.push(SUUMO_TC_WASHBASIN);
    const segParams = (kzCode ? '&kz=' + kzCode : '') + tcCodes.map(c => '&tc=' + c).join('');
    result.segment = { kz: kzCode || null, tc: tcCodes.slice() };

    // ── 検索URL構築（お客さんの実検索に合わせる）──
    //   駅(rn/ek) ＋ 徒歩○分以内(et) ＋ 構造(kz) ＋ 設備(tc) ＋ 間取り(md) ＋ 管理費込み(co=1)
    //   順位は「賃料(管理費込み)≤自分」の件数で求める（全件踏まえて正確。1ページ目だけ読まない）
    const normalizedLayout = _normalizeLayoutForSuumo(input.layout);
    const mdCode = _suumoMadoriCode(input.layout);
    const mdParam = mdCode ? '&md=' + mdCode : '';
    const etVal = _suumoWalkEt(input.walkMinutes);
    result.segment.md = mdCode || null;
    result.segment.et = etVal;

    const station = _resolveStationCode(input.lineName, input.stationName);
    let locParams = '', fw2 = '', isNewUrl = true;
    if (station && station.stationCode && station.lineCode) {
      result.searchMode = 'station';
      result.station = { line: station.lineName, name: station.stationName, ek: station.stationCode, rn: station.lineCode };
      locParams = '&ra=013&rn=' + station.lineCode + '&ek=' + station.stationCode;
      fw2 = mdCode ? '' : (normalizedLayout ? encodeURIComponent(normalizedLayout) : '');
    } else {
      const sc = _findTokyoScCode(input.address);
      if (sc) {
        result.searchMode = 'area';
        locParams = '&ta=13&sc=' + sc;
        const fw2Terms = [];
        const banchi = _extractBanchiKeyword(input.address);
        if (banchi) fw2Terms.push(banchi);
        if (!mdCode && normalizedLayout) fw2Terms.push(normalizedLayout);
        fw2 = encodeURIComponent(fw2Terms.filter(Boolean).join('+'));
      } else {
        result.searchMode = 'fw';
        isNewUrl = false;
      }
    }

    // ── 専有面積「○㎡以上」を追加（お客さんは下限だけで探す）──
    //   自分の広さを含む一番タイトな「○㎡以上」に絞る → 似た広さの中での割安度＝ほぼ平米単価順位。
    //   上限は付けない（mt=9999999）。これで「自分より狭い物件」が比較から外れる。
    const mbVal = _suumoAreaMb(subjArea);
    result.segment.mb = mbVal;

    // ── 築年数「築○年以内」を追加（お客さんは築年でも絞る。母数が減り同条件になる）──
    const cnVal = _suumoAgeCn(input.buildingAge);
    result.segment.cn = cnVal;

    // ── 順位 = お客さんの「安い順」一覧で、自分より安い部屋が何件あるか ──
    //   SUUMOの件数表示(paginate_set-hit)は同一部屋の重複広告まで数える(水増し)ので順位に使えない。
    //   一覧は重複排除済みなので、安い順1ページ目をパースし、賃料(管理費込み)が自分未満の部屋を数える。
    //   価格は実数比較なのでバケット誤差なし。po1=12=賃料+管理費が安い順 / pc=50 / co=1。
    const subjectTotal = subjRent + subjMgmt;
    result.subjectTotalRent = subjectTotal;

    const _segUrl = () => {
      if (!isNewUrl) {
        const fwTerms = [_normalizeAddress(input.address), normalizedLayout];
        return SUUMO_BASE_OLD + encodeURIComponent(fwTerms.filter(Boolean).join('+'))
          + segParams + '&co=1&et=' + etVal + '&mb=' + mbVal + '&mt=9999999&cn=' + cnVal
          + '&cb=0.0&ct=9999999&po1=12&pc=50';
      }
      return SUUMO_BASE_NEW
        + '?ar=030&bs=040' + locParams
        + '&cb=0.0&ct=9999999&co=1&et=' + etVal + '&cn=' + cnVal
        + '&mb=' + mbVal + '&mt=9999999'
        + segParams + mdParam
        + '&shkr1=03&shkr2=03&shkr3=03&shkr4=03'
        + '&po1=12&pc=50'
        + '&fw2=' + fw2
        + (result.searchMode === 'area' ? '&srch_navi=1' : '');
    };

    const listUrl = _segUrl();   // 同条件・安い順・1ページ目（最安から50棟）
    result.searchUrl = listUrl;
    result.rankUrl = listUrl;

    const html = await _fetchText(listUrl);
    if (!html) { result.errors.push('SUUMO fetch失敗'); return result; }
    const adCount = _parseSuumoHitCount(html);   // 広告数(重複込み・参考値)。順位には使わない
    result.adCount = adCount;

    // 一覧の部屋をパース → 同一部屋(同スペック)の重複を排除（賃料|管理費|面積|間取り|築年|階）
    const rawRooms = isNewUrl ? _parseSuumoCardsNew(html) : _parseSuumoCards(html);
    const seen = new Set(), uniq = [];
    for (const c of rawRooms) {
      if (!c.rentYen || !c.areaSqm) continue;
      const key = c.rentYen + '|' + c.mgmtYen + '|' + c.areaSqm + '|' + c.layout + '|' + c.ageYears + '|' + (c.floor || '');
      if (seen.has(key)) continue;
      seen.add(key); uniq.push(c);
    }

    if (!uniq.length) {
      // 0件（競合なし＝自分が唯一/最安）なら 1位。パース失敗（広告はあるのに0件）はエラー。
      if (adCount === 0) { result.sampleSize = 0; result.cheaperCount = 0; result.rank = 1; result.inPage1 = true; result.ok = true; return result; }
      result.errors.push('一覧パース0件(広告数=' + (adCount == null ? '?' : adCount) + ')');
      return result;
    }

    const totals = uniq.map(c => c.rentYen + c.mgmtYen).sort((a, b) => a - b);
    result.sampleSize = totals.length;   // 1ページ目の重複排除後の部屋数

    const cheaper = totals.filter(t => t < subjectTotal).length;
    result.cheaperCount = cheaper;
    result.rank = cheaper + 1;            // 安い順で自分が何番目か（実価格比較＝バケット誤差なし）

    // 1ページ目に自分が入るか: 50棟表示(=次ページあり)で、自分が1ページ目の最高額より高ければ圏外
    const cassetteCount = (html.match(/class="cassetteitem"/g) || []).length;
    const pageFull = cassetteCount >= 50;
    const shownMax = totals[totals.length - 1];
    result.pageFull = pageFull;
    result.inPage1 = (!pageFull) || (subjectTotal <= shownMax);
    result.ok = true;
    return result;
  }

  globalThis.getSuumoMarketMedian = getSuumoMarketMedian;
  globalThis.getSuumoSegmentRank = getSuumoSegmentRank;
})();
