/**
 * essquare-fiber-reader.js  （MAINワールドで実行）
 *
 * いい生活(ES-Square)の検索結果一覧は、各物件の情報を React Fiber の
 * `specBukkenView` props に持っている（DOM文字列やクラス名は不安定/難読）。
 * Fiber は「ページのMAINワールド」からしか読めないため、この content script を
 * world:"MAIN" で注入し、各行 [data-testclass="bukkenListItem"] の物件情報を
 * JSON化して row.dataset.essqManualProp に書き込む（data属性は分離ワールドの
 * essquare-content-search.js からも読める）。
 *
 * 抽出項目は essquare-background.js の _parseEssquareSearchResults と同等
 * （画像・設備は一覧に無いため送信時に詳細取得で補う）。ホバー/ツールチップ判定は
 * 手動送信では不要なので省略。
 */
(() => {
  'use strict';
  if (window.__essqFiberReaderLoaded) return;
  window.__essqFiberReaderLoaded = true;

  function extractRow(row) {
    try {
      const fiberKey = Object.keys(row).find((k) => k.startsWith('__reactFiber'));
      if (!fiberKey) return null;
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
      if (!specView) return null;

      const bv = specView.chinshaku_bukken_view || {};
      const jv = specView.chinshaku_boshu_joken_view || {};
      const uuid = bv.chinshaku_bukken_guid;
      if (!uuid) return null;

      // 築年数 (shunko_datejun: 202303103 → 2023年3月)
      let buildingAge = '';
      const shunko = specView.shunko_datejun;
      if (shunko) {
        const shunkoYear = Math.floor(shunko / 100000);
        const shunkoMonth = Math.floor((shunko % 100000) / 1000);
        if (shunkoYear > 0) {
          const age = new Date().getFullYear() - shunkoYear;
          const ageStr = age <= 0 ? '新築' : `築${age}年`;
          buildingAge = shunkoMonth > 0 ? `${shunkoYear}年${shunkoMonth}月(${ageStr})` : `${shunkoYear}年(${ageStr})`;
        }
      }

      // 入居可能日
      let moveInDate = '';
      const nyukyo = jv.nyukyo_kano_datejun;
      if (nyukyo) {
        const y = Math.floor(nyukyo / 100000);
        const md = nyukyo % 100000;
        const m = Math.floor(md / 1000);
        const d = Math.floor((md % 1000) / 10);
        if (y && m) moveInDate = d ? `${y}/${m}/${d}` : `${y}/${m}`;
      }

      let leaseType = '';
      if (jv.chintai_keiyaku_code === 2) leaseType = '定期借家';

      let renewalFee = '';
      if (jv.koshinryo_kagetsu) renewalFee = `${jv.koshinryo_kagetsu}ヶ月`;
      else if (jv.koshinryo_en) renewalFee = `${jv.koshinryo_en}円`;

      let deposit = '';
      if (jv.shikikin_kagetsu) deposit = `${jv.shikikin_kagetsu}ヶ月`;
      else if (jv.shikikin_en) deposit = `${jv.shikikin_en}円`;

      let keyMoney = '';
      if (jv.reikin_kagetsu) keyMoney = `${jv.reikin_kagetsu}ヶ月`;
      else if (jv.reikin_en) keyMoney = `${jv.reikin_en}円`;

      const mgmtFee = (jv.kanrihi || 0) + (jv.kyoekihi || 0) + (jv.zatsuyaku || 0);

      // 募集状況（申込あり）
      let listingStatus = '';
      const tagLabels = row.querySelectorAll('.eds-tag__label, .MuiChip-label');
      for (const tag of tagLabels) {
        if (tag.textContent.trim() === '申込あり') { listingStatus = '申込あり'; break; }
      }

      return {
        uuid,
        building_name: specView.tatemono_name || '',
        room_number: (specView.heya_kukaku_number || '').replace(/^0+(?=\d)/, ''),
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
        listing_status: listingStatus,
      };
    } catch (e) {
      return null;
    }
  }

  function writeAll() {
    const rows = document.querySelectorAll('[data-testclass="bukkenListItem"]');
    let ok = 0;
    rows.forEach((row) => {
      // 既に書いてあり、内容が変わらないなら再計算不要（軽量化）
      const prop = extractRow(row);
      if (prop) {
        try { row.dataset.essqManualProp = JSON.stringify(prop); ok++; } catch (e) {}
      }
    });
    return ok;
  }

  // 初回 + SPA再描画に追従（ページ送り/絞り込みで行が入れ替わる）
  let timer = null;
  function scheduleWrite() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; writeAll(); }, 300);
  }

  writeAll();
  scheduleWrite();
  try {
    const mo = new MutationObserver(() => scheduleWrite());
    mo.observe(document.body, { childList: true, subtree: true });
  } catch (e) {}
})();
