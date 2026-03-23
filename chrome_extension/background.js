/**
 * background.js (Service Worker)
 * REINS物件自動取得の中核 — スケジューリング、検索オーケストレーション、状態管理
 */

// === GAS API クライアント（inline） ===
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['gasWebappUrl', 'gasApiKey'], resolve);
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
  const resp = await fetch(url.toString(), { redirect: 'follow' });
  if (!resp.ok) throw new Error(`GAS応答エラー: ${resp.status}`);
  return resp.json();
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

// --- 初期化 ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['searchIntervalMinutes'], (data) => {
    setupAlarm(data.searchIntervalMinutes || 30);
  });
  // 初期統計
  chrome.storage.local.get(['stats'], (data) => {
    if (!data.stats) {
      chrome.storage.local.set({
        stats: { totalFound: 0, totalSubmitted: 0, errors: [], lastError: null }
      });
    }
  });
});

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
  // 排他制御
  const { isSearching, gasWebappUrl } = await getStorageData(['isSearching', 'gasWebappUrl']);
  if (isSearching) {
    console.log('検索中のためスキップ');
    return;
  }
  if (!gasWebappUrl) {
    console.log('GAS URL未設定のためスキップ');
    return;
  }

  await setStorageData({ isSearching: true, debugLog: '検索開始...' });

  try {
    // REINSタブを探す
    const reinsTab = await findReinsTab();
    if (!reinsTab) {
      console.log('REINSタブが見つかりません');
      await setStorageData({ loginDetected: false, debugLog: 'REINSタブが見つかりません' });
      return;
    }
    await setStorageData({ debugLog: `REINSタブ発見: tabId=${reinsTab.id}, url=${reinsTab.url}` });

    // ログイン確認（scripting APIで直接チェック）
    const loggedIn = await checkReinsLogin(reinsTab.id);
    if (!loggedIn) {
      console.log('REINSにログインしていません');
      await setStorageData({ loginDetected: false, debugLog: `ログインチェック失敗: tabId=${reinsTab.id}` });
      showNotification('REINS未ログイン', 'REINSにログインしてください');
      return;
    }
    await setStorageData({ loginDetected: true });

    // 検索条件を取得（キャッシュが1時間以内なら再利用）
    const { customerCriteria, lastCriteriaFetch } = await getStorageData(['customerCriteria', 'lastCriteriaFetch']);
    if (!customerCriteria || !lastCriteriaFetch || (Date.now() - lastCriteriaFetch > 3600000)) {
      await refreshCriteria();
    }
    const { customerCriteria: criteria } = await getStorageData(['customerCriteria']);
    if (!criteria || criteria.length === 0) {
      console.log('検索条件がありません');
      return;
    }

    // 既知の物件IDを取得（重複排除）
    let seenIds = {};
    try {
      const seenResult = await fetchSeenIds();
      if (seenResult && seenResult.seen_ids) {
        seenIds = seenResult.seen_ids; // { customer_name: [room_id, ...] }
      }
    } catch (err) {
      logError('既知物件ID取得失敗: ' + err.message);
    }

    // 各顧客の条件で検索を実行
    const { pageDelaySeconds } = await getStorageData(['pageDelaySeconds']);
    const delay = (pageDelaySeconds || 5) * 1000;

    for (const customer of criteria) {
      try {
        await searchForCustomer(reinsTab.id, customer, seenIds, delay);
      } catch (err) {
        logError(`${customer.name}の検索失敗: ${err.message}`);
      }
    }

    await setStorageData({ lastSearchTime: Date.now() });

  } catch (err) {
    logError('検索サイクルエラー: ' + err.message);
  } finally {
    await setStorageData({ isSearching: false });
  }
}

// --- 顧客ごとの検索（全てchrome.scripting.executeScriptで実行） ---
async function searchForCustomer(tabId, customer, seenIds, delay) {
  await setStorageData({ debugLog: `検索開始: ${customer.name}` });
  const customerSeenIds = seenIds[customer.name] || [];

  // 1. 検索フォームページ（GBK001310）に移動
  await chrome.tabs.update(tabId, { url: 'https://system.reins.jp/main/BK/GBK001310' });
  await waitForTabLoad(tabId);
  await sleep(delay);
  await setStorageData({ debugLog: `${customer.name}: 検索フォームに移動完了` });

  // 2. 検索条件を入力（scripting APIで直接DOM操作）
  const city = (customer.cities && customer.cities[0]) || '';
  const station = (customer.stations && customer.stations[0]) || '';
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (city, station) => {
        // 物件種別1: 賃貸マンション(03)を選択
        const selects = document.querySelectorAll('select');
        for (const sel of selects) {
          const opt = [...sel.options].find(o => o.value === '03' && o.text.includes('賃貸マンション'));
          if (opt) { sel.value = '03'; sel.dispatchEvent(new Event('change', {bubbles:true})); break; }
        }
        // 都道府県名
        const inputs = document.querySelectorAll('input[type="text"]');
        const setVal = (input, val) => { input.value = val; input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true})); };
        // ラベルで入力フィールドを特定
        inputs.forEach(inp => {
          const container = inp.closest('div')?.parentElement;
          if (!container) return;
          const text = container.textContent;
          if (text.includes('都道府県名') && !inp.value) setVal(inp, '東京都');
          if (text.includes('所在地名１') && city && !inp.value) setVal(inp, city);
        });
      },
      args: [city, station]
    });
    await sleep(1000);
  } catch (err) {
    await setStorageData({ debugLog: `${customer.name}: フォーム入力失敗: ${err.message}` });
    return;
  }
  await setStorageData({ debugLog: `${customer.name}: フォーム入力完了、検索実行中...` });

  // 3. 検索実行
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '検索');
        if (btn) btn.click();
      }
    });
  } catch (err) {
    await setStorageData({ debugLog: `${customer.name}: 検索ボタンクリック失敗: ${err.message}` });
    return;
  }
  await sleep(3000); // 検索実行待ち

  // 500件超の確認ダイアログ: OKボタンをクリック
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const okBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
        if (okBtn) okBtn.click();
      }
    });
  } catch (_) {}
  await waitForTabLoad(tabId);
  await sleep(delay);
  await setStorageData({ debugLog: `${customer.name}: 検索結果ページ到達` });

  // 4. 検索結果ページでデータ抽出（scripting API）
  let searchResults = [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const rows = document.querySelectorAll('.p-table-body-row');
        const data = [];
        rows.forEach((row, index) => {
          const items = row.querySelectorAll(':scope > .p-table-body-item');
          if (items.length < 20) return;
          const getText = el => el ? el.textContent.trim() : '';
          data.push({
            index,
            propertyNumber: getText(items[3]),
            buildingName: getText(items[11]),
            rent: getText(items[8]),
            layout: getText(items[13]),
            address: getText(items[6])
          });
        });
        return data;
      }
    });
    searchResults = (results && results[0] && results[0].result) || [];
  } catch (err) {
    await setStorageData({ debugLog: `${customer.name}: 検索結果抽出失敗: ${err.message}` });
    return;
  }

  if (searchResults.length === 0) {
    await setStorageData({ debugLog: `${customer.name}: 検索結果0件` });
    return;
  }
  await setStorageData({ debugLog: `${customer.name}: ${searchResults.length}件の検索結果` });

  const { stats } = await getStorageData(['stats']);
  const currentStats = stats || { totalFound: 0, totalSubmitted: 0, errors: [], lastError: null };

  // 5. 最初の5件のみ詳細を取得（レート制限のため）
  const maxDetails = 5;
  const newProperties = [];

  for (let i = 0; i < Math.min(searchResults.length, maxDetails); i++) {
    const result = searchResults[i];
    if (!result.propertyNumber) continue;

    // 重複チェック
    if (customerSeenIds.some(id => id.includes(result.propertyNumber))) {
      continue;
    }

    await setStorageData({ debugLog: `${customer.name}: 物件${i+1}/${Math.min(searchResults.length, maxDetails)} 詳細取得中 (${result.propertyNumber})` });

    // 詳細ボタンをクリック
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (idx) => {
          const rows = document.querySelectorAll('.p-table-body-row');
          if (idx < rows.length) {
            const btns = rows[idx].querySelectorAll('button');
            if (btns[1]) btns[1].click(); // 詳細ボタン
          }
        },
        args: [result.index]
      });
      await waitForTabLoad(tabId);
      await sleep(delay);

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
            if (label === '物件種目') return container.querySelector('.row .col-sm-2.col-5')?.textContent.trim() || '';
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
            rent: rentRaw ? Math.round(parseFloat(rentRaw.replace(/[^\d.]/g, '')) * (rentRaw.includes('万') ? 10000 : 1)) : 0,
            management_fee: mgmtFee ? parseInt(mgmtFee.replace(/[^\d]/g, '')) || 0 : 0,
            layout: getVal('間取タイプ') || '',
            area: parseFloat((area || '').replace(/[^\d.]/g, '')) || 0,
            floor: parseInt((floorLoc || '').match(/\d+/)?.[0] || '0'),
            floor_text: floorLoc || '',
            story_text: floorAbove ? floorAbove + '建' : '',
            structure: structure || '',
            building_age: builtDate || '',
            station_info: '',
            room_number: roomNumber || '',
            deposit: getVal('敷金') || '',
            key_money: getVal('礼金') || '',
            facilities: getVal('設備・条件・住宅性能等') || '',
            sunlight: getVal('バルコニー方向') || '',
            reins_property_number: propertyNumber,
            source: 'reins'
          };
        }
      });

      const detail = detailResults && detailResults[0] && detailResults[0].result;
      if (detail) {
        newProperties.push(detail);
        currentStats.totalFound++;
      }

      // 検索結果に戻る
      await chrome.tabs.goBack(tabId);
      await waitForTabLoad(tabId);
      await sleep(delay);

    } catch (err) {
      await setStorageData({ debugLog: `${customer.name}: 物件${result.propertyNumber}の詳細取得失敗: ${err.message}` });
      try { await chrome.tabs.goBack(tabId); await waitForTabLoad(tabId); await sleep(delay); } catch(_) {}
    }
  }

  // 6. GASに送信
  if (newProperties.length > 0) {
    await setStorageData({ debugLog: `${customer.name}: ${newProperties.length}件をGASに送信中...` });
    try {
      const submitResult = await submitProperties(customer.name, newProperties);
      if (submitResult && submitResult.success) {
        currentStats.totalSubmitted += submitResult.added || newProperties.length;
        await setStorageData({ debugLog: `${customer.name}: ${submitResult.added || newProperties.length}件送信完了` });
      }
    } catch (err) {
      logError(`${customer.name}のGAS送信失敗: ${err.message}`);
    }
  } else {
    await setStorageData({ debugLog: `${customer.name}: 新規物件なし` });
  }

  await setStorageData({ stats: currentStats });
}

// --- ユーティリティ ---

async function checkReinsLogin(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // ログインページやエラーページでないことを確認
        const url = location.href;
        if (url.includes('login') || url.includes('GKG001')) return false;
        // メインメニューや物件ページが表示されていればログイン済み
        return document.body.textContent.length > 100;
      }
    });
    return results && results[0] && results[0].result === true;
  } catch (err) {
    console.error('ログインチェック失敗:', err.message);
    return false;
  }
}

async function findReinsTab() {
  const tabs = await chrome.tabs.query({ url: 'https://system.reins.jp/*' });
  return tabs.length > 0 ? tabs[0] : null;
}

function sendTabMessage(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
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
    // タイムアウト: 30秒
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getStorageData(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function setStorageData(data) {
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

async function logError(message) {
  console.error(message);
  const { stats } = await getStorageData(['stats']);
  const currentStats = stats || { totalFound: 0, totalSubmitted: 0, errors: [], lastError: null };
  currentStats.lastError = message;
  currentStats.errors.push({ time: Date.now(), message });
  // エラーログは最新10件のみ保持
  if (currentStats.errors.length > 10) {
    currentStats.errors = currentStats.errors.slice(-10);
  }
  await setStorageData({ stats: currentStats });
}
