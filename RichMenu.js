/**
 * RichMenu.gs - リッチメニューの2段階化（登録前 / 登録後）
 *
 * 画像は公開ページ（form.ehomaki.com/richmenu/）に置き、GAS が取ってきて LINE に上げる。
 *   登録前: menu_before.png (2500x843)  … 空室確認 / 条件を登録
 *   登録後: menu_after.png  (2500x1686) … 空室確認 / 条件を変える / お気に入り / 配信の停止・再開 / 使い方
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
var RICHMENU_PROP_BEFORE = 'RICHMENU_BEFORE_ID';
var RICHMENU_PROP_AFTER = 'RICHMENU_AFTER_ID';
var RICHMENU_NAME_BEFORE = 'ehomaki 登録前';
var RICHMENU_NAME_AFTER = 'ehomaki 登録後';

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
      selected: true,
      name: RICHMENU_NAME_BEFORE,
      chatBarText: 'メニュー',
      areas: [
        { bounds: { x: 0, y: 0, width: 1250, height: 843 }, action: msg('空室確認') },
        { bounds: { x: 1250, y: 0, width: 1250, height: 843 }, action: msg('条件登録') }
      ]
    };
  }
  // 上段3つ（空室確認 / 条件を変える / お気に入り）、下段2つ（配信の停止・再開 / 使い方）
  var areas = [
    { bounds: { x: 0,    y: 0,   width: 833,  height: 843 }, action: msg('空室確認') },
    { bounds: { x: 833,  y: 0,   width: 833,  height: 843 }, action: msg('条件変更') },
    { bounds: { x: 1666, y: 0,   width: 834,  height: 843 }, action: msg('お気に入り') },
    { bounds: { x: 0,    y: 843, width: 1250, height: 843 }, action: msg('配信切替') },
    { bounds: { x: 1250, y: 843, width: 1250, height: 843 }, action: msg('使い方') }
  ];
  return { size: { width: 2500, height: 1686 }, selected: true, name: RICHMENU_NAME_AFTER, chatBarText: 'メニュー', areas: areas };
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
  console.log('次に bulkLinkRegisteredUsersToAfterMenu() を実行して、条件登録済みの人を登録後メニューにしてください');
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
