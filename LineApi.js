/**
 * LineApi.gs - LINE Messaging API ラッパー
 */

/**
 * Reply メッセージを送信する。
 * @param {string} replyToken - LINE replyToken
 * @param {Object[]} messages - メッセージオブジェクトの配列（最大5件）
 */
/** DRY_RUN: スクリプトプロパティで切り替え。GASエディタ→プロジェクトの設定→DRY_RUN を "true"/"false" に設定 */
function isDryRun_() {
  return PropertiesService.getScriptProperties().getProperty('DRY_RUN') === 'true';
}

function replyMessage(replyToken, messages) {
  if (isDryRun_()) {
    Logger.log('[DRY_RUN] replyMessage: ' + JSON.stringify(messages));
    return;
  }
  if (typeof _addFetchCount_ === 'function') _addFetchCount_('LINE返信', 1);
  var resp = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN
    },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: messages
    }),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code !== 200) {
    var body = resp.getContentText();
    throw new Error('LINE reply failed: ' + code + ' ' + body);
  }
}

/**
 * Push メッセージを送信する（オペレーター承認後のLINE通知用）。
 * @param {string} userId - LINE userId
 * @param {Object[]} messages - メッセージオブジェクトの配列（最大5件）
 */
function pushMessage(userId, messages, options) {
  // 送信先IDの検証(空・admin_プレースホルダー＝LINE未連携 を弾いて、分かりやすいエラーにする)
  //   これをしないと LINE API が cryptic な 400「'to' is invalid」を返す。
  var to = String(userId || '').trim();
  if (!to || to.indexOf('admin_') === 0) {
    throw new Error('LINE未連携のため送信できません(送信先ID: "' + userId + '")。LINE Usersシートで正しいユーザーID(U…)を登録してください。');
  }
  if (isDryRun_()) {
    Logger.log('[DRY_RUN] pushMessage to ' + to + ': ' + JSON.stringify(messages));
    return;
  }
  var body = {
    to: to,
    messages: messages
  };
  // options.silent = true で通知音・バイブレーションを無効化
  if (options && options.silent) {
    body.notificationDisabled = true;
  }
  if (typeof _addFetchCount_ === 'function') _addFetchCount_('LINE送信', 1);
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN
    },
    payload: JSON.stringify(body)
  });
}

/**
 * フォロワー（友だち）の userId 一覧を取得する。
 * ページネーション対応。最大 1000 件ずつ返る。
 * @param {number} [limit] - 最大取得件数（デフォルト: 300）
 * @return {string[]} userId の配列
 */
function getFollowerIds(limit) {
  limit = limit || 300;
  var allIds = [];
  var start = undefined;

  while (allIds.length < limit) {
    var url = 'https://api.line.me/v2/bot/followers/ids?limit=300';
    if (start) url += '&start=' + start;

    var res = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN },
      muteHttpExceptions: true
    });

    if (res.getResponseCode() !== 200) {
      console.error('getFollowerIds error: ' + res.getContentText());
      break;
    }

    var data = JSON.parse(res.getContentText());
    var ids = data.userIds || [];
    allIds = allIds.concat(ids);

    if (!data.next || ids.length === 0) break;
    start = data.next;
  }

  return allIds.slice(0, limit);
}

/**
 * LINE ユーザーのプロフィール情報を取得する。
 * @param {string} userId - LINE userId
 * @return {Object|null} { displayName, pictureUrl, statusMessage } or null
 */
function getLineProfile(userId) {
  try {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/' + userId, {
      headers: { 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    return JSON.parse(res.getContentText());
  } catch (e) {
    console.error('getLineProfile error: ' + e.message);
    return null;
  }
}

/**
 * LINE ユーザーがボットをブロックしているかを判定する。
 * getProfile API のレスポンスコードで判定:
 *   200 → 友だち登録中 (ブロックされていない)
 *   403/404 → ブロック / 友だち削除
 *   その他 → 不明 (ネットワーク等の一時障害扱い)
 *
 * Push メッセージではないので API コストは発生しない。
 *
 * @param {string} userId - LINE userId
 * @returns {boolean|null} true=ブロック中, false=ブロックされてない, null=不明
 */
function checkLineBlocked(userId) {
  if (!userId) return null;
  try {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/' + userId, {
      headers: { 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN },
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code === 200) return false;
    if (code === 403 || code === 404) return true;
    return null;
  } catch (e) {
    console.error('checkLineBlocked error: ' + e.message);
    return null;
  }
}

/**
 * 複数 userId の LINE ブロック状態を並列で判定する (UrlFetchApp.fetchAll 使用)。
 *
 * UrlFetchApp.fetchAll は同時並列上限が 100 件なので、 100 件超は自動で
 * チャンク分割する。
 *
 * @param {string[]} userIds - LINE userId 配列
 * @returns {Object} { userId: true/false/null, ... }
 *   true=ブロック中, false=ブロックされてない, null=判定不能 (一時障害等)
 */
function bulkCheckLineBlocked(userIds) {
  var result = {};
  if (!userIds || userIds.length === 0) return result;

  var CHUNK_SIZE = 100; // fetchAll 並列上限
  for (var ci = 0; ci < userIds.length; ci += CHUNK_SIZE) {
    var chunk = userIds.slice(ci, ci + CHUNK_SIZE);
    var requests = chunk.map(function(uid) {
      return {
        url: 'https://api.line.me/v2/bot/profile/' + uid,
        method: 'get',
        headers: { 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN },
        muteHttpExceptions: true
      };
    });
    var responses;
    try {
      // fetchAll も1件ずつ回数に数えられる。ここが一番効くので必ず記録する。
      if (typeof _addFetchCount_ === 'function') _addFetchCount_('LINEブロック判定', requests.length);
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      console.error('bulkCheckLineBlocked fetchAll error: ' + e.message);
      // チャンク全体を null (判定不能) として返す
      for (var ki = 0; ki < chunk.length; ki++) result[chunk[ki]] = null;
      continue;
    }
    for (var ri = 0; ri < responses.length; ri++) {
      var code = responses[ri].getResponseCode();
      var uid2 = chunk[ri];
      if (code === 200) result[uid2] = false;
      else if (code === 403 || code === 404) result[uid2] = true;
      else result[uid2] = null;
    }
  }
  return result;
}

/**
 * テキストメッセージを作成する。
 * @param {string} text - 送信テキスト
 * @return {Object} LINE text message object
 */
function textMsg(text) {
  return { type: 'text', text: text };
}

/**
 * Quick Reply 付きテキストメッセージを作成する。
 * @param {string} text - 送信テキスト
 * @param {Object[]} items - Quick Reply items
 * @return {Object} LINE text message object with quickReply
 */
function textMsgWithQuickReply(text, items) {
  return {
    type: 'text',
    text: text,
    quickReply: { items: items }
  };
}

/**
 * Postback Quick Reply アイテムを作成する。
 * @param {string} label - ボタンラベル（最大20文字）
 * @param {string} data - postback data
 * @param {string} [displayText] - タップ時に表示されるテキスト
 * @return {Object} Quick Reply item
 */
function qrPostback(label, data, displayText) {
  return {
    type: 'action',
    action: {
      type: 'postback',
      label: label,
      data: data,
      displayText: displayText || label
    }
  };
}

/**
 * Message Quick Reply アイテムを作成する。
 * @param {string} label - ボタンラベル（最大20文字）
 * @param {string} [text] - 送信テキスト（省略時はlabelと同じ）
 * @return {Object} Quick Reply item
 */
function qrMessage(label, text) {
  return {
    type: 'action',
    action: {
      type: 'message',
      label: label,
      text: text || label
    }
  };
}

/**
 * Datetimepicker Quick Reply アイテムを作成する。
 * @param {string} label - ボタンラベル（最大20文字）
 * @param {string} data - postback data
 * @param {string} mode - 'date' | 'time' | 'datetime'
 * @param {string} [initial] - 初期値（YYYY-MM-DD形式）
 * @param {string} [min] - 最小値
 * @param {string} [max] - 最大値
 * @return {Object} Quick Reply item
 */
function qrDatepicker(label, data, mode, initial, min, max) {
  var action = {
    type: 'datetimepicker',
    label: label,
    data: data,
    mode: mode || 'date'
  };
  if (initial) action.initial = initial;
  if (min) action.min = min;
  if (max) action.max = max;
  return { type: 'action', action: action };
}

/**
 * 確認画面用 Flex Message を構築する。
 * Quick Reply ではなくインラインボタンを使用し、
 * スクロールしなくてもボタンが見えるようにする。
 * @param {string} details - 条件の詳細テキスト
 * @param {boolean} [isEdit] - 条件変更モードの場合 true
 * @return {Object} LINE Flex Message object
 */
function buildConfirmFlex(details, isEdit) {
  var headerText = isEdit ? '以下の条件に変更します。' : '以下の条件で登録します。';
  var altText = isEdit ? '以下の条件に変更します' : '以下の条件で登録します';
  var buttonLabel = isEdit ? '変更を保存' : '登録する';

  return {
    type: 'flex',
    altText: altText,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: headerText, weight: 'bold', size: 'lg', wrap: true },
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: details.trim(), wrap: true, size: 'sm', margin: 'lg', color: '#333333' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#6ea814',
            action: { type: 'postback', label: buttonLabel, data: 'confirm_ok', displayText: buttonLabel }
          },
          {
            type: 'button',
            style: 'link',
            action: { type: 'postback', label: '◀ 戻る', data: 'action=back', displayText: '戻る' }
          }
        ]
      }
    }
  };
}
// ═══════════════════════════════════════════════════════════
//  LINEの表示名（ニックネーム）
//
//  なぜ要るか（2026-09-21 実測）:
//    chat.line.biz（公式アカウントマネージャー）が画面に出している userId は、
//    webhook で飛んでくる userId とは**別体系**だった。同じ人でも値が違う。
//    管理画面のAPI (/api/v1/bots/{bot}/chats/{chat}) の profile.userId まで
//    画面のIDで、本物の背番号はどこにも出てこない。
//    そのため「背番号で顧客名を引く」ことはできない。
//
//    残る鍵は、画面に見えている文字そのもの ＝ LINEのニックネーム。
//    こちらは getProfile で取れるので、シートに控えておいて照合する。
//
//  ⚠️ ニックネームは重複する。取り違えるくらいなら改名しないほうがいいので、
//    同じ名前が2人以上いたらその名前は表から落とすこと。
// ═══════════════════════════════════════════════════════════

var LINE_DISPLAY_NAME_COL = 4;   // LINE Users の D列

/**
 * 【GASエディタで実行 / 日次トリガー】LINE Users の「LINEの表示名」列を埋める。
 * 空欄の人だけ取りに行く。全員取り直したいときは refreshLineDisplayNames({all:true})。
 * getProfile は送信通数に数えられない。ブロック中の人は空欄のままにする。
 */
function refreshLineDisplayNames(opts) {
  opts = opts || {};
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(LINE_USERS_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return { ok: false, message: 'LINE Users が空です' };

  if (String(sh.getRange(1, LINE_DISPLAY_NAME_COL).getValue() || '').trim() === '') {
    sh.getRange(1, LINE_DISPLAY_NAME_COL).setValue('LINEの表示名');
  }

  var n = sh.getLastRow() - 1;
  var rows = sh.getRange(2, 1, n, LINE_DISPLAY_NAME_COL).getValues();
  var targets = [];
  for (var i = 0; i < n; i++) {
    var uid = String(rows[i][0] || '').trim();
    if (!uid) continue;
    if (!opts.all && String(rows[i][LINE_DISPLAY_NAME_COL - 1] || '').trim()) continue;
    targets.push({ row: i, uid: uid });
  }
  if (!targets.length) {
    console.log('[LINE表示名] 取りに行く人はいません');
    return { ok: true, fetched: 0, filled: 0 };
  }

  var filled = 0;
  var CHUNK = 100;   // fetchAll の並列上限
  for (var c = 0; c < targets.length; c += CHUNK) {
    var chunk = targets.slice(c, c + CHUNK);
    var requests = chunk.map(function (t) {
      return {
        url: 'https://api.line.me/v2/bot/profile/' + t.uid,
        method: 'get',
        headers: { 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN },
        muteHttpExceptions: true
      };
    });
    if (typeof _addFetchCount_ === 'function') _addFetchCount_('LINE表示名の取得', requests.length);
    var responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      console.error('[LINE表示名] fetchAll 失敗: ' + e.message);
      continue;
    }
    for (var r = 0; r < responses.length; r++) {
      if (responses[r].getResponseCode() !== 200) continue;   // ブロック等は空欄のまま
      var name = '';
      try { name = String(JSON.parse(responses[r].getContentText()).displayName || '').trim(); } catch (_e) {}
      if (!name) continue;
      rows[chunk[r].row][LINE_DISPLAY_NAME_COL - 1] = name;
      filled++;
    }
  }

  // 1回で書き戻す（1行ずつ書くとシートが遅い）
  var col = [];
  for (var w = 0; w < n; w++) col.push([rows[w][LINE_DISPLAY_NAME_COL - 1]]);
  sh.getRange(2, LINE_DISPLAY_NAME_COL, n, 1).setValues(col);

  console.log('[LINE表示名] ' + targets.length + '人に問い合わせ / ' + filled + '人を記録');
  return { ok: true, fetched: targets.length, filled: filled };
}

/**
 * LINEの表示名 → 顧客名 の対応表。
 * ⚠️ 同じ表示名が2人以上いたら、その名前は入れない（別人の名前を付けてしまうため）。
 * @return {{map:Object, skipped:Array<string>}}
 */
function getLineChatNameMap() {
  var out = { map: {}, skipped: [] };
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(LINE_USERS_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return out;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, LINE_DISPLAY_NAME_COL).getValues();

  var count = {};
  var pick = {};
  for (var i = 0; i < rows.length; i++) {
    var shown = String(rows[i][LINE_DISPLAY_NAME_COL - 1] || '').trim();
    var customer = String(rows[i][1] || '').trim();
    if (!shown || !customer) continue;
    count[shown] = (count[shown] || 0) + 1;
    if (count[shown] === 1) pick[shown] = customer;
    else if (pick[shown] !== customer) pick[shown] = null;   // 別人同士 → 使わない
  }
  for (var k in pick) {
    if (pick[k]) out.map[k] = pick[k];
    else out.skipped.push(k);
  }
  return out;
}
