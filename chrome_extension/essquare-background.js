/**
 * essquare-background.js
 * いい生活Square 検索オーケストレーション（Service Worker用）
 * importScripts() で background.js から読み込まれる
 *
 * 依存: essquare-config.js（先にimportScripts）、background.jsの共通関数
 *  - sleep(), getStorageData(), setStorageData(), gasPost(), submitProperties()
 *  - sendDiscordNotification(), getFilterRejectReason(), waitForTabLoad()
 *  - isSearchCancelled(), logError()
 *
 * Python essquare_search/ からの移植:
 *  - 検索: URLクエリパラメータで検索URL構築 → タブで遷移 → DOMパース
 *  - 詳細: 専用タブで詳細ページに遷移 → content script でスクレイピング
 *  - フィルタ: 共通フィルタ + ES-Square固有フィルタ
 */

// ES-Square専用ウィンドウ管理
let dedicatedEssquareTabId = null;
let dedicatedEssquareWindowId = null;

// === 価格テキストパーサー ===

function _parseEssquarePriceText(text) {
  if (!text || text === '-' || text === 'なし' || text === 'ー' || text === '—') return 0;
  text = text.replace(/,/g, '').replace(/円/g, '').trim();
  const m = text.match(/([\d.]+)\s*万/);
  if (m) return Math.floor(parseFloat(m[1]) * 10000);
  const m2 = text.match(/[\d.]+/);
  if (m2) return Math.floor(parseFloat(m2[0]));
  return 0;
}

function _parseEssquareAreaText(text) {
  if (!text) return 0;
  const m = text.match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

// === 検索URL構築 ===

function buildEssquareSearchUrl(customer, page) {
  const params = new URLSearchParams();

  // 駅コード
  const stationCodes = _resolveEssquareStationCodes(customer);
  if (stationCodes.length > 0) {
    for (const code of stationCodes) {
      params.append('station', code);
    }
  }

  // 市区町村（駅コードがない場合のフォールバック）
  const cities = customer.cities || [];
  if (stationCodes.length === 0 || stationCodes.length < (customer.stations || []).length) {
    for (const city of cities) {
      const cityTrimmed = city.trim();
      if (ESSQUARE_CITY_CODES[cityTrimmed]) {
        params.append('jusho', ESSQUARE_CITY_CODES[cityTrimmed]);
      }
    }
  }

  // 賃料（管理費込み・万円→円）
  if (customer.rent_max) {
    params.append('komi_chinryo.to', String(parseFloat(customer.rent_max) * 10000));
  }
  if (customer.rent_min) {
    params.append('komi_chinryo.from', String(parseFloat(customer.rent_min) * 10000));
  }

  // 間取り
  const layouts = customer.layouts || [];
  for (const layout of layouts) {
    const trimmed = layout.trim();
    if (trimmed === '4K以上') {
      // 4K以上 = 4K, 4DK, 4LDK, 5K以上 すべて含める
      for (const code of ['11', '12', '13', '14']) {
        params.append('search_madori_code2', code);
      }
    } else if (ESSQUARE_LAYOUT_MAP[trimmed]) {
      params.append('search_madori_code2', ESSQUARE_LAYOUT_MAP[trimmed]);
    }
  }

  // 専有面積
  if (customer.area_min) {
    params.append('search_menseki.from', String(parseInt(customer.area_min)));
  }

  // 築年数
  if (customer.building_age) {
    const ageStr = String(customer.building_age).replace(/[^\d]/g, '');
    if (ageStr) params.append('chiku_nensu', ageStr);
  }

  // 駅徒歩
  const walkMin = customer.walk ? parseInt(String(customer.walk).replace(/[^\d]/g, '')) : 0;
  if (walkMin > 0) {
    params.append('kotsu_ekitoho', String(walkMin));
  }

  // 構造
  if (customer.structures && customer.structures.length > 0) {
    const addedKozo = new Set();
    for (const s of customer.structures) {
      const kozo = ESSQUARE_STRUCTURE_MAP[s];
      if (kozo && !addedKozo.has(kozo)) {
        params.append('kozo', kozo);
        addedKozo.add(kozo);
      }
    }
  }

  // 建物種別
  if (customer.building_types && customer.building_types.length > 0) {
    for (const bt of customer.building_types) {
      const code = ESSQUARE_BUILDING_TYPE_MAP[bt];
      if (code) params.append('search_boshu_shubetsu_code', code);
    }
  }

  // 設備（ハード設備のみURLパラメータで指定）
  const toHankaku = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const equip = toHankaku(customer.equipment || '');
  const equipItems = equip.split(/[,、，\/／]/).map(s => s.trim()).filter(Boolean);
  for (const item of equipItems) {
    if (ESSQUARE_HARD_KODAWARI_NAMES.has(item) && ESSQUARE_KODAWARI_MAP[item]) {
      params.append('kodawari', ESSQUARE_KODAWARI_MAP[item]);
      // 家具家電付き → 家具付き(kagu_flag) + 家電付き(kaden_flag) の両方を送る
      if (item === '家具家電付き') {
        params.append('kodawari', 'kaden_flag');
      }
    }
  }

  // 敷金なし
  if (equip.includes('敷金なし')) {
    params.append('shikikin_nashi_flag', 'true');
  }
  // 礼金なし
  if (equip.includes('礼金なし')) {
    params.append('reikin_nashi_flag', 'true');
  }

  // テスト顧客でなければ申込あり除外
  const isTestUser = customer.name?.includes('テスト');
  if (!isTestUser) {
    params.append('is_exclude_moshikomi_exist', 'true');
  }

  // ソート: 最終更新日順
  params.append('order', 'saishu_koshin_time.desc');
  params.append('items_per_page', '30');
  params.append('p', String(page));

  return `${ESSQUARE_SEARCH_URL}?${params.toString()}`;
}

// === 駅名→駅コード解決 ===

function _resolveEssquareStationCodes(customer) {
  const rws = customer.routes_with_stations || [];
  let stationNames = rws.length > 0
    ? rws.flatMap(r => r.stations || [])
    : (customer.stations || []);

  if (stationNames.length === 0) return [];

  const codes = [];
  const unmapped = [];
  for (const name of stationNames) {
    const clean = name.replace(/駅$/, '').trim();
    // ケ/ヶ、ツ/ッ の表記揺れを吸収
    const variants = [
      clean,
      clean.replace(/ケ/g, 'ヶ'),
      clean.replace(/ヶ/g, 'ケ'),
      clean.replace(/ツ/g, 'ッ'),
      clean.replace(/ッ/g, 'ツ'),
    ];
    const code = variants.reduce((found, v) => found || ESSQUARE_STATION_CODES[v], null);
    if (code) {
      codes.push(code);
    } else {
      unmapped.push(clean);
    }
  }

  if (unmapped.length > 0) {
    console.warn(`[ES-Square] 駅コード未定義: ${unmapped.join(', ')}`);
    if (typeof addUnresolvedStation === 'function') {
      for (const name of unmapped) {
        addUnresolvedStation(customer.name || '不明', 'ES-Square', name);
      }
    }
  }

  return codes;
}

// === SPAレンダリング待ち ===

async function _waitForEssquareRender(tabId, timeoutMs) {
  const startTime = Date.now();
  let lastLen = 0;
  let staleStart = null;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const body = document.body;
          if (!body) return { len: 0, yen: false, sqm: false, zero: false, search: false };
          const t = body.innerText;
          return {
            len: t.length,
            yen: t.includes('円'),
            sqm: t.includes('㎡') || t.includes('m²'),
            zero: /0\s*件/.test(t),
            search: t.includes('検索'),
          };
        },
      });

      const ind = results?.[0]?.result;
      if (!ind) { await sleep(1000); continue; }

      // 検索結果が表示された
      if (ind.len > 1000 && ind.yen && ind.sqm) return 'rendered';
      if (ind.len > 2000 && ind.yen) return 'rendered';

      // 0件
      if (ind.len > 800 && ind.search && ind.zero && !ind.yen) return 'empty';

      // テキスト長変化の追跡
      if (ind.len !== lastLen) {
        lastLen = ind.len;
        staleStart = null;
      } else if (!staleStart) {
        staleStart = Date.now();
      } else if (Date.now() - staleStart > 8000) {
        console.warn(`[ES-Square] ページが${ind.len}charsで停止`);
        break;
      }
    } catch (e) {
      // タブが閉じられた等
    }
    await sleep(1000);
  }

  return 'timeout';
}

// === 検索結果パース（React Fiber経由） ===

async function _parseEssquareSearchResults(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',  // React Fiber にアクセスするためメインワールドで実行
    func: () => {
      const properties = [];

      // data-testclass="bukkenListItem" で物件行を特定
      const rows = document.querySelectorAll('[data-testclass="bukkenListItem"]');

      for (const row of rows) {
        try {
          // React Fiber から specBukkenView props を取得
          const fiberKey = Object.keys(row).find(k => k.startsWith('__reactFiber'));
          if (!fiberKey) continue;

          let fiber = row[fiberKey];
          let specView = null;
          for (let i = 0; i < 30; i++) {
            if (!fiber) break;
            if (fiber.memoizedProps && fiber.memoizedProps.specBukkenView) {
              specView = fiber.memoizedProps.specBukkenView;
              break;
            }
            fiber = fiber.return;
          }
          if (!specView) continue;

          const bv = specView.chinshaku_bukken_view || {};
          const jv = specView.chinshaku_boshu_joken_view || {};
          const uuid = bv.chinshaku_bukken_guid;
          if (!uuid) continue;

          // 築年数を計算 (shunko_datejun: 202303103 → 2023年)
          let buildingAge = '';
          const shunko = specView.shunko_datejun;
          if (shunko) {
            const shunkoYear = Math.floor(shunko / 100000);
            if (shunkoYear > 0) {
              const age = new Date().getFullYear() - shunkoYear;
              buildingAge = age <= 0 ? '新築' : `築${age}年`;
            }
          }

          // 入居可能日（datejun形式: YYYY*100000 + MM*1000 + DD*10 + precision）
          let moveInDate = '';
          const nyukyo = jv.nyukyo_kano_datejun;
          if (nyukyo) {
            const y = Math.floor(nyukyo / 100000);
            const md = nyukyo % 100000;
            const m = Math.floor(md / 1000);
            const d = Math.floor((md % 1000) / 10);
            if (y && m) moveInDate = d ? `${y}/${m}/${d}` : `${y}/${m}`;
          }

          // 契約種別
          let leaseType = '';
          if (jv.chintai_keiyaku_code === 2) leaseType = '定期借家';

          // 更新料（月数を優先）
          let renewalFee = '';
          if (jv.koshinryo_kagetsu) {
            renewalFee = `${jv.koshinryo_kagetsu}ヶ月`;
          } else if (jv.koshinryo_en) {
            renewalFee = `${jv.koshinryo_en}円`;
          }

          // 敷金（月数を優先）
          let deposit = '';
          if (jv.shikikin_kagetsu) {
            deposit = `${jv.shikikin_kagetsu}ヶ月`;
          } else if (jv.shikikin_en) {
            deposit = `${jv.shikikin_en}円`;
          }

          // 礼金（月数を優先）
          let keyMoney = '';
          if (jv.reikin_kagetsu) {
            keyMoney = `${jv.reikin_kagetsu}ヶ月`;
          } else if (jv.reikin_en) {
            keyMoney = `${jv.reikin_en}円`;
          }

          // 管理費（kanrihi + kyoekihi + zatsuyaku）
          const mgmtFee = (jv.kanrihi || 0) + (jv.kyoekihi || 0) + (jv.zatsuyaku || 0);

          properties.push({
            uuid,
            building_name: specView.tatemono_name || '',
            room_number: specView.heya_kukaku_number || '',
            address: specView.jusho_full_text || '',
            rent: jv.chinryo || 0,
            management_fee: mgmtFee,
            deposit,
            key_money: keyMoney,
            layout: specView.madori_name || '',
            area: specView.senyu_menseki || 0,
            building_age: buildingAge,
            station_info: specView.kotsu_text_1 || '',
            other_stations: [specView.kotsu_text_2, specView.kotsu_text_3].filter(Boolean),
            structure: specView.kozo || '',
            floor_text: specView.shozaikai ? (String(specView.shozaikai).includes('階') ? String(specView.shozaikai) : `${specView.shozaikai}階`) : '',
            floor: parseInt(specView.shozaikai) || 0,
            total_floors: specView.chijo_kaisu || 0,
            move_in_date: moveInDate,
            lease_type: leaseType,
            renewal_fee: renewalFee,
            komi_chinryo: jv.komi_chinryo || 0,
            contract_period: jv.keiyaku_kikan ? `${jv.keiyaku_kikan}年` : '',
            motozuke: jv.motozuke_gyosha_name || '',
            sales_point: bv.sales_point || '',
          });
        } catch (e) {
          // パースエラーは個別にスキップ
        }
      }

      return properties;
    },
  });

  return results?.[0]?.result || [];
}

// === 専用ウィンドウ管理 ===

async function findOrCreateDedicatedEssquareTab() {
  if (dedicatedEssquareTabId) {
    try {
      const tab = await chrome.tabs.get(dedicatedEssquareTabId);
      if (tab && tab.url?.includes('es-square.net')) {
        return tab;
      }
    } catch (e) {
      // タブが閉じられている
    }
    dedicatedEssquareTabId = null;
    dedicatedEssquareWindowId = null;
  }

  await setStorageData({ debugLog: '[ES-Square] 専用ウィンドウを作成中...' });
  const newWindow = await chrome.windows.create({
    url: `${ESSQUARE_BASE_URL}/bukken/chintai/search`,
    focused: false,
    width: 1200,
    height: 800,
    left: 0,
    top: 0,
    type: 'normal'
  });
  dedicatedEssquareWindowId = newWindow.id;
  dedicatedEssquareTabId = newWindow.tabs[0].id;

  await waitForTabLoad(dedicatedEssquareTabId);
  await sleep(3000); // React SPA 考慮

  // ログイン状態を確認
  const tab = await chrome.tabs.get(dedicatedEssquareTabId);
  if (tab.url?.includes('/login')) {
    await setStorageData({ debugLog: '[ES-Square] ログインが必要です。rent.es-square.netでログイン後に再実行してください。' });
    await closeDedicatedEssquareWindow();
    return null;
  }

  await setStorageData({ debugLog: `[ES-Square] 専用タブ作成: tabId=${dedicatedEssquareTabId}` });
  return tab;
}

async function closeDedicatedEssquareWindow() {
  if (dedicatedEssquareWindowId) {
    try {
      await chrome.windows.remove(dedicatedEssquareWindowId);
    } catch (e) {
      // 既に閉じられている
    }
    dedicatedEssquareWindowId = null;
    dedicatedEssquareTabId = null;
  }
}

// === ES-Square固有フィルタ ===

function getEssquareFilterRejectReason(prop, customer) {
  // 賃料フィルタ（rent + management_fee vs rent_max万円）
  if (customer.rent_max) {
    const totalRent = (prop.rent || 0) + (prop.management_fee || 0);
    const rentMaxYen = parseFloat(customer.rent_max) * 10000;
    if (totalRent > rentMaxYen) {
      return `賃料超過: ${totalRent}円 > ${rentMaxYen}円`;
    }
  }

  // ステータスフィルタ（テストユーザーはスキップ）
  const isTestUser = customer.name?.includes('テスト');
  if (!isTestUser) {
    if (prop.listing_status === '申込あり') {
      return '申込あり';
    }
  }

  const toHankaku = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const equip = toHankaku(customer.equipment || '').toLowerCase();

  const isNoneValue = (s) => !s || s === '-' || s === 'なし' || s === '0' || s === '0円' || s === '無' || s.trim() === '';

  // 敷金なし
  if (equip.includes('敷金なし') && !isNoneValue(prop.deposit)) {
    return `敷金あり: ${prop.deposit}`;
  }

  // 礼金なし
  if (equip.includes('礼金なし') && !isNoneValue(prop.key_money)) {
    return `礼金あり: ${prop.key_money}`;
  }

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
    // ガス種別
    if (equip.includes('都市ガス') && !fac.includes('都市ガス') && (fac.includes('プロパン') || fac.includes('LPガス'))) return 'プロパンガス物件（都市ガス希望）';
    if ((equip.includes('プロパン') || equip.includes('lpガス')) && !fac.includes('プロパン') && !fac.includes('LPガス') && fac.includes('都市ガス')) return '都市ガス物件（プロパンガス希望）';
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

function sendEssquareContentMessage(tabId, message, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('ES-Square content script応答タイムアウト'));
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

function buildEssquarePropertyDataJson(prop) {
  // sanitization_feeをother_onetime_feeに統合
  if (prop.sanitization_fee && !prop.other_onetime_fee) {
    prop.other_onetime_fee = `室内抗菌: ${prop.sanitization_fee}`;
  } else if (prop.sanitization_fee && prop.other_onetime_fee) {
    prop.other_onetime_fee += ` / 室内抗菌: ${prop.sanitization_fee}`;
  }

  return {
    source: 'essquare',
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
    other_stations: prop.other_stations || [],
    floor_text: prop.floor_text || '',
    structure: prop.structure || '',
    facilities: prop.facilities || '',
    move_in_date: prop.move_in_date || '',
    lease_type: prop.lease_type || '',
    listing_status: prop.listing_status || '',
    url: prop.url || '',
    image_url: prop.image_url || '',
    image_urls: prop.image_urls || [],
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
    story_text: prop.story_text || (prop.total_floors ? `${prop.total_floors}階建` : ''),
    guarantee_deposit: prop.guarantee_deposit || '',
    bicycle_parking_fee: prop.bicycle_parking_fee || '',
    motorcycle_parking_fee: prop.motorcycle_parking_fee || '',
    move_in_conditions: prop.move_in_conditions || '',
    pet_deposit: prop.pet_deposit || '',
    renewal_admin_fee: prop.renewal_admin_fee || '',
    renewal_info: prop.renewal_info || '',
    support_fee_24h: prop.support_fee_24h || '',
    additional_deposit: prop.additional_deposit || '',
    water_billing: prop.water_billing || '',
    cleaning_fee: prop.cleaning_fee || '',
    // sanitization_feeはother_onetime_feeに統合（GAS側未対応のため）
    rights_fee: prop.rights_fee || '',
    free_rent_detail: prop.free_rent_detail || '',
    cancellation_notice: prop.cancellation_notice || '',
  };
}

// === メイン検索関数 ===

/**
 * ES-Square 全顧客検索を実行する。
 * background.js の runSearchCycle() から呼ばれる。
 */
async function runEssquareSearch(criteria, seenIds, searchId) {
  await setStorageData({ debugLog: '[ES-Square] 検索開始...' });

  const essquareTab = await findOrCreateDedicatedEssquareTab();
  if (!essquareTab) return;

  try {
    for (let ci = 0; ci < criteria.length; ci++) {
      if (isSearchCancelled(searchId)) return;

      const customer = criteria[ci];
      await setStorageData({ debugLog: `[ES-Square] 顧客 ${ci+1}/${criteria.length}: ${customer.name}` });
      try {
        const cond = formatCustomerCriteria(customer);
        await setStorageData({ debugLog: `[ES-Square] 条件: ${cond}` });
      } catch (e) {
        await setStorageData({ debugLog: `[ES-Square] 条件表示エラー: ${e.message}` });
      }

      try {
        await searchEssquareForCustomer(dedicatedEssquareTabId, customer, seenIds, searchId);
      } catch (err) {
        if (err.message === 'SEARCH_CANCELLED') return;
        if (err.message === 'SLEEP_DETECTED') {
          await setStorageData({ debugLog: '[ES-Square] PCスリープ検知→検索中断' });
          return;
        }
        if (err.message === 'ESSQUARE_LOGIN_REQUIRED') {
          await setStorageData({ debugLog: '[ES-Square] ログインが必要です。rent.es-square.netでログインしてください。' });
          return;
        }
        logError(`[ES-Square] ${customer.name}の検索失敗: ${err.message}`);
      }

      if (ci < criteria.length - 1) await sleep(3000);
    }
  } finally {
    if (!isSearchCancelled(searchId)) {
      await closeDedicatedEssquareWindow();
    }
  }
}

/**
 * 1顧客分のES-Square検索を実行する。
 */
async function searchEssquareForCustomer(tabId, customer, seenIds, searchId) {
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

  // エリア指定チェック
  const stationCodes = _resolveEssquareStationCodes(customer);
  const cities = (customer.cities || []).filter(c => ESSQUARE_CITY_CODES[c.trim()]);
  if (stationCodes.length === 0 && cities.length === 0) {
    await setStorageData({ debugLog: `[ES-Square] ${customer.name}: エリア指定なし → スキップ` });
    return;
  }

  // 検索条件ログ
  const filterParts = [];
  if (customer.rent_max) filterParts.push(`〜${customer.rent_max}万`);
  if (stationCodes.length > 0) filterParts.push(`駅: ${stationCodes.length}件`);
  if (cities.length > 0) filterParts.push(`市区町村: ${cities.join(',')}`);
  if (customer.layouts?.length) filterParts.push(`間取り: ${customer.layouts.join('/')}`);
  if (customer.area_min) filterParts.push(`面積${customer.area_min}㎡〜`);
  if (customer.building_age) filterParts.push(`築${customer.building_age}年`);
  await setStorageData({ debugLog: `[ES-Square] ${customer.name}: 検索条件 → ${filterParts.join(' / ') || '(条件なし)'}` });

  // ページネーション（最大5ページ × 30件 = 150件）
  const maxPages = 5;
  let allProperties = [];

  for (let page = 1; page <= maxPages; page++) {
    if (isSearchCancelled(searchId)) throw new Error('SEARCH_CANCELLED');

    const url = buildEssquareSearchUrl(customer, page);
    if (page === 1) {
      await setStorageData({ debugLog: `[ES-Square] ${customer.name}: 検索URL → ${url}` });
    }

    // ページ遷移
    await chrome.tabs.update(tabId, { url });
    await waitForTabLoad(tabId);

    // SPAレンダリング待ち
    const renderStatus = await _waitForEssquareRender(tabId, 20000);

    if (renderStatus === 'empty') {
      if (page === 1) {
        await setStorageData({ debugLog: `[ES-Square] ${customer.name}: 検索結果0件` });
      }
      break;
    }

    if (renderStatus === 'timeout') {
      if (page === 1) {
        // リトライ
        await setStorageData({ debugLog: `[ES-Square] ${customer.name}: レンダリング待ちタイムアウト、リトライ...` });
        await chrome.tabs.update(tabId, { url });
        await waitForTabLoad(tabId);
        const retryStatus = await _waitForEssquareRender(tabId, 15000);
        if (retryStatus !== 'rendered') {
          await setStorageData({ debugLog: `[ES-Square] ${customer.name}: リトライ後も失敗` });
          break;
        }
      } else {
        await setStorageData({ debugLog: `[ES-Square] ${customer.name}: page=${page} レンダリング失敗、終了` });
        break;
      }
    }

    // ログインチェック
    const currentTab = await chrome.tabs.get(tabId);
    if (currentTab.url?.includes('/login')) {
      throw new Error('ESSQUARE_LOGIN_REQUIRED');
    }

    // DOMから物件リスト抽出
    const pageProps = await _parseEssquareSearchResults(tabId);
    await setStorageData({ debugLog: `[ES-Square] ${customer.name}: page=${page} → ${pageProps.length}件取得` });

    if (pageProps.length === 0) break;

    // 各物件にURL等を付与（React Fiberから取得済みフィールドは保持）
    for (const p of pageProps) {
      p.source = 'essquare';
      p.url = `${ESSQUARE_BASE_URL}/bukken/chintai/search/detail/${p.uuid}`;
      p.room_id = p.uuid;
      p.building_id = p.uuid.split('-')[0] || p.uuid;
      p.image_urls = p.image_urls || [];
      p.facilities = p.facilities || '';
      p.move_in_date = p.move_in_date || '';
      p.lease_type = p.lease_type || '';
      p.listing_status = p.listing_status || '';
      p.floor = p.floor || 0;
      p.floor_text = p.floor_text || '';
      p.sunlight = p.sunlight || '';
      p.total_units = p.total_units || '';
      p.contract_period = p.contract_period || '';
      p.renewal_fee = p.renewal_fee || '';
      p.key_exchange_fee = p.key_exchange_fee || '';
      p.fire_insurance = p.fire_insurance || '';
      p.guarantee_info = p.guarantee_info || '';
      p.parking_fee = p.parking_fee || '';
      p.free_rent = p.free_rent || '';
      p.other_monthly_fee = p.other_monthly_fee || '';
      p.other_onetime_fee = p.other_onetime_fee || '';
      p.shikibiki = p.shikibiki || '';
      p.layout_detail = p.layout_detail || '';
      p.story_text = p.total_floors ? `${p.total_floors}階建` : '';
    }

    allProperties.push(...pageProps);

    // 次ページ判定（30件未満なら最終ページ）
    if (pageProps.length < 30) break;

    await csleep(1500 + Math.random() * 1500);
  }

  if (allProperties.length === 0) return;

  await setStorageData({ debugLog: `[ES-Square] ${customer.name}: ${allProperties.length}件取得、詳細確認中...` });

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
      await csleep(3000); // React SPA 描画待ち

      // ログインチェック
      const detailTab = await chrome.tabs.get(tabId);
      if (detailTab.url?.includes('/login')) {
        throw new Error('ESSQUARE_LOGIN_REQUIRED');
      }

      let detailResult;
      try {
        detailResult = await sendEssquareContentMessage(tabId, { type: 'ESSQUARE_EXTRACT_DETAIL' });
      } catch (err) {
        console.warn(`[ES-Square] 詳細取得失敗 (${prop.building_name}):`, err.message);
      }

      if (detailResult?.ok && detailResult.detail) {
        const d = detailResult.detail;
        if (d.image_urls?.length) {
          prop.image_urls = d.image_urls;
          if (!prop.image_url && d.image_urls[0]) prop.image_url = d.image_urls[0];
        }
        if (d.listing_status) prop.listing_status = d.listing_status;
        if (d.facilities) prop.facilities = d.facilities;

        // 交通機関（詳細ページで複数路線が取得できた場合）
        if (d.other_stations?.length) {
          prop.other_stations = d.other_stations;
        }

        // 管理費: 詳細ページテキストからパース（検索結果が0の場合のフォールバック）
        if (d._mgmt_text && !prop.management_fee) {
          // "15,000円/-/-" → 15000
          const mgmtMatch = d._mgmt_text.match(/([\d,]+)\s*円/);
          if (mgmtMatch) {
            prop.management_fee = parseInt(mgmtMatch[1].replace(/,/g, ''));
          }
        }

        // 詳細ページの値で補完するフィールド（検索結果に無い場合のみ）
        const detailFields = [
          'floor_text', 'story_text', 'structure', 'total_units', 'lease_type', 'contract_period',
          'cancellation_notice', 'renewal_info', 'sunlight', 'free_rent', 'free_rent_detail',
          'fire_insurance', 'key_exchange_fee', 'guarantee_info', 'guarantee_deposit',
          'parking_fee', 'bicycle_parking_fee', 'motorcycle_parking_fee',
          'other_monthly_fee', 'other_onetime_fee', 'move_in_date', 'move_out_date',
          'preview_start_date', 'layout_detail', 'shikibiki', 'floor',
          'move_in_conditions', 'pet_deposit', 'renewal_admin_fee',
          'support_fee_24h', 'additional_deposit', 'water_billing',
          'cleaning_fee', 'sanitization_fee', 'rights_fee',
        ];
        for (const key of detailFields) {
          if (d[key] && !prop[key]) {
            prop[key] = d[key];
          }
        }

        // 詳細ページの値で上書きするフィールド（詳細ページのテキストの方が正確）
        const overrideFields = ['deposit', 'key_money', 'renewal_fee', 'move_in_date'];
        for (const key of overrideFields) {
          if (d[key]) {
            prop[key] = d[key];
          }
        }

        // 構造名を正規化
        if (prop.structure) {
          prop.structure = ESSQUARE_STRUCTURE_NORMALIZE[prop.structure] || prop.structure;
        }

        // 所在階をパース
        if (prop.floor_text && !prop.floor) {
          const floorMatch = prop.floor_text.match(/(\d+)/);
          if (floorMatch) prop.floor = parseInt(floorMatch[1]);
        }
      }
    } catch (err) {
      if (err.message === 'ESSQUARE_LOGIN_REQUIRED' || err.message === 'SEARCH_CANCELLED' || err.message === 'SLEEP_DETECTED') {
        throw err;
      }
      console.warn(`[ES-Square] 詳細処理エラー (${prop.building_name}):`, err.message);
    }

    // フィルタリング
    const rejectReason = getEssquareFilterRejectReason(prop, customer);
    if (rejectReason) {
      await setStorageData({ debugLog: `[ES-Square] ${customer.name}: ✗ スキップ: ${prop.building_name} ${prop.room_number || ''} - ${rejectReason}` });
      continue;
    }

    // property_data_json構築
    prop.property_data_json = JSON.stringify(buildEssquarePropertyDataJson(prop));

    submittedCount++;
    await setStorageData({ debugLog: `[ES-Square] ${customer.name}: ✓ 送信対象（${prop.building_name} ${prop.room_number || ''} ${prop.rent ? (prop.rent/10000)+'万' : ''}）` });

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
      logError(`[ES-Square] ${customer.name}: ${prop.building_name} GAS送信失敗: ${err.message}`);
    }

    // Discord通知（1物件ずつ）
    try {
      await sendDiscordNotification(customer.name, [prop], customer);
    } catch (err) {
      logError(`[ES-Square] ${customer.name}: ${prop.building_name} Discord通知失敗: ${err.message}`);
    }

    // seenIdsに追加
    if (!seenIds[customer.name]) seenIds[customer.name] = [];
    seenIds[customer.name].push(prop.room_id);

    // 物件間のランダム遅延
    const delayMs = 2000 + Math.random() * 2000;
    await csleep(delayMs);
  }

  if (submittedCount > 0) {
    await setStorageData({ debugLog: `[ES-Square] ${customer.name}: ${submittedCount}件送信完了` });
  } else {
    await setStorageData({ debugLog: `[ES-Square] ${customer.name}: 新着なし` });
  }
}
