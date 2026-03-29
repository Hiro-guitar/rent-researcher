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

// いえらぶBB関連ファイルを読み込み
importScripts('ielove-config.js', 'ielove-background.js');

// 拡張アイコンクリックでダッシュボード（log.html）を開く
chrome.action.onClicked.addListener(() => {
  openLogTab();
});

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

  // 駅名＋徒歩フィルタ
  let allStations = customer.stations || [];
  if (customer.routes_with_stations && customer.routes_with_stations.length > 0) {
    const rwsStations = customer.routes_with_stations.flatMap(r => r.stations || []);
    if (rwsStations.length > 0) allStations = rwsStations;
  }

  if (allStations.length > 0 && prop.station_info) {
    const transports = prop.station_info.split('/').map(s => s.trim());
    const walkMax = customer.walk ? parseInt(String(customer.walk).replace(/[^\d]/g, '')) : 0;

    const hasMatch = transports.some(transport => {
      const stationMatch = allStations.some(s => transport.includes(s));
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
      if (walkMax > 0) {
        return `駅/徒歩不一致: ${prop.station_info}（徒歩${walkMax}分以内）`;
      }
      return `駅不一致: ${prop.station_info}`;
    }
  } else if (allStations.length > 0 && !prop.station_info) {
    return '交通情報なし';
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

// --- アラーム ---
function setupAlarm(intervalMinutes) {
  chrome.alarms.clear('reins-search', () => {
    chrome.alarms.create('reins-search', { periodInMinutes: Math.max(10, intervalMinutes) });
    console.log(`REINS検索アラーム設定: ${intervalMinutes}分間隔`);
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reins-search') {
    runSearchCycle();
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

// --- メイン検索サイクル ---
async function runSearchCycle() {
  const { isSearching, gasWebappUrl, enabledServices } = await getStorageData(['isSearching', 'gasWebappUrl', 'enabledServices']);
  if (isSearching) { console.log('検索中のためスキップ'); return; }
  if (!gasWebappUrl) { console.log('GAS URL未設定のためスキップ'); return; }

  const services = enabledServices || { reins: true, ielove: true };

  if (!services.reins && !services.ielove) {
    console.log('有効なサービスがありません');
    return;
  }

  const searchId = ++currentSearchId;
  // DiscordスレッドIDキャッシュをクリア
  Object.keys(discordThreadIds).forEach(k => delete discordThreadIds[k]);
  const serviceNames = [services.reins && 'REINS', services.ielove && 'いえらぶ'].filter(Boolean).join('・');
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

    // === REINS検索 ===
    if (services.reins) {
      const reinsTab = await findReinsTab();
      if (!reinsTab) {
        await setStorageData({ loginDetected: false, debugLog: 'REINSタブが見つかりません（REINS検索スキップ）' });
      } else {
        await setStorageData({ debugLog: `REINSタブ発見: tabId=${reinsTab.id}, url=${reinsTab.url}` });

        const { pageDelaySeconds } = await getStorageData(['pageDelaySeconds']);
        const delay = (pageDelaySeconds || 2) * 1000;

        // 全顧客を順次検索
        for (let ci = 0; ci < criteria.length; ci++) {
          if (isSearchCancelled(searchId)) {
            console.log(`検索サイクル${searchId}は中止されました`);
            return;
          }

          const customer = criteria[ci];
          const cond = formatCustomerCriteria(customer);
          await setStorageData({ debugLog: `[REINS] 顧客 ${ci+1}/${criteria.length}: ${customer.name}` });
          await setStorageData({ debugLog: `[REINS] 条件: ${cond}` });
          try {
            // 路線が4つ以上ある場合、3つずつに分割して複数回検索
            const rws = customer.routes_with_stations || [];
            if (rws.length > 3) {
              for (let batch = 0; batch * 3 < rws.length; batch++) {
                if (isSearchCancelled(searchId)) {
                  console.log(`検索サイクル${searchId}は中止されました`);
                  return;
                }
                const batchRws = rws.slice(batch * 3, (batch + 1) * 3);
                const batchCustomer = {
                  ...customer,
                  routes: batchRws.map(r => r.route),
                  routes_with_stations: batchRws,
                };
                await setStorageData({ debugLog: `[REINS] ${customer.name}: バッチ ${batch+1}/${Math.ceil(rws.length/3)} (${batchRws.map(r=>r.route).join(', ')})` });
                await searchForCustomer(reinsTab.id, batchCustomer, seenIds, delay, searchId);
                if (batch * 3 + 3 < rws.length) await sleep(3000);
              }
            } else {
              await searchForCustomer(reinsTab.id, customer, seenIds, delay, searchId);
            }
          } catch (err) {
            if (err.message === 'SEARCH_CANCELLED') {
              console.log(`検索サイクル${searchId}: 中止により終了`);
              return;
            }
            if (err.message === 'SLEEP_DETECTED') {
              await setStorageData({ debugLog: 'PCスリープから復帰→検索サイクル終了（次回スケジュールで再開）' });
              return;
            }
            if (err.message === 'REINS_ERROR_PAGE') {
              await setStorageData({ debugLog: 'REINSエラーページ検知→検索サイクル終了（再ログイン後に再開してください）' });
              return;
            }
            logError(`[REINS] ${customer.name}の検索失敗: ${err.message}`);
          }
          // 顧客間の待ち時間
          if (ci < criteria.length - 1) await sleep(3000);
        }

        await closeDedicatedWindow();
        await setStorageData({ debugLog: '[REINS] 検索完了' });
      }
    }

    // === いえらぶBB検索 ===
    if (services.ielove) {
      if (isSearchCancelled(searchId)) return;
      try {
        await runIeloveSearch(criteria, seenIds, searchId);
      } catch (err) {
        if (err.message === 'SEARCH_CANCELLED') return;
        await setStorageData({ debugLog: `[いえらぶ] 検索エラー: ${err.message}` });
        logError('[いえらぶ] 検索エラー: ' + err.message);
      }
    }

    await setStorageData({ lastSearchTime: Date.now() });
  } catch (err) {
    logError('検索サイクルエラー: ' + err.message);
  } finally {
    clearInterval(globalKeepAlive);
    await closeDedicatedWindow();
    await closeDedicatedIeloveWindow();
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

  setResult = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (stationStr, customerData, lineNameMap, reinsCodeMap) => {
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
      for (let n = 1; n <= 3; n++) {
        vr[`ensnCd${n}`] = ''; vr[`ensnRykshu${n}`] = '';
        vr[`ekCdFrom${n}`] = ''; vr[`ekCdTo${n}`] = '';
        vr[`ekmiFrom${n}`] = ''; vr[`ekmiTo${n}`] = '';
        vr[`thNyurykc${n}`] = ''; vr[`thMHnKbn${n}`] = '';
      }
      vr.kkkuCnryuFrom = ''; vr.kkkuCnryuTo = '';
      vr.bkknShbt1 = ''; vr.bkknShbt2 = '';
      vr.mdrTyp = []; vr.mdrHysuFrom = ''; vr.mdrHysuTo = '';
      vr.snyuMnskFrom = ''; vr.snyuMnskTo = '';
      vr.hnkuNngppFrom = ''; vr.hnkuNngppTo = '';

      // 物件種別: 賃貸マンション
      vr.bkknShbt1 = '03';

      // 沿線コードセット
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

          const ensnCd = reinsCodeMap[reinsLineName];
          if (!ensnCd) continue;

          slotNum++;
          const num = slotNum;
          vr[`ensnCd${num}`] = ensnCd;
          vr[`ensnRykshu${num}`] = reinsLineName;

          // 駅名セット（駅指定がある場合、最初と最後の駅をFrom/Toにセット）
          if (colonIdx >= 0) {
            const stationsInLine = parts[i].substring(colonIdx + 1).split(',').map(s => s.trim()).filter(s => s);
            if (stationsInLine.length > 0) {
              vr[`ekmiFrom${num}`] = stationsInLine[0];
              vr[`ekmiTo${num}`] = stationsInLine[stationsInLine.length - 1];
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

      // 賃料上限（万円）
      if (customerData.rent_max) {
        vr.kkkuCnryuTo = String(customerData.rent_max);
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
          const m = layout.match(/^(\d+)\s*(.+)$/);
          if (m) {
            const rooms = parseInt(m[1]);
            const typeName = m[2].replace(/\s/g, '').toUpperCase()
              .replace(/Ｋ/g, 'K').replace(/Ｄ/g, 'D').replace(/Ｌ/g, 'L').replace(/Ｓ/g, 'S');
            const code = typeMap[typeName];
            if (code) types.add(code);
            if (rooms < minRooms) minRooms = rooms;
            if (rooms > maxRooms) maxRooms = rooms;
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
      if (customerData.area_min) {
        vr.snyuMnskFrom = String(customerData.area_min);
      }

      // 築年月（築N年以内 → From年をセット）
      // selectのiValueを変更してVueリアクティブに反映
      if (customerData.building_age) {
        const ageNum = parseInt(String(customerData.building_age).replace(/[^\d]/g, ''));
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
        debugEquip: customerData.equipment || '(empty)'
      };
    },
    args: [stationStr, { rent_max: customer.rent_max, layouts: customer.layouts || [], area_min: customer.area_min || '', building_age: customer.building_age || '', equipment: customer.equipment || '', stations: customer.stations || [], routes_with_stations: customer.routes_with_stations || [], walk: customer.walk || '' }, lineNameMap, reinsCodeMap]
  });

  const setStatus = setResult?.[0]?.result;
  if (!setStatus?.success) {
    await setStorageData({ debugLog: `${customer.name}: 条件セットエラー: ${JSON.stringify(setStatus)}` });
    return;
  }
  await setStorageData({ debugLog: `${customer.name}: 条件セット完了 ensn=[${setStatus.ensnDebug || '-'}] rent=${setStatus.kkkuCnryuTo} mdrTyp=[${setStatus.mdrTyp}] rooms=${setStatus.mdrHysuFrom}-${setStatus.mdrHysuTo} area=${setStatus.snyuMnskFrom || '-'}~ age=${setStatus.buildingAge || '-'} walk=${customer.walk || '-'} shziki=${setStatus.shzikiFrom || '-'}~${setStatus.shzikiTo || '-'} equip=${setStatus.debugEquip}` });

  // Vueリアクティブ更新を待つ
  await csleep(2000);

  // --- Step 3: 検索ボタンをDOMクリック（MAIN world） ---
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
        await setStorageData({ debugLog: `${customer.name}: 検索エラー（バリデーション）` });
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
            const perPage = parseInt(pageText[2], 10) - parseInt(pageText[1], 10) + 1;
            if (perPage > 0) pageInfo.totalPages = Math.ceil(pageInfo.totalItems / perPage);
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
    if (!isTest && customerSeenIds.some(id => id.includes(result.propertyNumber))) {
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

    totalDetailCount++;
    await setStorageData({ debugLog: `${customer.name}: p${currentPage}/${totalPages} 物件${totalDetailCount}/${maxDetails} 詳細取得中 (${result.buildingName} ${result.floor})` });

    try {
      // 詳細ボタンをクリック（物件番号で行を特定 — 再検索復帰後もindexズレしない）
      const clickResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: (propNum) => {
          const rows = document.querySelectorAll('.p-table-body-row');
          for (const row of rows) {
            if (row.textContent.includes(propNum)) {
              const detailBtn = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '詳細');
              if (detailBtn) { detailBtn.click(); return true; }
            }
          }
          // フォールバック: 全ての詳細ボタンから探す
          const allBtns = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '詳細');
          // 物件番号に近い行の詳細ボタンを探す
          for (const btn of allBtns) {
            const parentRow = btn.closest('.p-table-body-row');
            if (parentRow && parentRow.textContent.includes(propNum)) {
              btn.click(); return true;
            }
          }
          return false;
        },
        args: [result.propertyNumber]
      });
      if (!clickResult?.[0]?.result) {
        await setStorageData({ debugLog: `${customer.name}: ✗ ${result.buildingName} ${result.floor} 詳細ボタンが見つからない→スキップ` });
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
          const building = getVal('建物名');
          const roomNumber = getVal('部屋番号');
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
            address: [pref, addr1, addr2].filter(Boolean).join(''),
            rent: rentRaw ? parseFloat(rentRaw.replace(/[^\d.]/g, '')) * (rentRaw.includes('万') ? 10000 : 1) : 0,
            management_fee: totalMgmtFee,
            layout: getVal('間取タイプ') || '',
            area: parseFloat((area || '').replace(/[^\d.]/g, '')) || 0,
            floor: parseInt((floorLoc || '').match(/\d+/)?.[0] || '0'),
            floor_text: floorLoc || '',
            story_text: floorAbove ? floorAbove + '建' : '',
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
            deposit: getVal('敷金') || '',
            key_money: getVal('礼金') || '',
            facilities: getVal('設備・条件・住宅性能等') || '',
            sunlight: getVal('バルコニー方向') || '',
            lease_type: getVal('取引態様') || '',
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
            reins_property_number: propertyNumber,
            reins_shougo: getVal('商号') || '',
            reins_tel: getVal('電話番号') || '',
            source: 'reins'
          };
        }
      });

      const detail = detailResults && detailResults[0] && detailResults[0].result;
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
            await sendDiscordNotification(customer.name, [detail], customer);
          } catch (err) {
            logError(`${customer.name}: ${detail.building_name} ${detail.room_number || ''} Discord通知失敗: ${err.message}`);
          }
          await setStorageData({ stats: currentStats });
        } else {
          await setStorageData({ debugLog: `${customer.name}: ✗ スキップ: ${detail.building_name} ${detail.room_number || ''} - ${rejectReason}` });
        }
      }

      // 検索結果に戻る（Vue Router経由で戻る。history.back()だと2回戻ってGBK001310に行く場合がある）
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          // まずVue Routerのback()を試す（SPAの履歴管理に準拠）
          const nuxt = window.$nuxt;
          if (nuxt?.$router) { nuxt.$router.back(); return; }
          // フォールバック
          const backBtn = document.querySelector('.p-btn-back')
            || [...document.querySelectorAll('button')].find(el => el.textContent.trim() === '←');
          if (backBtn) { backBtn.click(); return; }
          history.back();
        }
      });
      // 検索結果一覧(GBK002200)に戻るまで待つ
      let backSuccess = false;
      for (let bw = 0; bw < 10; bw++) {
        await csleep(2000);
        const bt = await chrome.tabs.get(tabId);
        if (bt.url?.includes('GBK002200')) { backSuccess = true; break; }
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
        if (data.debugLog.length > 10000) data.debugLog = data.debugLog.slice(-10000);
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

  return lines.join('\n');
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
    }

    // 物件ごとに送信
    for (let i = 0; i < properties.length; i++) {
      const msg = buildDiscordMessage(properties[i], i + 1, gasWebappUrl, customerName, customer);
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

  const sourceTag = prop.source === 'ielove' ? 'いえらぶ' : 'REINS';
  const lines = [`**${index}. ${title}** \`[${sourceTag}]\``];

  // 検索URL（いえらぶ等、search_urlがある場合）
  if (prop.search_url) {
    lines.push(`🔍 [検索結果](${prop.search_url})`);
  }

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
    warnings.push('⚠️ 最上階条件あり: 階数情報不足のため要確認');
  }
  if ((equip.includes('2階以上') || equip.includes('1階')) && floorNum === 0) {
    warnings.push('⚠️ 階数条件あり: 所在階情報なしのため要確認');
  }
  if (equip.includes('南向き') && !prop.sunlight) {
    warnings.push('⚠️ 南向き条件あり: 採光面情報なしのため要確認');
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

  // 詳細ページURL
  if (prop.url) {
    lines.push(`🔗 [詳細ページ](${prop.url})`);
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
}
