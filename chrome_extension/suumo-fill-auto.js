/**
 * suumo-fill-auto.js — ForRent自動入稿（content script）
 *
 * ForRent管理画面（www.fn.forrent.jp）のiframe内で動作する。
 * chrome.storage.local の suumoFillQueue から承認済み物件を取得し、
 * フォームに自動入力→保存まで実行する。
 *
 * 既存の suumo-competitor-checker/suumo-fill.js のロジックを移植。
 * 差異: 手動ボタン→キュー駆動、chrome.storage.local→メッセージ経由
 *
 * manifest.json content_scripts:
 *   matches: ["https://www.fn.forrent.jp/fn/*"]
 *   all_frames: true
 */

(function () {
  'use strict';

  // トップフレームでは実行しない（入力フォームはiframe内）
  if (window.top === window) {
    console.log('[SUUMO自動入稿] トップフレーム - 入稿キュー監視を開始');
    initTopFrameMonitor();
    return;
  }

  console.log('[SUUMO自動入稿] iframe内 - フォーム入力スクリプト起動');

  // ── フォーム入力待機 ──
  // background.js からのメッセージでフォーム入力を開始
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SUUMO_FILL_START') {
      console.log('[SUUMO自動入稿] フォーム入力開始:', msg.data?.building);
      fillForrentForm(msg.data, msg.imageGenres)
        .then(() => {
          sendResponse({ success: true });
        })
        .catch(err => {
          console.error('[SUUMO自動入稿] エラー:', err);
          sendResponse({ success: false, error: err.message });
        });
      return true; // 非同期応答
    }
  });

  // ══════════════════════════════════════════════════════════
  //  ForRent フォーム入力ロジック
  //  （suumo-competitor-checker/suumo-fill.js からの移植）
  // ══════════════════════════════════════════════════════════

  async function fillForrentForm(data, imageGenres) {
    if (!data) throw new Error('物件データがありません');

    // ── 建物名 ──
    setInputById('bukkenNm', data.building || '');

    // ── 階数・部屋番号 ──
    const fieldMappings = [
      { id: 'kai', key: 'floorsAbove' },
      { id: 'chikaInput', key: 'floorsBelow' },
      { id: 'kaibubun', key: 'floorLocation' },
      { id: 'heyaNoInput', key: 'room' }
    ];
    fieldMappings.forEach(({ id, key }) => {
      if (data[key]) setInputById(id, data[key]);
    });

    // ── 物件種別 ──
    const buildingTypeMap = {
      'マンション': '01', 'アパート': '02', '一戸建て': '11',
      'テラス・タウンハウス': '16', 'その他': '99'
    };
    setSelectByName('${bukkenInputForm.bukkenShuCd}', buildingTypeMap[data.propertyType] || '');

    // ── 建物構造 ──
    if (data.structure) {
      const structureMap = {
        'RC': '01', '鉄筋コンクリート': '01', 'SRC': '02', '鉄骨鉄筋コンクリート': '02',
        '木造': '05', '鉄骨造': '06', '鉄骨': '06', '軽量鉄骨': '07', '軽量鉄骨造': '07',
        'その他': '99'
      };
      const key = toHalfWidth(data.structure);
      setSelectByName('${bukkenInputForm.kozoShuCd}', structureMap[key] || '');
    }

    // ── 築年月 ──
    if (data.builtYear) {
      setInputByIdWithEvents('Wareki2Seireki1', data.builtYear);
    }
    if (data.builtMonth) {
      const allMonthInputs = document.querySelectorAll('.getsuInput');
      allMonthInputs.forEach(input => {
        if (input.closest('tr')?.id === 'err9') {
          setInputWithEvents(input, String(data.builtMonth).padStart(2, '0'));
        }
      });
    }

    // ── 住所（カスケード） ──
    await fillAddress(data);

    // ── 交通情報 ──
    fillTrafficInfo(data);

    // ── 賃料 ──
    if (data.rent) {
      const rentStr = String(data.rent);
      const [intPart, decPart] = rentStr.split('.');
      setInputByName('${bukkenInputForm.chinryo1}', intPart || '');
      setInputByName('${bukkenInputForm.chinryo2}', decPart || '0');
    }

    // ── 管理費 ──
    fillManagementFee(data);

    // ── 敷金・礼金 ──
    fillDepositAndKey(data);

    // ── 間取り ──
    fillLayout(data);

    // ── 専有面積 ──
    if (data.usageArea) {
      const [intPart, decPart] = data.usageArea.split('.');
      setInputById('mensekiIntegerInput', intPart || '');
      setInputById('mensekiDecimalInput', (decPart || '0').padEnd(2, '0'));
    }

    // ── 画像アップロード ──
    if (data.images && data.images.length > 0 && imageGenres) {
      await uploadImages(data.images, imageGenres);
    }

    // ── 設備チェック ──
    if (data.features) {
      fillFeatures(data.features);
    }

    // ── 会社間流通のチェックを外す ──
    ['bukkenNmDispFlg', 'heyaNoDispFlg', 'heyaNoTokkiFlg', 'shosaiJushoDispFlg1', 'bukkenNmTokkiFlg'].forEach(id => {
      const cb = document.getElementById(id);
      if (cb && cb.checked) {
        cb.checked = false;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    // ── 入居予定: 相談 ──
    const nyukyoSodan = document.getElementById('nyukyoKbnCd2');
    if (nyukyoSodan) nyukyoSodan.checked = true;

    // ── 取引態様: 仲介先物 ──
    const torihikiSelect = document.getElementById('torihikiTaiyoKbnCd');
    if (torihikiSelect) {
      torihikiSelect.value = '4';
      torihikiSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ── 管理会社情報 ──
    if (data.shougo) {
      setInputByName('${bukkenInputForm.mototsukeGyoshaNm}', data.shougo.slice(0, 30));
    }
    setInputByName('${bukkenInputForm.mototsukeTantoNm}', '元付担当者');
    if (data.tel) {
      setInputByName('${bukkenInputForm.mototsukeTelNo}', data.tel);
    }
    const dateInput = document.querySelector('input[name="${bukkenInputForm.mototsukeKakuninDate}"]');
    if (dateInput) {
      const today = new Date();
      dateInput.value = today.getFullYear() + '/' + String(today.getMonth() + 1).padStart(2, '0') + '/' + String(today.getDate()).padStart(2, '0');
    }

    // ── 掲載設定 ──
    const shijiIsizeSelect = document.getElementById('shijiIsize');
    if (shijiIsizeSelect) {
      shijiIsizeSelect.value = '1';
      shijiIsizeSelect.dispatchEvent(new Event('change'));
    }

    // ── キャッチコピー ──
    setInputById('netCatch', '★人気のデザイナーズ物件に空きが出ました★');
    setInputById('netFreeMemo', '★現地集合での内見可能★類似物件も一緒に内見可能★オンライン内見・オンライン契約可能★一人暮らしのお部屋探しなら当社にお任せください★まずはお気軽にお問い合わせください★');

    // ── フリーコメント ──
    const freeMemo = document.getElementById('freeMemo');
    if (freeMemo) {
      if (data.sourceType === 'reins') {
        freeMemo.value = 'REINS 物件番号: ' + (data.propertyNumber || '');
      } else if (data.sourceUrl) {
        freeMemo.value = data.sourceUrl;
      }
    }

    // ── 単身者: 可 ──
    const tanshinRadio = document.getElementById('tanshinKbnCd2');
    if (tanshinRadio) tanshinRadio.checked = true;

    // ── 保証会社 ──
    fillGuaranteeCompany(data);

    // ── 周辺環境ポップアップ→保存 ──
    await waitAndClickShuhenButton();

    console.log('[SUUMO自動入稿] フォーム入力完了');
  }

  // ── 住所カスケード入力 ──
  async function fillAddress(data) {
    const prefSelect = document.getElementById('todofukenList');
    if (!prefSelect) return;

    prefSelect.value = '13'; // 東京都
    prefSelect.dispatchEvent(new Event('change'));

    await waitFor(800);

    const citySelect = document.getElementById('shigunkuList');
    if (citySelect && data.addr1) {
      const cityOpt = findOptionByText(citySelect, data.addr1);
      if (cityOpt) {
        citySelect.value = cityOpt.value;
        citySelect.dispatchEvent(new Event('change'));

        await waitFor(800);

        const townSelect = document.getElementById('chosonList');
        if (townSelect && data.town) {
          const townOpt = findOptionByText(townSelect, data.town);
          if (townOpt) {
            townSelect.value = townOpt.value;
            townSelect.dispatchEvent(new Event('change'));

            await waitFor(800);

            const azaSelect = document.getElementById('azaList');
            if (azaSelect) {
              let azaOpt;
              if (!data.chome || data.chome.trim() === '') {
                azaOpt = Array.from(azaSelect.options).find(opt => opt.value === '000');
              } else {
                azaOpt = findOptionByText(azaSelect, data.chome);
              }
              if (azaOpt) {
                azaSelect.value = azaOpt.value;
                azaSelect.dispatchEvent(new Event('change'));

                await waitFor(1000);
                setInputById('banchiNm', data.addr3 || '');
              }
            }
          }
        }
      }
    }
  }

  // ── 交通情報 ──
  function fillTrafficInfo(data) {
    if (!data.access || data.access.length === 0) return;
    const maxTraffic = 3;
    for (let i = 0; i < Math.min(data.access.length, maxTraffic); i++) {
      const num = i === 0 ? '' : String(i + 1);
      const t = data.access[i];
      if (!t) continue;

      setInputById('pkgEnsenNmDisp' + num, t.line || '');
      setInputById('pkgEnsenNm' + num, t.line || '');
      if (t.lineCode) {
        setInputByIdWithEvents('pkgEnsenCd' + num, t.lineCode);
      }

      setInputById('pkgEkiNmDisp' + num, t.station || '');
      setInputById('pkgEkiNm' + num, t.station || '');
      if (t.stationCode) {
        const stationCode = t.stationCode.slice(-5);
        setInputByIdWithEvents('pkgEkiCd' + num, stationCode);
      }

      const walkValue = (t.walk || '').replace(/[^\d]/g, '');
      setInputById('tohofun' + num, walkValue);

      const tohoRadio = document.getElementById('toho' + num) || document.getElementById('toho');
      if (tohoRadio) {
        tohoRadio.checked = true;
        tohoRadio.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  // ── 管理費 ──
  function fillManagementFee(data) {
    function parseYenToMan(str) {
      if (!str || str === 'なし') return null;
      const num = parseInt(str.replace(/[^\d]/g, ''), 10);
      if (isNaN(num)) return null;
      const man = num / 10000;
      const s = man.toString();
      const [intPart, decPart] = s.split('.');
      return { intPart, decPart: decPart || '0' };
    }

    function isNonZero(s) {
      if (!s) return false;
      const num = parseInt(s.replace(/[^\d]/g, ''), 10);
      return !isNaN(num) && num > 0;
    }

    const feeStr = isNonZero(data.commonServiceFee) ? data.commonServiceFee
                 : isNonZero(data.managementFee) ? data.managementFee : '';
    const parts = parseYenToMan(feeStr);
    const feeCheckbox = document.querySelector('input[name="${bukkenInputForm.kanrihiFlg}"]');

    if (parts) {
      if (feeCheckbox) {
        feeCheckbox.checked = true;
        feeCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      setInputByName('${bukkenInputForm.kanrihi1}', parts.intPart);
      setInputByName('${bukkenInputForm.kanrihi2}', parts.decPart);
    } else {
      if (feeCheckbox) {
        feeCheckbox.checked = false;
        feeCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  // ── 敷金・礼金 ──
  function fillDepositAndKey(data) {
    function parseVal(str) {
      if (!str || str === 'なし') return null;
      const num = parseFloat(str.replace(/[^\d.]/g, ''));
      if (isNaN(num)) return null;
      const unit = str.includes('万円') ? 'man' : str.includes('ヶ月') ? 'month' : null;
      if (!unit) return null;
      const [intPart, dec] = num.toFixed(1).split('.');
      return { intPart, decPart: (dec || '0').padEnd(1, '0'), unit };
    }

    // 礼金
    const reikin = parseVal(data.gratuity);
    const reikinFlg = document.getElementById('reikinFlg');
    const DReikin = document.getElementById('DReikin');
    if (reikin && reikinFlg) {
      reikinFlg.checked = true;
      if (DReikin) DReikin.style.visibility = 'visible';
      setInputByName('${bukkenInputForm.reikin1}', reikin.intPart);
      setInputByName('${bukkenInputForm.reikin2}', reikin.decPart);
      const kbnId = reikin.unit === 'month' ? 'reikinKbnCd1' : 'reikinKbnCd2';
      const radio = document.getElementById(kbnId);
      if (radio) radio.checked = true;
    } else if (reikinFlg) {
      reikinFlg.checked = false;
      if (DReikin) DReikin.style.visibility = 'hidden';
    }

    // 敷金
    const shikikin = parseVal(data.deposit);
    const shikikinFlg = document.getElementById('shikikinFlg');
    const DShikikin = document.getElementById('DShikikin');
    if (shikikin && shikikinFlg) {
      shikikinFlg.checked = true;
      if (DShikikin) DShikikin.style.visibility = 'visible';
      setInputByName('${bukkenInputForm.shikikin1}', shikikin.intPart);
      setInputByName('${bukkenInputForm.shikikin2}', shikikin.decPart);
      const kbnId = shikikin.unit === 'month' ? 'shikikinKbnCd1' : 'shikikinKbnCd2';
      const radio = document.getElementById(kbnId);
      if (radio) radio.checked = true;
    } else if (shikikinFlg) {
      shikikinFlg.checked = false;
      if (DShikikin) DShikikin.style.visibility = 'hidden';
    }
  }

  // ── 間取り ──
  function fillLayout(data) {
    const madoriType = toHalfWidth(data.madoriType || '').toUpperCase();
    const roomCount = (data.madoriRoomCount || '').match(/\d+/);
    const roomCountNum = roomCount ? roomCount[0] : '';

    const madoriSelect = document.querySelector('select[name="${bukkenInputForm.madoriTypeKbnCd}"]');
    const heyaCnt = document.getElementById('heyaCntInput');
    if (!madoriSelect || !heyaCnt) return;

    const typeMap = {
      'K': '02', 'DK': '03', 'SDK': '04', 'LDK': '05',
      'SLDK': '06', 'LK': '07', 'SK': '08', 'SLK': '09'
    };

    if (madoriType === 'ワンルーム' || madoriType === 'R') {
      heyaCnt.value = '';
      madoriSelect.value = '01';
    } else {
      heyaCnt.value = roomCountNum;
      madoriSelect.value = typeMap[madoriType] || '';
    }
  }

  // ── 画像アップロード ──
  async function uploadImages(images, genres) {
    // genres: { imageIndex: genreName }
    const genreToValue = {
      '外観': 'gaikan', 'リビング': '040101', 'その他部屋': '040102',
      'キッチン': '040103', 'バス': '040104', 'トイレ': '040105',
      '洗面': '040106', '収納': '040107', 'バルコニー': '040108',
      '庭': '040109', '玄関': '040110', 'セキュリティ': '040111',
      '設備': '040199', '眺望': '050101', 'エントランス': '030101',
      'ロビー': '030102', '駐車場': '030103', '共用部': '030199', 'その他': '999999'
    };

    // 間取り画像
    const madoriIdx = Object.keys(genres).find(k => genres[k] === '間取り');
    if (madoriIdx !== undefined && images[madoriIdx]) {
      await uploadToInput(images[madoriIdx], 'file_up_clientMadori');
    }

    // 外観画像
    const gaikanIdx = Object.keys(genres).find(k => genres[k] === '外観');
    if (gaikanIdx !== undefined && images[gaikanIdx]) {
      await uploadToInput(images[gaikanIdx], 'file_up_gaikan');
    }

    // リビング画像
    const livingIdx = Object.keys(genres).find(k => genres[k] === 'リビング');
    if (livingIdx !== undefined && images[livingIdx]) {
      await uploadToInputWithCategory(images[livingIdx], 'file_up_shitsunai', 'shitsunaiShashinCategory', '040101');
    }

    // その他の画像
    const otherTargets = [
      { fileId: 'file_up_shashin1', selectId: 'shashin1Category' },
      { fileId: 'file_up_shashin2', selectId: 'shashin2Category' },
      { fileId: 'file_up_shashin3', selectId: 'shashin3Category' },
      { fileId: 'file_up_tsuikaGazo1', selectId: 'tsuikaGazo1Category' },
      { fileId: 'file_up_tsuikaGazo2', selectId: 'tsuikaGazo2Category' },
      { fileId: 'file_up_tsuikaGazo3', selectId: 'tsuikaGazo3Category' },
      { fileId: 'file_up_tsuikaGazo4', selectId: 'tsuikaGazo4Category' },
      { fileId: 'file_up_tsuikaGazo5', selectId: 'tsuikaGazo5Category' },
      { fileId: 'file_up_tsuikaGazo6', selectId: 'tsuikaGazo6Category' },
      { fileId: 'file_up_tsuikaGazo7', selectId: 'tsuikaGazo7Category' },
      { fileId: 'file_up_tsuikaGazo8', selectId: 'tsuikaGazo8Category' },
    ];

    const otherIndexes = Object.keys(genres).filter(k =>
      !['間取り', '外観', 'リビング'].includes(genres[k])
    );

    for (let i = 0; i < otherIndexes.length && i < otherTargets.length; i++) {
      const idx = otherIndexes[i];
      const genre = genres[idx];
      const value = genreToValue[genre] || '999999';
      await uploadToInputWithCategory(images[idx], otherTargets[i].fileId, otherTargets[i].selectId, value);
    }
  }

  async function uploadToInput(imageUrl, inputId) {
    const input = document.getElementById(inputId);
    if (!input || !imageUrl) return;

    const file = await urlToFile(imageUrl, inputId + '.jpg');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function uploadToInputWithCategory(imageUrl, inputId, selectId, categoryValue) {
    await uploadToInput(imageUrl, inputId);
    const select = document.getElementById(selectId);
    if (select && categoryValue) {
      select.value = categoryValue;
      select.dispatchEvent(new Event('change'));
    }
  }

  async function urlToFile(url, filename) {
    if (url.startsWith('data:')) {
      return base64ToFile(url, filename);
    }
    const response = await fetch(url);
    const blob = await response.blob();
    return new File([blob], filename, { type: blob.type });
  }

  function base64ToFile(base64, filename) {
    const arr = base64.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) u8arr[n] = bstr.charCodeAt(n);
    return new File([u8arr], filename, { type: mime });
  }

  // ── 設備チェックボックス ──
  function fillFeatures(featuresStr) {
    const featureList = featuresStr.split(',').map(f => f.trim());
    const featureMap = {
      '分譲タイプ': '0256', '最上階': '0305',
      'エレベータ': '0501', 'エレベーター': '0501',
      '宅配ボックス': '0517', '宅配BOX': '0517',
      '24時間ゴミ出し可': '0527', '常時ゴミ出し可能': '0527', '敷地内ゴミ置き場': '0527',
      '駐輪場': '0816', 'バイク置き場': '0817',
      '角住戸': '1007', '角部屋': '1007',
      'オートロック': '1201', 'モニタ付オートロック': '1201',
      'ロフト': '1326', '都市ガス': '1436',
      'システムキッチン': '1401', 'カウンターキッチン': '1403',
      'IHクッキングヒーター': '1416', 'ガスコンロ': '1412',
      '2口コンロ': '1414', '3口以上コンロ': '1415',
      '追焚機能': '1505', '追い焚き風呂': '1505',
      'バス・トイレ別': '1501', 'バストイレ別': '1501',
      '温水洗浄便座': '1603',
      '洗面台': '1701', '洗面所独立': '1701', '独立洗面台': '1701',
      '室内洗濯機置場': '2129', '室内洗濯機置き場': '2129',
      '浴室乾燥機': '1507',
      'モニター付きインターホン': '2414', 'モニタ付インターホン': '2414',
      '防犯カメラ': '1211', '床暖房': '1806',
      'ウォークインクローゼット': '2204', 'シューズボックス': '2207',
      'フローリング': '2101', 'バルコニー': '2001',
      'インターネット使用料無料': '2406', 'インターネット無料': '2406',
      '事務所使用可': '2710'
    };

    // 必須項目は常にチェック
    ['3001', '0233', '2737', '2801'].forEach(id => {
      const cb = document.getElementById(id);
      if (cb) cb.checked = true;
    });

    featureList.forEach(name => {
      const id = featureMap[name];
      if (id) {
        const cb = document.getElementById(id);
        if (cb) cb.checked = true;
      }
    });
  }

  // ── 保証会社 ──
  function fillGuaranteeCompany(data) {
    const text = data.guaranteeCompany || '指定保証会社加入要　条件により異なるため、お問い合わせください';
    const cb = document.getElementById('hoshoninDaikoFlg');
    if (cb && !cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event('click'));
    }
    const requiredRadio = document.getElementById('hoshoninDaikoKbnCd2');
    if (requiredRadio) requiredRadio.checked = true;
    const select = document.getElementById('hoshoninDaikoKaishaKbnCd');
    if (select) {
      select.value = '2';
      select.dispatchEvent(new Event('change'));
    }
    const textarea = document.getElementById('hoshoninDaikoShosai');
    if (textarea) textarea.value = text;
  }

  // ── 周辺環境ポップアップ → 保存ボタン ──
  async function waitAndClickShuhenButton() {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const btn = document.querySelector('#rakurakuShuhenKankyo');
        if (btn && !btn.disabled) {
          clearInterval(checkInterval);
          btn.click();
          // ポップアップ処理後、保存を試みる
          setTimeout(() => {
            clickSaveButton();
            resolve();
          }, 3000);
        }
      }, 500);

      // 30秒タイムアウト
      setTimeout(() => {
        clearInterval(checkInterval);
        clickSaveButton();
        resolve();
      }, 30000);
    });
  }

  function clickSaveButton() {
    // ForRentの保存ボタンを検索してクリック
    const saveBtn = document.querySelector('input[type="submit"][value*="保存"]') ||
                    document.querySelector('button[type="submit"]') ||
                    document.querySelector('#submitBtn');
    if (saveBtn) {
      console.log('[SUUMO自動入稿] 保存ボタンをクリック');
      saveBtn.click();
    } else {
      console.warn('[SUUMO自動入稿] 保存ボタンが見つかりません');
    }
  }

  // ══════════════════════════════════════════════════════════
  //  ユーティリティ
  // ══════════════════════════════════════════════════════════

  function setInputById(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value || '';
  }

  function setInputByIdWithEvents(id, value) {
    const el = document.getElementById(id);
    if (el) {
      el.focus();
      el.value = value || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    }
  }

  function setInputByName(name, value) {
    const el = document.querySelector('input[name="' + name + '"]');
    if (el) {
      el.value = value || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function setSelectByName(name, value) {
    const el = document.querySelector('select[name="' + name + '"]');
    if (el && value) {
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function setInputWithEvents(el, value) {
    el.focus();
    el.value = value || '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  function findOptionByText(select, text) {
    return Array.from(select.options).find(opt => opt.text.trim() === text);
  }

  function toHalfWidth(str) {
    return (str || '').replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/　/g, ' ');
  }

  function waitFor(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

})();

// ══════════════════════════════════════════════════════════
//  トップフレーム: 入稿キュー監視
// ══════════════════════════════════════════════════════════
function initTopFrameMonitor() {
  // 5秒ごとにキューをチェック
  setInterval(checkFillQueue, 5000);
}

async function checkFillQueue() {
  return new Promise(resolve => {
    chrome.storage.local.get(['suumoFillQueue'], (data) => {
      const queue = data.suumoFillQueue || [];
      if (queue.length === 0) { resolve(); return; }

      const item = queue[0]; // 先頭の1件を処理
      console.log('[SUUMO自動入稿] キューに物件あり:', item.building);

      // TODO: ForRentの新規登録ページに遷移し、iframe内のフォーム入力をトリガーする
      // 現段階ではログのみ
      resolve();
    });
  });
}
