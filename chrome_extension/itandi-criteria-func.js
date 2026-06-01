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
 * 駅選択モーダル内で1駅を検索してチェックする関数。
 * 検索テキストボックスに駅名を入力 → 結果からチェックする。
 * @param {string} stationName - 駅名（例: "渋谷"、"新宿"）
 * @returns {{ ok: boolean, checked: boolean, error?: string }}
 */
// eslint-disable-next-line no-unused-vars
const __itandiSelectStation = (stationName) => {
  'use strict';

  // 「駅」を除去
  var cleanName = stationName.replace(/駅$/, '').trim();
  if (!cleanName) return { ok: false, checked: false, error: '駅名が空です' };

  var modal = document.querySelector('[role="dialog"]');
  if (!modal) return { ok: false, checked: false, error: 'モーダルが見つかりません' };

  // 駅検索テキストボックス（placeholder に「路線を選ばなくても」を含む）
  var inputs = modal.querySelectorAll('input[type="text"]');
  var searchInput = null;
  for (var i = 0; i < inputs.length; i++) {
    if ((inputs[i].placeholder || '').includes('路線を選ばなくても') ||
        (inputs[i].placeholder || '').includes('検索可能')) {
      searchInput = inputs[i];
      break;
    }
  }
  if (!searchInput) return { ok: false, checked: false, error: '駅検索テキストボックスが見つかりません' };

  // React互換の値設定
  var nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;
  nativeSetter.call(searchInput, cleanName);
  var tracker = searchInput._valueTracker;
  if (tracker) tracker.setValue('');
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  searchInput.dispatchEvent(new Event('change', { bubbles: true }));

  console.log('[itandi駅選択] 検索入力: ' + cleanName);
  return { ok: true, checked: false, searchedName: cleanName };
};

/**
 * 駅検索結果から駅をチェックする関数。
 * __itandiSelectStation の後、少し待ってから呼び出す。
 * @param {string} stationName - チェック対象の駅名
 * @returns {{ ok: boolean, checked: boolean, error?: string }}
 */
// eslint-disable-next-line no-unused-vars
const __itandiCheckStation = (stationName) => {
  'use strict';

  var cleanName = stationName.replace(/駅$/, '').trim();
  var modal = document.querySelector('[role="dialog"]');
  if (!modal) return { ok: false, checked: false, error: 'モーダルが見つかりません' };

  // StationFrame内の駅チェックボックスを検索
  var stationFrame = modal.querySelector('[class*="StationFrame"]');
  if (!stationFrame) return { ok: false, checked: false, error: '駅エリアが見つかりません' };

  var labels = stationFrame.querySelectorAll('label');
  for (var i = 0; i < labels.length; i++) {
    var labelText = labels[i].textContent.trim();
    if (labelText === cleanName) {
      // 既にチェック済みか確認
      var cb = labels[i].querySelector('input[type="checkbox"]');
      if (cb && cb.checked) {
        console.log('[itandi駅選択] 既にチェック済み: ' + cleanName);
        return { ok: true, checked: true, alreadyChecked: true };
      }
      labels[i].click();
      console.log('[itandi駅選択] チェック: ' + cleanName);
      return { ok: true, checked: true };
    }
  }

  // 見つからない場合 — 部分一致で探す
  for (var j = 0; j < labels.length; j++) {
    var txt = labels[j].textContent.trim();
    if (txt.includes(cleanName) || cleanName.includes(txt)) {
      var cb2 = labels[j].querySelector('input[type="checkbox"]');
      if (cb2 && cb2.checked) {
        return { ok: true, checked: true, alreadyChecked: true, matched: txt };
      }
      labels[j].click();
      console.log('[itandi駅選択] 部分一致でチェック: ' + txt + ' (検索: ' + cleanName + ')');
      return { ok: true, checked: true, matched: txt };
    }
  }

  console.warn('[itandi駅選択] 駅が見つかりません: ' + cleanName);
  return { ok: true, checked: false, error: '駅が見つかりません: ' + cleanName };
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
