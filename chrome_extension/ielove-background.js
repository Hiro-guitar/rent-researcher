/**
 * ielove-background.js
 * いえらぶBB 検索オーケストレーション（Service Worker用）
 * importScripts() で background.js から読み込まれる
 *
 * 依存: ielove-config.js（先にimportScripts）、background.jsの共通関数
 *  - sleep(), getStorageData(), setStorageData(), gasPost(), submitProperties()
 *  - sendDiscordNotification(), getFilterRejectReason(), waitForTabLoad()
 *  - isSearchCancelled(), logError()
 */

// いえらぶ専用ウィンドウ管理
let dedicatedIeloveTabId = null;
let dedicatedIeloveWindowId = null;

// === URL構築 ===

/**
 * CustomerCriteria から いえらぶBB 検索URLを構築する。
 * Python search.py:_build_search_url() の移植。
 */
function buildIeloveSearchUrl(customer, page = 1) {
  const parts = [
    `${IELOVE_BASE_URL}/ielovebb/rent/index`,
    `todofuken/${IELOVE_PREFECTURE_CODE}`,
  ];

  // 駅コード
  const stationCodes = resolveIeloveStationCodes(customer);
  if (stationCodes.length > 0) {
    parts.push(`lineTodofuken/${IELOVE_PREFECTURE_CODE}`);
    for (const code of stationCodes) {
      parts.push(`station/${code}`);
    }
  }

  // 賃料上限 (万円)
  if (customer.rent_max) {
    const rentMan = Math.floor(customer.rent_max / 10000);
    parts.push(`prct/${rentMan}`);
  }

  // 賃料下限 (万円)
  if (customer.rent_min) {
    const rentMinMan = Math.floor(customer.rent_min / 10000);
    parts.push(`prcf/${rentMinMan}`);
  }

  // 管理費込み
  parts.push('ikrh/1');

  // 専有面積下限
  if (customer.area_min) {
    parts.push(`barf/${parseFloat(customer.area_min).toFixed(2)}`);
  }

  // 駅徒歩
  const walkMinutes = customer.walk ? parseInt(String(customer.walk).replace(/[^\d]/g, '')) : 0;
  if (walkMinutes > 0) {
    parts.push(`wati1/${walkMinutes}`);
  }

  // 築年数
  if (customer.building_age) {
    const ageCode = resolveIeloveBuildingAge(customer.building_age);
    if (ageCode) parts.push(`buda/${ageCode}`);
  }

  // 間取り
  const layoutCodes = resolveIeloveLayouts(customer.layouts || []);
  for (const code of layoutCodes) {
    parts.push(`madori/${code}`);
  }

  // ハード設備（URLレベルで対応可能なもの）
  const equipIds = customer.equipment_ids || [];
  for (const eid of equipIds) {
    const opt = IELOVE_HARD_EQUIPMENT_OPTS[eid];
    if (opt) {
      parts.push(`${opt[0]}/${opt[1]}`);
    }
  }

  // ソート (更新が新しい順)
  parts.push('optt/2');

  // 1ページの表示件数 (最大200)
  parts.push('cnt/200');

  // ページ番号
  if (page > 1) {
    parts.push(`page/${page}`);
  }

  return parts.join('/') + '/';
}

/**
 * 顧客の駅名リストをいえらぶ駅コードに変換する。
 */
function resolveIeloveStationCodes(customer) {
  const codes = [];
  // routes_with_stations から全駅名を取得
  const rws = customer.routes_with_stations || [];
  let stationNames = [];

  if (rws.length > 0) {
    stationNames = rws.flatMap(r => r.stations || []);
  }
  if (stationNames.length === 0) {
    stationNames = customer.stations || [];
  }

  for (const name of stationNames) {
    // 「駅」を除去して検索
    const cleanName = name.replace(/駅$/, '');
    const code = IELOVE_STATION_CODES[cleanName] || IELOVE_STATION_CODES[name];
    if (code) {
      codes.push(code);
    } else {
      console.warn(`[ielove] 駅コード未登録: '${name}'`);
    }
  }
  return codes;
}

/**
 * 築年数を最も近いコードに変換する。
 */
function resolveIeloveBuildingAge(age) {
  const ageNum = parseInt(String(age).replace(/[^\d]/g, ''));
  if (!ageNum) return '';
  const thresholds = Object.keys(IELOVE_BUILDING_AGE_CODES).map(Number).sort((a, b) => a - b);
  let best = '';
  for (const t of thresholds) {
    if (t <= ageNum) best = IELOVE_BUILDING_AGE_CODES[t];
    else break;
  }
  return best || String(ageNum);
}

/**
 * 間取り名をコードに変換する。
 */
function resolveIeloveLayouts(layouts) {
  const codes = [];
  for (const layout of layouts) {
    const code = IELOVE_LAYOUT_CODES[layout];
    if (code) codes.push(code);
  }
  return codes;
}

// === 専用ウィンドウ管理 ===

async function findOrCreateDedicatedIeloveTab() {
  // 既存の専用タブが生きているか確認
  if (dedicatedIeloveTabId) {
    try {
      const tab = await chrome.tabs.get(dedicatedIeloveTabId);
      if (tab && tab.url?.includes('bb.ielove.jp')) {
        return tab;
      }
    } catch (e) {
      // タブが閉じられている
    }
    dedicatedIeloveTabId = null;
    dedicatedIeloveWindowId = null;
  }

  // 専用ウィンドウを作成
  await setStorageData({ debugLog: '専用いえらぶウィンドウを作成中...' });
  const newWindow = await chrome.windows.create({
    url: `${IELOVE_BASE_URL}/ielovebb/top/`,
    focused: false,
    width: 1200,
    height: 800,
    left: 0,
    top: 0,
    type: 'normal'
  });
  dedicatedIeloveWindowId = newWindow.id;
  dedicatedIeloveTabId = newWindow.tabs[0].id;

  // ページ読み込み完了を待つ
  await waitForTabLoad(dedicatedIeloveTabId);
  await sleep(2000);

  // ログイン状態を確認
  const tab = await chrome.tabs.get(dedicatedIeloveTabId);
  if (tab.url?.includes('/login')) {
    await setStorageData({ debugLog: 'いえらぶBBにログインしてください（bb.ielove.jpでログイン後に再実行）' });
    await closeDedicatedIeloveWindow();
    return null;
  }

  await setStorageData({ debugLog: `専用いえらぶタブ作成: tabId=${dedicatedIeloveTabId}` });
  return tab;
}

async function closeDedicatedIeloveWindow() {
  if (dedicatedIeloveWindowId) {
    try {
      await chrome.windows.remove(dedicatedIeloveWindowId);
    } catch (e) {
      // 既に閉じられている
    }
    dedicatedIeloveWindowId = null;
    dedicatedIeloveTabId = null;
  }
}

// === いえらぶ用フィルタリング ===

/**
 * いえらぶ固有のフィルタ（既存getFilterRejectReason に加えて適用）
 * @returns {string|null} 除外理由。nullなら合格。
 */
function getIeloveFilterRejectReason(prop, customer) {
  // 賃料フィルタ（rent + management_fee の合計）
  if (customer.rent_max) {
    const totalRent = (prop.rent || 0) + (prop.management_fee || 0);
    if (totalRent > customer.rent_max) {
      return `賃料超過: ${totalRent}円 > ${customer.rent_max}円`;
    }
  }

  // 募集状況フィルタ
  if (prop.listing_status === '申込あり') {
    return '申込あり';
  }

  // 定期借家フィルタ
  const toHankaku = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const equip = toHankaku(customer.equipment || '').toLowerCase();

  if (equip.includes('定期借家除く') || equip.includes('定期借家ng')) {
    if (prop.lease_type && prop.lease_type.includes('定期')) {
      return `定期借家: ${prop.lease_type}`;
    }
  }

  // ロフトNGフィルタ
  if (equip.includes('ロフトng') || equip.includes('ロフト不可')) {
    if (prop.facilities && prop.facilities.includes('ロフト')) {
      return 'ロフトNG: ロフト付き物件';
    }
  }

  // 階数フィルタ（2階以上、1階のみ）
  const floorNum = prop.floor || 0;
  const storyNum = parseInt(toHankaku(prop.story_text || '').match(/(\d+)/)?.[1] || '0');

  if (equip.includes('2階以上')) {
    if (floorNum > 0 && floorNum < 2) {
      return `2階以上条件: ${floorNum}階`;
    }
  }

  if (equip.includes('1階') && !equip.includes('1階以上') && !equip.includes('2階以上')) {
    if (floorNum > 0 && floorNum !== 1) {
      return `1階限定条件: ${floorNum}階`;
    }
  }

  // 既存の共通フィルタ（構造・最上階・南向き等）
  const commonReason = getFilterRejectReason(prop, customer);
  if (commonReason) return commonReason;

  return null;
}

/**
 * 入居時期を正規化する（"2026/5/中旬" → "2026年5月中旬"）
 */
function normalizeIeloveMoveInDate(text) {
  if (!text) return text;
  // "2026/5/中旬" パターン
  let m = text.match(/^(\d{4})\/(\d{1,2})\/(上旬|中旬|下旬)$/);
  if (m) return `${m[1]}年${parseInt(m[2])}月${m[3]}`;

  // "2026/5" パターン
  m = text.match(/^(\d{4})\/(\d{1,2})$/);
  if (m) return `${m[1]}年${parseInt(m[2])}月`;

  // "2026/5/15" パターン
  m = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${m[1]}年${parseInt(m[2])}月${parseInt(m[3])}日`;

  return text;
}

// === メイン検索関数 ===

/**
 * いえらぶBB 全顧客検索を実行する。
 * background.js の runSearchCycle() から呼ばれる。
 */
async function runIeloveSearch(criteria, seenIds, searchId) {
  await loadIeloveStationCodes();

  if (Object.keys(IELOVE_STATION_CODES).length === 0) {
    await setStorageData({ debugLog: '[いえらぶ] 駅コードが読み込めません。スキップ。' });
    return;
  }

  await setStorageData({ debugLog: '[いえらぶ] 検索開始...' });

  const ieloveTab = await findOrCreateDedicatedIeloveTab();
  if (!ieloveTab) {
    // ログイン必要メッセージは findOrCreateDedicatedIeloveTab() 内で設定済み
    return;
  }

  try {
    for (let ci = 0; ci < criteria.length; ci++) {
      if (isSearchCancelled(searchId)) return;

      const customer = criteria[ci];
      await setStorageData({ debugLog: `[いえらぶ] 顧客 ${ci+1}/${criteria.length}: ${customer.name}` });

      try {
        await searchIeloveForCustomer(dedicatedIeloveTabId, customer, seenIds, searchId);
      } catch (err) {
        if (err.message === 'SEARCH_CANCELLED') return;
        if (err.message === 'SLEEP_DETECTED') {
          await setStorageData({ debugLog: '[いえらぶ] PCスリープ検知→検索中断' });
          return;
        }
        if (err.message === 'IELOVE_LOGIN_REQUIRED') {
          await setStorageData({ debugLog: '[いえらぶ] ログインが必要です。bb.ielove.jpでログインしてください。' });
          return;
        }
        logError(`[いえらぶ] ${customer.name}の検索失敗: ${err.message}`);
      }

      // 顧客間の待ち時間
      if (ci < criteria.length - 1) await sleep(3000);
    }
  } finally {
    await closeDedicatedIeloveWindow();
  }
}

/**
 * 1顧客分のいえらぶBB検索を実行する。
 */
async function searchIeloveForCustomer(tabId, customer, seenIds, searchId) {
  const csleep = async (ms) => {
    const before = Date.now();
    await sleep(ms);
    const elapsed = Date.now() - before;
    if (elapsed > Math.max(ms * 3, ms + 30000)) {
      throw new Error('SLEEP_DETECTED');
    }
    if (isSearchCancelled(searchId)) throw new Error('SEARCH_CANCELLED');
  };

  const customerSeenIds = seenIds[customer.name] || [];
  const allNewProperties = [];

  const maxPages = 5;
  let searchUrl = buildIeloveSearchUrl(customer, 1);

  await setStorageData({ debugLog: `[いえらぶ] ${customer.name}: 検索URL構築完了` });

  for (let page = 1; page <= maxPages; page++) {
    if (isSearchCancelled(searchId)) throw new Error('SEARCH_CANCELLED');

    const url = page === 1 ? searchUrl : buildIeloveSearchUrl(customer, page);

    // タブを検索URLに遷移
    await chrome.tabs.update(tabId, { url });
    await waitForTabLoad(tabId);
    await csleep(2000);

    // ログインチェック
    const tab = await chrome.tabs.get(tabId);
    if (tab.url?.includes('/login')) {
      throw new Error('IELOVE_LOGIN_REQUIRED');
    }

    // 検索結果を抽出
    let searchResult;
    try {
      searchResult = await sendContentMessage(tabId, { type: 'IELOVE_EXTRACT_SEARCH_RESULTS' });
    } catch (err) {
      console.warn(`[ielove] page ${page} content script通信失敗:`, err.message);
      break;
    }

    if (!searchResult?.ok || !searchResult.properties?.length) {
      if (page === 1) {
        await setStorageData({ debugLog: `[いえらぶ] ${customer.name}: 検索結果0件` });
      }
      break;
    }

    const pageProperties = searchResult.properties;
    await setStorageData({ debugLog: `[いえらぶ] ${customer.name}: page ${page} → ${pageProperties.length}件` });

    // 各物件を処理
    for (const prop of pageProperties) {
      if (isSearchCancelled(searchId)) throw new Error('SEARCH_CANCELLED');

      // 重複チェック
      if (customerSeenIds.includes(prop.room_id)) continue;

      // 詳細ページから追加情報を取得
      if (prop.url) {
        try {
          // 検索結果ページのURLを保存（戻る用）
          const currentSearchPageUrl = url;

          // 詳細ページに遷移（Refererが自動設定される）
          await chrome.tabs.update(tabId, { url: prop.url });
          await waitForTabLoad(tabId);
          await csleep(1500);

          // ログインチェック
          const detailTab = await chrome.tabs.get(tabId);
          if (detailTab.url?.includes('/login')) {
            throw new Error('IELOVE_LOGIN_REQUIRED');
          }

          // 詳細情報を抽出
          let detailResult;
          try {
            detailResult = await sendContentMessage(tabId, { type: 'IELOVE_EXTRACT_DETAIL' });
          } catch (err) {
            console.warn(`[ielove] 詳細取得失敗 (${prop.building_name}):`, err.message);
          }

          if (detailResult?.ok && detailResult.detail) {
            // 詳細情報をマージ
            Object.assign(prop, detailResult.detail);

            // 構造名を正規化（いえらぶ表記→REINS/itandi共通名）
            if (prop.structure) {
              prop.structure = IELOVE_STRUCTURE_NORMALIZE[prop.structure] || prop.structure;
            }
          }

          // 検索結果ページに戻る
          await chrome.tabs.update(tabId, { url: currentSearchPageUrl });
          await waitForTabLoad(tabId);
          await csleep(1000);
        } catch (err) {
          if (err.message === 'IELOVE_LOGIN_REQUIRED' || err.message === 'SEARCH_CANCELLED' || err.message === 'SLEEP_DETECTED') {
            throw err;
          }
          console.warn(`[ielove] 詳細処理エラー (${prop.building_name}):`, err.message);
        }
      }

      // 入居時期を正規化
      if (prop.move_in_date) {
        prop.move_in_date = normalizeIeloveMoveInDate(prop.move_in_date);
      }

      // フィルタリン���
      const rejectReason = getIeloveFilterRejectReason(prop, customer);
      if (rejectReason) {
        console.log(`[ielove] フィルタ除外 (${prop.building_name}): ${rejectReason}`);
        continue;
      }

      // property_data_json を構築（GAS承認ページ用）
      prop.property_data_json = JSON.stringify(buildPropertyDataJson(prop));

      allNewProperties.push(prop);

      // 物件間のランダム遅延
      const delayMs = 1000 + Math.random() * 2000;
      await csleep(delayMs);
    }

    // ページ数チェック
    if (page === 1) {
      let totalResult;
      try {
        // 検索結果ページに戻っている状態で総件数を取得
        totalResult = await sendContentMessage(tabId, { type: 'IELOVE_GET_TOTAL_COUNT' });
      } catch (e) {
        // 取得失敗は無視
      }
      if (totalResult?.ok && totalResult.count <= 200) break;
    }

    if (pageProperties.length < 200) break;

    // ページ間のランダム遅延
    await csleep(1000 + Math.random() * 2000);
  }

  // GAS送信 + Discord通知
  if (allNewProperties.length > 0) {
    await setStorageData({ debugLog: `[いえらぶ] ${customer.name}: ${allNewProperties.length}件を送信中...` });

    try {
      await submitProperties(customer.name, allNewProperties);
    } catch (err) {
      logError(`[いえらぶ] GAS送信失敗 (${customer.name}): ${err.message}`);
    }

    try {
      await sendDiscordNotification(customer.name, allNewProperties, customer);
    } catch (err) {
      logError(`[いえらぶ] Discord通知失敗 (${customer.name}): ${err.message}`);
    }

    // seenIdsに追加（同一サイクル内の重複防止）
    if (!seenIds[customer.name]) seenIds[customer.name] = [];
    for (const p of allNewProperties) {
      seenIds[customer.name].push(p.room_id);
    }

    // 統計更新
    const { stats } = await getStorageData(['stats']);
    const currentStats = stats || { totalFound: 0, totalSubmitted: 0, errors: [], lastError: null };
    currentStats.totalFound += allNewProperties.length;
    currentStats.totalSubmitted += allNewProperties.length;
    await setStorageData({ stats: currentStats });

    await setStorageData({ debugLog: `[いえらぶ] ${customer.name}: ${allNewProperties.length}件送信完了` });
  } else {
    await setStorageData({ debugLog: `[いえらぶ] ${customer.name}: 新着なし` });
  }
}

/**
 * content script にメッセージを送信する（タイムアウト付き）
 */
function sendContentMessage(tabId, message, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('content script応答タイムアウト'));
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * 物件データをGAS承認ページ用のJSON形式に構築する。
 */
function buildPropertyDataJson(prop) {
  return {
    source: 'ielove',
    building_name: prop.building_name || '',
    room_number: prop.room_number || '',
    address: prop.address || '',
    rent: prop.rent || 0,
    management_fee: prop.management_fee || 0,
    deposit: prop.deposit || '',
    key_money: prop.key_money || '',
    layout: prop.layout || '',
    area: prop.area || 0,
    building_age: prop.building_age || '',
    station_info: prop.station_info || '',
    floor_text: prop.floor_text || '',
    story_text: prop.story_text || '',
    structure: prop.structure || '',
    facilities: prop.facilities || '',
    move_in_date: prop.move_in_date || '',
    lease_type: prop.lease_type || '',
    listing_status: prop.listing_status || '',
    url: prop.url || '',
    image_url: prop.image_url || '',
    image_urls: prop.image_urls || [],
    image_categories: prop.image_categories || [],
    other_stations: prop.other_stations || [],
    cleaning_fee: prop.cleaning_fee || '',
    key_exchange_fee: prop.key_exchange_fee || '',
    fire_insurance: prop.fire_insurance || '',
    guarantee_info: prop.guarantee_info || '',
    renewal_fee: prop.renewal_fee || '',
    contract_period: prop.contract_period || '',
    parking_fee: prop.parking_fee || '',
    free_rent: prop.free_rent || '',
    sunlight: prop.sunlight || '',
    total_units: prop.total_units || '',
    other_monthly_fee: prop.other_monthly_fee || '',
    other_onetime_fee: prop.other_onetime_fee || '',
    shikibiki: prop.shikibiki || '',
    layout_detail: prop.layout_detail || '',
  };
}
