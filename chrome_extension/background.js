/**
 * background.js (Service Worker)
 * REINS物件自動取得の中核 — スケジューリング、検索オーケストレーション、状態管理
 *
 * 重要な技術的制約:
 * - REINSはVue 2 SPA。execute()をJS直接呼び出しすると認証エラーになる
 * - 条件セットはVue $dataに直接代入（scriptタグ注入・MAIN world）
 * - 検索実行・OKダイアログはDOMクリック（人間操作と同じ）
 * - 検索フォームへの遷移はURL直接遷移NG → メニューボタンクリック経由
 */

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
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(url.toString(), { redirect: 'follow', signal: controller.signal });
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
  return properties.filter(prop => {
    // 構造フィルタ（structures が空なら全通過）
    if (customer.structures && customer.structures.length > 0) {
      if (!prop.structure) return false;
      const structMatch = customer.structures.some(s => prop.structure.includes(s));
      if (!structMatch) return false;
    }

    // 駅名＋徒歩フィルタ（station_infoに複数交通が「/」区切りで入っている）
    // routes_with_stations から全駅リストを構築
    let allStations = customer.stations || [];
    if (customer.routes_with_stations && customer.routes_with_stations.length > 0) {
      const rwsStations = customer.routes_with_stations.flatMap(r => r.stations || []);
      if (rwsStations.length > 0) allStations = rwsStations;
    }

    if (allStations.length > 0 && prop.station_info) {
      // 交通情報を「/」で分割して各交通をチェック
      const transports = prop.station_info.split('/').map(s => s.trim());
      const walkMax = customer.walk ? parseInt(String(customer.walk).replace(/[^\d]/g, '')) : 0;

      // 指定駅のいずれかが含まれ、かつ徒歩分数以内の交通があるかチェック
      const hasMatch = transports.some(transport => {
        const stationMatch = allStations.some(s => transport.includes(s));
        if (!stationMatch) return false;
        // 徒歩チェック（walkMaxが指定されている場合のみ）
        if (walkMax > 0) {
          const walkMatch = transport.match(/徒歩\s*(\d+)/);
          if (walkMatch) {
            const propWalk = parseInt(walkMatch[1]);
            if (propWalk > walkMax) return false;
          }
        }
        return true;
      });
      if (!hasMatch) return false;
    } else if (allStations.length > 0 && !prop.station_info) {
      return false;
    }

    return true;
  });
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
    chrome.storage.local.set({ isSearching: false, debugLog: '検索を中止しました' });
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'REFRESH_CRITERIA') {
    refreshCriteria().then(() => sendResponse({ ok: true })).catch(err => sendResponse({ error: err.message }));
    return true;
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
    if (result && result.criteria) {
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
  const { isSearching, gasWebappUrl } = await getStorageData(['isSearching', 'gasWebappUrl']);
  if (isSearching) { console.log('検索中のためスキップ'); return; }
  if (!gasWebappUrl) { console.log('GAS URL未設定のためスキップ'); return; }

  const searchId = ++currentSearchId;
  // DiscordスレッドIDキャッシュをクリア
  Object.keys(discordThreadIds).forEach(k => delete discordThreadIds[k]);
  // ログをクリアして新規開始
  await new Promise(resolve => chrome.storage.local.set({ debugLog: '' }, resolve));
  await setStorageData({ isSearching: true, debugLog: '検索開始...' });

  try {
    const reinsTab = await findReinsTab();
    if (!reinsTab) {
      await setStorageData({ loginDetected: false, debugLog: 'REINSタブが見つかりません' });
      return;
    }
    await setStorageData({ debugLog: `REINSタブ発見: tabId=${reinsTab.id}, url=${reinsTab.url}` });

    // 検索条件を取得
    await setStorageData({ debugLog: '検索条件を取得中...' });
    const { customerCriteria, lastCriteriaFetch } = await getStorageData(['customerCriteria', 'lastCriteriaFetch']);
    if (!customerCriteria || !lastCriteriaFetch || (Date.now() - lastCriteriaFetch > 3600000)) {
      try {
        await refreshCriteria();
      } catch (err) {
        await setStorageData({ debugLog: `検索条件取得失敗: ${err.message}` });
        return;
      }
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

    const { pageDelaySeconds } = await getStorageData(['pageDelaySeconds']);
    const delay = (pageDelaySeconds || 2) * 1000;

    // 全顧客を順次検索
    for (let ci = 0; ci < criteria.length; ci++) {
      // 中止チェック（searchIdが変わっていたら古いサイクルなので即終了）
      if (isSearchCancelled(searchId)) {
        console.log(`検索サイクル${searchId}は中止されました`);
        return;
      }

      const customer = criteria[ci];
      await setStorageData({ debugLog: `顧客 ${ci+1}/${criteria.length}: ${customer.name}` });
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
            await setStorageData({ debugLog: `${customer.name}: バッチ ${batch+1}/${Math.ceil(rws.length/3)} (${batchRws.map(r=>r.route).join(', ')})` });
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
        logError(`${customer.name}の検索失敗: ${err.message}`);
      }
      // 顧客間の待ち時間
      if (ci < criteria.length - 1) await sleep(3000);
    }

    await setStorageData({ lastSearchTime: Date.now() });
  } catch (err) {
    logError('検索サイクルエラー: ' + err.message);
  } finally {
    await setStorageData({ isSearching: false });
  }
}

// === 顧客ごとの検索 ===
async function searchForCustomer(tabId, customer, seenIds, delay, searchId) {
  // 中止チェック付きsleep（中止されたら例外で即脱出）
  const csleep = async (ms) => {
    await sleep(ms);
    if (isSearchCancelled(searchId)) throw new Error('SEARCH_CANCELLED');
  };

  await setStorageData({ debugLog: `検索開始: ${customer.name}` });
  const customerSeenIds = seenIds[customer.name] || [];

  // --- Step 1: 検索フォームに移動 ---
  // URL直接遷移はREINSの認証コンテキストが失われるためNG
  // メインメニューの「賃貸 物件検索」ボタンをクリックして正規遷移する
  // ただし既にGBK001310にいる場合はスキップ
  const currentTab = await chrome.tabs.get(tabId);
  if (!currentTab.url?.includes('GBK001310')) {
    await setStorageData({ debugLog: `${customer.name}: 検索フォームに移動中...` });

    // まずメインメニューに移動（右サイドバーの「賃貸物件検索」リンクをクリック）
    // GBK002200（結果ページ）やメインメニューからでも、サイドバーリンクで遷移可能
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // サイドバーの「賃貸物件検索」リンクをクリック
        const links = [...document.querySelectorAll('a, button')];
        const rentLink = links.find(el => {
          const text = el.textContent.trim();
          return text === '賃貸物件検索' || (text.includes('賃貸') && text.includes('物件検索'));
        });
        if (rentLink) { rentLink.click(); return 'clicked'; }
        // メインメニューのボタンを試す
        const btn = links.find(el => el.textContent.includes('賃貸') && el.textContent.includes('検索'));
        if (btn) { btn.click(); return 'clicked_btn'; }
        return 'not_found';
      }
    });

    // GBK001310への遷移とVue描画完了を待つ
    for (let w = 0; w < 30; w++) {
      if (isSearchCancelled(searchId)) return;
      await csleep(2000);
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.url?.includes('GBK001310')) {
          // さらにVueのフォームが描画されるまで待つ
          const ready = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              const labels = document.querySelectorAll('.p-label-title');
              return labels.length > 10; // フォームのラベルが10個以上あれば描画完了
            }
          });
          if (ready?.[0]?.result) break;
        }
      } catch (_) {}
    }
    await csleep(3000); // Vue完全初期化待ち
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

          let reinsLineName = lineNameMap[lineName];
          if (!reinsLineName) {
            // フォールバック1: "東京メトロ 東西線" ← "東京メトロ東西線" (スペースあり/なし)
            const fbKey = Object.keys(lineNameMap).find(k => {
              if (k.endsWith(' ' + lineName)) return true;
              // スペース除去して比較
              if (k.replace(/\s/g, '') === lineName.replace(/\s/g, '')) return true;
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

      return {
        success: true,
        bkknShbt1: vr.bkknShbt1,
        ensnCd1: vr.ensnCd1,
        kkkuCnryuTo: vr.kkkuCnryuTo,
        mdrTyp: vr.mdrTyp,
        mdrHysuFrom: vr.mdrHysuFrom,
        mdrHysuTo: vr.mdrHysuTo,
        snyuMnskFrom: vr.snyuMnskFrom,
        buildingAge: customerData.building_age || ''
      };
    },
    args: [stationStr, { rent_max: customer.rent_max, layouts: customer.layouts || [], area_min: customer.area_min || '', building_age: customer.building_age || '', stations: customer.stations || [], routes_with_stations: customer.routes_with_stations || [], walk: customer.walk || '' }, lineNameMap, reinsCodeMap]
  });

  const setStatus = setResult?.[0]?.result;
  if (!setStatus?.success) {
    await setStorageData({ debugLog: `${customer.name}: 条件セットエラー: ${JSON.stringify(setStatus)}` });
    return;
  }
  await setStorageData({ debugLog: `${customer.name}: 条件セット完了 shbt=${setStatus.bkknShbt1} ensn=${setStatus.ensnCd1} rent=${setStatus.kkkuCnryuTo} mdrTyp=[${setStatus.mdrTyp}] rooms=${setStatus.mdrHysuFrom}-${setStatus.mdrHysuTo} area=${setStatus.snyuMnskFrom || '-'}~ age=${setStatus.buildingAge || '-'} walk=${customer.walk || '-'}` });

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
  // 500件超 → 確認ダイアログ(OKクリック) → 結果ページ
  // 500件以下 → 直接結果ページ
  // 0件 → 結果ページ(0件表示)
  for (let d = 0; d < 30; d++) {
    if (isSearchCancelled(searchId)) return;
    await csleep(3000);
    try {
      const tab = await chrome.tabs.get(tabId);

      // 結果ページに遷移済み
      if (tab.url?.includes('GBK002200')) {
        await setStorageData({ debugLog: `${customer.name}: 結果ページに遷移` });
        break;
      }

      // エラーページ
      if (tab.url && !tab.url.includes('GBK001310') && !tab.url.includes('reins.jp')) {
        await setStorageData({ debugLog: `${customer.name}: 予期しないURL: ${tab.url}` });
        return;
      }

      // OKダイアログ検出 → DOMクリック
      const dialogResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // バリデーションエラー
          const dialogs = document.querySelectorAll('[role="dialog"], .modal.show');
          for (const dialog of dialogs) {
            const text = dialog.textContent;
            if (text.includes('入力に誤り') || text.includes('権限')) return 'error';
            // 0件ダイアログ: 該当する物件がない場合
            if (text.includes('該当') && (text.includes('ありません') || text.includes('０件') || text.includes('0件'))) {
              const okBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
              if (okBtn) { okBtn.click(); return 'no_results'; }
            }
            if (text.includes('500件') || text.includes('超えています')) {
              // OKボタンをクリック
              const okBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
              if (okBtn) { okBtn.click(); return 'ok_clicked'; }
            }
          }
          return 'waiting';
        }
      });

      const status = dialogResult?.[0]?.result;
      await setStorageData({ debugLog: `${customer.name}: ダイアログ${d+1}: ${status}` });
      if (status === 'error') return;
      if (status === 'no_results') {
        await setStorageData({ debugLog: `${customer.name}: 該当物件なし（0件）` });
        return;
      }
      if (status === 'ok_clicked') {
        // OKクリック後の遷移を待つ
        for (let w = 0; w < 20; w++) {
          await csleep(2000);
          const t = await chrome.tabs.get(tabId);
          await setStorageData({ debugLog: `${customer.name}: 遷移待ち${w+1}: url=${t.url?.split('/').pop()}` });
          if (t.url?.includes('GBK002200')) break;
        }
        break;
      }
    } catch (err) {
      await setStorageData({ debugLog: `${customer.name}: ダイアログ${d+1}エラー: ${err.message}` });
    }
  }

  // --- Step 5: 検索結果のDOM描画待ち ---
  await setStorageData({ debugLog: `${customer.name}: 検索結果待ち...` });

  // タブURLがGBK002200か確認
  const tabCheck = await chrome.tabs.get(tabId);
  if (!tabCheck.url?.includes('GBK002200')) {
    await setStorageData({ debugLog: `${customer.name}: 結果ページに遷移していません (URL=${tabCheck.url})` });
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

          // 「詳細」ボタンを持つ行を探す
          const detailBtns = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '詳細');
          const data = [];
          detailBtns.forEach((btn, index) => {
            const row = btn.closest('tr') || btn.closest('[class*="row"]') || btn.parentElement?.parentElement;
            if (!row) return;
            const text = row.textContent;
            const propNumMatch = text.match(/\b(100\d{8,})\b/);
            data.push({
              index,
              propertyNumber: propNumMatch ? propNumMatch[1] : '',
              text: text.substring(0, 200)
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
    if (!isTest && customerSeenIds.some(id => id.includes(result.propertyNumber))) continue;

    totalDetailCount++;
    await setStorageData({ debugLog: `${customer.name}: p${currentPage}/${totalPages} 物件${totalDetailCount}/${maxDetails} 詳細取得中 (${result.propertyNumber})` });

    try {
      // 詳細ボタンをクリック
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (idx) => {
          const detailBtns = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '詳細');
          if (idx < detailBtns.length) detailBtns[idx].click();
        },
        args: [result.index]
      });
      await waitForTabLoad(tabId);
      await csleep(delay);

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
          const mgmtFee = getVal('管理費') || getVal('共益費');
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
            management_fee: mgmtFee ? parseFloat(mgmtFee.replace(/[^\d.]/g, '')) || 0 : 0,
            layout: getVal('間取タイプ') || '',
            area: parseFloat((area || '').replace(/[^\d.]/g, '')) || 0,
            floor: parseInt((floorLoc || '').match(/\d+/)?.[0] || '0'),
            floor_text: floorLoc || '',
            story_text: floorAbove ? floorAbove + '建' : '',
            structure: structure || '',
            building_age: builtDate || '',
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
            move_in_date: getVal('入居可能時期') || getVal('引渡可能時期') || '',
            total_units: getVal('総戸数') || '',
            reins_property_number: propertyNumber,
            reins_shougo: getVal('商号') || '',
            reins_tel: getVal('電話番号') || '',
            source: 'reins'
          };
        }
      });

      const detail = detailResults && detailResults[0] && detailResults[0].result;
      if (detail) {
        const passFilter = filterByCustomerCriteria([detail], customer).length > 0;
        if (passFilter) {
          newProperties.push(detail);
          currentStats.totalFound++;
          // リアルタイムでGAS送信＋Discord通知
          try {
            const submitResult = await submitProperties(customer.name, [detail]);
            if (submitResult?.success) {
              currentStats.totalSubmitted += submitResult.added || 1;
              await setStorageData({ debugLog: `${customer.name}: 物件${detail.reins_property_number} GAS送信完了` });
            }
          } catch (err) {
            logError(`${customer.name}: 物件${detail.reins_property_number} GAS送信失敗: ${err.message}`);
          }
          try {
            await sendDiscordNotification(customer.name, [detail], customer);
          } catch (err) {
            logError(`${customer.name}: 物件${detail.reins_property_number} Discord通知失敗: ${err.message}`);
          }
          await setStorageData({ stats: currentStats });
        }
      }

      // 検索結果に戻る（REINSのSPAでは goBack だと検索フォームに戻る場合がある）
      // 詳細ページの「←」戻るボタンをクリック
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // 「←」ボタン（左上の戻るアイコン）をクリック
          const backBtn = document.querySelector('.p-btn-back, [class*="back"]')
            || [...document.querySelectorAll('button, a')].find(el => el.textContent.trim() === '←' || el.textContent.includes('戻る'));
          if (backBtn) { backBtn.click(); return; }
          // フォールバック: ブラウザ履歴で戻る
          history.back();
        }
      });
      // 検索結果一覧(GBK002200)に戻るまで待つ
      for (let bw = 0; bw < 15; bw++) {
        await csleep(2000);
        const bt = await chrome.tabs.get(tabId);
        if (bt.url?.includes('GBK002200')) break;
      }
      await csleep(delay);

    } catch (err) {
      if (err.message === 'SEARCH_CANCELLED') throw err;
      await setStorageData({ debugLog: `${customer.name}: 物件${result.propertyNumber}の詳細取得失敗: ${err.message}` });
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const backBtn = document.querySelector('.p-btn-back, [class*="back"]')
              || [...document.querySelectorAll('button, a')].find(el => el.textContent.trim() === '←' || el.textContent.includes('戻る'));
            if (backBtn) backBtn.click(); else history.back();
          }
        });
        for (let bw = 0; bw < 15; bw++) {
          await csleep(2000);
          const bt = await chrome.tabs.get(tabId);
          if (bt.url?.includes('GBK002200')) break;
        }
        await csleep(delay);
      } catch(e) { if (e.message === 'SEARCH_CANCELLED') throw e; }
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

async function findReinsTab() {
  const tabs = await chrome.tabs.query({ url: 'https://system.reins.jp/*' });
  return tabs.length > 0 ? tabs[0] : null;
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
  });
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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
      const msg = buildDiscordMessage(properties[i], i + 1, gasWebappUrl, customerName);
      await discordPostWithRetry(`${discordWebhookUrl}?thread_id=${threadId}`, { content: msg });
      if (i < properties.length - 1) await sleep(1000);
    }

    console.log(`Discord通知完了: ${customerName} ${properties.length}件`);
  } catch (err) {
    console.error(`Discord通知失敗: ${err.message}`);
  }
}

async function discordPostWithRetry(url, payload) {
  let resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (resp.status === 429) {
    const data = await resp.json();
    const retryAfter = (data.retry_after || 5) * 1000;
    console.warn(`Discord レート制限。${retryAfter}ms待機...`);
    await sleep(retryAfter);
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  if (!resp.ok && resp.status !== 204) {
    console.error(`Discord送信エラー: status=${resp.status}`);
  }
}

function buildDiscordMessage(prop, index, gasWebappUrl, customerName) {
  const fmtMan = (yen) => {
    if (!yen) return '0';
    const v = yen / 10000;
    return String(parseFloat(v.toFixed(4)));
  };

  let title = prop.building_name || '物件情報';
  if (prop.room_number) title += `  ${prop.room_number}`;

  const lines = [`**${index}. ${title}** \`[REINS]\``];

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

  if (prop.deposit || prop.key_money) {
    lines.push(`💴 敷金: ${prop.deposit || 'なし'} / 礼金: ${prop.key_money || 'なし'}`);
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
