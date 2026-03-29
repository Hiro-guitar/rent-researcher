/**
 * ielove-config.js
 * いえらぶBB 検索用の定数・コードマッピング
 * Python ielove_search/config.py から移植
 */

const IELOVE_BASE_URL = 'https://bb.ielove.jp';
const IELOVE_PREFECTURE_CODE = '13'; // 東京都

// 間取りコード (checkbox value)
// メイン間取り → S付き間取りも含めて検索する
const IELOVE_LAYOUT_CODES = {
  '1R': ['1'],
  '1K': ['2', '3'],       // 1K + 1SK
  '1DK': ['4', '5'],      // 1DK + 1SDK
  '1LDK': ['8', '9'],     // 1LDK + 1SLDK
  '2K': ['10', '11'],     // 2K + 2SK
  '2DK': ['12', '13'],    // 2DK + 2SDK
  '2LDK': ['16', '17'],   // 2LDK + 2SLDK
  '3K': ['18', '19'],     // 3K + 3SK
  '3DK': ['20', '21'],    // 3DK + 3SDK
  '3LDK': ['24', '25'],   // 3LDK + 3SLDK
  '4K': ['26', '27'],     // 4K + 4SK
  '4DK': ['28', '29'],    // 4DK + 4SDK
  '4LDK': ['32', '33'],   // 4LDK + 4SLDK
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
