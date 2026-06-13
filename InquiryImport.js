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

// 問い合わせ対応ログ（架電・メール送付などの記録）
var INQUIRY_LOG_SHEET_NAME = '問い合わせ対応ログ';
var INQUIRY_LOG_HEADERS = ['連番', '日時', '種別', '結果', 'メモ', '記録者'];

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

/** 「問い合わせ対応ログ」シートを取得（無ければ作成） */
function _getInquiryLogSheet_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(INQUIRY_LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(INQUIRY_LOG_SHEET_NAME);
    sheet.appendRow(INQUIRY_LOG_HEADERS);
    try {
      sheet.getRange(1, 1, 1, INQUIRY_LOG_HEADERS.length).setFontWeight('bold').setBackground('#e0e0e0');
      sheet.setFrozenRows(1);
      sheet.getRange('A:A').setNumberFormat('@'); // 連番をテキストで保持
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
/** 連番を重複判定用に正規化（空白除去＋先頭ゼロ除去）。
 *  シートに書くと先頭ゼロが消えて数値化されることがあるため、両側を揃えて照合する。 */
function _normRenban_(r) {
  var s = String(r == null ? '' : r).replace(/[\s　]/g, '');
  s = s.replace(/^0+/, '');
  return s;
}

/**
 * 問い合わせから自動でリード顧客を作る（メールで重複判定）。
 * 検索条件シートに status='lead', AF列(32)=メール, AG列(33)=stage'問い合わせ' を持つ行を追加。
 * 同じメールの顧客が既にいれば作らない（同名別人対策でメール優先）。メール無しは名前で判定。
 * （AE列=31=btMode は既存利用のため、stage は AG=33 を使う）
 */
function _autoCreateLeadFromInquiry_(info) {
  try {
    var name = String(info.name || '').trim();
    var email = String(info.email || '').trim();
    var emailKey = email.toLowerCase();
    if (!name && !email) return false;
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return false;
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var rowEmail = String(data[i][31] || '').trim().toLowerCase(); // AF列(32)=メール
      if (emailKey && rowEmail && rowEmail === emailKey) return false;      // メール一致 → 既存に紐付け（作らない）
      // メールが無い問い合わせのみ名前で判定（メールがあれば同姓同名の別人を取りこぼさないよう名前では判定しない）
      if (!emailKey && name && String(data[i][1] || '').trim() === name) return false;
    }
    // 新規リード作成
    var row = [];
    for (var c = 0; c < 19; c++) row.push('');
    row[0] = new Date();                 // A 登録日時
    row[1] = name || email || '名前なし'; // B 名前
    row[18] = 'lead';                    // S ステータス
    sheet.appendRow(row);
    var newRow = sheet.getLastRow();
    sheet.getRange(newRow, 32).setValue(email);        // AF(32): メール
    sheet.getRange(newRow, 33).setValue('問い合わせ'); // AG(33): 営業ステージ
    // 問い合わせ情報を対応ログに残す
    var parts = [];
    if (info.propertyName) parts.push('物件: ' + info.propertyName + (info.rent ? ' ' + info.rent : ''));
    if (email) parts.push('メール: ' + email);
    if (info.tel) parts.push('TEL: ' + info.tel);
    if (info.message) parts.push('内容: ' + info.message);
    try { addContactLog(row[1], 'SUUMO反響', Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'), parts.join(' / ')); } catch (eL) {}
    return true;
  } catch (e) {
    console.warn('[自動リード化] error: ' + e.message);
    return false;
  }
}

/**
 * 過去に取り込み済みの問い合わせを一括でリード化する（カンバン「問い合わせ」へ）。
 * 自動リード化機能の導入前に取り込んだ問い合わせを救済する用途。
 * メール（無ければ名前）で重複判定し、既存顧客は作らない。
 * @return {Object} { total, created, skipped }
 */
function backfillInquiryLeads() {
  var sheet = _getInquirySheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { total: 0, created: 0, skipped: 0 };
  var data = sheet.getRange(2, 1, lastRow - 1, INQUIRY_HEADERS.length).getValues();
  var created = 0;
  for (var i = 0; i < data.length; i++) {
    var info = {
      name: String(data[i][2] || '').trim(),         // C 問い合わせ者名
      email: String(data[i][4] || '').trim(),        // E メール
      tel: String(data[i][5] || '').trim(),          // F TEL
      message: String(data[i][7] || '').trim(),      // H お問合せ内容
      propertyName: String(data[i][8] || '').trim(), // I 物件名
      rent: String(data[i][10] || '').trim()         // K 賃料
    };
    if (!info.name && !info.email) continue;
    if (_autoCreateLeadFromInquiry_(info)) created++;
  }
  var result = { total: data.length, created: created, skipped: data.length - created };
  console.log('[問い合わせ一括リード化] ' + JSON.stringify(result));
  return result;
}

/**
 * 行に検索条件が入っているか判定（C市区町村/E路線/F駅/H賃料/I間取り/J面積/K築年/Y町名）。
 */
function _rowHasCriteria_(row) {
  return (String(row[3] || '').trim() !== '')
    || (String(row[4] || '').trim() !== '')
    || (String(row[5] || '').trim() !== '')
    || (String(row[7] || '').trim() !== '')
    || (String(row[8] || '').trim() !== '')
    || (String(row[9] || '').trim() !== '')
    || (String(row[10] || '').trim() !== '')
    || (String(row[24] || '').trim() !== '');
}

/**
 * 確認用（読み取り専用・削除しない）: 削除候補の重複リード行を一覧で返す。
 * 実削除の前に、同姓同名の別人を誤って消さないか目視確認するためのもの。
 * @return {Object} { count, candidates:[{row,name,email,matchedBy,realRow,realStatus,realHasCriteria}] }
 */
function previewDuplicateLeads() {
  return cleanupBackfillDamage(true);
}

/** 実削除（google.script.run 用）。確認は呼び出し側UIで行う。 */
function deleteDuplicateLeads() {
  return cleanupBackfillDamage(false);
}

/**
 * 復旧用: バックフィルが作ってしまった「重複リード行」を削除する。
 * - 既存の「条件が入っている別行」と同名の、条件が空の lead 行のみ対象。
 * - 本物の新規問い合わせ（名前が他に無い）リードは残す（カンバンに必要）。
 * @param {boolean} dryRun true なら削除せず候補一覧だけ返す（確認用）。
 * @return {Object} dryRun時: { count, candidates }, 実行時: { removed, removedNames, keptLeads }
 */
function cleanupBackfillDamage(dryRun) {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
  if (!sheet) return dryRun ? { count: 0, candidates: [] } : { removed: 0, removedNames: [], keptLeads: 0 };
  var data = sheet.getDataRange().getValues();

  // 「条件が入っている行」を名前・メールで索引（本物の顧客とみなす。status不問）
  var configuredByName = {}, configuredByEmail = {};
  for (var i = 1; i < data.length; i++) {
    if (!_rowHasCriteria_(data[i])) continue;
    var nm = String(data[i][1] || '').trim();
    var em = String(data[i][31] || '').trim().toLowerCase();
    if (nm) configuredByName[nm] = { row: i + 1, status: String(data[i][18] || '').trim().toLowerCase() };
    if (em) configuredByEmail[em] = { row: i + 1, status: String(data[i][18] || '').trim().toLowerCase() };
  }

  var toDelete = [], removedNames = [], candidates = [], keptLeads = 0;
  for (var j = 1; j < data.length; j++) {
    var status = String(data[j][18] || '').trim().toLowerCase();
    if (status !== 'lead') continue;
    if (_rowHasCriteria_(data[j])) { keptLeads++; continue; } // 条件入りリードは触らない
    var name = String(data[j][1] || '').trim();
    var email = String(data[j][31] || '').trim().toLowerCase();
    var byEmail = email && configuredByEmail[email];
    var byName = name && configuredByName[name];
    var match = byEmail || byName;
    if (match) {
      toDelete.push(j + 1);
      removedNames.push(name || email);
      candidates.push({
        row: j + 1, name: name, email: email,
        matchedBy: byEmail ? 'email' : 'name',
        realRow: match.row, realStatus: match.status
      });
    } else {
      keptLeads++;
    }
  }

  if (dryRun) {
    console.log('[削除候補プレビュー] count=' + candidates.length);
    return { count: candidates.length, candidates: candidates };
  }

  // 下から削除（行ズレ防止）
  toDelete.sort(function(a, b) { return b - a; });
  for (var d = 0; d < toDelete.length; d++) sheet.deleteRow(toDelete[d]);

  var result = { removed: toDelete.length, removedNames: removedNames, keptLeads: keptLeads };
  console.log('[バックフィル復旧] ' + JSON.stringify(result));
  return result;
}

/**
 * 移行用（一度だけ実行）: 旧コードが btMode 列(AE=31) に書いてしまった営業ステージを
 * 正しい AG列(33) へ移し、AE列をクリアする。
 * @return {Object} { fixed }
 */
function fixLeadStageColumns() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
  if (!sheet) return { fixed: 0 };
  var data = sheet.getDataRange().getValues();
  var STAGES = ['問い合わせ', '追客中', '内見', '申込', '成約', '終了'];
  var fixed = 0;
  for (var i = 1; i < data.length; i++) {
    var col31 = String(data[i][30] || '').trim(); // AE(31)=btMode
    if (STAGES.indexOf(col31) >= 0) {
      if (!String(data[i][32] || '').trim()) sheet.getRange(i + 1, 33).setValue(col31); // AG(33)=stage
      sheet.getRange(i + 1, 31).setValue(''); // AE(31) btMode をクリア
      fixed++;
    }
  }
  console.log('[stage列移行] fixed=' + fixed);
  return { fixed: fixed };
}

/**
 * 顧客管理ページの「問い合わせ取込」ボタン用。
 * 新規メールを取り込み、さらに過去分も含めて未リード化の問い合わせをリード化する。
 * @return {Object} { imported, skipped, scanned, leadsCreated }
 */
function importInquiriesWithBackfill() {
  var imp = importSuumoInquiries();
  var bf = backfillInquiryLeads();
  return {
    imported: imp.imported,
    skipped: imp.skipped,
    scanned: imp.scanned,
    leadsCreated: bf.created
  };
}

function importSuumoInquiries() {
  var sheet = _getInquirySheet_();

  // 連番列(B)をテキスト形式にして先頭ゼロを保持（数値化による重複判定ズレを防ぐ）
  try { sheet.getRange('B:B').setNumberFormat('@'); } catch (eFmt) {}

  // 既存の連番セット（重複防止）。正規化キーで照合（先頭ゼロ/全角空白の差を吸収）
  var existing = {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var renbanCol = sheet.getRange(2, 2, lastRow - 1, 1).getValues(); // B列
    for (var i = 0; i < renbanCol.length; i++) {
      var rb = _normRenban_(renbanCol[i][0]);
      if (rb) existing[rb] = true;
    }
  }

  // 件名で検索（直近90日）
  var threads = GmailApp.search('subject:反響お知らせメール newer_than:90d');
  var imported = 0, skipped = 0, scanned = 0;
  var newRows = [];
  var newInfos = []; // 自動リード化用

  for (var t = 0; t < threads.length; t++) {
    var msgs = threads[t].getMessages();
    for (var m = 0; m < msgs.length; m++) {
      var msg = msgs[m];
      var subject = msg.getSubject() || '';
      if (subject.indexOf('反響お知らせメール') === -1) continue;
      scanned++;
      var info = _parseSuumoInquiryEmail_(subject, msg.getPlainBody(), msg.getDate());
      if (!info || !info.renban) { continue; }
      var rbKey = _normRenban_(info.renban);
      if (existing[rbKey]) { skipped++; continue; }
      existing[rbKey] = true; // 同一バッチ内の重複も防ぐ

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
      newInfos.push(info);
      imported++;
    }
  }

  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, INQUIRY_HEADERS.length).setValues(newRows);
  }

  // 新規問い合わせを自動でリード顧客化（メール重複判定）→ カンバン「問い合わせ」列に出る
  for (var ni = 0; ni < newInfos.length; ni++) {
    _autoCreateLeadFromInquiry_(newInfos[ni]);
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

  // 対応ログを連番ごとに集計（最終接触・架電/メール回数）＋全件リスト(timeline用)
  var logSummary = {};
  var logsByRenban = {};
  try {
    var logSheet = _getInquiryLogSheet_();
    var lLast = logSheet.getLastRow();
    if (lLast > 1) {
      var ldata = logSheet.getRange(2, 1, lLast - 1, INQUIRY_LOG_HEADERS.length).getValues();
      for (var li = 0; li < ldata.length; li++) {
        var lk = _normRenban_(ldata[li][0]); if (!lk) continue;
        var ldt = ldata[li][1];
        var lts = (ldt instanceof Date) ? ldt.getTime() : (new Date(String(ldt)).getTime() || 0);
        var ltype = String(ldata[li][2] || '');
        var s = logSummary[lk] || (logSummary[lk] = { count: 0, callCount: 0, mailCount: 0, lastTs: 0, lastType: '', lastResult: '', lastStr: '' });
        s.count++;
        if (ltype.indexOf('架電') >= 0 || ltype.indexOf('電話') >= 0) s.callCount++;
        else if (ltype.indexOf('メール') >= 0) s.mailCount++;
        if (lts >= s.lastTs) {
          s.lastTs = lts; s.lastType = ltype; s.lastResult = String(ldata[li][3] || '');
          s.lastStr = (ldt instanceof Date) ? Utilities.formatDate(ldt, tz, 'MM/dd HH:mm') : String(ldt || '');
        }
        (logsByRenban[lk] || (logsByRenban[lk] = [])).push({
          source: 'manual', ts: lts,
          dateStr: (ldt instanceof Date) ? Utilities.formatDate(ldt, tz, 'yyyy/MM/dd HH:mm') : String(ldt || ''),
          type: ltype, detail: String(ldata[li][3] || ''), memo: String(ldata[li][4] || ''), rowIndex: li + 2
        });
      }
    }
  } catch (eLog) {}

  // 自動返信メール（reply.py が記録する「メール送信履歴」）をメールアドレスごとに集計＋全件リスト
  var autoMail = {};
  var autoByEmail = {};
  try {
    var ss2 = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var mSheet = ss2.getSheetByName('メール送信履歴');
    if (mSheet && mSheet.getLastRow() > 1) {
      var mdata = mSheet.getRange(2, 1, mSheet.getLastRow() - 1, 7).getValues();
      for (var mi = 0; mi < mdata.length; mi++) {
        var em = String(mdata[mi][1] || '').trim().toLowerCase(); if (!em) continue;
        var mdt = mdata[mi][0];
        var mts = (mdt instanceof Date) ? mdt.getTime() : (new Date(String(mdt)).getTime() || 0);
        var a = autoMail[em] || (autoMail[em] = { count: 0, lastTs: 0, lastStr: '', lastType: '' });
        a.count++;
        if (mts >= a.lastTs) {
          a.lastTs = mts; a.lastType = String(mdata[mi][4] || '');
          a.lastStr = (mdt instanceof Date) ? Utilities.formatDate(mdt, tz, 'MM/dd HH:mm') : String(mdt || '');
        }
        var mdays = mdata[mi][5];
        (autoByEmail[em] || (autoByEmail[em] = [])).push({
          source: 'auto', ts: mts,
          dateStr: (mdt instanceof Date) ? Utilities.formatDate(mdt, tz, 'yyyy/MM/dd HH:mm') : String(mdt || ''),
          type: '自動返信メール',
          detail: String(mdata[mi][4] || '') + ((mdays !== '' && mdays != null && String(mdays) !== '0') ? '（' + mdays + '日目）' : ''),
          memo: ''
        });
      }
    }
  } catch (eAM) {}

  var list = [];
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (!String(r[1] || '').trim()) continue; // 連番なし行はスキップ
    var recv = r[0];
    var recvStr = (recv instanceof Date) ? Utilities.formatDate(recv, tz, 'yyyy/MM/dd HH:mm') : String(recv || '');
    var recvTs = (recv instanceof Date) ? recv.getTime() : (new Date(String(recv)).getTime() || 0);
    var sm = logSummary[_normRenban_(r[1])] || null;
    var am = autoMail[String(r[4] || '').trim().toLowerCase()] || null;
    // 統合タイムライン（手動ログ＋自動返信メール）を新しい順で
    var tl = (logsByRenban[_normRenban_(r[1])] || []).concat(autoByEmail[String(r[4] || '').trim().toLowerCase()] || []);
    tl.sort(function(x, y) { return y.ts - x.ts; });
    list.push({
      timeline: tl,
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
      memo: String(r[18] || ''),
      // 対応ログサマリー
      logCount: sm ? sm.count : 0,
      callCount: sm ? sm.callCount : 0,
      mailCount: sm ? sm.mailCount : 0,
      lastContactStr: sm ? sm.lastStr : '',
      lastContactTs: sm ? sm.lastTs : 0,
      lastContactType: sm ? sm.lastType : '',
      lastContactResult: sm ? sm.lastResult : '',
      // 自動返信メール（reply.py 由来）
      autoMailCount: am ? am.count : 0,
      autoMailLastStr: am ? am.lastStr : '',
      autoMailLastTs: am ? am.lastTs : 0,
      autoMailLastType: am ? am.lastType : ''
    });
  }
  list.sort(function(a, b) { return b.ts - a.ts; });
  return list;
}

/** 対応ログを1件記録する（架電・メール送付など）。 */
function addInquiryLog(renban, type, result, memo) {
  try {
    if (!renban) return { success: false, message: '連番がありません' };
    var sheet = _getInquiryLogSheet_();
    sheet.appendRow([String(renban), new Date(), String(type || ''), String(result || ''), String(memo || ''), '']);
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/** 指定連番の対応ログを新しい順で返す。 */
function getInquiryLogs(renban) {
  try {
    var sheet = _getInquiryLogSheet_();
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];
    var key = _normRenban_(renban);
    var data = sheet.getRange(2, 1, lastRow - 1, INQUIRY_LOG_HEADERS.length).getValues();
    var tz = 'Asia/Tokyo';
    var out = [];
    for (var i = 0; i < data.length; i++) {
      if (_normRenban_(data[i][0]) !== key) continue;
      var dt = data[i][1];
      out.push({
        rowIndex: i + 2,
        dateStr: (dt instanceof Date) ? Utilities.formatDate(dt, tz, 'yyyy/MM/dd HH:mm') : String(dt || ''),
        ts: (dt instanceof Date) ? dt.getTime() : (new Date(String(dt)).getTime() || 0),
        type: String(data[i][2] || ''),
        result: String(data[i][3] || ''),
        memo: String(data[i][4] || '')
      });
    }
    out.sort(function(a, b) { return b.ts - a.ts; });
    return out;
  } catch (e) {
    return [];
  }
}

/** 手動の対応ログ ＋ 自動返信メール(メール送信履歴) を統合して新しい順で返す。 */
function getInquiryTimeline(renban, email) {
  var out = [];
  // 手動ログ（架電・メール送付）
  try {
    var logs = getInquiryLogs(renban);
    for (var i = 0; i < logs.length; i++) {
      out.push({
        ts: logs[i].ts, dateStr: logs[i].dateStr, source: 'manual',
        type: logs[i].type, detail: logs[i].result, memo: logs[i].memo, rowIndex: logs[i].rowIndex
      });
    }
  } catch (e1) {}
  // 自動返信メール（reply.py が記録）
  try {
    var em = String(email || '').trim().toLowerCase();
    if (em) {
      var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
      var mSheet = ss.getSheetByName('メール送信履歴');
      if (mSheet && mSheet.getLastRow() > 1) {
        var tz = 'Asia/Tokyo';
        var md = mSheet.getRange(2, 1, mSheet.getLastRow() - 1, 7).getValues();
        for (var j = 0; j < md.length; j++) {
          if (String(md[j][1] || '').trim().toLowerCase() !== em) continue;
          var dt = md[j][0];
          var ts = (dt instanceof Date) ? dt.getTime() : (new Date(String(dt)).getTime() || 0);
          var days = md[j][5];
          out.push({
            ts: ts,
            dateStr: (dt instanceof Date) ? Utilities.formatDate(dt, tz, 'yyyy/MM/dd HH:mm') : String(dt || ''),
            source: 'auto',
            type: '自動返信メール',
            detail: String(md[j][4] || '') + ((days !== '' && days != null && String(days) !== '0') ? '（' + days + '日目）' : ''),
            memo: ''
          });
        }
      }
    }
  } catch (e2) {}
  out.sort(function(a, b) { return b.ts - a.ts; });
  return out;
}

/** 対応ログを1件削除する（行番号＋連番で照合）。 */
function deleteInquiryLog(rowNum, renban) {
  try {
    var sheet = _getInquiryLogSheet_();
    var rowRenban = _normRenban_(sheet.getRange(rowNum, 1).getValue());
    if (rowRenban !== _normRenban_(renban)) {
      return { success: false, message: '行が一致しません（再読み込みしてください）' };
    }
    sheet.deleteRow(rowNum);
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
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

/**
 * 既存の重複行を削除する（連番が同じ行は最初の1件だけ残す）。
 * 先頭ゼロの数値化で重複取り込みされてしまった分の掃除用。エディタで一度実行。
 * @return {Object} { removed }
 */
function dedupeInquiries() {
  var sheet = _getInquirySheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { removed: 0 };
  var data = sheet.getRange(2, 2, lastRow - 1, 1).getValues(); // B列 連番
  var seen = {};
  var toDelete = [];
  for (var i = 0; i < data.length; i++) {
    var key = _normRenban_(data[i][0]);
    if (!key) continue;
    if (seen[key]) toDelete.push(i + 2); // シート行番号
    else seen[key] = true;
  }
  // 下から消す（行番号がずれないように）
  for (var d = toDelete.length - 1; d >= 0; d--) sheet.deleteRow(toDelete[d]);
  console.log('[問い合わせ重複削除] removed=' + toDelete.length);
  return { removed: toDelete.length };
}

/** 問い合わせを連番で1件取得（内部用）。 */
function _getInquiryByRenban_(renban) {
  var sheet = _getInquirySheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return null;
  var key = _normRenban_(renban);
  var data = sheet.getRange(2, 1, lastRow - 1, INQUIRY_HEADERS.length).getValues();
  var tz = 'Asia/Tokyo';
  for (var i = 0; i < data.length; i++) {
    if (_normRenban_(data[i][1]) !== key) continue;
    var recv = data[i][0];
    return {
      rowIndex: i + 2,
      receivedAt: (recv instanceof Date) ? Utilities.formatDate(recv, tz, 'yyyy/MM/dd HH:mm') : String(recv || ''),
      renban: String(data[i][1] || ''),
      name: String(data[i][2] || ''),
      email: String(data[i][4] || ''),
      tel: String(data[i][5] || ''),
      message: String(data[i][7] || ''),
      propertyName: String(data[i][8] || ''),
      rent: String(data[i][10] || '')
    };
  }
  return null;
}

/**
 * 問い合わせを「リード」として顧客登録し、対応履歴も顧客の対応ログへ引き継ぐ。
 * リードは status='lead'（自動検索対象外）。同名の既存顧客があれば紐付けのみ。
 * @return {Object} { success, customerName, alreadyExisted, message }
 */
function promoteInquiryToCustomer(renban) {
  try {
    var inq = _getInquiryByRenban_(renban);
    if (!inq) return { success: false, message: '問い合わせが見つかりません' };
    var name = (inq.name || '').trim();
    if (!name) return { success: false, message: '問い合わせに名前がありません' };

    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var critSheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!critSheet) return { success: false, message: '検索条件シートが見つかりません' };

    // 同名の既存顧客チェック
    var cdata = critSheet.getDataRange().getValues();
    var exists = false;
    for (var i = 1; i < cdata.length; i++) {
      if (String(cdata[i][1] || '').trim() === name) { exists = true; break; }
    }

    // 無ければ「リード」として作成（status='lead' → getExistingCustomers_ で自動検索除外）
    if (!exists) {
      var row = [];
      for (var c = 0; c < 19; c++) row.push('');
      row[0] = new Date(); // A 登録日時
      row[1] = name;       // B 名前
      row[18] = 'lead';    // S 配信ステータス
      critSheet.appendRow(row);
      try { critSheet.getRange(critSheet.getLastRow(), 33).setValue('問い合わせ'); } catch (eStg) {} // AG(33): 営業ステージ
    }

    // 問い合わせ情報を対応ログにメモとして残す
    var infoParts = [];
    if (inq.propertyName) infoParts.push('物件: ' + inq.propertyName + (inq.rent ? ' ' + inq.rent : ''));
    if (inq.email) infoParts.push('メール: ' + inq.email);
    if (inq.tel) infoParts.push('TEL: ' + inq.tel);
    if (inq.message) infoParts.push('内容: ' + inq.message);
    try { addContactLog(name, 'SUUMO反響', inq.receivedAt, infoParts.join(' / ')); } catch (e1) {}

    // 対応履歴（架電/手動メール/自動返信メール）を顧客の対応ログへコピー
    try {
      var tl = getInquiryTimeline(renban, inq.email);
      for (var t = 0; t < tl.length; t++) {
        var L = tl[t];
        var ctype = (L.source === 'auto') ? 'メール' : ((L.type && L.type.indexOf('架電') >= 0) ? '電話' : 'メール');
        var memo = (L.source === 'auto')
          ? ('自動返信メール: ' + (L.detail || ''))
          : ((L.detail ? L.detail + ' ' : '') + (L.memo || ''));
        addContactLog(name, ctype, L.dateStr, memo);
      }
    } catch (e2) {}

    // 問い合わせを対応済みにし、登録済みを記録
    try {
      var iSheet = _getInquirySheet_();
      iSheet.getRange(inq.rowIndex, 18).setValue('対応済み'); // R 対応状況
      var cur = String(iSheet.getRange(inq.rowIndex, 19).getValue() || ''); // S 対応メモ
      iSheet.getRange(inq.rowIndex, 19).setValue((cur ? cur + ' / ' : '') + '顧客登録済み(' + name + ')');
    } catch (e3) {}

    return {
      success: true, customerName: name, alreadyExisted: exists,
      message: name + ' を' + (exists ? '既存顧客に紐付け' : 'リードとして顧客登録') + 'しました（対応履歴も引き継ぎ）'
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
