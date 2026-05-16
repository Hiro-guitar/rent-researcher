/**
 * ConditionSuggestion.gs — 条件変更提案メッセージの送信機能
 *
 * 目的:
 *   条件登録をしてくれたが、物件をまだ紹介できていない (= 該当物件が見つから
 *   ない) 顧客に対して、「条件を緩めてみませんか」というLINEメッセージを
 *   送る。
 *
 * 候補抽出ロジック:
 *   - 配信ステータスが active (paused/blocked/snoozed は除外)
 *   - LINE userId が紐付いている (LINE Users シート登録あり)
 *   - 最終物件通知 (PENDING_SHEET status=sent の最新) から 14 日以上経過
 *     → 通知がない場合は登録日 (A列) から 14 日以上経過したかで判定
 *   - 前回の条件変更提案送信 (検索条件シートZ列) から 14 日以上経過
 *
 * メッセージ:
 *   Flex Message で 5 ボタン:
 *     - 家賃の上限を上げる   → 条件編集ページ #rentSection
 *     - エリアを広げる        → 条件編集ページ #areaSection
 *     - 築年数を緩める        → 条件編集ページ #ageSection
 *     - 面積を緩める          → 条件編集ページ #areaMinSection
 *     - もう少し条件を見直す  → 条件編集ページ (全体)
 *
 * シート拡張:
 *   検索条件シート Z列 (26列目, 配列index 25) を「条件変更提案 最終送信日時」
 *   として利用。空欄なら未送信扱い。
 *
 * 公開API (google.script.run から呼ばれる):
 *   - listConditionSuggestionCandidates() → 候補一覧
 *   - sendConditionSuggestionMessages(names) → 指定顧客に送信
 */

// 条件変更提案の閾値 (日数)
var CONDITION_SUGGESTION_THRESHOLD_DAYS = 14;
// 検索条件シートで「条件変更提案 最終送信日時」を記録する列 (1-based)
var CONDITION_SUGGESTION_SENT_COL = 26;

/**
 * 候補顧客の一覧を返す。AdminPage の「条件変更提案」セクションから呼ばれる。
 * @return {Array<Object>}
 */
function listConditionSuggestionCandidates() {
  try {
    return getConditionSuggestionCandidates_();
  } catch (e) {
    console.error('listConditionSuggestionCandidates error: ' + (e.stack || e.message));
    return [];
  }
}

/**
 * テスト送信用: 候補条件を無視して指定顧客に Flex メッセージを送信する。
 * 14日制限・Z列更新を行わないため、何度でも送れる。
 * @param {string} customerName
 * @return {{success: boolean, message: string}}
 */
function sendConditionSuggestionTest(customerName) {
  if (!customerName) return { success: false, message: '顧客名が未指定です' };
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return { success: false, message: '検索条件シートが見つかりません' };

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, message: '検索条件シートが空です' };
    var data = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();

    var row = null;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1] || '').trim() === String(customerName).trim()) {
        row = data[i];
        break;
      }
    }
    if (!row) return { success: false, message: '「' + customerName + '」が検索条件シートに見つかりません' };

    var lineUserIdMap = _getLineUserIdMapByCustomerName_();
    var userId = lineUserIdMap[customerName];
    if (!userId) return { success: false, message: '「' + customerName + '」の LINE userId が紐付いていません' };

    // 路線・駅 (E列) を Flex 表示用にパース
    var routesWithStations = [];
    try {
      if (typeof _parseRoutesWithStations === 'function') {
        routesWithStations = _parseRoutesWithStations(row[4]) || [];
      }
    } catch (_) {}
    var candidate = {
      name: customerName,
      lineUserId: userId,
      rentMax: String(row[7] || ''),
      layouts: String(row[8] || ''),
      walkMax: String(row[6] || ''),
      areaMin: String(row[9] || ''),
      ageMax: String(row[10] || ''),
      city: String(row[3] || ''),
      stations: String(row[5] || ''),
      routesWithStations: routesWithStations
    };
    var flex = buildConditionSuggestionFlex_(candidate);
    pushMessage(userId, [flex]);
    return { success: true, message: '「' + customerName + '」に送信しました (テスト送信: Z列は更新しません)' };
  } catch (e) {
    return { success: false, message: 'エラー: ' + (e.message || String(e)) };
  }
}

/**
 * 指定顧客に条件変更提案 Flex メッセージを送信する。
 * @param {string[]} customerNames - 送信対象の顧客名配列
 * @return {{sent: number, skipped: string[], failed: Array<{name:string, error:string}>}}
 */
function sendConditionSuggestionMessages(customerNames) {
  var result = { sent: 0, skipped: [], failed: [] };
  if (!Array.isArray(customerNames) || customerNames.length === 0) {
    return result;
  }
  var candidates = getConditionSuggestionCandidates_();
  var byName = {};
  for (var i = 0; i < candidates.length; i++) {
    byName[candidates[i].name] = candidates[i];
  }

  for (var k = 0; k < customerNames.length; k++) {
    var name = customerNames[k];
    var c = byName[name];
    if (!c) {
      result.skipped.push(name);
      continue;
    }
    try {
      var flex = buildConditionSuggestionFlex_(c);
      pushMessage(c.lineUserId, [flex]);
      // 送信日時を Z列 に記録
      try {
        var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
        var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
        sheet.getRange(c.rowIndex, CONDITION_SUGGESTION_SENT_COL).setValue(new Date());
      } catch (writeErr) {
        console.warn('条件変更提案 Z列 書き込み失敗 (' + name + '): ' + writeErr.message);
      }
      result.sent++;
    } catch (err) {
      result.failed.push({ name: name, error: err.message || String(err) });
    }
  }
  return result;
}

// ──────────────────────────────────────────────────────────────
// 候補抽出
// ──────────────────────────────────────────────────────────────
function getConditionSuggestionCandidates_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
  if (!sheet) return [];

  // 一括取得
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = Math.max(sheet.getLastColumn(), CONDITION_SUGGESTION_SENT_COL);
  var data = sheet.getRange(1, 1, lastRow, lastCol).getValues();

  // LINE userId マップ
  var lineUserIdMap = _getLineUserIdMapByCustomerName_();

  // 顧客ごとの「最終物件通知日」を PENDING_SHEET から一括取得
  var lastDeliveryMap = _buildLastDeliveryMap_();

  var now = Date.now();
  var thresholdMs = CONDITION_SUGGESTION_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  var dayMs = 24 * 60 * 60 * 1000;

  var candidates = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var name = String(row[1] || '').trim();
    if (!name) continue;

    // 配信ステータス: active のみ対象 (paused/snoozed/blocked は除外)
    var status = String(row[18] || '').trim().toLowerCase();
    if (status && status !== 'active') continue;

    var userId = lineUserIdMap[name];
    if (!userId) continue; // LINE紐付け無し → 送れないのでスキップ

    // 提案を14日以内に送ってる → 除外
    var lastSuggestAt = row[CONDITION_SUGGESTION_SENT_COL - 1];
    if (lastSuggestAt instanceof Date && (now - lastSuggestAt.getTime()) < thresholdMs) {
      continue;
    }

    // 最終物件通知日 or 登録日 (A列) から14日以上か?
    var regDate = row[0] instanceof Date ? row[0] : null;
    var lastDelivery = lastDeliveryMap[name] || null;
    var refDate = lastDelivery || regDate;
    if (!refDate) continue;

    var elapsedMs = now - refDate.getTime();
    if (elapsedMs < thresholdMs) continue;

    // 路線・駅 (E列): "路線名(駅A, 駅B), 路線名(駅C)" 形式
    var routesWithStations = [];
    try {
      if (typeof _parseRoutesWithStations === 'function') {
        routesWithStations = _parseRoutesWithStations(row[4]) || [];
      }
    } catch (_) {}

    candidates.push({
      name: name,
      lineUserId: userId,
      rowIndex: i + 1, // 1-based row in sheet
      registeredAt: regDate ? Utilities.formatDate(regDate, 'Asia/Tokyo', 'yyyy-MM-dd') : '',
      lastDeliveryAt: lastDelivery ? Utilities.formatDate(lastDelivery, 'Asia/Tokyo', 'yyyy-MM-dd') : '',
      daysSinceReference: Math.floor(elapsedMs / dayMs),
      lastSuggestAt: lastSuggestAt instanceof Date
        ? Utilities.formatDate(lastSuggestAt, 'Asia/Tokyo', 'yyyy-MM-dd')
        : '',
      // 現条件 (Flex メッセージ + 一覧表示用)
      rentMax: String(row[7] || ''),
      layouts: String(row[8] || ''),
      walkMax: String(row[6] || ''),
      areaMin: String(row[9] || ''),
      ageMax: String(row[10] || ''),
      city: String(row[3] || ''),
      stations: String(row[5] || ''),
      routesWithStations: routesWithStations  // [{ route: '路線名', stations: ['駅A', '駅B'] }, ...]
    });
  }

  // 経過日数が多い順
  candidates.sort(function(a, b) { return b.daysSinceReference - a.daysSinceReference; });
  return candidates;
}

/**
 * PENDING_SHEET (承認待ち物件) から、顧客ごとに「最終物件通知日」のマップを作る。
 * status='sent' の行のうち、column M (index 12) のタイムスタンプを集約。
 * @return {Object<string, Date>}
 */
function _buildLastDeliveryMap_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (!sheet) return {};
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};
  var data = sheet.getRange(2, 1, lastRow - 1, 13).getValues(); // A..M

  var map = {};
  for (var i = 0; i < data.length; i++) {
    var name = String(data[i][0] || '').trim();
    if (!name) continue;
    if (String(data[i][10]) !== 'sent') continue;
    var ts = data[i][12];
    var d = null;
    if (ts instanceof Date) {
      d = ts;
    } else if (typeof ts === 'string' && ts) {
      // 'yyyy-MM-dd HH:mm:ss' 形式 (PropertyApproval.updatePendingStatus 由来)
      var parsed = new Date(ts.replace(' ', 'T') + '+09:00');
      if (!isNaN(parsed.getTime())) d = parsed;
    }
    if (!d) continue;
    if (!map[name] || d.getTime() > map[name].getTime()) {
      map[name] = d;
    }
  }
  return map;
}

// ──────────────────────────────────────────────────────────────
// Flex Message 生成
// ──────────────────────────────────────────────────────────────
// 路線・駅の表示文字列を生成。
//   [{route:'西武新宿線', stations:['上石神井','武蔵関']}, ...]
//   → "西武新宿線（上石神井、武蔵関）／JR山手線（新宿）"
function _formatRoutesForDisplay_(routesWithStations) {
  if (!Array.isArray(routesWithStations) || routesWithStations.length === 0) return '';
  var parts = [];
  for (var i = 0; i < routesWithStations.length; i++) {
    var rws = routesWithStations[i] || {};
    var route = String(rws.route || '').trim();
    var stations = Array.isArray(rws.stations) ? rws.stations.filter(function(s) { return s; }) : [];
    if (route && stations.length > 0) {
      parts.push(route + '（' + stations.join('、') + '）');
    } else if (route) {
      parts.push(route);
    } else if (stations.length > 0) {
      parts.push(stations.join('、'));
    }
  }
  return parts.join(' ／ ');
}

// 1行分のラベル+値テキスト要素 (絵文字なし・項目名は明確に)
function _summaryLine_(label, value) {
  return {
    type: 'text',
    text: label + '：' + value,
    size: 'sm',
    color: '#444444',
    wrap: true
  };
}

function buildConditionSuggestionFlex_(c) {
  var liffBase = 'https://liff.line.me/' + LIFF_ID
    + '?action=selectCriteria&userId=' + encodeURIComponent(c.lineUserId);

  // 現条件の要約 (絵文字なし、項目名を明確に、路線名も含める)
  var summary = [];
  if (c.rentMax) summary.push(_summaryLine_('家賃の上限', c.rentMax + '万円'));
  var routesDisplay = _formatRoutesForDisplay_(c.routesWithStations);
  if (routesDisplay) {
    summary.push(_summaryLine_('沿線・駅', routesDisplay));
  } else if (c.stations) {
    summary.push(_summaryLine_('駅', c.stations));
  }
  if (c.city) summary.push(_summaryLine_('市区町村', c.city));
  if (c.layouts) summary.push(_summaryLine_('間取り', c.layouts));
  if (c.areaMin) summary.push(_summaryLine_('専有面積', c.areaMin + 'm² 以上'));
  if (c.ageMax) summary.push(_summaryLine_('築年数', c.ageMax + '年以内'));
  if (c.walkMax) summary.push(_summaryLine_('駅徒歩', c.walkMax + '分以内'));

  // postback data に現在値を載せる (再取得不要にして応答を早くする)
  var rentCurr = c.rentMax || '';
  var ageCurr = c.ageMax || '';
  var areaMinCurr = c.areaMin || '';

  return {
    type: 'flex',
    altText: 'ご条件の変更をしてみませんか？',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'lg',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: 'ご条件の変更をしてみませんか？', weight: 'bold', size: 'lg', color: '#2c3e50', wrap: true },
          { type: 'text', text: '条件を少し緩めると、ご紹介できる物件が増える可能性があります。', size: 'sm', color: '#555555', wrap: true, margin: 'sm' },
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '現在ご登録の条件', size: 'md', color: '#666666', weight: 'bold', margin: 'md' },
          {
            type: 'box', layout: 'vertical',
            spacing: 'md',
            margin: 'sm',
            contents: summary.length > 0 ? summary : [{ type: 'text', text: '(条件情報を取得できませんでした)', size: 'sm', color: '#aaaaaa' }]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'lg',
        contents: [
          // ── サクッと変更 (postback で値選択 → 即反映) ──
          { type: 'text', text: 'サクッと変更', size: 'xs', color: '#888888', weight: 'bold' },
          { type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
            action: { type: 'postback', label: '家賃の上限を上げる',
              data: 'condsug:open:rent:' + rentCurr,
              displayText: '家賃の上限を上げる' } },
          { type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
            action: { type: 'postback', label: '築年数を緩める',
              data: 'condsug:open:age:' + ageCurr,
              displayText: '築年数を緩める' } },
          { type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
            action: { type: 'postback', label: '面積を緩める',
              data: 'condsug:open:area_min:' + areaMinCurr,
              displayText: '面積を緩める' } },
          { type: 'separator', margin: 'md' },
          // ── じっくり見直す (LIFF で全項目編集) ──
          { type: 'text', text: 'じっくり見直す', size: 'xs', color: '#888888', weight: 'bold', margin: 'md' },
          { type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'uri', label: 'エリアを広げる', uri: liffBase + '&focus=area' } },
          { type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'uri', label: '条件編集ページを開く', uri: liffBase } }
        ]
      }
    }
  };
}

// ──────────────────────────────────────────────────────────────
// Postback ハンドラ (LIFF にせず LINE 内で値変更を完結させる)
// ──────────────────────────────────────────────────────────────
/**
 * LINE webhook の postback (data: condsug:...) を処理する。
 * コード.js の doPost dispatch から呼ばれる。
 *
 * data 形式:
 *   condsug:open:<category>:<currentValue>   → 値選択 Flex を返信
 *   condsug:set:<category>:<newValue>        → 検索条件シートを更新して確認返信
 *
 * @param {string} replyToken
 * @param {string} userId
 * @param {string} data
 */
function handleConditionSuggestionPostback(replyToken, userId, data) {
  try {
    var parts = String(data || '').split(':');
    if (parts.length < 3 || parts[0] !== 'condsug') {
      replyMessage(replyToken, [{ type: 'text', text: '条件変更の指示を解釈できませんでした。' }]);
      return;
    }
    var action = parts[1];
    var category = parts[2];
    var value = parts.slice(3).join(':'); // category の後の値部分 (空欄もありうる)

    if (action === 'open') {
      var flex = _buildValueSelectionFlex_(category, value, userId);
      if (!flex) {
        replyMessage(replyToken, [{ type: 'text', text: '値選択の準備に失敗しました。' }]);
        return;
      }
      replyMessage(replyToken, [flex]);
      return;
    }
    if (action === 'set') {
      _applyConditionChange_(replyToken, userId, category, value);
      return;
    }
    if (action === 'input') {
      // 自分で入力モード: state を CONDSUG_INPUT_<CATEGORY> にして、次のテキストを待つ
      _enterConditionInputMode_(replyToken, userId, category);
      return;
    }
    replyMessage(replyToken, [{ type: 'text', text: '不明な操作です: ' + action }]);
  } catch (e) {
    console.error('handleConditionSuggestionPostback error: ' + e.message);
    try { replyMessage(replyToken, [{ type: 'text', text: 'エラー: ' + e.message }]); } catch (_) {}
  }
}

// 家賃を価格帯に応じた単位で「切り上げ」る
//   < 15万: 0.1万 (千円) 単位
//   15-20万: 0.5万 単位
//   >= 20万: 1万 単位
function _ceilRentToStep_(v) {
  if (v < 15) return Math.ceil(v * 10) / 10;
  if (v < 20) return Math.ceil(v * 2) / 2;
  return Math.ceil(v);
}

// 表示用に小数を綺麗にフォーマット (8.0 → '8', 8.5 → '8.5')
function _fmtNum_(v) {
  return (v === Math.floor(v)) ? String(v) : String(Math.round(v * 10) / 10);
}

/**
 * Step 2: カテゴリごとに現在値から提案値を計算して値選択 Flex を組み立てる。
 */
function _buildValueSelectionFlex_(category, currentValue, userId) {
  var current = parseFloat(currentValue);

  var cfg;
  if (category === 'rent') {
    // 家賃: 現在値の +3% / +5% / +7% を価格帯単位で切り上げ
    var rc = isNaN(current) ? 8 : current;
    var r3 = _ceilRentToStep_(rc * 1.03);
    var r5 = _ceilRentToStep_(rc * 1.05);
    var r7 = _ceilRentToStep_(rc * 1.07);
    var seen = {};
    var opts = [];
    [r3, r5, r7].forEach(function (v) {
      if (v <= rc) return;       // 現在値以下は除外 (微小%で同値になるケース)
      var key = _fmtNum_(v);
      if (seen[key]) return;     // 重複除外
      seen[key] = true;
      opts.push({ value: key, label: key + '万円' });
    });
    cfg = {
      title: '家賃の上限を上げる',
      currentText: '現在: ' + (currentValue || '?') + '万円',
      options: opts,
      allowClear: false
    };
  } else if (category === 'age') {
    var ac = isNaN(current) ? 20 : current;
    cfg = {
      title: '築年数を緩める',
      currentText: '現在: ' + (currentValue || '?') + '年以内',
      options: [
        { value: String(ac + 5), label: (ac + 5) + '年以内' },
        { value: String(ac + 10), label: (ac + 10) + '年以内' },
        { value: String(ac + 15), label: (ac + 15) + '年以内' }
      ],
      allowClear: true,
      clearLabel: '築年数の指定をなくす'
    };
  } else if (category === 'area_min') {
    var sc = isNaN(current) ? 25 : current;
    var aopts = [];
    if (sc - 3 > 0) aopts.push({ value: String(sc - 3), label: (sc - 3) + 'm² 以上' });
    if (sc - 5 > 0) aopts.push({ value: String(sc - 5), label: (sc - 5) + 'm² 以上' });
    if (sc - 10 > 0) aopts.push({ value: String(sc - 10), label: (sc - 10) + 'm² 以上' });
    cfg = {
      title: '専有面積を緩める',
      currentText: '現在: ' + (currentValue || '?') + 'm² 以上',
      options: aopts,
      allowClear: true,
      clearLabel: '面積の指定をなくす'
    };
  } else {
    return null;
  }

  var footerButtons = cfg.options.map(function (opt) {
    return {
      type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
      action: {
        type: 'postback',
        label: opt.label + ' に変更',
        data: 'condsug:set:' + category + ':' + opt.value,
        displayText: opt.label + ' に変更'
      }
    };
  });
  if (cfg.allowClear) {
    footerButtons.push({
      type: 'button', style: 'secondary', height: 'sm',
      action: {
        type: 'postback',
        label: cfg.clearLabel || '指定なしにする',
        data: 'condsug:set:' + category + ':',
        displayText: cfg.clearLabel || '指定なしにする'
      }
    });
  }
  // 自分で入力する → postback で待機状態に入る (次のテキスト入力を受ける)
  footerButtons.push({
    type: 'button', style: 'secondary', height: 'sm',
    action: {
      type: 'postback',
      label: '自分で入力する',
      data: 'condsug:input:' + category,
      displayText: '自分で入力する'
    }
  });

  return {
    type: 'flex',
    altText: cfg.title,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: cfg.title, weight: 'bold', size: 'lg', color: '#2c3e50', wrap: true },
          { type: 'text', text: cfg.currentText, size: 'sm', color: '#666666', margin: 'sm', wrap: true },
          { type: 'text', text: 'いくつに変更しますか？', size: 'sm', color: '#555555', margin: 'md', wrap: true }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'lg',
        contents: footerButtons
      }
    }
  };
}

// カテゴリ別のヒント文・入力レンジ (自分で入力モード時に使う)
var _CONDSUG_INPUT_PROMPT = {
  rent:     { name: '家賃の上限', unit: '万円', example: '例: 9.5', min: 1,  max: 100 },
  age:      { name: '築年数',     unit: '年',   example: '例: 30',  min: 0,  max: 100 },
  area_min: { name: '専有面積',   unit: 'm²',   example: '例: 20',  min: 1,  max: 300 },
  walk:     { name: '駅徒歩',     unit: '分',   example: '例: 15',  min: 1,  max: 60 }
};

/**
 * 「自分で入力する」が押された時: state を CONDSUG_INPUT_<CATEGORY> にして
 * 次のテキストメッセージを待つ。
 */
function _enterConditionInputMode_(replyToken, userId, category) {
  var info = _CONDSUG_INPUT_PROMPT[category];
  if (!info) {
    replyMessage(replyToken, [{ type: 'text', text: '入力モード非対応の項目です。' }]);
    return;
  }
  try {
    var state = (typeof getState === 'function') ? getState(userId) : { step: '', data: {}, updatedAt: Date.now() };
    state.step = 'CONDSUG_INPUT_' + category.toUpperCase();
    if (typeof saveState === 'function') saveState(userId, state);
  } catch (e) {
    console.warn('_enterConditionInputMode_ saveState error: ' + e.message);
  }
  replyMessage(replyToken, [{
    type: 'text',
    text: info.name + 'を数字で入力してください。\n単位: ' + info.unit + '（' + info.example + '）\n\n中止する場合は「キャンセル」と送信してください。'
  }]);
}

/**
 * テキストメッセージハンドラ (コード.js から呼ばれる)。
 * 戻り値: true なら処理済み (呼び元はそれ以上ディスパッチしない)。
 */
function handleConditionSuggestionTextInput(replyToken, userId, message, state) {
  if (!state || !state.step || state.step.indexOf('CONDSUG_INPUT_') !== 0) return false;
  var category = state.step.replace('CONDSUG_INPUT_', '').toLowerCase();
  var info = _CONDSUG_INPUT_PROMPT[category];
  if (!info) {
    try { if (typeof clearState === 'function') clearState(userId); } catch (_) {}
    return false;
  }

  // キャンセル
  if (/^(キャンセル|cancel|中止|やめる)$/i.test(message)) {
    try { if (typeof clearState === 'function') clearState(userId); } catch (_) {}
    replyMessage(replyToken, [{ type: 'text', text: '入力をキャンセルしました。' }]);
    return true;
  }

  // 数値パース (全角→半角、単位文字除去)
  var raw = String(message).normalize('NFKC').replace(/[^0-9.]/g, '');
  var n = parseFloat(raw);
  if (isNaN(n)) {
    replyMessage(replyToken, [{
      type: 'text',
      text: '数字としてご入力ください。\n' + info.name + '（' + info.unit + '）\n' + info.example + '\n\n中止は「キャンセル」'
    }]);
    return true;
  }
  if (n < info.min || n > info.max) {
    replyMessage(replyToken, [{
      type: 'text',
      text: info.name + 'の範囲外です（' + info.min + '〜' + info.max + ' ' + info.unit + ' の範囲でご入力ください）。\n\n中止は「キャンセル」'
    }]);
    return true;
  }

  // 状態クリアして適用
  try { if (typeof clearState === 'function') clearState(userId); } catch (_) {}
  // 整数なら整数表示 / 小数なら .1 桁まで
  var writeValue = (n === Math.floor(n)) ? String(n) : String(Math.round(n * 10) / 10);
  _applyConditionChange_(replyToken, userId, category, writeValue);
  return true;
}

/**
 * Step 3: 検索条件シートを更新して、確認テキストを返信する。
 *
 * 列マッピング (Config.js & SheetWriter.js 準拠):
 *   G(6)  : 徒歩 (walk)
 *   H(7)  : 賃料上限 (rent_max)
 *   J(9)  : 面積下限 (area_min)
 *   K(10) : 築年数 (building_age)
 */
function _applyConditionChange_(replyToken, userId, category, newValue) {
  // category → column index (1-based for getRange)
  var colMap = { rent: 8, age: 11, area_min: 10, walk: 7 };
  var col = colMap[category];
  if (!col) {
    replyMessage(replyToken, [{ type: 'text', text: '不明なカテゴリです: ' + category }]);
    return;
  }

  // userId → 顧客名 (LINE Users シート)
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var luSheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);
  var customerName = '';
  if (luSheet) {
    var luData = luSheet.getDataRange().getValues();
    for (var i = 1; i < luData.length; i++) {
      if (String(luData[i][0] || '').trim() === userId) {
        customerName = String(luData[i][1] || '').trim();
        break;
      }
    }
  }
  if (!customerName) {
    replyMessage(replyToken, [{ type: 'text', text: 'お客様情報が見つかりませんでした。担当者にご連絡ください。' }]);
    return;
  }

  // 検索条件シートで customerName を探して該当列を更新
  var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
  if (!sheet) {
    replyMessage(replyToken, [{ type: 'text', text: '検索条件シートが見つかりませんでした。' }]);
    return;
  }
  var lastRow = sheet.getLastRow();
  var data = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
  var targetRowIndex = -1;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][1] || '').trim() === customerName) {
      targetRowIndex = r + 1; // 1-based
      break;
    }
  }
  if (targetRowIndex < 0) {
    replyMessage(replyToken, [{ type: 'text', text: 'ご登録の条件が見つかりませんでした。' }]);
    return;
  }

  // 値を書き込み (空欄なら指定なし)
  var writeVal = (newValue === undefined || newValue === null || newValue === '') ? '' : String(newValue);
  sheet.getRange(targetRowIndex, col).setValue(writeVal);

  // 確認テキスト
  var labels = {
    rent: { name: '家賃の上限', suffix: '万円', clearText: '指定なし' },
    age: { name: '築年数', suffix: '年以内', clearText: '指定なし' },
    area_min: { name: '専有面積', suffix: 'm² 以上', clearText: '指定なし' },
    walk: { name: '駅徒歩', suffix: '分以内', clearText: '指定なし' }
  };
  var info = labels[category];
  var changedText = writeVal === '' ? info.clearText : (writeVal + info.suffix);
  var msg = '✅ ' + info.name + 'を ' + changedText + ' に変更しました。\n次の検索から反映されます。';
  replyMessage(replyToken, [{ type: 'text', text: msg }]);
}
