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
    try {
      var debugSheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('debug_log');
      if (!debugSheet) debugSheet = SpreadsheetApp.openById(SPREADSHEET_ID).insertSheet('debug_log');
      debugSheet.appendRow([new Date(), 'replyMessage ERROR', code, body, JSON.stringify(messages).substring(0, 1000)]);
    } catch(e2) {}
    throw new Error('LINE reply failed: ' + code + ' ' + body);
  }
}

/**
 * Push メッセージを送信する（オペレーター承認後のLINE通知用）。
 * @param {string} userId - LINE userId
 * @param {Object[]} messages - メッセージオブジェクトの配列（最大5件）
 */
function pushMessage(userId, messages, options) {
  if (isDryRun_()) {
    Logger.log('[DRY_RUN] pushMessage to ' + userId + ': ' + JSON.stringify(messages));
    return;
  }
  var body = {
    to: userId,
    messages: messages
  };
  // options.silent = true で通知音・バイブレーションを無効化
  if (options && options.silent) {
    body.notificationDisabled = true;
  }
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