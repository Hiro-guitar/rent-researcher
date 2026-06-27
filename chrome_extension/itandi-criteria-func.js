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
 * 所在地選択は5つの別関数で段階的に実行:
 *   __itandiOpenAddressModal  — 「所在地で絞り込み」ボタンをクリックしてモーダルを開く
 *   __itandiSelectPrefecture  — 都道府県ラジオを選択（同期）
 *   __itandiSelectCity        — 市区町村ラジオをポーリング→選択（単一Promise）
 *   __itandiSelectTowns       — 町域チェックボックスをステートマシンで選択（単一Promise）
 *   __itandiConfirmAddress    — 「確定」ボタンをクリックしてモーダルを閉じる
 *
 * 重要: chrome.scripting.executeScript({ world: 'MAIN' }) は .then() チェーンの
 *       Promise を正しくawaitできないため、各関数は単一の new Promise で実装する。
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

    // ══════════════════════════════════════
    //  8. 募集条件更新フィルタ (offer_conditions_updated_at:gteq)
    //     SELECT要素で日数(0〜14)を選ぶ形式
    // ══════════════════════════════════════
    if (typeof customerData.daysWithin === 'number' && customerData.daysWithin >= 0) {
      var daysSelect = document.querySelector('select[name="offer_conditions_updated_at:gteq"]');
      if (daysSelect) {
        var daysVal = Math.min(customerData.daysWithin, 14);
        var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        nativeSetter.call(daysSelect, String(daysVal));
        daysSelect.dispatchEvent(new Event('change', { bubbles: true }));
        result.filled.push('募集条件更新: ' + daysVal + '日以内');
      } else {
        result.skipped.push('募集条件更新: select[name="offer_conditions_updated_at:gteq"]が見つからない');
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

  // ── Step B: 検索結果の描画をポーリングで待つ → クリック → 下の駅リストへの追加を検証 ──
  // 固定の setTimeout だと描画が遅れたときに駅を取りこぼし、未選択のまま次へ進んでしまう。
  // 一致する駅ラベルが描画されるまでポーリングし、クリック後にモーダル下部の
  // 「選択中の駅リスト」(Chip) に実際に追加されたかを必ず検証する（追加されなければリトライ）。
  // itandi は同名駅(複数路線)を1つの Chip に集約するため、Chip テキストが駅名と
  // 一致すれば「下のリストに追加された」と判断できる。
  return new Promise(function(resolve) {
    var POLL_INTERVAL = 150;   // ms: 描画ポーリング間隔
    var RENDER_TIMEOUT = 6000; // ms: 描画待ち上限
    var startTime = Date.now();

    // モーダル下部の「選択中の駅リスト」(Chip) に対象駅が追加されているか判定する。
    // Chip のテキスト要素 (itandi-bb-ui__Chip__Text 等) を走査し、駅名一致を探す。
    function isInSelectedList() {
      var chips = modal.querySelectorAll('[class*="Chip__Text"]');
      for (var i = 0; i < chips.length; i++) {
        var txt = (chips[i].textContent || '').trim();
        if (!txt) continue;
        if (txt === cleanName || txt.indexOf(cleanName) >= 0 || cleanName.indexOf(txt) >= 0) {
          return true;
        }
      }
      return false;
    }

    // 検索語に一致するラベルを集める。
    // 戻り値: null=未描画 / []=描画済みだが一致なし / [labels...]=一致あり
    function collectMatchingLabels() {
      var stationFrame = modal.querySelector('[class*="StationFrame"]');
      if (!stationFrame) return null;
      var labels = stationFrame.querySelectorAll('label');
      if (labels.length === 0) return null;
      var exact = [], partial = [];
      for (var i = 0; i < labels.length; i++) {
        var txt = labels[i].textContent.trim();
        if (!txt) continue;
        if (txt === cleanName) exact.push(labels[i]);
        else if (txt.includes(cleanName) || cleanName.includes(txt)) partial.push(labels[i]);
      }
      if (exact.length > 0) return exact;     // 完全一致を優先（同名駅を全路線分）
      if (partial.length > 0) return partial; // フォールバック: 部分一致
      return [];
    }

    function pollForRender() {
      var matched = collectMatchingLabels();
      var elapsed = Date.now() - startTime;
      if (matched === null) {
        // まだ描画されていない
        if (elapsed > RENDER_TIMEOUT) {
          resolve({ ok: true, checked: false, error: '駅エリアの描画タイムアウト: ' + cleanName });
          return;
        }
        setTimeout(pollForRender, POLL_INTERVAL);
        return;
      }
      if (matched.length === 0) {
        // 描画済みだが一致駅なし → 遅延描画の可能性があるので上限まで待つ
        if (elapsed > RENDER_TIMEOUT) {
          console.warn('[itandi駅選択] 駅が見つかりません: ' + cleanName);
          resolve({ ok: true, checked: false, error: '駅が見つかりません: ' + cleanName });
          return;
        }
        setTimeout(pollForRender, POLL_INTERVAL);
        return;
      }
      // 一致ラベルあり → クリックして実際にチェックが入るか検証
      clickAndVerify(matched, 0);
    }

    // ラベルをクリックし、下の駅リスト(Chip)に追加されたか検証（最大3回リトライ）。
    // 「ちゃんと選択できて下の駅リストに追加されたら次に進む」という要件のため、
    // checkbox.checked ではなく Chip への追加を最終判定に使う。
    function clickAndVerify(labels, attempt) {
      // 既にリストに入っていれば追加クリック不要（重複クリックで解除されるのを防ぐ）
      if (!isInSelectedList()) {
        for (var i = 0; i < labels.length; i++) {
          var cb = labels[i].querySelector('input[type="checkbox"]');
          if (cb && cb.checked) continue; // 既にチェック済みはスキップ
          labels[i].click();
        }
      }
      // クリック反映（Chip 描画）を待ってから下の駅リストを確認
      setTimeout(function() {
        if (isInSelectedList()) {
          console.log('[itandi駅選択] 下の駅リストに追加確認: ' + cleanName);
          resolve({ ok: true, checked: true });
        } else if (attempt < 3) {
          console.warn('[itandi駅選択] 駅リスト未追加、リトライ ' + (attempt + 1) + ': ' + cleanName);
          clickAndVerify(labels, attempt + 1);
        } else {
          // リトライ上限まで追加を確認できず。次へ進めないよう checked:false で返す。
          console.warn('[itandi駅選択] 下の駅リストへの追加を確認できません: ' + cleanName);
          resolve({
            ok: true,
            checked: false,
            error: '下の駅リストへの追加を確認できません: ' + cleanName
          });
        }
      }, 300);
    }

    pollForRender();
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
 * 所在地モーダルで都道府県を選択する関数（同期）。
 * @param {string} prefectureName - 都道府県名（例: "東京都"）
 * @returns {{ ok: boolean, error?: string }}
 */
// eslint-disable-next-line no-unused-vars
const __itandiSelectPrefecture = (prefectureName) => {
  'use strict';
  prefectureName = prefectureName || '東京都';

  var modal = document.querySelector('.itandi-bb-ui__ModalBody');
  if (!modal) return { ok: false, error: 'モーダルが見つかりません' };

  var prefRadios = modal.querySelectorAll('input[type="radio"][name="prefectureId"]');
  for (var p = 0; p < prefRadios.length; p++) {
    var prefLabel = prefRadios[p].closest('label');
    if (prefLabel && prefLabel.textContent.trim() === prefectureName) {
      if (!prefRadios[p].checked) {
        prefLabel.click();
        console.log('[itandi所在地] 都道府県選択: ' + prefectureName);
      } else {
        console.log('[itandi所在地] 都道府県は既に選択済み: ' + prefectureName);
      }
      return { ok: true };
    }
  }
  return { ok: false, error: '都道府県が見つかりません: ' + prefectureName };
};

/**
 * 所在地モーダルで市区町村を選択する関数。
 * 市区町村ラジオが表示されるまでポーリングし、見つかったらクリック。
 * 単一の new Promise で実装（.then() チェーンなし）。
 * @param {string} cityName - 市区町村名（例: "豊島区"）
 * @returns {Promise<{ ok: boolean, citySelected: boolean, error?: string }>}
 */
// eslint-disable-next-line no-unused-vars
const __itandiSelectCity = (cityName) => {
  'use strict';

  var modal = document.querySelector('.itandi-bb-ui__ModalBody');
  if (!modal) return Promise.resolve({ ok: false, citySelected: false, error: 'モーダルが見つかりません' });

  return new Promise(function(resolve) {
    var interval = 200;
    var elapsed = 0;
    var maxMs = 5000;

    var timer = setInterval(function() {
      elapsed += interval;

      // 市区町村ラジオが表示されるまで待つ
      var radios = modal.querySelectorAll('input[type="radio"]:not([name="prefectureId"])');
      if (radios.length === 0) {
        if (elapsed >= maxMs) {
          clearInterval(timer);
          resolve({ ok: false, citySelected: false, error: '市区町村リストが表示されませんでした' });
        }
        return;
      }

      // ラジオが見つかった → 市区町村を検索してクリック
      clearInterval(timer);
      for (var i = 0; i < radios.length; i++) {
        var cityLabel = radios[i].closest('label');
        if (cityLabel && cityLabel.textContent.trim() === cityName) {
          cityLabel.click();
          console.log('[itandi所在地] 市区町村選択: ' + cityName);
          resolve({ ok: true, citySelected: true });
          return;
        }
      }
      resolve({ ok: true, citySelected: false, error: '市区町村が見つかりません: ' + cityName });
    }, interval);
  });
};

/**
 * 所在地モーダルで町域チェックボックスを選択する関数。
 * 町域データのロード待ち→全域チェック解除→React再レンダリング待ち→個別町域チェック
 * をステートマシン方式で実行。単一の new Promise（.then() チェーンなし）。
 *
 * @param {string[]} towns - 町名リスト（例: ["北大塚二丁目", "南大塚一丁目"]）
 * @returns {Promise<{ ok: boolean, townsChecked: number, townErrors?: string[], error?: string }>}
 */
// eslint-disable-next-line no-unused-vars
const __itandiSelectTowns = (towns) => {
  'use strict';

  if (!towns || towns.length === 0) {
    return Promise.resolve({ ok: true, townsChecked: 0, allArea: true });
  }

  // 初期チェック（この時点でモーダルがなければ即エラー）
  if (!document.querySelector('.itandi-bb-ui__ModalBody')) {
    return Promise.resolve({ ok: false, townsChecked: 0, error: 'モーダルが見つかりません' });
  }

  // ── 町名の正規化: 漢数字→全角数字丁目 ──
  var _normalizeForMatch = function(text) {
    var kanjiMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
                    '六': 6, '七': 7, '八': 8, '九': 9 };
    return text.replace(/([一二三四五六七八九十]+)丁目/, function(_, k) {
      var num = 0;
      for (var n = 0; n < k.length; n++) {
        if (k[n] === '十') { num = num === 0 ? 10 : num * 10; }
        else { num += kanjiMap[k[n]] || 0; }
      }
      var fullwidth = String(num).replace(/[0-9]/g, function(c) {
        return String.fromCharCode(c.charCodeAt(0) + 0xFEE0);
      });
      return fullwidth + '丁目';
    });
  };

  // ── モーダルを毎回再取得するヘルパー（Reactの再レンダリングで参照が無効になるため） ──
  var _getModal = function() {
    return document.querySelector('.itandi-bb-ui__ModalBody');
  };

  return new Promise(function(resolve) {
    var stage = 'waitTowns';
    var interval = 200;
    var elapsed = 0;
    var stageElapsed = 0; // 各ステージ内の経過時間
    var maxMs = 20000;

    var timer = setInterval(function() {
      elapsed += interval;
      stageElapsed += interval;

      if (elapsed >= maxMs) {
        clearInterval(timer);
        console.warn('[itandi所在地] タイムアウト (stage: ' + stage + ', elapsed: ' + elapsed + 'ms)');
        resolve({ ok: false, townsChecked: 0, error: 'タイムアウト (stage: ' + stage + ')' });
        return;
      }

      // 毎回モーダルを再取得（React再レンダリングでDOM要素が差し替わるため）
      var modal = _getModal();
      if (!modal) {
        console.log('[itandi所在地] モーダルが一時的に見つからない (stage: ' + stage + ')');
        return; // 再レンダリング中かもしれないので次のtickで再チェック
      }

      // ── Stage 1: 町域チェックボックスが表示されるまで待つ ──
      if (stage === 'waitTowns') {
        var checks = modal.querySelectorAll('input[type="checkbox"]');
        var townCount = 0;
        for (var j = 0; j < checks.length; j++) {
          var lbl = checks[j].closest('label');
          if (lbl && lbl.textContent.trim() !== '全域') townCount++;
        }
        if (townCount > 0) {
          console.log('[itandi所在地] 町域データ表示完了 (' + townCount + '件)');
          stage = 'uncheckAll';
          stageElapsed = 0;
        }
        return;
      }

      // ── Stage 2: 「全域」チェックを外す ──
      if (stage === 'uncheckAll') {
        var allChecks = modal.querySelectorAll('input[type="checkbox"]');
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
          stage = 'waitRerender';
          stageElapsed = 0;
        } else {
          console.log('[itandi所在地] 全域チェックは不要（既に解除済みまたは存在しない）');
          stage = 'selectTowns';
          stageElapsed = 0;
        }
        return;
      }

      // ── Stage 3: React再レンダリング完了を待つ ──
      //   全域チェック解除後、最低1000ms待ってから未チェックの町域チェックボックスを探す
      if (stage === 'waitRerender') {
        if (stageElapsed < 1000) return; // React再レンダリング+API通信を待つ

        var cbs = modal.querySelectorAll('input[type="checkbox"]');
        var uncheckedTownCount = 0;
        for (var w = 0; w < cbs.length; w++) {
          var wl = cbs[w].closest('label');
          if (wl && wl.textContent.trim() !== '全域' && wl.textContent.trim().length > 0) {
            if (!cbs[w].checked) uncheckedTownCount++;
          }
        }
        if (uncheckedTownCount > 0) {
          console.log('[itandi所在地] 再レンダリング完了 (未チェック町域: ' + uncheckedTownCount + '件)');
          stage = 'selectTowns';
          stageElapsed = 0;
        }
        return;
      }

      // ── Stage 4: 個別町域をチェック ──
      if (stage === 'selectTowns') {
        clearInterval(timer);

        // デバッグ: 利用可能なチェックボックスラベルを全て出力
        var debugCbs = modal.querySelectorAll('input[type="checkbox"]');
        var availableLabels = [];
        for (var x = 0; x < debugCbs.length; x++) {
          var xl = debugCbs[x].closest('label');
          if (xl) availableLabels.push(xl.textContent.trim() + (debugCbs[x].checked ? '✓' : ''));
        }
        console.log('[itandi所在地] 利用可能ラベル: ' + availableLabels.join(' | '));
        console.log('[itandi所在地] 選択対象: ' + towns.join(', '));

        var townChecked = 0;
        var townErrors = [];

        for (var t = 0; t < towns.length; t++) {
          var townName = towns[t];
          var normalizedTown = _normalizeForMatch(townName);
          var townFound = false;

          console.log('[itandi所在地] 検索中: "' + townName + '" → 正規化: "' + normalizedTown + '"');

          // DOMを再取得（毎回最新のmodalから）
          var freshModal = _getModal();
          var townCheckboxes = freshModal ? freshModal.querySelectorAll('input[type="checkbox"]') : [];
          for (var c = 0; c < townCheckboxes.length; c++) {
            var townLabel = townCheckboxes[c].closest('label');
            if (!townLabel) continue;
            var labelText = townLabel.textContent.trim();

            if (labelText === normalizedTown || labelText === townName) {
              if (!townCheckboxes[c].checked) {
                townLabel.click();
                console.log('[itandi所在地] 町域チェック: ' + labelText);
              } else {
                console.log('[itandi所在地] 町域は既にチェック済み: ' + labelText);
              }
              townFound = true;
              townChecked++;
              break;
            }
          }

          if (!townFound) {
            // 丁目なし町名（例: "北大塚"）→ 前方一致で全丁目チェック
            var baseName = normalizedTown.replace(/[０-９0-9]+丁目$/, '');
            if (baseName !== normalizedTown) {
              console.warn('[itandi所在地] 町域が見つかりません: ' + townName);
              townErrors.push(townName);
              continue;
            }
            var prefixMatched = 0;
            for (var d = 0; d < townCheckboxes.length; d++) {
              var tLabel = townCheckboxes[d].closest('label');
              if (!tLabel) continue;
              var tText = tLabel.textContent.trim();
              if (tText.indexOf(baseName) === 0 && tText !== '全域') {
                if (!townCheckboxes[d].checked) {
                  tLabel.click();
                }
                prefixMatched++;
                townChecked++;
                console.log('[itandi所在地] 町域チェック(前方一致): ' + tText);
              }
            }
            if (prefixMatched === 0) {
              console.warn('[itandi所在地] 前方一致でも見つかりません: ' + baseName);
              townErrors.push(townName);
            }
          }
        }

        console.log('[itandi所在地] 町域選択完了: ' + townChecked + '/' + towns.length + '件');
        resolve({
          ok: true,
          townsChecked: townChecked,
          townErrors: townErrors.length > 0 ? townErrors : undefined
        });
        return;
      }
    }, interval);
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
