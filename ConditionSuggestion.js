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
 * 自動送信: GAS の時間トリガーから呼ばれる想定。
 *   1. 候補抽出
 *   2. 全員に送信
 *   3. Discord に結果通知
 *
 * 無効化したい時は ScriptProperties で
 *   CONDITION_SUGGESTION_AUTO_ENABLED = 'false'
 * を設定する。
 *
 * 初回セットアップは setupConditionSuggestionAutoTrigger() を1回手動実行で
 * トリガー登録できる。
 */
function runConditionSuggestionAutoSend() {
  var ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  try {
    // 無効化スイッチ
    var props = PropertiesService.getScriptProperties();
    var enabled = props.getProperty('CONDITION_SUGGESTION_AUTO_ENABLED');
    if (enabled === 'false' || enabled === 'FALSE') {
      console.log('[条件変更提案/自動] 無効化されているためスキップ (' + ts + ')');
      return;
    }

    var candidates = getConditionSuggestionCandidates_();
    if (!candidates || candidates.length === 0) {
      // 候補なしの日は Discord 通知不要 (毎日0件の通知でノイズになるため)
      console.log('[条件変更提案/自動] 候補なし (' + ts + ')');
      return;
    }

    var names = candidates.map(function (c) { return c.name; });
    var result = sendConditionSuggestionMessages(names);
    console.log('[条件変更提案/自動] 送信完了: 候補' + candidates.length + ' 送信' + result.sent
      + ' スキップ' + (result.skipped || []).length + ' 失敗' + (result.failed || []).length);
    _notifyAutoSendToDiscord_(candidates.length, result, ts);
  } catch (err) {
    console.error('[条件変更提案/自動] 致命エラー: ' + err.message + '\n' + err.stack);
    try { _notifyAutoSendErrorToDiscord_(err, ts); } catch (_) {}
  }
}

/**
 * Discord に自動送信結果を通知。失敗一覧も含める。
 */
function _notifyAutoSendToDiscord_(total, result, ts) {
  try {
    var webhookUrl = PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK_URL');
    if (!webhookUrl) return;
    var lines = [];
    lines.push('🔔 **条件変更提案メッセージ 自動送信**');
    lines.push('時刻: ' + (ts || ''));
    lines.push('候補: ' + total + '名');
    if (total > 0) {
      lines.push('・✅ 送信成功: ' + (result.sent || 0) + '件');
      if ((result.skipped || []).length > 0) {
        lines.push('・⏭ スキップ (候補外): ' + result.skipped.length + '件 ' + result.skipped.slice(0, 5).join(', '));
      }
      if ((result.failed || []).length > 0) {
        lines.push('・❌ 失敗: ' + result.failed.length + '件');
        for (var i = 0; i < Math.min(result.failed.length, 5); i++) {
          var f = result.failed[i];
          lines.push('   - ' + f.name + ': ' + (f.error || '不明').substring(0, 80));
        }
      }
    } else {
      lines.push('(該当する顧客なし)');
    }
    UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ content: lines.join('\n') }),
      muteHttpExceptions: true
    });
  } catch (e) {
    console.warn('_notifyAutoSendToDiscord_ failed: ' + e.message);
  }
}

function _notifyAutoSendErrorToDiscord_(err, ts) {
  var webhookUrl = PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK_URL');
  if (!webhookUrl) return;
  UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      content: '⚠️ **条件変更提案 自動送信エラー**\n時刻: ' + ts + '\nエラー: ' + (err.message || '不明')
    }),
    muteHttpExceptions: true
  });
}

/**
 * 初回セットアップ用: 既存トリガーを削除して、毎日 10:00 (JST) に
 * runConditionSuggestionAutoSend を実行するトリガーを登録する。
 * GAS エディタから1回手動実行する。
 */
function setupConditionSuggestionAutoTrigger() {
  // 既存の同名トリガーを削除
  var existing = ScriptApp.getProjectTriggers();
  var deleted = 0;
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'runConditionSuggestionAutoSend') {
      ScriptApp.deleteTrigger(existing[i]);
      deleted++;
    }
  }
  // 毎日10時にトリガー登録
  ScriptApp.newTrigger('runConditionSuggestionAutoSend')
    .timeBased()
    .everyDays(1)
    .atHour(10)
    .inTimezone('Asia/Tokyo')
    .create();
  return '✅ 既存トリガー' + deleted + '個を削除し、毎日10:00 (JST) のトリガーを新規登録しました。';
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
      structures: String(row[11] || ''),
      equipment: String(row[12] || ''),
      city: String(row[3] || ''),
      stations: String(row[5] || ''),
      routesWithStations: routesWithStations
    };
    var flex = buildConditionSuggestionFlex_(candidate);
    pushMessage(userId, [flex]);
    // 「条件を変更する」LIFFボタンタップ時の応答を高速化するため
    // フォームHTMLをプリレンダしてCacheServiceに保存する。
    try {
      if (typeof prerenderAndCacheCriteriaHtml_ === 'function') {
        prerenderAndCacheCriteriaHtml_(userId);
      }
    } catch (_ePR) {
      console.warn('条件変更提案テストプリレンダ失敗: ' + (_ePR && _ePR.message));
    }
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
      // 「条件を変更する」LIFFボタンタップ時の応答を高速化するため
      // フォームHTMLをプリレンダしてCacheServiceに保存する。
      try {
        if (typeof prerenderAndCacheCriteriaHtml_ === 'function') {
          prerenderAndCacheCriteriaHtml_(c.lineUserId);
        }
      } catch (_ePR) {
        console.warn('条件変更提案プリレンダ失敗: ' + (_ePR && _ePR.message));
      }
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
      structures: String(row[11] || ''),
      equipment: String(row[12] || ''),
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

// 値文字列から既存サフィックスを剥がして数字部分だけ返す。
// 「指定しない」「指定なし」「空」は null を返す → 呼び元で「指定なし」表示にする。
function _stripCondSuffix_(value, suffixRe) {
  if (value === undefined || value === null) return null;
  var s = String(value).trim();
  if (!s || s === '指定しない' || s === '指定なし') return null;
  if (suffixRe) s = s.replace(suffixRe, '');
  return s || null;
}

// 「値 + 単位 / 指定なし」のテキスト要素を作る
function _condLine_(label, raw, suffix, suffixRe) {
  var v = _stripCondSuffix_(raw, suffixRe);
  var text = v ? (v + suffix) : '指定なし';
  return _summaryLine_(label, text);
}

function buildConditionSuggestionFlex_(c) {
  var liffBase = 'https://liff.line.me/' + LIFF_ID
    + '?action=selectCriteria&userId=' + encodeURIComponent(c.lineUserId);

  // 現条件の要約 (絵文字なし、項目名を明確に、路線名も含める)。
  // 各項目は必ず表示する (空/指定しない なら「指定なし」と明示)。
  var summary = [];
  summary.push(_condLine_('家賃の上限', c.rentMax, '万円', /万円$/));

  // エリアは路線・駅 / 市区町村 / どちらも未指定 のいずれか
  var routesDisplay = _formatRoutesForDisplay_(c.routesWithStations);
  if (routesDisplay) {
    summary.push(_summaryLine_('沿線・駅', routesDisplay));
  } else if (c.stations) {
    summary.push(_summaryLine_('駅', c.stations));
  } else if (c.city) {
    summary.push(_summaryLine_('市区町村', c.city));
  } else {
    summary.push(_summaryLine_('エリア', '指定なし'));
  }

  if (c.layouts) {
    summary.push(_summaryLine_('間取り', c.layouts));
  } else {
    summary.push(_summaryLine_('間取り', '指定なし'));
  }
  summary.push(_condLine_('専有面積', c.areaMin, 'm² 以上', /m²?\s*以上$|㎡\s*以上$/));
  summary.push(_condLine_('築年数', c.ageMax, '年以内', /年以内$/));
  summary.push(_condLine_('駅徒歩', c.walkMax, '分以内', /分以内$/));
  // こだわり条件は全項目を表示 (顧客が自分の登録状態を完全に把握できるように)
  var eqItems = (c.equipment || '').split(/[,、]/).map(function (s) { return s.trim(); }).filter(function (s) { return s; });
  if (eqItems.length === 0) {
    summary.push(_summaryLine_('こだわり', '指定なし'));
  } else {
    summary.push(_summaryLine_('こだわり', eqItems.join('、')));
  }

  // (旧仕様で各カテゴリの postback data 用に現在値を計算していた変数は撤去。
  //  詳細カスケードを復活させる際は c.rentMax / c.ageMax / c.areaMin /
  //  c.walkMax / c.layouts / c.structures / c.equipment から組み立てる)

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
          { type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
            action: { type: 'uri', label: '条件を変更する', uri: liffBase } },
          { type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'postback', label: 'このまま様子を見る',
              data: 'condsug:keep',
              displayText: 'このまま様子を見る' } },
          { type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'postback', label: '配信を停止する',
              data: 'condsug:pause',
              displayText: '配信を停止する' } }
        ]
      }
      // ──────────────────────────────────────────────────────────────
      // ※ 旧仕様: 「サクッと変更」ボタン群 (家賃/築年/面積/駅徒歩/間取り/構造/こだわり)
      //   は撤去したが、postback ハンドラと値選択 Flex / 適用ロジックは
      //   ConditionSuggestion.js 内に残してある (次回の仕様変更で再利用するため)。
      //   - _buildValueSelectionFlex_
      //   - _applyConditionChange_
      //   - _findNearestSmallerLayouts_ / _generateRelaxCumulativeOptions_
      //   - _parseLayout_ / _CONDSUG_INPUT_PROMPT
      //   - _enterConditionInputMode_ / handleConditionSuggestionTextInput
      //   - handleConditionSuggestionPostback の condsug:open / condsug:set /
      //     condsug:input アクション
      //   (現メッセージにはこれらのボタンが出ないだけ。過去送信メッセージで古い
      //    ボタンをタップされた場合は今までと同じ挙動になる。)
      // ──────────────────────────────────────────────────────────────
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
    if (parts.length < 2 || parts[0] !== 'condsug') {
      replyMessage(replyToken, [{ type: 'text', text: '条件変更の指示を解釈できませんでした。' }]);
      return;
    }
    var action = parts[1];
    // 新仕様の 2 アクション (3ボタン Flex から飛んでくる) を先に処理
    if (action === 'keep') {
      replyMessage(replyToken, [{
        type: 'text',
        text: '承知いたしました。引き続き、お客様にぴったりの物件をお探ししてお届けします。\n\n気が変わった時は、いつでも「条件変更」とお送りください。'
      }]);
      return;
    }
    if (action === 'pause') {
      // 既存の配信停止フローに委譲 (理由を聞く quickReply が出る)
      if (typeof handleDeliveryStopCommand === 'function') {
        handleDeliveryStopCommand(replyToken, userId);
      } else {
        replyMessage(replyToken, [{ type: 'text', text: '配信停止の処理を呼び出せませんでした。「配信停止」と直接お送りください。' }]);
      }
      return;
    }
    // ── 旧仕様 (詳細カスケード) のハンドラ。互換のため残置 ──
    if (parts.length < 3) {
      replyMessage(replyToken, [{ type: 'text', text: '条件変更の指示を解釈できませんでした。' }]);
      return;
    }
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

// 間取り名を (部屋数, 種類ランク) にパース。
//   ワンルーム → (0, 0)
//   NK   → (N, 1)
//   NDK  → (N, 2)
//   NLDK → (N, 3)
//   4K以上 → (4, 1)
function _parseLayout_(name) {
  if (!name) return null;
  if (name === 'ワンルーム') return { rooms: 0, type: 0 };
  if (name === '4K以上') return { rooms: 4, type: 1 };
  var m = String(name).match(/^(\d+)(LDK|DK|K)$/);
  if (!m) return null;
  return {
    rooms: parseInt(m[1], 10),
    type: m[2] === 'LDK' ? 3 : (m[2] === 'DK' ? 2 : 1)
  };
}

// 現在選択中の間取り (複数可) に対して「近い順で smaller な候補」を limit 個返す。
//
// 仕様:
//   - 「larger」(部屋数も種類も最大値より大きい) 候補は除外
//   - 距離は「現在選択中のいずれかの間取り」との 2D マンハッタン距離で
//     最も近い値 (min distance) を採用 → 複数選択でも自然な近さ判定
//   - 同距離なら「最も近い現在値と同じ種類ランク」を優先 (LDK ↔ LDK 等)
//
// 例:
//   [1K, 1LDK] → 1DK, ワンルーム は各 current への最小距離で評価される
//   [2LDK] → 1LDK (同type, room-1) と 2DK (同room, type-1) が同距離 →
//            type一致の 1LDK が先
function _findNearestSmallerLayouts_(currentList, limit) {
  var LAYOUTS = ['ワンルーム','1K','1DK','1LDK','2K','2DK','2LDK','3K','3DK','3LDK','4K以上'];
  var parsedCurrent = currentList.map(_parseLayout_).filter(function (p) { return p; });
  if (parsedCurrent.length === 0) return [];
  // 「larger 除外」判定の基準として、現在の中で最も大きい間取り (rooms*10+type) を取る。
  var maxCurrent = parsedCurrent.reduce(function (a, b) {
    return (b.rooms * 10 + b.type) > (a.rooms * 10 + a.type) ? b : a;
  });

  var candidates = [];
  for (var i = 0; i < LAYOUTS.length; i++) {
    var name = LAYOUTS[i];
    if (currentList.indexOf(name) >= 0) continue;
    var p = _parseLayout_(name);
    if (!p) continue;
    // larger 判定: rooms > maxCurrent.rooms、または rooms == max かつ type > max.type
    if (p.rooms > maxCurrent.rooms) continue;
    if (p.rooms === maxCurrent.rooms && p.type > maxCurrent.type) continue;
    // 現在選択中のうち最も近いものまでの距離を取る
    var minDist = Infinity;
    var nearestCur = parsedCurrent[0];
    for (var ci = 0; ci < parsedCurrent.length; ci++) {
      var cur = parsedCurrent[ci];
      var d = Math.abs(p.rooms - cur.rooms) + Math.abs(p.type - cur.type);
      if (d < minDist) { minDist = d; nearestCur = cur; }
    }
    var typeMatch = (p.type === nearestCur.type) ? 0 : 1; // 0 が優先 (同じ種類)
    candidates.push({ name: name, dist: minDist, typeMatch: typeMatch });
  }
  candidates.sort(function (a, b) {
    if (a.dist !== b.dist) return a.dist - b.dist;
    if (a.typeMatch !== b.typeMatch) return a.typeMatch - b.typeMatch;
    return 0;
  });
  var result = candidates.slice(0, limit).map(function (c) { return c.name; });

  // 特別ケース: 「ワンルーム」だけ選択中の場合、より小さい候補は無いが
  // 1K は実質的に同等扱いされることが多いため例外的に提案する。
  if (result.length === 0 && currentList.length === 1 && currentList[0] === 'ワンルーム') {
    return ['1K'];
  }
  return result;
}

// multi-select (間取り・構造) で「現在 + 追加候補」を累積的に提案する。
//   eligibleList: 追加候補を「先頭から追加すべき順」に並べた配列
//   戻り値: 最大3つの選択肢 [{value: '<full-list-csv>', label: '...'}]
//
// 例 (eligible 3つ以上): [鉄骨系, 木造, ブロック・その他]
//   Opt1: 鉄骨系 も含める          (先頭1個)
//   Opt2: 鉄骨系・木造 も含める     (先頭2個)
//   Opt3: 全てを含める              (3個まとめて = 全部)
//
// 例 (eligible 2つ): [木造, ブロック・その他]
//   Opt1: 木造 も含める
//   Opt2: 全てを含める               (=2個追加)
//
// 例 (eligible 1つ): [ワンルーム]
//   Opt1: ワンルーム も含める         (これ1つだけ)
function _generateRelaxCumulativeOptions_(currentList, eligibleList) {
  if (!eligibleList || eligibleList.length === 0) return [];
  var opts = [];
  // Opt 1: 先頭1個追加
  opts.push({
    addList: [eligibleList[0]],
    label: eligibleList[0] + ' も含める'
  });
  if (eligibleList.length === 2) {
    opts.push({ addList: eligibleList.slice(), label: '全てを含める' });
  } else if (eligibleList.length >= 3) {
    // Opt 2: 先頭2個
    opts.push({
      addList: [eligibleList[0], eligibleList[1]],
      label: eligibleList[0] + '・' + eligibleList[1] + ' も含める'
    });
    // Opt 3: 全て
    opts.push({ addList: eligibleList.slice(), label: '全てを含める' });
  }
  return opts.map(function (o) {
    return {
      value: currentList.concat(o.addList).join(','),
      label: o.label
    };
  });
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
    // 築年数: 新しいほど細かく、古いほど粗く刻む。
    // 標準ラダー (条件編集ページの AGE_VALUES と同じ系列) から、
    // 現在値より大きい次の3つを採用する。
    var AGE_LADDER = [1, 2, 3, 4, 5, 7, 10, 15, 20, 25, 30, 35, 40];
    var ac = isNaN(current) ? 20 : current;
    var ageOpts = [];
    for (var ai = 0; ai < AGE_LADDER.length && ageOpts.length < 3; ai++) {
      if (AGE_LADDER[ai] > ac) {
        ageOpts.push({ value: String(AGE_LADDER[ai]), label: AGE_LADDER[ai] + '年以内' });
      }
    }
    cfg = {
      title: '築年数を緩める',
      currentText: '現在: ' + (currentValue || '?') + '年以内',
      options: ageOpts,
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
  } else if (category === 'walk') {
    // 駅徒歩: ラダー方式。現在値より大きい次の3つを採用
    var WALK_LADDER = [1, 3, 5, 7, 10, 12, 15, 20];
    var wc = isNaN(current) ? 10 : current;
    var walkOpts = [];
    for (var wi = 0; wi < WALK_LADDER.length && walkOpts.length < 3; wi++) {
      if (WALK_LADDER[wi] > wc) {
        walkOpts.push({ value: String(WALK_LADDER[wi]), label: WALK_LADDER[wi] + '分以内' });
      }
    }
    cfg = {
      title: '駅徒歩を伸ばす',
      currentText: '現在: ' + (currentValue || '?') + '分以内',
      options: walkOpts,
      allowClear: true,
      clearLabel: '駅徒歩の指定をなくす'
    };
  } else if (category === 'equipment') {
    // こだわり条件: 現在選択中の各項目を「X を諦める」ボタンに変換。
    // ワンタップで個別に諦められる。複数諦めたいなら最初の提案メッセージに戻って再タップ。
    var eqList = String(currentValue || '').split(/[,、]/).map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    var eopts = [];
    for (var ei = 0; ei < eqList.length; ei++) {
      var item = eqList[ei];
      // 諦める = 現在リストから item を除いた新リストに更新
      var newList = eqList.slice(0, ei).concat(eqList.slice(ei + 1));
      eopts.push({
        value: newList.join(','),
        label: item + ' を諦める'
      });
    }
    cfg = {
      title: 'こだわり条件を見直す',
      currentText: eqList.length > 0 ? '現在: ' + eqList.join('、') : '現在: 指定なし',
      options: eopts,
      allowClear: eqList.length > 0,
      clearLabel: '全て諦める',
      promptText: '諦めても良いこだわり条件をタップしてください。'
    };
  } else if (category === 'layouts' || category === 'structures') {
    // 間取り・構造 は「現在の選択肢に追加」方式 (multi-select)
    // 緩める向きは category ごとに異なる:
    //   layouts → 「現在より小さい間取りだけ追加」(大きい間取り = 高い・選びにくいので不要)
    //   structures → ladder順で未選択を「次の1個 → 次の2個 → 全て」と段階的に追加
    var ladder, direction, mtitle, mprompt;
    if (category === 'layouts') {
      ladder = ['ワンルーム', '1K', '1DK', '1LDK', '2K', '2DK', '2LDK', '3K', '3DK', '3LDK', '4K以上'];
      direction = 'smaller';
      mtitle = '間取りを増やす';
      mprompt = '今ご登録の間取りに加えたい候補をお選びください。';
    } else {
      ladder = ['鉄筋系', '鉄骨系', '木造', 'ブロック・その他'];
      direction = 'cumulative';
      mtitle = '構造を増やす';
      mprompt = '今ご登録の構造に加えたい候補をお選びください。';
    }

    var currentList = String(currentValue || '').split(/[,、]/).map(function (s) { return s.trim(); }).filter(function (s) { return s; });

    var mopts = [];
    if (direction === 'smaller') {
      // 間取り: (部屋数, 種類ランク) の 2次元空間で「近い順」に2つ選ぶ。
      //   ワンルーム=(0,0), NK=(N,1), NDK=(N,2), NLDK=(N,3), 4K以上=(4,1)
      // 「より大きい」(部屋数>maxOrイコールで種類>max) は除外。
      // 同距離なら同じ種類 (LDK→LDK 等) を優先 → 2LDK→1LDK が 2LDK→2DK より上位に。
      var nearer = _findNearestSmallerLayouts_(currentList, 2);
      if (nearer.length >= 1) {
        mopts.push({
          value: currentList.concat([nearer[0]]).join(','),
          label: nearer[0] + ' も含める'
        });
      }
      if (nearer.length >= 2) {
        mopts.push({
          value: currentList.concat([nearer[0], nearer[1]]).join(','),
          label: nearer[0] + '・' + nearer[1] + ' も含める'
        });
      }
    } else {
      // 構造: ladder 順で未選択を取り、「次の1個 → 次の2個 → 全て」の累積追加
      var eligible = [];
      for (var si = 0; si < ladder.length; si++) {
        if (currentList.indexOf(ladder[si]) < 0) eligible.push(ladder[si]);
      }
      mopts = _generateRelaxCumulativeOptions_(currentList, eligible);
    }

    cfg = {
      title: mtitle,
      currentText: currentList.length > 0 ? '現在: ' + currentList.join('、') : '現在: 指定なし',
      options: mopts,
      allowClear: false,
      promptText: mprompt
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
  // 自分で入力する / 自分で選び直す
  //   数値カテゴリ (rent/age/area_min/walk) → LINE内テキスト入力フロー
  //   multi-select カテゴリ (layouts/structures/equipment) → LIFFの該当セクションへ遷移
  if (category === 'layouts' || category === 'structures' || category === 'equipment') {
    var liffBase2 = 'https://liff.line.me/' + LIFF_ID
      + '?action=selectCriteria&userId=' + encodeURIComponent(userId);
    footerButtons.push({
      type: 'button', style: 'secondary', height: 'sm',
      action: { type: 'uri', label: '自分で選び直す', uri: liffBase2 + '&focus=' + category }
    });
  } else {
    footerButtons.push({
      type: 'button', style: 'secondary', height: 'sm',
      action: {
        type: 'postback',
        label: '自分で入力する',
        data: 'condsug:input:' + category,
        displayText: '自分で入力する'
      }
    });
  }

  // body のプロンプト文 (multi-select 用にも対応)
  var promptText = cfg.promptText || 'いくつに変更しますか？';

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
          { type: 'text', text: promptText, size: 'sm', color: '#555555', margin: 'md', wrap: true }
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
  // G(7):徒歩 H(8):賃料 I(9):間取り J(10):面積 K(11):築年 L(12):構造 M(13):設備
  var colMap = { rent: 8, age: 11, area_min: 10, walk: 7, layouts: 9, structures: 12, equipment: 13 };
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

  // 既存シートの書き込み慣例に合わせる:
  //   K列(築年数): "20年以内" / 指定なしなら "指定しない"
  //   H列(賃料), G列(徒歩), J列(面積): 数字のみ / 指定なしなら "指定しない"
  //   I列(間取り), L列(構造): カンマ区切り(ない場合は空白 or "指定しない")
  var rawValue = (newValue === undefined || newValue === null || newValue === '') ? '' : String(newValue);
  var sheetValue;
  if (rawValue === '') {
    sheetValue = '指定しない';
  } else if (category === 'age') {
    sheetValue = rawValue + '年以内';
  } else if (category === 'layouts' || category === 'structures' || category === 'equipment') {
    // カンマ区切りに整形 (空要素除去)
    var items = rawValue.split(/[,、]/).map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    sheetValue = items.join(', ');
    if (!sheetValue) sheetValue = '指定しない';
  } else {
    sheetValue = rawValue;
  }
  sheet.getRange(targetRowIndex, col).setValue(sheetValue);

  // 確認テキスト用
  var labels = {
    rent: { name: '家賃の上限', suffix: '万円' },
    age: { name: '築年数', suffix: '年以内' },
    area_min: { name: '専有面積', suffix: 'm² 以上' },
    walk: { name: '駅徒歩', suffix: '分以内' },
    layouts: { name: '間取り', suffix: '' },
    structures: { name: '建物構造', suffix: '' },
    equipment: { name: 'こだわり条件', suffix: '' }
  };
  var info = labels[category];
  var changedText;
  if (rawValue === '') {
    changedText = '指定なし';
  } else if (category === 'layouts' || category === 'structures' || category === 'equipment') {
    changedText = sheetValue; // カンマ区切りリストそのまま
  } else {
    changedText = rawValue + info.suffix;
  }
  var msg = '✅ ' + info.name + 'を ' + changedText + ' に変更しました。\n次の検索から反映されます。';
  replyMessage(replyToken, [{ type: 'text', text: msg }]);
}
