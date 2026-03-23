/**
 * content-detail.js
 * REINS物件詳細ページ（GBK003200）からデータを抽出する
 * background.js からのメッセージで起動
 */

(function () {
  'use strict';

  // background.js からのメッセージを受信
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CHECK_LOGIN') {
      sendResponse({ loggedIn: isLoggedIn() });
      return;
    }

    if (msg.type === 'EXTRACT_PROPERTY_DETAIL') {
      extractPropertyDetail()
        .then(data => sendResponse({ success: true, data }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // 非同期応答
    }
  });

  // ページロード時にログイン状態を通知
  chrome.runtime.sendMessage({ type: 'LOGIN_STATUS', loggedIn: isLoggedIn() });

  // --- ログイン検出 ---
  function isLoggedIn() {
    // REINS詳細ページが表示できていればログイン済み
    // ログインページにリダイレクトされた場合は p-label-title が存在しない
    return document.querySelectorAll('.p-label-title').length > 0;
  }

  // --- メインの抽出処理 ---
  async function extractPropertyDetail() {
    const propertyNumber = getValueByLabel('物件番号');
    if (!propertyNumber) {
      throw new Error('物件番号が取得できません（詳細ページではない可能性）');
    }

    // 住所組み立て
    const pref = getValueByLabel('都道府県名');
    const addr1 = getValueByLabel('所在地名１');
    const addr2Raw = getValueByLabel('所在地名２');
    const addr3 = getValueByLabel('所在地名３');
    const building = getValueByLabel('建物名');
    const address = [pref, addr1, addr2Raw, addr3].filter(Boolean).join('');

    // 賃料（万円 → 円に変換）
    const rentRaw = getValueByLabel('賃料');
    const rent = parseRentToYen(rentRaw);

    // 管理費・共益費
    const managementFeeRaw = getValueByLabel('管理費');
    const commonServiceFeeRaw = getValueByLabel('共益費');
    const managementFee = parseFeeToYen(managementFeeRaw) || parseFeeToYen(commonServiceFeeRaw);

    // 面積
    const areaRaw = getValueByLabel('使用部分面積');
    const area = parseFloat(areaRaw.replace(/[^\d.]/g, '')) || 0;

    // 間取り
    const madoriType = normalizeText(getValueByLabel('間取タイプ'));
    const madoriRoomCount = normalizeText(getValueByLabel('間取部屋数'));
    let layout = '';
    if (madoriType === 'ワンルーム') {
      layout = 'ワンルーム';
    } else if (madoriRoomCount && madoriType) {
      const count = madoriRoomCount.replace('室', '');
      layout = `${count}${madoriType}`;
    }

    // 築年月
    const builtDateRaw = getValueByLabel('築年月');
    const buildingAge = normalizeBuildingAge(builtDateRaw);

    // 階数
    const floorLocationRaw = getValueByLabel('所在階');
    const floorAboveRaw = getValueByLabel('地上階層');
    const floorBelowRaw = getValueByLabel('地下階層');
    const floor = parseInt(floorLocationRaw.match(/\d+/)?.[0] || '0', 10);
    const floorText = floorLocationRaw ? `${floorLocationRaw}階` : '';
    let storyText = '';
    if (floorAboveRaw) storyText += `地上${extractNum(floorAboveRaw)}階`;
    if (floorBelowRaw && extractNum(floorBelowRaw) !== '0') storyText += `地下${extractNum(floorBelowRaw)}階`;
    if (storyText) storyText += '建';

    // 構造
    const structure = getValueByLabel('建物構造');

    // 交通情報
    const accessList = getAccessInfo();
    let stationInfo = '';
    const otherStations = [];
    if (accessList.length > 0) {
      const first = accessList[0];
      stationInfo = `${first.line} ${first.station} 徒歩${first.walk}`;
      for (let i = 1; i < accessList.length; i++) {
        const a = accessList[i];
        otherStations.push(`${a.line} ${a.station} 徒歩${a.walk}`);
      }
    }

    // 画像URL取得（base64ではなくURLのみ）
    const imageUrls = await getImageUrls();

    // 各種費用・条件
    const deposit = getValueByLabel('敷金');
    const keyMoney = getValueByLabel('礼金');
    const contractPeriod = getValueByLabel('契約期間');
    const renewalType = getValueByLabel('更新区分');
    const sunlight = getValueByLabel('バルコニー方向');
    const features = getValueByLabel('設備・条件・住宅性能等');
    const moveInDate = getValueByLabel('入居可能年月日') || getValueByLabel('引渡可能年月日');
    const totalUnits = getValueByLabel('総戸数');
    const propertyType = getValueByLabel('物件種目');
    const roomNumber = getValueByLabel('部屋番号');

    // 更新料・その他費用
    const renewalFee = getValueByLabel('更新料');
    const keyExchangeFee = formatFee(getValueByLabel('鍵交換代金'));
    const guaranteeCompany = getValueByLabel('保証会社');

    // その他一時金
    const otherFee1Name = getValueByLabel('その他一時金名称１');
    const otherFee1Amount = getValueByLabel('金額１');
    const otherFee2Name = getValueByLabel('その他一時金名称２');
    const otherFee2Amount = getValueByLabel('金額２');
    const otherMonthlyName = getValueByLabel('その他月額費名称');
    const otherMonthlyAmount = getValueByLabel('その他月額費金額');

    // その他一時金・月額費をまとめる
    const otherOnetimeParts = [];
    if (otherFee1Name && otherFee1Amount) otherOnetimeParts.push(`${otherFee1Name}: ${formatFee(otherFee1Amount)}`);
    if (otherFee2Name && otherFee2Amount) otherOnetimeParts.push(`${otherFee2Name}: ${formatFee(otherFee2Amount)}`);

    const otherMonthlyParts = [];
    if (otherMonthlyName && otherMonthlyAmount) otherMonthlyParts.push(`${otherMonthlyName}: ${formatFee(otherMonthlyAmount)}`);

    // 定期借家判定
    const leaseType = renewalType || '';

    // Property スキーマに合わせた返却データ
    return {
      building_id: `reins_${propertyNumber}`,
      room_id: `reins_${propertyNumber}_${roomNumber || 'no_room'}`,
      building_name: building || '',
      address,
      rent,
      source: 'reins',
      management_fee: managementFee,
      deposit: formatFee(deposit),
      key_money: formatFee(keyMoney),
      layout,
      area,
      floor,
      building_age: buildingAge,
      station_info: stationInfo,
      room_number: roomNumber,
      url: '',  // REINSはセッション依存のためURL保存不可
      image_url: imageUrls[0] || '',
      image_urls: imageUrls,
      story_text: storyText,
      other_stations: otherStations,
      move_in_date: moveInDate,
      floor_text: floorText,
      structure,
      total_units: totalUnits,
      lease_type: leaseType,
      contract_period: contractPeriod,
      cancellation_notice: '',
      renewal_info: renewalType,
      sunlight,
      facilities: features,
      renewal_fee: formatFee(renewalFee),
      key_exchange_fee: keyExchangeFee,
      guarantee_info: guaranteeCompany,
      other_monthly_fee: otherMonthlyParts.join(', '),
      other_onetime_fee: otherOnetimeParts.join(', '),
      // REINS固有の追加情報
      reins_property_number: propertyNumber,
      reins_property_type: propertyType,
      reins_shougo: getValueByLabel('商号'),
      reins_tel: getValueByLabel('代表電話番号'),
    };
  }

  // --- ユーティリティ関数 ---

  function getValueByLabel(labelText) {
    const label = [...document.querySelectorAll('.p-label-title')]
      .find(el => el.textContent.trim() === labelText);
    if (!label) return '';
    const container = label.closest('.p-label')?.parentElement;
    if (!container) return '';

    if (labelText === '商号') {
      const outer = label.closest('.col-sm-6');
      if (!outer) return '';
      const aTag = outer.querySelector('a.d-none.d-sm-inline');
      return aTag ? aTag.textContent.trim() : '';
    }

    if (labelText === '部屋番号') {
      return container.querySelector('.col-sm-4')?.textContent.trim() || '';
    }

    if (labelText === '物件種目') {
      return container.querySelector('.row .col-sm-2.col-5')?.textContent.trim() || '';
    }

    return container.querySelector('.row .col')?.textContent.trim() || '';
  }

  function getAccessInfo() {
    const results = [];
    const fullWidthNums = ['\uff11', '\uff12', '\uff13']; // １２３
    const h3List = [...document.querySelectorAll('h3')];

    fullWidthNums.forEach((num, i) => {
      const h3 = h3List.find(el => el.textContent.trim() === `\u4ea4\u901a${num}`); // 交通N
      if (!h3) return;

      let container = h3.nextElementSibling;
      while (container && !container.classList.contains('container')) {
        container = container.nextElementSibling;
      }
      if (!container) return;

      const rows = [...container.querySelectorAll(':scope > .row')];
      for (let j = 0; j < rows.length; j += 3) {
        const getVal = (row, targetLabel) => {
          const title = row?.querySelector('.p-label-title');
          return (title?.textContent.trim() === targetLabel)
            ? title.closest('.p-label')?.nextElementSibling?.textContent.trim() || '' : '';
        };

        const line = getVal(rows[j], '\u6cbf\u7dda\u540d');     // 沿線名
        const station = getVal(rows[j + 1], '\u99c5\u540d');     // 駅名
        const walkRaw = getVal(rows[j + 2], '\u99c5\u3088\u308a\u5f92\u6b69'); // 駅より徒歩
        const walk = walkRaw.match(/^(\d+\u5206)/)?.[1] || '';   // N分

        if (line || station || walk) {
          results.push({ line, station, walk });
        }
      }
    });

    return results;
  }

  async function getImageUrls() {
    const urls = [];
    const thumbnails = document.querySelectorAll('div.mx-auto');

    for (const thumb of thumbnails) {
      thumb.click();
      await new Promise(r => setTimeout(r, 200));

      const imageView = document.querySelector('.image-view');
      if (imageView) {
        const style = imageView.getAttribute('style');
        const match = style?.match(/url\(["']?(.*?)["']?\)/);
        if (match && match[1]) {
          let imageUrl = match[1];
          if (imageUrl.startsWith('/')) {
            imageUrl = location.origin + imageUrl;
          }
          urls.push(imageUrl);
        }
      }

      const closeBtn = document.querySelector('.modal .btn.btn-outline, .modal .close');
      if (closeBtn) {
        closeBtn.click();
        await new Promise(r => setTimeout(r, 300));
      }
    }

    return urls;
  }

  function normalizeText(str) {
    if (!str) return '';
    return str
      .replace(/\s/g, '')
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, s =>
        String.fromCharCode(s.charCodeAt(0) - 0xFEE0)
      );
  }

  function extractNum(str) {
    return str.match(/\d+/)?.[0] || '0';
  }

  function parseRentToYen(rentStr) {
    if (!rentStr) return 0;
    const normalized = normalizeText(rentStr);
    const num = parseFloat(normalized.match(/[\d.]+/)?.[0] || '0');
    if (normalized.includes('\u4e07')) { // 万
      return Math.round(num * 10000);
    }
    return Math.round(num);
  }

  function parseFeeToYen(feeStr) {
    if (!feeStr) return 0;
    const normalized = normalizeText(feeStr);
    if (normalized === '\u306a\u3057' || normalized === '\u2015' || normalized === '-') return 0; // なし
    const num = parseInt(normalized.replace(/[^\d]/g, ''), 10);
    return isNaN(num) ? 0 : num;
  }

  function formatFee(str) {
    if (!str) return '';
    const normalized = normalizeText(str);
    if (normalized === '\u306a\u3057' || normalized === '\u2015' || normalized === '-') return '';
    return str.trim();
  }

  function normalizeBuildingAge(builtDateStr) {
    if (!builtDateStr) return '';
    const str = builtDateStr.trim();

    // 「築○年」形式ならそのまま
    if (/^\u7bc9\d+\u5e74/.test(str)) return str;
    if (str === '\u65b0\u7bc9') return str; // 新築

    // 年月形式から計算
    const m = str.match(/(\d{4})\u5e74/); // YYYY年
    if (m) {
      const builtYear = parseInt(m[1], 10);
      const monthMatch = str.match(/(\d{1,2})\u6708/); // MM月
      const builtMonth = monthMatch ? parseInt(monthMatch[1], 10) : 1;

      const now = new Date();
      let years = now.getFullYear() - builtYear;
      if (now.getMonth() + 1 < builtMonth) years--;
      if (years < 1) return '\u65b0\u7bc9'; // 新築
      return `\u7bc9${years}\u5e74`; // 築N年
    }

    return str;
  }
})();
