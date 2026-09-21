/**
 * RichMenu.gs - リッチメニューの2段階化（登録前 / 登録後）
 *
 * 画像は公開ページ（form.ehomaki.com/richmenu/）に置き、GAS が取ってきて LINE に上げる。
 *   登録前: menu_before.png (2500x843)  … 空室確認 / 条件を登録
 *   登録後: menu_after.png  (2500x1686) … 空室確認 / 条件を変える / お気に入り / 配信の停止・再開 / 使い方 / お部屋マップ
 *   挨拶用: greeting.png    (1040x1040) … 「どっち？」の案内（使い方でも出す）
 *
 * 使い方（GASエディタ・RichMenu.gs）
 *   1. setupRichMenus()                     … 2枚を作って画像を上げ、登録前を既定にする。ID はスクリプトプロパティに保存
 *   2. bulkLinkRegisteredUsersToAfterMenu() … 今いる条件登録済みの人を登録後メニューに切り替える
 *   以降は writeToSheet（条件登録の完了）で自動的に登録後へ切り替わる。
 *
 * 表示の優先順位（LINE仕様）: 個別リンク > API の既定 > 公式アカウントマネージャーの設定
 */

var RICHMENU_IMAGE_BASE = 'https://form.ehomaki.com/richmenu/';
var RICHMENU_GREETING_IMAGE = RICHMENU_IMAGE_BASE + 'greeting.png';
// お部屋マップの見本（ピンが並んだ地図のスクリーンショット）。カードの上に出す。
var RICHMENU_MAP_PREVIEW_IMAGE = RICHMENU_IMAGE_BASE + 'map_preview.jpg';
var RICHMENU_PROP_BEFORE = 'RICHMENU_BEFORE_ID';
var RICHMENU_PROP_AFTER = 'RICHMENU_AFTER_ID';
var RICHMENU_NAME_BEFORE = 'ehomaki 登録前';
var RICHMENU_NAME_AFTER = 'ehomaki 登録後';

// お部屋マップを「押した瞬間に開く」ための LIFF 設定（LINE Developers）。
//   liffId        … LIFF アプリの ID（例 '2001234567-AbCdEfGh'）。docs/map.html の MAP_LIFF_ID と同じ値にする
//   loginChannelId… LIFF を置いた LINEログインチャネルのチャネルID（IDトークンの検証に使う）
// 空のあいだは、メニューを押すとボットがリンクを返す。設定したら setupRichMenus() をもう一度実行する。
var MAP_LIFF_CONFIG = { liffId: '', loginChannelId: '' };

function _richMenuFetch_(url, method, payload, contentType) {
  var opt = {
    method: method,
    headers: { 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN },
    muteHttpExceptions: true
  };
  if (payload != null) {
    opt.contentType = contentType || 'application/json';
    opt.payload = (contentType && contentType !== 'application/json') ? payload : JSON.stringify(payload);
  }
  if (typeof _addFetchCount_ === 'function') _addFetchCount_('リッチメニュー', 1);
  var res = UrlFetchApp.fetch(url, opt);
  var code = res.getResponseCode();
  var body = res.getContentText() || '';
  var json = null;
  try { json = body ? JSON.parse(body) : null; } catch (_) {}
  return { ok: code >= 200 && code < 300, code: code, body: body, json: json };
}

function _richMenuDef_(kind) {
  var msg = function (text) { return { type: 'message', label: text, text: text }; };
  if (kind === 'before') {
    return {
      size: { width: 2500, height: 843 },
      // 登録前は開いたまま。初めて来た人にメニューの存在を知ってもらう必要がある。
      // 枠は2つ（空室確認／条件を登録）だけなので、見えていることに意味がある。
      selected: true,
      name: RICHMENU_NAME_BEFORE,
      chatBarText: 'メニュー',
      areas: [
        { bounds: { x: 0, y: 0, width: 1250, height: 843 }, action: msg('空室確認') },
        { bounds: { x: 1250, y: 0, width: 1250, height: 843 }, action: msg('条件登録') }
      ]
    };
  }
  // 3列×2行: 空室確認 / 条件を変える / お気に入り / 配信の停止・再開 / 使い方 / お部屋マップ
  // お部屋マップは LIFF が設定済みなら押した瞬間に開く(uri)。未設定ならボットがリンクを返す(message)。
  var mapAction = MAP_LIFF_CONFIG.liffId
    ? { type: 'uri', label: 'お部屋マップ', uri: 'https://liff.line.me/' + MAP_LIFF_CONFIG.liffId }
    : msg('お部屋マップ');
  var areas = [
    { bounds: { x: 0,    y: 0,   width: 833, height: 843 }, action: msg('空室確認') },
    { bounds: { x: 833,  y: 0,   width: 833, height: 843 }, action: msg('条件変更') },
    { bounds: { x: 1666, y: 0,   width: 834, height: 843 }, action: msg('お気に入り') },
    { bounds: { x: 0,    y: 843, width: 833, height: 843 }, action: msg('配信切替') },
    { bounds: { x: 833,  y: 843, width: 833, height: 843 }, action: msg('使い方') },
    { bounds: { x: 1666, y: 843, width: 834, height: 843 }, action: mapAction }
  ];
  // ⚠️ 登録後は閉じた状態で出す（selected: false / 2026-09-21）。
  //   この層には物件カードが届く。6枠は縦2段あって、開いていると画面の半分近くを占め、
  //   カルーセルが窮屈になる。メニューの存在はもう知っているので、閉じていて困らない。
  return { size: { width: 2500, height: 1686 }, selected: false, name: RICHMENU_NAME_AFTER, chatBarText: 'メニュー', areas: areas };
}

/** 【GASエディタから実行】リッチメニュー2枚を作り直して、登録前を既定にする。 */
function setupRichMenus() {
  var sp = PropertiesService.getScriptProperties();

  // 前に API で作った同名のメニューは消す（重複を残さない）
  var list = _richMenuFetch_('https://api.line.me/v2/bot/richmenu/list', 'get');
  var old = (list.json && list.json.richmenus) || [];
  for (var i = 0; i < old.length; i++) {
    if (old[i].name === RICHMENU_NAME_BEFORE || old[i].name === RICHMENU_NAME_AFTER) {
      var del = _richMenuFetch_('https://api.line.me/v2/bot/richmenu/' + old[i].richMenuId, 'delete');
      console.log('旧メニュー削除 ' + old[i].name + ' ' + old[i].richMenuId + ' → ' + del.code);
    }
  }

  var ids = {};
  var kinds = [['before', 'menu_before.png', RICHMENU_PROP_BEFORE], ['after', 'menu_after.png', RICHMENU_PROP_AFTER]];
  for (var k = 0; k < kinds.length; k++) {
    var kind = kinds[k][0];
    var created = _richMenuFetch_('https://api.line.me/v2/bot/richmenu', 'post', _richMenuDef_(kind));
    if (!created.ok) throw new Error('作成失敗(' + kind + '): ' + created.code + ' ' + created.body);
    var id = created.json.richMenuId;
    var img = UrlFetchApp.fetch(RICHMENU_IMAGE_BASE + kinds[k][1], { muteHttpExceptions: true });
    if (img.getResponseCode() !== 200) throw new Error('画像取得失敗: ' + kinds[k][1] + ' HTTP ' + img.getResponseCode());
    var up = _richMenuFetch_('https://api-data.line.me/v2/bot/richmenu/' + id + '/content', 'post', img.getBlob().getBytes(), 'image/png');
    if (!up.ok) throw new Error('画像アップロード失敗(' + kind + '): ' + up.code + ' ' + up.body);
    sp.setProperty(kinds[k][2], id);
    ids[kind] = id;
    console.log('作成 ' + kind + ': ' + id);
  }

  var def = _richMenuFetch_('https://api.line.me/v2/bot/user/all/richmenu/' + ids.before, 'post', {});
  if (!def.ok) throw new Error('既定メニュー設定失敗: ' + def.code + ' ' + def.body);
  console.log('既定メニュー = 登録前 (' + ids.before + ')');

  // ⚠️ ここで止めてはいけない。既定を「登録前」にした瞬間、条件登録済みの人も含めて
  //   全員が2枠のメニューになる。個別リンクを張り直すまでその状態が続くので、
  //   間を空けずに続けて実行する。
  bulkLinkRegisteredUsersToAfterMenu();
}

/** 条件登録が完了した人を登録後メニューへ。writeToSheet から呼ばれる。失敗しても登録は止めない。 */
function linkRichMenuAfter(userId) {
  try {
    if (!userId || String(userId).indexOf('U') !== 0) return;
    var id = PropertiesService.getScriptProperties().getProperty(RICHMENU_PROP_AFTER);
    if (!id) return;   // まだ setupRichMenus() をしていない
    var res = _richMenuFetch_('https://api.line.me/v2/bot/user/' + userId + '/richmenu/' + id, 'post', {});
    if (!res.ok) console.warn('[リッチメニュー] 登録後への切替失敗 ' + userId + ': ' + res.code + ' ' + res.body);
  } catch (e) {
    console.warn('[リッチメニュー] 切替で例外: ' + e.message);
  }
}

/**
 * 友だち追加（follow）のたびに、その人に合ったメニューを割り当て直す。
 *
 * ⚠️ LINEの仕様: ブロックしてから解除すると、その人に張った個別メニューは外れる。
 *   そのまま放っておくと、条件登録済みのお客様が既定の「登録前」(2枠)メニューに
 *   戻ってしまい、お気に入りもお部屋マップも押せなくなる。
 *   解除のときも follow イベントは届くので、ここで張り直す。
 */
function restoreRichMenuOnFollow(userId) {
  try {
    var registered = false;
    try { registered = !!readLatestCriteria(userId); } catch (_) {}
    if (!registered) return;   // 未登録の人は既定の「登録前」でよい
    linkRichMenuAfter(userId);
    console.log('[リッチメニュー] follow で登録後メニューを張り直し: ' + userId);
  } catch (e) {
    console.warn('[リッチメニュー] follow の張り直しで例外: ' + e.message);
  }
}

/** 【GASエディタから実行】今いる条件登録済みの人を一括で登録後メニューにする。 */
function bulkLinkRegisteredUsersToAfterMenu() {
  var id = PropertiesService.getScriptProperties().getProperty(RICHMENU_PROP_AFTER);
  if (!id) throw new Error('先に setupRichMenus() を実行してください');
  var names = _namesWithCriteria_();
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var lu = ss.getSheetByName(LINE_USERS_SHEET_NAME);
  var userIds = [];
  var seen = {};
  if (lu && lu.getLastRow() > 1) {
    var data = lu.getRange(2, 1, lu.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < data.length; i++) {
      var uid = String(data[i][0] || '').trim();
      var nm = String(data[i][1] || '').trim();
      if (uid.indexOf('U') === 0 && names[nm] && !seen[uid]) { seen[uid] = true; userIds.push(uid); }
    }
  }
  var okCount = 0;
  for (var s = 0; s < userIds.length; s += 500) {
    var chunk = userIds.slice(s, s + 500);
    var res = _richMenuFetch_('https://api.line.me/v2/bot/richmenu/bulk/link', 'post', { richMenuId: id, userIds: chunk });
    if (res.ok) okCount += chunk.length;
    else console.error('一括リンク失敗: ' + res.code + ' ' + res.body);
  }
  console.log('登録後メニューに切り替え: ' + okCount + ' / ' + userIds.length + ' 人');
}

/** 条件登録前の人への「使い方」= 挨拶と同じ「どっち？」画像。 */
function buildGreetingGuideMessages() {
  return [
    { type: 'image', originalContentUrl: RICHMENU_GREETING_IMAGE, previewImageUrl: RICHMENU_GREETING_IMAGE },
    textMsg('まずは下のメニューから、\n「空室確認」か「条件を登録」をタップしてください。')
  ];
}

/**
 * 「お部屋マップ」をタップ（LIFF 未設定のとき）。その人の地図リンクを返す。
 */
function handleMapCommand(replyToken, userId) {
  var name = _vacancyLineUserName_(userId);
  if (!name) {
    replyMessage(replyToken, [textMsg(
      'お部屋マップは、お部屋探しの条件を登録して物件をお送りしたあとにご覧いただけます。\n' +
      'まずは下のメニューの「条件を登録」からどうぞ。'
    )]);
    return;
  }
  var url = getCustomerMapUrl(name).url || '';
  replyMessage(replyToken, [{
    type: 'flex', altText: 'お部屋マップ',
    contents: {
      type: 'bubble',
      // 見本の画像を出す。「地図で見られる」と字で書くより、ピンが並んだ絵を1枚見せる方が早い。
      hero: {
        type: 'image', url: RICHMENU_MAP_PREVIEW_IMAGE,
        size: 'full', aspectRatio: '4:3', aspectMode: 'cover',
        action: { type: 'uri', label: '地図を開く', uri: url }
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'xl',
        contents: [
          { type: 'text', text: '🗺 お部屋マップ', weight: 'bold', size: 'md', color: '#333333' },
          { type: 'text', text: 'これまでにお送りしたお部屋を、地図でまとめて見られます。駅や建物名でも絞り込めます。',
            size: 'sm', color: '#555555', wrap: true, margin: 'md' }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: 'lg',
        contents: [{ type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
          action: { type: 'uri', label: '地図を開く', uri: url } }]
      }
    }
  }]);
}

/**
 * doGet: ?action=map_token_by_line&id_token=...
 * LIFF から届いた ID トークンを LINE で検証し、その人の地図トークンを返す。
 * userId は Messaging API と同じ（同じプロバイダー配下のチャネルなら一致する）。
 */
function handleMapTokenByLine(e) {
  var out = function (obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  };
  var idToken = String((e.parameter && e.parameter.id_token) || '');
  if (!idToken) return out({ ok: false, reason: 'no_token' });
  if (!MAP_LIFF_CONFIG.loginChannelId) return out({ ok: false, reason: 'not_configured' });
  try {
    if (typeof _addFetchCount_ === 'function') _addFetchCount_('LIFF検証', 1);
    var res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'post',
      payload: { id_token: idToken, client_id: MAP_LIFF_CONFIG.loginChannelId },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      console.warn('[お部屋マップ] IDトークン検証失敗: HTTP ' + res.getResponseCode() + ' ' + res.getContentText().substring(0, 200));
      return out({ ok: false, reason: 'invalid_token' });
    }
    var userId = String(JSON.parse(res.getContentText()).sub || '');
    var name = userId ? _vacancyLineUserName_(userId) : '';
    if (!name) return out({ ok: false, reason: 'not_registered' });
    return out({ ok: true, t: _customerMapToken_(name) });
  } catch (err) {
    console.error('[お部屋マップ] map_token_by_line: ' + err.message);
    return out({ ok: false, reason: 'error' });
  }
}
