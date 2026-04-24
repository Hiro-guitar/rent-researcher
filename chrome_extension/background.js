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
importScripts('ielove-config.js', 'ielove-oaza-config.js', 'ielove-background.js');
// itandi BB関連ファイルを読み込み
importScripts('itandi-config.js', 'itandi-background.js');
// ES-Square関連ファイルを読み込み
importScripts('essquare-config.js', 'essquare-background.js');
// SUUMO巡回・入稿関連ファイルを読み込み
// suumo-competitor.js は suumo-patrol.js から countSuumoCompetitors を参照するので先にロード
importScripts('suumo-competitor.js', 'suumo-patrol.js');
// SUUMOビジネス Daily Search からの掲載実績取得(Phase 1)
importScripts('suumo-business-fetch.js');
// ForRent掲載停止(保留化)自動操作(Phase 3)
importScripts('forrent-stop.js');
// ForRent確認画面の登録ボタン自動クリック(Phase 5)
importScripts('forrent-final-submit.js');
// ForRent PUB1R2801 の成約状態をシートに直読み同期
importScripts('forrent-status-sync.js');

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
  // SUUMO巡回モードではGASに顧客向け送信しない（コレクターに追加）
  if (globalThis._suumoPatrolMode && globalThis._suumoPatrolCollector) {
    for (const prop of properties) {
      // コレクターが async push を持つ場合は await（都度送信モード）
      await globalThis._suumoPatrolCollector.push(prop);
    }
    return { success: true, added: properties.length, _patrolCollected: true };
  }
  const threadId = discordThreadIds[customerName] || '';
  return gasPost({ action: 'add_reins_property', customer_name: customerName, properties, discord_thread_id: threadId });
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

// 町名表記を正規化（漢数字→算用数字、全角→半角）
function _normalizeTownText(s) {
  if (!s) return '';
  let r = s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const kanjiMap = {'一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9','十':'10'};
  r = r.replace(/[一二三四五六七八九十]/g, c => kanjiMap[c] || c);
  r = r.replace(/\s+/g, '');
  return r;
}

// 住所テキストが指定された町名を含むかチェック（表記ゆれ対応）
function _addressMatchesTown(address, town) {
  if (address.includes(town)) return true;
  return _normalizeTownText(address).includes(_normalizeTownText(town));
}

// フィルタ不合格の理由を返す（合格ならnull）
function getFilterRejectReason(prop, customer) {
  // 町名丁目フィルタ（selectedTownsが指定されている場合、住所テキストで照合）
  if (customer.selectedTowns && Object.keys(customer.selectedTowns).length > 0) {
    const addr = prop.address || '';
    if (addr) {
      let townMatch = false;
      for (const city of Object.keys(customer.selectedTowns)) {
        const towns = customer.selectedTowns[city];
        if (!towns || towns.length === 0) continue;
        if (!addr.includes(city)) continue;
        for (const town of towns) {
          if (_addressMatchesTown(addr, town)) {
            townMatch = true;
            break;
          }
        }
        if (townMatch) break;
      }
      if (!townMatch) {
        return `町名不一致: ${addr}`;
      }
    }
  }

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
  // SUUMO巡回モード時はスキップせずDiscord通知(⚠️ 募集状況: 申込あり)へ流す
  try {
    if (!globalThis._suumoPatrolMode && globalThis.__hasMoshikomiKey && globalThis.__hasMoshikomiKey(prop.building_name, prop.room_number)) {
      return '他サイトで申込あり(前回実行)';
    }
  } catch(e) {}

  // SUUMO巡回モードのREINS物件: 広告転載区分「不可」ならスキップ
  // 「広告可」→通過 / 「広告可（但し要連絡）」→通過（Discord通知で⚠️警告表示）
  if (globalThis._suumoPatrolMode && prop.ad_keisai === '不可') {
    return '広告転載区分: 不可';
  }

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

// --- 自動検索トグルに応じてスリープ抑制を制御 ---
function __applyKeepAwakeForAutoSearch() {
  try {
    chrome.storage.local.get(['autoSearchEnabled'], (d) => {
      if (!chrome.power) return;
      if (d.autoSearchEnabled !== false) {
        try { chrome.power.requestKeepAwake('system'); } catch(e) {}
        // SWが停止してもalarmで定期的に起こしてkeepAwakeを再設定
        chrome.alarms.create('keep-awake', { periodInMinutes: 1 });
      } else {
        try { chrome.power.releaseKeepAwake(); } catch(e) {}
        chrome.alarms.clear('keep-awake');
      }
    });
  } catch(e) {}
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'autoSearchEnabled' in changes) __applyKeepAwakeForAutoSearch();
});
// SW起動時(ブラウザ起動/SW再起動)にも状態を反映
__applyKeepAwakeForAutoSearch();
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(__applyKeepAwakeForAutoSearch);

// --- スリープ復帰時に自動検索を再開 ---
chrome.idle.setDetectionInterval(60); // 60秒操作なしでidle判定
chrome.idle.onStateChanged.addListener((state) => {
  if (state === 'active') {
    // locked/idle → active に戻った = スリープ復帰
    // 既存アラームが残っていればそのまま、失効していれば再セット
    chrome.storage.local.get(['autoSearchEnabled', 'searchIntervalMinutes'], (data) => {
      if (data.autoSearchEnabled === false) return;
      chrome.alarms.get('reins-search', (alarm) => {
        if (alarm) {
          const remainMin = ((alarm.scheduledTime - Date.now()) / 60000).toFixed(1);
          console.log(`[system] スリープ復帰検知 → 既存アラームあり（残り${remainMin}分）、再セットスキップ`);
          setStorageData({ debugLog: `[system] スリープ復帰検知 → 既存アラームあり（残り${remainMin}分）、再セットスキップ` });
        } else {
          console.log('[system] スリープ復帰検知 → アラーム失効、再セット');
          setStorageData({ debugLog: '[system] スリープ復帰検知 → アラーム失効、再セット' });
          setupAlarm(data.searchIntervalMinutes || 30);
        }
      });
    });
  }
});

// --- 初期化 ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['searchIntervalMinutes'], (data) => {
    setupAlarm(data.searchIntervalMinutes || 30);
  });
  chrome.storage.local.set({ isSearching: false });
  __applyKeepAwakeForAutoSearch();
  chrome.storage.local.get(['stats'], (data) => {
    if (!data.stats) {
      chrome.storage.local.set({
        stats: { totalFound: 0, totalSubmitted: 0, errors: [], lastError: null }
      });
    }
  });
  // SUUMO入稿: backup poll（スマホ承認など拡張トリガーを受け取れなかった分の取りこぼし対策）
  // 基本は承認ページからの即時トリガー(SUUMO_APPROVED_NOW)で起動するので、60分に1回で十分
  chrome.alarms.create('suumo-queue-poll', { delayInMinutes: 60 });
});

// Chrome起動時: 前回起動中に承認された取りこぼしを1回だけ処理
chrome.runtime.onStartup.addListener(() => {
  console.log('[SUUMO入稿] Chrome起動 → backup poll実行');
  setTimeout(() => {
    pollAndStartFillIfNeeded({ source: 'startup' }).catch(err => {
      console.log(`[SUUMO入稿] onStartup poll失敗: ${err.message}`);
    });
  }, 5000); // ネットワーク初期化待ち
  // backup pollアラーム再セット
  chrome.alarms.create('suumo-queue-poll', { delayInMinutes: 60 });
});

// 入稿専用タブのクローズ検知 → suumoFillTabIdをクリア
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get(['suumoFillTabId'], (data) => {
    if (data.suumoFillTabId === tabId) {
      console.log(`[SUUMO入稿] 入稿タブ(${tabId})がクローズされた → suumoFillTabIdクリア`);
      chrome.storage.local.remove(['suumoFillTabId', 'suumoFillQueue']);
    }
  });
});

// 入稿タブがforrent.jp外に遷移したら入稿タブ扱いを解除
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  chrome.storage.local.get(['suumoFillTabId'], (data) => {
    if (data.suumoFillTabId !== tabId) return;
    if (!changeInfo.url.includes('fn.forrent.jp')) {
      console.log(`[SUUMO入稿] 入稿タブ(${tabId})がforrent外に遷移 → suumoFillTabIdクリア`);
      chrome.storage.local.remove(['suumoFillTabId', 'suumoFillQueue']);
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
  // 1分ごとにkeepAwakeを再設定（SW停止による解除を防ぐ）
  if (alarm.name === 'keep-awake') {
    try { if (chrome.power) chrome.power.requestKeepAwake('system'); } catch(e) {}
    return;
  }
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

  // ── SUUMO巡回アラーム ──
  if (alarm.name === 'suumo-patrol') {
    chrome.storage.local.get(['suumoPatrolEnabled', 'businessStartHour', 'businessEndHour'], (data) => {
      const startH = data.businessStartHour !== undefined ? data.businessStartHour : 10;
      const endH = data.businessEndHour !== undefined ? data.businessEndHour : 20;
      const hour = new Date().getHours();
      const inBusiness = hour >= startH && hour < endH;

      if (data.suumoPatrolEnabled !== true) {
        console.log('[SUUMO巡回] 無効のためスキップ');
      } else if (!inBusiness) {
        console.log(`[SUUMO巡回] 営業時間外 (${hour}時) のためスキップ`);
      } else {
        runSuumoPatrolCycle();
      }
      // 次回SUUMO巡回アラームをセット（60分間隔固定）
      chrome.alarms.create('suumo-patrol', { delayInMinutes: 60 });
    });
  }

  // ── SUUMO入稿キュー backup poll（60分に1回・取りこぼし対策） ──
  // 通常は承認ページからの即時トリガー(SUUMO_APPROVED_NOW)で起動する
  // スマホ承認時などPCに即時通知が届かなかった分をここで拾う
  if (alarm.name === 'suumo-queue-poll') {
    pollAndStartFillIfNeeded({ source: 'backup' }).catch(err => {
      console.log(`[SUUMO入稿] backup poll失敗: ${err.message}`);
    });
    chrome.alarms.create('suumo-queue-poll', { delayInMinutes: 60 });
  }

  // ── ForRent時間外に承認された物件の遅延入稿 ──
  if (alarm.name === 'suumo-fill-scheduled') {
    console.log('[SUUMO入稿] スケジュール起動: ForRent利用時間到来');
    setStorageData({ debugLog: '[SUUMO入稿] ForRent利用時間到来 → 入稿開始' });
    pollAndStartFillIfNeeded({ source: 'scheduled' }).catch(err => {
      console.log(`[SUUMO入稿] スケジュール起動失敗: ${err.message}`);
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

  // ── SUUMO巡回関連メッセージ ──
  if (msg.type === 'SUUMO_PATROL_NOW') {
    runSuumoPatrolCycle();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'SUUMO_PATROL_TOGGLE') {
    chrome.storage.local.set({ suumoPatrolEnabled: msg.enabled }, () => {
      if (msg.enabled) {
        chrome.alarms.create('suumo-patrol', { delayInMinutes: 1 }); // すぐ開始
      } else {
        chrome.alarms.clear('suumo-patrol');
        // 実行中の巡回サイクルを中断（キューポーリングは止めない）
        currentSearchId++;
        _suumoPatrolRunning = false;
        setStorageData({ debugLog: '[SUUMO巡回] 停止しました' });
      }
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'SUUMO_QUEUE_POLL_NOW') {
    // content scriptからのキュー再取得依頼
    // 送信元タブは既に入稿タブなので、新タブは作らずGASからキュー取得→追記のみ行う
    (async () => {
      try {
        // 送信元タブを入稿タブとして登録（タブID不一致によるタブ二重作成を防止）
        if (sender.tab?.id) {
          await setStorageData({ suumoFillTabId: sender.tab.id });
        }
        const { available } = checkForrentAvailability();
        if (!available) {
          sendResponse({ ok: false, reason: '時間外' });
          return;
        }
        // Phase 4: 承認→ForRentボタン経由ルートでも必ず前処理(データ更新+停止)を実行。
        // 複数のSUUMO_QUEUE_POLL_NOWが並列で来た場合、同時に複数preHookが走ったり、
        // 片方がskipして先にキュー取得に進んで入稿開始してしまうレースを防ぐため、
        // ミューテックスで直列化する(前処理完了まで全呼び出しが待つ)。
        const preHookResult = await getOrRunSuumoPreHook_();
        if (!preHookResult.ok) {
          await setStorageData({ debugLog: `[SUUMO入稿] QUEUE_POLL経路の前処理失敗: ${preHookResult.error}` });
          sendResponse({ ok: false, error: '前処理失敗: ' + preHookResult.error });
          return;
        }
        const queueData = await pollSuumoApprovalQueue({ lock: true });
        if (queueData && queueData.queue && queueData.queue.length > 0) {
          const added = await appendFillQueue(queueData.queue);
          await setStorageData({
            suumoActiveListingCount: queueData.activeListingCount,
            suumoStopCandidate: queueData.stopCandidate
          });
          console.log(`[SUUMO入稿] QUEUE_POLL_NOW: ${added}件をキューに追加`);
          sendResponse({ ok: true, added });
        } else {
          console.log('[SUUMO入稿] QUEUE_POLL_NOW: GASからの取得結果は0件');
          sendResponse({ ok: true, added: 0 });
        }
      } catch (err) {
        console.error('[SUUMO入稿] QUEUE_POLL_NOW失敗:', err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  // GAS承認ページの承認ボタン押下時、suumo-approval-trigger.jsが送信
  // → 新規タブで入稿プロセスを即時起動、または稼働中タブのキューに追記
  if (msg.type === 'SUUMO_APPROVED_NOW') {
    console.log(`[SUUMO入稿] 承認トリガー受信: key=${msg.propertyKey}, ${msg.building} ${msg.room}`);
    setStorageData({ debugLog: `[SUUMO入稿] 承認検知(${msg.building || msg.propertyKey}) → 入稿開始` });
    pollAndStartFillIfNeeded({ source: 'approval' }).then(() => {
      sendResponse({ ok: true, started: true });
    }).catch(err => {
      console.error('[SUUMO入稿] 承認トリガー処理失敗:', err);
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }
  // content script (suumo-fill-auto.js) からの「このタブは入稿用？」問い合わせ
  // タブIDが suumoFillTabId と一致する場合のみ true を返す
  // これにより、手動で開いたForRentタブでは絶対にキュー監視が走らない
  if (msg.type === 'AM_I_FILL_TAB') {
    const tabId = sender.tab?.id;
    chrome.storage.local.get(['suumoFillTabId'], (data) => {
      const isFillTab = (typeof tabId === 'number') && data.suumoFillTabId === tabId;
      sendResponse({ isFillTab: !!isFillTab, tabId: tabId, fillTabId: data.suumoFillTabId });
    });
    return true;
  }
  // 入稿タブからの「次の物件ちょうだい」要求（race condition防止のため atomic に pop）
  // content scriptが storage.local を直接書き換えないことで、background側からの追記と競合しない
  if (msg.type === 'POP_FILL_QUEUE_HEAD') {
    const tabId = sender.tab?.id;
    chrome.storage.local.get(['suumoFillTabId'], async (data) => {
      if (typeof tabId !== 'number' || data.suumoFillTabId !== tabId) {
        sendResponse({ ok: false, error: 'not fill tab' });
        return;
      }
      try {
        const head = await popFillQueueHead();
        sendResponse({ ok: true, item: head });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    });
    return true;
  }
  if (msg.type === 'SUUMO_FILL_RELAY') {
    // トップフレームからiframe内のcontent scriptへメッセージをリレー
    // 送信元タブの全フレームに SUUMO_FILL_START を送信
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'SUUMO_FILL_START',
        data: msg.data,
        imageGenres: msg.imageGenres
      }, { frameId: 0 }).catch(() => {});
      // iframe（frameId > 0）にも送信
      chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
        if (!frames) return;
        for (const frame of frames) {
          if (frame.frameId === 0) continue;
          chrome.tabs.sendMessage(tabId, {
            type: 'SUUMO_FILL_START',
            data: msg.data,
            imageGenres: msg.imageGenres
          }, { frameId: frame.frameId }).catch(() => {});
        }
      });
      sendResponse({ ok: true, relayed: true });
    } else {
      sendResponse({ ok: false, error: 'タブIDが取得できません' });
    }
    return true;
  }
  if (msg.type === 'FETCH_IMAGE_AS_BASE64') {
    // content script（ForRentページ）から画像URLを受け取り、base64で返す
    // background service workerはhost_permissionsの全ドメインにfetchできる
    (async () => {
      try {
        const response = await fetch(msg.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const reader = new FileReader();
        const dataUrl = await new Promise((resolve, reject) => {
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        sendResponse({ ok: true, dataUrl });
      } catch (err) {
        console.error('[FETCH_IMAGE_AS_BASE64] 失敗:', msg.url, err.message);
        // ログ画面にも記録(入稿タブのconsoleに出るwarnは普段見えないため)
        try {
          await setStorageData({ debugLog: `[画像fetch失敗] ${String(msg.url).substring(0, 100)} - ${err.message}` });
        } catch (_) {}
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  if (msg.type === 'SUUMO_FILL_COMPLETE') {
    // suumo-fill-auto.jsからの入稿完了報告
    reportSuumoPostComplete(msg.data).then(result => {
      // 入稿完了したら suumoFillMode フラグをクリア(以降の誤起動防止)
      try { chrome.storage.local.remove(['suumoFillMode', 'suumoFillModeSetAt']); } catch (_) {}
      sendResponse(result);
    }).catch(err => {
      sendResponse({ success: false, message: err.message });
    });
    return true;
  }
  // ── Phase 5: 確認画面到達通知 → 事前チェック+登録ボタン自動クリック ──
  if (msg.type === 'SUUMO_CONFIRM_REACHED') {
    (async () => {
      try {
        const tabId = sender.tab && sender.tab.id;
        if (!tabId) {
          sendResponse({ ok: false, error: 'tabId不明' });
          return;
        }
        const result = await tryForrentFinalSubmit({
          tabId,
          imageGenresCount: msg.imageGenresCount || 0,
          imageUploadStats: msg.imageUploadStats || {},
        });
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  // ── SUUMOビジネス Daily Search 手動取得(Phase 1) ──
  // options.html の「SUUMOビジネス データ取得」ボタンから送信される
  if (msg.type === 'SUUMO_BUSINESS_FETCH_NOW') {
    (async () => {
      try {
        const result = await runSuumoBusinessFetch();
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  // ── ForRent状態同期(PUB1R2801直読み) ──
  if (msg.type === 'SUUMO_FORRENT_STATUS_SYNC') {
    (async () => {
      try {
        const result = await syncForrentListingStatus();
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  // ── ForRent停止テスト実行(Phase 3) ──
  // options.html の「ForRent停止テスト実行」ボタンから送信される
  if (msg.type === 'FORRENT_STOP_TEST') {
    (async () => {
      try {
        const result = await stopForrentListing({
          suumoPropertyCode: msg.suumoPropertyCode,
          dryRun: msg.dryRun, // 未指定ならストレージから判定
        });
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
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
globalThis.runSearchCycle = async function runSearchCycle() {
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
  // DiscordスレッドIDは永続化のためクリアしない（同じスレッドを再利用）
  // 物件通し番号はサイクルごとにリセット
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

  // 検索中はスリープを抑制(画面はオフ可・システムスリープのみ防止)
  try { chrome.power && chrome.power.requestKeepAwake && chrome.power.requestKeepAwake('system'); } catch(e) {}

  try {
    // 検索条件を取得（毎回GASから最新を取得）
    await setStorageData({ debugLog: '検索条件を取得中...' });
    try {
      await refreshCriteria();
    } catch (err) {
      await setStorageData({ debugLog: `検索条件取得失敗: ${err.message}` });
      return;
    }
    const { customerCriteria: allCriteria, excludedCustomers } = await getStorageData(['customerCriteria', 'excludedCustomers']);
    if (!allCriteria || allCriteria.length === 0) {
      await setStorageData({ debugLog: '検索条件がありません（GASに条件が登録されていない可能性）' });
      return;
    }
    // 除外リストに入っている顧客をスキップ（新規顧客は自動で検索対象）
    const excluded = excludedCustomers || [];
    const criteria = excluded.length > 0
      ? allCriteria.filter(c => !excluded.includes(c.name))
      : allCriteria;
    if (criteria.length === 0) {
      await setStorageData({ debugLog: '選択された顧客がありません' });
      return;
    }
    const skipped = allCriteria.length - criteria.length;
    const skippedMsg = skipped > 0 ? `（${skipped}件スキップ）` : '';
    await setStorageData({ debugLog: `検索条件 ${criteria.length}件取得完了${skippedMsg}` });

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

      // --- いえらぶ ---
      if (services.ielove) {
        if (isSearchCancelled(searchId)) return;
        try { await runIeloveSearch([customer], seenIds, searchId); }
        catch (err) { if (err.message === 'SEARCH_CANCELLED') return; logError('[いえらぶ] 検索エラー: ' + err.message); }
      }

      // --- REINS（他サイトで申込あり検出後に判定するため最後に実行） ---
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
                  _originalCustomer: customer,
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

      // --- 一括モード: この顧客分だけ重複排除＆通知 ---
      if (notifyMode === 'batch') {
        try { await flushBatchBufferForCustomer(customer.name); }
        catch (err) { logError(`[system] ${customer.name}: 一括通知エラー: ${err.message}`); }
      }

      // 物件が見つからなかった顧客は _noResultCustomers に貯めて、
      // 巡回サイクル全体の終了時に1通のまとめ通知として送る（顧客ごと個別通知が煩わしいため）
      if (!discordPropertyCounters[customer.name] || discordPropertyCounters[customer.name] === 0) {
        try {
          if (!globalThis._noResultCustomers) globalThis._noResultCustomers = [];
          globalThis._noResultCustomers.push({ name: customer.name });
        } catch (err) {
          logError(`[system] ${customer.name}: 新着なし蓄積エラー: ${err.message}`);
        }
      }

      if (ci < criteria.length - 1) await sleep(3000);
    }

    if (services.reins && reinsTab) {
      await closeDedicatedWindow();
      await setStorageData({ debugLog: '[REINS] 検索完了', reinsAutomationTabId: null });
    }

    // === 未解決駅サマリー ===
    await reportUnresolvedStations();

    // === 新着なし顧客のまとめ通知（1通にまとめてメインチャンネルに投稿） ===
    try {
      await sendDiscordNoResultSummary();
    } catch (err) {
      logError('新着なしまとめ通知エラー: ' + err.message);
    }

    await setStorageData({ lastSearchTime: Date.now() });
  } catch (err) {
    logError('検索サイクルエラー: ' + err.message);
  } finally {
    clearInterval(globalKeepAlive);
    try { chrome.power && chrome.power.releaseKeepAwake && chrome.power.releaseKeepAwake(); } catch(e) {}
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

  // スキップ済み物件IDをロード（詳細ページ遷移を省略して高速化）
  const skipStorageKey = `reinsSkipped_${customer.name}`;
  const skipHashKey = `reinsSkipHash_${customer.name}`;
  const skipData = await getStorageData([skipStorageKey, skipHashKey]);
  const skippedMap = skipData[skipStorageKey] || {}; // { propertyNumber: { reason, ts } }

  // 条件別ハッシュで、変わった条件に関連するスキップのみリセット
  // ※ バッチ分割時は routes_with_stations/cities がサブセットになるため、
  //   元の全条件（_originalCustomer）をハッシュ対象にする
  const simpleHash = (s) => s.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0).toString(36);
  const prevHashes = skipData[skipHashKey] || {};
  const origCustomer = customer._originalCustomer || customer;
  const currentHashes = {
    structures: simpleHash(JSON.stringify(origCustomer.structures || [])),
    stations: simpleHash(JSON.stringify({ s: origCustomer.stations, r: origCustomer.routes_with_stations, w: origCustomer.walk })),
    layouts: simpleHash(JSON.stringify(origCustomer.layouts || [])),
    equipment: simpleHash(JSON.stringify(origCustomer.equipment || '')),
    building_age: simpleHash(JSON.stringify(origCustomer.building_age || '')),
  };
  const conditionToReasonPattern = {
    structures: /構造不一致|構造不明/,
    stations: /駅不一致|駅\/徒歩不一致|交通情報なし/,
    layouts: /間取り不一致/,
    equipment: /敷金|礼金|定期借家|ロフト/,
    building_age: /新築でない/,
  };
  for (const [category, hash] of Object.entries(currentHashes)) {
    if (prevHashes[category] && prevHashes[category] !== hash) {
      const pattern = conditionToReasonPattern[category];
      if (pattern) {
        for (const key of Object.keys(skippedMap)) {
          if (pattern.test(skippedMap[key].reason)) delete skippedMap[key];
        }
      }
    }
  }
  await setStorageData({ [skipHashKey]: currentHashes });
  let skippedMapDirty = false;

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
  // MutationObserverでフォーム描画完了を即座に検知（最大30秒）
  const formReady = await waitForDomReady(tabId, '.p-textbox-input', { timeout: 30000 });
  if (isSearchCancelled(searchId)) return;
  if (!formReady.found) {
    await setStorageData({ debugLog: `${customer.name}: 検索フォームが見つかりません` });
    return;
  }

  // --- Step 2: 条件セット（executeScript world:'MAIN'で直接実行） ---
  // ※ scriptタグ注入はCSPでブロックされるため、world:'MAIN'を使う
  const lineNameMap = await loadLineNameMap();
  const reinsCodeMap = await loadReinsCodeMap();
  const stationStr = buildStationString(customer);

  await setStorageData({ debugLog: `${customer.name}: stationStr="${stationStr}", rent_max=${customer.rent_max}` });

  // .p-textbox-input が描画されるまで待つ（最大15秒）
  let setResult;
  await waitForDomReady(tabId, '.p-textbox-input', { timeout: 15000 });

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

          // 丸ノ内線方南町支線の分岐対応: 本線駅と支線駅を分離
          if (lineName === '東京メトロ丸ノ内線' && colonIdx >= 0) {
            const honanBranchStations = new Set(['中野新橋', '中野富士見町', '方南町']);
            const stns = parts[i].substring(colonIdx + 1).split(',').map(s => s.trim()).filter(s => s);
            const mainStns = stns.filter(s => !honanBranchStations.has(s));
            const branchStns = stns.filter(s => honanBranchStations.has(s));
            if (branchStns.length > 0 && mainStns.length > 0) {
              // 混在: 現在のパートを本線駅のみに書き換え、支線を新パートとして追加
              parts[i] = lineName + '：' + mainStns.join(',');
              parts.splice(i + 1, 0, lineName + '（方南支線）：' + branchStns.join(','));
              // reinsLineNameは本線のまま（丸ノ内線）
            } else if (branchStns.length > 0 && mainStns.length === 0) {
              // 全駅が支線 → 丸ノ内方南に切り替え
              reinsLineName = '丸ノ内方南';
            }
            // 全駅が本線の場合はそのまま
          }

          // 丸ノ内線方南支線パート（上記spliceで追加されたもの）の処理
          if (lineName === '東京メトロ丸ノ内線（方南支線）') {
            reinsLineName = '丸ノ内方南';
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
  await csleep(500);

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
  // まずMutationObserverで結果ページまたはダイアログの出現を待つ
  let step4Done = false;
  for (let d = 0; d < 60; d++) {
    if (isSearchCancelled(searchId)) return;
    await csleep(1000);
    try {
      // DOM内容で結果ページ/ダイアログを検出
      const pageCheck = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
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
        step4Done = true;
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
        // MutationObserverで結果ページ表示を待つ
        const okReady = await waitForDomReady(tabId, null, { textIncludes: '検索結果一覧', timeout: 40000 });
        step4Done = true;
        break;
      }
    } catch (err) {
      await setStorageData({ debugLog: `${customer.name}: ダイアログ${d+1}エラー: ${err.message}` });
    }
  }

  // --- Step 5: 検索結果のDOM描画待ち ---
  await setStorageData({ debugLog: `${customer.name}: 検索結果待ち...` });

  // DOM内容で結果ページか確認（URLはSPAのため信頼しない）
  if (!step4Done) {
    const resultCheck = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.body.textContent.includes('検索結果一覧')
    });
    if (!resultCheck?.[0]?.result) {
      await setStorageData({ debugLog: `${customer.name}: 結果ページに遷移していません` });
      return;
    }
  }

  // MutationObserverで検索結果の描画完了を待つ（行の出現 or 0件表示、最大30秒）
  let resultsReady = false;
  try {
    const rowsResult = await chrome.scripting.executeScript({
      target: { tabId },
      args: [30000],
      func: (timeoutMs) => {
        return new Promise((resolve) => {
          const check = () => {
            // 検索結果行が存在する → データあり
            if (document.querySelectorAll('.p-table-body-row').length > 0) return { type: 'rows' };
            // 結果ページだが行もチェックボックスもない → 0件
            const bodyText = document.body?.textContent || '';
            if (bodyText.includes('検索結果') && bodyText.length > 200
                && document.querySelectorAll('input[type="checkbox"]').length === 0
                && document.querySelectorAll('.p-table-body-row').length === 0) {
              // ページネーションリンクもない場合のみ0件と判定（描画途中を誤検知しない）
              if (document.querySelectorAll('.page-link').length === 0) return { type: 'zero' };
            }
            return null;
          };
          const result = check();
          if (result) { resolve(result); return; }
          const timer = setTimeout(() => { observer.disconnect(); resolve({ type: 'timeout' }); }, timeoutMs);
          const observer = new MutationObserver(() => {
            const result = check();
            if (result) {
              observer.disconnect();
              clearTimeout(timer);
              resolve(result);
            }
          });
          observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
        });
      }
    });
    const r = rowsResult?.[0]?.result || { type: 'timeout' };
    if (r.type === 'rows') {
      resultsReady = true;
    } else if (r.type === 'zero') {
      await setStorageData({ debugLog: `${customer.name}: 検索結果0件` });
      return;
    }
  } catch (_) {}
  if (isSearchCancelled(searchId)) return;

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

    // スキップ済み物件チェック（前回フィルタで除外された物件は詳細ページに行かない）
    if (!isTest && skippedMap[result.propertyNumber]) {
      continue; // スキップ済みはログなし（大量になるため）
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
      for (let waitTry = 0; waitTry < 30; waitTry++) {
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
        if (clickStatus === 'dialog_closed') { await csleep(500); continue; }
        // no_rows の最初の検出で詳細な状態をダンプ
        if (clickStatus === 'no_rows' && waitTry === 1) {
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
        if (clickStatus === 'no_rows' && waitTry >= 6 && !triedRecovery) {
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
          // 2) 入力欄が描画されるまで待つ（MutationObserver）
          await waitForDomReady(tabId, '.p-textbox-input', { timeout: 30000 });
          // 3) 同じ条件設定関数を再実行
          await chrome.scripting.executeScript({
            target: { tabId }, world: 'MAIN',
            func: __setCriteriaFunc, args: __criteriaArgs
          });
          await csleep(500);
          // 4) 検索ボタンクリック
          await chrome.scripting.executeScript({
            target: { tabId }, world: 'MAIN',
            func: () => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '検索'); if (b) b.click(); }
          });
          // 5) ダイアログ処理＆結果ページ待ち
          for (let rs = 0; rs < 50; rs++) {
            await csleep(1000);
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
            if (s === 'ok') {
              // 結果行の出現をMutationObserverで待つ
              await waitForDomReady(tabId, '.p-table-body-row', { timeout: 30000 });
              break;
            }
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
              await waitForDomReady(tabId, '.p-table-body-row', { timeout: 15000 });
            }
          }
          continue;
        }
        await csleep(500);
      }
      if (clickStatus !== 'clicked') {
        await setStorageData({ debugLog: `${customer.name}: ✗ ${result.buildingName} ${result.floor} 詳細ボタンが見つからない(${clickStatus})→スキップ` });
        continue;
      }
      // SPA遷移: 詳細ページのラベル要素出現で描画完了を検知
      await waitForDomReady(tabId, '.p-label-title', { timeout: 15000, minCount: 5 });

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

      // 詳細ページのVueコンポーネントがマウントされるまで待つ（MutationObserver、最大15秒）
      // 会員情報・広告転載区分など遅延描画セクションを含めるため minCount を増やす
      await waitForDomReady(tabId, '.p-label-title', { timeout: 15000, minCount: 20 });

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
            // レスポンシブ重複(d-sm-none + d-none d-sm-inline 併存)を除外するテキスト取得
            const extractText = (el) => {
              if (!el) return '';
              const clone = el.cloneNode(true);
              clone.querySelectorAll('.d-sm-none').forEach(n => n.remove());
              const text = clone.textContent.trim();
              return text || el.textContent.trim();
            };
            // 値は内側の .row 直下の div（class="col" のことも "col-2" のこともある）
            const innerRow = container.querySelector(':scope > .row');
            if (innerRow) {
              const valEl = innerRow.querySelector(':scope > [class^="col"], :scope > [class*=" col"]');
              if (valEl) return extractText(valEl);
            }
            return extractText(container.querySelector('.row .col'));
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

          // 交通情報（交通1〜3）を抽出
          const __transports = (() => {
            const list = [];
            const allLabels = [...document.querySelectorAll('.p-label-title')];
            const lineLabels = allLabels.filter(e => e.textContent.trim() === '沿線名');
            const stationLabels = allLabels.filter(e => e.textContent.trim() === '駅名');
            const walkLabels = allLabels.filter(e => {
              const t = e.textContent.trim();
              return t === '駅より徒歩' || t === '駅から徒歩' || t === '徒歩';
            });
            const getValFromLabel = (el) => {
              if (!el) return '';
              const container = el.closest('.p-label')?.parentElement;
              if (!container) return '';
              const innerRow = container.querySelector(':scope > .row');
              if (innerRow) {
                const valEl = innerRow.querySelector(':scope > [class^="col"], :scope > [class*=" col"]');
                if (valEl) return valEl.textContent.trim();
              }
              return container.querySelector('.row .col')?.textContent.trim() || '';
            };
            const normalizeWalk = (raw) => {
              if (!raw) return '';
              const s = String(raw).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
              const m = s.match(/(\d+)/);
              if (!m) return '';
              return `徒歩${m[1]}分`;
            };
            const count = Math.max(lineLabels.length, stationLabels.length, walkLabels.length);
            for (let t = 0; t < count; t++) {
              const line = getValFromLabel(lineLabels[t]);
              const station = getValFromLabel(stationLabels[t]);
              const walk = normalizeWalk(getValFromLabel(walkLabels[t]));
              if (line || station) {
                let info = [line, station].filter(Boolean).join(' ');
                if (walk) info += ' ' + walk;
                list.push(info);
              }
            }
            if (list.length === 0) {
              const fallbackWalk = normalizeWalk(getVal('駅から徒歩') || getVal('駅より徒歩') || getVal('徒歩'));
              const base = [getVal('沿線名'), getVal('駅名')].filter(Boolean).join(' ');
              const single = base + (fallbackWalk ? ' ' + fallbackWalk : '');
              if (single.trim()) list.push(single);
            }
            return list;
          })();

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
            station_info: __transports[0] || '',
            other_stations: __transports.slice(1),
            room_number: roomNumber || '',
            room_attr: roomAttr || '',
            deposit: getVal('敷金') || '',
            key_money: getVal('礼金') || '',
            facilities: getVal('設備・条件・住宅性能等') || '',
            sunlight: getVal('バルコニー方向') || '',
            lease_type: getVal('建物賃貸借区分') || '',
            // 契約期間: 「契約期間」ラベル優先。無ければ「建物賃貸借期間」(定期借家の場合こちら)
            contract_period: getVal('契約期間') || getVal('建物賃貸借期間') || '',
            // 広告転載区分: 「広告可」→'可'、「不可」→'不可'、「広告可（但し要連絡）」→'要連絡'
            ad_keisai: (() => {
              const adReprint = getVal('広告転載区分') || '';
              if (!adReprint) return '';
              if (adReprint === '広告可') return '可';
              if (adReprint === '不可') return '不可';
              if (adReprint.includes('要連絡')) return '要連絡';
              return adReprint;
            })(),
            ad_reprint_raw: getVal('広告転載区分') || '',
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
            // 代表電話番号(会員情報セクション)優先、無ければ旧「電話番号」ラベル
            reins_tel: getVal('代表電話番号') || getVal('電話番号') || '',
            // SUUMO承認画面/Discord通知で使う元付フィールド（reins_shougo/telのエイリアス）
            owner_company: getVal('商号') || '',
            owner_phone: getVal('代表電話番号') || getVal('電話番号') || '',
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

      const detail = detailResults && detailResults[0] && detailResults[0].result;
      if (detail) {
        // room_idをハッシュ化（propertyNumberベース・顧客向けURLでソース非表示）
        detail._raw_room_id = detail.room_id;
        detail.room_id = await hashRoomId('reins', 'reins_' + (detail.reins_property_number || ''));
      }
      // フィルタ先行判定: スキップする物件では画像取得を行わない
      let __rejectReason = null;
      if (detail) {
        __rejectReason = getFilterRejectReason(detail, customer);
      }

      // SUUMO巡回モード: 画像base64取得前にSUUMO競合数をチェック
      // (REINSの画像取得は fetch + blob→base64 変換で重いため効果大)
      if (detail && !__rejectReason &&
          globalThis._suumoPatrolMode &&
          typeof globalThis.checkSuumoCompetitorPreSkip === 'function') {
        try {
          const preResult = await globalThis.checkSuumoCompetitorPreSkip(detail);
          if (preResult.competitor) {
            detail.suumo_competitor = preResult.competitor;
          }
          if (preResult.skip) {
            __rejectReason = `${preResult.reason}(画像取得前に判定)`;
            await setStorageData({ debugLog: `${customer.name}: ✗ スキップ: ${detail.building_name || ''} ${detail.room_number || ''} - ${__rejectReason}` });
          }
        } catch (e) {
          console.warn('[REINS] 競合先行判定エラー:', e && e.message);
        }
      }

      // === 画像をbase64で抽出（$nuxt walk → bkknGzuList 直読み方式） ===
      // フィルタでスキップされる物件は画像取得スキップ
      let imageBase64s = [];
      if (detail && !__rejectReason) {
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
        imageBase64s = Array.isArray(imgResult) ? imgResult : (imgResult.images || []);
        await setStorageData({ debugLog: `${customer.name}: REINS画像 base64取得=${imageBase64s.length}件` });
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
          const BATCH = 6;
          for (let i = 0; i < imageBase64s.length; i += BATCH) {
            const chunk = imageBase64s.slice(i, i + BATCH);
            const results = await Promise.all(chunk.map(uploadOne));
            for (const r of results) {
              if (r) uploadedUrls.push(r);
              else uploadFailed++;
            }
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
        const rejectReason = __rejectReason;
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
          // スキップ済みとして記録（次回以降、詳細ページ遷移を省略）
          if (detail.reins_property_number) {
            skippedMap[detail.reins_property_number] = { reason: rejectReason, ts: Date.now() };
            skippedMapDirty = true;
          }
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
      for (let bw = 0; bw < 20; bw++) {
        await csleep(500);
        const bt = await chrome.tabs.get(tabId);
        await setStorageData({ debugLog: `${customer.name}: 戻り待機 ${bw+1}/10 url=${(bt.url||'').slice(-40)}` });
        // 3秒（6回）以降でまだ詳細ページなら強制的に戻る操作を再度打つ
        if (bw >= 6 && bt.url?.includes('GBK003200')) {
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
          // rows=0 が12回（6秒）続いたら検索フォームに戻して再検索で強制リフレッシュ
          if (bw >= 12) {
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
          for (let rs = 0; rs < 60; rs++) {
            await csleep(1000);
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
                await waitForDomReady(tabId, '.p-table-body-row', { timeout: 30000 });
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
                await waitForDomReady(tabId, '.p-table-body-row', { timeout: 15000 });
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
          await csleep(1500);
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
            for (let rs = 0; rs < 60; rs++) {
              await csleep(1000);
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
                reOk = true;
                if (s === 'ok_clicked') await waitForDomReady(tabId, '.p-table-body-row', { timeout: 30000 });
                break;
              }
            }
            if (reOk) {
              if (currentPage > 1) {
                for (let navP = 2; navP <= currentPage; navP++) {
                  await chrome.scripting.executeScript({ target: { tabId }, func: (page) => { const links = document.querySelectorAll('.page-link'); for (const l of links) { if (l.textContent.trim() === String(page)) { l.click(); return; } } }, args: [navP] });
                  await waitForDomReady(tabId, '.p-table-body-row', { timeout: 15000 });
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
        for (let bw = 0; bw < 20; bw++) {
          await csleep(500);
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
            for (let rs = 0; rs < 60; rs++) {
              await csleep(1000);
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
                if (s === 'ok_clicked') await waitForDomReady(tabId, '.p-table-body-row', { timeout: 30000 });
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
                await waitForDomReady(tabId, '.p-table-body-row', { timeout: 15000 });
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
        // SPA遷移: MutationObserverで行の再描画を待つ
        await waitForDomReady(tabId, '.p-table-body-row', { timeout: 30000 });
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

  // スキップ済み物件マップを保存（変更があった場合のみ）
  if (skippedMapDirty) {
    await setStorageData({ [skipStorageKey]: skippedMap });
  }

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

  // 専用ウィンドウを作成（最小化状態）してREINSを開く
  // クッキー共有でログイン済みセッションを引き継ぐ
  // 最小化ウィンドウでも content script とページロードは正常動作する
  await setStorageData({ debugLog: '専用REINSウィンドウを作成中...' });
  const newWindow = await chrome.windows.create({
    url: 'https://system.reins.jp/main/BK/GBK001310',
    focused: false,
    type: 'normal',
    state: 'minimized'
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

// MutationObserver で指定セレクタ/条件の要素出現を即座に検知するヘルパー
// selector: CSSセレクタ文字列、またはDOM判定関数の文字列表現
// opts.textIncludes: body.textContent にこの文字列が含まれたら成功とみなす
// opts.timeout: タイムアウト(ms) デフォルト30000
// 戻り値: { found: true/false }
async function waitForDomReady(tabId, selector, opts = {}) {
  const timeout = opts.timeout || 30000;
  const textIncludes = opts.textIncludes || null;
  const minCount = opts.minCount || 1;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [selector, timeout, textIncludes, minCount],
      func: (sel, timeoutMs, textInc, minCnt) => {
        return new Promise((resolve) => {
          // 既に条件を満たしているか即チェック
          const check = () => {
            if (sel && document.querySelectorAll(sel).length >= minCnt) return true;
            if (textInc && document.body?.textContent?.includes(textInc)) return true;
            return false;
          };
          if (check()) { resolve({ found: true }); return; }
          const timer = setTimeout(() => { observer.disconnect(); resolve({ found: false }); }, timeoutMs);
          const observer = new MutationObserver(() => {
            if (check()) {
              observer.disconnect();
              clearTimeout(timer);
              resolve({ found: true });
            }
          });
          observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
        });
      }
    });
    return results?.[0]?.result || { found: false };
  } catch (e) {
    return { found: false, error: e.message };
  }
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

// 顧客ごとのDiscordスレッドID（chrome.storage.localに永続化）
let discordThreadIds = {};
// 起動時にストレージから復元
(async () => {
  try {
    const data = await getStorageData(['discordThreadIds']);
    if (data.discordThreadIds) discordThreadIds = data.discordThreadIds;
  } catch (e) { console.warn('discordThreadIds復元失敗:', e); }
})();
// 顧客ごとのDiscord物件通し番号（検索サイクル中に保持・リセットされる）
const discordPropertyCounters = {};

function buildSearchInfo(customer) {
  const lines = ['**検索条件**', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'];

  // 路線・駅
  const rws = customer.routes_with_stations || [];
  if (rws.length > 0) {
    const routeParts = rws.map(r => {
      return r.stations && r.stations.length > 0
        ? `${r.route}（${r.stations.join(', ')}）`
        : r.route;
    });
    lines.push(`路線: ${routeParts.join(' / ')}`);
  } else if (customer.stations && customer.stations.length > 0) {
    lines.push(`駅: ${customer.stations.join(', ')}`);
  }

  // エリア（市区町村・町名丁目）
  if (customer.selectedTowns && Object.keys(customer.selectedTowns).length > 0) {
    const parts = Object.entries(customer.selectedTowns).map(([city, towns]) =>
      towns && towns.length > 0 ? `${city}（${towns.join(', ')}）` : city
    );
    lines.push(`エリア: ${parts.join(' / ')}`);
  } else if (customer.cities && customer.cities.length > 0) {
    lines.push(`エリア: ${customer.cities.join(', ')}`);
  }

  // 賃料
  if (customer.rent_max) {
    lines.push(`賃料: 〜${customer.rent_max}万円`);
  }

  // 間取り
  if (customer.layouts && customer.layouts.length > 0) {
    lines.push(`間取り: ${customer.layouts.join(' / ')}`);
  }

  // 面積
  if (customer.area_min) {
    lines.push(`面積: ${customer.area_min}㎡〜`);
  }

  // 築年数
  if (customer.building_age) {
    lines.push(`築年: 築${String(customer.building_age).replace(/[^\d]/g, '')}年以内`);
  }

  // 構造
  if (customer.structures && customer.structures.length > 0) {
    lines.push(`構造: ${customer.structures.join(' / ')}`);
  }

  // 駅徒歩
  if (customer.walk) {
    const walkMin = String(customer.walk).replace(/[^\d]/g, '');
    if (walkMin) lines.push(`駅徒歩: ${walkMin}分以内`);
  }

  // 設備・条件
  if (customer.equipment) {
    const equipStr = typeof customer.equipment === 'string' ? customer.equipment : (customer.equipment || []).join(', ');
    if (equipStr) lines.push(`設備: ${equipStr}`);
  }

  // 検索URL（いえらぶ等）
  if (customer.search_url) {
    lines.push(`[検索結果を開く](${customer.search_url})`);
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
  // SUUMO巡回モードではDiscord通知をスキップ
  if (globalThis._suumoPatrolMode) return;

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
      // ストレージに永続化
      try { await setStorageData({ discordThreadIds }); } catch (e) {}

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

    // スレッドが生きているか確認（既存スレッドの場合、最初の投稿で404なら再作成）
    if (!discordPropertyCounters[customerName]) discordPropertyCounters[customerName] = 0;

    // この検索実行でこの顧客の最初の物件送信なら、先に検索条件を送信
    if (discordPropertyCounters[customerName] === 0 && customer) {
      const searchInfo = buildSearchInfo(customer);
      await discordPostWithRetry(`${discordWebhookUrl}?thread_id=${threadId}`, { content: searchInfo });
      await sleep(500);
    }

    for (let i = 0; i < properties.length; i++) {
      discordPropertyCounters[customerName]++;
      const msg = '<@1459814543600390341>\n' + buildDiscordMessage(properties[i], discordPropertyCounters[customerName], gasWebappUrl, customerName, customer);
      const postResp = await discordPostWithRetry(`${discordWebhookUrl}?thread_id=${threadId}`, { content: msg });
      // スレッドが期限切れ/削除された場合は再作成
      if (postResp && (postResp.status === 404 || postResp.status === 400)) {
        console.warn(`Discord スレッド無効 (${postResp.status})。${customerName}のスレッドを再作成...`);
        delete discordThreadIds[customerName];
        try { await setStorageData({ discordThreadIds }); } catch (e) {}
        // 再帰的に呼び直し（新スレッド作成される）
        const remaining = properties.slice(i);
        discordPropertyCounters[customerName] -= 1; // カウンタ戻す
        await sendDiscordNotification(customerName, remaining, customer);
        return;
      }
      if (i < properties.length - 1) await sleep(1000);
    }

    console.log(`Discord通知完了: ${customerName} ${properties.length}件`);

  } catch (err) {
    console.error(`Discord通知失敗: ${err.message}`);
  }
}

/**
 * 検索サイクル終了時、新着なしだった顧客を1通のメッセージにまとめて
 * メインチャンネル(スレッド外)に投稿する。顧客ごとの個別通知による通知ラッシュを
 * 避けるための関数。未解決駅があった顧客についてはその情報も併記する。
 */
async function sendDiscordNoResultSummary() {
  const list = (globalThis._noResultCustomers || []).slice();
  globalThis._noResultCustomers = []; // 次回サイクル用にクリア

  const { discordWebhookUrl } = await getConfig();
  if (!discordWebhookUrl) return;

  // 次回巡回予定時刻を取得（自動検索ON + アラームが立っている時のみ）
  let nextRunLine = '';
  try {
    const storage = await new Promise(r => chrome.storage.local.get(['autoSearchEnabled'], r));
    const autoEnabled = storage.autoSearchEnabled !== false; // デフォルトtrue
    if (autoEnabled) {
      const alarm = await new Promise(r => chrome.alarms.get('reins-search', r));
      if (alarm && alarm.scheduledTime) {
        const d = new Date(alarm.scheduledTime);
        const pad = n => String(n).padStart(2, '0');
        const nowDate = new Date();
        const sameDay = d.getFullYear() === nowDate.getFullYear()
          && d.getMonth() === nowDate.getMonth()
          && d.getDate() === nowDate.getDate();
        const prefix = sameDay ? '本日' : `${d.getMonth() + 1}/${d.getDate()}`;
        const diffMinTotal = Math.max(0, Math.round((alarm.scheduledTime - Date.now()) / 60000));
        const diffHour = Math.floor(diffMinTotal / 60);
        const diffMin = diffMinTotal % 60;
        let diffText;
        if (diffHour > 0 && diffMin > 0) diffText = `${diffHour}時間${diffMin}分後`;
        else if (diffHour > 0) diffText = `${diffHour}時間後`;
        else diffText = `${diffMin}分後`;
        nextRunLine = `🕐 次回巡回予定: ${prefix} ${pad(d.getHours())}:${pad(d.getMinutes())} (約${diffText})`;
      }
    }
  } catch (e) {
    console.warn('次回巡回時刻取得失敗:', e && e.message);
  }

  // 通知する要素が何もなければスキップ（新着なし0名 + 次回時刻なし）
  if (list.length === 0 && !nextRunLine) return;

  const lines = [];
  if (list.length > 0) {
    lines.push(`📭 **新着なし: ${list.length}名**`);
    const names = list.map(item => `・${item.name}`);
    lines.push(names.join('\n'));

    // 未解決駅があった顧客だけ追記
    const unresolvedLines = [];
    for (const item of list) {
      const cu = _unresolvedStations[item.name];
      if (!cu) continue;
      const svcParts = [];
      for (const [svc, stations] of Object.entries(cu)) {
        if (stations.length > 0) svcParts.push(`${svc}: ${stations.join(', ')}`);
      }
      if (svcParts.length > 0) {
        unresolvedLines.push(`⚠️ **${item.name}**: 駅名解決失敗 ${svcParts.join(' / ')}`);
      }
    }
    if (unresolvedLines.length > 0) {
      lines.push('');
      lines.push(unresolvedLines.join('\n'));
    }
  }

  if (nextRunLine) {
    if (lines.length > 0) lines.push('');
    lines.push(nextRunLine);
  }

  // Discord Webhook メッセージは 2000 文字が上限。超える場合は行単位で分割送信。
  const MAX_LEN = 1900; // 余裕を持って1900
  const full = lines.join('\n');
  const chunks = [];
  if (full.length <= MAX_LEN) {
    chunks.push(full);
  } else {
    let buf = '';
    for (const line of lines) {
      if (buf.length + line.length + 1 > MAX_LEN) {
        if (buf) chunks.push(buf);
        buf = line;
      } else {
        buf = buf ? (buf + '\n' + line) : line;
      }
    }
    if (buf) chunks.push(buf);
  }
  // フォーラムチャンネルのWebhookは thread_name(新スレッド作成) or thread_id(既存スレッド投稿)が必須。
  // 1日1スレッド方式: 日付キー(YYYY-MM-DD)で threadId を chrome.storage.local に保存。
  // 同日は thread_id で追記、日をまたいだら新スレッド作成。
  const nowD = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateKey = `${nowD.getFullYear()}-${pad(nowD.getMonth() + 1)}-${pad(nowD.getDate())}`;
  const threadName = `📋 巡回サマリー ${nowD.getMonth() + 1}/${nowD.getDate()}`;
  const THREAD_STORAGE_KEY = 'patrolSummaryThread'; // { dateKey, threadId }
  try {
    const cache = await new Promise(r => chrome.storage.local.get([THREAD_STORAGE_KEY], r));
    let savedThread = cache[THREAD_STORAGE_KEY];
    let threadId = (savedThread && savedThread.dateKey === dateKey) ? savedThread.threadId : null;

    for (let i = 0; i < chunks.length; i++) {
      let url = discordWebhookUrl;
      const payload = { content: chunks[i], allowed_mentions: { parse: [] } };
      if (!threadId) {
        // 同日スレッド未作成 → thread_name で新規作成
        url = `${discordWebhookUrl}?wait=true`;
        payload.thread_name = threadName;
      } else {
        // 既存スレッドに追記
        url = `${discordWebhookUrl}?thread_id=${threadId}`;
      }
      const resp = await discordPostWithRetry(url, payload);
      if (!threadId && resp && resp.ok) {
        try {
          const respData = await resp.json();
          threadId = respData.channel_id || respData.id;
          if (threadId) {
            await new Promise(r => chrome.storage.local.set({ [THREAD_STORAGE_KEY]: { dateKey, threadId } }, r));
          }
        } catch (e) {}
      }
      if (i < chunks.length - 1) await sleep(500);
    }
    console.log(`Discord 新着なしまとめ通知完了: 新着なし${list.length}名 chunks=${chunks.length} nextRun=${nextRunLine ? 'あり' : 'なし'} threadReused=${!!(savedThread && savedThread.dateKey === dateKey)}`);
  } catch (err) {
    console.error(`Discord 新着なしまとめ通知失敗: ${err.message}`);
  }
}

async function sendDiscordNoResultNotification(customerName, customer) {
  const { discordWebhookUrl } = await getConfig();
  if (!discordWebhookUrl) return;

  try {
    let threadId = discordThreadIds[customerName];

    // スレッドがまだなければ作成
    if (!threadId) {
      const headerPayload = {
        content: `**${customerName}** 様の検索結果`,
        thread_name: `🏠 ${customerName}`
      };
      const resp = await fetch(`${discordWebhookUrl}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(headerPayload)
      });

      if (!resp.ok) {
        console.error(`Discord スレッド作成失敗 (no-result): status=${resp.status}`);
        return;
      }

      const respData = await resp.json();
      threadId = respData.channel_id;
      if (!threadId) {
        console.error('Discord レスポンスに channel_id なし (no-result)');
        return;
      }
      discordThreadIds[customerName] = threadId;
      try { await setStorageData({ discordThreadIds }); } catch (e) {}
    }

    // 検索条件を送信
    if (customer) {
      const searchInfo = buildSearchInfo(customer);
      await discordPostWithRetry(`${discordWebhookUrl}?thread_id=${threadId}`, { content: searchInfo });
      await sleep(500);
    }

    // 未解決駅があれば警告を送信
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

    // 新着なしメッセージを送信
    await discordPostWithRetry(`${discordWebhookUrl}?thread_id=${threadId}`, {
      content: `📭 **${customerName}** 様: 新着物件なし`
    });

    console.log(`Discord新着なし通知完了: ${customerName}`);

  } catch (err) {
    console.error(`Discord新着なし通知失敗: ${err.message}`);
  }
}

async function discordPostWithRetry(url, payload) {
  // @here/@everyone メンションを有効にする
  if (payload && payload.content && !payload.allowed_mentions) {
    payload.allowed_mentions = { users: ['1459814543600390341'] };
  }
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
      let errBody = '';
      try { errBody = (await resp.text()).substring(0, 500); } catch (e) {}
      console.error(`Discord送信エラー: status=${resp.status} body=${errBody}`);
    }
    return resp;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error('Discord送信タイムアウト');
    } else {
      throw err;
    }
    return null;
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
  // 物件ごとの区切り線（1件目にも入れる。上は検索条件）
  const lines = [];
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`**${index}. ${title}** \`[${sourceTag}]\``);

  // 賃料
  let rentStr = `賃料: **${fmtMan(prop.rent)}万円**`;
  if (prop.management_fee) {
    rentStr += ` (管理費: ${fmtMan(prop.management_fee)}万円)`;
  }
  lines.push(rentStr);

  // 間取り
  if (prop.layout) lines.push(`間取り: ${prop.layout}`);
  // 面積
  if (prop.area) lines.push(`面積: ${prop.area}m²`);
  // 築年
  if (prop.building_age) lines.push(`築年: ${prop.building_age}`);

  if (prop.address) lines.push(`住所: ${prop.address}`);
  if (prop.station_info) lines.push(`交通: ${prop.station_info}`);

  // 階数
  if (prop.floor_text || prop.story_text) {
    lines.push(`階数: ${prop.floor_text || '?'}/${prop.story_text || '?'}`);
  }

  if (prop.deposit || prop.key_money) {
    lines.push(`敷金: ${prop.deposit || 'なし'} / 礼金: ${prop.key_money || 'なし'}`);
  }

  // 入居時期
  if (prop.move_in_date) {
    lines.push(`入居: ${prop.move_in_date}`);
  }

  // REINS物件番号（REINSソースの場合のみ）
  if (prop.source !== 'ielove' && prop.source !== 'itandi' && prop.source !== 'essquare' && prop.reins_property_number) {
    lines.push(`物件番号: ${prop.reins_property_number}`);
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
  // 広告掲載可否（itandi）— SUUMO巡回モードの時のみ「可」以外でアラート
  if (globalThis._suumoPatrolMode && prop.source === 'itandi' && prop.ad_keisai) {
    const adKeisaiStr = String(prop.ad_keisai).trim();
    if (adKeisaiStr && adKeisaiStr !== '可') {
      warnings.push(`⚠️ 広告掲載: ${adKeisaiStr}（SUUMO広告掲載の確認が必要です）`);
    }
  }
  // 入居時期アラート
  const moveInWarning = _checkMoveInWarning(prop, customer?.move_in_date);
  if (moveInWarning) {
    warnings.push(moveInWarning);
  }
  // その他ご希望（顧客の自由入力）
  if (customer?.notes && String(customer.notes).trim()) {
    warnings.push(`⚠️ その他ご希望: ${String(customer.notes).trim()}`);
  }
  if (warnings.length > 0) {
    const ansiText = warnings.join('\n');
    lines.push(`\`\`\`ansi\n\u001b[0;33m${ansiText}\u001b[0m\n\`\`\``);
  }

  // 広告料・現況・客付会社メッセージ
  lines.push(`広告料: ${prop.ad_fee || '-'}`);
  if (prop.current_status) lines.push(`現況: ${prop.current_status}`);
  else if (prop.listing_status) lines.push(`現況: ${prop.listing_status}`);
  if (prop.agent_message) lines.push(`メッセージ: ${prop.agent_message}`);

  // 詳細ページURL
  if (prop.url) {
    lines.push(`[詳細ページ](${prop.url})`);
  } else if (prop.source !== 'ielove' && prop.source !== 'itandi' && prop.source !== 'essquare' && prop.reins_property_number) {
    // REINS: 物件番号検索を自動実行するURL（拡張のcontent-search.jsがhashを検出して検索）
    const cleanNum = String(prop.reins_property_number).replace(/\D/g, '');
    lines.push(`[REINSで開く](https://system.reins.jp/main/BK/GBK004100#bukken=${cleanNum})`);
  }

  // 承認リンク
  if (gasWebappUrl && customerName) {
    const approveUrl = `${gasWebappUrl}?action=approve&customer=${encodeURIComponent(customerName)}&room_id=${prop.room_id}`;
    lines.push(`[承認してLINE送信](${approveUrl})`);
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

// ══════════════════════════════════════════════════════════════
//  SUUMO入稿: ForRentタブ管理・入稿プロセス
// ══════════════════════════════════════════════════════════════

/** ForRentのベースURL（suumo_fill=trueでcontent scriptがキュー処理を開始） */
const FORRENT_BASE_URL = 'https://www.fn.forrent.jp/fn/';
const FORRENT_FILL_URL = 'https://www.fn.forrent.jp/fn/?suumo_fill=true';

/**
 * ForRentの利用可能時間チェック
 *
 * ご利用可能時間:
 *   月曜日: 9:00〜24:00
 *   日曜日: 8:00〜23:00
 *   その他: 8:00〜24:00
 *
 * @returns {{ available: boolean, nextAvailableTime: number|null }}
 */
function checkForrentAvailability() {
  const now = new Date();
  const day = now.getDay(); // 0=日, 1=月, ...
  const hour = now.getHours();
  const minute = now.getMinutes();
  const currentMinutes = hour * 60 + minute;

  let startMinutes, endMinutes;
  if (day === 1) {
    // 月曜: 9:00〜24:00
    startMinutes = 9 * 60;
    endMinutes = 24 * 60;
  } else if (day === 0) {
    // 日曜: 8:00〜23:00
    startMinutes = 8 * 60;
    endMinutes = 23 * 60;
  } else {
    // その他: 8:00〜24:00
    startMinutes = 8 * 60;
    endMinutes = 24 * 60;
  }

  if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
    return { available: true, nextAvailableTime: null };
  }

  // 次の利用可能時刻を計算
  const next = new Date(now);
  if (currentMinutes >= endMinutes) {
    // 今日の利用時間は終了 → 翌日の開始時刻
    next.setDate(next.getDate() + 1);
  }
  // 翌日の曜日に応じた開始時刻
  const nextDay = next.getDay();
  let nextStart;
  if (nextDay === 1) {
    nextStart = 9 * 60; // 月曜
  } else {
    nextStart = 8 * 60; // 日曜・その他
  }
  next.setHours(Math.floor(nextStart / 60), nextStart % 60, 0, 0);

  return { available: false, nextAvailableTime: next.getTime() };
}

// ── 入稿キュー操作の mutex（race condition防止） ──────────────
// content scriptからの POP と background からの APPEND が同時に走ると
// 処理済み物件の再出現・重複入稿が起きるため、キュー書込は必ずここ経由で直列化する
let _fillQueueMutex = Promise.resolve();
function withFillQueueLock(fn) {
  const prev = _fillQueueMutex;
  let release;
  _fillQueueMutex = new Promise(r => { release = r; });
  return prev.then(() => fn()).finally(() => release());
}

async function popFillQueueHead() {
  return await withFillQueueLock(async () => {
    const { suumoFillQueue = [] } = await getStorageData(['suumoFillQueue']);
    if (suumoFillQueue.length === 0) return null;
    const head = suumoFillQueue[0];
    await setStorageData({ suumoFillQueue: suumoFillQueue.slice(1) });
    return head;
  });
}

async function appendFillQueue(items) {
  if (!items || items.length === 0) return 0;
  return await withFillQueueLock(async () => {
    const { suumoFillQueue = [] } = await getStorageData(['suumoFillQueue']);
    // 重複排除（物件キー単位）
    const existingKeys = new Set(
      suumoFillQueue.map(it => it.key || it.propertyKey).filter(Boolean)
    );
    const newItems = items.filter(it => {
      const k = it.key || it.propertyKey;
      return !k || !existingKeys.has(k);
    });
    if (newItems.length === 0) return 0;
    await setStorageData({ suumoFillQueue: suumoFillQueue.concat(newItems) });
    return newItems.length;
  });
}

/**
 * GASからキューをポーリングし、物件があれば入稿プロセスを開始
 *
 * @param {Object} options
 * @param {'approval'|'backup'|'startup'|'scheduled'|'manual'} options.source
 *   - approval: GAS承認ページからのSUUMO_APPROVED_NOW（即時処理）
 *   - backup:   60分おきのbackup poll（取りこぼし対策）
 *   - startup:  Chrome起動時の onStartup
 *   - scheduled: 営業時間外→営業開始時の suumo-fill-scheduled
 *   - manual:   ポップアップ等からの手動起動
 *
 * 稼働中タブがあるときの振る舞い（source別）:
 *   - approval / manual: GASから追加分を取得してキューに追記（連続入稿）
 *   - backup / startup: 重複処理を避けるためスキップ
 *   - scheduled: 基本的に稼働中タブは無いはず。あれば何もしない
 */
/**
 * 承認時の自動前処理(Phase 4)
 *
 * 順序:
 *   1. SUUMOビジネス Daily Search からデータ取得 → GAS反映 (best effort, 失敗は続行)
 *   2. GASから現在の掲載数と停止候補リストを peek (lockなし)
 *   3. 掲載数 >= 50 なら候補先頭の物件をForRentで停止
 *      - 停止成功: GASに stop_suumo_listing 反映 → OK返却
 *      - 停止ドライラン: GAS反映はしない + 警告ログ残して OK返却(入稿続行)
 *      - 停止失敗: NG返却(呼び出し元で入稿中止)
 *
 * @returns {Promise<{ok:boolean, error?:string, stopped?:Object}>}
 */
/**
 * Phase 4 前処理のミューテックス付き実行
 *
 * - 実行中の preHook Promise を _preHookInFlight に保持、並列呼び出しは同じPromiseを待つ
 * - 直近5分以内に成功済みなら即OK返却(再実行不要)
 * - 失敗した場合はキャッシュしない(次回リトライ可能)
 */
let _preHookInFlight = null;
let _preHookSucceededAt = 0;
let _preHookFailedAt = 0;
let _preHookFailedError = '';

async function getOrRunSuumoPreHook_() {
  const nowMs = Date.now();
  // 直近5分以内に成功済みなら再実行しない(over-stop防止)
  if (_preHookSucceededAt && (nowMs - _preHookSucceededAt) < 5 * 60 * 1000) {
    return { ok: true, cached: true };
  }
  // 直近60秒以内に失敗していれば再実行しない(無限ループ防止)
  // 同じエラーで何度もForRentを叩き続けるのを回避
  if (_preHookFailedAt && (nowMs - _preHookFailedAt) < 60 * 1000) {
    return { ok: false, cached: true, error: '直近失敗中(cooldown): ' + _preHookFailedError };
  }
  // 実行中のpreHookがあれば同じ結果を待つ
  if (_preHookInFlight) {
    return await _preHookInFlight;
  }
  // 新規実行
  _preHookInFlight = (async () => {
    try {
      const result = await runSuumoApprovalPreHook_();
      if (result && result.ok) {
        _preHookSucceededAt = Date.now();
        _preHookFailedAt = 0;
        _preHookFailedError = '';
      } else {
        _preHookFailedAt = Date.now();
        _preHookFailedError = (result && result.error) || 'no result';
      }
      return result || { ok: false, error: 'no result' };
    } catch (err) {
      _preHookFailedAt = Date.now();
      _preHookFailedError = err.message;
      return { ok: false, error: err.message };
    } finally {
      _preHookInFlight = null;
    }
  })();
  return await _preHookInFlight;
}

async function runSuumoApprovalPreHook_() {
  // ── 0. ForRent状態同期 (実態と整合) ──
  // SUUMOビジネスは今日-2日までの集計のため、直近の停止・入稿を反映できない。
  // ForRent PUB1R2801 を直読みしてシートの active/stopped を正確化してから
  // 以降の判定を行う(掲載数オーバーエラー対策)。
  try {
    await setStorageData({ debugLog: '[承認前処理] ForRent状態同期(実態反映)開始' });
    const syncResult = await syncForrentListingStatus();
    if (!syncResult || !syncResult.ok) {
      await setStorageData({ debugLog: `[承認前処理] ForRent状態同期失敗(スキップして続行): ${syncResult && syncResult.error}` });
    }
  } catch (err) {
    await setStorageData({ debugLog: `[承認前処理] ForRent状態同期例外(スキップ): ${err.message}` });
  }

  // ── 1. SUUMOビジネスデータ取得 (JST日次キャッシュ) ──
  // SUUMOビジネスは1日1回しかデータ更新されないので、当日(JST)に一度取得済みなら
  // 日付が変わるまで再取得しない
  try {
    const { suumoBusinessLastFetchAt } = await getStorageData(['suumoBusinessLastFetchAt']);
    const toJstDate = (ms) => {
      // JST(UTC+9)の日付を YYYY-MM-DD 形式で取得
      const d = new Date(Number(ms) + 9 * 60 * 60 * 1000);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const todayJst = toJstDate(Date.now());
    const lastJst = suumoBusinessLastFetchAt ? toJstDate(suumoBusinessLastFetchAt) : null;
    if (lastJst && lastJst === todayJst) {
      await setStorageData({ debugLog: `[承認前処理] SUUMOビジネスデータは本日(${todayJst})取得済み → スキップ` });
    } else {
      await setStorageData({ debugLog: '[承認前処理] SUUMOビジネスデータ更新開始(本日初取得)' });
      const fetchResult = await runSuumoBusinessFetch();
      if (!fetchResult || !fetchResult.ok) {
        await setStorageData({ debugLog: `[承認前処理] データ更新失敗(スキップして続行): ${fetchResult && fetchResult.error}` });
      }
      // runSuumoBusinessFetch内で成功時にsuumoBusinessLastFetchAtを更新している
    }
  } catch (err) {
    await setStorageData({ debugLog: `[承認前処理] データ更新例外(スキップ): ${err.message}` });
  }

  // ── 2. 現在の掲載数と停止候補を peek ──
  let peek;
  try {
    peek = await pollSuumoApprovalQueue({ lock: false });
  } catch (err) {
    return { ok: false, error: `停止候補取得失敗: ${err.message}` };
  }
  if (!peek) {
    return { ok: false, error: '停止候補取得失敗(GAS応答なし)' };
  }

  const activeCount = Number(peek.activeListingCount) || 0;
  if (activeCount < 50) {
    await setStorageData({ debugLog: `[承認前処理] 現掲載${activeCount}件 → 停止不要、入稿へ進む` });
    return { ok: true };
  }

  // 候補リスト取得: 新API(stopCandidates) → 旧API(stopCandidate単数) の順でフォールバック
  const candidates = Array.isArray(peek.stopCandidates) && peek.stopCandidates.length > 0
    ? peek.stopCandidates
    : (peek.stopCandidate ? [peek.stopCandidate] : []);

  if (candidates.length === 0) {
    await setStorageData({ debugLog: '[承認前処理] ⚠️ 50件達しているが停止候補なし(全員保護対象?) → 入稿中止' });
    return { ok: false, error: '50件達しているが停止候補が空(全員保護対象)' };
  }

  // ── 3. 先頭候補を停止 ──
  const target = candidates[0];
  const suumoCode = String(target.suumoPropertyCode || '').replace(/[^0-9]/g, '');
  if (!suumoCode || suumoCode.length !== 12) {
    await setStorageData({ debugLog: `[承認前処理] ⚠️ 候補のsuumo_property_codeが不正: "${target.suumoPropertyCode}" → 入稿中止` });
    return { ok: false, error: `候補のsuumo_property_code不正: ${target.suumoPropertyCode}` };
  }

  await setStorageData({
    debugLog: `[承認前処理] 停止実行: ${target.building} ${target.room} (${suumoCode}) score=${target.score}`
  });

  const stopResult = await stopForrentListing({ suumoPropertyCode: suumoCode });

  if (!stopResult || !stopResult.ok) {
    return { ok: false, error: `ForRent停止失敗: ${(stopResult && stopResult.error) || '不明'}` };
  }

  // ── 3b. ドライランの場合: GAS反映せず、ログだけ残して続行 ──
  if (stopResult.dryRun) {
    await setStorageData({ debugLog: `[承認前処理] ⚠️ 停止処理はドライラン中のため実際には停止されていない。入稿は続行するが SUUMO側で上限エラーになる可能性あり` });
    return { ok: true, stopped: target, dryRun: true };
  }

  // ── 3c. GASに停止を反映 (stop_suumo_listing) ──
  try {
    const { gasWebappUrl } = await getStorageData(['gasWebappUrl']);
    if (gasWebappUrl && target.key) {
      const res = await fetch(gasWebappUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop_suumo_listing', key: target.key })
      });
      if (!res.ok) {
        await setStorageData({ debugLog: `[承認前処理] ⚠️ GAS停止反映HTTP${res.status}(ForRent側は停止済、シート更新のみ失敗)` });
      }
    }
  } catch (err) {
    await setStorageData({ debugLog: `[承認前処理] ⚠️ GAS停止反映失敗: ${err.message}(ForRent側は停止済)` });
  }

  await setStorageData({
    debugLog: `[承認前処理] 停止完了: ${target.building} ${target.room} → 入稿へ進む`,
    suumoForrentLastAutoStopAt: Date.now(),
    suumoForrentLastAutoStopTarget: { key: target.key, building: target.building, room: target.room, suumoCode: suumoCode },
  });
  return { ok: true, stopped: target };
}

async function pollAndStartFillIfNeeded(options = {}) {
  const source = options.source || 'approval';
  await setStorageData({ debugLog: `[SUUMO入稿] pollAndStartFillIfNeeded 開始 source=${source}` });

  // 稼働中入稿タブの有無を確認
  const { suumoFillTabId } = await getStorageData(['suumoFillTabId']);
  let tabAlive = false;
  if (suumoFillTabId) {
    try {
      const existingTab = await chrome.tabs.get(suumoFillTabId);
      if (existingTab && existingTab.url && existingTab.url.includes('fn.forrent.jp')) {
        tabAlive = true;
      }
    } catch (e) {
      // タブが存在しない → suumoFillTabIdは古いので続行（後でnew tab作成）
      await chrome.storage.local.remove(['suumoFillTabId', 'suumoFillQueue']);
    }
  }
  await setStorageData({ debugLog: `[SUUMO入稿] tabAlive=${tabAlive} suumoFillTabId=${suumoFillTabId}` });

  // ── 稼働中タブあり ──
  if (tabAlive) {
    // 重複処理を避けるため backup/startup は完全スキップ
    if (source === 'backup' || source === 'startup' || source === 'scheduled') {
      console.log(`[SUUMO入稿] 入稿タブ(${suumoFillTabId})稼働中 → ${source}をスキップ`);
      return;
    }
    // approval/manual: GASから追加分を取得して稼働中タブのキューに追記
    const { available } = checkForrentAvailability();
    if (!available) {
      // タブ稼働中で時間外はレアケース（処理中に時間を跨いだ等）。追加取得はせず静観
      console.log('[SUUMO入稿] タブ稼働中・時間外 → 追加取得スキップ');
      return;
    }

    // ── Phase 4: 稼働中タブでも approval/manual なら前処理(データ更新+必要なら停止)を実行 ──
    // 以前は tabAlive=true の時に前処理をスキップしていたため、
    // 50件超過時に停止されずに追加キュー投入され、SUUMO側で「掲載数オーバー」エラーになっていた
    if (source === 'approval' || source === 'manual') {
      const preHook = await getOrRunSuumoPreHook_();
      if (!preHook.ok) {
        await setStorageData({ debugLog: `[SUUMO入稿] 前処理失敗のため稼働中タブへの追加も中止: ${preHook.error}` });
        return;
      }
    }

    const queueData = await pollSuumoApprovalQueue({ lock: true });
    if (queueData && queueData.queue && queueData.queue.length > 0) {
      const added = await appendFillQueue(queueData.queue);
      console.log(`[SUUMO入稿] 稼働中タブのキューに ${added}件追加（連続入稿）`);
      await setStorageData({
        suumoActiveListingCount: queueData.activeListingCount,
        suumoStopCandidate: queueData.stopCandidate,
        debugLog: `[SUUMO入稿] 稼働中タブに${added}件追加`
      });
    }
    return;
  }

  // ── 稼働中タブなし ──
  const { available, nextAvailableTime } = checkForrentAvailability();
  if (!available) {
    const nextDate = new Date(nextAvailableTime);
    const timeStr = `${nextDate.getMonth()+1}/${nextDate.getDate()} ${String(nextDate.getHours()).padStart(2,'0')}:${String(nextDate.getMinutes()).padStart(2,'0')}`;
    // キューを事前に確認（空なら予約しない）
    const peek = await pollSuumoApprovalQueue({ lock: false });
    if (!peek || !peek.queue || peek.queue.length === 0) return;
    console.log(`[SUUMO入稿] ForRent時間外 → ${timeStr} にスケジュール`);
    await setStorageData({ debugLog: `[SUUMO入稿] ForRent利用時間外のため ${timeStr} に入稿予定` });
    chrome.alarms.create('suumo-fill-scheduled', { when: nextAvailableTime });
    return;
  }

  // ── Phase 4: 承認/手動起動時のみ、入稿前に SUUMOビジネス更新 → 50件超なら自動停止 ──
  //   - データ取得失敗はスキップ(入稿は続行)
  //   - 停止失敗は入稿中止(50件超過の入稿は SUUMO側でエラーになるため安全優先)
  //   - 停止ドライラン中はGAS反映せず、ログ警告だけ残して入稿は続行
  if (source === 'approval' || source === 'manual') {
    const preHook = await getOrRunSuumoPreHook_();
    if (!preHook.ok) {
      await setStorageData({ debugLog: `[SUUMO入稿] 前処理失敗のため入稿中止: ${preHook.error}` });
      return;
    }
  }

  // 実入稿フェーズ: ロック付きでキュー取得（取得した瞬間にGAS側でsubmittingに変わり二重取得防止）
  const queueData = await pollSuumoApprovalQueue({ lock: true });
  if (!queueData || !queueData.queue || queueData.queue.length === 0) {
    return;
  }

  console.log(`[SUUMO入稿] ${queueData.queue.length}件の承認済み物件あり（submittingへロック済み）`);
  await setStorageData({
    suumoFillQueue: queueData.queue,
    suumoActiveListingCount: queueData.activeListingCount,
    suumoStopCandidate: queueData.stopCandidate
  });

  await startSuumoFillProcess();
}

/**
 * ForRentの入稿プロセスを開始
 *
 * ForRentは動的セッションID管理のため固定URLでは新規登録ページに直接アクセスできない。
 * 既存ForRentタブがあればそれを使い、なければ ?suumo_fill=true 付きで開く。
 * content script (suumo-fill-auto.js) が ?suumo_fill=true を検知してキュー処理を開始。
 */
async function startSuumoFillProcess() {
  try {
    // ── race condition対策: 空タブを先に作ってタブIDを storage に書き込んでから URL設定 ──
    // 旧: tabs.create(url=FORRENT_FILL_URL) → await setStorageData(tabId)
    //     の順だとログインページが即document_idleになった場合に content script が
    //     AM_I_FILL_TAB を送った時点で storage にタブIDがまだ書かれておらず
    //     「入稿タブではない」と判定→自動ログインがスキップされる事象が起きる。
    // 新: 空タブ(about:blank)作成 → storage書込 → tabs.update(url) の順で、
    //     content script が走る前に必ずtabIdが確定している状態にする。
    const forrentTab = await chrome.tabs.create({ url: 'about:blank', active: false });
    await setStorageData({ suumoFillTabId: forrentTab.id });
    await chrome.tabs.update(forrentTab.id, { url: FORRENT_FILL_URL });
    console.log(`[SUUMO入稿] 入稿用タブを新規作成 (tab ${forrentTab.id})`);
    await setStorageData({ debugLog: `[SUUMO入稿] ForRent入稿タブ作成(tab=${forrentTab.id})` });
  } catch (err) {
    console.error('[SUUMO入稿] ForRentタブオープン失敗:', err);
    await setStorageData({ debugLog: `[SUUMO入稿] ForRentタブオープン失敗: ${err.message}` });
  }
}
