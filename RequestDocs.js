/**
 * 内見依頼書・広告掲載依頼書の作成
 *
 * これまでは専用スプレッドシートの「入力用」シートに手で値を打ち込んで、
 * 「印刷用」シートをPDFに書き出していた。その入力部分だけをここで肩代わりする。
 *
 * PDFへの書き出し自体はChrome拡張側が
 *   https://docs.google.com/spreadsheets/d/<ID>/export?format=pdf&gid=<印刷用のgid>
 * をブラウザのログイン状態で取得して行う。
 * GAS側でPDF化しないのは、DriveApp や export エンドポイントを使うと
 * OAuthスコープが増えて、既存の14デプロイメントが再承認待ちで止まるため。
 * （現在このプロジェクトは Drive スコープを一切使っていない）
 */

// 依頼書テンプレート（内見依頼書・広告掲載依頼書・送付状の6シート構成）
var REQUEST_DOC_SS_ID = '1RliT_d0iOm766AkF49TlepWBK-XhGCW02ubaTqt0VEg';

var REQUEST_DOC_KINDS = {
  viewing: {
    label: '内見依頼書',
    inputSheet: '内見依頼書・入力用',
    printSheet: '内見依頼書・印刷用'
  },
  ad: {
    label: '広告掲載依頼書',
    inputSheet: '広告掲載依頼書・入力用',
    printSheet: '広告掲載依頼書・印刷用'
  }
};

/**
 * A列のラベルを探して、同じ行のB列に値を書く。
 * 行番号を直接指定しないのは、テンプレート側で行が増減しても壊れないようにするため。
 * 戻り値: 書けたラベルの一覧
 */
function _setByLabelColumnA_(sheet, values) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return [];
  var labels = sheet.getRange(1, 1, lastRow, 1).getValues();
  var written = [];
  for (var i = 0; i < labels.length; i++) {
    var label = String(labels[i][0] || '').trim();
    if (!label) continue;
    if (!Object.prototype.hasOwnProperty.call(values, label)) continue;
    sheet.getRange(i + 1, 2).setValue(values[label]);
    written.push(label);
  }
  return written;
}

/**
 * 印刷用シートのラベル（例:「広告媒体：」）の右隣のセルに値を書く。
 * 入力用シートに項目が無いものだけをここで直接書く。
 * 数式が入っているセルは絶対に上書きしない（テンプレートが壊れて元に戻せなくなるため）。
 */
function _setBesideLabelOnPrintSheet_(sheet, labelPattern, value) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 2) return { ok: false, reason: 'empty_sheet' };
  var vals = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  for (var r = 0; r < vals.length; r++) {
    for (var c = 0; c < vals[r].length - 1; c++) {
      if (!labelPattern.test(String(vals[r][c] || ''))) continue;
      // ラベルの右隣から、最初の「空でない or 書ける」セルを探す
      for (var c2 = c + 1; c2 < vals[r].length; c2++) {
        var cell = sheet.getRange(r + 1, c2 + 1);
        if (String(cell.getFormula() || '')) return { ok: false, reason: 'formula_cell' };
        if (String(vals[r][c2] || '').trim() === '') continue;
        cell.setValue(value);
        return { ok: true, a1: cell.getA1Notation() };
      }
      return { ok: false, reason: 'value_cell_not_found' };
    }
  }
  return { ok: false, reason: 'label_not_found' };
}

/**
 * 依頼書テンプレートに値を流し込む。
 * 実際のPDF化は拡張側が印刷用シートの gid を使って行うので、その gid を返す。
 *
 * json: { kind, company, building, rooms, date, time, media }
 */
function handleMakeRequestDoc(json) {
  var out = function (obj) {
    return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
  };

  var kind = String(json.kind || '').trim();
  var conf = REQUEST_DOC_KINDS[kind];
  if (!conf) return out({ ok: false, error: '不明な書類種別: ' + kind });

  var company = String(json.company || '').trim();
  var building = String(json.building || '').trim();
  if (!company) return out({ ok: false, error: '会社名が空です' });
  if (!building) return out({ ok: false, error: '物件名が空です' });

  // 同じテンプレートを共有するので、値を書いてから拡張がPDFを取り終えるまで
  // 別のリクエストが割り込まないよう直列化する。
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (eLock) {
    return out({ ok: false, error: '他の依頼書を作成中です。少し待ってからもう一度お試しください。' });
  }

  try {
    var ss;
    try {
      ss = SpreadsheetApp.openById(REQUEST_DOC_SS_ID);
    } catch (eOpen) {
      return out({
        ok: false,
        error: '依頼書テンプレートを開けません。スクリプトのGoogleアカウントに編集権限を付けてください。(' + eOpen.message + ')'
      });
    }

    var inputSheet = ss.getSheetByName(conf.inputSheet);
    var printSheet = ss.getSheetByName(conf.printSheet);
    if (!inputSheet) return out({ ok: false, error: 'シートが見つかりません: ' + conf.inputSheet });
    if (!printSheet) return out({ ok: false, error: 'シートが見つかりません: ' + conf.printSheet });

    var values = { '会社名': company, '物件名': building };
    if (kind === 'viewing') {
      values['内見日'] = String(json.date || '').trim();
      values['時間'] = String(json.time || '').trim();
      // 同じ建物の複数部屋をまとめて内見することがあるので、部屋番号は連結して1行に入れる
      values['部屋番号'] = String(json.rooms || '').trim();
    }

    var written = _setByLabelColumnA_(inputSheet, values);
    // 入力用に無い項目（広告媒体）は印刷用へ直接。数式セルなら触らない。
    var mediaResult = null;
    if (kind === 'ad') {
      var media = String(json.media || '').trim();
      if (media) mediaResult = _setBesideLabelOnPrintSheet_(printSheet, /広告媒体/, media);
    }

    SpreadsheetApp.flush();

    return out({
      ok: true,
      label: conf.label,
      ssId: REQUEST_DOC_SS_ID,
      printGid: printSheet.getSheetId(),
      written: written,
      media: mediaResult,
      // 拡張側のファイル名づくり用
      fileName: _requestDocFileName_(conf.label, building, json)
    });
  } catch (e) {
    return out({ ok: false, error: e.message });
  } finally {
    try { lock.releaseLock(); } catch (eR) {}
  }
}

function _requestDocFileName_(label, building, json) {
  var parts = [label, building];
  var rooms = String(json.rooms || '').trim();
  if (rooms) parts.push(rooms.replace(/[、,\s]+/g, '-'));
  var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
  parts.push(stamp);
  // ファイル名に使えない文字を落とす
  return parts.join('_').replace(/[\\\/:*?"<>|]/g, '') + '.pdf';
}
