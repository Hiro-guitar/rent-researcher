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

    // 巡回開始前フック: 1日1回、SUUMO広告一括更新を実行
    // (forrent広告更新は巡回処理(各サイトAPI)と干渉しないため開始前に実施)
    try {
      if (typeof globalThis.maybeRunSuumoBulkAdUpdate === 'function') {
        await globalThis.maybeRunSuumoBulkAdUpdate();
      }
    } catch (e) {
      await setStorageData({ debugLog: `[SUUMO巡回] 広告一括更新フック例外: ${e.message}` });
    }

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

    // Discord通知は Chrome拡張側(ユーザーIP)で行う方式に変更したため、
    // ここでは GAS にスレッド作成を依頼しない。
    // スレッド管理は Discord通知送信時に createSuumoPatrolThread_ が巡回ごとに行う。

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

      // エリア条件が空（cities/stations/routes_with_stations が全て空）なら
      // 各サイトのAPIが「都道府県全件」扱いで too many properties エラーになるため
      // この巡回条件はスキップ。
      const hasCities = Array.isArray(customer.cities) && customer.cities.length > 0;
      const hasStations = Array.isArray(customer.stations) && customer.stations.length > 0;
      const hasRws = Array.isArray(customer.routes_with_stations) && customer.routes_with_stations.length > 0;
      if (!hasCities && !hasStations && !hasRws) {
        await setStorageData({ debugLog: `[SUUMO巡回] ✗ スキップ: 条件「${crit.name}」にエリア指定(市区町村/駅/路線)がありません` });
        continue;
      }

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
      // 旧実装は前回GAS送信から30秒空ける待機を入れていたが、
      // 実測で30秒空けてもCloudflare 1015は発生し、失敗分は再送機能で
      // 最終的に届いているため、待機ロジックは撤廃（巡回速度優先）。
      const sendCollector = {
        _items: [],
        async push(prop) {
          // 間取り情報がない物件は反響予測スコアが計算できないためスキップ
          const layout = (prop.layout || prop.madori || '').toString().trim();
          if (!layout) {
            await setStorageData({ debugLog:
              `[SUUMO巡回] ✗ スキップ: ${prop.building_name || prop.buildingName || ''} ${prop.room_number || ''} (間取り情報なし)`
            });
            return this._items.length;
          }
          this._items.push(prop);
          totalCollected++;
          // 元付電話番号からハイフン類を除去（全サイト共通の正規化）
          //   例: "03-1234-5678" → "0312345678"
          //   全角ハイフン/長音符/EN DASH/EM DASH/MINUS SIGN も対象
          if (prop.owner_phone) {
            prop.owner_phone = String(prop.owner_phone)
              .replace(/[-\u2010-\u2015\u2212\uFF0D\u30FC]/g, '')
              .trim();
          }
          const key = normSuumoKey(
            prop.building_name || prop.buildingName || prop.building || '',
            prop.room_number || prop.roomNumber || prop.room || ''
          );
          // 強制再取得リストにある物件は seenKeys バイパス
          // (room_id / _raw_room_id / propertyNumber いずれか一致でOK)
          const forceSet = globalThis._oneShotForceRefetchSet;
          const isForced = !!(forceSet && forceSet.size > 0 && (
            forceSet.has(String(prop.room_id || '')) ||
            forceSet.has(String(prop._raw_room_id || '')) ||
            forceSet.has(String(prop.propertyNumber || '')) ||
            forceSet.has(String(prop.reins_property_number || ''))
          ));
          if (seenKeys[key] && !isForced) {
            // 既知物件: ログを出して透明にする(従来は無言スキップ)
            await setStorageData({ debugLog:
              `[SUUMO巡回] ✗ 既知スキップ: ${prop.building_name || prop.buildingName || ''} ${prop.room_number || ''} (前回までに通知済み)`
            });
            return this._items.length;
          }
          if (isForced) {
            await setStorageData({ debugLog:
              `[SUUMO巡回] [強制再取得] ${prop.building_name || prop.buildingName || ''} ${prop.room_number || ''} を再処理対象として通過`
            });
          }
          seenKeys[key] = Date.now();
          totalNew++;
          // 画像枚数による事前スキップ(SUUMO巡回のみ)
          // 競合検索より先にチェックすることで SUUMO検索呼び出しを減らす
          // REINSは仕様上画像が最大10枚までなので、11枚以下スキップの対象外
          try {
            const { suumoSkipLowImageCount } = await getStorageData(['suumoSkipLowImageCount']);
            if (suumoSkipLowImageCount) {
              const isReins = prop.source === 'reins' || prop.sourceType === 'reins';
              if (!isReins) {
                const imgs = prop.image_urls || prop.images || [];
                const imgCount = Array.isArray(imgs) ? imgs.length : 0;
                // 11枚以下(0枚含む) → スキップ
                if (imgCount <= 11) {
                  await setStorageData({ debugLog:
                    `[SUUMO巡回] ✗ スキップ: ${prop.building_name || prop.buildingName || ''} ${prop.room_number || ''} - 画像${imgCount}枚(11枚以下)`
                  });
                  return this._items.length;
                }
              }
            }
          } catch (_) {}
          // SUUMO競合数:
          //   各サイトの詳細スクレイプ内で「画像取得直前」に
          //   checkSuumoCompetitorPreSkip 済みの物件は prop.suumo_competitor が
          //   既にアタッチされている。その場合は再取得しない。
          //   未アタッチ(旧経路/REINS以外のフォールバック)なら従来通りここで取得。
          let skipByCompetition = false;
          let skipReason = '';
          try {
            if (prop.suumo_competitor && typeof prop.suumo_competitor === 'object') {
              // 詳細スクレイプ側で取得済み → 閾値判定のみ再評価(念のため)
              const competitor = prop.suumo_competitor;
              await setStorageData({ debugLog:
                `[SUUMO巡回] 競合数(詳細側で取得済): あり${competitor.withName}(HL${competitor.withNameHighlighted})/なし${competitor.withoutName}(HL${competitor.withoutNameHighlighted})`
              });
              try {
                const { suumoCompSkipThresholds } = await getStorageData(['suumoCompSkipThresholds']);
                const t = suumoCompSkipThresholds || {};
                const checks = [
                  { label: '物件名あり×HLあり', actual: competitor.withNameHighlighted || 0, limit: t.withNameHighlighted },
                  { label: '物件名あり×HLなし', actual: Math.max(0, (competitor.withName || 0) - (competitor.withNameHighlighted || 0)), limit: t.withName },
                  { label: '物件名なし×HLあり', actual: competitor.withoutNameHighlighted || 0, limit: t.withoutNameHighlighted },
                  { label: '物件名なし×HLなし', actual: Math.max(0, (competitor.withoutName || 0) - (competitor.withoutNameHighlighted || 0)), limit: t.withoutName },
                ];
                for (const c of checks) {
                  if (c.limit === null || c.limit === undefined) continue;
                  if (c.actual > c.limit) {
                    skipByCompetition = true;
                    skipReason = `SUUMO競合多数(${c.label} ${c.actual}>${c.limit})`;
                    break;
                  }
                }
              } catch (_) {}
            } else if (typeof globalThis.countSuumoCompetitors === 'function') {
              // 詳細スクレイプ側で未取得 → フォールバックで取得
              let bfDiag = '';
              try {
                const bf = globalThis._suumoCompetitorInternals &&
                           globalThis._suumoCompetitorInternals._toSuumoBuildingFloor &&
                           globalThis._suumoCompetitorInternals._toSuumoBuildingFloor(prop);
                bfDiag = bf ? `階建=${bf}` : '階建不明(広め検索でフォールバック)';
              } catch (e) { bfDiag = '階建判定エラー'; }
              await setStorageData({ debugLog:
                `[SUUMO競合] 入力(送信直前フォールバック): addr="${prop.address || ''}" rent=${prop.rent} area=${prop.area || prop.usageArea} structure="${prop.structure || ''}" ${bfDiag}`
              });
              const competitor = await globalThis.countSuumoCompetitors(prop);
              if (competitor) {
                prop.suumo_competitor = competitor;
                await setStorageData({ debugLog:
                  `[SUUMO巡回] 競合数: あり${competitor.withName}(HL${competitor.withNameHighlighted})/なし${competitor.withoutName}(HL${competitor.withoutNameHighlighted}) url=${competitor.url || ''}`
                });
                try {
                  const { suumoCompSkipThresholds } = await getStorageData(['suumoCompSkipThresholds']);
                  const t = suumoCompSkipThresholds || {};
                  const checks = [
                    { label: '物件名あり×HLあり', actual: competitor.withNameHighlighted || 0, limit: t.withNameHighlighted },
                    { label: '物件名あり×HLなし', actual: Math.max(0, (competitor.withName || 0) - (competitor.withNameHighlighted || 0)), limit: t.withName },
                    { label: '物件名なし×HLあり', actual: competitor.withoutNameHighlighted || 0, limit: t.withoutNameHighlighted },
                    { label: '物件名なし×HLなし', actual: Math.max(0, (competitor.withoutName || 0) - (competitor.withoutNameHighlighted || 0)), limit: t.withoutName },
                  ];
                  for (const c of checks) {
                    if (c.limit === null || c.limit === undefined) continue;
                    if (c.actual > c.limit) {
                      skipByCompetition = true;
                      skipReason = `SUUMO競合多数(${c.label} ${c.actual}>${c.limit})`;
                      break;
                    }
                  }
                } catch (_) {}
              } else {
                await setStorageData({ debugLog: `[SUUMO巡回] 競合数: null(URL構築失敗 or 全候補fetch失敗)` });
              }
            }
          } catch (compErr) {
            console.warn('[SUUMO巡回] 競合数取得例外:', compErr && compErr.message);
          }
          // 競合数上限超過 → GAS送信もDiscordも完全スキップ
          if (skipByCompetition) {
            await setStorageData({ debugLog:
              `[SUUMO巡回] ✗ スキップ: ${prop.building_name || prop.buildingName || ''} ${prop.room_number || ''} - ${skipReason}`
            });
            return this._items.length;
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
  if (properties.length > 0) {
    const p = properties[0];
    console.log('[SUUMO巡回] 先頭物件フィールド:', Object.keys(p).join(', '));
    console.log('[SUUMO巡回] building_name=' + (p.building_name || ''), 'room_number=' + (p.room_number || ''));
  }

  // 90秒タイムアウト付き fetch
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000);
  let response;
  try {
    response = await fetch(gasWebappUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        action: 'add_suumo_candidate',
        properties: properties,
        patrolCriteriaId: patrolCriteriaId
      })
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err && err.name === 'AbortError') {
      throw new Error('GAS送信タイムアウト(90秒): 次回巡回で再試行');
    }
    throw err;
  }
  clearTimeout(timeoutId);

  const rawText = await response.text();
  console.log('[SUUMO巡回] GASレスポンス:', rawText.substring(0, 500));
  if (!response.ok) throw new Error(`GAS応答エラー: HTTP ${response.status}`);
  const result = JSON.parse(rawText);

  if (result.webhookSet === false) {
    await setStorageData({ debugLog: `[SUUMO巡回] ⚠️ GAS側にSUUMO Discord Webhook URLが未設定です！オプションページで保存してください` });
  }

  // GAS が返した notifyProps を使って Chrome拡張側(ユーザーIP)から Discord 通知
  // GAS の IP プールを使わないことで Cloudflare 1015 を回避
  if (Array.isArray(result.notifyProps) && result.notifyProps.length > 0 && result.discordWebhookUrl) {
    try {
      const sendResult = await sendSuumoDiscordFromExtension_(
        result.notifyProps,
        result.criteriaName || '',
        result.gasUrl || gasWebappUrl,
        result.discordWebhookUrl
      );
      const errSnippet = sendResult.errors.length > 0 ? ` 失敗${sendResult.errors.length}件: ${sendResult.errors.slice(0,1).join('|').substring(0,120)}` : '';
      await setStorageData({ debugLog: `[SUUMO巡回] Discord送信結果(拡張側): ${sendResult.sent}/${result.notifyProps.length}件${errSnippet}` });
      // 送信成功した行を GAS にマーク依頼
      if (sendResult.sheetRowIndexes.length > 0) {
        await markSuumoDiscordSentInGas_(sendResult.sheetRowIndexes);
      }
    } catch (e) {
      await setStorageData({ debugLog: `[SUUMO巡回] Discord送信例外: ${e.message}` });
    }
  }
  return result;
}

// ════════════════════════════════════════════════════════════════════
// SUUMO巡回 Discord 通知 (Chrome拡張側で実行 = ユーザーIPから送信)
// 旧実装は GAS の UrlFetchApp.fetch から webhook を叩いていたが、GAS共用IP
// プールが Cloudflare 1015 にフラグされる事象が頻発したため、お客様検索と
// 同様にユーザーIP(Chrome拡張)から送信する形に変更。
// ════════════════════════════════════════════════════════════════════

/**
 * 巡回ごとに新規 Discord スレッドを作成
 * - 1巡回 = 1スレッド (sendSuumoDiscordFromExtension_ 1回呼ばれるごとに作成)
 * - スレッド名: "🌀 SUUMO巡回 YYYY-MM-DD HH:mm" (JST 日時で巡回単位を識別)
 * - スレッド作成失敗時は null を返す(呼び出し側でフォールバック扱い)
 *
 * 注: 過去のレート制限問題は GAS 共有IPが原因 (Chrome拡張へ移行で解消済み)。
 *     スレッド数を抑える理由はないため日毎統合をやめて巡回ごとに分けている。
 */
async function createSuumoPatrolThread_(webhookUrl) {
  if (!webhookUrl) return null;
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const dateStr = jstNow.getUTCFullYear() + '-'
    + String(jstNow.getUTCMonth() + 1).padStart(2, '0') + '-'
    + String(jstNow.getUTCDate()).padStart(2, '0');
  const timeStr = String(jstNow.getUTCHours()).padStart(2, '0') + ':'
    + String(jstNow.getUTCMinutes()).padStart(2, '0');
  const threadName = '🌀 SUUMO巡回 ' + dateStr + ' ' + timeStr;
  const headerContent = '━━━ SUUMO巡回 ' + dateStr + ' ' + timeStr + ' ━━━';
  try {
    const resp = await fetch(webhookUrl + (webhookUrl.indexOf('?') >= 0 ? '&' : '?') + 'wait=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_name: threadName, content: headerContent })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      await setStorageData({ debugLog: `[SUUMO巡回] スレッド作成失敗: HTTP ${resp.status} ${text.substring(0,150)}` });
      return null;
    }
    const data = await resp.json();
    const threadId = data.channel_id || data.thread_id || (data.channel && data.channel.id) || '';
    if (!threadId) {
      await setStorageData({ debugLog: `[SUUMO巡回] スレッド作成失敗: thread_id取得不可` });
      return null;
    }
    await setStorageData({
      debugLog: `[SUUMO巡回] Discordスレッド作成OK ${threadName} (id=${threadId})`
    });
    return threadId;
  } catch (err) {
    await setStorageData({ debugLog: `[SUUMO巡回] スレッド作成例外: ${err.message}` });
    return null;
  }
}

/**
 * (旧) 日付ごとの SUUMO巡回 Discord スレッドを取得・作成
 * - 同じ JST日付なら既存スレッドを再利用(スレッド作成は1日1回のみ)
 * - 別日 or 未作成なら新規スレッド作成
 * - スレッド作成失敗時は null を返す(呼び出し側でフォールバック扱い)
 *
 * suumo-bulk-update.js (一括更新) で引き続き使用。
 */
async function getOrCreateSuumoDailyThread_(webhookUrl) {
  if (!webhookUrl) return null;
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayJst = jstNow.getUTCFullYear() + '-'
    + String(jstNow.getUTCMonth() + 1).padStart(2, '0') + '-'
    + String(jstNow.getUTCDate()).padStart(2, '0');

  const { suumoDailyThreadId, suumoDailyThreadDate } = await getStorageData([
    'suumoDailyThreadId', 'suumoDailyThreadDate'
  ]);
  if (suumoDailyThreadId && suumoDailyThreadDate === todayJst) {
    return suumoDailyThreadId;
  }

  // 新スレッド作成 (forum チャンネルへの thread_name付き投稿で channel_id 取得)
  const threadName = '🌀 SUUMO巡回 ' + todayJst;
  const headerContent = '━━━ SUUMO巡回 ' + todayJst + ' ━━━';
  try {
    const resp = await fetch(webhookUrl + (webhookUrl.indexOf('?') >= 0 ? '&' : '?') + 'wait=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_name: threadName, content: headerContent })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      await setStorageData({ debugLog: `[SUUMO巡回] スレッド作成失敗: HTTP ${resp.status} ${text.substring(0,150)}` });
      return null;
    }
    const data = await resp.json();
    const threadId = data.channel_id || data.thread_id || (data.channel && data.channel.id) || '';
    if (!threadId) {
      await setStorageData({ debugLog: `[SUUMO巡回] スレッド作成失敗: thread_id取得不可` });
      return null;
    }
    await setStorageData({
      suumoDailyThreadId: threadId,
      suumoDailyThreadDate: todayJst,
      debugLog: `[SUUMO巡回] 本日(${todayJst})のDiscordスレッド作成OK`
    });
    return threadId;
  } catch (err) {
    await setStorageData({ debugLog: `[SUUMO巡回] スレッド作成例外: ${err.message}` });
    return null;
  }
}

/**
 * 1物件分の Discord メッセージ content を構築
 * 既存のGAS sendSuumoDiscordNotification と完全同一フォーマット
 */
function buildSuumoDiscordMessageContent_(p, criteriaName, gasUrl, propertyKey) {
  const fmtMan = (yen) => {
    if (!yen) return '';
    const v = parseFloat(yen);
    if (isNaN(v)) return String(yen);
    if (v >= 10000) return String(parseFloat((v / 10000).toFixed(4))) + '万円';
    return String(v) + '円';
  };

  const building = p.building_name || p.buildingName || p.building || '(建物名なし)';
  const room = p.room_number || p.roomNumber || p.room || '';
  const source = p.sourceType || p.source || '';
  const rentDisplay = p.rent ? fmtMan(p.rent) : '不明';
  const mgmtFeeRaw = p.management_fee || p.managementFee || p.commonServiceFee || '';
  const mgmtFee = mgmtFeeRaw ? fmtMan(mgmtFeeRaw) : '';
  const layout = p.layout || ((p.madoriRoomCount || '') + (p.madoriType || ''));
  const area = p.area || p.usageArea || '';
  const address = p.address || ((p.pref || '') + (p.addr1 || '') + (p.addr2 || ''));
  let stationInfo = p.station_info || '';
  if (!stationInfo && p.access && p.access.length > 0) {
    stationInfo = (p.access[0].line || '') + ' ' + (p.access[0].station || '') + '駅 徒歩' + (p.access[0].walk || '') + '分';
  }
  const otherStations = (p.other_stations && p.other_stations.length > 0) ? p.other_stations : [];
  const approveUrl = (gasUrl || '') + '?action=suumo_approve&key=' + encodeURIComponent(propertyKey || '');

  // 警告アラート
  const warnings = [];
  const adKeisai = p.ad_keisai || p.adKeisai || '';
  if (adKeisai && String(adKeisai).trim() !== '可') {
    warnings.push('⚠️ 広告掲載: ' + String(adKeisai).trim() + '(SUUMO広告掲載の確認が必要です)');
  }
  const listingStatus = p.listing_status ? String(p.listing_status).trim() : '';
  if (listingStatus && (listingStatus === '申込あり' || /^申込\d+件$/.test(listingStatus) || /申込/.test(listingStatus))) {
    warnings.push('⚠️ 募集状況: ' + listingStatus);
  }

  const msgLines = [];
  msgLines.push('**🏠 新着SUUMO候補物件**');
  msgLines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  msgLines.push('**' + building + '  ' + room + '号室** `[' + source + ']`');
  let rentLine = '賃料: **' + rentDisplay + '**';
  if (mgmtFee) rentLine += ' (管理費: ' + mgmtFee + ')';
  msgLines.push(rentLine);
  if (layout) msgLines.push('間取り: ' + layout);
  if (area) msgLines.push('面積: ' + area + 'm²');
  if (p.building_age) msgLines.push('築年: ' + p.building_age);
  if (address) msgLines.push('住所: ' + address);
  if (stationInfo) msgLines.push('交通: ' + stationInfo);
  if (otherStations.length > 0) msgLines.push('他の路線: ' + otherStations.join(' / '));
  if (p.floor_text || p.story_text) {
    msgLines.push('階数: ' + (p.floor_text || '?') + '/' + (p.story_text || '?'));
  }
  if (p.deposit || p.key_money) {
    msgLines.push('敷金: ' + (p.deposit || 'なし') + ' / 礼金: ' + (p.key_money || 'なし'));
  }
  if (p.move_in_date) msgLines.push('入居: ' + p.move_in_date);
  if (p.reins_property_number) msgLines.push('物件番号: ' + p.reins_property_number);
  if (p.ad_fee) msgLines.push('広告料: ' + p.ad_fee);
  if (p.current_status) msgLines.push('現況: ' + p.current_status);
  else if (p.listing_status) msgLines.push('現況: ' + p.listing_status);
  const ownerCompany = p.owner_company || p.reins_shougo || '';
  const ownerPhone = p.owner_phone || p.reins_tel || '';
  if (ownerCompany) msgLines.push('元付: ' + ownerCompany + (ownerPhone ? ' (' + ownerPhone + ')' : ''));

  // SUUMO競合数
  if (p.suumo_competitor && typeof p.suumo_competitor === 'object') {
    const sc = p.suumo_competitor;
    const compLine = '🏙️ SUUMO競合: 物件名あり:' + (sc.withName || 0) + '件(うちハイライト' + (sc.withNameHighlighted || 0) + '件)'
                   + ' / なし:' + (sc.withoutName || 0) + '件(うちハイライト' + (sc.withoutNameHighlighted || 0) + '件)';
    msgLines.push(compLine);
    if (sc.url) msgLines.push('[🔍 SUUMO検索結果](' + sc.url + ')');
  }

  // 反響予測スコア (事前計算済みの場合のみ表示)
  if (p.inquiry_score && typeof p.inquiry_score.score === 'number') {
    const s = p.inquiry_score;
    msgLines.push('📊 反響予測: **' + s.score + '点** ' + s.label);
    if (p.inquiry_market && p.inquiry_market.median) {
      const im = p.inquiry_market;
      let mLine = '  └ 相場 ¥' + im.median + '/㎡ (' + im.sampleSize + '件・filter:' + im.filterUsed + ')';
      if (im.searchUrl) mLine += ' [🔍相場検索](' + im.searchUrl + ')';
      msgLines.push(mLine);
    }
    if (s.breakdown) {
      const b = s.breakdown;
      const parts = [];
      if (b.score1 !== null) parts.push('単価:' + b.score1);
      if (b.score2 !== null) parts.push('徒歩:' + b.score2);
      if (b.score3 !== null) parts.push('築年:' + b.score3);
      if (parts.length > 0) msgLines.push('  └ 内訳: ' + parts.join(' / ') + ' (設備' + b.equipmentCount + '個)');
    }
  }

  // 画像枚数カウント(11枚以下なら警告)
  let imageCount = 0;
  if (p.image_urls && Array.isArray(p.image_urls)) imageCount = p.image_urls.length;
  else if (p.imageUrls && Array.isArray(p.imageUrls)) imageCount = p.imageUrls.length;
  if (imageCount === 0 && p.image_url) imageCount = 1;
  if (imageCount <= 11) {
    warnings.push('⚠️ 画像: ' + imageCount + '枚(11枚以下なので要確認)');
  }

  if (warnings.length > 0) {
    msgLines.push('```ansi\n\u001b[0;33m' + warnings.join('\n') + '\u001b[0m\n```');
  }

  msgLines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (p.url) {
    msgLines.push('[🔗 詳細ページ](' + p.url + ')');
  } else if (p.reins_property_number) {
    const cleanNum = String(p.reins_property_number).replace(/\D/g, '');
    msgLines.push('[🔗 REINSで開く](https://system.reins.jp/main/BK/GBK004100#bukken=' + cleanNum + ')');
  }
  msgLines.push('[📋 承認ページを開く](' + approveUrl + ')');
  msgLines.push('巡回条件: ' + (criteriaName || '不明'));

  return msgLines.join('\n');
}

/**
 * SUUMO巡回 Discord 通知をユーザーIPから送信
 * @param {Array} notifyProps - GAS が返した newProperties の整形版 [{key, property, sheetRowIndex}]
 * @param {string} criteriaName
 * @param {string} gasUrl - 承認URL構築用
 * @param {string} webhookUrl - SUUMO_DISCORD_WEBHOOK_URL
 * @returns {Promise<{sent: number, errors: string[], sheetRowIndexes: number[]}>}
 *   sheetRowIndexes: 送信成功した sheetRowIndex の配列(GAS にマーク依頼用)
 */
async function sendSuumoDiscordFromExtension_(notifyProps, criteriaName, gasUrl, webhookUrl) {
  if (!webhookUrl || !notifyProps || notifyProps.length === 0) {
    return { sent: 0, errors: [], sheetRowIndexes: [] };
  }

  // 巡回ごとに新規スレッド作成
  const threadId = await createSuumoPatrolThread_(webhookUrl);

  let sent = 0;
  const errors = [];
  const successIndexes = [];
  for (let i = 0; i < notifyProps.length; i++) {
    const item = notifyProps[i];
    const p = item.property || {};

    // 反響予測スコアを事前計算 (失敗してもメッセージ送信は継続)
    const _bldName = p.building_name || p.buildingName || p.building || '';
    const _roomNo = p.room_number || p.roomNumber || p.room || '';
    try {
      const fnsOk = (typeof getSuumoMarketMedian === 'function'
        && typeof calculateInquiryScore === 'function'
        && typeof buildInquiryScoreInput === 'function'
        && typeof extractWalkMinutes === 'function'
        && typeof extractBuildingAge === 'function');
      console.log('[SUUMO反響] 計算開始', _bldName, _roomNo, 'fnsOk=', fnsOk,
        'address=', p.address, 'layout=', p.layout, 'area=', p.area);
      if (!fnsOk) {
        await setStorageData({ debugLog: '[反響スコア] 関数未ロード ' + _bldName + ' ' + _roomNo });
      } else {
        const propertyType = (p.structure && /木造/.test(p.structure)) ? 'アパート' : 'マンション';
        const median = await getSuumoMarketMedian({
          address: p.address,
          layout: p.layout || '',
          area: Number(p.area) || 0,
          buildingAge: extractBuildingAge(p),
          walkMinutes: extractWalkMinutes(p),
          propertyType: propertyType
        });
        console.log('[SUUMO反響] median結果', _bldName, 'ok=', median && median.ok,
          'sampleSize=', median && median.sampleSize, 'errors=', median && median.errors);
        if (median && median.ok) {
          const input = buildInquiryScoreInput(p, median.median);
          const scoreResult = calculateInquiryScore(input);
          p.inquiry_score = scoreResult;
          p.inquiry_market = median;
          await setStorageData({ debugLog:
            '[反響スコア] ' + _bldName + ' ' + _roomNo + ' → ' + scoreResult.score + '点 (' + scoreResult.label + ')'
          });
        } else {
          await setStorageData({ debugLog:
            '[反響スコア] ' + _bldName + ' ' + _roomNo + ' → 計算失敗: ' + ((median && median.errors && median.errors.join(',')) || 'unknown')
          });
        }
      }
    } catch (e) {
      console.warn('[SUUMO巡回] 反響スコア計算失敗:', e && e.message);
      await setStorageData({ debugLog: '[反響スコア] ' + _bldName + ' ' + _roomNo + ' → 例外: ' + (e && e.message) });
    }

    const content = buildSuumoDiscordMessageContent_(p, criteriaName, gasUrl, item.key);

    const payload = { content };
    let postUrl = webhookUrl;
    if (threadId) {
      // 既存スレッドに追記投稿
      postUrl = webhookUrl + (webhookUrl.indexOf('?') >= 0 ? '&' : '?') + 'thread_id=' + encodeURIComponent(threadId);
    } else {
      // スレッド取得失敗時のフォールバック: forum 新スレッド作成
      const building = p.building_name || p.buildingName || p.building || '';
      const room = p.room_number || p.roomNumber || p.room || '';
      const rentDisplay = p.rent ? (p.rent / 10000).toFixed(2) + '万円' : '不明';
      payload.thread_name = building + ' ' + room + '号室 - ' + rentDisplay;
    }

    // 429/5xxは指数バックオフでリトライ(最大3回)
    let success = false;
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch(postUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (resp.ok) {
          sent++;
          success = true;
          if (item.sheetRowIndex) successIndexes.push(item.sheetRowIndex);
          break;
        }
        const bodyText = (await resp.text().catch(() => '')).substring(0, 200);
        lastErr = `HTTP ${resp.status}: ${bodyText.replace(/\s+/g, ' ')}`;
        if (resp.status === 429 || resp.status >= 500) {
          // Retry-After 尊重
          let waitMs = 0;
          const retryHeader = resp.headers.get('Retry-After');
          if (retryHeader) waitMs = parseFloat(retryHeader) * 1000;
          try {
            const j = JSON.parse(bodyText);
            if (j.retry_after) waitMs = Math.max(waitMs, parseFloat(j.retry_after) * 1000);
          } catch (_) {}
          if (waitMs <= 0) waitMs = Math.min(5000 * Math.pow(3, attempt), 60000);
          if (waitMs > 60000) {
            lastErr = `Retry-After過大: ${Math.round(waitMs/1000)}s(次回巡回で再送)`;
            break;
          }
          await sleep(waitMs);
          continue;
        }
        break; // その他エラーはリトライしない
      } catch (err) {
        lastErr = err.message;
        await sleep(2000);
      }
    }
    if (!success) errors.push(lastErr);
    // 物件間ディレイ(レート制限緩和)
    if (i < notifyProps.length - 1) await sleep(1000);
  }
  return { sent, errors, sheetRowIndexes: successIndexes };
}

/**
 * Chrome拡張から GAS へ「Discord送信成功した sheetRowIndex 群をマークして」と依頼
 */
async function markSuumoDiscordSentInGas_(sheetRowIndexes) {
  if (!sheetRowIndexes || sheetRowIndexes.length === 0) return;
  try {
    const { gasWebappUrl } = await getStorageData(['gasWebappUrl']);
    if (!gasWebappUrl) return;
    await fetch(gasWebappUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mark_suumo_discord_sent', sheetRowIndexes })
    });
  } catch (_) {}
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
