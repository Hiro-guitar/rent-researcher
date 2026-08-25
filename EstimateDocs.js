/**
 * 初期費用概算書の作成
 *
 * 依頼書（RequestDocs.js）と同じ考え方。専用スプレッドシートの「データ入力用」に
 * 値を流し込み、出力シートをChrome拡張がPDFで書き出す。
 * GAS側でPDF化しないのは、DriveApp や export エンドポイントを使うと
 * OAuthスコープが増えて既存デプロイメントが再承認待ちで止まるため。
 *
 * テンプレートの作り:
 *   データ入力用 A列=項目名 / B列=金額 / C列=ヶ月数や%
 *   B6 敷金   = B4 * C6          （賃料 × ヶ月）
 *   B7 礼金   = B4 * C7
 *   B8 仲介   = B4 * C8          （既定 1.1ヶ月）
 *   B10 日割り家賃   = B4/F9*(F9-(D9-1))   B9=入居月 D9=入居日 F9=その月の日数
 *   B11 日割り管理費 = B5/F9*(F9-(D9-1))
 *   B12 前家賃 = B4
 *   B14 初回保証料 = (B4+B5)*0.01*C14
 *   A15:C22 は自由記入欄（ラベル/金額/備考）。鍵交換費用等もここ
 * ⚠️ B6,B7,B8,B10,B11,B12,B14 は数式。絶対に上書きしないこと。
 */

var ESTIMATE_DOC_SS_ID = '1diEuLPCXLZXBEJwiQDUDW41tilsmcVR35MvgdLWMWd0';
var ESTIMATE_INPUT_SHEET = 'データ入力用';

// 初回保証料の次の行から下は、項目名ごと毎回書き換える自由記入欄。
// テンプレートでは「鍵交換費用/24時間サポート/火災保険/インターネット」が
// 入っているが固定ではない。出力シートは A15〜A22 の8行を拾っている。
var ESTIMATE_FREE_ROWS = 8;
// 割引シートの合計は =sum(D18,D19,F20,D21,…,D29) と1セルずつ列挙されていて、
// 自由記入欄は上から4行(D26〜D29)までしか入っていない。標準シートは =sum(D18:F33)。
var ESTIMATE_DISCOUNT_TOTAL_ROWS = 4;

var ESTIMATE_DOC_KINDS = {
  standard: { label: '初期費用概算書', printSheet: '初期費用概算書' },
  // 仲介手数料に「→ 割引後」を併記するタイプ。日割りありなので標準と対になる。
  discount: { label: '初期費用概算書（仲介手数料割引）', printSheet: '仲介手数料割引' }
};

/** データ入力用のA列ラベル → 書き込む列 */
function _estimateFindLabelRow_(labels, name) {
  for (var i = 0; i < labels.length; i++) {
    if (String(labels[i][0] || '').trim() === name) return i + 1;   // 1始まりの行番号
  }
  return -1;
}

function handleMakeEstimateDoc(json) {
  var out = function (obj) {
    return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
  };

  var kind = String(json.kind || 'standard').trim();
  var conf = ESTIMATE_DOC_KINDS[kind];
  if (!conf) return out({ ok: false, error: '不明な種別: ' + kind });

  var building = String(json.building || '').trim();
  if (!building) return out({ ok: false, error: '物件名が空です' });

  var num = function (v, dflt) {
    var n = Number(String(v === undefined || v === null ? '' : v).replace(/[,\s円]/g, ''));
    return isNaN(n) ? dflt : n;
  };
  var rent = num(json.rent, 0);
  if (rent <= 0) return out({ ok: false, error: '賃料が入っていません' });

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (eLock) {
    return out({ ok: false, error: '他の概算書を作成中です。少し待ってからもう一度お試しください。' });
  }

  try {
    var ss;
    try {
      ss = SpreadsheetApp.openById(ESTIMATE_DOC_SS_ID);
    } catch (eOpen) {
      return out({
        ok: false,
        error: '概算書テンプレートを開けません。スクリプトのGoogleアカウントに編集権限を付けてください。(' + eOpen.message + ')'
      });
    }

    var input = ss.getSheetByName(ESTIMATE_INPUT_SHEET);
    var printSheet = ss.getSheetByName(conf.printSheet);
    if (!input) return out({ ok: false, error: 'シートが見つかりません: ' + ESTIMATE_INPUT_SHEET });
    if (!printSheet) return out({ ok: false, error: 'シートが見つかりません: ' + conf.printSheet });

    var lastRow = input.getLastRow();
    var labels = input.getRange(1, 1, Math.max(lastRow, 22), 1).getValues();
    var rowOf = function (name) { return _estimateFindLabelRow_(labels, name); };
    var written = [];
    var setB = function (name, value) {
      var r = rowOf(name);
      if (r < 0) return;
      input.getRange(r, 2).setValue(value);
      written.push(name);
    };
    var setC = function (name, value) {
      var r = rowOf(name);
      if (r < 0) return;
      input.getRange(r, 3).setValue(value);
      written.push(name + '(C列)');
    };

    // ── 物件と金額 ──
    setB('物件名', building);
    setB('部屋番号', String(json.room || '').trim());
    setB('賃料', rent);
    setB('管理費', num(json.managementFee, 0));

    // 敷金・礼金・仲介手数料は「ヶ月数」を入れる（金額はテンプレの数式が出す）
    setC('敷金', num(json.depositMonths, 0));
    setC('礼金', num(json.keyMoneyMonths, 0));
    setC('仲介手数料', num(json.brokerageMonths, 1.1));

    // ── 入居予定日（B=月 / D=日 / F=その月の日数）──
    var moveRow = rowOf('入居予定日');
    var moveMonth = num(json.moveInMonth, 0);
    var moveDay = num(json.moveInDay, 0);
    var daysInMonth = num(json.daysInMonth, 0);
    if (moveRow > 0 && moveMonth > 0 && moveDay > 0 && daysInMonth > 0) {
      input.getRange(moveRow, 2).setValue(moveMonth);
      input.getRange(moveRow, 4).setValue(moveDay);
      input.getRange(moveRow, 6).setValue(daysInMonth);
      // 「※ 9月16日入居の場合」の注記も入居日に合わせる（概算書のG21に出る）
      input.getRange(moveRow, 8).setValue('※ ' + moveMonth + '月' + moveDay + '日入居の場合');
      written.push('入居予定日');
    }

    // 前家賃は数式(=賃料)だが、前管理費は数式ではないので管理費を入れておく
    setB('前管理費', num(json.managementFee, 0));

    setC('初回保証料', num(json.guaranteeRate, 60));

    // ── 自由記入欄（初回保証料の次の行から8行）──
    // 鍵交換費用・24時間サポート・火災保険・インターネットもここに入る。
    // テンプレート上は固定項目に見えるが、実際は毎回手で書き換えている枠なので、
    // ラベルごとこちらで入れる。金額は「無料」のような文字も入るので、
    // 数値に見えるときだけ数値として書く。
    var freeStart = rowOf('初回保証料') + 1;
    var lines = Array.isArray(json.items) ? json.items : [];
    var filled = 0;
    var overflow = [];
    if (freeStart > 1) {
      for (var e = 0; e < ESTIMATE_FREE_ROWS; e++) {
        var r = freeStart + e;
        var it = lines[e] || {};
        var label = String(it.label || '').trim();
        var amountRaw = String(it.amount === undefined || it.amount === null ? '' : it.amount).trim();
        var amount = '';
        if (label && amountRaw !== '') {
          var asNum = num(amountRaw, null);
          amount = (asNum === null) ? amountRaw : asNum;   // 「無料」等はそのまま文字で
        }
        input.getRange(r, 1).setValue(label);
        input.getRange(r, 2).setValue(label ? amount : '');
        input.getRange(r, 3).setValue(label ? String(it.note || '') : '');
        if (label) filled++;
      }
      for (var o2 = ESTIMATE_FREE_ROWS; o2 < lines.length; o2++) {
        if (String(lines[o2].label || '').trim()) overflow.push(lines[o2].label);
      }
    }

    // ── 割引タイプ: 仲介手数料の「→ 割引後」の金額 ──
    var discountResult = null;
    if (kind === 'discount') {
      var discounted = num(json.discountedBrokerage, 33000);
      discountResult = _setDiscountedBrokerage_(printSheet, discounted);
    }

    SpreadsheetApp.flush();

    // 割引シートの合計は =sum(D18,D19,F20,D21,…,D29) と1セルずつ列挙されていて、
    // 追加項目の行(D30〜D33)が入っていない。標準シートは =sum(D18:F33) なので入る。
    // テンプレートの数式を勝手に書き換えないので、使ったときは画面で知らせる。
    var totalWarning = '';
    if (kind === 'discount' && filled > ESTIMATE_DISCOUNT_TOTAL_ROWS) {
      totalWarning = '割引タイプの合計に入るのは自由記入欄の上から'
        + ESTIMATE_DISCOUNT_TOTAL_ROWS + '件までです（テンプレートの合計式が'
        + 'それ以降の行を範囲に入れていないため）。'
        + (filled - ESTIMATE_DISCOUNT_TOTAL_ROWS) + '件が合計に入っていません。';
    }
    if (overflow.length) {
      totalWarning += (totalWarning ? ' / ' : '')
        + '記入欄が' + ESTIMATE_FREE_ROWS + '行しかないため入らなかった項目: ' + overflow.join('、');
    }

    return out({
      ok: true,
      label: conf.label,
      totalWarning: totalWarning,
      ssId: ESTIMATE_DOC_SS_ID,
      printGid: printSheet.getSheetId(),
      written: written,
      discount: discountResult,
      filled: filled,
      fileName: _estimateFileName_(conf.label, building, json.room)
    });
  } catch (e) {
    return out({ ok: false, error: e.message });
  } finally {
    try { lock.releaseLock(); } catch (eR) {}
  }
}

/**
 * 割引シートの「仲介手数料」行にある、矢印の右の金額を書き換える。
 * 数式セルは触らない（合計の式が壊れると金額が狂うため）。
 */
function _setDiscountedBrokerage_(printSheet, amount) {
  try {
    var lastRow = printSheet.getLastRow();
    var lastCol = printSheet.getLastColumn();
    var vals = printSheet.getRange(1, 1, lastRow, lastCol).getValues();
    for (var r = 0; r < vals.length; r++) {
      var hasArrow = false, arrowCol = -1;
      for (var c = 0; c < vals[r].length; c++) {
        if (String(vals[r][c] || '').trim() === '→') { hasArrow = true; arrowCol = c; break; }
      }
      if (!hasArrow) continue;
      var cell = printSheet.getRange(r + 1, arrowCol + 2);   // 矢印の右
      if (String(cell.getFormula() || '')) return { ok: false, reason: 'formula_cell' };
      cell.setValue(amount);
      return { ok: true, a1: cell.getA1Notation(), amount: amount };
    }
    return { ok: false, reason: 'arrow_not_found' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function _estimateFileName_(label, building, room) {
  var name = label + '_' + String(building || '').trim();
  var rm = String(room || '').trim();
  if (rm) name += ' ' + rm;
  return name.replace(/[\\\/:*?"<>|]/g, '').trim() + '.pdf';
}
