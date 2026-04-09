/**
 * background.js (Service Worker)
 * 物件自動取得の中核 — スケジューリング、検索オーケストレーション、状態管理
 * REINS + いえらぶBB対応
 *
 * 重要な技術的制約:
 * - REINSはVue 2 SPA。execute()をJS直接呼び出しすると認証エラーになる
 * - 条件セットはVue $dataに直接代入（scriptタグ注入・MAIN world）
 * - 検索実行・OKダイアログはDOMクリック（人間操作と同じ）
 * - 検索フォームへの遷移はURL直接遷移NG → メニューボタンクリック経由
 */

// 駅名解決失敗を蓄積するグローバル変数（検索サイクルごとにリセット）
// { customerName: { service: [stationName, ...], ... }, ... }
let _unresolvedStations = {};

// 他サイトで「申込あり」として弾いた物件のキーを永続化(7日TTL)
// 形式: { "<building>|<room>": <timestamp>, ... }
// REINSが最初に走るため、前回以前の実行で収集したキーを参照する
const __MOSHIKOMI_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日。期間内に他サイトが再度申込ありを検出すれば都度延長される
globalThis.__moshikomiSkipMap = {};
chrome.storage.local.get(['moshikomiSkipMap'], (d) => {
  const m = d.moshikomiSkipMap || {};
  const now = Date.now();
  for (const k in m) { if (now - m[k] < __MOSHIKOMI_TTL_MS) globalThis.__moshikomiSkipMap[k] = m[k]; }
});
globalThis.__normMoshikomiKey = (building, room) => {
  const nb = String(building || '').replace(/\s+/g, '').toLowerCase();
  const nr = String(room || '').replace(/[^\d]/g, '');
  if (!nb || !nr) return '';
  return `${nb}|${nr}`;
};
globalThis.__addMoshikomiKey = (building, room) => {
  const k = globalThis.__normMoshikomiKey(building, room);
  if (!k) return;
  globalThis.__moshikomiSkipMap[k] = Date.now();
  // 保存(デバウンスせず都度。サイズは小さい想定)
  chrome.storage.local.set({ moshikomiSkipMap: globalThis.__moshikomiSkipMap }).catch(()=>{});
};
globalThis.__removeMoshikomiKey = (building, room) => {
  const k = globalThis.__normMoshikomiKey(building, room);
  if (!k) return;
  if (globalThis.__moshikomiSkipMap[k]) {
    delete globalThis.__moshikomiSkipMap[k];
    chrome.storage.local.set({ moshikomiSkipMap: globalThis.__moshikomiSkipMap }).catch(()=>{});
  }
};
globalThis.__hasMoshikomiKey = (building, room) => {
  const k = globalThis.__normMoshikomiKey(building, room);
  if (!k) return false;
  const ts = globalThis.__moshikomiSkipMap[k];
  return !!(ts && (Date.now() - ts < __MOSHIKOMI_TTL_MS));
};

// バス・トイレ別の処理モード（'alert' or 'skip'）— options画面で設定
let __btMode = 'alert';
chrome.storage.local.get(['btMode'], (d) => { if (d.btMode) __btMode = d.btMode; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.btMode) __btMode = changes.btMode.newValue || 'alert';
});

// いえらぶBB関連ファイルを読み込み
importScripts('ielove-config.js', 'ielove-background.js');
// itandi BB関連ファイルを読み込み
importScripts('itandi-config.js', 'itandi-background.js');
// ES-Square関連ファイルを読み込み
importScripts('essquare-config.js', 'essquare-background.js');

// 拡張アイコンクリックでダッシュボード（log.html）を開く
chrome.action.onClicked.addListener(() => {
  openLogTab();
});

// === REINS物件番号オートサーチ（Discordリンクから #bukken=XXX で起動） ===
const __reinsAutoSearchHandled = new Set(); // tabIdごとに進行中フラグ
async function __getAutomationTabId() {
  try {
    const r = await new Promise(res => chrome.storage.local.get(['reinsAutomationTabId'], res));
    return r?.reinsAutomationTabId || null;
  } catch (e) { return null; }
}
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab.url || !tab.url.includes('system.reins.jp')) return;
  const m = tab.url.match(/[#?&]bukken=(\d+)/);
  if (!m) return;
  if (changeInfo.status !== 'complete' && !changeInfo.url) return;
  const num = m[1];
  // 自動取得タブまたは検索結果/詳細ページがbukkenで上書きされた → 元に戻して別タブで開く
  const automationTabId = await __getAutomationTabId();
  const isAutomationTab = automationTabId === tabId;
  const isAutomationPage = /GBK002200|GBK003200/.test(tab.url);
  if (isAutomationTab || isAutomationPage) {
    // 自動取得タブには触らない（goBackするとVue状態が壊れる）。新規タブで開く
    try { await chrome.tabs.create({ url: 'https://system.reins.jp/main/BK/GBK004100#bukken=' + num, active: true }); } catch (e) {}
    return;
  }
  const key = tabId + ':' + num;
  if (__reinsAutoSearchHandled.has(key)) return;
  __reinsAutoSearchHandled.add(key);
  try {
    await reinsAutoSearchByNumber(tabId, num);
  } catch (e) {
    console.error('reinsAutoSearchByNumber error:', e);
  } finally {
    setTimeout(() => __reinsAutoSearchHandled.delete(key), 60000);
  }
});

async function reinsAutoSearchByNumber(tabId, num) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // ログイン画面なら諦める
  const tab0 = await chrome.tabs.get(tabId);
  if (/login|GKG001/i.test(tab0.url || '')) return;

  // 1) 物件番号検索ページへ遷移（Vueルーター経由）
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      try {
        const n = window.$nuxt;
        if (n && n.$router) { n.$router.push('/main/BK/GBK004100'); return 'router'; }
      } catch (e) {}
      location.assign('https://system.reins.jp/main/BK/GBK004100');
      return 'location';
    }
  });

  // 2) GBK004100到達 & 物件番号入力欄出現を待つ
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const t = await chrome.tabs.get(tabId);
    if (!t.url?.includes('GBK004100')) continue;
    const ready = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')];
        for (const el of inputs) {
          const ctx = el.closest('.p-label, .form-group, div')?.parentElement?.textContent || '';
          if (ctx.includes('物件番号')) return true;
        }
        return false;
      }
    });
    if (ready?.[0]?.result) break;
  }

  // 3) 物件番号入力 → 検索ボタンクリック（MAIN worldでVue互換）
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (number) => {
      const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')];
      let target = null;
      for (const el of inputs) {
        const ctx = el.closest('.p-label, .form-group, div')?.parentElement?.textContent || '';
        if (ctx.includes('物件番号')) { target = el; break; }
      }
      if (!target) return 'no_input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(target, number);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      setTimeout(() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '検索');
        if (btn) btn.click();
      }, 300);
      return 'ok';
    },
    args: [num]
  });

  // 4) 検索結果ページ到達(GBK004200) → 詳細ボタンクリック
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const t = await chrome.tabs.get(tabId);
    if (!t.url?.includes('GBK004200')) continue;
    const clicked = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const detail = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '詳細');
        if (detail) { detail.click(); return true; }
        return false;
      }
    });
    if (clicked?.[0]?.result) break;
  }
}

// === GAS API クライアント（inline） ===
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['gasWebappUrl', 'gasApiKey', 'discordWebhookUrl'], resolve);
  });
}

async function gasGet(action, params = {}) {
  const { gasWebappUrl, gasApiKey } = await getConfig();
  if (!gasWebappUrl) throw new Error('GAS URLが設定されていません');
  const url = new URL(gasWebappUrl);
  url.searchParams.set('action', action);
  url.searchParams.set('api_key', gasApiKey || '');
  url.searchParams.set('_t', Date.now()); // キャッシュバスティング
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(url.toString(), { redirect: 'follow', signal: controller.signal, cache: 'no-store' });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`GAS応答エラー: ${resp.status}`);
    return resp.json();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error(`GASリクエストタイムアウト (${action})`);
    throw err;
  }
}

async function gasPost(body) {
  const { gasWebappUrl, gasApiKey } = await getConfig();
  if (!gasWebappUrl) throw new Error('GAS URLが設定されていません');
  body.api_key = gasApiKey || '';
  const resp = await fetch(gasWebappUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(body),
    redirect: 'follow'
  });
  if (!resp.ok) throw new Error(`GAS応答エラー: ${resp.status}`);
  return resp.json();
}

async function fetchCriteria() { return gasGet('get_criteria'); }
async function fetchSeenIds() { return gasGet('get_seen_ids'); }
async function submitProperties(customerName, properties) {
  return gasPost({ action: 'add_reins_property', customer_name: customerName, properties });
}
// === END GAS API クライアント ===

// === room_id ハッシュ化（ソース・ID形式の匿名化） ===
// 顧客向けURLにはハッシュ化したroom_idを使用し、
// どのサイトから取得したか・IDの形式から推測されないようにする。
const ROOM_ID_SALT = 'rr_v1_k7x9q2mA8pL5nC3bZ';
async function hashRoomId(source, rawId) {
  const input = ROOM_ID_SALT + '|' + (source || '') + '|' + (rawId || '');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
// === END room_id ハッシュ化 ===

// === lineNameMap + reinsCodeMap ===
let cachedLineNameMap = null;
async function loadLineNameMap() {
  if (cachedLineNameMap) return cachedLineNameMap;
  const response = await fetch(chrome.runtime.getURL("lineNameMap.json"));
  cachedLineNameMap = await response.json();
  return cachedLineNameMap;
}

// 顧客の検索条件を1行の文字列にまとめる
function formatCustomerCriteria(customer) {
  const parts = [];
  if (customer.rent_max) parts.push(`〜${customer.rent_max}万`);
  // 路線・駅をまとめて表示（buildStationStringと同じ形式）
  const stationStr = buildStationString(customer);
  if (stationStr) parts.push(stationStr);
  if (customer.walk) parts.push(`徒歩${customer.walk}分`);
  if (customer.layouts?.length) parts.push(`間取: ${customer.layouts.join('/')}`);
  if (customer.area_min) parts.push(`面積${customer.area_min}㎡〜`);
  if (customer.building_age) parts.push(`築${customer.building_age}年`);
  if (customer.structures?.length) parts.push(`構造: ${customer.structures.join('/')}`);
  const equip = customer.equipment;
  if (equip) {
    if (Array.isArray(equip)) {
      if (equip.length) parts.push(`設備: ${equip.join(', ')}`);
    } else if (typeof equip === 'string' && equip) {
      parts.push(`設備: ${equip}`);
    }
  }
  return parts.join(' / ') || '(条件なし)';
}

let cachedReinsCodeMap = null;
async function loadReinsCodeMap() {
  if (cachedReinsCodeMap) return cachedReinsCodeMap;
  const response = await fetch(chrome.runtime.getURL("reinsCodeMap.json"));
  cachedReinsCodeMap = await response.json();
  return cachedReinsCodeMap;
}

// 顧客条件からstation文字列を組み立て
function buildStationString(customer) {
  const rws = customer.routes_with_stations || [];
  if (rws.length > 0) {
    return rws.map(r => {
      if (r.stations && r.stations.length > 0) {
        return `${r.route}：${r.stations.join(', ')}`;
      }
      return r.route;
    }).join(' / ');
  }
  // フォールバック（旧フォーマット）
  const routes = customer.routes || [];
  const stations = customer.stations || [];
  if (routes.length === 0) return '';
  if (routes.length === 1) {
    const stationList = stations.join(', ');
    return stationList ? `${routes[0]}：${stationList}` : routes[0];
  }
  return routes.join(' / ');
}

// 顧客条件に基づく物件フィルタリング
function filterByCustomerCriteria(properties, customer) {
  return properties.filter(prop => !getFilterRejectReason(prop, customer));
}

// フィルタ不合格の理由を返す（合格ならnull）
function getFilterRejectReason(prop, customer) {
  // 構造フィルタ（顧客条件は「鉄筋系」等のカテゴリ名、REINS詳細は日本語名に正規化済み）
  if (customer.structures && customer.structures.length > 0) {
    if (!prop.structure) return `構造不明（要求: ${customer.structures.join('/')})`;
    // カテゴリ→許可する日本語構造名の展開
    const categoryMap = {
      '鉄筋系': ['鉄筋コンクリート', '鉄骨鉄筋コンクリート'],
      '鉄骨系': ['鉄骨造', '軽量鉄骨造'],
      '木造': ['木造'],
      'ブロック・その他': ['コンクリートブロック', 'ALC造', 'プレキャストコンクリート', '鉄骨プレキャストコンクリート', 'その他']
    };
    // 許可する構造名のセットを構築
    const allowedNames = new Set();
    for (const s of customer.structures) {
      if (categoryMap[s]) {
        categoryMap[s].forEach(n => allowedNames.add(n));
      } else {
        allowedNames.add(s);
      }
    }
    if (!allowedNames.has(prop.structure)) {
      return `構造不一致: ${prop.structure}（要求: ${customer.structures.join('/')})`;
    }
  }

  // 他サイト(itandi/ES-Square/いえらぶ)で申込ありとして弾かれた物件は同一実行内でREINSでもスキップ
  try {
    if (globalThis.__hasMoshikomiKey && globalThis.__hasMoshikomiKey(prop.building_name, prop.room_number)) {
      return '他サイトで申込あり(前回実行)';
    }
  } catch(e) {}

  // 新築フィルタ（顧客が「新築」指定の場合、新築フラグが「新築」の物件のみ通過）
  if (customer.building_age && String(customer.building_age).includes('新築')) {
    if (!prop.shinchiku_flag || !prop.shinchiku_flag.includes('新築')) {
      return `新築でない: 新築フラグ=${prop.shinchiku_flag || 'なし'}`;
    }
  }

  // 賃料＋管理費フィルタ（顧客の rent_max は管理費込みの上限）
  if (customer.rent_max && prop.rent) {
    const rentMaxYen = parseFloat(customer.rent_max) * 10000;
    const totalRent = prop.rent + (prop.management_fee || 0);
    if (totalRent > rentMaxYen) {
      return `賃料+管理費超過: ${totalRent}円 > ${rentMaxYen}円（賃料${prop.rent}+管理費${prop.management_fee || 0}）`;
    }
  }

  // 駅名＋徒歩フィルタ
  let allStations = customer.stations || [];
  if (customer.routes_with_stations && customer.routes_with_stations.length > 0) {
    const rwsStations = customer.routes_with_stations.flatMap(r => r.stations || []);
    if (rwsStations.length > 0) allStations = rwsStations;
  }

  if (allStations.length > 0) {
    // メイン駅 + その他交通をすべて結合して判定
    const transports = [];
    if (prop.station_info) {
      transports.push(...prop.station_info.split('/').map(s => s.trim()));
    }
    if (prop.other_stations && prop.other_stations.length > 0) {
      transports.push(...prop.other_stations.map(s => s.trim()));
    }

    if (transports.length === 0) {
      return '交通情報なし';
    }

    const walkMax = customer.walk ? parseInt(String(customer.walk).replace(/[^\d]/g, '')) : 0;

    const normStn = (s) => String(s || '').replace(/駅$/, '').trim();
    const hasMatch = transports.some(transport => {
      const tNorm = normStn(transport);
      const stationMatch = allStations.some(s => {
        const sn = normStn(s);
        return sn && tNorm.includes(sn);
      });
      if (!stationMatch) return false;
      if (walkMax > 0) {
        const walkMatch = transport.match(/徒歩\s*(\d+)/);
        if (walkMatch) {
          const propWalk = parseInt(walkMatch[1]);
          if (propWalk > walkMax) return false;
        }
      }
      return true;
    });
    if (!hasMatch) {
      const allTransportStr = transports.join(' / ');
      if (walkMax > 0) {
        return `駅/徒歩不一致: ${allTransportStr}（徒歩${walkMax}分以内）`;
      }
      return `駅不一致: ${allTransportStr}`;
    }
  }

  // 間取りフィルタ（REINS検索はタイプ×部屋数のクロス積のため、詳細取得後に正確にフィルタ）
  if (customer.layouts && customer.layouts.length > 0 && prop.layout) {
    // REINS間取りタイプをお客さんのカテゴリに正規化
    // LK→LDK, SK→K, SDK→DK, SLK→LDK, SLDK→LDK
    const normalizeType = (t) => {
      const u = t.replace(/\s/g, '').toUpperCase()
        .replace(/Ｋ/g, 'K').replace(/Ｄ/g, 'D').replace(/Ｌ/g, 'L').replace(/Ｓ/g, 'S');
      if (u === 'LK') return 'LDK';
      if (u === 'SK') return 'K';
      if (u === 'SDK') return 'DK';
      if (u === 'SLK' || u === 'SLDK') return 'LDK';
      return u;
    };
    // 物件の間取りをパース（例: "2LDK" → rooms=2, type="LDK"）
    const propLayout = prop.layout.replace(/\s/g, '');
    const propMatch = propLayout.match(/^(\d+)\s*(.+)$/);
    let propRooms = 0;
    let propType = '';
    if (propMatch) {
      propRooms = parseInt(propMatch[1]);
      propType = normalizeType(propMatch[2]);
    } else if (propLayout.includes('ワンルーム') || propLayout.toUpperCase() === 'R') {
      propRooms = 1;
      propType = 'R';
    }

    if (propRooms > 0 && propType) {
      const propNormalized = propType === 'R' ? 'ワンルーム' : propRooms + propType;
      // 顧客の指定間取りリストと照合
      const allowed = customer.layouts.some(layout => {
        if (layout.includes('以上')) {
          // "4K以上" → 4部屋以上かつK/DK/LDK
          const aboveMatch = layout.replace(/以上/g, '').trim().match(/^(\d+)\s*(.+)$/);
          if (aboveMatch) {
            const minRooms = parseInt(aboveMatch[1]);
            const baseType = normalizeType(aboveMatch[2]);
            // 「4K以上」= 4部屋以上で、K/DK/LDKいずれか
            if (propRooms >= minRooms) {
              if (baseType === 'K') return ['K', 'DK', 'LDK'].includes(propType);
              if (baseType === 'DK') return ['DK', 'LDK'].includes(propType);
              return propType === baseType;
            }
          }
          return false;
        }
        // 通常の間取り（完全一致）
        const custMatch = layout.match(/^(\d+)\s*(.+)$/);
        if (custMatch) {
          const custRooms = parseInt(custMatch[1]);
          const custType = normalizeType(custMatch[2]);
          return propRooms === custRooms && propType === custType;
        }
        if (layout.includes('ワンルーム')) return propType === 'R';
        return false;
      });
      if (!allowed) {
        return `間取り不一致: ${prop.layout}（要求: ${customer.layouts.join(', ')}）`;
      }
    }
  }

  // 南向きフィルタ（バルコニー方向に「南」を含むか判定。情報なしは通過）
  const toHankaku = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const equip = toHankaku(customer.equipment || '').toLowerCase();
  if (equip.includes('南向き')) {
    if (prop.sunlight && !prop.sunlight.includes('南')) {
      return `南向きでない: バルコニー方向=${prop.sunlight}`;
    }
  }

  // 最上階フィルタ
  if (equip.includes('最上階')) {
    const floorNum = parseInt(toHankaku(prop.floor_text || '').match(/(\d+)/)?.[1] || '0');
    const storyNum = parseInt(toHankaku(prop.story_text || '').match(/(\d+)/)?.[1] || '0');
    if (floorNum > 0 && storyNum > 0 && floorNum < storyNum) {
      return `最上階でない: ${prop.floor_text}/${prop.story_text}`;
    }
  }

  // 階数フィルタ（2階以上、1階のみ）
  {
    const floorNum = parseInt(toHankaku(prop.floor_text || '').match(/(\d+)/)?.[1] || '0');
    if (equip.includes('2階以上') && floorNum > 0 && floorNum < 2) {
      return `2階以上条件: ${floorNum}階`;
    }
    if (equip.includes('1階') && !equip.includes('1階以上') && !equip.includes('2階以上') && floorNum > 0 && floorNum !== 1) {
      return `1階限定条件: ${floorNum}階`;
    }
  }

  // 角部屋 → アラート（buildDiscordMessageで処理）

  // ロフトNGフィルタ（ロフトがある場合は除外。情報なしは通過→アラートで対応）
  if (equip.includes('ロフトng') || equip.includes('ロフト不可')) {
    const fac = prop.facilities || '';
    if (fac && fac.includes('ロフト')) {
      return `ロフト付き物件（ロフトNG）`;
    }
  }

  // ガス種別フィルタ（都市ガス希望→プロパンならスキップ、逆も同様。情報なしは通過）
  {
    const fac = prop.facilities || '';
    if (equip.includes('都市ガス') && fac && !fac.includes('都市ガス') && fac.includes('プロパンガス')) {
      return `プロパンガス物件（都市ガス希望）`;
    }
    if ((equip.includes('プロパン') || equip.includes('lpガス')) && fac && !fac.includes('プロパンガス') && fac.includes('都市ガス')) {
      return `都市ガス物件（プロパンガス希望）`;
    }
  }

  // バス・トイレ別スキップモード（options画面で btMode='skip' 指定時のみ、equipにバス・トイレ別があって設備欄に無ければ除外）
  if (__btMode === 'skip' && (equip.includes('バストイレ別') || equip.includes('バス・トイレ別') || equip.includes('bt別'))) {
    const fac = prop.facilities || '';
    if (!fac.includes('バス・トイレ別') && !fac.includes('バストイレ別')) {
      return `バス・トイレ別の記載なし`;
    }
  }

  // ペット可フィルタ（REINS表記: ペット可/ペット相談。記載なし・設備なしは除外）
  if (equip.includes('ペット')) {
    const fac = prop.facilities || '';
    if (!fac.includes('ペット可') && !fac.includes('ペット相談')) {
      return `ペット可の記載なし`;
    }
  }

  // 事務所利用可フィルタ（REINS表記: 事務所使用可。記載なし・設備なしは除外）
  if (equip.includes('事務所')) {
    const fac = prop.facilities || '';
    if (!fac.includes('事務所使用可')) {
      return `事務所利用可の記載なし`;
    }
  }

  // フリーレントフィルタ（free_rentフィールドまたはfacilitiesにフリーレント記載がなければ除外）
  if (equip.includes('フリーレント')) {
    const fac = prop.facilities || '';
    const freeRent = prop.free_rent || '';
    const hasFreeRent = fac.includes('フリーレント') || (freeRent && freeRent !== 'なし' && freeRent !== '-');
    if (!hasFreeRent) {
      return `フリーレントなし`;
    }
  }

  // 定期借家を含まないフィルタ（設備に定期借家借地権、またはlease_typeに定期借家）
  if (equip.includes('定期借家を含まない') || equip.includes('定期借家除く')) {
    const fac = prop.facilities || '';
    if (fac.includes('定期借家') || (prop.lease_type && prop.lease_type.includes('定期借家'))) {
      return `定期借家物件`;
    }
  }

  return null; // 合格
}

// 築年月文字列から築年（西暦）を抽出
// "2015年03月" → 2015, "平成27年3月" → 2015, "令和2年" → 2020
function parseBuildingAge(str) {
  if (!str) return null;

  // 西暦パターン
  const westernMatch = str.match(/(\d{4})\s*年/);
  if (westernMatch) return parseInt(westernMatch[1]);

  // 和暦パターン
  const eraMatch = str.match(/(令和|平成|昭和)\s*(\d+)\s*年/);
  if (eraMatch) {
    const era = eraMatch[1];
    const year = parseInt(eraMatch[2]);
    if (era === '令和') return 2018 + year;
    if (era === '平成') return 1988 + year;
    if (era === '昭和') return 1925 + year;
  }

  return null;
}

// --- 初期化 ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['searchIntervalMinutes'], (data) => {
    setupAlarm(data.searchIntervalMinutes || 30);
  });
  chrome.storage.local.set({ isSearching: false });
  chrome.storage.local.get(['stats'], (data) => {
    if (!data.stats) {
      chrome.storage.local.set({
        stats: { totalFound: 0, totalSubmitted: 0, errors: [], lastError: null }
      });
    }
  });
});

chrome.storage.local.set({ isSearching: false });

// 検索サイクルID（中止判定用）
let currentSearchId = 0;

function isSearchCancelled(searchId) {
  return searchId !== currentSearchId;
}

// --- アラーム（営業時間 + ジッター対応） ---
// 次回実行時刻を計算（営業時間外なら翌営業開始時刻、内ならランダムジッター付き間隔）
function computeNextRunDelayMs(intervalMinutes, jitterPercent, startHour, endHour) {
  const now = new Date();
  const hour = now.getHours();
  // 営業時間外 → 次の営業開始時刻まで
  if (hour < startHour || hour >= endHour) {
    const next = new Date(now);
    if (hour >= endHour) next.setDate(next.getDate() + 1);
    next.setHours(startHour, 0, 0, 0);
    // 営業開始直後のスパイク回避のため 0〜10分のランダムオフセット
    return next.getTime() - now.getTime() + Math.floor(Math.random() * 10 * 60 * 1000);
  }
  // 営業時間内 → 間隔 ± ジッター%
  const base = Math.max(10, intervalMinutes) * 60 * 1000;
  const j = (jitterPercent || 0) / 100;
  const delta = base * j;
  const delay = base + (Math.random() * 2 - 1) * delta; // base ± delta
  // 次回実行が営業時間を超える場合は翌営業開始時刻に
  const nextTime = new Date(now.getTime() + delay);
  if (nextTime.getHours() >= endHour || nextTime.getDate() !== now.getDate()) {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    next.setHours(startHour, 0, 0, 0);
    return next.getTime() - now.getTime() + Math.floor(Math.random() * 10 * 60 * 1000);
  }
  return delay;
}

function setupAlarm(intervalMinutes) {
  chrome.storage.local.get(['jitterPercent', 'businessStartHour', 'businessEndHour'], (data) => {
    const jitter = data.jitterPercent !== undefined ? data.jitterPercent : 20;
    const startH = data.businessStartHour !== undefined ? data.businessStartHour : 10;
    const endH = data.businessEndHour !== undefined ? data.businessEndHour : 20;
    const delayMs = computeNextRunDelayMs(intervalMinutes, jitter, startH, endH);
    chrome.alarms.clear('reins-search', () => {
      chrome.alarms.create('reins-search', { when: Date.now() + delayMs });
      const mins = (delayMs / 60000).toFixed(1);
      console.log(`REINS検索アラーム設定: 次回 ${mins}分後 (営業${startH}-${endH}時, ジッター±${jitter}%)`);
    });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reins-search') {
    chrome.storage.local.get(['autoSearchEnabled', 'searchIntervalMinutes', 'businessStartHour', 'businessEndHour'], (data) => {
      const startH = data.businessStartHour !== undefined ? data.businessStartHour : 10;
      const endH = data.businessEndHour !== undefined ? data.businessEndHour : 20;
      const hour = new Date().getHours();
      const inBusiness = hour >= startH && hour < endH;

      if (data.autoSearchEnabled === false) {
        console.log('[system] 自動検索が無効のためスキップ');
      } else if (!inBusiness) {
        console.log(`[system] 営業時間外 (${hour}時) のためスキップ`);
      } else {
        runSearchCycle();
      }
      // 次回アラームを再セット（ジッター付き / 営業時間考慮）
      setupAlarm(data.searchIntervalMinutes || 60);
    });
  }
});

// --- メッセージ受信 ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SEARCH_NOW') {
    runSearchCycle();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'STOP_SEARCH') {
    currentSearchId++; // 古いサイクルを無効化
    chrome.storage.local.set({ isSearching: false });
    setStorageData({ debugLog: '検索を中止しました' });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'UPDATE_ALARM') {
    chrome.storage.local.get(['searchIntervalMinutes'], (data) => {
      setupAlarm(data.searchIntervalMinutes || 30);
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'LOGIN_STATUS') {
    chrome.storage.local.set({ loginDetected: msg.loggedIn });
    return;
  }
});

// --- 検索条件取得 ---
async function refreshCriteria() {
  try {
    const result = await fetchCriteria();
    if (result?.error) {
      await setStorageData({ debugLog: `GAS criteria error: ${result.error}` });
    }
    if (result && result.criteria) {
      // デバッグ: 全顧客のequipment値を出力
      const equipDebug = result.criteria.map(c => `${c.name}:[${c.equipment||''}]`).join(' | ');
      await setStorageData({ debugLog: `DEBUG equips: ${equipDebug}` });
      chrome.storage.local.set({
        customerCriteria: result.criteria,
        lastCriteriaFetch: Date.now()
      });
      console.log(`検索条件取得: ${result.criteria.length}件`);
    }
  } catch (err) {
    logError('検索条件取得失敗: ' + err.message);
    throw err;
  }
}

// _unresolvedStations にエントリを追加するヘルパー
function addUnresolvedStation(customerName, service, stationName) {
  if (!_unresolvedStations[customerName]) _unresolvedStations[customerName] = {};
  if (!_unresolvedStations[customerName][service]) _unresolvedStations[customerName][service] = [];
  const list = _unresolvedStations[customerName][service];
  if (!list.includes(stationName)) list.push(stationName);
}

// 未解決駅サマリーをログ出力 + GAS報告
async function reportUnresolvedStations() {
  // 実際に未解決駅があるエントリだけ抽出
  const entries = [];
  for (const [customer, services] of Object.entries(_unresolvedStations)) {
    const svcParts = [];
    for (const [svc, names] of Object.entries(services)) {
      if (names.length > 0) svcParts.push(`${svc}: ${names.join(', ')}`);
    }
    if (svcParts.length > 0) entries.push({ customer, detail: svcParts.join(' / '), services });
  }

  if (entries.length === 0) return; // 全駅解決済み → 何もしない

  // コンソール警告
  const summary = entries.map(e => `  ${e.customer}: ${e.detail}`).join('\n');
  console.warn(`[駅名解決失敗まとめ]\n${summary}`);

  // デバッグログにも表示
  await setStorageData({ debugLog: `⚠️ 駅名解決失敗: ${entries.map(e => e.detail).join(' | ')}` });

  // GASに報告（失敗してもサイクルは止めない）
  // Discord通知は各顧客スレッド内で送信済み（sendDiscordNotification内）
  try {
    await gasPost({
      action: 'log_unresolved_stations',
      data: _unresolvedStations,
    });
  } catch (err) {
    console.warn('[未解決駅] GAS報告失敗:', err.message);
  }
}

// --- メイン検索サイクル ---
async function runSearchCycle() {
  const { isSearching, gasWebappUrl, enabledServices } = await getStorageData(['isSearching', 'gasWebappUrl', 'enabledServices']);
  if (isSearching) { console.log('検索中のためスキップ'); return; }
  if (!gasWebappUrl) { console.log('GAS URL未設定のためスキップ'); return; }

  const services = enabledServices || { reins: true, ielove: true, itandi: true, essquare: true };

  if (!services.reins && !services.ielove && !services.itandi && !services.essquare) {
    console.log('有効なサービスがありません');
    return;
  }

  const searchId = ++currentSearchId;
  // 未解決駅の蓄積をリセット
  _unresolvedStations = {};
  // DiscordスレッドIDキャッシュをクリア
  Object.keys(discordThreadIds).forEach(k => delete discordThreadIds[k]);
  Object.keys(discordPropertyCounters).forEach(k => delete discordPropertyCounters[k]);
  // 一括通知バッファをクリア
  Object.keys(_batchBuffer).forEach(k => delete _batchBuffer[k]);
  const serviceNames = [services.reins && 'REINS', services.ielove && 'いえらぶ', services.itandi && 'itandi', services.essquare && 'ES-Square'].filter(Boolean).join('・');
  await setStorageData({ isSearching: true, debugLog: `━━━ 検索開始 (${serviceNames}) ━━━` });

  // ログタブを自動オープン（既に開いていればフォーカス）
  await openLogTab();

  // 検索全体を通してService Workerを生存させるグローバルkeepalive
  const globalKeepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);

  try {
    // 検索条件を取得（毎回GASから最新を取得）
    await setStorageData({ debugLog: '検索条件を取得中...' });
    try {
      await refreshCriteria();
    } catch (err) {
      await setStorageData({ debugLog: `検索条件取得失敗: ${err.message}` });
      return;
    }
    const { customerCriteria: criteria } = await getStorageData(['customerCriteria']);
    if (!criteria || criteria.length === 0) {
      await setStorageData({ debugLog: '検索条件がありません（GASに条件が登録されていない可能性）' });
      return;
    }
    await setStorageData({ debugLog: `検索条件 ${criteria.length}件取得完了` });

    let seenIds = {};
    await setStorageData({ debugLog: '既知物件IDを取得中...' });
    try {
      const seenResult = await fetchSeenIds();
      if (seenResult && seenResult.seen_ids) seenIds = seenResult.seen_ids;
      await setStorageData({ debugLog: `既知物件ID取得完了` });
    } catch (err) {
      await setStorageData({ debugLog: `既知物件ID取得失敗（続行）: ${err.message}` });
    }

    const { notifyMode } = await getStorageData(['notifyMode']);

    // === 顧客ループを外側、サービスを内側に（両モード共通） ===
    let reinsTab = null;
    let reinsDelay = 2000;
    if (services.reins) {
      reinsTab = await findReinsTab();
      if (!reinsTab) {
        await setStorageData({ loginDetected: false, debugLog: 'REINSタブが見つかりません（REINS検索スキップ）' });
      } else {
        await setStorageData({ debugLog: `REINSタブ発見: tabId=${reinsTab.id}`, reinsAutomationTabId: reinsTab.id });
        const { pageDelaySeconds } = await getStorageData(['pageDelaySeconds']);
        reinsDelay = (pageDelaySeconds || 2) * 1000;
      }
    }
    let reinsFatalExit = false;

    for (let ci = 0; ci < criteria.length; ci++) {
      if (isSearchCancelled(searchId)) return;
      const customer = criteria[ci];
      await setStorageData({ debugLog: `━━ 顧客 ${ci+1}/${criteria.length}: ${customer.name} ━━` });

      // --- REINS ---
      if (services.reins && reinsTab && !reinsFatalExit) {
        const cond = formatCustomerCriteria(customer);
        await setStorageData({ debugLog: `[REINS] ${customer.name} 条件: ${cond}` });
        try {
          const rws = customer.routes_with_stations || [];
          const cities = customer.cities || [];
          const _rwsChunks = rws.length > 0
            ? Array.from({length: Math.ceil(rws.length/3)}, (_,i) => rws.slice(i*3, i*3+3))
            : [[]];
          const _cityChunks = cities.length > 0
            ? Array.from({length: Math.ceil(cities.length/3)}, (_,i) => cities.slice(i*3, i*3+3))
            : [[]];
          const _totalBatches = _rwsChunks.length * _cityChunks.length;
          if (_totalBatches === 1 && rws.length <= 3 && cities.length <= 3) {
            // 単一バッチで完結
            await searchForCustomer(reinsTab.id, customer, seenIds, reinsDelay, searchId);
          } else {
            let _batchIdx = 0;
            for (const rwsChunk of _rwsChunks) {
              for (const cityChunk of _cityChunks) {
                if (isSearchCancelled(searchId)) return;
                _batchIdx++;
                const batchCustomer = {
                  ...customer,
                  routes: rwsChunk.map(r => r.route),
                  routes_with_stations: rwsChunk,
                  cities: cityChunk,
                };
                await setStorageData({ debugLog: `[REINS] ${customer.name}: バッチ ${_batchIdx}/${_totalBatches} (路線${rwsChunk.length}件/市区町村${cityChunk.length}件)` });
                await searchForCustomer(reinsTab.id, batchCustomer, seenIds, reinsDelay, searchId);
                if (_batchIdx < _totalBatches) await sleep(3000);
              }
            }
          }
        } catch (err) {
          if (err.message === 'SEARCH_CANCELLED') return;
          if (err.message === 'SLEEP_DETECTED' || err.message === 'REINS_ERROR_PAGE') {
            await setStorageData({ debugLog: `[REINS] ${err.message}→REINS中止（他サービスは継続）` });
            reinsFatalExit = true;
          } else {
            logError(`[REINS] ${customer.name}の検索失敗: ${err.message}`);
          }
        }
      }

      // --- いえらぶ ---
      if (services.ielove) {
        if (isSearchCancelled(searchId)) return;
        try { await runIeloveSearch([customer], seenIds, searchId); }
        catch (err) { if (err.message === 'SEARCH_CANCELLED') return; logError('[いえらぶ] 検索エラー: ' + err.message); }
      }

      // --- itandi ---
      if (services.itandi) {
        if (isSearchCancelled(searchId)) return;
        try { await runItandiSearch([customer], seenIds, searchId); }
        catch (err) { if (err.message === 'SEARCH_CANCELLED') return; logError('[itandi] 検索エラー: ' + err.message); }
      }

      // --- ES-Square ---
      if (services.essquare) {
        if (isSearchCancelled(searchId)) return;
        try { await runEssquareSearch([customer], seenIds, searchId); }
        catch (err) { if (err.message === 'SEARCH_CANCELLED') return; logError('[ES-Square] 検索エラー: ' + err.message); }
      }

      // --- 一括モード: この顧客分だけ重複排除＆通知 ---
      if (notifyMode === 'batch') {
        try { await flushBatchBufferForCustomer(customer.name); }
        catch (err) { logError(`[system] ${customer.name}: 一括通知エラー: ${err.message}`); }
      }

      if (ci < criteria.length - 1) await sleep(3000);
    }

    if (services.reins && reinsTab) {
      await closeDedicatedWindow();
      await setStorageData({ debugLog: '[REINS] 検索完了', reinsAutomationTabId: null });
    }

    // === 未解決駅サマリー ===
    await reportUnresolvedStations();

    await setStorageData({ lastSearchTime: Date.now() });
  } catch (err) {
    logError('検索サイクルエラー: ' + err.message);
  } finally {
    clearInterval(globalKeepAlive);
    // 中止時はタブを閉じない（テスト確認用にタブを残す）
    if (!isSearchCancelled(searchId)) {
      await closeDedicatedWindow();
      await closeDedicatedIeloveWindow();
      await closeDedicatedItandiWindow();
      await closeDedicatedEssquareWindow();
    }
    await setStorageData({ isSearching: false });
  }
}

// === 顧客ごとの検索 ===
async function searchForCustomer(tabId, customer, seenIds, delay, searchId) {
  // 中止チェック＋スリープ検知付きsleep
  const csleep = async (ms) => {
    const before = Date.now();
    await sleep(ms);
    const elapsed = Date.now() - before;
    // 要求時間の3倍以上かかった場合、PCスリープから復帰したと判断
    if (elapsed > Math.max(ms * 3, ms + 30000)) {
      await setStorageData({ debugLog: `${customer.name}: PCスリープ検知（${Math.round(elapsed/1000)}秒経過、要求${Math.round(ms/1000)}秒）→検索中断` });
      throw new Error('SLEEP_DETECTED');
    }
    if (isSearchCancelled(searchId)) throw new Error('SEARCH_CANCELLED');
  };

  await setStorageData({ debugLog: `検索開始: ${customer.name}` });
  const customerSeenIds = seenIds[customer.name] || [];

  // --- Step 1: 検索フォームの準備 ---
  // まずVueハイドレーション確保 + 検索フォームへルーティング
  // ※ refresh()はPromiseを返すがexecuteScriptでawaitするとハングするため、fire-and-forget
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const nuxt = window.$nuxt;
      if (!nuxt) return;
      if (nuxt.$route?.path !== '/main/BK/GBK001310') {
        nuxt.$router.push('/main/BK/GBK001310');
      }
      nuxt.refresh();
    }
  });
  await csleep(5000); // refresh + ルーティング完了待ち

  // .p-textbox-input でフォーム描画完了を待つ（最大30秒）
  let formFound = false;
  for (let w = 0; w < 15; w++) {
    if (isSearchCancelled(searchId)) return;
    try {
      const ready = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => !!document.querySelector('.p-textbox-input')
      });
      if (ready?.[0]?.result) { formFound = true; break; }
    } catch (_) {}
    await csleep(2000);
  }
  if (!formFound) {
    await setStorageData({ debugLog: `${customer.name}: 検索フォームが見つかりません` });
    return;
  }

  // --- Step 2: 条件セット（executeScript world:'MAIN'で直接実行） ---
  // ※ scriptタグ注入はCSPでブロックされるため、world:'MAIN'を使う
  const lineNameMap = await loadLineNameMap();
  const reinsCodeMap = await loadReinsCodeMap();
  const stationStr = buildStationString(customer);

  await setStorageData({ debugLog: `${customer.name}: stationStr="${stationStr}", rent_max=${customer.rent_max}` });

  // .p-textbox-input が描画されるまでリトライ（最大15秒）
  let setResult;
  for (let retry = 0; retry < 5; retry++) {
    const inputCheck = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!document.querySelector('.p-textbox-input')
    });
    if (inputCheck?.[0]?.result) break;
    await csleep(3000);
  }

  // SW再起動直後でもbtModeを確実に拾うためストレージから直読み
  const __btModeFresh = await new Promise(res => chrome.storage.local.get(['btMode'], d => res(d.btMode || 'alert')));
  __btMode = __btModeFresh;
  const __criteriaArgs = [stationStr, { rent_max: customer.rent_max, layouts: customer.layouts || [], area_min: customer.area_min || '', building_age: customer.building_age || '', equipment: customer.equipment || '', stations: customer.stations || [], routes_with_stations: customer.routes_with_stations || [], walk: customer.walk || '', cities: customer.cities || [], prefecture: customer.prefecture || '東京都' }, lineNameMap, reinsCodeMap, __btModeFresh];
  const __setCriteriaFunc = (stationStr, customerData, lineNameMap, reinsCodeMap, btMode) => {
      // Vueルート取得
      const fi = document.querySelector('.p-textbox-input');
      if (!fi) return { error: 'no_input' };
      let el = fi;
      while (el && !el.__vue__) el = el.parentElement;
      let p = el?.__vue__;
      let depth = 0;
      while (p && depth < 20) {
        if (Object.keys(p.$data || {}).length > 100) break;
        p = p.$parent; depth++;
      }
      if (!p || Object.keys(p.$data || {}).length < 100) return { error: 'no_vr', depth };
      const vr = p;

      // 条件クリア
      vr.snckKbn = false;
      for (let n = 1; n <= 3; n++) {
        vr[`ensnCd${n}`] = ''; vr[`ensnRykshu${n}`] = '';
        vr[`ekCdFrom${n}`] = ''; vr[`ekCdTo${n}`] = '';
        vr[`ekmiFrom${n}`] = ''; vr[`ekmiTo${n}`] = '';
        vr[`thNyurykc${n}`] = ''; vr[`thMHnKbn${n}`] = '';
        // 所在地スロット (都道府県名・市区町村名)
        vr[`tdufknmi${n}`] = '';
        vr[`shzicmi1${n}`] = '';
      }
      vr.kkkuCnryuFrom = ''; vr.kkkuCnryuTo = '';
      vr.bkknShbt1 = ''; vr.bkknShbt2 = '';
      vr.mdrTyp = []; vr.mdrHysuFrom = ''; vr.mdrHysuTo = '';
      vr.snyuMnskFrom = ''; vr.snyuMnskTo = '';
      vr.hnkuNngppFrom = ''; vr.hnkuNngppTo = '';

      // 物件種別: 賃貸マンション
      vr.bkknShbt1 = '03';

      // 沿線コードセット
      const reinsSearchStations = []; // デバッグ用: セットした駅名を記録
      const reinsUnresolved = []; // 未解決路線を記録
      if (stationStr) {
        const parts = stationStr.split('/').map(s => s.trim());
        let slotNum = 0; // 実際にセットした沿線スロット数
        for (let i = 0; i < parts.length && slotNum < 3; i++) {
          const colonIdx = parts[i].indexOf('\uff1a'); // ：(全角コロン)
          const lineName = colonIdx >= 0 ? parts[i].substring(0, colonIdx).trim() : parts[i].trim();

          // 全角英数→半角変換（ＪＲ→JR等）
          const toHankakuAlpha = (s) => s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

          let reinsLineName = lineNameMap[lineName];
          if (!reinsLineName) {
            // フォールバック: 全角→半角変換+スペース正規化して比較
            const normalized = toHankakuAlpha(lineName).replace(/\s/g, '');
            const fbKey = Object.keys(lineNameMap).find(k => {
              const kNorm = toHankakuAlpha(k).replace(/\s/g, '');
              if (kNorm === normalized) return true;
              if (k.endsWith(' ' + lineName)) return true;
              return false;
            });
            reinsLineName = fbKey ? lineNameMap[fbKey] : lineName;
          }
          if (reinsLineName === '\u691c\u7d22\u4e0d\u80fd') continue; // 検索不能

          // 丸ノ内線方南町支線の分岐対応: 支線駅がある場合は路線名を切り替え
          if (lineName === '東京メトロ丸ノ内線' && colonIdx >= 0) {
            const honanBranchStations = new Set(['中野新橋', '中野富士見町', '方南町']);
            const stns = parts[i].substring(colonIdx + 1).split(',').map(s => s.trim()).filter(s => s);
            if (stns.some(s => honanBranchStations.has(s))) {
              reinsLineName = '丸ノ内方南';
            }
          }

          // 常磐線の分岐対応: 各停駅（綾瀬〜北柏）はREINSでは常磐緩行線
          if (reinsLineName === '常磐線' && colonIdx >= 0) {
            const jobanLocalOnly = new Set(['綾瀬', '亀有', '金町', '北松戸', '馬橋', '新松戸', '北小金', '南柏', '北柏']);
            const stns = parts[i].substring(colonIdx + 1).split(',').map(s => s.trim()).filter(s => s);
            const allLocal = stns.every(s => jobanLocalOnly.has(s));
            const hasLocal = stns.some(s => jobanLocalOnly.has(s));
            if (allLocal) {
              // 全駅が各停のみ → 常磐緩行線
              reinsLineName = '常磐緩行線';
            } else if (hasLocal) {
              // 混在（各停駅 + 快速駅）→ 常磐線のまま、各停のみの駅は最寄りの快速停車駅に置換
              // 常磐緩行線は北千住始点なので、各停のみ駅 → 北千住に置換
              for (let si = 0; si < stns.length; si++) {
                if (jobanLocalOnly.has(stns[si])) stns[si] = '北千住';
              }
              parts[i] = lineName + '：' + stns.join(',');
            }
          }

          // 中央線の分岐対応: 各停区間駅（水道橋〜東中野）はREINSでは総武中央線
          if (reinsLineName === '中央線' && colonIdx >= 0) {
            const chuoLocalOnly = new Set(['水道橋', '飯田橋', '市ケ谷', '信濃町', '千駄ケ谷', '代々木', '大久保', '東中野']);
            const stns = parts[i].substring(colonIdx + 1).split(',').map(s => s.trim()).filter(s => s);
            const allLocal = stns.every(s => chuoLocalOnly.has(s));
            const hasLocal = stns.some(s => chuoLocalOnly.has(s));
            if (allLocal) {
              // 全駅が各停区間 → 総武中央線
              reinsLineName = '総武中央線';
            } else if (hasLocal) {
              // 混在（各停駅 + 快速駅）→ 中央線のまま、各停のみの駅は最寄りの快速停車駅に置換
              // 各停区間は御茶ノ水〜新宿間なので、各停のみ駅 → 御茶ノ水に置換
              for (let si = 0; si < stns.length; si++) {
                if (chuoLocalOnly.has(stns[si])) stns[si] = '御茶ノ水';
              }
              parts[i] = lineName + '：' + stns.join(',');
            }
          }

          // 西武池袋線: 東飯能以降はREINSに存在しないため、飯能をtoに制限
          if (reinsLineName === '西武池袋線' && colonIdx >= 0) {
            const beyondHanno = new Set(['東飯能', '高麗', '武蔵横手', '東吾野', '吾野', '西吾野', '正丸', '芦ヶ久保', '横瀬', '西武秩父']);
            const stns = parts[i].substring(colonIdx + 1).split(',').map(s => s.trim()).filter(s => s);
            // from/toの両方が範囲外の場合は飯能に置き換え
            for (let si = 0; si < stns.length; si++) {
              if (beyondHanno.has(stns[si])) stns[si] = '飯能';
            }
            // 置き換え後の駅リストを再構築（partsを直接書き換え）
            parts[i] = lineName + '：' + stns.join(',');
          }

          const ensnCd = reinsCodeMap[reinsLineName];
          if (!ensnCd) {
            console.warn(`[REINS] 沿線コード未定義: "${reinsLineName}" (元路線名: "${lineName}")`);
            // 駅名も含めて未解決として記録
            if (colonIdx >= 0) {
              const stns = parts[i].substring(colonIdx + 1).split(',').map(s => s.trim()).filter(s => s);
              stns.forEach(s => reinsUnresolved.push(s));
            } else {
              reinsUnresolved.push(`[路線: ${lineName}]`);
            }
            continue;
          }

          slotNum++;
          const num = slotNum;
          vr[`ensnCd${num}`] = ensnCd;
          vr[`ensnRykshu${num}`] = reinsLineName;

          // 駅名セット（駅指定がある場合、最初と最後の駅をFrom/Toにセット）
          if (colonIdx >= 0) {
            // REINS駅名マッピング: StationData.jsの駅名 → REINS表示名
            const reinsStationMap = {
              '羽田空港第３ターミナル': '羽田第３ターミナル',
              '羽田空港第3ターミナル': '羽田第３ターミナル',
              '羽田空港第１・第２ターミナル': '羽田第１・第２タ',
              '羽田空港第1・第2ターミナル': '羽田第１・第２タ',
              '羽田空港第１ターミナル': '羽田第１ターミナル',
              '羽田空港第1ターミナル': '羽田第１ターミナル',
              '羽田空港第２ターミナル': '羽田第２ターミナル',
              '羽田空港第2ターミナル': '羽田第２ターミナル',
              '南町田グランベリーパーク': '南町田グランベリーＰ',
              '東京国際クルーズターミナル': '東京国際クルーズＴ',
              'とうきょうスカイツリー': '東京スカイツリー',
              '新鎌ケ谷': '新鎌ヶ谷',
            };
            // 路線依存の駅名変換（同名駅が他路線にもある場合）
            const reinsLineStationMap = {
              '東京モノレール': { '浜松町': 'モノレール浜松町' },
              '都営新宿線': { '市ケ谷': '市ヶ谷' },
            };
            const toReinsStation = (name) => {
              const lineMap = reinsLineStationMap[lineName];
              if (lineMap && lineMap[name]) return lineMap[name];
              return reinsStationMap[name] || name;
            };

            const stationsInLine = parts[i].substring(colonIdx + 1).split(',').map(s => s.trim()).filter(s => s);
            if (stationsInLine.length > 0) {
              const fromStation = toReinsStation(stationsInLine[0]);
              const toStation = toReinsStation(stationsInLine[stationsInLine.length - 1]);
              vr[`ekmiFrom${num}`] = fromStation;
              vr[`ekmiTo${num}`] = toStation;
              reinsSearchStations.push({ line: reinsLineName, from: fromStation, to: toStation });
              console.log(`[REINS] 沿線${num} "${reinsLineName}" 駅名セット: From="${fromStation}", To="${toStation}"`);
            }
          }

          // 駅徒歩セット（全沿線に同じ値）
          if (customerData.walk) {
            const walkMin = String(customerData.walk).replace(/[^\d]/g, '');
            if (walkMin) {
              vr[`thNyurykc${num}`] = walkMin;
              vr[`thMHnKbn${num}`] = '1'; // 1=分
            }
          }
        }
      }

      // 所在地（市区町村）セット — 最大3スロット
      // 駅検索とは独立したスロット番号体系 (tdufknmi1〜3 / shzicmi11〜13)
      const reinsCitiesSet = [];
      if (customerData.cities && customerData.cities.length > 0) {
        const prefName = customerData.prefecture || '東京都';
        const citiesList = customerData.cities
          .map(c => (c || '').trim())
          .filter(c => c);
        for (let ci = 0; ci < citiesList.length && ci < 3; ci++) {
          const slot = ci + 1;
          vr[`tdufknmi${slot}`] = prefName;
          vr[`shzicmi1${slot}`] = citiesList[ci];
          reinsCitiesSet.push(`${slot}:${prefName}/${citiesList[ci]}`);
        }
        // 4件以上は呼び出し側で3件ずつバッチ分割される
      }

      // 賃料上限（万円）
      if (customerData.rent_max) {
        vr.kkkuCnryuTo = String(customerData.rent_max);
        // 下限は上限の70%（万円、小数1桁）
        const min70 = Math.floor(parseFloat(customerData.rent_max) * 0.7 * 10) / 10;
        if (min70 > 0) vr.kkkuCnryuFrom = String(min70);
      }

      // 間取りセット（layouts: ["1K", "1DK", "2LDK"] → mdrTyp + mdrHysuFrom/To）
      if (customerData.layouts && customerData.layouts.length > 0) {
        // 間取りタイプ → REINSコードのマッピング
        const typeMap = {
          'ワンルーム': '01', 'R': '01',
          'K': '02',
          'DK': '03',
          'LK': '04',
          'LDK': '05',
          'SK': '06',
          'SDK': '07',
          'SLK': '08',
          'SLDK': '09'
        };

        const types = new Set();
        let minRooms = Infinity;
        let maxRooms = 0;

        for (const layout of customerData.layouts) {
          // "1LDK" → rooms=1, type="LDK"
          // "ワンルーム" → rooms=1, type="ワンルーム"
          // "4K以上" → rooms=4, type="K", maxRoomsを10に
          const cleaned = layout.replace(/以上/g, '').trim();
          const isAbove = layout.includes('以上');
          const m = cleaned.match(/^(\d+)\s*(.+)$/);
          if (m) {
            const rooms = parseInt(m[1]);
            const typeName = m[2].replace(/\s/g, '').toUpperCase()
              .replace(/Ｋ/g, 'K').replace(/Ｄ/g, 'D').replace(/Ｌ/g, 'L').replace(/Ｓ/g, 'S');
            const code = typeMap[typeName];
            if (code) types.add(code);
            // 「以上」の場合、同系統の上位タイプも追加（K→DK,LDK等）
            if (isAbove) {
              if (typeName === 'K') { types.add('03'); types.add('05'); } // DK, LDK
              if (typeName === 'DK') { types.add('05'); } // LDK
            }
            if (rooms < minRooms) minRooms = rooms;
            if (isAbove) { maxRooms = 10; } else if (rooms > maxRooms) { maxRooms = rooms; }
          } else if (layout.includes('ワンルーム') || layout.toUpperCase() === 'R') {
            types.add('01');
            if (1 < minRooms) minRooms = 1;
            if (1 > maxRooms) maxRooms = 1;
          }
        }

        if (types.size > 0) {
          vr.mdrTyp = [...types];
        }
        if (minRooms !== Infinity && maxRooms > 0) {
          vr.mdrHysuFrom = String(minRooms);
          vr.mdrHysuTo = String(maxRooms);
        }
      }

      // 建物使用部分面積（㎡）
      if (customerData.area_min && String(customerData.area_min).trim() && !String(customerData.area_min).includes('指定しない')) {
        const n = parseFloat(String(customerData.area_min).replace(/[^\d.]/g, ''));
        if (!isNaN(n) && n > 0) vr.snyuMnskFrom = String(n);
      }

      // 築年月（築N年以内 or 新築 → From年をセット）
      // selectのiValueを変更してVueリアクティブに反映
      if (customerData.building_age) {
        const ageStr = String(customerData.building_age);
        const isNewBuild = ageStr.includes('新築');
        // 新築の場合は新築区分チェックをON（築年月の範囲検索は不要）
        if (isNewBuild) {
          vr.snckKbn = true;
        }
        const ageNum = isNewBuild ? 0 : parseInt(ageStr.replace(/[^\d]/g, ''));
        if (ageNum > 0) {
          const now = new Date();
          const fromDate = new Date(now.getFullYear() - ageNum, now.getMonth() + 1, 1);
          const fromYear = String(fromDate.getFullYear());
          const fromMonth = String(fromDate.getMonth() + 1).padStart(2, '0');
          // 築年月From年・月のselect要素を探してiValueをセット
          const chikuLabel = document.evaluate(
            "//span[contains(@class,'p-label-title') and contains(text(),'築年月')]",
            document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
          ).singleNodeValue;
          if (chikuLabel) {
            const container = chikuLabel.parentElement?.parentElement;
            if (container) {
              const selects = container.querySelectorAll('select');
              // selects[0]=年From, selects[1]=月From
              const setSelectValue = (sel, value) => {
                let selEl = sel;
                while (selEl) {
                  if (selEl.__vue__ && selEl.__vue__.$data && 'iValue' in selEl.__vue__.$data) {
                    selEl.__vue__.$data.iValue = value;
                    selEl.__vue__.$emit('input', value);
                    selEl.__vue__.$emit('change', value);
                    break;
                  }
                  selEl = selEl.parentElement;
                }
              };
              if (selects.length >= 1) setSelectValue(selects[0], fromYear);
              if (selects.length >= 2) setSelectValue(selects[1], fromMonth);
            }
          }
        }
      }

      // 所在階（equipment条件に基づく）
      // 全角数字→半角数字変換
      const toHankaku = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
      const equip = toHankaku(customerData.equipment || '').toLowerCase();
      if (equip.includes('2階以上')) {
        vr.shzikiFrom = '2';
      } else if (equip.includes('1階の物件') || equip.includes('1階')) {
        vr.shzikiFrom = '1';
        vr.shzikiTo = '1';
      }

      // バス・トイレ別スキップモード: 設備・条件・住宅性能等(optKnsk)欄に「バス・トイレ別」を追加してREINS側で絞り込む
      if (btMode === 'skip' && (equip.includes('バストイレ別') || equip.includes('バス・トイレ別') || equip.includes('bt別'))) {
        // REINS「こだわり条件選択」モーダルの「バス・トイレ別」= ID '030'
        // 検索実体は vr.selectedOptIds 配列。表示用 vr.optKnsk も合わせて更新
        const BT_ID = '030';
        if (!Array.isArray(vr.selectedOptIds)) vr.selectedOptIds = [];
        if (!vr.selectedOptIds.includes(BT_ID)) vr.selectedOptIds.push(BT_ID);
        const cur = (vr.optKnsk || '').trim();
        if (!cur.includes('バス・トイレ別') && !cur.includes('バストイレ別')) {
          vr.optKnsk = cur ? (cur + ' バス・トイレ別') : 'バス・トイレ別';
        }
      }

      // セットした全沿線情報をデバッグ用に収集
      const ensnDebug = [];
      for (let n = 1; n <= 3; n++) {
        if (vr[`ensnCd${n}`]) ensnDebug.push(`${n}:${vr[`ensnCd${n}`]}`);
      }

      return {
        success: true,
        bkknShbt1: vr.bkknShbt1,
        ensnCd1: vr.ensnCd1,
        ensnDebug: ensnDebug.join(' '),
        kkkuCnryuTo: vr.kkkuCnryuTo,
        mdrTyp: vr.mdrTyp,
        mdrHysuFrom: vr.mdrHysuFrom,
        mdrHysuTo: vr.mdrHysuTo,
        snyuMnskFrom: vr.snyuMnskFrom,
        shzikiFrom: vr.shzikiFrom || '',
        shzikiTo: vr.shzikiTo || '',
        buildingAge: customerData.building_age || '',
        debugEquip: customerData.equipment || '(empty)',
        reinsSearchStations: reinsSearchStations,
        reinsUnresolved: reinsUnresolved,
        reinsCitiesSet: reinsCitiesSet,
      };
    };
  setResult = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: __setCriteriaFunc,
    args: __criteriaArgs
  });

  const setStatus = setResult?.[0]?.result;
  if (!setStatus?.success) {
    await setStorageData({ debugLog: `${customer.name}: 条件セットエラー: ${JSON.stringify(setStatus)}` });
    return;
  }
  // REINS未解決駅を蓄積
  if (setStatus.reinsUnresolved && setStatus.reinsUnresolved.length > 0) {
    for (const name of setStatus.reinsUnresolved) {
      addUnresolvedStation(customer.name, 'REINS', name);
    }
  }
  await setStorageData({ debugLog: `${customer.name}: 条件セット完了 ensn=[${setStatus.ensnDebug || '-'}] cities=[${(setStatus.reinsCitiesSet||[]).join(' ') || '-'}] rent=${setStatus.kkkuCnryuTo} mdrTyp=[${setStatus.mdrTyp}] rooms=${setStatus.mdrHysuFrom}-${setStatus.mdrHysuTo} area=${setStatus.snyuMnskFrom || '-'}~ age=${setStatus.buildingAge || '-'} walk=${customer.walk || '-'} shziki=${setStatus.shzikiFrom || '-'}~${setStatus.shzikiTo || '-'} equip=${setStatus.debugEquip}` });

  // Vueリアクティブ更新を待つ
  await csleep(2000);

  // --- Step 3: 検索ボタンをDOMクリック（MAIN world） ---
  // Chromeのバックグラウンドタブスロットリング対策:
  // HTMLAudioElementで silent WAV をループ再生 → タブが「音声再生中」扱いになり throttle されない
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      if (window.__reinsKeepAlive) return;
      try {
        // 1秒の無音wav (44.1kHz, mono, 16bit)
        const sampleRate = 44100;
        const numSamples = sampleRate;
        const buffer = new ArrayBuffer(44 + numSamples * 2);
        const view = new DataView(buffer);
        const writeString = (offset, str) => { for (let i=0;i<str.length;i++) view.setUint8(offset+i, str.charCodeAt(i)); };
        writeString(0, 'RIFF');
        view.setUint32(4, 36 + numSamples*2, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate*2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, numSamples*2, true);
        // data は全て0（無音）
        const blob = new Blob([buffer], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.loop = true;
        audio.volume = 0.01;
        const playPromise = audio.play();
        if (playPromise) playPromise.catch(e => console.log('audio play failed:', e));
        window.__reinsKeepAlive = audio;
      } catch (e) { console.log('keepAlive err:', e); }
    }
  });
  await csleep(500);
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const btns = [...document.querySelectorAll('button')];
      const searchBtn = btns.find(b => b.textContent.trim() === '\u691c\u7d22'); // 検索
      if (searchBtn) searchBtn.click();
    }
  });
  await setStorageData({ debugLog: `${customer.name}: 検索ボタンクリック` });

  // --- Step 4: ダイアログ処理 + ページ遷移待ち ---
  // REINSはSPAのためURLではなくDOM内容で結果ページへの遷移を検出する
  for (let d = 0; d < 30; d++) {
    if (isSearchCancelled(searchId)) return;
    await csleep(3000);
    try {
      // DOM内容で結果ページ/ダイアログを検出
      const pageCheck = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // 結果ページのヘッダを検出
          const headings = document.querySelectorAll('h1, h2, h3, [class*="header"]');
          const bodyText = document.body.textContent;
          const isResultPage = bodyText.includes('検索結果一覧');

          // ダイアログ検出
          const dialogs = document.querySelectorAll('[role="dialog"], .modal.show');
          for (const dialog of dialogs) {
            const text = dialog.textContent;
            if (text.includes('入力に誤り') || text.includes('権限')) return { type: 'error' };
            if (text.includes('該当') && (text.includes('ありません') || text.includes('０件') || text.includes('0件'))) {
              const okBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
              if (okBtn) { okBtn.click(); return { type: 'no_results' }; }
            }
            if (text.includes('500件') || text.includes('超えています')) {
              const okBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
              if (okBtn) { okBtn.click(); return { type: 'ok_clicked' }; }
            }
          }

          if (isResultPage) return { type: 'result_page' };
          return { type: 'waiting' };
        }
      });

      const status = pageCheck?.[0]?.result;
      if (!status) continue;

      if (status.type === 'result_page') {
        await setStorageData({ debugLog: `${customer.name}: 結果ページに遷移` });
        break;
      }
      if (status.type === 'error') {
        const stationInfo = (setStatus.reinsSearchStations || []).map(s => `${s.line}: ${s.from}〜${s.to}`).join(', ');
        const msg = `${customer.name}: ⚠️ 検索エラー（バリデーション）駅名不一致の可能性あり [${stationInfo}]`;
        console.warn(`[REINS] ${msg}`);
        await setStorageData({ debugLog: msg });
        return;
      }
      if (status.type === 'no_results') {
        await setStorageData({ debugLog: `${customer.name}: 該当物件なし（0件）` });
        return;
      }
      if (status.type === 'ok_clicked') {
        await setStorageData({ debugLog: `${customer.name}: 500件超ダイアログOK` });
        // 結果ページ表示を待つ
        for (let w = 0; w < 20; w++) {
          await csleep(2000);
          const ready = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => document.body.textContent.includes('検索結果一覧')
          });
          if (ready?.[0]?.result) break;
        }
        break;
      }
      await setStorageData({ debugLog: `${customer.name}: ダイアログ${d+1}: ${status.type}` });
    } catch (err) {
      await setStorageData({ debugLog: `${customer.name}: ダイアログ${d+1}エラー: ${err.message}` });
    }
  }

  // --- Step 5: 検索結果のDOM描画待ち ---
  await setStorageData({ debugLog: `${customer.name}: 検索結果待ち...` });

  // DOM内容で結果ページか確認（URLはSPAのため信頼しない）
  const resultCheck = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.body.textContent.includes('検索結果一覧')
  });
  if (!resultCheck?.[0]?.result) {
    await setStorageData({ debugLog: `${customer.name}: 結果ページに遷移していません` });
    return;
  }

  // SPA遷移後のDOM描画を待つ（最大60秒）
  let resultsReady = false;
  for (let i = 0; i < 20; i++) {
    if (isSearchCancelled(searchId)) return;
    await csleep(3000);
    try {
      // ISOLATED worldでDOM確認（MAIN worldは不要）
      const check = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // 結果ページの特徴的な要素を探す
          const header = document.querySelector('h2, .p-header');
          const headerText = header?.textContent || '';
          const isResultPage = headerText.includes('検索結果') || document.body.textContent.includes('検索結果');
          const checkboxes = document.querySelectorAll('input[type="checkbox"]').length;
          const bodyLen = document.body.textContent.length;
          // 検索結果テーブルの行を探す（複数のセレクタを試す）
          const rows1 = document.querySelectorAll('.p-table-body-row').length;
          const rows2 = document.querySelectorAll('tr').length;
          const detailBtns = [...document.querySelectorAll('button')].filter(b => b.textContent.includes('詳細')).length;
          return { isResultPage, checkboxes, bodyLen, rows1, rows2, detailBtns, url: location.href };
        }
      });
      const r = check?.[0]?.result || {};
      await setStorageData({ debugLog: `${customer.name}: 結果${i+1}: result=${r.isResultPage} cb=${r.checkboxes} detail=${r.detailBtns} rows=${r.rows1}/${r.rows2}` });

      if (r.detailBtns > 0 || r.rows1 > 0) {
        resultsReady = true;
        break;
      }
      // 0件の場合もisResultPageがtrueなら完了
      if (r.isResultPage && r.bodyLen > 200 && r.checkboxes === 0) {
        await setStorageData({ debugLog: `${customer.name}: 検索結果0件` });
        return;
      }
    } catch (err) {
      await setStorageData({ debugLog: `${customer.name}: 結果${i+1}エラー: ${err.message}` });
    }
  }

  if (!resultsReady) {
    await setStorageData({ debugLog: `${customer.name}: 検索結果が表示されませんでした` });
    return;
  }

  await csleep(delay);
  await setStorageData({ debugLog: `${customer.name}: 検索結果ページ到達` });

  const { stats } = await getStorageData(['stats']);
  const currentStats = stats || { totalFound: 0, totalSubmitted: 0, errors: [], lastError: null };
  const newProperties = [];

  // --- Step 6〜7: ページネーションしながら検索結果を詳細取得（最大200件） ---
  const maxDetails = 200;
  let totalDetailCount = 0;
  let currentPage = 1;
  let consecutiveRecoveryFails = 0;
  let totalPages = 1;

  pageLoop: while (currentPage <= totalPages) {
    // 検索結果データ抽出（現在のページ）
    let searchResults = [];
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // ページ情報を取得
          const pageInfo = { totalPages: 1, currentPage: 1, totalItems: 0 };
          const pageLinks = document.querySelectorAll('.page-link');
          pageLinks.forEach(link => {
            const num = parseInt(link.textContent.trim(), 10);
            if (!isNaN(num)) {
              if (num > pageInfo.totalPages) pageInfo.totalPages = num;
              const li = link.closest('li');
              if (li && li.classList.contains('active')) pageInfo.currentPage = num;
            }
          });
          const pageText = document.body.textContent.match(/(\d+)～(\d+)件\s*／\s*(\d+)件/);
          if (pageText) {
            pageInfo.totalItems = parseInt(pageText[3], 10);
            // perPage は1ページ目の時のみ信頼可能（最終ページは表示件数が少ないため不正確）
            const from = parseInt(pageText[1], 10);
            const to = parseInt(pageText[2], 10);
            if (from === 1) {
              const perPage = to - from + 1;
              if (perPage > 0) {
                const calc = Math.ceil(pageInfo.totalItems / perPage);
                // page-link側の値と食い違う場合は小さい方を採用
                pageInfo.totalPages = Math.min(
                  pageInfo.totalPages > 1 ? pageInfo.totalPages : calc,
                  calc
                );
              }
            }
          }

          // 各行から物件情報を抽出
          const rows = document.querySelectorAll('.p-table-body-row');
          const data = [];
          rows.forEach((row, index) => {
            const items = row.querySelectorAll(':scope > .p-table-body-item');
            if (items.length < 23) return;
            const propertyNumber = (items[3]?.textContent.trim() || '').match(/\b(100\d{8,})\b/)?.[1] || '';
            data.push({
              index,
              propertyNumber,
              buildingName: items[11]?.textContent.trim() || '',      // 物件名
              floor: items[12]?.textContent.trim() || '',             // 階数
              rentText: items[8]?.textContent.trim() || '',           // 賃料（row2 col5）
              managementFeeText: items[15]?.textContent.trim() || '', // 管理費（row3 col5）
              commonFeeText: items[21]?.textContent.trim() || '',     // 共益費（row4 col5）
              depositGuarantee: items[16]?.textContent.trim() || '',  // 敷金／保証金
              keyMoneyRights: items[22]?.textContent.trim() || '',    // 礼金／権利金
              text: row.textContent.substring(0, 200)
            });
          });
          return { data, pageInfo };
        }
      });
      const extracted = results && results[0] && results[0].result;
      if (extracted) {
        searchResults = extracted.data || [];
        totalPages = extracted.pageInfo.totalPages;
        currentPage = extracted.pageInfo.currentPage;
      }
    } catch (err) {
      await setStorageData({ debugLog: `${customer.name}: 検索結果抽出失敗(p${currentPage}): ${err.message}` });
      break;
    }

    if (searchResults.length === 0) {
      if (currentPage === 1) {
        await setStorageData({ debugLog: `${customer.name}: 検索結果0件` });
      }
      break;
    }
    await setStorageData({ debugLog: `${customer.name}: ページ${currentPage}/${totalPages} ${searchResults.length}件の検索結果` });

    // 現在のページの全物件について詳細取得
    for (let i = 0; i < searchResults.length; i++) {
    if (totalDetailCount >= maxDetails) {
      await setStorageData({ debugLog: `${customer.name}: 詳細取得上限${maxDetails}件に到達` });
      break pageLoop;
    }
    const result = searchResults[i];
    if (!result.propertyNumber) continue;
    const isTest = customer.name.includes('テスト');
    // room_idはハッシュ化済みなのでpropertyNumber単位で完全一致チェック
    const reinsRoomHash = await hashRoomId('reins', 'reins_' + result.propertyNumber);
    if (!isTest && (
      customerSeenIds.includes(reinsRoomHash) ||
      customerSeenIds.some(id => id.includes(result.propertyNumber)) // 旧形式（生ID）互換
    )) {
      continue; // 既知物件はログなし（大量になるため）
    }

    // 一覧ページで敷金/礼金フィルタ（equipment条件に基づく）
    const toHankaku_ = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    const equip = toHankaku_(customer.equipment || '').toLowerCase();
    const isNone = (s) => !s || s === '-' || s === 'なし' || s === 'なし/-' || s === '-/-' || s === 'なし/なし';
    const hasNoneInSlash = (s) => {
      const parts = (s || '').split('/').map(p => p.trim());
      return parts.every(p => !p || p === '-' || p === 'なし');
    };
    if (equip.includes('敷金なし')) {
      if (!hasNoneInSlash(result.depositGuarantee)) {
        await setStorageData({ debugLog: `${customer.name}: ✗ 一覧スキップ: ${result.buildingName} ${result.floor} - 敷金あり(${result.depositGuarantee})` });
        continue;
      }
    }
    if (equip.includes('礼金なし')) {
      const reikinPart = (result.keyMoneyRights || '').split('/')[0].trim();
      if (reikinPart && reikinPart !== '-' && reikinPart !== 'なし') {
        await setStorageData({ debugLog: `${customer.name}: ✗ 一覧スキップ: ${result.buildingName} ${result.floor} - 礼金あり(${result.keyMoneyRights})` });
        continue;
      }
    }

    // 一覧ページで賃料+管理費+共益費フィルタ（詳細を開く前にスキップ→高速化）
    if (customer.rent_max && result.rentText) {
      const parseYen_ = (s) => {
        if (!s) return 0;
        const n = s.replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
                   .replace(/,/g, '');
        const m = n.match(/([\d.]+)/);
        if (!m) return 0;
        const v = parseFloat(m[1]);
        if (isNaN(v)) return 0;
        return n.includes('万') ? Math.round(v * 10000) : Math.round(v);
      };
      const rentYen_ = parseYen_(result.rentText);
      const mgmtYen_ = parseYen_(result.managementFeeText);
      const commonYen_ = parseYen_(result.commonFeeText);
      if (rentYen_ > 0) {
        const rentMaxYen_ = parseFloat(customer.rent_max) * 10000;
        const totalYen_ = rentYen_ + mgmtYen_ + commonYen_;
        if (totalYen_ > rentMaxYen_) {
          await setStorageData({ debugLog: `${customer.name}: ✗ 一覧スキップ: ${result.buildingName} ${result.floor} - 賃料+管理+共益超過 ${totalYen_}円(${result.rentText}+${result.managementFeeText||'0'}+${result.commonFeeText||'0'}) > ${rentMaxYen_}円` });
          continue;
        }
      }
    }

    totalDetailCount++;
    await setStorageData({ debugLog: `${customer.name}: p${currentPage}/${totalPages} 物件${totalDetailCount}/${maxDetails} 詳細取得中 (${result.buildingName} ${result.floor})` });

    try {
      // 詳細ボタンをクリック（物件番号で行を特定）— 行が描画されるまで最大15秒待つ
      // ダイアログ（連続閲覧警告等）が出ていればOKで閉じる
      let clickStatus = 'not_found';
      let triedRecovery = false;
      for (let waitTry = 0; waitTry < 12; waitTry++) {
        const cr = await chrome.scripting.executeScript({
          target: { tabId },
          func: (propNum, rowIndex) => {
            const dialogs = document.querySelectorAll('[role="dialog"], .modal.show');
            for (const dialog of dialogs) {
              const okBtn = [...dialog.querySelectorAll('button')].find(b => /OK|閉じる|はい/.test(b.textContent.trim()));
              if (okBtn) { okBtn.click(); return 'dialog_closed'; }
            }
            const rows = document.querySelectorAll('.p-table-body-row');
            if (rows.length === 0) return 'no_rows';
            // index で直接特定（同じ建物の連続物件でも確実）
            const row = rows[rowIndex];
            if (row && row.textContent.includes(propNum)) {
              const detailBtn = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '詳細');
              if (detailBtn) { detailBtn.click(); return 'clicked'; }
            }
            // index がズレた場合は物件番号で「最初に一致した未訪問行」をフォールバック検索
            // ただし末尾完全一致のみ許可（部分文字列誤マッチ防止）
            for (const r of rows) {
              const items = r.querySelectorAll(':scope > .p-table-body-item');
              const cellText = (items[3]?.textContent || '').trim();
              const m = cellText.match(/\b(100\d{8,})\b/);
              if (m && m[1] === propNum) {
                const detailBtn = [...r.querySelectorAll('button')].find(b => b.textContent.trim() === '詳細');
                if (detailBtn) { detailBtn.click(); return 'clicked_fallback'; }
              }
            }
            return 'not_found_in_' + rows.length + '_rows';
          },
          args: [result.propertyNumber, result.index]
        });
        clickStatus = cr?.[0]?.result || 'error';
        if (clickStatus === 'clicked') break;
        if (clickStatus === 'dialog_closed') { await csleep(1500); continue; }
        // no_rows の最初の検出で詳細な状態をダンプ
        if (clickStatus === 'no_rows' && waitTry === 0) {
          try {
            const diag = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => {
                const url = location.href;
                const title = document.title;
                const h = [...document.querySelectorAll('h1,h2,h3,[class*="header"]')].slice(0,5).map(e=>e.textContent.trim().slice(0,40)).filter(Boolean);
                const dialogs = [...document.querySelectorAll('[role="dialog"],.modal,.modal.show,.toast')].map(d=>d.textContent.trim().slice(0,80)).filter(Boolean);
                const selectors = {
                  'p-table-body-row': document.querySelectorAll('.p-table-body-row').length,
                  'body-row*': document.querySelectorAll('[class*="body-row"]').length,
                  'tbody tr': document.querySelectorAll('tbody tr').length,
                  '詳細btn': [...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='詳細').length,
                  'page-link': document.querySelectorAll('.page-link').length,
                  'spinner': document.querySelectorAll('[class*="spinner"],[class*="loading"]').length,
                };
                const bodyLen = document.body.textContent.length;
                const hasResultText = document.body.textContent.includes('検索結果一覧');
                const has0kenText = /該当.*0|０件|該当なし/.test(document.body.textContent);
                return { url, title, h, dialogs, selectors, bodyLen, hasResultText, has0kenText };
              }
            });
            const d = diag?.[0]?.result || {};
            await setStorageData({ debugLog: `${customer.name}: 🔍診断 url=${(d.url||'').slice(-50)} title=${(d.title||'').slice(0,30)} h=${JSON.stringify(d.h||[])} dialogs=${JSON.stringify(d.dialogs||[])} sel=${JSON.stringify(d.selectors||{})} bodyLen=${d.bodyLen} 結果一覧text=${d.hasResultText} 0件text=${d.has0kenText}` });
          } catch(e) {
            await setStorageData({ debugLog: `${customer.name}: 🔍診断失敗 ${e.message}` });
          }
        }
        // no_rowsが続く場合、検索フォームから再検索して復帰
        if (clickStatus === 'no_rows' && waitTry >= 2 && !triedRecovery) {
          triedRecovery = true;
          await setStorageData({ debugLog: `${customer.name}: 結果一覧が空→検索条件を再投入して復帰` });
          // 1) 検索フォームへ
          await chrome.scripting.executeScript({
            target: { tabId }, world: 'MAIN',
            func: () => {
              const nuxt = window.$nuxt;
              if (nuxt?.$router) { nuxt.$router.push('/main/BK/GBK001310'); return; }
              location.href = 'https://system.reins.jp/main/BK/GBK001310';
            }
          });
          // 2) 入力欄が描画されるまで待つ
          for (let w = 0; w < 15; w++) {
            await csleep(2000);
            const ok = await chrome.scripting.executeScript({ target: { tabId }, func: () => !!document.querySelector('.p-textbox-input') });
            if (ok?.[0]?.result) break;
          }
          // 3) 同じ条件設定関数を再実行
          await chrome.scripting.executeScript({
            target: { tabId }, world: 'MAIN',
            func: __setCriteriaFunc, args: __criteriaArgs
          });
          await csleep(2000);
          // 4) 検索ボタンクリック
          await chrome.scripting.executeScript({
            target: { tabId }, world: 'MAIN',
            func: () => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '検索'); if (b) b.click(); }
          });
          // 5) ダイアログ処理＆結果ページ待ち
          for (let rs = 0; rs < 25; rs++) {
            await csleep(2000);
            const rsCheck = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => {
                const dialogs = document.querySelectorAll('[role="dialog"], .modal.show');
                for (const d of dialogs) {
                  if (d.textContent.includes('500件') || d.textContent.includes('超えて')) {
                    const ok = [...d.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
                    if (ok) { ok.click(); return 'ok'; }
                  }
                }
                if (document.querySelectorAll('.p-table-body-row, [class*="body-row"]').length > 0) return 'rows';
                return 'wait';
              }
            });
            const s = rsCheck?.[0]?.result;
            if (s === 'rows') break;
            if (s === 'ok') await csleep(2500);
          }
          // 6) 現在ページまで進める
          if (currentPage > 1) {
            for (let np = 2; np <= currentPage; np++) {
              await chrome.scripting.executeScript({
                target: { tabId },
                func: (page) => {
                  const links = document.querySelectorAll('.page-link');
                  for (const l of links) if (l.textContent.trim() === String(page)) { l.click(); return; }
                },
                args: [np]
              });
              await csleep(3000);
            }
          }
          // 結果ページ＆ダイアログ処理
          for (let rs = 0; rs < 20; rs++) {
            await csleep(2000);
            const rsCheck = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => {
                const dialogs = document.querySelectorAll('[role="dialog"], .modal.show');
                for (const dialog of dialogs) {
                  if (dialog.textContent.includes('500件') || dialog.textContent.includes('超えて')) {
                    const okBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
                    if (okBtn) { okBtn.click(); return 'ok'; }
                  }
                }
                if (document.querySelectorAll('.p-table-body-row, [class*="body-row"]').length > 0) return 'rows';
                return 'wait';
              }
            });
            const s = rsCheck?.[0]?.result;
            if (s === 'rows') break;
            if (s === 'ok') await csleep(2500);
          }
          // 現在ページまで進める
          if (currentPage > 1) {
            for (let np = 2; np <= currentPage; np++) {
              await chrome.scripting.executeScript({
                target: { tabId },
                func: (page) => {
                  const links = document.querySelectorAll('.page-link');
                  for (const l of links) if (l.textContent.trim() === String(page)) { l.click(); return; }
                },
                args: [np]
              });
              await csleep(3000);
            }
          }
          continue;
        }
        await csleep(2000);
      }
      if (clickStatus !== 'clicked') {
        await setStorageData({ debugLog: `${customer.name}: ✗ ${result.buildingName} ${result.floor} 詳細ボタンが見つからない(${clickStatus})→スキップ` });
        continue;
      }
      await waitForTabLoad(tabId);
      await csleep(delay);

      // REINSエラーページ検知（E2171「不適切な画面操作」等）
      const tabInfo = await chrome.tabs.get(tabId);
      if (tabInfo.url && !tabInfo.url.includes('GBK00')) {
        // REINS内だがエラーページの可能性
        const [errCheck] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.body?.innerText?.includes('不適切な画面操作') || document.body?.innerText?.includes('エラー番号')
        });
        if (errCheck?.result) {
          await setStorageData({ debugLog: `${customer.name}: REINSエラーページ検知→検索中断` });
          throw new Error('REINS_ERROR_PAGE');
        }
      }

      // 詳細ページのVueコンポーネントがマウントされるまで待つ（最大15秒）
      for (let w = 0; w < 30; w++) {
        const ready = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.querySelectorAll('.p-label-title').length > 10
        });
        if (ready?.[0]?.result) break;
        await csleep(500);
      }

      // 詳細データ抽出
      const detailResults = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const getVal = (label) => {
            const el = [...document.querySelectorAll('.p-label-title')].find(e => e.textContent.trim() === label);
            if (!el) return '';
            const container = el.closest('.p-label')?.parentElement;
            if (!container) return '';
            if (label === '部屋番号') return container.querySelector('.col-sm-4')?.textContent.trim() || '';
            return container.querySelector('.row .col')?.textContent.trim() || '';
          };

          const propertyNumber = getVal('物件番号');
          if (!propertyNumber) return null;

          const pref = getVal('都道府県名');
          const addr1 = getVal('所在地名１');
          const addr2 = getVal('所在地名２');
          const addr3 = getVal('所在地名３');
          const building = getVal('建物名');
          const roomNumber = getVal('部屋番号');
          // 部屋番号行の2つ目のcol-sm-4（角部屋等の属性テキスト）
          const roomAttr = (() => {
            const el = [...document.querySelectorAll('.p-label-title')].find(e => e.textContent.trim() === '部屋番号');
            const cols = el?.closest('.p-label')?.parentElement?.querySelectorAll('.col-sm-4');
            return cols && cols.length > 1 ? cols[1].textContent.trim() : '';
          })();
          const rentRaw = getVal('賃料');
          const parseFee = (s) => s ? parseFloat(s.replace(/[^\d.]/g, '')) || 0 : 0;
          const mgmtFeeVal = parseFee(getVal('管理費'));
          const kyoekiFeeVal = parseFee(getVal('共益費'));
          const totalMgmtFee = mgmtFeeVal + kyoekiFeeVal;
          const area = getVal('使用部分面積');
          const floorLoc = getVal('所在階');
          const floorAbove = getVal('地上階層');
          const structure = getVal('建物構造');
          const builtDate = getVal('築年月');

          return {
            building_id: 'reins_' + propertyNumber,
            room_id: 'reins_' + propertyNumber + '_' + (roomNumber || 'no_room'),
            building_name: building || '',
            address: [pref, addr1, addr2, addr3].filter(Boolean).join(''),
            rent: rentRaw ? parseFloat(rentRaw.replace(/[^\d.]/g, '')) * (rentRaw.includes('万') ? 10000 : 1) : 0,
            management_fee: totalMgmtFee,
            layout: (() => {
              const t = (getVal('間取タイプ') || '').trim();
              const r = (getVal('間取部屋数') || '').replace(/[^\d]/g, '');
              if (t === 'ワンルーム' || t === '1R') return 'ワンルーム';
              if (r && t) return `${r}${t}`;
              return t;
            })(),
            area: parseFloat((area || '').replace(/[^\d.]/g, '')) || 0,
            floor: parseInt((floorLoc || '').match(/\d+/)?.[0] || '0'),
            floor_text: floorLoc || '',
            story_text: (() => {
              const fb = (getVal('地下階層') || '').replace(/[^\d]/g, '');
              const fa = (floorAbove || '').replace(/[^\d]/g, '');
              let s = '';
              if (fa) s += '地上' + fa + '階';
              if (fb && fb !== '0') s += '地下' + fb + '階';
              return s ? s + '建' : '';
            })(),
            structure: (() => {
              if (!structure) return '';
              // REINS詳細ページの構造値を正規化（全角→半角、日本語名→標準名）
              const hankaku = structure.replace(/[Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
              // まずコード→日本語名（英字コードの場合）
              const codeMap = {
                'RC': '鉄筋コンクリート', 'SRC': '鉄骨鉄筋コンクリート',
                'S': '鉄骨造', 'W': '木造', 'LS': '軽量鉄骨造',
                'ALC': 'ALC造', 'PC': 'プレキャストコンクリート',
                'HPC': '鉄骨プレキャストコンクリート', 'CB': 'コンクリートブロック'
              };
              const alphaKey = hankaku.replace(/[造\s]/g, '').toUpperCase();
              if (codeMap[alphaKey]) return codeMap[alphaKey];
              // 日本語名の場合もマッピング（REINSドロップダウン: 鉄骨造, 木造, 軽量鉄骨, ブロック 等）
              const jpMap = {
                '鉄骨造': '鉄骨造', '鉄骨': '鉄骨造',
                '木造': '木造', '木': '木造',
                '軽量鉄骨造': '軽量鉄骨造', '軽量鉄骨': '軽量鉄骨造',
                'ブロック': 'コンクリートブロック',
                'その他': 'その他'
              };
              return jpMap[hankaku] || jpMap[hankaku.replace(/造/g, '')] || structure;
            })(),
            building_age: (() => {
              if (!builtDate) return '';
              // 西暦を抽出
              let builtYear = null;
              const wm = builtDate.match(/(\d{4})\s*年/);
              if (wm) builtYear = parseInt(wm[1]);
              else {
                const em = builtDate.match(/(令和|平成|昭和)\s*(\d+)\s*年/);
                if (em) {
                  const y = parseInt(em[2]);
                  if (em[1] === '令和') builtYear = 2018 + y;
                  else if (em[1] === '平成') builtYear = 1988 + y;
                  else if (em[1] === '昭和') builtYear = 1925 + y;
                }
              }
              if (!builtYear) return builtDate;
              const age = new Date().getFullYear() - builtYear;
              return `築${age}年`;
            })(),
            station_info: (() => {
              // 全交通情報を取得（交通1〜3）
              const transports = [];
              const labels = ['沿線名', '駅名', '駅より徒歩'];
              // ラベルが複数ある場合（交通1, 交通2, 交通3...）を探す
              const allLabels = [...document.querySelectorAll('.p-label-title')];
              const lineLabels = allLabels.filter(e => e.textContent.trim() === '沿線名');
              const stationLabels = allLabels.filter(e => e.textContent.trim() === '駅名');
              const walkLabels = allLabels.filter(e => e.textContent.trim() === '駅より徒歩');
              const getValFromLabel = (el) => {
                if (!el) return '';
                const container = el.closest('.p-label')?.parentElement;
                if (!container) return '';
                return container.querySelector('.row .col')?.textContent.trim() || '';
              };
              const count = Math.max(lineLabels.length, stationLabels.length);
              for (let t = 0; t < count; t++) {
                const line = getValFromLabel(lineLabels[t]);
                const station = getValFromLabel(stationLabels[t]);
                const walk = getValFromLabel(walkLabels[t]);
                if (line || station) {
                  let info = [line, station].filter(Boolean).join(' ');
                  if (walk) info += ' 徒歩' + walk;
                  transports.push(info);
                }
              }
              return transports.join(' / ') || ([getVal('沿線名'), getVal('駅名')].filter(Boolean).join(' ') + (getVal('駅から徒歩') ? ' 徒歩' + getVal('駅から徒歩') : ''));
            })(),
            room_number: roomNumber || '',
            room_attr: roomAttr || '',
            deposit: getVal('敷金') || '',
            key_money: getVal('礼金') || '',
            facilities: getVal('設備・条件・住宅性能等') || '',
            sunlight: getVal('バルコニー方向') || '',
            lease_type: getVal('建物賃貸借区分') || '',
            contract_period: getVal('契約期間') || '',
            move_in_date: (() => {
              // 「入居年月」は col-4 と col-8 に分かれている（例: "令和 8年 4月" + "中旬"）
              const allLabels = [...document.querySelectorAll('.p-label-title')];
              const nengetsuLabel = allLabels.find(e => e.textContent.trim() === '入居年月');
              if (nengetsuLabel) {
                const container = nengetsuLabel.closest('.p-label')?.parentElement;
                if (container) {
                  const row = container.querySelector('.row');
                  if (row) {
                    const cols = [...row.querySelectorAll('[class*="col"]')];
                    const fullText = cols.map(c => c.textContent.trim()).filter(Boolean).join(' ');
                    if (fullText) {
                      // 和暦→西暦変換
                      const wm = fullText.match(/(?:令和|平成|昭和)\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(上旬|中旬|下旬)?/);
                      if (wm) {
                        const eraYear = parseInt(wm[1]);
                        let seireki;
                        if (fullText.includes('令和')) seireki = 2018 + eraYear;
                        else if (fullText.includes('平成')) seireki = 1988 + eraYear;
                        else if (fullText.includes('昭和')) seireki = 1925 + eraYear;
                        if (seireki) return `${seireki}年${parseInt(wm[2])}月${wm[3] || ''}`;
                      }
                      return fullText;
                    }
                  }
                }
              }
              // フォールバック: 入居時期（「即時」「相談」等）
              const jikiVal = getVal('入居時期');
              if (jikiVal && jikiVal !== '予定') {
                if (jikiVal === '即時' || jikiVal === '即入居') return '即入居可';
                return jikiVal;
              }
              return getVal('入居可能時期') || getVal('引渡可能時期') || '';
            })(),
            total_units: getVal('[賃貸]棟総戸数') || getVal('総戸数') || '',
            shinchiku_flag: getVal('新築フラグ') || '',
            reins_property_number: propertyNumber,
            reins_shougo: getVal('商号') || '',
            reins_tel: getVal('電話番号') || '',
            // === 第1弾追加フィールド ===
            // 単価
            sqm_price: getVal('㎡単価') || '',
            tsubo_price: getVal('坪単価') || '',
            // 賃貸借契約詳細
            lease_period: getVal('建物賃貸借期間') || '',
            lease_renewal: getVal('建物賃貸借更新') || '',
            // 保証金・権利金・償却
            guarantee_money: getVal('保証金') || '',
            key_premium: getVal('権利金') || '',
            shoukyaku_code: getVal('償却コード') || '',
            shoukyaku_months: getVal('償却月数') || '',
            shoukyaku_rate: getVal('償却率') || '',
            // 更新
            renewal_type: getVal('更新区分') || '',
            renewal_fee: getVal('更新料') || '',
            // その他一時金・月額費
            other_onetime_fee: (() => {
              const parts = [];
              const n1 = getVal('その他一時金名称１'); const a1 = getVal('金額１');
              const n2 = getVal('その他一時金名称２'); const a2 = getVal('金額２');
              if (n1 && a1) parts.push(n1 + ': ' + a1);
              if (n2 && a2) parts.push(n2 + ': ' + a2);
              return parts.join(', ');
            })(),
            other_monthly_fee: (() => {
              const n = getVal('その他月額費名称'); const a = getVal('その他月額費金額');
              return (n && a) ? (n + ': ' + a) : '';
            })(),
            // 鍵交換
            key_exchange_type: getVal('鍵交換区分') || '',
            key_exchange_fee: getVal('鍵交換代金') || '',
            // 報酬
            commission_type: getVal('報酬形態') || '',
            commission: getVal('報酬') || '',
            ad_fee: (() => {
              // 「報酬」ラベル完全一致を最優先、ダメなら 報酬額/報酬(税抜) 等を探す
              let v = getVal('報酬');
              if (v) return v;
              const labels = [...document.querySelectorAll('.p-label-title')];
              const target = labels.find(e => {
                const t = e.textContent.trim();
                return /^報酬/.test(t) && !/形態|割合/.test(t);
              });
              if (!target) return '';
              const container = target.closest('.p-label')?.parentElement;
              if (!container) return '';
              // 直近の .row .col を取得（col-sm-6 配下の最初の .row > .col）
              const col = container.querySelector(':scope > .row .col, .row .col');
              return col?.textContent.trim() || '';
            })(),
            commission_landlord: getVal('負担割合貸主') || '',
            commission_tenant: getVal('負担割合借主') || '',
            commission_motozuke: getVal('配分割合元付') || '',
            commission_kyakuzuke: getVal('配分割合客付') || '',
            // 現況
            current_status: getVal('現況') || '',
            // バルコニー面積
            balcony_area: getVal('バルコニー(テラス)面積') || '',
            // 室1〜5
            rooms_detail: (() => {
              const rooms = [];
              for (let i = 1; i <= 5; i++) {
                const fl = getVal(`室${i}:所在階`);
                const tp = getVal(`室${i}:室タイプ`);
                const sz = getVal(`室${i}:室広さ`);
                if (fl || tp || sz) rooms.push([fl, tp, sz].filter(Boolean).join(' '));
              }
              return rooms.join(' / ');
            })(),
            // 駐車場
            parking_available: getVal('駐車場在否') || '',
            parking_fee: getVal('駐車場月額') || '',
            parking_fee_min: getVal('駐車場月額(最低値)') || '',
            parking_fee_max: getVal('駐車場月額(最高値)') || '',
            // 火災保険
            insurance_required: getVal('保険加入義務') || '',
            insurance_name: getVal('保険名称') || '',
            insurance_fee: getVal('保険料') || '',
            insurance_period: getVal('保険期間') || '',
            // 備考
            remarks: (() => {
              const parts = [];
              for (let i = 1; i <= 4; i++) {
                const v = getVal('備考' + i);
                if (v) parts.push(v);
              }
              return parts.join('\n');
            })(),
            source: 'reins'
          };
        }
      });

      // === 画像をbase64で抽出（$nuxt walk → bkknGzuList 直読み方式） ===
      const imageResults = await Promise.race([
        chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async () => {
          async function fetchAsBase64(url) {
            try {
              const r = await fetch(url, { credentials: 'include' });
              if (!r.ok) return null;
              const blob = await r.blob();
              if (!blob || blob.size < 1000) return null;
              return await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              });
            } catch (e) { return null; }
          }
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const images = [];
          // Vueツリーから bkknGzuList を探索
          const findList = () => {
            const walk = (c, d = 0) => {
              if (d > 10 || !c) return null;
              if (c.$data && Array.isArray(c.$data.bkknGzuList) && c.$data.bkknGzuList.length > 0) {
                return c.$data.bkknGzuList;
              }
              const children = c.$children || [];
              for (const ch of children) {
                const r = walk(ch, d + 1);
                if (r) return r;
              }
              return null;
            };
            return walk(window.$nuxt);
          };
          // Vue マウント待ち（最大5秒）
          let list = null;
          for (let i = 0; i < 25; i++) {
            list = findList();
            if (list && list.length > 0) break;
            await sleep(200);
          }
          if (!list || list.length === 0) return images;
          // gzuBngu 昇順でソート
          const sorted = [...list].sort((a, b) => {
            const an = parseInt(a.gzuBngu, 10) || 0;
            const bn = parseInt(b.gzuBngu, 10) || 0;
            return an - bn;
          });
          for (const item of sorted) {
            let url = item.bkknGzuSrc;
            if (!url) continue;
            if (url.startsWith('/')) url = location.origin + url;
            try {
              const base64 = await fetchAsBase64(url);
              if (base64) images.push(base64);
            } catch (e) {}
          }
          return images;
        }
      }),
        new Promise((resolve) => setTimeout(() => resolve(null), 120000))
      ]);
      const imgResult = (imageResults && imageResults[0] && imageResults[0].result) || {};
      const imageBase64s = Array.isArray(imgResult) ? imgResult : (imgResult.images || []);
      await setStorageData({ debugLog: `${customer.name}: REINS画像 base64取得=${imageBase64s.length}件` });

      const detail = detailResults && detailResults[0] && detailResults[0].result;
      if (detail) {
        // room_idをハッシュ化（propertyNumberベース・顧客向けURLでソース非表示）
        detail._raw_room_id = detail.room_id;
        detail.room_id = await hashRoomId('reins', 'reins_' + (detail.reins_property_number || ''));
      }
      if (!detail) {
        try {
          const t = await chrome.tabs.get(tabId);
          const dump = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => ({
              h: [...document.querySelectorAll('h1,h2,h3')].map(e=>e.textContent.trim()).slice(0,4),
              labels: [...document.querySelectorAll('.p-label-title')].length,
              modals: document.querySelectorAll('.modal.show, .image-view').length,
              thumbs: document.querySelectorAll('div.mx-auto').length
            })
          });
          await setStorageData({ debugLog: `${customer.name}: detail=null url=${t.url?.substring(0,80)} ${JSON.stringify(dump?.[0]?.result || {})}` });
        } catch(e) {}
      }

      // === 画像base64をcatboxへアップロード（並列6 + 429指数バックオフ + 3回リトライ） ===
      if (detail && imageBase64s.length > 0) {
        try {
          const uploadedUrls = [];
          let uploadFailed = 0;
          const uploadErrors = [];
          async function uploadOne(b64) {
            const MAX_ATTEMPTS = 3;
            let lastErr = null;
            for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
              try {
                const publicUrl = await uploadBase64ToCatbox(b64);
                if (publicUrl) return publicUrl;
                lastErr = 'null_response';
                if (attempt < MAX_ATTEMPTS - 1) await csleep(1000);
              } catch (e) {
                lastErr = (e && e.message) || String(e);
                if (attempt >= MAX_ATTEMPTS - 1) {
                  uploadErrors.push(`b64size=${b64?.length || 0} err=${lastErr}`);
                  return null;
                }
                if (e && e.rateLimited) {
                  const wait = 2000 * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
                  await csleep(wait);
                } else {
                  await csleep(1000);
                }
              }
            }
            if (lastErr) uploadErrors.push(`b64size=${b64?.length || 0} err=${lastErr}`);
            return null;
          }
          const BATCH = 2;
          for (let i = 0; i < imageBase64s.length; i += BATCH) {
            const chunk = imageBase64s.slice(i, i + BATCH);
            const results = await Promise.all(chunk.map(uploadOne));
            for (const r of results) {
              if (r) uploadedUrls.push(r);
              else uploadFailed++;
            }
            if (i + BATCH < imageBase64s.length) await csleep(1500);
          }
          if (uploadedUrls.length > 0) {
            detail.image_urls = uploadedUrls;
            detail.image_url = uploadedUrls[0];
          }
          const errSample = uploadErrors.length > 0 ? ` [${uploadErrors.slice(0,2).join(' | ')}]` : '';
          await setStorageData({ debugLog: `${customer.name}: REINS画像アップロード完了 ${uploadedUrls.length}/${imageBase64s.length}件${uploadFailed > 0 ? ` (失敗:${uploadFailed})` : ''}${errSample}` });
        } catch (upErr) {
          logError(`${customer.name}: REINS画像アップロード失敗: ${upErr.message}`);
        }
      }

      if (detail) {
        const rejectReason = getFilterRejectReason(detail, customer);
        if (!rejectReason) {
          newProperties.push(detail);
          currentStats.totalFound++;
          await setStorageData({ debugLog: `${customer.name}: ✓ 送信対象（${detail.building_name} ${detail.room_number || ''} ${detail.floor_text} ${detail.rent ? (detail.rent/10000)+'万' : ''}）` });
          // リアルタイムでGAS送信＋Discord通知
          try {
            const submitResult = await submitProperties(customer.name, [detail]);
            if (submitResult?.success) {
              currentStats.totalSubmitted += submitResult.added || 1;
            }
          } catch (err) {
            logError(`${customer.name}: ${detail.building_name} ${detail.room_number || ''} GAS送信失敗: ${err.message}`);
          }
          try {
            await deliverProperty(customer.name, detail, customer, 'reins');
          } catch (err) {
            logError(`${customer.name}: ${detail.building_name} ${detail.room_number || ''} Discord通知失敗: ${err.message}`);
          }
          await setStorageData({ stats: currentStats });
        } else {
          await setStorageData({ debugLog: `${customer.name}: ✗ スキップ: ${detail.building_name} ${detail.room_number || ''} - ${rejectReason}` });
        }
      }

      await setStorageData({ debugLog: `${customer.name}: 一覧に戻り中...` });
      // 残留モーダルを閉じる
      await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN',
        func: () => {
          for (let i = 0; i < 3; i++) {
            const m = document.querySelector('.modal.show, .image-view');
            if (!m) break;
            const cb = document.querySelector('.modal.show .btn.btn-outline, .modal.show .close, .modal .btn.btn-outline');
            if (cb) cb.click();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
          }
        }
      });
      await csleep(500);
      // 検索結果に戻る
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          // ① UI上の戻るボタン優先
          const backBtn = document.querySelector('.p-btn-back')
            || [...document.querySelectorAll('button')].find(el => /^(←|戻る|検索結果に戻る)/.test(el.textContent.trim()));
          if (backBtn) { backBtn.click(); return 'backBtn'; }
          // ② Vue Router
          const nuxt = window.$nuxt;
          if (nuxt?.$router) { nuxt.$router.back(); return 'router'; }
          history.back();
          return 'history';
        }
      });
      // 検索結果一覧(GBK002200)に戻るまで待つ
      let backSuccess = false;
      for (let bw = 0; bw < 10; bw++) {
        await csleep(2000);
        const bt = await chrome.tabs.get(tabId);
        await setStorageData({ debugLog: `${customer.name}: 戻り待機 ${bw+1}/10 url=${(bt.url||'').slice(-40)}` });
        // 3回目以降でまだ詳細ページなら強制的に戻る操作を再度打つ
        if (bw >= 2 && bt.url?.includes('GBK003200')) {
          await chrome.scripting.executeScript({
            target: { tabId }, world: 'MAIN',
            func: () => {
              const backBtn = document.querySelector('.p-btn-back')
                || [...document.querySelectorAll('button')].find(el => /^(←|戻る|検索結果に戻る)/.test(el.textContent.trim()));
              if (backBtn) { backBtn.click(); return; }
              const nuxt = window.$nuxt;
              if (nuxt?.$router) nuxt.$router.back();
            }
          });
        }
        if (bt.url?.includes('GBK002200')) {
          // URLだけでなく、結果一覧の行が実際に描画されているか確認
          const rowsCheck = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => document.querySelectorAll('.p-table-body-row').length
          });
          const rowCount = rowsCheck?.[0]?.result || 0;
          if (rowCount > 0) { backSuccess = true; break; }
          // rows=0 が6回続いたら検索フォームに戻して再検索で強制リフレッシュ
          if (bw >= 5) {
            await setStorageData({ debugLog: `${customer.name}: 結果0件→検索フォームへ強制遷移` });
            await chrome.tabs.update(tabId, { url: 'https://system.reins.jp/main/BK/GBK001310' });
            await csleep(3000);
          }
          continue;
        }
        // 検索フォーム(GBK001310)に戻ってしまった場合 → 再検索して結果ページに復帰
        if (bt.url?.includes('GBK001310')) {
          await setStorageData({ debugLog: `${customer.name}: 検索フォームに戻った→再検索で復帰試行` });
          // 検索ボタンをクリック（条件はまだセットされている）
          await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
              const btns = [...document.querySelectorAll('button')];
              const searchBtn = btns.find(b => b.textContent.trim() === '検索');
              if (searchBtn) searchBtn.click();
            }
          });
          // 結果ページに遷移するまで待つ
          let reSearchOk = false;
          for (let rs = 0; rs < 30; rs++) {
            await csleep(3000);
            const rsCheck = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => {
                // ダイアログ処理
                const dialogs = document.querySelectorAll('[role="dialog"], .modal.show');
                for (const dialog of dialogs) {
                  const text = dialog.textContent;
                  if (text.includes('500件') || text.includes('超えています')) {
                    const okBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
                    if (okBtn) { okBtn.click(); return 'ok_clicked'; }
                  }
                }
                if (document.body.textContent.includes('検索結果一覧')) return 'result_page';
                return 'waiting';
              }
            });
            const rsStatus = rsCheck?.[0]?.result;
            if (rsStatus === 'result_page' || rsStatus === 'ok_clicked') {
              reSearchOk = true;
              if (rsStatus === 'ok_clicked') {
                await csleep(3000); // ダイアログ閉じ待ち
              }
              break;
            }
          }
          if (reSearchOk) {
            await setStorageData({ debugLog: `${customer.name}: 再検索で結果ページ復帰成功` });
            // 現在のページに戻る必要がある場合はページネーション
            if (currentPage > 1) {
              for (let navP = 2; navP <= currentPage; navP++) {
                await chrome.scripting.executeScript({
                  target: { tabId },
                  func: (page) => {
                    const pageLinks = document.querySelectorAll('.page-link');
                    for (const link of pageLinks) {
                      if (link.textContent.trim() === String(page)) { link.click(); return; }
                    }
                  },
                  args: [navP]
                });
                await csleep(3000);
              }
            }
            backSuccess = true;
          } else {
            await setStorageData({ debugLog: `${customer.name}: 再検索復帰失敗→残り物件スキップ` });
            return newProperties;
          }
          break;
        }
        if (!bt.url?.includes('system.reins.jp')) {
          // REINS外に遷移した → history.back()でREINSに戻る試行
          await setStorageData({ debugLog: `${customer.name}: REINS外に遷移(${bt.url?.substring(0,50)})→戻り試行` });
          await chrome.scripting.executeScript({
            target: { tabId },
            func: () => { history.back(); }
          });
          await csleep(3000);
          const bt2 = await chrome.tabs.get(tabId);
          if (bt2.url?.includes('GBK002200')) { backSuccess = true; break; }
          if (bt2.url?.includes('GBK001310')) {
            // 検索フォームに戻れた → 再検索で復帰
            await setStorageData({ debugLog: `${customer.name}: REINS復帰→検索フォームから再検索` });
            await chrome.scripting.executeScript({
              target: { tabId }, world: 'MAIN',
              func: () => {
                const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '検索');
                if (btn) btn.click();
              }
            });
            let reOk = false;
            for (let rs = 0; rs < 30; rs++) {
              await csleep(3000);
              const rsCheck = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                  const dialogs = document.querySelectorAll('[role="dialog"], .modal.show');
                  for (const dialog of dialogs) {
                    if (dialog.textContent.includes('500件') || dialog.textContent.includes('超えています')) {
                      const okBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
                      if (okBtn) { okBtn.click(); return 'ok_clicked'; }
                    }
                  }
                  if (document.body.textContent.includes('検索結果一覧')) return 'result_page';
                  return 'waiting';
                }
              });
              const s = rsCheck?.[0]?.result;
              if (s === 'result_page' || s === 'ok_clicked') { reOk = true; if (s === 'ok_clicked') await csleep(3000); break; }
            }
            if (reOk) {
              if (currentPage > 1) {
                for (let navP = 2; navP <= currentPage; navP++) {
                  await chrome.scripting.executeScript({ target: { tabId }, func: (page) => { const links = document.querySelectorAll('.page-link'); for (const l of links) { if (l.textContent.trim() === String(page)) { l.click(); return; } } }, args: [navP] });
                  await csleep(3000);
                }
              }
              backSuccess = true;
              break;
            }
          }
          if (!backSuccess) {
            await setStorageData({ debugLog: `${customer.name}: REINS復帰失敗→残り物件スキップ` });
            return newProperties;
          }
        }
      }
      if (!backSuccess) {
        await setStorageData({ debugLog: `${customer.name}: 戻りタイムアウト→残り物件スキップ` });
        return newProperties;
      }
      await csleep(delay);

    } catch (err) {
      if (err.message === 'SEARCH_CANCELLED' || err.message === 'SLEEP_DETECTED' || err.message === 'REINS_ERROR_PAGE') throw err;
      await setStorageData({ debugLog: `${customer.name}: 詳細取得失敗(${result.buildingName || result.propertyNumber}): ${err.message}` });
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            const nuxt = window.$nuxt;
            if (nuxt?.$router) { nuxt.$router.back(); return; }
            const backBtn = document.querySelector('.p-btn-back')
              || [...document.querySelectorAll('button')].find(el => el.textContent.trim() === '←');
            if (backBtn) backBtn.click(); else history.back();
          }
        });
        let recovered = false;
        for (let bw = 0; bw < 10; bw++) {
          await csleep(2000);
          const bt = await chrome.tabs.get(tabId);
          if (bt.url?.includes('GBK002200')) { recovered = true; break; }
          if (bt.url?.includes('GBK001310')) {
            // 検索フォームに戻った→再検索で復帰
            await setStorageData({ debugLog: `${customer.name}: エラー回復→検索フォームから再検索` });
            await chrome.scripting.executeScript({
              target: { tabId }, world: 'MAIN',
              func: () => {
                const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '検索');
                if (btn) btn.click();
              }
            });
            for (let rs = 0; rs < 30; rs++) {
              await csleep(3000);
              const rsCheck = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                  const dialogs = document.querySelectorAll('[role="dialog"], .modal.show');
                  for (const dialog of dialogs) {
                    if (dialog.textContent.includes('500件') || dialog.textContent.includes('超えています')) {
                      const okBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
                      if (okBtn) { okBtn.click(); return 'ok_clicked'; }
                    }
                  }
                  if (document.body.textContent.includes('検索結果一覧')) return 'result_page';
                  return 'waiting';
                }
              });
              const s = rsCheck?.[0]?.result;
              if (s === 'result_page' || s === 'ok_clicked') {
                recovered = true;
                if (s === 'ok_clicked') await csleep(3000);
                break;
              }
            }
            if (recovered && currentPage > 1) {
              for (let navP = 2; navP <= currentPage; navP++) {
                await chrome.scripting.executeScript({
                  target: { tabId },
                  func: (page) => {
                    const pageLinks = document.querySelectorAll('.page-link');
                    for (const link of pageLinks) {
                      if (link.textContent.trim() === String(page)) { link.click(); return; }
                    }
                  },
                  args: [navP]
                });
                await csleep(3000);
              }
            }
            if (!recovered) {
              await setStorageData({ debugLog: `${customer.name}: エラー回復失敗→残り物件スキップ` });
              return newProperties;
            }
            break;
          }
          if (!bt.url?.includes('system.reins.jp')) {
            await setStorageData({ debugLog: `${customer.name}: エラー回復失敗(REINS外)→残り物件スキップ` });
            return newProperties;
          }
        }
        if (!recovered) {
          await setStorageData({ debugLog: `${customer.name}: エラー回復タイムアウト→残り物件スキップ` });
          return newProperties;
        }
        await csleep(delay);
      } catch(e) { if (e.message === 'SEARCH_CANCELLED' || e.message === 'SLEEP_DETECTED' || e.message === 'REINS_ERROR_PAGE') throw e; }
    }
  } // end detail loop for current page

    // --- ページネーション: 次のページへ ---
    if (currentPage < totalPages) {
      const nextPage = currentPage + 1;
      await setStorageData({ debugLog: `${customer.name}: ページ${nextPage}/${totalPages}へ移動中...` });
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (page) => {
            const pageLinks = document.querySelectorAll('.page-link');
            for (const link of pageLinks) {
              if (link.textContent.trim() === String(page)) {
                link.click();
                return true;
              }
            }
            // 「次へ」ボタンのフォールバック
            for (const link of pageLinks) {
              if (link.textContent.includes('次') || link.textContent.includes('›')) {
                link.click();
                return true;
              }
            }
            return false;
          },
          args: [nextPage]
        });
        await waitForTabLoad(tabId);
        await csleep(delay);
        currentPage = nextPage;
      } catch (err) {
        if (err.message === 'SEARCH_CANCELLED') throw err;
        await setStorageData({ debugLog: `${customer.name}: ページ${nextPage}への移動失敗: ${err.message}` });
        break pageLoop;
      }
    } else {
      break; // 最終ページ処理完了
    }
  } // end pageLoop

  if (newProperties.length === 0) {
    await setStorageData({ debugLog: `${customer.name}: 新規物件なし` });
  } else {
    await setStorageData({ debugLog: `${customer.name}: ${newProperties.length}件送信完了（全${totalPages}ページ）` });
  }
}

// --- ユーティリティ ---

// 拡張専用のREINSタブID（検索中のみ有効）
let dedicatedReinsTabId = null;
let dedicatedReinsWindowId = null;

async function findOrCreateDedicatedReinsTab() {
  // 既存の専用タブが生きているか確認
  if (dedicatedReinsTabId) {
    try {
      const tab = await chrome.tabs.get(dedicatedReinsTabId);
      if (tab && tab.url?.includes('system.reins.jp')) {
        return tab;
      }
    } catch (e) {
      // タブが閉じられている
    }
    dedicatedReinsTabId = null;
    dedicatedReinsWindowId = null;
  }

  // 専用ウィンドウを作成（最小化）してREINSを開く
  // クッキー共有でログイン済みセッションを引き継ぐ
  await setStorageData({ debugLog: '専用REINSウィンドウを作成中...' });
  const newWindow = await chrome.windows.create({
    url: 'https://system.reins.jp/main/BK/GBK001310',
    focused: false,
    width: 1200,
    height: 800,
    left: 0,
    top: 0,
    type: 'normal'
  });
  dedicatedReinsWindowId = newWindow.id;
  dedicatedReinsTabId = newWindow.tabs[0].id;

  // ページ読み込み完了を待つ
  await waitForTabLoad(dedicatedReinsTabId);
  await sleep(3000);

  // ログイン状態を確認
  const tab = await chrome.tabs.get(dedicatedReinsTabId);
  if (tab.url?.includes('login') || tab.url?.includes('GKG001')) {
    await setStorageData({ debugLog: '専用ウィンドウでREINSログインが必要です' });
    await closeDedicatedWindow();
    return null;
  }

  await setStorageData({ debugLog: `専用REINSタブ作成: tabId=${dedicatedReinsTabId}, windowId=${dedicatedReinsWindowId}` });
  return tab;
}

async function closeDedicatedWindow() {
  if (dedicatedReinsWindowId) {
    try {
      await chrome.windows.remove(dedicatedReinsWindowId);
    } catch (e) {
      // 既に閉じられている
    }
    dedicatedReinsWindowId = null;
    dedicatedReinsTabId = null;
  }
}

// 後方互換: 既存コードから呼ばれる場合のエイリアス
async function findReinsTab() {
  return findOrCreateDedicatedReinsTab();
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo(() => {}); }, 25000);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearInterval(keepAlive);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); clearInterval(keepAlive); resolve(); }, 30000);
  });
}

// ログタブを開く（既に開いていればフォーカス）
async function openLogTab() {
  const logUrl = chrome.runtime.getURL('log.html');
  const tabs = await chrome.tabs.query({ url: logUrl });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: logUrl, active: false });
  }
}

// Service Worker keepalive付きsleep（MV3ではsetTimeoutだけだとWorkerが停止する）
function sleep(ms) {
  return new Promise(resolve => {
    // 25秒ごとにChrome APIを呼んでService Workerを生存させる
    const keepAlive = setInterval(() => {
      chrome.runtime.getPlatformInfo(() => {});
    }, 25000);
    setTimeout(() => {
      clearInterval(keepAlive);
      resolve();
    }, ms);
  });
}

function getStorageData(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function setStorageData(data) {
  if (data.debugLog) {
    return new Promise(resolve => {
      chrome.storage.local.get(['debugLog'], (prev) => {
        const prevLog = prev.debugLog || '';
        const timestamp = new Date().toLocaleTimeString('ja-JP');
        data.debugLog = prevLog + `\n[${timestamp}] ${data.debugLog}`;
        if (data.debugLog.length > 500000) data.debugLog = data.debugLog.slice(-500000);
        chrome.storage.local.set(data, resolve);
      });
    });
  }
  return new Promise(resolve => chrome.storage.local.set(data, resolve));
}

function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text y="20" font-size="20">🏠</text></svg>',
    title,
    message
  });
}

// === Discord Webhook 送信 ===

// 顧客ごとのDiscordスレッドID（検索サイクル中に保持）
const discordThreadIds = {};
// 顧客ごとのDiscord物件通し番号（検索サイクル中に保持）
const discordPropertyCounters = {};

function buildSearchInfo(customer) {
  const lines = ['📋 **検索条件**', '━━━━━━━━━━'];

  // 路線・駅
  if (customer.routes && customer.routes.length > 0) {
    const routeStations = customer.route_stations || {};
    const routeParts = customer.routes.map(route => {
      const stas = routeStations[route];
      return stas && stas.length > 0 ? `${route}(${stas.join(', ')})` : route;
    });
    lines.push(`🚉 ${routeParts.join(' / ')}`);
  }

  // 賃料
  if (customer.rent_max) {
    lines.push(`💰 〜${customer.rent_max}万円`);
  }

  // 間取り
  if (customer.layouts && customer.layouts.length > 0) {
    lines.push(`🏠 ${customer.layouts.join(' / ')}`);
  }

  // 面積
  if (customer.area_min) {
    lines.push(`📐 ${customer.area_min}㎡〜`);
  }

  // 築年数
  if (customer.building_age) {
    lines.push(`🏗 築${String(customer.building_age).replace(/[^\d]/g, '')}年以内`);
  }

  // 構造
  if (customer.structures && customer.structures.length > 0) {
    lines.push(`🏢 ${customer.structures.join(' / ')}`);
  }

  // 駅徒歩
  if (customer.walk) {
    const walkMin = String(customer.walk).replace(/[^\d]/g, '');
    if (walkMin) lines.push(`🚶 徒歩${walkMin}分以内`);
  }

  // 設備・条件
  if (customer.equipment) {
    const equipStr = typeof customer.equipment === 'string' ? customer.equipment : (customer.equipment || []).join(', ');
    if (equipStr) lines.push(`🔧 ${equipStr}`);
  }

  // 検索URL（いえらぶ等）
  if (customer.search_url) {
    lines.push(`🔍 [検索結果を開く](${customer.search_url})`);
  }

  return lines.join('\n');
}

// === 通知モード制御 ===
// _batchBuffer[customerName] = [{ prop, customer, service }, ...]
const _batchBuffer = {};
const _serviceRank = { itandi: 4, essquare: 3, ielove: 2, reins: 1 };

function normalizeBuildingName(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFKC')              // 全角→半角、互換正規化
    .replace(/[\s\u3000]+/g, '')     // 空白削除
    .replace(/[()（）\-－ｰ・,、.。]/g, '') // 記号削除
    .toUpperCase();
}

function buildDedupKey(prop) {
  const name = normalizeBuildingName(prop.building_name || prop.buildingName || '');
  if (!name) return null; // 建物名ないと判定不能→重複排除しない
  const room = prop.room_number || prop.roomNumber || '';
  if (room) return `${name}|${String(room).trim()}`;
  const floor = prop.floor || prop.floorText || '';
  const area = prop.area || '';
  return `${name}|${floor}|${area}`;
}

async function deliverProperty(customerName, prop, customer, service) {
  const { notifyMode } = await getStorageData(['notifyMode']);
  if (notifyMode === 'batch') {
    if (!_batchBuffer[customerName]) _batchBuffer[customerName] = [];
    _batchBuffer[customerName].push({ prop, customer, service });
    return;
  }
  // 即時モード（デフォルト）
  await sendDiscordNotification(customerName, [prop], customer);
}

// 特定顧客のバッファをフラッシュ（重複排除→通知）
async function flushBatchBufferForCustomer(customerName) {
  const entries = _batchBuffer[customerName];
  if (!entries || entries.length === 0) return;
  const byKey = new Map();
  const noKey = [];
  const dropped = []; // 重複として除外されたもの（ログ用）
  for (const e of entries) {
    const key = buildDedupKey(e.prop);
    if (!key) { noKey.push(e); continue; }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, e);
    } else if ((_serviceRank[e.service] || 0) > (_serviceRank[existing.service] || 0)) {
      // 既存より優先度が高い → 入れ替え。既存を dropped へ
      dropped.push({ ...existing, _winnerService: e.service });
      byKey.set(key, e);
    } else {
      // 既存の方が優先 → こちらを dropped へ
      dropped.push({ ...e, _winnerService: existing.service });
    }
  }
  const winners = [...byKey.values(), ...noKey];
  const props = winners.map(e => e.prop);
  const customer = winners[0].customer;
  await setStorageData({ debugLog: `[system] ${customerName}: ${entries.length}件→重複${dropped.length}件排除→${winners.length}件通知` });
  // 排除された物件を1件ずつログ
  for (const d of dropped) {
    const name = d.prop.building_name || d.prop.buildingName || '(建物名なし)';
    const room = d.prop.room_number || d.prop.roomNumber || '';
    await setStorageData({ debugLog: `[system] ${customerName}: ✗ 重複スキップ: ${name} ${room} (${d.service} → ${d._winnerService}優先)` });
  }
  try {
    await sendDiscordNotification(customerName, props, customer);
  } catch (err) {
    logError(`${customerName}: 一括通知失敗: ${err.message}`);
  }
  delete _batchBuffer[customerName];
}

async function sendDiscordNotification(customerName, properties, customer) {
  const { discordWebhookUrl, gasWebappUrl } = await getConfig();
  if (!discordWebhookUrl || properties.length === 0) return;

  try {
    let threadId = discordThreadIds[customerName];

    // スレッドがまだなければ作成＋検索条件を送信
    if (!threadId) {
      const headerPayload = {
        content: `**${customerName}** 様の新着物件`,
        thread_name: `🏠 ${customerName}`
      };
      const resp = await fetch(`${discordWebhookUrl}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(headerPayload)
      });

      if (!resp.ok) {
        console.error(`Discord スレッド作成失敗: status=${resp.status}`);
        return;
      }

      const respData = await resp.json();
      threadId = respData.channel_id;
      if (!threadId) {
        console.error('Discord レスポンスに channel_id なし');
        return;
      }
      discordThreadIds[customerName] = threadId;

      // 検索条件を送信
      if (customer) {
        const searchInfo = buildSearchInfo(customer);
        await sleep(500);
        await discordPostWithRetry(`${discordWebhookUrl}?thread_id=${threadId}`, { content: searchInfo });
        await sleep(500);
      }

      // 未解決駅があればスレッド内に警告を送信
      const custUnresolved = _unresolvedStations[customerName];
      if (custUnresolved) {
        const svcParts = [];
        for (const [svc, names] of Object.entries(custUnresolved)) {
          if (names.length > 0) svcParts.push(`${svc}: ${names.join(', ')}`);
        }
        if (svcParts.length > 0) {
          const warnMsg = `⚠️ **駅名解決失敗**\n${svcParts.join('\n')}\n該当駅の検索がスキップされています。`;
          await discordPostWithRetry(`${discordWebhookUrl}?thread_id=${threadId}`, { content: warnMsg });
          await sleep(500);
        }
      }
    }

    // 物件ごとに送信（顧客ごとの通し番号）
    if (!discordPropertyCounters[customerName]) discordPropertyCounters[customerName] = 0;
    for (let i = 0; i < properties.length; i++) {
      discordPropertyCounters[customerName]++;
      const msg = buildDiscordMessage(properties[i], discordPropertyCounters[customerName], gasWebappUrl, customerName, customer);
      await discordPostWithRetry(`${discordWebhookUrl}?thread_id=${threadId}`, { content: msg });
      if (i < properties.length - 1) await sleep(1000);
    }

    console.log(`Discord通知完了: ${customerName} ${properties.length}件`);
  } catch (err) {
    console.error(`Discord通知失敗: ${err.message}`);
  }
}

async function discordPostWithRetry(url, payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    let resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (resp.status === 429) {
      const data = await resp.json();
      const retryAfter = Math.min((data.retry_after || 5) * 1000, 30000);
      console.warn(`Discord レート制限。${retryAfter}ms待機...`);
      await sleep(retryAfter);
      const ctrl2 = new AbortController();
      const tid2 = setTimeout(() => ctrl2.abort(), 15000);
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl2.signal
      });
      clearTimeout(tid2);
    }

    if (!resp.ok && resp.status !== 204) {
      console.error(`Discord送信エラー: status=${resp.status}`);
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error('Discord送信タイムアウト');
    } else {
      throw err;
    }
  }
}

/**
 * 入居時期テキストを Date オブジェクトに変換する。
 * Python の _parse_move_in_date と同等のロジック。
 *
 * @param {string} text - 入居時期テキスト（例: "5月中旬", "2026年4月下旬", "即入居可"）
 * @param {boolean} asDeadline - true: 旬の末日（顧客の希望期限）、false: 旬の初日（物件の入居可能開始日）
 * @returns {Date|null}
 */
function _parseMoveInDate(text, asDeadline = false) {
  if (!text) return null;
  text = text.trim();

  // 制約なし・即時入居可能 → 比較不要
  const skipKeywords = ['いい物件見つかり次第', '即入居可', '即入居', '即時', '即日', '未定'];
  if (skipKeywords.some(kw => text.includes(kw))) return null;

  // 和暦→西暦変換（"令和 8年 4月" → "2026年4月"）
  const warekiMatch = text.match(/(?:令和|平成|昭和)\s*(\d{1,2})\s*年/);
  if (warekiMatch) {
    const eraYear = parseInt(warekiMatch[1]);
    let seirekiYear;
    if (text.includes('令和')) seirekiYear = 2018 + eraYear;
    else if (text.includes('平成')) seirekiYear = 1988 + eraYear;
    else if (text.includes('昭和')) seirekiYear = 1925 + eraYear;
    if (seirekiYear) {
      text = text.replace(/(?:令和|平成|昭和)\s*\d{1,2}\s*年/, `${seirekiYear}年`);
    }
  }

  const now = new Date();
  const refYear = now.getFullYear();
  const refMonth = now.getMonth() + 1; // 1-based

  // 年・月・日・旬 を抽出
  const yearMatch = text.match(/(\d{4})\s*年/);
  const monthMatch = text.match(/(\d{1,2})\s*月/);
  const dayMatch = text.match(/(\d{1,2})\s*日/);

  let year = yearMatch ? parseInt(yearMatch[1]) : null;
  const month = monthMatch ? parseInt(monthMatch[1]) : null;

  if (month === null) return null; // 月がないと判定不能

  let period = null;
  if (text.includes('上旬')) period = 'early';
  else if (text.includes('中旬')) period = 'mid';
  else if (text.includes('下旬')) period = 'late';

  // 年が未指定の場合: 今年 or 来年で最も近い未来を推定
  if (year === null) {
    year = month >= refMonth ? refYear : refYear + 1;
  }

  // 日の決定
  let day;
  if (dayMatch) {
    day = parseInt(dayMatch[1]);
  } else if (period !== null) {
    if (asDeadline) {
      if (period === 'early') day = 10;
      else if (period === 'mid') day = 20;
      else day = new Date(year, month, 0).getDate(); // 月末
    } else {
      if (period === 'early') day = 1;
      else if (period === 'mid') day = 11;
      else day = 21;
    }
  } else {
    // 月のみ指定
    if (asDeadline) {
      day = new Date(year, month, 0).getDate(); // 月末
    } else {
      day = 1;
    }
  }

  try {
    const d = new Date(year, month - 1, day);
    if (isNaN(d.getTime())) return null;
    return d;
  } catch {
    return null;
  }
}

/**
 * 物件の入居可能時期が顧客の希望入居時期を過ぎていないかチェックする。
 * @param {Object} prop - 物件オブジェクト
 * @param {string} customerMoveIn - 顧客の希望入居時期
 * @returns {string|null} - 警告メッセージ or null
 */
function _checkMoveInWarning(prop, customerMoveIn) {
  if (!customerMoveIn || customerMoveIn === 'いい物件見つかり次第') return null;

  const customerDeadline = _parseMoveInDate(customerMoveIn, true);
  if (!customerDeadline) return null;

  const propMoveIn = (prop.move_in_date || '').trim();

  // 即入居可等はスキップ
  if (['即入居可', '即入居', '即時', '即日'].some(kw => propMoveIn.includes(kw))) return null;

  // 入居可能時期が空（記載なし）
  if (!propMoveIn) {
    return `⚠️ ${customerMoveIn}入居希望: 入居可能時期の記載がありません`;
  }

  // 「相談」は日付比較できないが、入居時期が不確定なのでアラート
  if (propMoveIn.includes('相談')) {
    return `⚠️ ${customerMoveIn}入居希望: 入居時期「相談」のため要確認`;
  }

  const propertyAvailable = _parseMoveInDate(propMoveIn, false);
  if (!propertyAvailable) return null;

  if (propertyAvailable > customerDeadline) {
    return `⚠️ ${customerMoveIn}入居希望: 入居可能${propMoveIn}のため要確認`;
  }

  return null;
}

function buildDiscordMessage(prop, index, gasWebappUrl, customerName, customer) {
  const fmtMan = (yen) => {
    if (!yen) return '0';
    const v = yen / 10000;
    return String(parseFloat(v.toFixed(4)));
  };

  let title = prop.building_name || '物件情報';
  if (prop.room_number) title += `  ${prop.room_number}`;

  const sourceTag = prop.source === 'ielove' ? 'いえらぶ' : prop.source === 'itandi' ? 'itandi' : prop.source === 'essquare' ? 'いい生活スクエア' : 'REINS';
  const lines = [`**${index}. ${title}** \`[${sourceTag}]\``];

  // 賃料
  let rentStr = `💰 **${fmtMan(prop.rent)}万円**`;
  if (prop.management_fee) {
    rentStr += ` (管理費: ${fmtMan(prop.management_fee)}万円)`;
  }
  lines.push(rentStr);

  // 間取り・面積・築年
  const parts = [];
  if (prop.layout) parts.push(`🏠 ${prop.layout}`);
  if (prop.area) parts.push(`📐 ${prop.area}m²`);
  if (prop.building_age) parts.push(`🏗 ${prop.building_age}`);
  if (parts.length) lines.push(parts.join(' ｜ '));

  if (prop.address) lines.push(`📍 ${prop.address}`);
  if (prop.station_info) lines.push(`🚉 ${prop.station_info}`);

  // 階数
  if (prop.floor_text || prop.story_text) {
    lines.push(`🏢 ${prop.floor_text || '?'}/${prop.story_text || '?'}`);
  }

  if (prop.deposit || prop.key_money) {
    lines.push(`💴 敷金: ${prop.deposit || 'なし'} / 礼金: ${prop.key_money || 'なし'}`);
  }

  // 入居時期
  if (prop.move_in_date) {
    lines.push(`📅 入居: ${prop.move_in_date}`);
  }

  // 警告アラート（ANSI黄色コードブロックで表示 — rent-researcher準拠）
  const toHankaku = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const equip = toHankaku(customer?.equipment || '').toLowerCase();
  const floorNum = parseInt(toHankaku(prop.floor_text || '').match(/(\d+)/)?.[1] || '0');
  const storyNum = parseInt(toHankaku(prop.story_text || '').match(/(\d+)/)?.[1] || '0');
  const warnings = [];
  if (equip.includes('最上階') && (floorNum === 0 || storyNum === 0)) {
    warnings.push('⚠️ 最上階かどうか確認してください');
  }
  if (equip.includes('2階以上') && floorNum === 0) {
    warnings.push('⚠️ 2階以上かどうか確認してください');
  }
  if (equip.includes('1階') && !equip.includes('2階以上') && floorNum === 0) {
    warnings.push('⚠️ 1階かどうか確認してください');
  }
  if (equip.includes('南向き') && !prop.sunlight) {
    warnings.push('⚠️ 南向きかどうか確認してください');
  }
  if (equip.includes('角部屋') && !(prop.facilities || '').includes('角部屋') && !(prop.facilities || '').includes('角住戸') && !(prop.room_attr || '').includes('角部屋')) {
    warnings.push('⚠️ 角部屋かどうか確認してください');
  }
  // 設備系アラート（REINSの実際の設備名で判定。設備情報なし/ありどちらでもチェック）
  const fac = prop.facilities || '';
  // 追い焚き（REINS: 追焚機能, itandi: 追焚き機能）
  if ((equip.includes('追い焚き') || equip.includes('追いだき') || equip.includes('追い炊き')) && !fac.includes('追焚') && !fac.includes('追い焚') && !fac.includes('追いだき')) {
    warnings.push('⚠️ 追い焚き機能かどうか確認してください');
  }
  // エレベーター（REINS: エレベータ ※長音なし, itandi: エレベーター）
  if ((equip.includes('エレベーター') || equip.includes('ev')) && !fac.includes('エレベータ') && !fac.includes('エレベーター')) {
    warnings.push('⚠️ エレベーターかどうか確認してください');
  }
  // バス・トイレ別（REINS: バス・トイレ別, itandi: バス・トイレ別, いえらぶ: バストイレ別）
  // btMode='skip' の場合はフィルタ側で除外済みなのでアラート不要
  if (__btMode !== 'skip' && (equip.includes('バストイレ別') || equip.includes('バス・トイレ別') || equip.includes('bt別')) && !fac.includes('バス・トイレ別') && !fac.includes('バストイレ別')) {
    warnings.push('⚠️ バス・トイレ別かどうか確認してください');
  }
  // 温水洗浄便座
  if ((equip.includes('温水洗浄便座') || equip.includes('ウォシュレット')) && !fac.includes('温水洗浄便座')) {
    warnings.push('⚠️ 温水洗浄便座かどうか確認してください');
  }
  // 浴室乾燥機（REINS: 浴室乾燥機, itandi: 浴室乾燥/浴室乾燥機）
  if (equip.includes('浴室乾燥') && !fac.includes('浴室乾燥')) {
    warnings.push('⚠️ 浴室乾燥機かどうか確認してください');
  }
  // 室内洗濯機置場（REINS: 室内洗濯機置場, itandi: 室内洗濯機置き場）
  if ((equip.includes('室内洗濯機置場') || equip.includes('室内洗濯')) && !fac.includes('室内洗濯機')) {
    warnings.push('⚠️ 室内洗濯機置場かどうか確認してください');
  }
  // エアコン
  if (equip.includes('エアコン') && !fac.includes('エアコン')) {
    warnings.push('⚠️ エアコン付きかどうか確認してください');
  }
  // 床暖房
  if (equip.includes('床暖房') && !fac.includes('床暖房')) {
    warnings.push('⚠️ 床暖房かどうか確認してください');
  }
  // 独立洗面台（REINS: シャンプードレッサー/洗面台, itandi: 独立洗面台, いえらぶ: 洗面所独立）
  // シャンプードレッサー・独立洗面・洗面所独立 → 確定。洗面台のみ → ユニットバスの可能性ありアラート
  if (equip.includes('独立洗面')) {
    if (fac.includes('シャンプードレッサー') || fac.includes('独立洗面') || fac.includes('洗面所独立') || fac.includes('洗面化粧台') || fac.includes('シャワー付洗面')) {
      // 独立洗面台確定 → アラート不要
    } else if (fac.includes('洗面台')) {
      warnings.push('⚠️ 独立洗面台があるかどうか確認してください（洗面台の記載あり、ユニットバスの可能性）');
    } else {
      warnings.push('⚠️ 独立洗面台があるかどうか確認してください');
    }
  }
  // ガスコンロ（REINS表記: ガスコンロ設置可/ガスキッチン）
  if (equip.includes('ガスコンロ') && !fac.includes('ガスコンロ') && !fac.includes('ガスキッチン')) {
    warnings.push('⚠️ ガスコンロ対応かどうか確認してください');
  }
  // IH（REINS表記: ＩＨクッキングヒーター ※全角）
  if (equip.includes('ih') && !fac.includes('ＩＨ') && !fac.includes('IH')) {
    warnings.push('⚠️ IHコンロかどうか確認してください');
  }
  // コンロ2口以上
  if (equip.includes('コンロ2口以上') || equip.includes('2口以上') || equip.includes('コンロ２口以上')) {
    if (!fac.includes('2口') && !fac.includes('２口') && !fac.includes('3口') && !fac.includes('３口')) {
      warnings.push('⚠️ コンロ2口以上かどうか確認してください');
    }
  }
  // システムキッチン
  if (equip.includes('システムキッチン') && !fac.includes('システムキッチン')) {
    warnings.push('⚠️ システムキッチンかどうか確認してください');
  }
  // カウンターキッチン（itandi: 対面キッチン, いえらぶ: オープンキッチン/アイランドキッチン, REINS: アイランドキッチン）
  if (equip.includes('カウンターキッチン') && !fac.includes('カウンターキッチン') && !fac.includes('対面キッチン') && !fac.includes('オープンキッチン') && !fac.includes('アイランドキッチン')) {
    warnings.push('⚠️ カウンターキッチンかどうか確認してください');
  }
  // 駐輪場
  if (equip.includes('駐輪場') && !fac.includes('駐輪場')) {
    warnings.push('⚠️ 駐輪場ありかどうか確認してください');
  }
  // 宅配ボックス（itandi: 宅配BOXも含む）
  if ((equip.includes('宅配ボックス') || equip.includes('宅配box')) && !fac.includes('宅配ボックス') && !fac.includes('宅配BOX')) {
    warnings.push('⚠️ 宅配ボックスかどうか確認してください');
  }
  // ゴミ置場（REINS: ２４時間ゴミ出し可, itandi: 敷地内ゴミ置き場, いえらぶ: 敷地内ごみ置き場/ゴミ出し24時間OK）
  if ((equip.includes('ゴミ置') || equip.includes('ごみ置') || equip.includes('ゴミ捨') || equip.includes('ごみ捨')) && !fac.includes('ゴミ出し') && !fac.includes('ゴミ置') && !fac.includes('ごみ置') && !fac.includes('ごみ出し')) {
    warnings.push('⚠️ 敷地内ゴミ置場かどうか確認してください');
  }
  // ロフト / ロフトNG
  if (equip.includes('ロフト')) {
    if (equip.includes('ロフトng') || equip.includes('ロフト不可')) {
      // ロフトNG: ロフトありはフィルタで除外済み。ロフト記載なしはアラート
      if (!fac.includes('ロフト')) warnings.push('⚠️ ロフトがないか確認してください（ロフトNG）');
    } else if (!fac.includes('ロフト')) {
      warnings.push('⚠️ ロフト付きかどうか確認してください');
    }
  }
  // 家具家電付き（REINSにチェックボックスなし→常にアラート）
  if (equip.includes('家具') || equip.includes('家電')) {
    warnings.push('⚠️ 家具家電付きかどうか確認してください');
  }
  // バルコニー（REINS表記: ルーフバルコニー/２面バルコニー/両面バルコニー/３面バルコニー）
  if (equip.includes('バルコニー') && !equip.includes('ルーフバルコニー')) {
    if (!fac.includes('バルコニー')) {
      warnings.push('⚠️ バルコニー付きかどうか確認してください');
    }
  }
  // ルーフバルコニー
  if (equip.includes('ルーフバルコニー') && !fac.includes('ルーフバルコニー')) {
    warnings.push('⚠️ ルーフバルコニー付きかどうか確認してください');
  }
  // 専用庭
  if (equip.includes('専用庭') && !fac.includes('専用庭')) {
    warnings.push('⚠️ 専用庭かどうか確認してください');
  }
  // 都市ガス/プロパンガス（一方がある場合はスキップで除外済み。ガス情報なしの場合はアラート）
  if (equip.includes('都市ガス') && !fac.includes('都市ガス') && !fac.includes('プロパン') && !fac.includes('LPガス') && !fac.includes('ＬＰガス')) {
    warnings.push('⚠️ 都市ガスかどうか確認してください');
  }
  if ((equip.includes('プロパン') || equip.includes('lpガス')) && !fac.includes('プロパン') && !fac.includes('LPガス') && !fac.includes('ＬＰガス') && !fac.includes('都市ガス')) {
    warnings.push('⚠️ プロパンガスかどうか確認してください');
  }
  // オートロック
  if (equip.includes('オートロック') && !fac.includes('オートロック')) {
    warnings.push('⚠️ オートロックかどうか確認してください');
  }
  // TVモニタ付きインターホン（REINS: モニター付きインターホン, itandi: モニター付インターホン, いえらぶ: TVインターホン）
  if ((equip.includes('tvモニタ') || equip.includes('モニター付') || equip.includes('モニタ付') || equip.includes('tvインターホン') || equip.includes('tvインターフォン')) && !fac.includes('モニター付') && !fac.includes('TVインターホン') && !fac.includes('ＴＶインターホン') && !fac.includes('TVモニタ')) {
    warnings.push('⚠️ TVモニタ付きインターホンかどうか確認してください');
  }
  // 防犯カメラ（REINSは常にアラート、itandi/いえらぶは防犯カメラで判定）
  if (equip.includes('防犯カメラ') && !fac.includes('防犯カメラ')) {
    warnings.push('⚠️ 防犯カメラかどうか確認してください');
  }
  // ペット可はフィルタで除外済み（アラート不要）
  // 楽器（REINS表記: 楽器使用可/楽器相談）
  if (equip.includes('楽器') && !fac.includes('楽器使用可') && !fac.includes('楽器相談')) {
    warnings.push('⚠️ 楽器可かどうか確認してください');
  }
  // 事務所利用可はフィルタで除外済み（アラート不要）
  // ルームシェア（REINSにチェックボックスなし→常にアラート）
  if ((equip.includes('ルームシェア') || equip.includes('シェアハウス')) && !fac.includes('ルームシェア') && !fac.includes('シェアハウス')) {
    warnings.push('⚠️ ルームシェア可かどうか確認してください');
  }
  // 高齢者（REINS: 高齢者向け, itandi: 高齢者向き/高齢者相談/高齢者世帯向け, いえらぶ: 高齢者限定/高齢者歓迎/高齢者相談）
  if (equip.includes('高齢者') && !fac.includes('高齢者向') && !fac.includes('高齢者相談') && !fac.includes('高齢者歓迎') && !fac.includes('高齢者限定') && !fac.includes('高齢者世帯')) {
    warnings.push('⚠️ 高齢者歓迎かどうか確認してください');
  }
  // フリーレントはフィルタで除外済み（アラート不要）
  // インターネット無料（REINS: 常にアラート, itandi: インターネット無料, いえらぶ: ネット使用料不要）
  if ((equip.includes('インターネット無料') || equip.includes('ネット無料')) && !fac.includes('インターネット無料') && !fac.includes('ネット無料') && !fac.includes('ネット使用料不要')) {
    warnings.push('⚠️ インターネット無料かどうか確認してください');
  }
  // 収納（REINS表記: 収納スペース/ウォークインクローゼット等）
  if (equip.includes('収納') && !equip.includes('ウォークイン') && !equip.includes('シューズ')) {
    if (!fac.includes('収納') && !fac.includes('クロゼット') && !fac.includes('クローゼット') && !fac.includes('物置') && !fac.includes('グルニエ')) {
      warnings.push('⚠️ 収納があるか確認してください');
    }
  }
  // シューズボックス（REINS表記: シューズインクローゼット）
  if (equip.includes('シューズ')) {
    if (!fac.includes('シューズインクローゼット') && !fac.includes('シューズボックス') && !fac.includes('シューズBOX') && !fac.includes('シューズクロゼット') && !fac.includes('シューズクローク') && !fac.includes('シューズWIC')) {
      warnings.push('⚠️ シューズボックスがあるか確認してください');
    }
  }
  // ウォークインクローゼット
  if (equip.includes('ウォークイン')) {
    if (!fac.includes('ウォークインクローゼット') && !fac.includes('ウォークインクロゼット') && !fac.includes('ウォークスルークロゼット') && !fac.includes('WIC')) {
      warnings.push('⚠️ ウォークインクローゼットがあるか確認してください');
    }
  }
  // 要物確アラート（itandi）
  if (prop.needs_confirmation) {
    warnings.push('⚠️ 要物確の物件です');
  }
  // 入居時期アラート
  const moveInWarning = _checkMoveInWarning(prop, customer?.move_in_date);
  if (moveInWarning) {
    warnings.push(moveInWarning);
  }
  if (warnings.length > 0) {
    const ansiText = warnings.join('\n');
    lines.push(`\`\`\`ansi\n\u001b[0;33m${ansiText}\u001b[0m\n\`\`\``);
  }

  // 広告料・現況・客付会社メッセージ
  lines.push(`📢 広告料: ${prop.ad_fee || '-'}`);
  if (prop.current_status) lines.push(`📋 現況: ${prop.current_status}`);
  else if (prop.listing_status) lines.push(`📋 現況: ${prop.listing_status}`);
  if (prop.agent_message) lines.push(`💬 メッセージ: ${prop.agent_message}`);

  // 詳細ページURL
  if (prop.url) {
    lines.push(`🔗 [詳細ページ](${prop.url})`);
  } else if (prop.source !== 'ielove' && prop.source !== 'itandi' && prop.source !== 'essquare' && prop.reins_property_number) {
    // REINS: 物件番号検索を自動実行するURL（拡張のcontent-search.jsがhashを検出して検索）
    const cleanNum = String(prop.reins_property_number).replace(/\D/g, '');
    lines.push(`🔗 [REINSで開く](https://system.reins.jp/main/BK/GBK004100#bukken=${cleanNum})`);
  }

  // 承認リンク
  if (gasWebappUrl && customerName) {
    const approveUrl = `${gasWebappUrl}?action=approve&customer=${encodeURIComponent(customerName)}&room_id=${prop.room_id}`;
    lines.push(`✅ [承認してLINE送信](${approveUrl})`);
  }

  return lines.join('\n');
}

// === END Discord ===

async function logError(message) {
  console.error(message);
  const { stats } = await getStorageData(['stats']);
  const currentStats = stats || { totalFound: 0, totalSubmitted: 0, errors: [], lastError: null };
  currentStats.lastError = message;
  currentStats.errors.push({ time: Date.now(), message });
  if (currentStats.errors.length > 10) currentStats.errors = currentStats.errors.slice(-10);
  await setStorageData({ stats: currentStats });
  // Discord へエラー通知（同一メッセージは5分間クールダウン）
  notifyDiscordError(message).catch(() => {});
}

// エラー通知のクールダウン管理（メモリ上）
const _errorNotifyCache = new Map();
async function notifyDiscordError(message) {
  try {
    const { discordWebhookUrl, errorWebhookUrl } = await getStorageData(['discordWebhookUrl', 'errorWebhookUrl']);
    const webhook = errorWebhookUrl || discordWebhookUrl;
    if (!webhook) return;
    // クールダウン: 同一メッセージ先頭80文字で5分以内はスキップ
    const key = String(message).slice(0, 80);
    const now = Date.now();
    const last = _errorNotifyCache.get(key) || 0;
    if (now - last < 5 * 60 * 1000) return;
    _errorNotifyCache.set(key, now);
    // 古いエントリ削除
    if (_errorNotifyCache.size > 50) {
      for (const [k, t] of _errorNotifyCache) {
        if (now - t > 30 * 60 * 1000) _errorNotifyCache.delete(k);
      }
    }
    const ts = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const body = { content: `⚠️ **REINS拡張エラー** (${ts})\n\`\`\`\n${String(message).slice(0, 1800)}\n\`\`\`` };
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.error('Discord エラー通知失敗:', e);
  }
}
