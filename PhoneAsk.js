/**
 * PhoneAsk.gs — 条件を登録した人に「お電話で5分ほどお話しできますか」と送る
 *
 * 狙い（2026-09-29 ユーザー決定）:
 *   成約につながったのは、電話で話して温度感をつかめた人だった。30分かけて検索する前に、
 *   5分電話して条件を絞る。そのための最初の一声を、スタッフが書いたのと同じ文面で自動で送る。
 *   文面は実際に内見まで進んだ人（鈴木海渡さま 9/18）にユーザーが手で送ったものをそのまま使う。
 *
 * ⚠️ カードにしないこと。普通の文字のメッセージ1通にする（スタッフが送ったのと見分けがつかないように）。
 * ⚠️ 宛名と「担当の西村と申します」は付ける（人が書いたものとして送るため。ボットのカードの決まりとは別）。
 *   宛名は顧客名に空白があれば姓だけ、無ければそのまま。LINEのニックネームのままの人には付けない。
 * ⚠️ 返事はボットが答えないので「LINE要返信」に入り、樹形図の 🔴 LINEに返信 に出る。そこから電話する。
 *
 * 送る時刻: 登録から3分後。営業時間外（10時前・20時以降）に登録した人は、次の朝10:16。
 *   ⚠️ トリガーは5分おきなので、実際に届くのは3〜8分後。
 * 送らない: すでに送った人／終了・ブロック・配信停止の人／登録前後に電話で話せている人（担当者が代理登録した場合など）。
 */

var PHONE_ASK_SHEET = '電話のお願い';
var PHONE_ASK_ENABLED = false;       // false の間は予約だけして送らない
var PHONE_ASK_OPEN_H = 10;           // 営業時間の始まり
var PHONE_ASK_CLOSE_H = 20;          // 営業時間の終わり
var PHONE_ASK_SIGNER = '西村';

function _phoneAskSheet_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sh = ss.getSheetByName(PHONE_ASK_SHEET);
  if (!sh) {
    sh = ss.insertSheet(PHONE_ASK_SHEET);
    sh.appendRow(['顧客名', 'userId', '登録日時', '送る予定', '送った日時', '状態']);
    try { sh.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#e0e0e0'); sh.setFrozenRows(1); } catch (_) {}
  }
  return sh;
}

/** 送る予定の時刻。営業時間内なら3分後、外なら次の朝10:16（ユーザー決定 2026-09-29）。 */
function _phoneAskSendAt_(nowMs) {
  var now = new Date(nowMs);
  var h = (typeof getJstHour === 'function') ? getJstHour(now) : now.getHours();
  if (h >= PHONE_ASK_OPEN_H && h < PHONE_ASK_CLOSE_H) return new Date(nowMs + 3 * 60000);
  // 0〜9時台なら当日、20時以降なら翌日の 10:16
  var jst = new Date(nowMs + 9 * 3600000);
  var dayOffset = (h >= PHONE_ASK_CLOSE_H) ? 1 : 0;
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() + dayOffset, 10 - 9, 16, 0));
}

/**
 * 【SheetWriter.writeToSheet から呼ぶ】初めて条件を登録した人を予約する。一度きり。
 * ⚠️ 速さ優先。ここでは送らない（予約するだけ）。
 */
function enqueuePhoneAsk(customerName, userId) {
  customerName = String(customerName || '').trim();
  if (!customerName || !userId) return;
  var sh = _phoneAskSheet_();
  if (sh.getLastRow() > 1) {
    var names = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < names.length; i++) if (String(names[i][0] || '').trim() === customerName) return;
  }
  var now = Date.now();
  sh.appendRow([customerName, userId, new Date(now), _phoneAskSendAt_(now), '', '予約']);
  console.log('[電話のお願い] 予約: ' + customerName);
}

/** 宛名。空白があれば姓だけ。LINEのニックネームのままなら付けない（''）。 */
function _phoneAskDear_(customerName, userId) {
  var name = String(customerName || '').trim();
  if (!name) return '';
  try {
    var lu = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(LINE_USERS_SHEET_NAME);
    var rows = lu.getRange(2, 1, lu.getLastRow() - 1, 4).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0] || '').trim() !== String(userId)) continue;
      var disp = String(rows[i][3] || '').trim();   // D列: LINEの表示名
      if (disp && disp === name) return '';          // ニックネームのまま＝本名が分からない
    }
  } catch (_e) {}
  var parts = name.split(/[\s　]+/);
  return (parts.length > 1 ? parts[0] : name) + 'さま';
}

/** 送る文面（ユーザーが実際に手で送って内見につながったものをそのまま使う）。 */
function buildPhoneAskText(customerName, userId) {
  var dear = _phoneAskDear_(customerName, userId);
  return (dear ? dear + '、' : '') + 'お探しのご条件の詳細をいただきありがとうございます。\n\n'
    + '担当の' + PHONE_ASK_SIGNER + 'と申します。\n'
    + 'いただいておりますご条件を拝見しまして、お電話で5分程度お話をお伺いすることは可能でしょうか。\n\n'
    + '少しでもご希望に合った物件をお送りするために、もしよろしければご対応をいただけますと幸いです。\n'
    + '何卒、よろしくお願いいたします。';
}

/** 送らない方がよい人か（理由を返す。送ってよければ ''）。 */
function _phoneAskSkipReason_(customerName) {
  var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRITERIA_SHEET_NAME);
  var data = sh.getDataRange().getValues();
  var row = null;
  for (var i = 1; i < data.length; i++) if (String(data[i][1] || '').trim() === customerName) row = data[i];
  if (!row) return '顧客が見つからない';
  var st = String(row[18] || '').trim().toLowerCase();
  if (st === 'blocked' || st === 'paused' || st === 'auto_paused') return '配信停止・ブロック';
  if (String(row[32] || '').trim() === '終了') return '終了';
  // すでに電話で話せている（担当者の代理登録など）なら送らない
  try {
    var cl = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CONTACT_LOG_SHEET_NAME);
    if (cl && cl.getLastRow() > 1) {
      var logs = cl.getRange(2, 1, cl.getLastRow() - 1, 4).getValues();
      var since = Date.now() - 3 * 86400000;
      for (var j = 0; j < logs.length; j++) {
        if (String(logs[j][0] || '').trim() !== customerName) continue;
        if (_cellToEpochMs_(logs[j][1]) < since) continue;
        if (String(logs[j][2] || '').indexOf('電話') >= 0 && _contactLogOutcome_(logs[j][2], logs[j][3]) === 'talked') return '電話で話せている';
      }
    }
  } catch (_e) {}
  return '';
}

/** 【トリガー・5分おき】予定の時刻が来た人に送る。 */
function processPhoneAsk() {
  var sh = _phoneAskSheet_();
  if (sh.getLastRow() < 2) return;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues();
  var now = Date.now();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][5] || '').trim() !== '予約') continue;
    var at = rows[i][3];
    if (!(at instanceof Date) || at.getTime() > now) continue;
    var name = String(rows[i][0] || '').trim();
    var uid = String(rows[i][1] || '').trim();
    var skip = _phoneAskSkipReason_(name);
    if (skip) { sh.getRange(i + 2, 6).setValue('見送り（' + skip + '）'); continue; }
    if (!PHONE_ASK_ENABLED) { console.log('[電話のお願い] 送る時刻（まだ送りません）: ' + name); continue; }
    try {
      pushMessage(uid, [textMsg(buildPhoneAskText(name, uid))]);
      sh.getRange(i + 2, 5, 1, 2).setValues([[new Date(), '送った']]);
      console.log('[電話のお願い] 送りました: ' + name);
    } catch (e) {
      sh.getRange(i + 2, 6).setValue('送れず（' + e.message + '）');
    }
  }
}

/** 顧客名 → 送る予定の時刻（予約中の人だけ）。樹形図の「次の自動」に使う。 */
function _phoneAskPlanned_() {
  var out = {};
  try {
    var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(PHONE_ASK_SHEET);
    if (!sh || sh.getLastRow() < 2) return out;
    sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues().forEach(function (r) {
      if (String(r[5] || '').trim() === '予約' && r[3] instanceof Date) out[String(r[0] || '').trim()] = r[3].getTime();
    });
  } catch (_e) {}
  return out;
}

/** 【GASエディタで実行: PhoneAsk.gs】Hiroki に文面を送って見た目を確かめる。 */
function testSendPhoneAsk() {
  var uid = _moveInUserIds_()['Hiroki'];
  if (!uid) { console.log('Hiroki の LINE が見つかりません'); return; }
  pushMessage(uid, [textMsg(buildPhoneAskText('鈴木 海渡', uid))]);
  console.log('送りました（宛名は例として「鈴木 海渡」→「鈴木さま」）');
}
