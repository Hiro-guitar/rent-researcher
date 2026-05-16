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

  return {
    type: 'flex',
    altText: 'ご条件の変更をしてみませんか？',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'lg', // 大セクション間の縦間隔を広めに
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: 'ご条件の変更をしてみませんか？', weight: 'bold', size: 'lg', color: '#2c3e50', wrap: true },
          { type: 'text', text: '条件を少し緩めると、ご紹介できる物件が増える可能性があります。', size: 'sm', color: '#555555', wrap: true, margin: 'sm' },
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '現在ご登録の条件', size: 'sm', color: '#888888', weight: 'bold', margin: 'md' },
          {
            type: 'box', layout: 'vertical',
            spacing: 'md', // 条件1行ごとに少し余白を入れて見やすく
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
          { type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
            action: { type: 'uri', label: '家賃の上限を上げる', uri: liffBase + '&focus=rent' } },
          { type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
            action: { type: 'uri', label: 'エリアを広げる', uri: liffBase + '&focus=area' } },
          { type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
            action: { type: 'uri', label: '築年数を緩める', uri: liffBase + '&focus=age' } },
          { type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
            action: { type: 'uri', label: '面積を緩める', uri: liffBase + '&focus=area_min' } },
          { type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'uri', label: 'もう少し条件を見直す', uri: liffBase } }
        ]
      }
    }
  };
}
