/**
 * background.js (Service Worker)
 * REINS物件自動取得の中核 — スケジューリング、検索オーケストレーション、状態管理
 */

importScripts('lib/gas-client.js');

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

  await setStorageData({ isSearching: true });

  try {
    // REINSタブを探す
    const reinsTab = await findReinsTab();
    if (!reinsTab) {
      console.log('REINSタブが見つかりません');
      await setStorageData({ loginDetected: false });
      return;
    }

    // ログイン確認
    const loginResult = await sendTabMessage(reinsTab.id, { type: 'CHECK_LOGIN' });
    if (!loginResult || !loginResult.loggedIn) {
      console.log('REINSにログインしていません');
      await setStorageData({ loginDetected: false });
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

// --- 顧客ごとの検索 ---
async function searchForCustomer(tabId, customer, seenIds, delay) {
  console.log(`検索開始: ${customer.name}`);
  const customerSeenIds = seenIds[customer.name] || [];

  // 1. 検索フォームページ（GBK001310）に移動
  await chrome.tabs.update(tabId, { url: 'https://system.reins.jp/main/BK/GBK001310' });
  await waitForTabLoad(tabId);
  await sleep(delay);

  // 2. 検索条件を入力
  // 顧客の条件から検索フォームに入力するデータを構築
  const formCriteria = buildFormCriteria(customer);
  try {
    await sendTabMessage(tabId, { type: 'FILL_SEARCH_FORM', criteria: formCriteria });
    await sleep(1000);
  } catch (err) {
    console.log(`検索フォーム入力失敗: ${err.message}`);
    return;
  }

  // 3. 検索実行
  try {
    await sendTabMessage(tabId, { type: 'SUBMIT_SEARCH' });
  } catch (err) {
    console.log(`検索実行失敗: ${err.message}`);
    return;
  }
  await waitForTabLoad(tabId);
  await sleep(delay);

  // 500件超の確認ダイアログが出る場合がある（Vueのモーダル）
  // OKボタンを探してクリック
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const okBtn = [...document.querySelectorAll('button')].find(
          b => b.textContent.trim() === 'OK'
        );
        if (okBtn) okBtn.click();
      }
    });
    await waitForTabLoad(tabId);
    await sleep(delay);
  } catch (_) {}

  // 4. 検索結果ページ（GBK002200）でデータ抽出
  let searchResults;
  try {
    searchResults = await sendTabMessage(tabId, { type: 'EXTRACT_SEARCH_RESULTS' });
  } catch (err) {
    console.log(`検索結果抽出失敗: ${err.message}`);
    return;
  }

  if (!searchResults || !searchResults.success || !searchResults.results || searchResults.results.length === 0) {
    console.log(`${customer.name}: 検索結果なし`);
    return;
  }

  const { stats } = await getStorageData(['stats']);
  const currentStats = stats || { totalFound: 0, totalSubmitted: 0, errors: [], lastError: null };

  // 5. 各物件の詳細を取得
  const newProperties = [];

  for (const result of searchResults.results) {
    // 重複チェック（物件番号ベース）
    const roomId = `reins_${result.propertyNumber}_no_room`;
    if (customerSeenIds.includes(roomId) ||
        customerSeenIds.some(id => id.includes(result.propertyNumber))) {
      console.log(`スキップ（既知）: ${result.propertyNumber}`);
      continue;
    }

    // 詳細ボタンをクリックして遷移
    try {
      await sendTabMessage(tabId, { type: 'CLICK_DETAIL_BUTTON', index: result.index });
      await waitForTabLoad(tabId);
      await sleep(delay);

      // 詳細データ抽出
      const detailResult = await sendTabMessage(tabId, { type: 'EXTRACT_PROPERTY_DETAIL' });
      if (detailResult && detailResult.success && detailResult.data) {
        newProperties.push(detailResult.data);
        currentStats.totalFound++;
      }

      // 検索結果に戻る（ブラウザバック）
      await chrome.tabs.goBack(tabId);
      await waitForTabLoad(tabId);
      await sleep(delay);

    } catch (err) {
      console.error(`物件 ${result.propertyNumber} の詳細取得失敗:`, err.message);
      try {
        await chrome.tabs.goBack(tabId);
        await waitForTabLoad(tabId);
        await sleep(delay);
      } catch (_) {}
    }
  }

  // 6. GASに送信
  if (newProperties.length > 0) {
    try {
      const submitResult = await submitProperties(customer.name, newProperties);
      if (submitResult && submitResult.success) {
        currentStats.totalSubmitted += submitResult.added || newProperties.length;
        console.log(`${customer.name}: ${newProperties.length}件送信完了`);
      }
    } catch (err) {
      logError(`${customer.name}のGAS送信失敗: ${err.message}`);
    }
  }

  await setStorageData({ stats: currentStats });
}

// --- 顧客条件 → 検索フォーム入力データに変換 ---
function buildFormCriteria(customer) {
  const criteria = {
    prefecture: '東京都'  // デフォルト東京
  };

  // 市区町村（最初の1つを使用）
  if (customer.cities && customer.cities.length > 0) {
    criteria.city = customer.cities[0];
  }

  // 駅名（最初の1つを使用）
  if (customer.stations && customer.stations.length > 0) {
    criteria.stationName = customer.stations[0];
  }

  return criteria;
}

// --- ユーティリティ ---

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
