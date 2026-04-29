/**
 * inquiry-score.js
 * 物件の反響予測スコアを計算する (4サイト共通)
 *
 * メインAPI:
 *   globalThis.calculateInquiryScore(input) → { score, label, breakdown }
 *
 * input:
 *   {
 *     rent:           120000,    // 賃料 (円)
 *     managementFee:  5000,      // 管理費 (円)
 *     area:           43.88,     // 専有面積 (㎡)
 *     walkMinutes:    8,         // 最寄り駅徒歩分 (複数路線あれば最短)
 *     buildingAge:    12,        // 築年数 (年)
 *     equipmentFlags: {          // 重要設備フラグ (true なら所持)
 *       autoLock: true,
 *       deliveryBox: true,
 *       washbasin: false,        // 独立洗面
 *       reHeating: false,        // 追い焚き
 *       monitorIntercom: true,
 *       walkInCloset: false,
 *       bathDryer: false,
 *       floor2OrAbove: true,     // 2F以上
 *       depositZero: true,       // 敷金なし
 *       keyMoneyZero: false      // 礼金なし
 *     },
 *     marketMedianPerSqm: 3000   // 相場中央値 (円/㎡、別途取得)
 *   }
 *
 * output:
 *   {
 *     score: 75,              // 総合 0-100
 *     label: '👍 標準以上',
 *     breakdown: {
 *       score1: 80,           // 平米単価 vs 期待相場 (重み 60%)
 *       score2: 65,           // 駅徒歩 (重み 25%)
 *       score3: 64,           // 築年数 (重み 15%)
 *       expectedRent: 144000, // 期待月額 (相場+設備分)
 *       actualPerSqm: 2849,   // 実平米単価
 *       expectedPerSqm: 3284, // 期待平米単価
 *       deviationPct: 13.2,   // 偏差% (+ なら割安)
 *       equipmentCount: 4     // 該当設備数
 *     }
 *   }
 */

const _INQUIRY_EQUIPMENT_KEYS = [
  'autoLock',          // オートロック
  'deliveryBox',       // 宅配ボックス
  'washbasin',         // 独立洗面
  'reHeating',         // 追い焚き
  'monitorIntercom',   // モニター付インターホン
  'walkInCloset',      // ウォークインクローゼット
  'bathDryer',         // 浴室乾燥
  'floor2OrAbove',     // 2F以上
  'depositZero',       // 敷金なし
  'keyMoneyZero'       // 礼金なし
];

const _INQUIRY_EQUIPMENT_PREMIUM_PER_ITEM = 5000; // 設備1個 = 月+5000円相当

/**
 * 反響予測スコアを計算
 */
function calculateInquiryScore(input) {
  const result = {
    score: 0,
    label: '',
    breakdown: {
      score1: null,
      score2: null,
      score3: null,
      expectedRent: null,
      actualPerSqm: null,
      expectedPerSqm: null,
      deviationPct: null,
      equipmentCount: 0
    }
  };

  if (!input) return _finalizeScore(result);

  const rent = Number(input.rent) || 0;
  const mgmt = Number(input.managementFee) || 0;
  const area = Number(input.area) || 0;
  const walk = Number(input.walkMinutes);
  const age = Number(input.buildingAge);
  const eq = input.equipmentFlags || {};
  const median = Number(input.marketMedianPerSqm) || 0;

  // 設備該当数
  let eqCount = 0;
  for (const k of _INQUIRY_EQUIPMENT_KEYS) {
    if (eq[k] === true) eqCount++;
  }
  result.breakdown.equipmentCount = eqCount;

  // === score1: 平米単価 vs 期待相場 (重み60%) ===
  if (rent > 0 && area > 0 && median > 0) {
    const actualMonthly = rent + mgmt;
    const actualPerSqm = actualMonthly / area;
    const expectedMonthly = median * area + eqCount * _INQUIRY_EQUIPMENT_PREMIUM_PER_ITEM;
    const expectedPerSqm = expectedMonthly / area;
    const deviationPct = (expectedPerSqm - actualPerSqm) / expectedPerSqm * 100;
    const score1 = _clamp(0, 100, 50 + deviationPct * 1.67);
    result.breakdown.score1 = Math.round(score1 * 10) / 10;
    result.breakdown.expectedRent = Math.round(expectedMonthly);
    result.breakdown.actualPerSqm = Math.round(actualPerSqm);
    result.breakdown.expectedPerSqm = Math.round(expectedPerSqm);
    result.breakdown.deviationPct = Math.round(deviationPct * 10) / 10;
  }

  // === score2: 駅徒歩 (重み25%) ===
  if (!isNaN(walk) && walk >= 0) {
    const score2 = Math.max(0, 100 - (walk - 1) * 5);
    result.breakdown.score2 = Math.round(score2 * 10) / 10;
  }

  // === score3: 築年数 (重み15%) ===
  // 築15年までは線形(100→55)、それ以降は緩和カーブ。最低20で底打ち。
  // 反響実績との照合: 築30年でも割安+設備が揃えば反響が出るため、線形3pt減点は厳しすぎた
  if (!isNaN(age) && age >= 0) {
    const score3 = age <= 15
      ? 100 - age * 3
      : Math.max(20, 55 - (age - 15) * 1.5);
    result.breakdown.score3 = Math.round(score3 * 10) / 10;
  }

  return _finalizeScore(result);
}

function _finalizeScore(result) {
  // 重み付け合計 (利用可能な指標のみで合算、不足分は重みも除外して再正規化)
  const weights = { score1: 0.60, score2: 0.25, score3: 0.15 };
  let weightedSum = 0;
  let totalWeight = 0;
  for (const k of Object.keys(weights)) {
    const v = result.breakdown[k];
    if (v !== null) {
      weightedSum += v * weights[k];
      totalWeight += weights[k];
    }
  }
  const score = totalWeight > 0 ? weightedSum / totalWeight : 0;
  result.score = Math.round(score);
  result.label = _scoreToLabel(result.score);
  return result;
}

function _scoreToLabel(score) {
  if (score >= 80) return '🔥 高反響予測';
  if (score >= 60) return '👍 標準以上';
  if (score >= 40) return '➖ 普通';
  if (score >= 20) return '🔻 反響少なめ';
  return '⚠️ 厳しい';
}

function _clamp(min, max, v) {
  return Math.max(min, Math.min(max, v));
}

// ============================================================
// 物件データ → スコア入力 への変換ヘルパー
// 4サイト (itandi/ES-Square/いえらぶ/REINS) は概ね統一フィールド
// (facilities, deposit, key_money, floor, floor_text, rent, management_fee,
//  area, building_age, station_info, access) を使う前提
// ============================================================

/**
 * 物件オブジェクトから equipmentFlags を抽出
 *
 * 設備名のバリエーションは background.js (line 4445-4602) の辞書に厳密準拠。
 * 4サイト (itandi/いい生活/いえらぶ/REINS) の実際の表記を網羅:
 *   - 独立洗面: シャンプードレッサー / 独立洗面 / 洗面所独立 / 洗面化粧台 / シャワー付洗面
 *   - 追い焚き: 追焚 / 追い焚 / 追いだき
 *   - モニターIH: モニター付 / TV(orＴＶ)モニタ / TV(orＴＶ)インターホン
 *   - WIC: ウォークインクローゼット / クロゼット / ウォークスルークロゼット / WIC
 *
 * 注: 「浴室暖房乾燥機」「追い炊き」等は4サイトに存在しないため意図的に未対応。
 */
function extractEquipmentFlags(prop) {
  const facilities = String((prop && prop.facilities) || '');
  return {
    autoLock:        /オートロック/.test(facilities),
    deliveryBox:     /宅配(ボックス|BOX)/.test(facilities),
    washbasin:       /シャンプードレッサー|独立洗面|洗面所独立|洗面化粧台|シャワー付洗面/.test(facilities),
    reHeating:       /追焚|追い焚|追いだき/.test(facilities),
    monitorIntercom: /モニター付|[TＴ][VＶ](モニタ|インターホン)/.test(facilities),
    walkInCloset:    /ウォーク(イン|スルー)クロ[ーゼ]?ゼット|WIC/.test(facilities),
    bathDryer:       /浴室乾燥/.test(facilities),
    floor2OrAbove:   _isFloor2OrAbove(prop),
    depositZero:     _isZeroOrNone(prop && (prop.deposit !== undefined ? prop.deposit : prop.shikikin)),
    keyMoneyZero:    _isZeroOrNone(prop && (prop.key_money !== undefined ? prop.key_money : prop.reikin))
  };
}

function _isFloor2OrAbove(prop) {
  if (!prop) return false;
  const f = Number(prop.floor);
  if (isFinite(f) && f >= 2) return true;
  if (isFinite(f) && f >= 1) return false; // 1階確定
  const ft = String(prop.floor_text || prop.floorText || '');
  const m = ft.match(/(\d+)\s*階(?!建)/);
  if (m) {
    const n = parseInt(m[1], 10);
    return n >= 2;
  }
  return false;
}

function _isZeroOrNone(value) {
  if (value === 0 || value === '0') return true;
  if (value === undefined || value === null || value === '') return false;
  const s = String(value).replace(/\s+/g, '');
  if (/^(なし|無し|無|無料|0|０|‐|-|—|ゼロ|0円|0万|0ヶ月|0ケ月|0か月|ゼロ円|0万円)$/.test(s)) return true;
  return false;
}

/**
 * 物件オブジェクトから「最寄り駅徒歩分(最短)」を抽出
 */
function extractWalkMinutes(prop) {
  if (!prop) return null;
  // 1. station_walk_minutes (数値)
  if (prop.station_walk_minutes !== undefined) {
    const n = Number(prop.station_walk_minutes);
    if (isFinite(n) && n >= 0) return n;
  }
  // 2. access 配列 [{walk: 5}, ...]
  if (Array.isArray(prop.access) && prop.access.length > 0) {
    const ws = prop.access.map(a => Number(a && a.walk)).filter(v => isFinite(v) && v > 0);
    if (ws.length > 0) return Math.min(...ws);
  }
  // 3. station_info テキストから「徒歩X分」抽出
  if (prop.station_info) {
    const all = String(prop.station_info).match(/(?:徒歩|歩)\s*(\d+)\s*分/g) || [];
    const mins = all.map(s => parseInt(s.match(/\d+/)[0], 10)).filter(v => isFinite(v) && v > 0);
    if (mins.length > 0) return Math.min(...mins);
  }
  return null;
}

/**
 * 物件オブジェクトから「築年数(年)」を抽出
 */
function extractBuildingAge(prop) {
  if (!prop) return null;
  const ba = String(prop.building_age || prop.buildingAge || '');
  if (/新築/.test(ba)) return 0;
  // "築X年" を最優先
  const m = ba.match(/築\s*(\d+)\s*年/);
  if (m) return parseInt(m[1], 10);
  // 年月表記から計算 (例: "2021年5月")
  const ym = ba.match(/(\d{4})\s*年/);
  if (ym) {
    const y = parseInt(ym[1], 10);
    const now = new Date();
    return Math.max(0, now.getFullYear() - y);
  }
  return null;
}

/**
 * 物件オブジェクト + 相場中央値 → calculateInquiryScore の input 形式に変換
 */
function buildInquiryScoreInput(prop, marketMedianPerSqm) {
  return {
    rent: Number(prop && prop.rent) || 0,
    managementFee: Number(prop && prop.management_fee) || 0,
    area: Number(prop && prop.area) || 0,
    walkMinutes: extractWalkMinutes(prop),
    buildingAge: extractBuildingAge(prop),
    equipmentFlags: extractEquipmentFlags(prop),
    marketMedianPerSqm: marketMedianPerSqm
  };
}

globalThis.calculateInquiryScore = calculateInquiryScore;
globalThis.extractEquipmentFlags = extractEquipmentFlags;
globalThis.extractWalkMinutes = extractWalkMinutes;
globalThis.extractBuildingAge = extractBuildingAge;
globalThis.buildInquiryScoreInput = buildInquiryScoreInput;
