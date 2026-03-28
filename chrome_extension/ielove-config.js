/**
 * ielove-config.js
 * いえらぶBB 検索用の定数・コードマッピング
 * Python ielove_search/config.py から移植
 */

const IELOVE_BASE_URL = 'https://bb.ielove.jp';
const IELOVE_PREFECTURE_CODE = '13'; // 東京都

// 間取りコード (checkbox value)
const IELOVE_LAYOUT_CODES = {
  '1R': '1',
  '1K': '2',
  '1DK': '4',
  '1LDK': '8',
  '2K': '10',
  '2DK': '12',
  '2LDK': '16',
  '3K': '18',
  '3DK': '20',
  '3LDK': '24',
  '4K': '26',
  '4DK': '28',
  '4LDK': '32',
};

// 建物構造: CustomerCriteria の structure_types → いえらぶコード
const IELOVE_STRUCTURE_ALIAS = {
  '鉄筋コンクリート': '4',     // RC
  '鉄骨鉄筋コンクリート': '5', // SRC
  '鉄骨造': '3',
  '軽量鉄骨': '8',
  '軽量鉄骨造': '8',
  '木造': '1',
  'RC': '4',
  'SRC': '5',
};

// いえらぶ構造コード → 正規化名（REINS/itandi と統一するための逆引き）
const IELOVE_STRUCTURE_NORMALIZE = {
  '木造': '木造',
  'ブロック': 'コンクリートブロック',
  '鉄骨造': '鉄骨造',
  'RC': '鉄筋コンクリート',
  'SRC': '鉄骨鉄筋コンクリート',
  'PC': 'プレキャストコンクリート',
  'HPC': '鉄骨プレキャストコンクリート',
  '軽量鉄骨': '軽量鉄骨造',
  'その他': 'その他',
  'ALC': 'ALC造',
  // 詳細ページで日本語名で返ってくる場合
  '鉄筋コンクリート造': '鉄筋コンクリート',
  '鉄骨鉄筋コンクリート造': '鉄骨鉄筋コンクリート',
  '鉄筋コンクリート': '鉄筋コンクリート',
  '鉄骨鉄筋コンクリート': '鉄骨鉄筋コンクリート',
};

// 築年数コード (URLパラメータ値)
const IELOVE_BUILDING_AGE_CODES = {
  3: '3',
  5: '5',
  10: '10',
  15: '15',
  20: '20',
  25: '25',
  30: '30',
  35: '35',
};

// ハード設備 (itandi option_id → いえらぶ opts パラメータ)
// ペット(22010)・事務所(22050)は選択肢が排他的で取りこぼすため取得後フィルタで対応
const IELOVE_HARD_EQUIPMENT_OPTS = {
  19010: ['opts3', '0301'],   // 家具家電付き → 家具・家電付
};

// 駅コード・路線コード（ieloveStationCodes.json からロード）
let IELOVE_STATION_CODES = {};
let IELOVE_LINE_CODES = {};

// Service Worker 内で JSON をロード
async function loadIeloveStationCodes() {
  if (Object.keys(IELOVE_STATION_CODES).length > 0) return;
  try {
    const response = await fetch(chrome.runtime.getURL('ieloveStationCodes.json'));
    const data = await response.json();
    IELOVE_STATION_CODES = data.station_codes || {};
    IELOVE_LINE_CODES = data.line_codes || {};
    console.log(`[ielove] 駅コード ${Object.keys(IELOVE_STATION_CODES).length}件ロード`);
  } catch (err) {
    console.error('[ielove] 駅コード読み込み失敗:', err);
  }
}
