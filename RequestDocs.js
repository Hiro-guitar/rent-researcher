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

    var rooms = String(json.rooms || '').trim();
    var values = { '会社名': company, '物件名': building };
    if (kind === 'viewing') {
      values['内見日'] = String(json.date || '').trim();
      values['時間'] = String(json.time || '').trim();
      // 同じ建物の複数部屋をまとめて内見することがあるので、部屋番号は連結して1行に入れる
      values['部屋番号'] = rooms;
    } else if (kind === 'ad') {
      // 広告掲載依頼書には部屋番号の欄が無いので、物件名に続けて入れる
      // （テンプレートの見本「みらいえ高田馬場 1」も同じ書き方）
      if (rooms) values['物件名'] = building + ' ' + rooms;
    }

    var written = _setByLabelColumnA_(inputSheet, values);
    // 入力用に無い項目（広告媒体）は印刷用へ直接。数式セルなら触らない。
    var mediaResult = null;
    if (kind === 'ad') {
      var media = String(json.media || '').trim();
      if (media) mediaResult = _setBesideLabelOnPrintSheet_(printSheet, /広告媒体/, media);
    }

    var fontFix = _fitCompanyCell_(printSheet, company);

    SpreadsheetApp.flush();

    return out({
      ok: true,
      label: conf.label,
      fontFix: fontFix,
      ssId: REQUEST_DOC_SS_ID,
      printGid: printSheet.getSheetId(),
      written: written,
      media: mediaResult,
      // 拡張側のファイル名づくり用
      fileName: _requestDocFileName_(conf.label, values['物件名'])
    });
  } catch (e) {
    return out({ ok: false, error: e.message });
  } finally {
    try { lock.releaseLock(); } catch (eR) {}
  }
}

/**
 * 宛名（会社名）を読みやすい大きさにする。
 *
 * ・内見依頼書の会社名セルはフォントが小さく設定されていて読みにくいので、
 *   隣の「御中」と同じ大きさに揃える。
 * ・ただし大きくすると長い社名が見切れる。会社名は右揃えなので左へ伸びる＝
 *   「御中」より左の列の幅が使える。そこに収まる範囲で一番大きい字にする。
 * ・「縮小して全体を表示」だと勝手に極小になるので OVERFLOW にして自分で決める。
 *
 * テンプレートを直接直してもいいが、書き込みのたびに揃えておけば
 * 社名の長さが変わっても毎回ちょうどよくなる。
 */
function _fitCompanyCell_(printSheet, companyText) {
  try {
    var lastRow = printSheet.getLastRow();
    var lastCol = printSheet.getLastColumn();
    if (lastRow < 1 || lastCol < 2) return null;
    var vals = printSheet.getRange(1, 1, lastRow, lastCol).getValues();

    for (var r = 0; r < vals.length; r++) {
      for (var c = 0; c < vals[r].length; c++) {
        if (String(vals[r][c] || '').trim() !== '御中') continue;

        var onchuCol = c + 1;                       // 1始まり
        var maxSize = printSheet.getRange(r + 1, onchuCol).getFontSize();

        // 「御中」から左へ、最初に中身のあるセル＝会社名
        var compCol = -1;
        for (var c2 = c - 1; c2 >= 0; c2--) {
          if (String(vals[r][c2] || '').trim() === '') continue;
          compCol = c2 + 1;
          break;
        }
        if (compCol < 0) return null;

        // 使える幅＝「御中」より左の列の合計（右揃えなので左方向に伸びる）
        var available = 0;
        for (var w = 1; w < onchuCol; w++) available += printSheet.getColumnWidth(w);
        available -= 10;   // 「御中」との間の余白

        var size = _fitFontSizeForWidth_(String(companyText || ''), maxSize, available);
        var cell = printSheet.getRange(r + 1, compCol);
        cell.setFontSize(size);
        cell.setWrapStrategy(SpreadsheetApp.WrapStrategy.OVERFLOW);
        return { a1: cell.getA1Notation(), size: size, max: maxSize, availablePx: available };
      }
    }
  } catch (e) {
    console.warn('_fitCompanyCell_ error: ' + e.message);
  }
  return null;
}

/**
 * 幅(px)に収まる一番大きいフォントサイズ(pt)を返す。
 * 全角は約1文字ぶん、半角は約0.55文字ぶんの幅として見積もる。
 * 列幅はpx、フォントはptなので 1pt≒1.333px で換算する。
 */
function _fitFontSizeForWidth_(text, maxSize, availablePx) {
  var units = 0;
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    // ASCII と半角カナは半角幅
    units += (code < 0x0080 || (code >= 0xFF61 && code <= 0xFF9F)) ? 0.55 : 1.0;
  }
  if (units <= 0) return maxSize;
  var minSize = 7;
  for (var size = Math.max(maxSize, minSize); size > minSize; size--) {
    if (units * size * 1.333 <= availablePx) return size;
  }
  return minSize;
}

// ファイル名は「内見依頼書_物件名.pdf」。
// 物件名は書類に印刷されるものと同じ（広告掲載依頼書は部屋番号込み）。
function _requestDocFileName_(label, building) {
  return (label + '_' + building).replace(/[\\\/:*?"<>|]/g, '').trim() + '.pdf';
}
