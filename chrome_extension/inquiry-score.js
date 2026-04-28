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
  if (!isNaN(age) && age >= 0) {
    const score3 = Math.max(10, 100 - age * 3);
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

globalThis.calculateInquiryScore = calculateInquiryScore;
