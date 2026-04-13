/**
 * suumo-patrol.js — SUUMO巡回エンジン
 *
 * 顧客条件とは独立した巡回検索を実行し、新着物件をGASに送信する。
 * background.js から importScripts('suumo-patrol.js') で読み込まれる。
 *
 * 巡回フロー:
 *   1. GASから巡回条件を取得 (action=get_patrol_criteria)
 *   2. 各条件を customer 互換オブジェクトに変換
 *   3. 既存の検索関数 (runItandiSearch, runEssquareSearch, runIeloveSearch, searchForCustomer) を利用
 *   4. 物件抽出後、GASに候補として送信 (action=add_suumo_candidate)
 *   5. Discord通知はGAS側で実行
 *
 * 重要: 既存の顧客向け検索パイプラインには一切干渉しない。
 *       巡回は別のalarm ('suumo-patrol') で独立してトリガーされる。
 */

// ── 巡回状態管理 ──
let _suumoPatrolRunning = false;
let _suumoPatrolSearchId = 0;

/**
 * 巡回条件をGASから取得
 */
async function fetchPatrolCriteria() {
  const { gasWebappUrl, apiKey } = await getStorageData(['gasWebappUrl', 'apiKey']);
  if (!gasWebappUrl) throw new Error('GAS URL未設定');

  const url = `${gasWebappUrl}?action=get_patrol_criteria&api_key=${encodeURIComponent(apiKey || '')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`巡回条件取得失敗: HTTP ${res.status}`);

  const data = await res.json();
  return data.criteria || [];
}

/**
 * 巡回条件をcustomer互換オブジェクトに変換
 *
 * 既存の検索関数が期待するフォーマット:
 *   name, routes_with_stations, cities, rent_max, layouts, walk, area_min,
 *   building_age, structures, equipment, prefecture, stations
 */
function patrolCriteriaToCustomer(criteria) {
  let areaObj = {};
  try {
    areaObj = typeof criteria.areaJson === 'string' ? JSON.parse(criteria.areaJson) : (criteria.areaJson || {});
  } catch (e) {}

  let layouts = [];
  try {
    layouts = typeof criteria.layoutsJson === 'string' ? JSON.parse(criteria.layoutsJson) : (criteria.layoutsJson || []);
  } catch (e) {}

  const cities = areaObj.cities || [];
  const stations = areaObj.stations || [];

  // 顧客名の代わりに条件IDを使用（ログ・識別用）
  // ただし、顧客向け検索との混乱を避けるため、プレフィックス付き
  return {
    name: `[SUUMO巡回] ${criteria.name}`,
    _isSuumoPatrol: true,
    _patrolCriteriaId: criteria.id,
    _patrolCriteriaName: criteria.name,
    prefecture: '東京都',
    cities: cities,
    stations: stations,
    routes_with_stations: [], // 巡回ではルート指定なし（市区町村 or 駅名で検索）
    routes: [],
    rent_max: criteria.rentMax || '',
    layouts: layouts,
    walk: '', // 巡回では徒歩分指定なし（幅広く取得）
    area_min: criteria.areaMin || '',
    building_age: criteria.buildingAge || '',
    structures: [],
    equipment: [],
    petType: '',
    // 巡回用: 賃料下限も考慮
    _rentMin: criteria.rentMin || ''
  };
}

/**
 * メインの巡回実行関数
 *
 * 既存のrunSearchCycleとは完全に独立して動作する。
 * 同時実行を防止するため、_suumoPatrolRunning フラグで排他制御。
 */
async function runSuumoPatrolCycle() {
  if (_suumoPatrolRunning) {
    console.log('[SUUMO巡回] 既に実行中のためスキップ');
    return;
  }

  // 顧客検索が実行中の場合もスキップ（タブの競合を避ける）
  const { isSearching } = await getStorageData(['isSearching']);
  if (isSearching) {
    console.log('[SUUMO巡回] 顧客検索が実行中のためスキップ');
    return;
  }

  _suumoPatrolRunning = true;
  const searchId = ++_suumoPatrolSearchId;

  try {
    await setStorageData({ debugLog: '━━━ SUUMO巡回 開始 ━━━' });

    // 1. 巡回条件を取得
    let criteria;
    try {
      criteria = await fetchPatrolCriteria();
    } catch (err) {
      await setStorageData({ debugLog: `[SUUMO巡回] 条件取得失敗: ${err.message}` });
      return;
    }

    if (!criteria || criteria.length === 0) {
      await setStorageData({ debugLog: '[SUUMO巡回] 有効な巡回条件がありません' });
      return;
    }

    await setStorageData({ debugLog: `[SUUMO巡回] ${criteria.length}件の条件で巡回開始` });

    // 2. 既知物件キーセットを読み込み（ローカル）
    const { suumoSeenKeys } = await getStorageData(['suumoSeenKeys']);
    const seenKeys = suumoSeenKeys || {};

    // 3. 有効なサービスを確認
    const { enabledServices } = await getStorageData(['enabledServices']);
    const services = enabledServices || { reins: true, ielove: true, itandi: true, essquare: true };

    // 4. 各巡回条件を処理
    for (let ci = 0; ci < criteria.length; ci++) {
      const crit = criteria[ci];
      const customer = patrolCriteriaToCustomer(crit);

      await setStorageData({ debugLog: `[SUUMO巡回] 条件 ${ci+1}/${criteria.length}: ${crit.name}` });

      // 各サイトの検索結果を収集
      const collectedProperties = [];

      // --- itandi ---
      if (services.itandi) {
        try {
          const props = await runSuumoPatrolForService('itandi', customer, searchId);
          collectedProperties.push(...props);
        } catch (err) {
          await setStorageData({ debugLog: `[SUUMO巡回][itandi] エラー: ${err.message}` });
        }
      }

      // --- ES-Square ---
      if (services.essquare) {
        try {
          const props = await runSuumoPatrolForService('essquare', customer, searchId);
          collectedProperties.push(...props);
        } catch (err) {
          await setStorageData({ debugLog: `[SUUMO巡回][ES-Square] エラー: ${err.message}` });
        }
      }

      // --- いえらぶ ---
      if (services.ielove) {
        try {
          const props = await runSuumoPatrolForService('ielove', customer, searchId);
          collectedProperties.push(...props);
        } catch (err) {
          await setStorageData({ debugLog: `[SUUMO巡回][いえらぶ] エラー: ${err.message}` });
        }
      }

      // --- REINS ---
      if (services.reins) {
        try {
          const props = await runSuumoPatrolForService('reins', customer, searchId);
          collectedProperties.push(...props);
        } catch (err) {
          await setStorageData({ debugLog: `[SUUMO巡回][REINS] エラー: ${err.message}` });
        }
      }

      // 5. 新着判定 & GASに送信
      if (collectedProperties.length > 0) {
        const newProperties = [];
        for (const prop of collectedProperties) {
          const key = normSuumoKey(prop.building || prop.buildingName || '', prop.room || prop.roomNumber || '');
          if (!seenKeys[key]) {
            seenKeys[key] = Date.now();
            newProperties.push(prop);
          }
        }

        if (newProperties.length > 0) {
          await setStorageData({ debugLog: `[SUUMO巡回] ${crit.name}: ${newProperties.length}件の新着物件を検出` });

          // GASに送信
          try {
            await sendSuumoCandidatesToGas(newProperties, crit.id);
          } catch (err) {
            await setStorageData({ debugLog: `[SUUMO巡回] GAS送信失敗: ${err.message}` });
          }
        } else {
          await setStorageData({ debugLog: `[SUUMO巡回] ${crit.name}: 新着なし（${collectedProperties.length}件中全て既知）` });
        }
      } else {
        await setStorageData({ debugLog: `[SUUMO巡回] ${crit.name}: 物件取得0件` });
      }

      // 条件間の待ち時間
      if (ci < criteria.length - 1) await sleep(5000);
    }

    // 6. 既知キーセットを保存（古いものをクリーンアップ: 60日以上前）
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    for (const key of Object.keys(seenKeys)) {
      if (seenKeys[key] < cutoff) delete seenKeys[key];
    }
    await setStorageData({ suumoSeenKeys: seenKeys });

    await setStorageData({ debugLog: '━━━ SUUMO巡回 完了 ━━━' });

  } catch (err) {
    await setStorageData({ debugLog: `[SUUMO巡回] 致命的エラー: ${err.message}` });
    console.error('[SUUMO巡回] エラー:', err);
  } finally {
    _suumoPatrolRunning = false;
  }
}

/**
 * 特定サービスのSUUMO巡回検索を実行
 *
 * 既存の検索関数を使うが、結果の通知は行わず、物件データだけを返す。
 * _isSuumoPatrol フラグにより、既存のDiscord通知をスキップする。
 *
 * @returns {Array} 物件データ配列
 */
async function runSuumoPatrolForService(service, customer, searchId) {
  // 巡回モードで検出した物件を収集するバッファ
  const collected = [];

  // グローバルに巡回用コレクターを設定
  // 既存の通知関数の代わりにこのコレクターが呼ばれるようにする
  globalThis._suumoPatrolCollector = collected;
  globalThis._suumoPatrolMode = true;

  try {
    // 空のseenIdsを渡す（巡回ではGAS側で重複管理するため）
    const seenIds = {};

    switch (service) {
      case 'itandi':
        await runItandiSearch([customer], seenIds, searchId);
        break;
      case 'essquare':
        await runEssquareSearch([customer], seenIds, searchId);
        break;
      case 'ielove':
        await runIeloveSearch([customer], seenIds, searchId);
        break;
      case 'reins':
        const reinsTab = await findReinsTab();
        if (reinsTab) {
          const { pageDelaySeconds } = await getStorageData(['pageDelaySeconds']);
          const reinsDelay = (pageDelaySeconds || 2) * 1000;
          await searchForCustomer(reinsTab.id, customer, seenIds, reinsDelay, searchId);
        }
        break;
    }
  } finally {
    globalThis._suumoPatrolMode = false;
    globalThis._suumoPatrolCollector = null;
  }

  return collected;
}

/**
 * 物件キーの正規化（SUUMO巡回用）
 */
function normSuumoKey(building, room) {
  const b = (building || '').replace(/[\s\u3000]/g, '').toLowerCase();
  const r = (room || '').replace(/[^\d]/g, '');
  return b + '|' + r;
}

/**
 * 新着物件をGASに送信
 */
async function sendSuumoCandidatesToGas(properties, patrolCriteriaId) {
  const { gasWebappUrl } = await getStorageData(['gasWebappUrl']);
  if (!gasWebappUrl) throw new Error('GAS URL未設定');

  const response = await fetch(gasWebappUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'add_suumo_candidate',
      properties: properties,
      patrolCriteriaId: patrolCriteriaId
    })
  });

  if (!response.ok) throw new Error(`GAS応答エラー: HTTP ${response.status}`);
  return await response.json();
}

/**
 * SUUMO承認キューをポーリング
 */
async function pollSuumoApprovalQueue() {
  const { gasWebappUrl, apiKey } = await getStorageData(['gasWebappUrl', 'apiKey']);
  if (!gasWebappUrl) return null;

  const url = `${gasWebappUrl}?action=get_suumo_queue&api_key=${encodeURIComponent(apiKey || '')}`;
  const res = await fetch(url);
  if (!res.ok) return null;

  return await res.json();
}

/**
 * SUUMO入稿完了をGASに報告
 */
async function reportSuumoPostComplete(data) {
  const { gasWebappUrl } = await getStorageData(['gasWebappUrl']);
  if (!gasWebappUrl) throw new Error('GAS URL未設定');

  const response = await fetch(gasWebappUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'suumo_post_complete',
      ...data
    })
  });

  if (!response.ok) throw new Error(`GAS応答エラー: HTTP ${response.status}`);
  return await response.json();
}
