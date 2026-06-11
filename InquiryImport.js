/**
 * InquiryImport.gs - SUUMO(リクルートJDS)の反響お知らせメールを取り込み、
 *                    「問い合わせ」シートに記録する。顧客管理ページに一覧表示。
 *
 * 取り込み元: GmailApp（このスクリプト所有アカウントのメールボックス）
 *   - 件名「[リクルートＪＤＳ]反響お知らせメール」を検索して本文を解析
 *   - 「連番」を一意キーとして重複取り込みを防ぐ
 *
 * 注意: GmailApp を使うため、初回は Apps Script エディタで importSuumoInquiries() を
 *       手動実行して Gmail 権限を承認する必要がある。
 */

var INQUIRY_SHEET_NAME = '問い合わせ';
var INQUIRY_HEADERS = [
  '受信日時',      // A
  '連番',          // B (一意キー)
  '問い合わせ者名', // C
  'カナ',          // D
  'メール',        // E
  'TEL',           // F
  '連絡方法',      // G
  'お問合せ内容',  // H
  '物件名',        // I
  '物件コード',    // J
  '賃料',          // K
  '間取り',        // L
  '専有面積',      // M
  '最寄り駅',      // N
  '所在地',        // O
  '物件詳細URL',   // P
  '媒体',          // Q
  '対応状況',      // R (未対応/対応中/対応済み)
  '対応メモ',      // S
  'GmailID'        // T (トレース用)
];

/** 「問い合わせ」シートを取得（無ければ作成） */
function _getInquirySheet_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(INQUIRY_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(INQUIRY_SHEET_NAME);
    sheet.appendRow(INQUIRY_HEADERS);
    try {
      sheet.getRange(1, 1, 1, INQUIRY_HEADERS.length).setFontWeight('bold').setBackground('#e0e0e0');
      sheet.setFrozenRows(1);
    } catch (e) {}
  }
  return sheet;
}

/** 本文からラベルに対応する値を抽出（全角/半角コロン・空白区切りの両対応、行頭アンカー）
 *  転送メール対策: 行頭の引用記号(>｜|)や空白も許容する。 */
function _exVal_(body, label) {
  var esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var lead = '(?:^|[\\r\\n])[ \\t　>｜|]*'; // 行頭 + 任意の引用記号/空白
  // ラベル：値 （コロン区切り）
  var m = body.match(new RegExp(lead + esc + '[ \\t　]*[:：][ \\t　]*([^\\r\\n]*)'));
  if (m) return (m[1] || '').trim();
  // ラベル　値 （空白区切り。反響到着日時 など）
  m = body.match(new RegExp(lead + esc + '[ \\t　]+([^\\r\\n]*)'));
  return m ? (m[1] || '').trim() : '';
}

/**
 * 反響お知らせメール本文を解析して問い合わせオブジェクトを返す。
 * 連番が取れない場合は null（対象外メール）。
 */
function _parseSuumoInquiryEmail_(subject, body, fallbackDate) {
  if (!body) return null;
  var renban = _exVal_(body, '連番');
  if (!renban) return null; // 反響メールでなければ連番が無い

  // 受信日時: 反響到着日時 → お問合せ日時 → Gmail受信日時
  var dateStr = _exVal_(body, '反響到着日時') || _exVal_(body, 'お問合せ日時');
  var receivedAt = null;
  if (dateStr) {
    var d = new Date(dateStr.replace(/-/g, '/'));
    if (!isNaN(d.getTime())) receivedAt = d;
  }
  if (!receivedAt) receivedAt = (fallbackDate instanceof Date) ? fallbackDate : new Date();

  return {
    receivedAt: receivedAt,
    renban: renban,
    name: _exVal_(body, '名前（漢字）') || _exVal_(body, '名前(漢字)'),
    kana: _exVal_(body, '名前（カナ）') || _exVal_(body, '名前(カナ)'),
    email: _exVal_(body, 'メールアドレス'),
    tel: _exVal_(body, 'ＴＥＬ') || _exVal_(body, 'TEL'),
    contactMethod: _exVal_(body, '連絡方法'),
    message: _exVal_(body, 'お問合せ内容'),
    propertyName: _exVal_(body, '物件名'),
    propertyCode: _exVal_(body, '物件コード'),
    rent: _exVal_(body, '賃料'),
    layout: _exVal_(body, '間取り'),
    area: _exVal_(body, '専有面積'),
    station: _exVal_(body, '最寄り駅'),
    address: _exVal_(body, '所在地'),
    detailUrl: _exVal_(body, '物件詳細画面') || _exVal_(body, '物件詳細URL'),
    channel: _exVal_(body, 'お問合せ企画') || 'SUUMO'
  };
}

/**
 * Gmail から反響お知らせメールを取り込み、「問い合わせ」シートへ追記する。
 * 時間トリガー & 手動ボタンの両方から呼ばれる。
 * @return {Object} { imported, skipped, scanned }
 */
function importSuumoInquiries() {
  var sheet = _getInquirySheet_();

  // 既存の連番セット（重複防止）
  var existing = {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var renbanCol = sheet.getRange(2, 2, lastRow - 1, 1).getValues(); // B列
    for (var i = 0; i < renbanCol.length; i++) {
      var rb = String(renbanCol[i][0] || '').trim();
      if (rb) existing[rb] = true;
    }
  }

  // 件名で検索（直近90日）
  var threads = GmailApp.search('subject:反響お知らせメール newer_than:90d');
  var imported = 0, skipped = 0, scanned = 0;
  var newRows = [];

  for (var t = 0; t < threads.length; t++) {
    var msgs = threads[t].getMessages();
    for (var m = 0; m < msgs.length; m++) {
      var msg = msgs[m];
      var subject = msg.getSubject() || '';
      if (subject.indexOf('反響お知らせメール') === -1) continue;
      scanned++;
      var info = _parseSuumoInquiryEmail_(subject, msg.getPlainBody(), msg.getDate());
      if (!info || !info.renban) { continue; }
      if (existing[info.renban]) { skipped++; continue; }
      existing[info.renban] = true; // 同一バッチ内の重複も防ぐ

      newRows.push([
        info.receivedAt,
        info.renban,
        info.name,
        info.kana,
        info.email,
        info.tel,
        info.contactMethod,
        info.message,
        info.propertyName,
        info.propertyCode,
        info.rent,
        info.layout,
        info.area,
        info.station,
        info.address,
        info.detailUrl,
        info.channel,
        '未対応',
        '',
        msg.getId()
      ]);
      imported++;
    }
  }

  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, INQUIRY_HEADERS.length).setValues(newRows);
  }

  console.log('[問い合わせ取込] scanned=' + scanned + ' imported=' + imported + ' skipped=' + skipped);
  return { imported: imported, skipped: skipped, scanned: scanned };
}

/**
 * 顧客管理ページ用: 問い合わせ一覧を新しい順で返す。
 * @return {Object[]}
 */
function getInquiries() {
  var sheet = _getInquirySheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  var data = sheet.getRange(2, 1, lastRow - 1, INQUIRY_HEADERS.length).getValues();
  var tz = 'Asia/Tokyo';
  var list = [];
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (!String(r[1] || '').trim()) continue; // 連番なし行はスキップ
    var recv = r[0];
    var recvStr = (recv instanceof Date) ? Utilities.formatDate(recv, tz, 'yyyy/MM/dd HH:mm') : String(recv || '');
    var recvTs = (recv instanceof Date) ? recv.getTime() : (new Date(String(recv)).getTime() || 0);
    list.push({
      rowIndex: i + 2,
      receivedAt: recvStr,
      ts: recvTs,
      renban: String(r[1] || ''),
      name: String(r[2] || ''),
      kana: String(r[3] || ''),
      email: String(r[4] || ''),
      tel: String(r[5] || ''),
      contactMethod: String(r[6] || ''),
      message: String(r[7] || ''),
      propertyName: String(r[8] || ''),
      propertyCode: String(r[9] || ''),
      rent: String(r[10] || ''),
      layout: String(r[11] || ''),
      area: String(r[12] || ''),
      station: String(r[13] || ''),
      address: String(r[14] || ''),
      detailUrl: String(r[15] || ''),
      channel: String(r[16] || ''),
      status: String(r[17] || '未対応'),
      memo: String(r[18] || '')
    });
  }
  list.sort(function(a, b) { return b.ts - a.ts; });
  return list;
}

/**
 * 問い合わせの対応状況・メモを更新する（連番＋行番号で照合）。
 */
function updateInquiryStatus(rowNum, renban, status, memo) {
  var sheet = _getInquirySheet_();
  var rowRenban = String(sheet.getRange(rowNum, 2).getValue() || '').trim();
  if (rowRenban !== String(renban).trim()) {
    return { success: false, message: '行が一致しません（再読み込みしてください）' };
  }
  if (status) sheet.getRange(rowNum, 18).setValue(status);  // R: 対応状況
  if (memo !== undefined && memo !== null) sheet.getRange(rowNum, 19).setValue(memo); // S: 対応メモ
  return { success: true };
}

/** 時間トリガーを設置（5分毎）。一度だけ実行すればよい。 */
function installInquiryImportTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'importSuumoInquiries') {
      return { ok: true, message: '既にトリガーが設置されています' };
    }
  }
  ScriptApp.newTrigger('importSuumoInquiries')
    .timeBased()
    .everyMinutes(5)
    .create();
  return { ok: true, message: 'トリガーを設置しました（5分毎）' };
}

/** 時間トリガーを削除 */
function removeInquiryImportTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'importSuumoInquiries') {
      ScriptApp.deleteTrigger(existing[i]);
      removed++;
    }
  }
  return { ok: true, removed: removed };
}

/**
 * 診断用: 取り込みが動くか確認する。Apps Scriptエディタで実行してログを見る。
 *  - threadCount=0 なら、Gmailに反響メールが届いていない（転送/フィルタ/件名を確認）
 *  - messages>0 だが sample.parseFailed=true なら、解析に失敗（本文の形式が違う→bodyHeadを共有してください）
 *  - sample に renban/name/物件名 が入っていれば取り込みOK
 * @return {Object}
 */
function testInquiryImport() {
  var out = { query: 'subject:反響お知らせメール newer_than:90d', threadCount: 0, messages: 0, sample: null };
  try {
    var threads = GmailApp.search(out.query);
    out.threadCount = threads.length;
    for (var t = 0; t < threads.length && !out.sample; t++) {
      var msgs = threads[t].getMessages();
      for (var m = 0; m < msgs.length; m++) {
        var msg = msgs[m];
        if ((msg.getSubject() || '').indexOf('反響お知らせメール') === -1) continue;
        out.messages++;
        if (!out.sample) {
          var body = msg.getPlainBody() || '';
          var info = _parseSuumoInquiryEmail_(msg.getSubject(), body, msg.getDate());
          if (info && info.renban) {
            out.sample = {
              renban: info.renban, name: info.name, kana: info.kana,
              propertyName: info.propertyName, propertyCode: info.propertyCode,
              rent: info.rent, layout: info.layout, area: info.area,
              tel: info.tel, email: info.email, contactMethod: info.contactMethod,
              message: info.message, detailUrl: info.detailUrl,
              channel: info.channel, receivedAt: String(info.receivedAt)
            };
          } else {
            out.sample = { parseFailed: true, subject: msg.getSubject(), bodyHead: body.substring(0, 500) };
          }
        }
      }
    }
  } catch (e) {
    out.error = e.message;
  }
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}
