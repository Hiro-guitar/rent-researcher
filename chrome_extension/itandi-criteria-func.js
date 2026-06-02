/**
 * itandi-criteria-func.js
 * itandi BBの検索フォームにReact互換の方法で条件を注入する関数。
 * chrome.scripting.executeScript({ func: __itandiCriteriaFunc }) として使用。
 * background.js から importScripts で読み込まれる。
 *
 * itandi BB: React 18 + itandi-bb-ui コンポーネント
 * - テキスト入力: native setter + _valueTracker reset + input/change event
 * - チェックボックス: label.click() で React onChange が発火
 * - ラジオ: label.click()
 *
 * 駅選択は3つの別関数で段階的に実行:
 *   __itandiOpenStationModal  — 「路線・駅で絞り込み」ボタンをクリックしてモーダルを開く
 *   __itandiSelectStation     — モーダル内の駅検索ボックスで1駅を検索→チェック
 *   __itandiConfirmStations   — 「確定」ボタンをクリックしてモーダルを閉じる
 *
 * 所在地選択は3つの別関数で段階的に実行:
 *   __itandiOpenAddressModal    — 「所在地で絞り込み」ボタンをクリックしてモーダルを開く
 *   __itandiSelectCityAndTowns  — 都道府県→市区町村→町域・丁目を選択（1区ずつ呼ぶ）
 *   __itandiConfirmAddress      — 「確定」ボタンをクリックしてモーダルを閉じる
 */

// eslint-disable-next-line no-unused-vars
const __itandiCriteriaFunc = (customerData) => {
  'use strict';

  const log = (msg) => console.log('[itandi条件入力] ' + msg);
  const warn = (msg) => console.warn('[itandi条件入力] ' + msg);

  // ── React 互換の value 設定 ──
  function setReactInputValue(input, value) {
    if (!input) return false;
    var nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeSetter.call(input, String(value));
    var tracker = input._valueTracker;
    if (tracker) tracker.setValue('');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // ── name 属性で input を探す ──
  function findInput(name) {
    return document.querySelector('input[name="' + name + '"]');
  }

  // ── チェックボックスを label テキストで探してチェックする ──
  // itandi BB のチェックボックスは <label> 内に <span class="MuiButtonBase-root"> がある
  function clickCheckboxByLabel(labelText) {
    // まず全 label を走査
    var labels = document.querySelectorAll('label');
    for (var i = 0; i < labels.length; i++) {
      var lab = labels[i];
      var txt = (lab.textContent || '').trim();
      if (txt === labelText) {
        // チェック済みかどうかを確認
        var checkbox = lab.querySelector('input[type="checkbox"]');
        if (checkbox && checkbox.checked) {
          log('既にチェック済み: ' + labelText);
          return true;
        }
        // MuiButtonBase-root の span をクリック
        var btn = lab.querySelector('span.MuiButtonBase-root, span.MuiCheckbox-root');
        if (btn) {
          btn.click();
          log('チェック: ' + labelText);
          return true;
        }
        // フォールバック: label 自体をクリック
        lab.click();
        log('チェック(label click): ' + labelText);
        return true;
      }
    }
    return false;
  }

  // ── チェックボックスを input value で探してチェックする ──
  function clickCheckboxByValue(name, value) {
    // name と value で input を検索
    var inputs = document.querySelectorAll('input[type="checkbox"][name="' + name + '"]');
    for (var j = 0; j < inputs.length; j++) {
      if (inputs[j].value === value && !inputs[j].checked) {
        // 親の label または MuiButtonBase を探す
        var parent = inputs[j].closest('label');
        if (parent) {
          var btn = parent.querySelector('span.MuiButtonBase-root, span.MuiCheckbox-root');
          if (btn) { btn.click(); return true; }
          parent.click();
          return true;
        }
        // フォールバック: input 自体
        inputs[j].click();
        return true;
      }
    }
    return false;
  }

  var result = { success: false, filled: [], skipped: [], errors: [] };

  try {
    // ══════════════════════════════════════
    //  1. 賃料（管理費込み）
    // ══════════════════════════════════════
    if (customerData.rent_max) {
      var rentMaxVal = parseFloat(customerData.rent_max);
      if (!isNaN(rentMaxVal) && rentMaxVal > 0) {
        var rentMaxInput = findInput('rent:lteq');
        if (rentMaxInput) {
          // itandi の賃料入力は万円単位（UIで「万円」と表示）
          setReactInputValue(rentMaxInput, rentMaxVal);
          result.filled.push('賃料上限: ' + rentMaxVal + '万円');
        } else {
          result.skipped.push('賃料上限: input[name="rent:lteq"]が見つからない');
        }

        // 下限: 上限の70% を自動設定
        var rentMinInput = findInput('rent:gteq');
        if (rentMinInput) {
          var rentMinVal = Math.floor(rentMaxVal * 0.7 * 10) / 10;
          setReactInputValue(rentMinInput, rentMinVal);
          result.filled.push('賃料下限: ' + rentMinVal + '万円(自動)');
        }
      }
    }

    // 管理費込みチェックボックス
    var totalRentCheck = findInput('totalRentCheck');
    if (totalRentCheck && !totalRentCheck.checked) {
      var totalRentLabel = totalRentCheck.closest('label');
      if (totalRentLabel) {
        var totalRentBtn = totalRentLabel.querySelector('span.MuiButtonBase-root');
        if (totalRentBtn) totalRentBtn.click();
        else totalRentLabel.click();
        result.filled.push('管理費込みチェック');
      }
    }

    // ══════════════════════════════════════
    //  2. 間取り
    // ══════════════════════════════════════
    var layouts = customerData.layouts || [];
    if (layouts.length > 0) {
      // itandi BB の間取りチェックボックス: name="room_layout:in", value="1R" etc
      var LAYOUT_SPECIAL = {
        'ワンルーム': ['1R'],
        '4K以上': ['4K', '4DK', '4LDK', '5K_OVER']
      };
      var layoutsToCheck = [];
      for (var li = 0; li < layouts.length; li++) {
        var l = layouts[li].trim();
        if (LAYOUT_SPECIAL[l]) {
          layoutsToCheck = layoutsToCheck.concat(LAYOUT_SPECIAL[l]);
        } else {
          layoutsToCheck.push(l);
        }
      }
      var layoutChecked = [];
      for (var lj = 0; lj < layoutsToCheck.length; lj++) {
        if (clickCheckboxByValue('room_layout:in', layoutsToCheck[lj])) {
          layoutChecked.push(layoutsToCheck[lj]);
        }
      }
      if (layoutChecked.length > 0) {
        result.filled.push('間取り: ' + layoutChecked.join(', '));
      }
    }

    // ══════════════════════════════════════
    //  3. 駅徒歩
    // ══════════════════════════════════════
    if (customerData.walk) {
      var walkVal = parseInt(String(customerData.walk).replace(/[^\d]/g, ''));
      if (walkVal > 0) {
        var walkInput = findInput('station_walk_minutes:lteq');
        if (walkInput) {
          setReactInputValue(walkInput, walkVal);
          result.filled.push('駅徒歩: ' + walkVal + '分以内');
        } else {
          result.skipped.push('駅徒歩: inputが見つからない');
        }
      }
    }

    // ══════════════════════════════════════
    //  4. 専有面積
    // ══════════════════════════════════════
    if (customerData.area_min && !String(customerData.area_min).includes('指定しない')) {
      var areaVal = parseFloat(String(customerData.area_min).replace(/[^\d.]/g, ''));
      if (!isNaN(areaVal) && areaVal > 0) {
        var areaInput = findInput('floor_area_amount:gteq');
        if (areaInput) {
          setReactInputValue(areaInput, areaVal);
          result.filled.push('面積: ' + areaVal + 'm²以上');
        } else {
          result.skipped.push('面積: inputが見つからない');
        }
      }
    }

    // ══════════════════════════════════════
    //  5. 築年数
    // ══════════════════════════════════════
    if (customerData.building_age) {
      var ageStr = String(customerData.building_age).trim();
      if (!ageStr.includes('新築')) {
        var ageNum = parseInt(ageStr.replace(/[^\d]/g, ''));
        if (ageNum > 0) {
          var ageInput = findInput('building_age:lteq');
          if (ageInput) {
            setReactInputValue(ageInput, ageNum);
            result.filled.push('築年数: ' + ageNum + '年以内');
          } else {
            result.skipped.push('築年数: inputが見つからない');
          }
        }
      }
    }

    // ══════════════════════════════════════
    //  6. 構造
    // ══════════════════════════════════════
    var structures = customerData.structures || [];
    if (structures.length > 0) {
      var STRUCTURE_MAP = {
        '木造': ['wooden'],
        'ブロック': ['block'],
        '鉄骨造': ['steel'],
        '軽量鉄骨造': ['lightweight_steel'],
        'RC': ['rc'],
        'SRC': ['src'],
        'PC': ['pc'],
        'HPC': ['hpc'],
        'ALC': ['alc'],
        'CFT': ['cft'],
        '鉄筋系': ['rc', 'src'],
        '鉄骨系': ['steel', 'lightweight_steel'],
        'ブロック・その他': ['block', 'reinforcing_block', 'alc', 'pc', 'hpc', 'cft'],
      };
      var structuresToCheck = [];
      for (var si = 0; si < structures.length; si++) {
        var mapped = STRUCTURE_MAP[structures[si]];
        if (mapped) {
          structuresToCheck = structuresToCheck.concat(mapped);
        }
      }
      // 重複除去
      structuresToCheck = structuresToCheck.filter(function (v, i, a) { return a.indexOf(v) === i; });
      var structChecked = [];
      for (var sj = 0; sj < structuresToCheck.length; sj++) {
        if (clickCheckboxByValue('structure_type:in', structuresToCheck[sj])) {
          structChecked.push(structuresToCheck[sj]);
        }
      }
      if (structChecked.length > 0) {
        result.filled.push('構造: ' + structChecked.join(', '));
      }
    }

    // ══════════════════════════════════════
    //  7. 設備 (option_id:all_in チェックボックス)
    // ══════════════════════════════════════
    var equipment = customerData.equipment || '';
    if (equipment) {
      var equipList = typeof equipment === 'string' ? equipment.split(',') : equipment;
      var EQUIPMENT_IDS = {
        'バス・トイレ別': 11010, 'バストイレ別': 11010, 'BT別': 11010,
        '温水洗浄便座': 11020,
        '追い焚き機能': 11040, '追い焚き': 11040, '追い焚き風呂': 11040,
        '浴室乾燥機': 11050,
        '独立洗面台': 11060,
        '室内洗濯機置き場': 11080, '室内洗濯機置場': 11080,
        'コンロ2口以上': 12032, '2口以上コンロ': 12032,
        'コンロ3口以上': 12033,
        'エアコン': 13010, 'エアコン付き': 13010,
        'オートロック': 16010,
        'モニター付きインターホン': 16011, 'TVモニタ付きインタホン': 16011,
        '床暖房': 13020,
        'ウォークインクローゼット': 14012,
        'シューズボックス': 14020,
        'インターネット無料': 15021,
        '宅配ボックス': 21020,
        '家具付き': 19010, '家具家電付き': 19010,
        'エレベーター': 19040,
        '駐輪場': 19090, '駐輪場あり': 19090,
        'ガスコンロ対応': 12030, 'ガスコンロ設置可': 12030,
        'IHコンロ': 12020, 'IHクッキングヒーター': 12020,
        'システムキッチン': 12010,
        '都市ガス': 10020,
        'プロパンガス': 10021,
        'バルコニー付': 19070, 'バルコニー': 19070,
        '防犯カメラ': 16030,
        'ペット相談': 22010, 'ペット可': 22010, 'ペット相談可': 22010,
        '事務所可': 22050, '事務所利用可': 22050,
        '楽器相談可': 22020, '楽器相談': 22020,
      };
      var equipChecked = [];
      var toHankaku = function (s) {
        return s.replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
      };

      for (var ei = 0; ei < equipList.length; ei++) {
        var eq = equipList[ei].trim();
        if (!eq) continue;

        var optionId = EQUIPMENT_IDS[eq];
        if (optionId) {
          if (clickCheckboxByValue('option_id:all_in', String(optionId))) {
            equipChecked.push(eq);
          }
        }
      }

      // 2階以上 フィルタ
      var equipNorm = toHankaku(equipment).toLowerCase();
      if (equipNorm.includes('2階以上')) {
        var floorInput = findInput('floor:gteq');
        if (floorInput) {
          setReactInputValue(floorInput, 2);
          result.filled.push('階数: 2階以上');
        } else {
          // チェックボックス形式の場合もある
          clickCheckboxByLabel('2階以上');
        }
      }

      // 敷金なし
      if (equipNorm.includes('敷金なし')) {
        var shikikinInput = findInput('shikikin:eq');
        if (shikikinInput) {
          setReactInputValue(shikikinInput, 0);
          result.filled.push('敷金なし');
        } else {
          clickCheckboxByLabel('敷金なし');
        }
      }

      // 礼金なし
      if (equipNorm.includes('礼金なし')) {
        var reikinInput = findInput('reikin:eq');
        if (reikinInput) {
          setReactInputValue(reikinInput, 0);
          result.filled.push('礼金なし');
        } else {
          clickCheckboxByLabel('礼金なし');
        }
      }

      if (equipChecked.length > 0) {
        result.filled.push('設備: ' + equipChecked.join(', '));
      }
    }

    result.success = true;
    log('完了: ' + result.filled.join(' / '));
    if (result.skipped.length > 0) log('スキップ: ' + result.skipped.join(' / '));

  } catch (e) {
    result.errors.push(e.message);
    warn('エラー: ' + e.message);
  }

  return result;
};

/**
 * 駅選択モーダルを開く関数。
 * 「路線・駅で絞り込み」ボタンを探してクリックする。
 * @returns {{ ok: boolean, error?: string }}
 */
// eslint-disable-next-line no-unused-vars
const __itandiOpenStationModal = () => {
  'use strict';
  // 「路線・駅で絞り込み」ボタンを探す
  var buttons = document.querySelectorAll('button');
  for (var i = 0; i < buttons.length; i++) {
    if (buttons[i].textContent.trim().includes('路線・駅で絞り込み')) {
      buttons[i].click();
      console.log('[itandi駅選択] モーダルを開きました');
      return { ok: true };
    }
  }
  return { ok: false, error: '「路線・駅で絞り込み」ボタンが見つかりません' };
};

/**
 * 駅選択モーダル内で1駅を検索してチェックする関数（検索＋チェックを1回のexecuteScriptで実行）。
 * 検索テキストボックスに駅名を入力 → 描画待ち → チェックボックスをクリック。
 * Promiseを返すため、executeScript側でawaitされる。
 * @param {string} stationName - 駅名（例: "渋谷"、"新宿"）
 * @returns {Promise<{ ok: boolean, checked: boolean, error?: string }>}
 */
// eslint-disable-next-line no-unused-vars
const __itandiSelectAndCheckStation = (stationName) => {
  'use strict';

  var cleanName = stationName.replace(/駅$/, '').trim();
  if (!cleanName) return Promise.resolve({ ok: false, checked: false, error: '駅名が空です' });

  var modal = document.querySelector('[role="dialog"]');
  if (!modal) return Promise.resolve({ ok: false, checked: false, error: 'モーダルが見つかりません' });

  // 駅検索テキストボックスを探す
  var inputs = modal.querySelectorAll('input[type="text"]');
  var searchInput = null;
  for (var i = 0; i < inputs.length; i++) {
    if ((inputs[i].placeholder || '').includes('路線を選ばなくても') ||
        (inputs[i].placeholder || '').includes('検索可能')) {
      searchInput = inputs[i];
      break;
    }
  }
  if (!searchInput) return Promise.resolve({ ok: false, checked: false, error: '駅検索テキストボックスが見つかりません' });

  // ── Step A: React onChange で検索テキストを入力 ──
  var rpk = Object.keys(searchInput).find(function(k) { return k.startsWith('__reactProps'); });
  if (rpk && searchInput[rpk].onChange) {
    searchInput[rpk].onChange({ target: { value: cleanName } });
  } else {
    return Promise.resolve({ ok: false, checked: false, error: 'React onChangeが見つかりません' });
  }
  console.log('[itandi駅選択] 検索入力: ' + cleanName);

  // ── Step B: 描画を待ってからチェック ──
  return new Promise(function(resolve) {
    setTimeout(function() {
      var stationFrame = modal.querySelector('[class*="StationFrame"]');
      if (!stationFrame) {
        resolve({ ok: true, checked: false, error: '駅エリアが見つかりません: ' + cleanName });
        return;
      }

      var labels = stationFrame.querySelectorAll('label');
      var checkedCount = 0;

      // 完全一致（同名駅を全路線分チェック）
      for (var i = 0; i < labels.length; i++) {
        var labelText = labels[i].textContent.trim();
        if (labelText === cleanName) {
          var cb = labels[i].querySelector('input[type="checkbox"]');
          if (cb && cb.checked) { checkedCount++; continue; }
          labels[i].click();
          checkedCount++;
          console.log('[itandi駅選択] チェック: ' + cleanName + ' (#' + checkedCount + ')');
        }
      }

      if (checkedCount > 0) {
        resolve({ ok: true, checked: true, checkedCount: checkedCount });
        return;
      }

      // 部分一致フォールバック
      for (var j = 0; j < labels.length; j++) {
        var txt = labels[j].textContent.trim();
        if (txt.includes(cleanName) || cleanName.includes(txt)) {
          var cb2 = labels[j].querySelector('input[type="checkbox"]');
          if (cb2 && cb2.checked) { checkedCount++; continue; }
          labels[j].click();
          checkedCount++;
          console.log('[itandi駅選択] 部分一致チェック: ' + txt);
        }
      }

      if (checkedCount > 0) {
        resolve({ ok: true, checked: true, checkedCount: checkedCount });
      } else {
        console.warn('[itandi駅選択] 駅が見つかりません: ' + cleanName);
        resolve({ ok: true, checked: false, error: '駅が見つかりません: ' + cleanName });
      }
    }, 800);  // React描画待ち
  });
};

/**
 * 駅選択モーダルの「確定」ボタンをクリックする関数。
 * @returns {{ ok: boolean, error?: string }}
 */
// eslint-disable-next-line no-unused-vars
const __itandiConfirmStations = () => {
  'use strict';
  var modal = document.querySelector('[role="dialog"]');
  if (!modal) return { ok: false, error: 'モーダルが見つかりません' };

  var buttons = modal.querySelectorAll('button');
  for (var i = 0; i < buttons.length; i++) {
    if (buttons[i].textContent.trim() === '確定') {
      buttons[i].click();
      console.log('[itandi駅選択] 確定クリック');
      return { ok: true };
    }
  }
  return { ok: false, error: '確定ボタンが見つかりません' };
};

// ══════════════════════════════════════════════════════════
//  所在地選択（モーダル経由）
// ══════════════════════════════════════════════════════════

/**
 * 所在地選択モーダルを開く関数。
 * 「所在地で絞り込み」ボタンを探してクリックする。
 * @returns {{ ok: boolean, error?: string }}
 */
// eslint-disable-next-line no-unused-vars
const __itandiOpenAddressModal = () => {
  'use strict';
  var buttons = document.querySelectorAll('button');
  for (var i = 0; i < buttons.length; i++) {
    if (buttons[i].textContent.trim().includes('所在地で絞り込み')) {
      buttons[i].click();
      console.log('[itandi所在地] モーダルを開きました');
      return { ok: true };
    }
  }
  return { ok: false, error: '「所在地で絞り込み」ボタンが見つかりません' };
};

/**
 * 所在地選択モーダル内で1市区町村を選択し、町域があればチェックする。
 * 市区町村はラジオボタンだが、クリックするたびに追加される仕様。
 * 都道府県はprefectureId=13（東京都）がデフォルト。
 *
 * @param {string} cityName - 市区町村名（例: "豊島区"）
 * @param {string[]} towns - 町名リスト（例: ["北大塚二丁目", "南大塚一丁目"]）。空なら全域。
 * @param {string} prefectureName - 都道府県名（例: "東京都"）。省略時は "東京都"
 * @returns {Promise<{ ok: boolean, citySelected: boolean, townsChecked: number, error?: string }>}
 */
// eslint-disable-next-line no-unused-vars
const __itandiSelectCityAndTowns = (cityName, towns, prefectureName) => {
  'use strict';

  prefectureName = prefectureName || '東京都';

  var modal = document.querySelector('.itandi-bb-ui__ModalBody');
  if (!modal) return Promise.resolve({ ok: false, citySelected: false, townsChecked: 0, error: 'モーダルが見つかりません' });

  // ── Step 1: 都道府県を選択（未選択の場合） ──
  var prefRadios = modal.querySelectorAll('input[type="radio"][name="prefectureId"]');
  var prefSelected = false;
  for (var p = 0; p < prefRadios.length; p++) {
    var prefLabel = prefRadios[p].closest('label');
    if (prefLabel && prefLabel.textContent.trim() === prefectureName) {
      if (!prefRadios[p].checked) {
        prefLabel.click();
        console.log('[itandi所在地] 都道府県選択: ' + prefectureName);
      }
      prefSelected = true;
      break;
    }
  }
  if (!prefSelected) {
    return Promise.resolve({ ok: false, citySelected: false, townsChecked: 0, error: '都道府県が見つかりません: ' + prefectureName });
  }

  // ── Step 2: 市区町村を選択 ──
  return new Promise(function(resolve) {
    // 都道府県選択後の描画待ち
    setTimeout(function() {
      var allRadios = modal.querySelectorAll('input[type="radio"]:not([name="prefectureId"])');
      var cityFound = false;

      for (var i = 0; i < allRadios.length; i++) {
        var cityLabel = allRadios[i].closest('label');
        if (cityLabel && cityLabel.textContent.trim() === cityName) {
          cityLabel.click();
          console.log('[itandi所在地] 市区町村選択: ' + cityName);
          cityFound = true;
          break;
        }
      }

      if (!cityFound) {
        resolve({ ok: true, citySelected: false, townsChecked: 0, error: '市区町村が見つかりません: ' + cityName });
        return;
      }

      // 町域選択がない場合（全域）→ そのまま完了
      if (!towns || towns.length === 0) {
        resolve({ ok: true, citySelected: true, townsChecked: 0, allArea: true });
        return;
      }

      // ── Step 3: 町域・丁目を選択（描画待ち後） ──
      setTimeout(function() {
        // 「全域」チェックを外す（個別選択のため）
        var allChecks = modal.querySelectorAll('input[type="checkbox"]');
        // 町域側の「全域」チェックボックス（2番目の「全域」= 町域カラム側）
        var areaAllChecks = [];
        for (var a = 0; a < allChecks.length; a++) {
          var aLabel = allChecks[a].closest('label');
          if (aLabel && aLabel.textContent.trim() === '全域') {
            areaAllChecks.push(allChecks[a]);
          }
        }
        // 町域側の全域チェック（2番目）がチェック済みなら外す
        if (areaAllChecks.length >= 2 && areaAllChecks[1].checked) {
          areaAllChecks[1].closest('label').click();
          console.log('[itandi所在地] 全域チェック解除');
        }

        // 町域をチェック
        setTimeout(function() {
          var townChecked = 0;
          var townErrors = [];

          // 町名の正規化: 漢数字→アラビア数字、丁目をN丁目に統一
          var normalizeForMatch = function(text) {
            var kanjiMap = { '一': '１', '二': '２', '三': '３', '四': '４', '五': '５',
                            '六': '６', '七': '７', '八': '８', '九': '９', '十': '１０' };
            var result = text;
            // 漢数字丁目を全角数字丁目に変換
            result = result.replace(/([一二三四五六七八九十]+)丁目/, function(_, k) {
              var num = 0;
              for (var n = 0; n < k.length; n++) {
                if (k[n] === '十') { num = num === 0 ? 10 : num * 10; }
                else { num += parseInt(kanjiMap[k[n]]) || 0; }
              }
              // 全角数字に変換
              var fullwidth = String(num).replace(/[0-9]/g, function(c) {
                return String.fromCharCode(c.charCodeAt(0) + 0xFEE0);
              });
              return fullwidth + '丁目';
            });
            return result;
          };

          for (var t = 0; t < towns.length; t++) {
            var townName = towns[t];
            var normalizedTown = normalizeForMatch(townName);
            var townFound = false;

            // 丁目指定がある場合（例: "北大塚二丁目" → "北大塚２丁目"）
            // → 完全一致でチェック
            var townCheckboxes = modal.querySelectorAll('input[type="checkbox"]');
            for (var c = 0; c < townCheckboxes.length; c++) {
              var townLabel = townCheckboxes[c].closest('label');
              if (!townLabel) continue;
              var labelText = townLabel.textContent.trim();

              if (labelText === normalizedTown || labelText === townName) {
                if (!townCheckboxes[c].checked) {
                  townLabel.click();
                }
                townFound = true;
                townChecked++;
                console.log('[itandi所在地] 町域チェック: ' + labelText);
                break;
              }
            }

            if (!townFound) {
              // 丁目なし町名（例: "北大塚"）→ 前方一致で全丁目チェック
              var baseName = normalizedTown.replace(/[０-９0-9]+丁目$/, '');
              if (baseName !== normalizedTown) {
                // 丁目付きだが見つからなかった
                townErrors.push(townName);
                continue;
              }
              // 町名のみ指定 → その町名で始まるすべての丁目をチェック
              for (var d = 0; d < townCheckboxes.length; d++) {
                var tLabel = townCheckboxes[d].closest('label');
                if (!tLabel) continue;
                var tText = tLabel.textContent.trim();
                if (tText.indexOf(baseName) === 0 && tText !== '全域') {
                  if (!townCheckboxes[d].checked) {
                    tLabel.click();
                  }
                  townChecked++;
                  console.log('[itandi所在地] 町域チェック(前方一致): ' + tText);
                }
              }
            }
          }

          resolve({
            ok: true,
            citySelected: true,
            townsChecked: townChecked,
            townErrors: townErrors.length > 0 ? townErrors : undefined
          });
        }, 300); // 全域チェック解除後の描画待ち
      }, 500); // 市区町村選択後の描画待ち
    }, 500); // 都道府県選択後の描画待ち
  });
};

/**
 * 所在地選択モーダルの「確定」ボタンをクリックする関数。
 * @returns {{ ok: boolean, error?: string }}
 */
// eslint-disable-next-line no-unused-vars
const __itandiConfirmAddress = () => {
  'use strict';
  var modal = document.querySelector('.itandi-bb-ui__ModalBody');
  if (!modal) return { ok: false, error: 'モーダルが見つかりません' };

  var buttons = document.querySelectorAll('button');
  for (var i = 0; i < buttons.length; i++) {
    if (buttons[i].textContent.trim() === '確定') {
      buttons[i].click();
      console.log('[itandi所在地] 確定クリック');
      return { ok: true };
    }
  }
  return { ok: false, error: '確定ボタンが見つかりません' };
};
