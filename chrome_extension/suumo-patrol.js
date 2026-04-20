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
// searchIdはbackground.jsのcurrentSearchIdを使用

/**
 * 巡回条件をGASから取得
 */
async function fetchPatrolCriteria() {
  const { gasWebappUrl, gasApiKey } = await getStorageData(['gasWebappUrl', 'gasApiKey']);
  if (!gasWebappUrl) throw new Error('GAS URL未設定');

  const url = `${gasWebappUrl}?action=get_patrol_criteria&api_key=${encodeURIComponent(gasApiKey || '')}`;
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
  let structures = [];
  try {
    structures = typeof criteria.structuresJson === 'string' ? JSON.parse(criteria.structuresJson) : (criteria.structuresJson || []);
  } catch (e) {}

  let equipmentArr = [];
  try {
    equipmentArr = typeof criteria.equipmentJson === 'string' ? JSON.parse(criteria.equipmentJson) : (criteria.equipmentJson || []);
  } catch (e) {}
  // 既存の検索関数はequipmentを文字列（カンマ区切り）で期待する
  const equipment = Array.isArray(equipmentArr) ? equipmentArr.join(',') : String(equipmentArr || '');

  const routesWithStations = areaObj.routes_with_stations || [];
  const routes = routesWithStations.map(r => r.route);

  return {
    name: `[SUUMO巡回] ${criteria.name}`,
    _isSuumoPatrol: true,
    _patrolCriteriaId: criteria.id,
    _patrolCriteriaName: criteria.name,
    prefecture: '東京都',
    cities: cities,
    stations: stations,
    routes_with_stations: routesWithStations,
    routes: routes,
    rent_max: criteria.rentMax || '',
    layouts: layouts,
    walk: criteria.walk || '',
    area_min: criteria.areaMin || '',
    building_age: criteria.buildingAge || '',
    structures: structures,
    equipment: equipment,
    petType: equipmentArr.includes('ペット相談可') ? 'ok' : '',
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
  // 既存のcurrentSearchIdを使用（isSearchCancelledがこれを参照するため）
  const searchId = ++currentSearchId;

  try {
    await setStorageData({ debugLog: '━━━ SUUMO巡回 開始 ━━━' });

    // 1. 巡回条件を取得
    let criteria;
    let debugInfo;
    try {
      const { gasWebappUrl, gasApiKey } = await getStorageData(['gasWebappUrl', 'gasApiKey']);
      const url = `${gasWebappUrl}?action=get_patrol_criteria&api_key=${encodeURIComponent(gasApiKey || '')}`;
      console.log('[SUUMO巡回] リクエストURL:', url);
      const res = await fetch(url);
      const rawText = await res.text();
      console.log('[SUUMO巡回] GAS生レスポンス:', rawText.substring(0, 500));
      const data = JSON.parse(rawText);
      criteria = data.criteria || [];
      debugInfo = data.debug || {};
      console.log('[SUUMO巡回] パース結果: 全', debugInfo.total, '件, 有効', debugInfo.active, '件');
    } catch (err) {
      await setStorageData({ debugLog: `[SUUMO巡回] 条件取得失敗: ${err.message}` });
      return;
    }

    if (!criteria || criteria.length === 0) {
      await setStorageData({ debugLog: `[SUUMO巡回] 有効な巡回条件がありません (debug: 全${debugInfo.total || '?'}件, 有効${debugInfo.active || '?'}件)` });
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
      if (isSearchCancelled(searchId)) {
        await setStorageData({ debugLog: '[SUUMO巡回] 中断されました' });
        return;
      }

      const crit = criteria[ci];
      const customer = patrolCriteriaToCustomer(crit);
      console.log('[SUUMO巡回] GAS条件:', JSON.stringify(crit));
      console.log('[SUUMO巡回] 変換後customer:', JSON.stringify(customer));

      await setStorageData({ debugLog: `[SUUMO巡回] 条件 ${ci+1}/${criteria.length}: ${crit.name}` });

      // 各サイトの検索結果を収集
      const collectedProperties = [];

      const serviceList = [
        { key: 'itandi', label: 'itandi' },
        { key: 'essquare', label: 'ES-Square' },
        { key: 'ielove', label: 'いえらぶ' },
        { key: 'reins', label: 'REINS' },
      ];

      let totalNew = 0;
      let totalCollected = 0;

      // 物件検出時に即座にGASへ送信するコレクター（都度送信）
      const sendCollector = {
        _items: [],
        async push(prop) {
          this._items.push(prop);
          totalCollected++;
          const key = normSuumoKey(
            prop.building_name || prop.buildingName || prop.building || '',
            prop.room_number || prop.roomNumber || prop.room || ''
          );
          if (seenKeys[key]) return this._items.length;
          seenKeys[key] = Date.now();
          totalNew++;
          // SUUMO競合数を取得して prop.suumo_competitor にアタッチ（失敗しても送信継続）
          try {
            if (typeof globalThis.countSuumoCompetitors === 'function') {
              // 階建情報の有無を診断ログで出す（無ければ広め検索でフォールバック）
              let bfDiag = '';
              try {
                const bf = globalThis._suumoCompetitorInternals &&
                           globalThis._suumoCompetitorInternals._toSuumoBuildingFloor &&
                           globalThis._suumoCompetitorInternals._toSuumoBuildingFloor(prop);
                bfDiag = bf ? `階建=${bf}` : '階建不明(広め検索でフォールバック)';
              } catch (e) { bfDiag = '階建判定エラー'; }
              await setStorageData({ debugLog:
                `[SUUMO競合] 入力: addr="${prop.address || ''}" rent=${prop.rent} area=${prop.area || prop.usageArea} structure="${prop.structure || ''}" ${bfDiag}`
              });
              const competitor = await globalThis.countSuumoCompetitors(prop);
              if (competitor) {
                prop.suumo_competitor = competitor;
                await setStorageData({ debugLog:
                  `[SUUMO巡回] 競合数: あり${competitor.withName}(HL${competitor.withNameHighlighted})/なし${competitor.withoutName}(HL${competitor.withoutNameHighlighted}) url=${competitor.url || ''}`
                });
              } else {
                await setStorageData({ debugLog: `[SUUMO巡回] 競合数: null(URL構築失敗 or 全候補fetch失敗)` });
              }
            }
          } catch (compErr) {
            console.warn('[SUUMO巡回] 競合数取得例外:', compErr && compErr.message);
          }
          try {
            await sendSuumoCandidatesToGas([prop], crit.id);
            await setStorageData({ debugLog: `[SUUMO巡回] → ${prop.building_name || prop.buildingName || ''} ${prop.room_number || ''} 送信完了` });
          } catch (err) {
            await setStorageData({ debugLog: `[SUUMO巡回] GAS送信失敗: ${err.message}` });
          }
          return this._items.length;
        }
      };

      for (const svc of serviceList) {
        if (isSearchCancelled(searchId)) {
          await setStorageData({ debugLog: '[SUUMO巡回] 中断されました' });
          return;
        }
        if (!services[svc.key]) continue;
        try {
          await runSuumoPatrolForService(svc.key, customer, searchId, sendCollector);
          const serviceCount = sendCollector._items.length;
          await setStorageData({ debugLog: `[SUUMO巡回][${svc.label}] 累計${serviceCount}件取得` });
        } catch (err) {
          await setStorageData({ debugLog: `[SUUMO巡回][${svc.label}] エラー: ${err.message}` });
          console.error(`[SUUMO巡回][${svc.label}]`, err);
        }
      }

      if (totalNew > 0) {
        await setStorageData({ debugLog: `[SUUMO巡回] ${crit.name}: ${totalNew}件の新着物件を検出` });
      } else if (totalCollected > 0) {
        await setStorageData({ debugLog: `[SUUMO巡回] ${crit.name}: 新着なし（${totalCollected}件中全て既知）` });
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
async function runSuumoPatrolForService(service, customer, searchId, collector) {
  // 巡回モードで検出した物件のコレクター。
  // 引数で渡されていれば使用（都度送信モード）、なければ配列を生成（従来モード）
  const activeCollector = collector || [];

  // グローバルに巡回用コレクターを設定
  // 既存の通知関数の代わりにこのコレクターが呼ばれるようにする
  globalThis._suumoPatrolCollector = activeCollector;
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

  return activeCollector;
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

  console.log('[SUUMO巡回] GAS送信: ' + properties.length + '件, criteriaId=' + patrolCriteriaId);
  // 送信データの先頭物件のフィールドを確認
  if (properties.length > 0) {
    const p = properties[0];
    console.log('[SUUMO巡回] 先頭物件フィールド:', Object.keys(p).join(', '));
    console.log('[SUUMO巡回] building_name=' + (p.building_name || ''), 'room_number=' + (p.room_number || ''));
  }

  const response = await fetch(gasWebappUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'add_suumo_candidate',
      properties: properties,
      patrolCriteriaId: patrolCriteriaId
    })
  });

  const rawText = await response.text();
  console.log('[SUUMO巡回] GASレスポンス:', rawText.substring(0, 500));
  if (!response.ok) throw new Error(`GAS応答エラー: HTTP ${response.status}`);
  const result = JSON.parse(rawText);
  // Discord通知の結果をデバッグログに出力
  if (result.discord) {
    await setStorageData({ debugLog: `[SUUMO巡回] Discord通知結果: ${JSON.stringify(result.discord)}` });
  }
  if (result.webhookSet === false) {
    await setStorageData({ debugLog: `[SUUMO巡回] ⚠️ GAS側にSUUMO Discord Webhook URLが未設定です！オプションページで保存してください` });
  }
  return result;
}

/**
 * SUUMO承認キューをポーリング
 * @param {Object} opts - { lock: true で取得と同時にsubmittingロック }
 */
async function pollSuumoApprovalQueue(opts) {
  const { gasWebappUrl, gasApiKey } = await getStorageData(['gasWebappUrl', 'gasApiKey']);
  if (!gasWebappUrl) return null;

  const lockParam = opts && opts.lock ? '&lock=true' : '';
  const url = `${gasWebappUrl}?action=get_suumo_queue&api_key=${encodeURIComponent(gasApiKey || '')}${lockParam}`;
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
