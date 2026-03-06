/**
 * RouteData.gs - 鉄道会社別路線データ
 *
 * create_google_form.js (v3) と同一の路線名を使用。
 * sheets.py が期待する SUUMO 準拠のフォーマットと完全一致。
 */

const ROUTE_COMPANIES = [
  {
    id: 'jr',
    label: 'JR',
    sheetColumn: 'F',  // F列 (index 5)
    routes: [
      'ＪＲ山手線', 'ＪＲ京浜東北線', 'ＪＲ東海道本線', 'ＪＲ常磐線',
      'ＪＲ南武線', 'ＪＲ横浜線', 'ＪＲ横須賀線', 'ＪＲ中央線',
      'ＪＲ青梅線', 'ＪＲ五日市線', 'ＪＲ武蔵野線', 'ＪＲ八高線',
      'ＪＲ埼京線', 'ＪＲ高崎線', 'ＪＲ宇都宮線', 'ＪＲ総武線',
      'ＪＲ総武線快速', 'ＪＲ京葉線', '湘南新宿ライン宇須', '湘南新宿ライン高海'
    ]
  },
  {
    id: 'metro',
    label: '東京メトロ',
    sheetColumn: 'G',  // G列 (index 6)
    routes: [
      '東京メトロ銀座線', '東京メトロ丸ノ内線', '東京メトロ日比谷線',
      '東京メトロ東西線', '東京メトロ千代田線', '東京メトロ有楽町線',
      '東京メトロ半蔵門線', '東京メトロ南北線', '東京メトロ副都心線'
    ]
  },
  {
    id: 'toei',
    label: '都営',
    sheetColumn: 'H',  // H列 (index 7)
    routes: [
      '都営浅草線', '都営三田線', '都営新宿線',
      '都営大江戸線', '都電荒川線', '日暮里・舎人ライナー'
    ]
  },
  {
    id: 'tokyu',
    label: '東急電鉄',
    sheetColumn: 'I',  // I列 (index 8)
    routes: [
      '東急東横線', '東急田園都市線', '東急池上線',
      '東急目黒線', '東急多摩川線', '東急大井町線', '東急世田谷線'
    ]
  },
  {
    id: 'seibu_tobu',
    label: '西武・東武',
    sheetColumn: 'J',  // J列 (index 9)
    routes: [
      '西武有楽町線', '西武新宿線', '西武池袋線', '西武拝島線',
      '西武国分寺線', '西武多摩川線', '西武多摩湖線', '西武豊島線',
      '東武東上線', '東武伊勢崎線', '東武亀戸線', '東武大師線'
    ]
  },
  {
    id: 'keio',
    label: '京王電鉄',
    sheetColumn: 'K',  // K列 (index 10)
    routes: [
      '京王線', '京王新線', '京王井の頭線',
      '京王相模原線', '京王高尾線', '京王競馬場線', '京王動物園線'
    ]
  },
  {
    id: 'keisei_keikyu_odakyu',
    label: '京成・京急・小田急',
    sheetColumn: 'L',  // L列 (index 11)
    routes: [
      '京成本線', '京成押上線', '京成金町線',
      '京急本線', '京急空港線', '小田急線', '小田急多摩線'
    ]
  },
  {
    id: 'other',
    label: 'その他',
    sheetColumn: 'M',  // M列 (index 12)
    routes: [
      '多摩都市モノレール', 'りんかい線', '北総線', '東京モノレール',
      '新交通ゆりかもめ', '埼玉高速鉄道', 'つくばエクスプレス', '成田スカイアクセス'
    ]
  }
];

/**
 * 会社IDから路線データを取得する。
 * @param {string} companyId
 * @return {Object|null}
 */
function getCompanyById(companyId) {
  return ROUTE_COMPANIES.find(c => c.id === companyId) || null;
}

/**
 * 路線名から所属する会社IDを特定する。
 * @param {string} routeName
 * @return {string|null} companyId
 */
function findCompanyForRoute(routeName) {
  for (const company of ROUTE_COMPANIES) {
    if (company.routes.includes(routeName)) {
      return company.id;
    }
  }
  return null;
}

/**
 * 全路線をフラットリストで取得（会社ラベル情報付き）。
 * ページネーション表示時にヘッダーとして会社名を表示するために使用。
 * @return {Array<{company: string, companyId: string, route: string}>}
 */
function getAllRoutesFlat() {
  const flat = [];
  for (const company of ROUTE_COMPANIES) {
    for (const route of company.routes) {
      flat.push({ company: company.label, companyId: company.id, route: route });
    }
  }
  return flat;
}

/**
 * 指定ページの路線一覧に含まれる会社名を取得する。
 * ページヘッダー表示用。
 * @param {number} page - ページ番号（0始まり）
 * @param {number} pageSize - 1ページあたりの件数
 * @return {string} 会社名（複数にまたがる場合はスラッシュ区切り）
 */
function getCompanyLabelForPage(page, pageSize) {
  const flat = getAllRoutesFlat();
  const startIdx = page * pageSize;
  const endIdx = Math.min(startIdx + pageSize, flat.length);
  const pageItems = flat.slice(startIdx, endIdx);
  const companies = [];
  for (const item of pageItems) {
    if (companies.indexOf(item.company) === -1) {
      companies.push(item.company);
    }
  }
  return companies.join(' / ');
}
