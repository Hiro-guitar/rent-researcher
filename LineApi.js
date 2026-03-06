/**
 * LineApi.gs - LINE Messaging API ラッパー
 */

/**
 * Reply メッセージを送信する。
 * @param {string} replyToken - LINE replyToken
 * @param {Object[]} messages - メッセージオブジェクトの配列（最大5件）
 */
function replyMessage(replyToken, messages) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN
    },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: messages
    })
  });
}

/**
 * Push メッセージを送信する（オペレーター承認後のLINE通知用）。
 * @param {string} userId - LINE userId
 * @param {Object[]} messages - メッセージオブジェクトの配列（最大5件）
 */
function pushMessage(userId, messages) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN
    },
    payload: JSON.stringify({
      to: userId,
      messages: messages
    })
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
 * @return {Object} LINE Flex Message object
 */
function buildConfirmFlex(details) {
  return {
    type: 'flex',
    altText: '以下の条件で登録します',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '以下の条件で登録します。', weight: 'bold', size: 'lg', wrap: true },
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
            color: '#06C755',
            action: { type: 'postback', label: '登録する', data: 'confirm_ok', displayText: '登録する' }
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