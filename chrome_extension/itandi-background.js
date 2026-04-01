/**
 * itandi-background.js
 * itandi BB 検索オーケストレーション（Service Worker用）
 * importScripts() で background.js から読み込まれる
 *
 * 依存: itandi-config.js（先にimportScripts）、background.jsの共通関数
 *  - sleep(), getStorageData(), setStorageData(), gasPost(), submitProperties()
 *  - sendDiscordNotification(), getFilterRejectReason(), waitForTabLoad()
 *  - isSearchCancelled(), logError()
 *
 * Python itandi_search/ からの移植:
 *  - 検索: API POST (fetch) で物件取得
 *  - 詳細: 専用タブで詳細ページに遷移 → content script でスクレイピング
 *  - フィルタ: 共通フィルタ + itandi固有フィルタ
 */

// itandi専用ウィンドウ管理
let dedicatedItandiTabId = null;
let dedicatedItandiWindowId = null;

// 駅名→station_idキャッシュ（同一サイクル内で再利用）
let itandiStationCache = {};

// === 価格テキストパーサー ===

function _parseItandiPriceText(text) {
  if (!text || text === '-' || text === 'なし' || text === 'ー' || text === '—') return 0;
  text = text.replace(/,/g, '').replace(/円/g, '').trim();
  const m = text.match(/([\d.]+)\s*万/);
  if (m) return Math.floor(parseFloat(m[1]) * 10000);
  const m2 = text.match(/[\d.]+/);
  if (m2) return Math.floor(parseFloat(m2[0]));
  return 0;
}

function _parseItandiAreaText(text) {
  if (!text) return 0;
  const m = text.match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

// === 間取りマッピング ===

function _mapItandiLayouts(layouts) {
  const result = [];
  for (const l of layouts) {
    const trimmed = l.trim();
    if (!trimmed) continue;
    if (ITANDI_LAYOUT_SPECIAL[trimmed]) {
      result.push(...ITANDI_LAYOUT_SPECIAL[trimmed]);
    } else {
      result.push(trimmed);
    }
  }
  // 重複除去
  return [...new Set(result)];
}

// === ページコンテキスト内でAPI呼び出しを実行 ===
// itandi BBはCSRFトークン + Cookieベース認証のため、
// Service Workerからの直接fetchではなく、ログイン済みタブ内でfetchを実行する

/**
 * 専用タブのページコンテキスト内でGET APIを実行する。
 */
async function itandiApiGet(tabId, url) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (apiUrl) => {
      return new Promise((resolve) => {
        fetch(apiUrl, {
          method: 'GET',
          credentials: 'include',
          headers: { 'Accept': 'application/json, text/plain, */*' }
        })
        .then(r => r.text().then(t => resolve({ status: r.status, body: t })))
        .catch(e => resolve({ status: 0, body: '', error: e.message }));
      });
    },
    args: [url],
  });

  const result = results?.[0]?.result;
  if (!result || result.status === 0) {
    throw new Error(result?.error || 'API通信エラー');
  }
  if (result.status === 401) throw new Error('ITANDI_LOGIN_REQUIRED');
  if (result.status !== 200) throw new Error(`APIエラー (${result.status})`);
  return JSON.parse(result.body);
}

/**
 * 専用タブのページコンテキスト内でPOST APIを実行する。
 * CSRFトークンをCookieから取得して自動付与。
 */
async function itandiApiPost(tabId, url, payload) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (apiUrl, bodyJson) => {
      // CSRFトークンをCookieから取得
      let csrfToken = '';
      const cookies = document.cookie.split(';');
      for (const c of cookies) {
        const trimmed = c.trim();
        if (trimmed.startsWith('CSRF-TOKEN=')) {
          csrfToken = decodeURIComponent(trimmed.substring('CSRF-TOKEN='.length));
          break;
        }
      }

      return new Promise((resolve) => {
        fetch(apiUrl, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
            'X-CSRF-TOKEN': csrfToken,
            'Pragma': 'no-cache'
          },
          body: bodyJson
        })
        .then(r => r.text().then(t => resolve({ status: r.status, body: t })))
        .catch(e => resolve({ status: 0, body: '', error: e.message }));
      });
    },
    args: [url, JSON.stringify(payload)],
  });

  const result = results?.[0]?.result;
  if (!result || result.status === 0) {
    throw new Error(result?.error || 'API通信エラー');
  }
  if (result.status === 401) throw new Error('ITANDI_LOGIN_REQUIRED');
  if (result.status === 422) throw new Error(`itandi検索パラメータ不正 (422): ${result.body?.substring(0, 200) || ''}`);
  if (result.status === 429) throw new Error('itandiレート制限 (429)');
  if (result.status !== 200) throw new Error(`itandi APIエラー (${result.status}): ${result.body?.substring(0, 200) || ''}`);
  return JSON.parse(result.body);
}

// === 駅名 → station_id 解決 ===

async function resolveItandiStationIds(tabId, customer) {
  const prefecture = customer.prefecture || '東京都';
  const prefectureId = ITANDI_PREFECTURE_IDS[prefecture] || null;

  // routes_with_stations または stations から駅名を取得
  let stationNames = [];
  const rws = customer.routes_with_stations || [];
  if (rws.length > 0) {
    stationNames = rws.flatMap(r => r.stations || []);
  }
  if (stationNames.length === 0) {
    stationNames = customer.stations || [];
  }
  if (stationNames.length === 0) return [];

  const allIds = [];

  for (const name of stationNames) {
    const cleanName = name.replace(/駅$/, '').trim();
    if (!cleanName) continue;

    // キャッシュチェック
    const cacheKey = `${cleanName}_${prefectureId}`;
    if (itandiStationCache[cacheKey]) {
      allIds.push(...itandiStationCache[cacheKey]);
      continue;
    }

    // マッピングテーブルで検索名候補を取得
    const mappedValue = ITANDI_STATION_NAME_MAP[cleanName];
    let searchNames;
    if (Array.isArray(mappedValue)) {
      searchNames = mappedValue;
    } else if (mappedValue) {
      searchNames = [mappedValue];
    } else {
      searchNames = [cleanName];
    }

    try {
      const matched = [];

      for (const searchName of searchNames) {
        const url = `${ITANDI_STATIONS_API_URL}?name=${encodeURIComponent(searchName)}`;
        const data = await itandiApiGet(tabId, url);
        const stations = data.stations || [];

        // 1. 完全一致
        for (const st of stations) {
          if (st.label !== searchName) continue;
          if (prefectureId && st.prefecture_id !== prefectureId) continue;
          if (!matched.includes(st.id)) matched.push(st.id);
        }

        if (matched.length > 0) break; // 見つかったら次の候補は試さない
      }

      // 2. 完全一致で見つからなかった場合、前方一致フォールバック
      if (matched.length === 0) {
        const primarySearch = searchNames[0];
        const url = `${ITANDI_STATIONS_API_URL}?name=${encodeURIComponent(primarySearch)}`;
        const data = await itandiApiGet(tabId, url);
        const stations = data.stations || [];

        for (const st of stations) {
          if (!st.label.startsWith(primarySearch) && !primarySearch.startsWith(st.label)) continue;
          if (prefectureId && st.prefecture_id !== prefectureId) continue;
          if (!matched.includes(st.id)) matched.push(st.id);
        }

        if (matched.length > 0) {
          console.log(`[itandi] 駅名「${cleanName}」→ 前方一致でマッチ`);
        }
      }

      // 3. ケ/ヶ/ガ の表記揺れ自動変換（マッピングテーブルになかった場合）
      if (matched.length === 0 && /[ケヶが]/.test(cleanName)) {
        const variants = [
          cleanName.replace(/[ケヶが]/g, 'ケ'),
          cleanName.replace(/[ケヶが]/g, 'ヶ'),
          cleanName.replace(/[ケヶが]/g, 'が'),
        ].filter(v => v !== cleanName);

        for (const variant of variants) {
          const url = `${ITANDI_STATIONS_API_URL}?name=${encodeURIComponent(variant)}`;
          const data = await itandiApiGet(tabId, url);
          const stations = data.stations || [];

          for (const st of stations) {
            if (st.label !== variant) continue;
            if (prefectureId && st.prefecture_id !== prefectureId) continue;
            if (!matched.includes(st.id)) matched.push(st.id);
          }

          if (matched.length > 0) {
            console.log(`[itandi] 駅名「${cleanName}」→「${variant}」で表記揺れマッチ`);
            break;
          }
        }
      }

      itandiStationCache[cacheKey] = matched;
      allIds.push(...matched);

      if (matched.length === 0) {
        console.warn(`[itandi] 駅名「${cleanName}」に一致する駅がありません`);
      }
    } catch (err) {
      if (err.message === 'ITANDI_LOGIN_REQUIRED') throw err;
      console.warn(`[itandi] 駅検索APIエラー (${cleanName}):`, err.message);
    }
  }

  return allIds;
}

// === 設備テキスト → equipment_ids 変換 ===

/**
 * 顧客の設備テキスト（M列）から itandi API の equipment_ids を解決する。
 * Python itandi_search/sheets.py の設備パース処理に相当。
 */
function resolveItandiEquipmentIds(equipmentText) {
  if (!equipmentText) return { hard: [], soft: [] };
  const toHankaku = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const text = toHankaku(equipmentText);

  const hardIds = [];
  const softIds = [];
  const seenIds = new Set();

  // 設備名をカンマ・読点・スラッシュで分割
  const items = text.split(/[,、，\/／]/).map(s => s.trim()).filter(Boolean);

  for (const item of items) {
    // ITANDI_EQUIPMENT_IDS でマッチするか
    const id = ITANDI_EQUIPMENT_IDS[item];
    if (id && !seenIds.has(id)) {
      seenIds.add(id);
      if (ITANDI_SOFT_EQUIPMENT_IDS.has(id)) {
        softIds.push(id);
      } else {
        hardIds.push(id);
      }
    }
  }

  return { hard: hardIds, soft: softIds };
}

// === 検索ペイロード構築 ===

function buildItandiSearchPayload(customer, stationIds) {
  const filterObj = {};
  const prefecture = customer.prefecture || '東京都';
  const prefectureId = ITANDI_PREFECTURE_IDS[prefecture] || null;

  // エリア（市区町村）
  const cities = customer.cities || [];
  if (cities.length > 0 && prefectureId) {
    filterObj['address:in'] = cities
      .filter(c => c.trim())
      .map(c => ({ city: c.trim(), prefecture_id: prefectureId }));
  }

  // 駅
  if (stationIds && stationIds.length > 0) {
    filterObj['station_id:in'] = stationIds;
  } else if (!filterObj['address:in'] && prefectureId) {
    // 市区町村も駅もない場合、都道府県で安全策
    filterObj['address:in'] = [{ prefecture_id: prefectureId }];
  }

  // 賃料（管理費込み・万円→円）
  if (customer.rent_min) {
    filterObj['total_rent:gteq'] = parseFloat(customer.rent_min) * 10000;
  }
  if (customer.rent_max) {
    filterObj['total_rent:lteq'] = parseFloat(customer.rent_max) * 10000;
  }

  // 間取り
  const layouts = customer.layouts || [];
  if (layouts.length > 0) {
    const mapped = _mapItandiLayouts(layouts);
    if (mapped.length > 0) {
      filterObj['room_layout:in'] = mapped;
    }
  }

  // 専有面積
  if (customer.area_min) {
    filterObj['floor_area_amount:gteq'] = parseFloat(customer.area_min);
  }

  // 築年数
  if (customer.building_age) {
    const ageStr = String(customer.building_age).trim();
    if (!ageStr.includes('新築')) {
      const ageNum = parseInt(ageStr.replace(/[^\d]/g, ''));
      if (ageNum > 0) {
        filterObj['building_age:lteq'] = ageNum;
      }
    }
  }

  // 駅徒歩
  const walkMin = customer.walk ? parseInt(String(customer.walk).replace(/[^\d]/g, '')) : 0;
  if (walkMin > 0) {
    filterObj['station_walk_minutes:lteq'] = walkMin;
  }

  // 構造
  if (customer.structures && customer.structures.length > 0) {
    const structureApiValues = [];
    for (const s of customer.structures) {
      if (ITANDI_STRUCTURE_CATEGORY_MAP[s]) {
        structureApiValues.push(...ITANDI_STRUCTURE_CATEGORY_MAP[s]);
      } else if (ITANDI_STRUCTURE_TYPE_MAP[s]) {
        structureApiValues.push(ITANDI_STRUCTURE_TYPE_MAP[s]);
      }
    }
    if (structureApiValues.length > 0) {
      filterObj['structure_type:in'] = [...new Set(structureApiValues)];
    }
  }

  // 設備（テキストからID解決、ハードフィルタのみAPIに送信）
  const resolved = resolveItandiEquipmentIds(customer.equipment);
  if (resolved.hard.length > 0) {
    filterObj['option_id:all_in'] = resolved.hard;
  }

  // 階数フィルタ（1階 or 2階以上）
  const toHankaku = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const equip = toHankaku(customer.equipment || '').toLowerCase();
  if (equip.includes('2階以上')) {
    filterObj['floor:gteq'] = 2;
  } else if (equip.includes('1階') && !equip.includes('1階以上')) {
    filterObj['floor:lteq'] = 1;
  }

  // 敷金なし・礼金なし
  if (equip.includes('敷金なし')) {
    filterObj['shikikin:eq'] = 0;
  }
  if (equip.includes('礼金なし')) {
    filterObj['reikin:eq'] = 0;
  }

  return {
    aggregation: {
      bucket_size: 5,
      field: 'building_id',
      next_bucket_existance_check: true,
    },
    filter: filterObj,
    page: { limit: 20, page: 1 },
    sort: [{ last_status_opened_at: 'desc' }],
  };
}

// === 検索レスポンスパース ===

function parseItandiSearchResponse(data) {
  const properties = [];
  const buildings = data.buildings || [];

  for (const bldg of buildings) {
    if (!bldg || typeof bldg !== 'object') continue;

    const propertyId = bldg.property_id || 0;
    const buildingName = bldg.name || '';
    const address = bldg.address_text || '';
    const buildingAge = bldg.building_age_text || '';
    const imageUrlBldg = bldg.image_url || '';
    const storyText = bldg.story_text || '';

    // 最寄り駅
    const stationTexts = bldg.nearby_train_station_texts || [];
    const stationInfo = stationTexts[0] || '';
    const otherStations = stationTexts.slice(1);

    const rooms = bldg.rooms || [];
    if (rooms.length === 0) continue;

    for (const room of rooms) {
      if (!room || typeof room !== 'object') continue;
      const roomId = room.property_id || room.id || 0;
      if (!roomId) continue;

      const rent = _parseItandiPriceText(room.rent_text || '');
      const managementFee = _parseItandiPriceText(
        room.kanrihi_text || room.kanrihi_kyoekihi_text || ''
      );
      const deposit = room.shikikin_text || '';
      const keyMoney = room.reikin_text || '';
      const layout = room.layout_text || '';
      const area = _parseItandiAreaText(room.floor_area_text || '');
      const imageUrl = room.madori_image_url || imageUrlBldg;
      const roomNumber = room.room_number || '';

      properties.push({
        source: 'itandi',
        building_id: String(propertyId),
        room_id: String(roomId),
        building_name: buildingName,
        address: address,
        rent: rent,
        management_fee: managementFee,
        deposit: deposit,
        key_money: keyMoney,
        layout: layout,
        area: area,
        floor: 0,
        floor_text: '',
        building_age: buildingAge,
        station_info: stationInfo,
        other_stations: otherStations,
        room_number: roomNumber,
        url: `${ITANDI_BASE_URL}/rent_rooms/${roomId}`,
        image_url: imageUrl,
        image_urls: [],
        story_text: storyText,
        // 詳細ページで補完されるフィールド
        structure: '',
        facilities: '',
        move_in_date: '',
        lease_type: '',
        listing_status: '',
        sunlight: '',
        total_units: '',
        contract_period: '',
        renewal_fee: '',
        key_exchange_fee: '',
        fire_insurance: '',
        guarantee_info: '',
        parking_fee: '',
        free_rent: '',
        other_monthly_fee: '',
        other_onetime_fee: '',
        shikibiki: '',
        layout_detail: '',
        web_badge_count: -1,
        needs_confirmation: false,
      });
    }
  }

  return properties;
}

// === 専用ウィンドウ管理 ===

async function findOrCreateDedicatedItandiTab() {
  // 既存の専用タブが生きているか確認
  if (dedicatedItandiTabId) {
    try {
      const tab = await chrome.tabs.get(dedicatedItandiTabId);
      if (tab && tab.url?.includes('itandibb.com')) {
        return tab;
      }
    } catch (e) {
      // タブが閉じられている
    }
    dedicatedItandiTabId = null;
    dedicatedItandiWindowId = null;
  }

  // 専用ウィンドウを作成
  await setStorageData({ debugLog: '[itandi] 専用ウィンドウを作成中...' });
  const newWindow = await chrome.windows.create({
    url: `${ITANDI_BASE_URL}/rent_rooms/list`,
    focused: false,
    width: 1200,
    height: 800,
    left: 0,
    top: 0,
    type: 'normal'
  });
  dedicatedItandiWindowId = newWindow.id;
  dedicatedItandiTabId = newWindow.tabs[0].id;

  // ページ読み込み完了を待つ
  await waitForTabLoad(dedicatedItandiTabId);
  await sleep(3000); // React SPA 考慮

  // ログイン状態を確認
  const tab = await chrome.tabs.get(dedicatedItandiTabId);
  if (tab.url?.includes('itandi-accounts.com') || tab.url?.includes('/login')) {
    await setStorageData({ debugLog: '[itandi] itandiにログインしてください（itandibb.comでログイン後に再実行）' });
    await closeDedicatedItandiWindow();
    return null;
  }

  await setStorageData({ debugLog: `[itandi] 専用タブ作成: tabId=${dedicatedItandiTabId}` });
  return tab;
}

async function closeDedicatedItandiWindow() {
  if (dedicatedItandiWindowId) {
    try {
      await chrome.windows.remove(dedicatedItandiWindowId);
    } catch (e) {
      // 既に閉じられている
    }
    dedicatedItandiWindowId = null;
    dedicatedItandiTabId = null;
  }
}

// === itandi固有フィルタ ===

function getItandiFilterRejectReason(prop, customer) {
  // 賃料フィルタ（rent + management_fee vs rent_max万円）
  if (customer.rent_max) {
    const totalRent = (prop.rent || 0) + (prop.management_fee || 0);
    const rentMaxYen = parseFloat(customer.rent_max) * 10000;
    if (totalRent > rentMaxYen) {
      return `賃料超過: ${totalRent}円 > ${rentMaxYen}円`;
    }
  }

  // ステータス・WEBバッジフィルタ（テストユーザーはスキップ）
  const isTestUser = customer.name?.includes('テスト');
  if (!isTestUser) {
    if (prop.listing_status === '申込あり') {
      return '申込あり';
    }
    if (prop.web_badge_count >= 1) {
      return `WEBバッジ ${prop.web_badge_count}件`;
    }
  }

  const toHankaku = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const equip = toHankaku(customer.equipment || '').toLowerCase();

  const isNoneValue = (s) => !s || s === '-' || s === 'なし' || s === '0' || s === '0円' || s === '無' || s.trim() === '';

  // 敷金なし
  if (equip.includes('敷金なし')) {
    if (!isNoneValue(prop.deposit)) {
      return `敷金あり: ${prop.deposit}`;
    }
  }

  // 礼金なし
  if (equip.includes('礼金なし')) {
    if (!isNoneValue(prop.key_money)) {
      return `礼金あり: ${prop.key_money}`;
    }
  }

  // フリーレント → アラート（buildDiscordMessageで処理）

  // 定期借家除外
  if (equip.includes('定期借家除く') || equip.includes('定期借家ng')) {
    if (prop.lease_type && prop.lease_type.includes('定期')) {
      return `定期借家: ${prop.lease_type}`;
    }
  }

  // ロフトNG
  if (equip.includes('ロフトng') || equip.includes('ロフト不可')) {
    if (prop.facilities && prop.facilities.includes('ロフト')) {
      return 'ロフトNG: ロフト付き物件';
    }
  }

  // 設備フィルタ（設備情報がある場合のみチェック）
  const fac = prop.facilities || '';
  if (fac) {
    // 室内洗濯機置場 → アラート（buildDiscordMessageで処理）
    // ロフト希望 → アラート（buildDiscordMessageで処理）
    // エアコン → アラート（buildDiscordMessageで処理）
    // 床暖房 → アラート（buildDiscordMessageで処理）

    // 家具家電付き → 検索APIでフィルタ済み（option_id 19010）、アラートはbuildDiscordMessageで処理

    // バス・トイレ別 → アラート（buildDiscordMessageで処理）
    // 独立洗面台 → アラート（buildDiscordMessageで処理）
    // 温水洗浄便座 → アラート（buildDiscordMessageで処理）
    // 浴室乾燥機 → アラート（buildDiscordMessageで処理）
    // 追い焚き → アラート（buildDiscordMessageで処理）
    // ガスコンロ → アラート（buildDiscordMessageで処理）
    // IHコンロ → アラート（buildDiscordMessageで処理）
    // コンロ2口以上 → アラート（buildDiscordMessageで処理）
    // システムキッチン → アラート（buildDiscordMessageで処理）
    // カウンターキッチン → アラート（buildDiscordMessageで処理）
    // 駐輪場 → アラート（buildDiscordMessageで処理）
    // エレベーター → アラート（buildDiscordMessageで処理）
    // 宅配ボックス → アラート（buildDiscordMessageで処理）
    // 敷地内ゴミ置場 → アラート（buildDiscordMessageで処理）
    // バルコニー → アラート（buildDiscordMessageで処理）
    // ルーフバルコニー → アラート（buildDiscordMessageで処理）
    // 専用庭 → アラート（buildDiscordMessageで処理）

    // ガス種別（一方がある場合はスキップ。情報なしは通過→アラート）
    if (equip.includes('都市ガス') && !fac.includes('都市ガス') && (fac.includes('プロパン') || fac.includes('LPガス'))) return 'プロパンガス物件（都市ガス希望）';
    if ((equip.includes('プロパン') || equip.includes('lpガス')) && !fac.includes('プロパン') && !fac.includes('LPガス') && fac.includes('都市ガス')) return '都市ガス物件（プロパンガス希望）';
    // オートロック → アラート（buildDiscordMessageで処理）
    // TVモニタ付きインターホン → アラート（buildDiscordMessageで処理）
    // 防犯カメラ → アラート（buildDiscordMessageで処理）
    // ペット可
    if (equip.includes('ペット')) {
      if (fac.includes('ペット不可')) return 'ペット不可';
      if (!fac.includes('ペット相談') && !fac.includes('ペット可') && !fac.includes('小型犬') && !fac.includes('大型犬') && !fac.includes('猫可')) return 'ペット可の記載なし';
    }
    // 楽器
    if (equip.includes('楽器') && fac.includes('楽器不可')) return '楽器不可';
    // 事務所
    if (equip.includes('事務所')) {
      if (fac.includes('事務所不可')) return '事務所利用不可';
      if (!fac.includes('事務所可') && !fac.includes('事務所使用相談')) return '事務所利用可の記載なし';
    }
    // ルームシェア
    if ((equip.includes('ルームシェア') || equip.includes('シェアハウス')) && fac.includes('ルームシェア不可')) return 'ルームシェア不可';
    // 高齢者
    if (equip.includes('高齢者') && fac.includes('高齢者不可')) return '高齢者不可';
  }

  // 階数フィルタ
  const floorNum = prop.floor || 0;
  if (equip.includes('2階以上') && floorNum > 0 && floorNum < 2) return `2階以上条件: ${floorNum}階`;
  if (equip.includes('1階') && !equip.includes('1階以上') && !equip.includes('2階以上') && floorNum > 0 && floorNum !== 1) return `1階限定条件: ${floorNum}階`;

  // 共通フィルタ（構造・最上階・南向き・間取り等）
  const commonReason = getFilterRejectReason(prop, customer);
  if (commonReason) return commonReason;

  return null;
}

// === content script 通信 ===

function sendItandiContentMessage(tabId, message, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('itandi content script応答タイムアウト'));
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

// === property_data_json構築 ===

function buildItandiPropertyDataJson(prop) {
  return {
    source: 'itandi',
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
    other_stations: prop.other_stations || [],
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

// === メイン検索関数 ===

/**
 * itandi BB 全顧客検索を実行する。
 * background.js の runSearchCycle() から呼ばれる。
 */
async function runItandiSearch(criteria, seenIds, searchId) {
  // 駅名キャッシュをリセット
  itandiStationCache = {};

  await setStorageData({ debugLog: '[itandi] 検索開始...' });

  // 専用タブを作成（API呼び出し＋詳細スクレイピング共用）
  const itandiTab = await findOrCreateDedicatedItandiTab();
  if (!itandiTab) return;

  try {
    for (let ci = 0; ci < criteria.length; ci++) {
      if (isSearchCancelled(searchId)) return;

      const customer = criteria[ci];
      await setStorageData({ debugLog: `[itandi] 顧客 ${ci+1}/${criteria.length}: ${customer.name}` });
      try {
        const cond = formatCustomerCriteria(customer);
        await setStorageData({ debugLog: `[itandi] 条件: ${cond}` });
      } catch (e) {
        await setStorageData({ debugLog: `[itandi] 条件表示エラー: ${e.message}` });
      }

      try {
        await searchItandiForCustomer(dedicatedItandiTabId, customer, seenIds, searchId);
      } catch (err) {
        if (err.message === 'SEARCH_CANCELLED') return;
        if (err.message === 'SLEEP_DETECTED') {
          await setStorageData({ debugLog: '[itandi] PCスリープ検知→検索中断' });
          return;
        }
        if (err.message === 'ITANDI_LOGIN_REQUIRED') {
          await setStorageData({ debugLog: '[itandi] ログインが必要です。itandibb.comでログインしてください。' });
          return;
        }
        logError(`[itandi] ${customer.name}の検索失敗: ${err.message}`);
      }

      // 顧客間の待ち時間
      if (ci < criteria.length - 1) await sleep(3000);
    }
  } finally {
    // 中止時はタブを閉じない（確認用に残す。background.jsのfinallyで制御）
    if (!isSearchCancelled(searchId)) {
      await closeDedicatedItandiWindow();
    }
  }
}

/**
 * 1顧客分のitandi BB検索を実行する。
 */
async function searchItandiForCustomer(tabId, customer, seenIds, searchId) {
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
  let submittedCount = 0;

  // 駅名→station_id解決
  let stationIds = null;
  const rws = customer.routes_with_stations || [];
  const stationNames = rws.length > 0
    ? rws.flatMap(r => r.stations || [])
    : (customer.stations || []);

  if (stationNames.length > 0) {
    try {
      stationIds = await resolveItandiStationIds(tabId, customer);
      if (stationIds.length > 0) {
        await setStorageData({ debugLog: `[itandi] ${customer.name}: station_ids解決 ${stationIds.length}件` });
      } else {
        await setStorageData({ debugLog: `[itandi] ${customer.name}: 駅名に一致するstation_idがありません` });
      }
    } catch (err) {
      await setStorageData({ debugLog: `[itandi] ${customer.name}: 駅解決エラー: ${err.message}` });
    }
  }

  // 検索ペイロード構築
  const payload = buildItandiSearchPayload(customer, stationIds);

  // 検索条件をログに出力（確認用）
  const f = payload.filter;
  const filterParts = [];
  if (f['total_rent:lteq']) filterParts.push(`賃料〜${f['total_rent:lteq']/10000}万`);
  if (f['total_rent:gteq']) filterParts.push(`賃料${f['total_rent:gteq']/10000}万〜`);
  if (f['station_id:in']) filterParts.push(`駅: ${stationNames.join('・')}(${f['station_id:in'].length}件)`);
  if (f['address:in']) filterParts.push(`エリア: ${f['address:in'].map(a => a.city || '都道府県').join(',')}`);
  if (f['room_layout:in']) filterParts.push(`間取り: ${f['room_layout:in'].join('/')}`);
  if (f['floor_area_amount:gteq']) filterParts.push(`面積${f['floor_area_amount:gteq']}㎡〜`);
  if (f['building_age:lteq']) filterParts.push(`築${f['building_age:lteq']}年`);
  if (f['station_walk_minutes:lteq']) filterParts.push(`徒歩${f['station_walk_minutes:lteq']}分`);
  if (f['structure_type:in']) filterParts.push(`構造: ${f['structure_type:in'].join('/')}`);
  if (f['option_id:all_in']) filterParts.push(`設備ID: ${f['option_id:all_in'].join(',')}`);
  if (f['floor:gteq']) filterParts.push('2階以上');
  if (f['floor:lteq'] === 1) filterParts.push('1階');
  if (f['shikikin:eq'] === 0) filterParts.push('敷金なし');
  if (f['reikin:eq'] === 0) filterParts.push('礼金なし');
  await setStorageData({ debugLog: `[itandi] ${customer.name}: API検索条件 → ${filterParts.join(' / ') || '(条件なし)'}` });
  await setStorageData({ debugLog: `[itandi] ${customer.name}: payload → ${JSON.stringify(payload)}` });

  // ページネーション（最大10ページ = 200件）
  const maxPages = 10;
  let allProperties = [];

  for (let page = 1; page <= maxPages; page++) {
    if (isSearchCancelled(searchId)) throw new Error('SEARCH_CANCELLED');

    payload.page.page = page;
    let data;
    try {
      // itandibb.comのページコンテキスト上にいることを確認
      const currentTab = await chrome.tabs.get(tabId);
      if (!currentTab.url?.includes('itandibb.com')) {
        // 詳細ページ遷移後などで別ドメインになっている場合、戻す
        await chrome.tabs.update(tabId, { url: `${ITANDI_BASE_URL}/rent_rooms/list` });
        await waitForTabLoad(tabId);
        await csleep(2000);
      }
      data = await itandiApiPost(tabId, ITANDI_SEARCH_API_URL, payload);
    } catch (err) {
      if (err.message === 'ITANDI_LOGIN_REQUIRED') throw err;
      await setStorageData({ debugLog: `[itandi] ${customer.name}: API page ${page} エラー: ${err.message}` });
      break;
    }

    const pageProps = parseItandiSearchResponse(data);
    allProperties.push(...pageProps);

    if (page === 1) {
      const totalCount = data.room_total_count || data.total_count || pageProps.length;
      await setStorageData({ debugLog: `[itandi] ${customer.name}: ${totalCount}件ヒット` });
    }

    // 次ページ確認
    const meta = data.meta || {};
    const agg = data.aggregation || {};
    const hasNext = meta.next_bucket_exists || agg.next_bucket_exists || false;
    if (!hasNext) break;

    await csleep(1000);
  }

  if (allProperties.length === 0) {
    await setStorageData({ debugLog: `[itandi] ${customer.name}: 検索結果0件` });
    return;
  }

  await setStorageData({ debugLog: `[itandi] ${customer.name}: ${allProperties.length}件取得、詳細確認中...` });

  // 各物件を処理
  for (const prop of allProperties) {
    if (isSearchCancelled(searchId)) throw new Error('SEARCH_CANCELLED');

    // 重複チェック
    const isTestUser = customer.name.includes('テスト');
    if (!isTestUser && customerSeenIds.includes(prop.room_id)) {
      continue;
    }

    // 詳細ページからスクレイピング
    try {
      await chrome.tabs.update(tabId, { url: prop.url });
      await waitForTabLoad(tabId);
      await csleep(2500); // React SPA の描画待ち

      // ログインチェック
      const detailTab = await chrome.tabs.get(tabId);
      if (detailTab.url?.includes('itandi-accounts.com') || detailTab.url?.includes('/login')) {
        throw new Error('ITANDI_LOGIN_REQUIRED');
      }

      let detailResult;
      try {
        detailResult = await sendItandiContentMessage(tabId, { type: 'ITANDI_EXTRACT_DETAIL' });
      } catch (err) {
        console.warn(`[itandi] 詳細取得失敗 (${prop.building_name}):`, err.message);
      }

      if (detailResult?.ok && detailResult.detail) {
        const d = detailResult.detail;
        // 詳細情報をマージ
        if (d.image_urls?.length) {
          prop.image_urls = d.image_urls;
          if (!prop.image_url && d.image_urls[0]) prop.image_url = d.image_urls[0];
        }
        if (d.listing_status) prop.listing_status = d.listing_status;
        if (d.web_badge_count !== undefined) prop.web_badge_count = d.web_badge_count;
        if (d.needs_confirmation) prop.needs_confirmation = d.needs_confirmation;
        if (d.facilities) prop.facilities = d.facilities;
        if (d.guarantee_info) prop.guarantee_info = d.guarantee_info;

        // その他の詳細フィールド
        const detailFields = [
          'floor_text', 'structure', 'total_units', 'lease_type', 'contract_period',
          'cancellation_notice', 'renewal_info', 'sunlight', 'shikibiki', 'pet_deposit',
          'free_rent', 'renewal_fee', 'renewal_admin_fee', 'fire_insurance',
          'key_exchange_fee', 'support_fee_24h', 'additional_deposit', 'guarantee_deposit',
          'water_billing', 'parking_fee', 'bicycle_parking_fee', 'motorcycle_parking_fee',
          'other_monthly_fee', 'other_onetime_fee', 'move_in_conditions', 'move_out_date',
          'move_in_date', 'free_rent_detail', 'layout_detail', 'preview_start_date',
        ];
        for (const key of detailFields) {
          if (d[key] && !prop[key]) {
            prop[key] = d[key];
          }
        }

        // 構造名を正規化
        if (prop.structure) {
          prop.structure = ITANDI_STRUCTURE_NORMALIZE[prop.structure] || prop.structure;
        }

        // 所在階をパースして floor に設定
        if (prop.floor_text) {
          const floorMatch = prop.floor_text.match(/(\d+)/);
          if (floorMatch) prop.floor = parseInt(floorMatch[1]);
        }
      }
    } catch (err) {
      if (err.message === 'ITANDI_LOGIN_REQUIRED' || err.message === 'SEARCH_CANCELLED' || err.message === 'SLEEP_DETECTED') {
        throw err;
      }
      console.warn(`[itandi] 詳細処理エラー (${prop.building_name}):`, err.message);
    }

    // フィルタリング
    const rejectReason = getItandiFilterRejectReason(prop, customer);
    if (rejectReason) {
      await setStorageData({ debugLog: `[itandi] ${customer.name}: ✗ スキップ: ${prop.building_name} ${prop.room_number || ''} - ${rejectReason}` });
      continue;
    }

    // property_data_json構築
    prop.property_data_json = JSON.stringify(buildItandiPropertyDataJson(prop));

    submittedCount++;
    await setStorageData({ debugLog: `[itandi] ${customer.name}: ✓ 送信対象（${prop.building_name} ${prop.room_number || ''} ${prop.rent ? (prop.rent/10000)+'万' : ''}）` });

    // GAS送信（1物件ずつ）
    try {
      const submitResult = await submitProperties(customer.name, [prop]);
      if (submitResult?.success) {
        const { stats } = await getStorageData(['stats']);
        const currentStats = stats || { totalFound: 0, totalSubmitted: 0, errors: [], lastError: null };
        currentStats.totalFound++;
        currentStats.totalSubmitted += submitResult.added || 1;
        await setStorageData({ stats: currentStats });
      }
    } catch (err) {
      logError(`[itandi] ${customer.name}: ${prop.building_name} GAS送信失敗: ${err.message}`);
    }

    // Discord通知（1物件ずつ）
    try {
      await sendDiscordNotification(customer.name, [prop], customer);
    } catch (err) {
      logError(`[itandi] ${customer.name}: ${prop.building_name} Discord通知失敗: ${err.message}`);
    }

    // seenIdsに追加
    if (!seenIds[customer.name]) seenIds[customer.name] = [];
    seenIds[customer.name].push(prop.room_id);

    // 物件間のランダム遅延
    const delayMs = 2000 + Math.random() * 2000;
    await csleep(delayMs);
  }

  if (submittedCount > 0) {
    await setStorageData({ debugLog: `[itandi] ${customer.name}: ${submittedCount}件送信完了` });
  } else {
    await setStorageData({ debugLog: `[itandi] ${customer.name}: 新着なし` });
  }
}
