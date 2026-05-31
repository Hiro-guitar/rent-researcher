/**
 * reins-criteria-func.js
 * REINSの検索フォームにVue $dataを注入する関数。
 * chrome.scripting.executeScript({ func: __reinsCriteriaFunc }) として使用。
 * background.js から importScripts で読み込まれる。
 */

// eslint-disable-next-line no-unused-vars
const __reinsCriteriaFunc = (stationStr, customerData, lineNameMap, reinsCodeMap, btMode) => {
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
    vr.snckKbn = false;
    for (let n = 1; n <= 3; n++) {
      vr[`ensnCd${n}`] = ''; vr[`ensnRykshu${n}`] = '';
      vr[`ekCdFrom${n}`] = ''; vr[`ekCdTo${n}`] = '';
      vr[`ekmiFrom${n}`] = ''; vr[`ekmiTo${n}`] = '';
      vr[`thNyurykc${n}`] = ''; vr[`thMHnKbn${n}`] = '';
      // 所在地スロット (都道府県名・市区町村名)
      vr[`tdufknmi${n}`] = '';
      vr[`shzicmi1${n}`] = '';
    }
    vr.kkkuCnryuFrom = ''; vr.kkkuCnryuTo = '';
    vr.bkknShbt1 = ''; vr.bkknShbt2 = '';
    vr.mdrTyp = []; vr.mdrHysuFrom = ''; vr.mdrHysuTo = '';
    vr.snyuMnskFrom = ''; vr.snyuMnskTo = '';
    vr.hnkuNngppFrom = ''; vr.hnkuNngppTo = '';
    // 登録年月日もリセット (turk = touroku)
    vr.turkKkn = '0';
    vr.turkNngppFrom = ''; vr.turkNngppTo = '';
    vr.turkNngppDisabled = true;

    // 物件種別: 賃貸マンション
    vr.bkknShbt1 = '03';

    // 沿線コードセット
    const reinsSearchStations = []; // デバッグ用: セットした駅名を記録
    const reinsUnresolved = []; // 未解決路線を記録
    if (stationStr) {
      const parts = stationStr.split('/').map(s => s.trim());
      let slotNum = 0; // 実際にセットした沿線スロット数
      for (let i = 0; i < parts.length && slotNum < 3; i++) {
        const colonIdx = parts[i].indexOf('\uff1a'); // ：(全角コロン)
        const lineName = colonIdx >= 0 ? parts[i].substring(0, colonIdx).trim() : parts[i].trim();

        // 全角英数→半角変換（ＪＲ→JR等）
        const toHankakuAlpha = (s) => s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

        let reinsLineName = lineNameMap[lineName];
        if (!reinsLineName) {
          // フォールバック: 全角→半角変換+スペース正規化して比較
          const normalized = toHankakuAlpha(lineName).replace(/\s/g, '');
          const fbKey = Object.keys(lineNameMap).find(k => {
            const kNorm = toHankakuAlpha(k).replace(/\s/g, '');
            if (kNorm === normalized) return true;
            if (k.endsWith(' ' + lineName)) return true;
            return false;
          });
          reinsLineName = fbKey ? lineNameMap[fbKey] : lineName;
        }
        if (reinsLineName === '\u691c\u7d22\u4e0d\u80fd') continue; // 検索不能

        // 丸ノ内線方南町支線の分岐対応: 本線駅と支線駅を分離
        if (lineName === '東京メトロ丸ノ内線' && colonIdx >= 0) {
          const honanBranchStations = new Set(['中野新橋', '中野富士見町', '方南町']);
          const stns = parts[i].substring(colonIdx + 1).split(',').map(s => s.trim()).filter(s => s);
          const mainStns = stns.filter(s => !honanBranchStations.has(s));
          const branchStns = stns.filter(s => honanBranchStations.has(s));
          if (branchStns.length > 0 && mainStns.length > 0) {
            // 混在: 現在のパートを本線駅のみに書き換え、支線を新パートとして追加
            parts[i] = lineName + '：' + mainStns.join(',');
            parts.splice(i + 1, 0, lineName + '（方南支線）：' + branchStns.join(','));
            // reinsLineNameは本線のまま（丸ノ内線）
          } else if (branchStns.length > 0 && mainStns.length === 0) {
            // 全駅が支線 → 丸ノ内方南に切り替え
            reinsLineName = '丸ノ内方南';
          }
          // 全駅が本線の場合はそのまま
        }

        // 丸ノ内線方南支線パート（上記spliceで追加されたもの）の処理
        if (lineName === '東京メトロ丸ノ内線（方南支線）') {
          reinsLineName = '丸ノ内方南';
        }

        // 常磐線の分岐対応: 各停駅（綾瀬〜北柏）はREINSでは常磐緩行線
        if (reinsLineName === '常磐線' && colonIdx >= 0) {
          const jobanLocalOnly = new Set(['綾瀬', '亀有', '金町', '北松戸', '馬橋', '新松戸', '北小金', '南柏', '北柏']);
          const stns = parts[i].substring(colonIdx + 1).split(',').map(s => s.trim()).filter(s => s);
          const allLocal = stns.every(s => jobanLocalOnly.has(s));
          const hasLocal = stns.some(s => jobanLocalOnly.has(s));
          if (allLocal) {
            // 全駅が各停のみ → 常磐緩行線
            reinsLineName = '常磐緩行線';
          } else if (hasLocal) {
            // 混在（各停駅 + 快速駅）→ 常磐線のまま、各停のみの駅は最寄りの快速停車駅に置換
            // 常磐緩行線は北千住始点なので、各停のみ駅 → 北千住に置換
            for (let si = 0; si < stns.length; si++) {
              if (jobanLocalOnly.has(stns[si])) stns[si] = '北千住';
            }
            parts[i] = lineName + '：' + stns.join(',');
          }
        }

        // 中央線の分岐対応: 各停区間駅（水道橋〜東中野）はREINSでは総武中央線
        if (reinsLineName === '中央線' && colonIdx >= 0) {
          const chuoLocalOnly = new Set(['水道橋', '飯田橋', '市ケ谷', '信濃町', '千駄ケ谷', '代々木', '大久保', '東中野']);
          const stns = parts[i].substring(colonIdx + 1).split(',').map(s => s.trim()).filter(s => s);
          const allLocal = stns.every(s => chuoLocalOnly.has(s));
          const hasLocal = stns.some(s => chuoLocalOnly.has(s));
          if (allLocal) {
            // 全駅が各停区間 → 総武中央線
            reinsLineName = '総武中央線';
          } else if (hasLocal) {
            // 混在（各停駅 + 快速駅）→ 中央線のまま、各停のみの駅は最寄りの快速停車駅に置換
            // 各停区間は御茶ノ水〜新宿間なので、各停のみ駅 → 御茶ノ水に置換
            for (let si = 0; si < stns.length; si++) {
              if (chuoLocalOnly.has(stns[si])) stns[si] = '御茶ノ水';
            }
            parts[i] = lineName + '：' + stns.join(',');
          }
        }

        // 西武池袋線: 東飯能以降はREINSに存在しないため、飯能をtoに制限
        if (reinsLineName === '西武池袋線' && colonIdx >= 0) {
          const beyondHanno = new Set(['東飯能', '高麗', '武蔵横手', '東吾野', '吾野', '西吾野', '正丸', '芦ヶ久保', '横瀬', '西武秩父']);
          const stns = parts[i].substring(colonIdx + 1).split(',').map(s => s.trim()).filter(s => s);
          // from/toの両方が範囲外の場合は飯能に置き換え
          for (let si = 0; si < stns.length; si++) {
            if (beyondHanno.has(stns[si])) stns[si] = '飯能';
          }
          // 置き換え後の駅リストを再構築（partsを直接書き換え）
          parts[i] = lineName + '：' + stns.join(',');
        }

        const ensnCd = reinsCodeMap[reinsLineName];
        if (!ensnCd) {
          console.warn(`[REINS] 沿線コード未定義: "${reinsLineName}" (元路線名: "${lineName}")`);
          // 駅名も含めて未解決として記録
          if (colonIdx >= 0) {
            const stns = parts[i].substring(colonIdx + 1).split(',').map(s => s.trim()).filter(s => s);
            stns.forEach(s => reinsUnresolved.push(s));
          } else {
            reinsUnresolved.push(`[路線: ${lineName}]`);
          }
          continue;
        }

        slotNum++;
        const num = slotNum;
        vr[`ensnCd${num}`] = ensnCd;
        vr[`ensnRykshu${num}`] = reinsLineName;

        // 駅名セット（駅指定がある場合、最初と最後の駅をFrom/Toにセット）
        if (colonIdx >= 0) {
          // REINS駅名マッピング: StationData.jsの駅名 → REINS表示名
          const reinsStationMap = {
            '羽田空港第３ターミナル': '羽田第３ターミナル',
            '羽田空港第3ターミナル': '羽田第３ターミナル',
            '羽田空港第１・第２ターミナル': '羽田第１・第２タ',
            '羽田空港第1・第2ターミナル': '羽田第１・第２タ',
            '羽田空港第１ターミナル': '羽田第１ターミナル',
            '羽田空港第1ターミナル': '羽田第１ターミナル',
            '羽田空港第２ターミナル': '羽田第２ターミナル',
            '羽田空港第2ターミナル': '羽田第２ターミナル',
            '南町田グランベリーパーク': '南町田グランベリーＰ',
            '東京国際クルーズターミナル': '東京国際クルーズＴ',
            'とうきょうスカイツリー': '東京スカイツリー',
            '新鎌ケ谷': '新鎌ヶ谷',
          };
          // 路線依存の駅名変換（同名駅が他路線にもある場合）
          const reinsLineStationMap = {
            '東京モノレール': { '浜松町': 'モノレール浜松町' },
            '都営新宿線': { '市ケ谷': '市ヶ谷' },
          };
          const toReinsStation = (name) => {
            const lineMap = reinsLineStationMap[lineName];
            if (lineMap && lineMap[name]) return lineMap[name];
            return reinsStationMap[name] || name;
          };

          const stationsInLine = parts[i].substring(colonIdx + 1).split(',').map(s => s.trim()).filter(s => s);
          if (stationsInLine.length > 0) {
            const fromStation = toReinsStation(stationsInLine[0]);
            const toStation = toReinsStation(stationsInLine[stationsInLine.length - 1]);
            vr[`ekmiFrom${num}`] = fromStation;
            vr[`ekmiTo${num}`] = toStation;
            reinsSearchStations.push({ line: reinsLineName, from: fromStation, to: toStation });
            console.log(`[REINS] 沿線${num} "${reinsLineName}" 駅名セット: From="${fromStation}", To="${toStation}"`);
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

    // 所在地（市区町村）セット — 最大3スロット
    // 駅検索とは独立したスロット番号体系 (tdufknmi1〜3 / shzicmi11〜13)
    const reinsCitiesSet = [];
    if (customerData.cities && customerData.cities.length > 0) {
      const prefName = customerData.prefecture || '東京都';
      const citiesList = customerData.cities
        .map(c => (c || '').trim())
        .filter(c => c);
      for (let ci = 0; ci < citiesList.length && ci < 3; ci++) {
        const slot = ci + 1;
        vr[`tdufknmi${slot}`] = prefName;
        vr[`shzicmi1${slot}`] = citiesList[ci];
        reinsCitiesSet.push(`${slot}:${prefName}/${citiesList[ci]}`);
      }
      // 4件以上は呼び出し側で3件ずつバッチ分割される
    }

    // 賃料上限（万円）
    if (customerData.rent_max) {
      vr.kkkuCnryuTo = String(customerData.rent_max);
    }
    // 賃料下限（万円・小数1桁）: 明示指定があれば優先。無ければ rent_max の70%を自動設定。
    // SUUMO巡回(_isSuumoPatrol)は明示指定が無い限り下限を入れない（新着検知が目的のため）。
    if (customerData.rent_min) {
      vr.kkkuCnryuFrom = String(customerData.rent_min);
    } else if (customerData.rent_max && !customerData._isSuumoPatrol) {
      const min70 = Math.floor(parseFloat(customerData.rent_max) * 0.7 * 10) / 10;
      if (min70 > 0) vr.kkkuCnryuFrom = String(min70);
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
        // "4K以上" → rooms=4, type="K", maxRoomsを10に
        const cleaned = layout.replace(/以上/g, '').trim();
        const isAbove = layout.includes('以上');
        const m = cleaned.match(/^(\d+)\s*(.+)$/);
        if (m) {
          const rooms = parseInt(m[1]);
          const typeName = m[2].replace(/\s/g, '').toUpperCase()
            .replace(/Ｋ/g, 'K').replace(/Ｄ/g, 'D').replace(/Ｌ/g, 'L').replace(/Ｓ/g, 'S');
          const code = typeMap[typeName];
          if (code) types.add(code);
          // 「以上」の場合、同系統の上位タイプも追加（K→DK,LDK等）
          if (isAbove) {
            if (typeName === 'K') { types.add('03'); types.add('05'); } // DK, LDK
            if (typeName === 'DK') { types.add('05'); } // LDK
          }
          if (rooms < minRooms) minRooms = rooms;
          if (isAbove) { maxRooms = 10; } else if (rooms > maxRooms) { maxRooms = rooms; }
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
    if (customerData.area_min && String(customerData.area_min).trim() && !String(customerData.area_min).includes('指定しない')) {
      const n = parseFloat(String(customerData.area_min).replace(/[^\d.]/g, ''));
      if (!isNaN(n) && n > 0) vr.snyuMnskFrom = String(n);
    }

    // 築年月（築N年以内 or 新築 → From年をセット）
    // selectのiValueを変更してVueリアクティブに反映
    if (customerData.building_age) {
      const ageStr = String(customerData.building_age);
      const isNewBuild = ageStr.includes('新築');
      // 新築の場合は新築区分チェックをON（築年月の範囲検索は不要）
      if (isNewBuild) {
        vr.snckKbn = true;
      }
      const ageNum = isNewBuild ? 0 : parseInt(ageStr.replace(/[^\d]/g, ''));
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

    // 所在階（equipment条件に基づく）
    // 全角数字→半角数字変換
    const toHankaku = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    const equip = toHankaku(customerData.equipment || '').toLowerCase();
    if (equip.includes('2階以上')) {
      vr.shzikiFrom = '2';
    } else if (equip.includes('1階の物件') || equip.includes('1階')) {
      vr.shzikiFrom = '1';
      vr.shzikiTo = '1';
    }

    // バス・トイレ別スキップモード: 設備・条件・住宅性能等(optKnsk)欄に「バス・トイレ別」を追加してREINS側で絞り込む
    if (btMode === 'skip' && (equip.includes('バストイレ別') || equip.includes('バス・トイレ別') || equip.includes('bt別'))) {
      // REINS「こだわり条件選択」モーダルの「バス・トイレ別」= ID '030'
      // 検索実体は vr.selectedOptIds 配列。表示用 vr.optKnsk も合わせて更新
      const BT_ID = '030';
      if (!Array.isArray(vr.selectedOptIds)) vr.selectedOptIds = [];
      if (!vr.selectedOptIds.includes(BT_ID)) vr.selectedOptIds.push(BT_ID);
      const cur = (vr.optKnsk || '').trim();
      if (!cur.includes('バス・トイレ別') && !cur.includes('バストイレ別')) {
        vr.optKnsk = cur ? (cur + ' バス・トイレ別') : 'バス・トイレ別';
      }
    }

    // SUUMO巡回時の「登録年月日 N日以内」フィルタ。
    // REINS は Vue $data 直書きで動作 (turkKkn='4' = 「日付を指定」)。
    //   turkKkn       : '0'(指定なし) | '1'(3日以内) | '2'(1週間以内) |
    //                   '3'(1ヶ月以内) | '4'(日付を指定) | '5'(前日) | '6'(当日)
    //   turkNngppFrom : 'YYYY-MM-DD' (ISO date)
    //   turkNngppTo   : 'YYYY-MM-DD'
    //   turkNngppDisabled : Boolean (= turkKkn !== '4' 時 true)
    // プリセット (1/2/3) と日付指定で結果同等のはずなので、任意日数対応のため
    // 一律 turkKkn='4' (日付指定) を使用。
    if (customerData && customerData._isSuumoPatrol &&
        typeof customerData.daysWithin === 'number' && customerData.daysWithin >= 0) {
      const __pad = (n) => String(n).padStart(2, '0');
      const __today = new Date();
      __today.setHours(0, 0, 0, 0);
      const __todayStr = __today.getFullYear() + '-' + __pad(__today.getMonth() + 1) + '-' + __pad(__today.getDate());
      const __from = new Date(__today);
      __from.setDate(__from.getDate() - customerData.daysWithin);
      const __fromStr = __from.getFullYear() + '-' + __pad(__from.getMonth() + 1) + '-' + __pad(__from.getDate());
      vr.turkKkn = '4';
      vr.turkNngppFrom = __fromStr;
      vr.turkNngppTo = __todayStr;
      vr.turkNngppDisabled = false;
    }

    // セットした全沿線情報をデバッグ用に収集
    const ensnDebug = [];
    for (let n = 1; n <= 3; n++) {
      if (vr[`ensnCd${n}`]) ensnDebug.push(`${n}:${vr[`ensnCd${n}`]}`);
    }

    return {
      success: true,
      bkknShbt1: vr.bkknShbt1,
      ensnCd1: vr.ensnCd1,
      ensnDebug: ensnDebug.join(' '),
      kkkuCnryuTo: vr.kkkuCnryuTo,
      mdrTyp: vr.mdrTyp,
      mdrHysuFrom: vr.mdrHysuFrom,
      mdrHysuTo: vr.mdrHysuTo,
      snyuMnskFrom: vr.snyuMnskFrom,
      shzikiFrom: vr.shzikiFrom || '',
      shzikiTo: vr.shzikiTo || '',
      buildingAge: customerData.building_age || '',
      debugEquip: customerData.equipment || '(empty)',
      reinsSearchStations: reinsSearchStations,
      reinsUnresolved: reinsUnresolved,
      reinsCitiesSet: reinsCitiesSet,
    };
};
