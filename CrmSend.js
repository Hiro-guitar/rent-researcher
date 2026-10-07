/**
 * CrmSend.gs — 顧客管理の画面から物件とスタッフの一言を送る（2026-09-30〜）
 *
 * これまでは、物件検索で見つけた物件が Discord に画像つきで届き、承認ページで1件ずつ（または
 * カートで）承認して送っていた。出先で見るのも承認するのも大変だったので、顧客ごとに
 * 顧客管理の画面で目で確かめ、選んだ物件を**横並びのカード1つ**にまとめ、
 * **そのあとにスタッフの普通の文**を別の吹き出しで送る形にする（1回の送信＝LINE 1通分）。
 *
 * 送ったあとの記録は、今までの一括送信（PropertyApproval.js の sendCartCarousel）と同じ:
 *   承認待ち物件の status を sent に、通知済み物件に1行、詳細ページのURL（ehomaki）を作る。
 *
 * ⚠️ スタッフの文はカードにしないこと。普通の文字のメッセージにする（スタッフが今打ったように見せるため）。
 */

/** 承認待ち（まだ送っていない）物件を、顧客ごとに画面で使う形でまとめる。 */
function _crmPendingAll_(crits, only) {
  var out = {};
  // ⚠️ どこから送ったものでも、送り済みは新着に出さない（2026-10-02）。
  //   Discord の承認ページなど別の経路で送ると、承認待ちの行が pending のまま残ることがある。
  //   「送った」の記録は通知済み物件シートに必ず入る（addToSeenSheet）ので、そちらで照らし合わせる。
  var seen = {};
  var watchRows = [];
  try {
    var ss0 = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SEEN_SHEET_NAME);
    if (ss0 && ss0.getLastRow() > 1) {
      ss0.getRange(2, 1, ss0.getLastRow() - 1, 16).getValues().forEach(function (r) {
        seen[String(r[0] || '').trim() + '|' + String(r[1] || '').trim()] = true;
        if (r[9]) watchRows.push({ name: String(r[0] || '').trim(), buildingName: String(r[2] || ''), roomNumber: String(r[15] || '') });   // J列: キャンセル待ち
      });
    }
  } catch (eSeen) { console.warn('[送る物件] 通知済みを読めません: ' + eSeen.message); }
  try {
    var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PENDING_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return out;
    var data = sh.getRange(2, 1, sh.getLastRow() - 1, 15).getValues();
    // ⚠️ 同じ部屋を別のサイト（REINS と itandi など）で見つけると、物件の番号が別になる。
    //   番号だけで照らし合わせると、送った部屋がまた新着に出る（2026-10-02 髙橋さま）。建物名＋部屋番号でも見る。
    var bkey = function (name, p) {
      var norm = function (x) {
        return String(x || '').replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
          .replace(/[\s　・\-－ー]/g, '').toLowerCase();
      };
      var room = String(p.roomNumber || '').replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }).replace(/\D/g, '').replace(/^0+/, '');   // 「0605」と「605」は同じ部屋
      return room ? name + '|' + norm(p.buildingName) + '|' + room : '';   // 部屋番号が無ければ建物だけでは決めない
    };
    var sentKeys = {};
    for (var j = 0; j < data.length; j++) {
      if (String(data[j][10]) !== 'sent') continue;
      if (only && String(data[j][0] || '').trim() !== only) continue;   // 1人分だけのときは他の人を見ない
      try { var k0 = bkey(String(data[j][0] || '').trim(), rowToProperty(data[j])); if (k0) sentKeys[k0] = true; } catch (_e0) {}
    }
    // 同じ部屋を別のサイトの番号でキャンセル待ちにしていたら、新着の方にも「キャンセル待ち中」と出す（2回付けないように）
    var watchKeys = {};
    watchRows.forEach(function (w) { var kw = bkey(w.name, w); if (kw) watchKeys[kw] = true; });
    var shown = {};
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][10]) !== 'pending') continue;
      var name = String(data[i][0] || '').trim();
      if (!name || (only && name !== only)) continue;
      if (seen[name + '|' + String(data[i][2] || '').trim()]) continue;   // もう送った
      var p;
      try { p = rowToProperty(data[i]); } catch (e) { continue; }
      var k = bkey(name, p);
      if (k && (sentKeys[k] || shown[k])) continue;   // 同じ部屋を送った／もう一覧に出した
      if (k) shown[k] = true;
      var cr = (crits && crits[name]) || {};
      var warn = '';
      try { warn = _computePropertyWarningsGAS_(p, (cr.equipment || []).join(','), cr.notes || '') || ''; } catch (_w) {}
      // 承認ページで選んだ写真（順番も）があればそれを出す。送るカードと同じ並びになる
      var edited = !!(p.selectedImageUrls && p.selectedImageUrls.length);
      var imgs = edited ? p.selectedImageUrls : ((p.imageUrls && p.imageUrls.length) ? p.imageUrls : (p.imageUrl ? [p.imageUrl] : []));
      (out[name] = out[name] || []).push({
        roomId: String(data[i][2] || ''),
        building: p.buildingName || '', room: p.roomNumber || '',
        rent: p.rent || '', fee: p.managementFee || '', layout: p.layout || '', area: p.area || '',
        station: p.stationInfo || '', age: p.buildingAge || '', floor: p.floorText || '',
        image: imgs[0] || '', images: imgs.slice(0, 6), imgCount: imgs.length, edited: edited, url: _crmSourceUrl_(p),
        watching: !!(k && watchKeys[k]),
        warnings: String(warn).split('\n').filter(function (s) { return s; }),
        found: (data[i][11] instanceof Date) ? Utilities.formatDate(data[i][11], 'Asia/Tokyo', 'M/d') : '',
        comment: String(data[i][14] || '')   // O列: 担当者コメント（別の人から引き継いだものも）
      });
    }
  } catch (e) { console.warn('[送る物件] 承認待ちを読めません: ' + e.message); }
  // 条件に合わないかもしれない物件（⚠ が付いたもの）は後ろへ。順番はそれぞれの中で今のまま
  Object.keys(out).forEach(function (n) {
    var ok = [], warn = [];
    out[n].forEach(function (p) { (p.warnings && p.warnings.length ? warn : ok).push(p); });
    out[n] = ok.concat(warn);
  });
  return out;
}

// ── 送信候補（新着を仕分けて残した物件）──
// 物件の状態（K列）には手を付けず、別の小さなシートに覚える。送った・見送ったら消す。
var CRM_CAND_SHEET = 'CRM送信候補';
/** 顧客名 → { 物件番号: true } */
function _crmCandidatesAll_() {
  var out = {};
  try {
    var sh = SpreadsheetApp.openById(CRITERIA_SHEET_ID).getSheetByName(CRM_CAND_SHEET);
    if (!sh || sh.getLastRow() < 2) return out;
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
      var n = String(r[0] || '').trim(), rid = String(r[1] || '').trim();
      if (n && rid) (out[n] = out[n] || {})[rid] = true;
    });
  } catch (e) {}
  return out;
}
function _crmCandSet_(customerName, roomIds, on) {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sh = ss.getSheetByName(CRM_CAND_SHEET);
  if (!sh) { if (!on) return; sh = ss.insertSheet(CRM_CAND_SHEET); sh.appendRow(['顧客名', '物件番号', '入れた日時']); }
  var want = {}; (roomIds || []).forEach(function (r) { want[String(r)] = true; });
  var data = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues() : [];
  var have = {};
  for (var i = data.length - 1; i >= 0; i--) {
    var n = String(data[i][0] || '').trim(), rid = String(data[i][1] || '').trim();
    if (n !== customerName || !want[rid]) continue;
    if (on) have[rid] = true; else sh.deleteRow(i + 2);
  }
  if (on) {
    var now = new Date();
    Object.keys(want).forEach(function (rid) { if (!have[rid]) sh.appendRow([customerName, rid, now]); });
    sh.getRange(2, 2, Math.max(1, sh.getLastRow() - 1), 1).setNumberFormat('@');
  }
  try { cfSyncSheet(CRM_CAND_SHEET, '送信候補'); } catch (eCf) {}
}

/** 画面: 物件を送信候補に入れる（on=true）／新着に戻す（on=false）。 */
function setCrmCandidates(customerName, roomIds, on) {
  _crmCandSet_(customerName, roomIds, !!on);
  var page = _crmTreeForPage_(customerName);
  page.savedMessage = (roomIds || []).length + '件を' + (on ? '候補に入れました' : '新着に戻しました');
  return page;
}

/**
 * 画面: 選んだ物件（横並びのカード）と、スタッフの一言（普通の文）を送る。
 * どちらか片方だけでもよい。1回の push に収まれば LINE 1通分。
 * @param {string} customerName
 * @param {string[]} roomIds  承認待ち物件の room_id（空なら文だけ）
 * @param {string} text       スタッフの一言（空なら物件だけ）
 */
function sendCrmProperties(customerName, roomIds, text) {
  roomIds = (roomIds || []).filter(function (r) { return r; });
  text = String(text || '').trim();
  if (!roomIds.length && !text) throw new Error('送る物件も一言もありません');
  var uid = findLineUserId(customerName);
  if (!uid || String(uid).indexOf('admin_') === 0) throw new Error(customerName + ' さんはLINEがつながっていません');

  var messages = [], sentTargets = [];
  if (roomIds.length) {
    var rows = _findRowsByRoomIdsAnyStatus_(customerName, roomIds);
    if (!rows.length) throw new Error('選んだ物件が見つかりません（すでに片付けられた可能性があります）');
    var stations = _getCustomerSelectedStations_(customerName);
    var bubbles = [];
    // 同じ物件の行が複数（新着・送った・見送った）あっても1枚だけ送る。新着→送った→それ以外の順で選ぶ
    var rank = { pending: 0, sent: 1 };
    var best = {};
    rows.forEach(function (r) {
      var k = String(r.values[2]);
      var cur = best[k];
      var rr = rank[String(r.values[10])] !== undefined ? rank[String(r.values[10])] : 2;
      if (!cur || rr < cur.rr) best[k] = { r: r, rr: rr };
    });
    rows = roomIds.map(function (k) { return best[String(k)] && best[String(k)].r; }).filter(Boolean);
    rows.forEach(function (r) {
      var prop = rowToProperty(r.values);
      var rid = String(r.values[2]);
      var sel = (prop.selectedImageUrls && prop.selectedImageUrls.length) ? prop.selectedImageUrls
        : (prop.imageUrls && prop.imageUrls.length ? prop.imageUrls : (prop.imageUrl ? [prop.imageUrl] : []));
      // ⚠️ 担当者コメント（O列）を必ず載せること。以前は読んでおらず、カードにコメントが出ていなかった
      var comment = String(r.values[14] || '').trim();
      var viewUrl = _bestViewUrl_(customerName, rid, prop, { staffComment: comment, authoritative: prop._editedFields || {} });
      cachePropertyImages(customerName, rid, sel, prop.selectedImageCategories || []);
      var flex = buildPropertyFlex(prop, { includeImage: sel.length > 0, heroImageUrls: sel, viewUrl: viewUrl, customerStations: stations, staffComment: comment });
      if (flex && flex.contents) bubbles.push(flex.contents);
      sentTargets.push({ rowIndex: r.rowIndex, prop: prop, viewUrl: viewUrl });
    });
    messages = _splitBubblesIntoCarousels_(bubbles, text ? text.split('\n')[0].substring(0, 100) : 'お探しの物件が見つかりました');
  }
  // スタッフの一言は、物件のあとに普通の文で（カードにしない）
  if (text) messages.push(textMsg(text));
  // 家族のLINE（親子）にも同じものを送る
  var targets = [uid].concat((typeof _crmFamilyUids_ === 'function') ? _crmFamilyUids_(customerName) : []);
  targets.forEach(function (to) {
    for (var m = 0; m < messages.length; m += 5) pushMessage(to, messages.slice(m, m + 5));
  });

  try { _crmCandSet_(customerName, roomIds, false); } catch (eCd) {}   // 送ったので候補から外す
  sentTargets.forEach(function (t) {
    updatePendingStatus(t.rowIndex, 'sent', t.viewUrl);
    _crmMarkSeen_(customerName, t.prop);
  });
  addContactLog(customerName, 'LINE', new Date().toISOString(),
    (sentTargets.length ? '物件' + sentTargets.length + '件' : '') + (sentTargets.length && text ? '＋' : '') + (text ? '一言: ' + text.substring(0, 60) : ''));
  var page = _crmTreeForPage_(customerName);
  page.savedMessage = (sentTargets.length ? '物件' + sentTargets.length + '件' : '') + (sentTargets.length && text ? 'と一言' : (text ? '一言' : '')) + 'を送りました';
  return page;
}

/** 画面: 選んだ新着をまとめて見送る。 */
function skipCrmProperties(customerName, roomIds) {
  var rows = _findRowsByRoomIdsAnyStatus_(customerName, roomIds || []);
  var n = 0;
  rows.forEach(function (r) { if (String(r.values[10]) === 'pending') { updatePendingStatus(r.rowIndex, 'skipped', ''); n++; } });
  try { _crmCandSet_(customerName, roomIds, false); } catch (eCd) {}
  var page = _crmTreeForPage_(customerName);
  page.savedMessage = (roomIds || []).length + '件を見送りました';
  return page;
}

/** 画面: 承認待ちの物件を見送る（送らない）。 */
function skipCrmProperty(customerName, roomId) {
  var rows = _findRowsByRoomIdsAnyStatus_(customerName, [roomId]);
  rows.forEach(function (r) { if (String(r.values[10]) === 'pending') updatePendingStatus(r.rowIndex, 'skipped', ''); });
  try { _crmCandSet_(customerName, [roomId], false); } catch (eCd) {}
  return _crmTreeForPage_(customerName);
}

/** 画面: 文だけ LINE Chat で手で送ったときの記録（コピーボタン）。 */
function logCrmManualMessage(customerName, text) {
  addContactLog(customerName, 'LINE', new Date().toISOString(), 'LINE Chat で送信: ' + String(text || '').substring(0, 60));
  return _crmTreeForPage_(customerName);
}

/** 画面: その人に送った物件（最近20件）。「別の人にも送る」の元にする。 */
function getCrmSentProps(customerName) {
  var out = [];
  var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PENDING_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return out;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 15).getValues();
  // 募集終了の印（通知済み物件シート: N列=手で募集終了 / F列=空室確認で募集終了）
  var closedBy = {};
  try {
    var seenSh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SEEN_SHEET_NAME);
    if (seenSh && seenSh.getLastRow() > 1) {
      seenSh.getRange(2, 1, seenSh.getLastRow() - 1, 14).getValues().forEach(function (r) {
        if (String(r[0] || '').trim() !== customerName) return;
        var k = String(r[1] || '').trim();
        if (String(r[13] || '') === 'closed') closedBy[k] = 'manual';
        else if (String(r[5] || '') === 'closed' && !closedBy[k]) closedBy[k] = 'auto';
      });
    }
  } catch (eC) {}
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0] || '').trim() !== customerName || String(data[i][10]) !== 'sent') continue;
    var p; try { p = rowToProperty(data[i]); } catch (e) { continue; }
    var imgs = (p.selectedImageUrls && p.selectedImageUrls.length) ? p.selectedImageUrls : (p.imageUrls || []);
    var ms = _cellToEpochMs_(data[i][12]);
    out.push({ roomId: String(data[i][2] || ''), building: p.buildingName || '', room: p.roomNumber || '',
      rent: p.rent || '', fee: p.managementFee || '', layout: p.layout || '', area: p.area || '', station: p.stationInfo || '',
      image: imgs[0] || '', comment: String(data[i][14] || ''), ms: ms, closed: closedBy[String(data[i][2] || '').trim()] || '', url: _crmSourceUrl_(p),
      sentAt: ms ? Utilities.formatDate(new Date(ms), 'Asia/Tokyo', 'M/d') : '' });
  }
  return out.sort(function (a, b) { return b.ms - a.ms; }).slice(0, 60);
}

/**
 * 画面: 送った物件を、写真の選び方・担当者コメントごと別のお客様の新着に入れる。
 * すぐには送らない（送り先に合わせて一言を変えたり、まとめて送れるように）。
 */
function copyCrmPropertyTo(fromName, roomId, toName) {
  toName = String(toName || '').trim();
  if (!toName || toName === fromName) throw new Error('送り先のお客様を選んでください');
  var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PENDING_SHEET_NAME);
  var width = sh.getLastColumn();
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, width).getValues();
  var src = null;
  for (var i = 0; i < data.length; i++) {
    var n = String(data[i][0] || '').trim(), rid = String(data[i][2] || '').trim();
    if (n === toName && rid === String(roomId) && ['pending', 'sent'].indexOf(String(data[i][10])) >= 0) {
      throw new Error(toName + ' さんには、この物件はもう' + (String(data[i][10]) === 'sent' ? '送っています' : '新着に入っています'));
    }
    if (n === fromName && rid === String(roomId)) src = data[i];
  }
  if (!src) throw new Error('元の物件が見つかりません');
  var row = src.slice();
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  row[0] = toName; row[10] = 'pending'; row[11] = new Date(); row[12] = now; row[13] = '';   // A / K / L / M / N
  sh.appendRow(row);
  var last = sh.getLastRow();
  sh.getRange(last, 2, 1, 2).setNumberFormat('@').setValues([[String(src[1] || ''), String(src[2] || '')]]);   // B・C は文字として
  try { cfSyncRows(PENDING_SHEET_NAME, [last], '物件のコピー'); } catch (eCf) {}
  var page = _crmTreeForPage_(toName);
  page.savedMessage = toName + ' さんの新着に入れました（コメントも引き継ぎ）';
  return page;
}

/** 調べもの用（api_key 必須）: 新着と通知済み物件の照らし合わせの内訳。物件番号と件数だけ返す。 */
function crmDebugPendingSeen_(name) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var pend = ss.getSheetByName(PENDING_SHEET_NAME).getDataRange().getValues();
  var seenSh = ss.getSheetByName(SEEN_SHEET_NAME);
  var seen = seenSh.getRange(2, 1, seenSh.getLastRow() - 1, 4).getValues();
  var pRows = pend.filter(function (r) { return String(r[0]).trim() === name; });
  var sRows = seen.filter(function (r) { return String(r[0]).trim() === name; });
  return {
    pendingByStatus: pRows.reduce(function (a, r) { var k = String(r[10]); a[k] = (a[k] || 0) + 1; return a; }, {}),
    pendingRoomIds: pRows.filter(function (r) { return String(r[10]) === 'pending'; }).slice(0, 15).map(function (r) { return [String(r[2]), typeof r[2], String(r[3]).slice(0, 12)]; }),
    seenCount: sRows.length,
    seenRoomIds: sRows.slice(-15).map(function (r) { return [String(r[1]), typeof r[1], String(r[2]).slice(0, 12), String(r[3]).slice(0, 16)]; })
  };
}

/**
 * 画面: 送った物件を、家族のLINEにだけ送り直す（家族をつなぐ前に親だけに送ってしまった分など）。
 * 記録（送った印）は親の分がすでにあるので書かない。コメント・選んだ写真はそのまま。
 */
function resendCrmToFamily(customerName, roomIds, text) {
  roomIds = (roomIds || []).filter(function (r) { return r; });
  var fam = (typeof _crmFamilyUids_ === 'function') ? _crmFamilyUids_(customerName) : [];
  if (!fam.length) throw new Error('家族のLINEがつながっていません');
  if (!roomIds.length) throw new Error('送る物件を選んでください');
  var rows = _findRowsByRoomIdsAnyStatus_(customerName, roomIds);
  if (!rows.length) throw new Error('選んだ物件が見つかりません');
  var stations = _getCustomerSelectedStations_(customerName);
  var bubbles = rows.map(function (r) {
    var prop = rowToProperty(r.values);
    var rid = String(r.values[2]);
    var sel = (prop.selectedImageUrls && prop.selectedImageUrls.length) ? prop.selectedImageUrls
      : (prop.imageUrls && prop.imageUrls.length ? prop.imageUrls : (prop.imageUrl ? [prop.imageUrl] : []));
    var comment = String(r.values[14] || '').trim();
    var viewUrl = String(r.values[13] || '') || _bestViewUrl_(customerName, rid, prop, { staffComment: comment });
    var flex = buildPropertyFlex(prop, { includeImage: sel.length > 0, heroImageUrls: sel, viewUrl: viewUrl, customerStations: stations, staffComment: comment });
    return flex && flex.contents;
  }).filter(Boolean);
  text = String(text || '').trim();
  var messages = _splitBubblesIntoCarousels_(bubbles, text ? text.split('\n')[0].substring(0, 100) : 'お探しの物件をお送りします');
  if (text) messages.push(textMsg(text));
  fam.forEach(function (to) { for (var m = 0; m < messages.length; m += 5) pushMessage(to, messages.slice(m, m + 5)); });
  addContactLog(customerName, 'その他', new Date().toISOString(), '家族のLINEに物件' + bubbles.length + '件を送り直した');
  var page = _crmTreeForPage_(customerName);
  page.savedMessage = '家族のLINEに物件' + bubbles.length + '件を送りました';
  return page;
}

// ── CRMの中で物件を直す（承認ページを読み込まずに即開く）──
// 承認ページの「保存だけ」と同じ置き場所に書く: 写真=J列 selected_image_urls、文字=J列 edited_fields、一言=O列。
var CRM_EDIT_FIELDS_ = ['buildingName', 'roomNumber', 'layout', 'area', 'buildingAge', 'floorText', 'storyText', 'structure',
  'totalUnits', 'sunlight', 'moveInDate', 'stationInfo', 'address', 'otherStations', 'rent', 'managementFee', 'deposit',
  'keyMoney', 'shikibiki', 'petDeposit', 'renewalFee', 'fireInsurance', 'renewalAdminFee', 'guaranteeInfo', 'cleaningFee',
  'keyExchangeFee', 'supportFee24h', 'rightsFee', 'additionalDeposit', 'guaranteeDeposit', 'waterBilling', 'parkingFee',
  'bicycleParkingFee', 'motorcycleParkingFee', 'otherMonthlyFee', 'otherOnetimeFee', 'leaseType', 'contractPeriod',
  'cancellationNotice', 'renewalInfo', 'freeRent', 'freeRentDetail', 'moveOutDate', 'moveInConditions', 'layoutDetail', 'facilities'];

function _crmFieldStr_(p, k) {
  var v = p[k];
  if (k === 'otherStations') return (v || []).join('\n');
  return (v === undefined || v === null) ? '' : String(v);
}

/** 物件の中身（全項目・全写真・今の選択・一言）。お客様を選んだときに裏で先に取っておく。 */
function getCrmPropertyDetails(customerName, roomIds) {
  var rows = _findRowsByRoomIdsAnyStatus_(customerName, roomIds || []);
  var out = {};
  rows.forEach(function (r) {
    var rid = String(r.values[2]);
    if (out[rid]) return;
    var p = rowToProperty(r.values);
    var fields = {};
    CRM_EDIT_FIELDS_.forEach(function (k) { fields[k] = _crmFieldStr_(p, k); });
    var all = (p.imageUrls && p.imageUrls.length) ? p.imageUrls.slice() : (p.imageUrl ? [p.imageUrl] : []);
    var sel = (p.selectedImageUrls && p.selectedImageUrls.length) ? p.selectedImageUrls.slice() : all.slice();
    // 選んだ写真は元の写真の並びにないもの（あとから足した写真）もある
    sel.forEach(function (u) { if (all.indexOf(u) < 0) all.push(u); });
    var cats = {};
    (p.imageUrls || []).forEach(function (u, i) { cats[u] = (p.imageCategories || [])[i] || ''; });
    (p.selectedImageUrls || []).forEach(function (u, i) { if ((p.selectedImageCategories || [])[i]) cats[u] = p.selectedImageCategories[i]; });
    out[rid] = { fields: fields, all: all, selected: sel, cats: cats, comment: String(r.values[14] || ''), url: _crmSourceUrl_(p) };
  });
  return out;
}

/** 直した中身を保存する（送らない）。同じ部屋の行が複数あれば全部に書く。 */
function saveCrmPropertyEdit(customerName, roomId, fields, images, comment) {
  var rows = _findRowsByRoomIdsAnyStatus_(customerName, [roomId]);
  if (!rows.length) throw new Error('この物件が見つかりません（片付けられた可能性があります）');
  var base = _rowToPropertyBase_(rows[0].values);
  // 元の値と違う項目だけを「直した」として残す
  var ed = {};
  CRM_EDIT_FIELDS_.forEach(function (k) {
    if (!fields || fields[k] === undefined) return;
    var v = String(fields[k]);
    if (v === _crmFieldStr_(base, k)) return;
    if (k === 'otherStations') ed[k] = v.split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    else if (k === 'rent' || k === 'managementFee' || k === 'area') ed[k] = Number(v.replace(/[,，円]/g, '')) || 0;
    else ed[k] = v;
  });
  var old = {};
  try { old = rowToProperty(rows[0].values); } catch (e) {}
  var cats = {};
  (old.imageUrls || []).forEach(function (u, i) { cats[u] = (old.imageCategories || [])[i] || ''; });
  (old.selectedImageUrls || []).forEach(function (u, i) { if ((old.selectedImageCategories || [])[i]) cats[u] = old.selectedImageCategories[i]; });
  images = (images || []).filter(function (u) { return u; });
  var origCats = images.map(function (u) { return cats[u] || ''; });
  var hosted = images.length ? persistImageUrls_(images) : [];
  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PENDING_SHEET_NAME);
  comment = String(comment || '').trim();
  rows.forEach(function (r) {
    _savePendingEditedFields_(r.rowIndex, ed);
    if (hosted.length) saveSelectedImages(r.rowIndex, hosted, origCats);
    sheet.getRange(r.rowIndex, 15).setValue(comment);   // O列: 一言（空にしたら消す）
    try { cfSyncRows(PENDING_SHEET_NAME, [r.rowIndex], '物件の修正'); } catch (eCf) {}
  });
  try { CacheService.getScriptCache().removeAll(['prop2_' + customerName + '_' + roomId, 'imgs_' + customerName + '_' + roomId]); } catch (e) {}
  return { roomId: String(roomId), images: hosted, comment: comment, edited: Object.keys(ed).length > 0 || hosted.length > 0 };
}

// ── キャンセル待ち（通知済み物件シートの J列に印。空室確認で空いたら Discord に知らせる仕組みは既存のまま）──
/** 顧客名 → キャンセル待ちの物件一覧。 */
function _crmWatchAll_() {
  var out = {};
  try {
    var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SEEN_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return out;
    var data = sh.getRange(2, 1, sh.getLastRow() - 1, 16).getValues();
    var fmt = function (v) {
      if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'M/d H:mm');
      var m = String(v || '').match(/^\d{4}-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
      return m ? (Number(m[1]) + '/' + Number(m[2]) + ' ' + Number(m[3]) + ':' + m[4]) : String(v || '');
    };
    for (var i = 0; i < data.length; i++) {
      if (!data[i][9]) continue;   // J列: キャンセル待ちの印
      var name = String(data[i][0] || '').trim();
      var src = String(data[i][4] || ''), ref = String(data[i][7] || '');
      var url = '';
      if (src === 'reins' || /^\d{6,}$/.test(ref.replace(/\D/g, '')) && ref.indexOf('http') !== 0) {
        var num = ref.replace(/\D/g, '');
        if (num) url = 'https://system.reins.jp/main/BK/GBK004100#bukken=' + num;
      } else if (ref.indexOf('http') === 0) url = ref;
      (out[name] = out[name] || []).push({
        roomId: String(data[i][1] || '').trim(), building: String(data[i][2] || ''), room: String(data[i][15] || ''),
        status: String(data[i][13] || '') === 'closed' ? 'closed' : String(data[i][5] || ''),
        checkedAt: fmt(data[i][6]), since: fmt(data[i][9]), url: url,
        watchOnly: String(data[i][14] || '').trim() === 'watch_only', sent: !!data[i][3]
      });
    }
  } catch (e) { console.warn('[キャンセル待ち] 読めません: ' + e.message); }
  return out;
}

/** 画面: 送った物件のキャンセル待ちを付ける／外す。 */
function setCrmWatch(customerName, roomId, on) {
  var r = setCancellationWatch(customerName, roomId, !!on);
  if (!r.ok) throw new Error(r.message);
  var page = _crmTreeForPage_(customerName);
  page.savedMessage = r.message;
  return page;
}

/** 画面: まだ送っていない新着をキャンセル待ちにする（申込ありの部屋など）。新着からは消え、キャンセル待ちに並ぶ。 */
function addCrmWatchFromPending(customerName, roomId) {
  var rows = _findRowsByRoomIdsAnyStatus_(customerName, [roomId]);
  if (!rows.length) throw new Error('この物件が見つかりません');
  var p = rowToProperty(rows[0].values);
  var r = addCancellationWatchOnly(customerName, {
    roomId: String(roomId), buildingName: p.buildingName, roomNumber: p.roomNumber,
    source: p.source, url: p.url, reinsPropertyNumber: p.reins_property_number
  });
  if (!r.ok) throw new Error(r.message);
  var page = _crmTreeForPage_(customerName);
  page.savedMessage = r.message;
  return page;
}

/** 画面: 送った物件を募集終了にする／募集中に戻す（お客様の物件ページ・地図に「募集終了」と出る）。送った物件の一覧を返す。 */
function setCrmClosed(customerName, roomId, closed) {
  var r = setManualClosed(customerName, roomId, !!closed);
  if (!r.ok) throw new Error(r.message);
  return { list: getCrmSentProps(customerName), message: r.message };
}

/**
 * 送った記録（通知済み物件シート）を付ける。もう行があれば送った日だけ新しくする。
 * ⚠️ 送り直し・見送った物件をやっぱり送るときに addToSeenSheet をそのまま呼ぶと、同じ物件の行が増える。
 */
function _crmMarkSeen_(customerName, prop) {
  try {
    var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SEEN_SHEET_NAME);
    if (sh && sh.getLastRow() > 1) {
      var keys = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
      for (var i = 0; i < keys.length; i++) {
        if (String(keys[i][0]).trim() === customerName && String(keys[i][1]).trim() === String(prop.roomId)) {
          var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
          sh.getRange(i + 2, 4).setValue(now);                                         // D列: 送った日
          if (String(sh.getRange(i + 2, 15).getValue()) === 'watch_only') sh.getRange(i + 2, 15).setValue('');   // もう「送っていない」ではない
          return;
        }
      }
    }
  } catch (e) { console.warn('[送った記録] ' + e.message); }
  addToSeenSheet(customerName, prop);
}

/** 画面: 見送った物件の一覧（新しい順・60件まで）。 */
function getCrmSkippedProps(customerName) {
  var out = [];
  var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PENDING_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return out;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 15).getValues();
  var seenRid = {};
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0] || '').trim() !== customerName || String(data[i][10]) !== 'skipped') continue;
    var rid = String(data[i][2] || '');
    var p; try { p = rowToProperty(data[i]); } catch (e) { continue; }
    var imgs = (p.selectedImageUrls && p.selectedImageUrls.length) ? p.selectedImageUrls : (p.imageUrls || []);
    var ms = _cellToEpochMs_(data[i][12]);
    out.push({ roomId: rid, building: p.buildingName || '', room: p.roomNumber || '',
      rent: p.rent || '', fee: p.managementFee || '', layout: p.layout || '', area: p.area || '', station: p.stationInfo || '',
      image: imgs[0] || '', comment: String(data[i][14] || ''), ms: ms, url: _crmSourceUrl_(p),
      at: ms ? Utilities.formatDate(new Date(ms), 'Asia/Tokyo', 'M/d') : '' });
  }
  return out.sort(function (a, b) { return b.ms - a.ms; }).filter(function (x) {
    if (seenRid[x.roomId]) return false; seenRid[x.roomId] = true; return true;
  }).slice(0, 60);
}

/** 画面: 送った・見送ったの一覧をまとめて取る（お客様を選んだときに裏で取って、タブの件数を出す）。 */
function getCrmPropLists(customerName) {
  var o = {}; o[customerName] = true;
  return _crmPropListsFor_(o)[customerName] || { sent: [], skipped: [] };
}

/** 画面: 見送った物件を新着に戻す。 */
function unskipCrmProperty(customerName, roomId) {
  var rows = _findRowsByRoomIdsAnyStatus_(customerName, [roomId]);
  var n = 0;
  rows.forEach(function (r) { if (String(r.values[10]) === 'skipped') { updatePendingStatus(r.rowIndex, 'pending', ''); n++; } });
  if (!n) throw new Error('見送った物件が見つかりません');
  var page = _crmTreeForPage_(customerName);
  page.savedMessage = '新着に戻しました';
  return page;
}

/**
 * 画面: 送った・見送ったの一覧を、全員分まとめて1回で取る（ページを開いたあと裏で取っておき、名前を押したら一瞬で出す）。
 * シートは承認待ち・通知済みを1回ずつ読むだけ。終了・成約の人は除く。
 */
function getCrmPropListsAll(nameList) {
  var names = {};
  (nameList || []).forEach(function (n) { names[String(n)] = true; });
  return _crmPropListsFor_(names);
}

function _crmPropListsFor_(names) {
  var out = {};
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var closedBy = {};
  try {
    var seenSh = ss.getSheetByName(SEEN_SHEET_NAME);
    if (seenSh && seenSh.getLastRow() > 1) {
      seenSh.getRange(2, 1, seenSh.getLastRow() - 1, 14).getValues().forEach(function (r) {
        var n = String(r[0] || '').trim();
        if (!names[n]) return;
        var k = n + '|' + String(r[1] || '').trim();
        if (String(r[13] || '') === 'closed') closedBy[k] = 'manual';
        else if (String(r[5] || '') === 'closed' && !closedBy[k]) closedBy[k] = 'auto';
      });
    }
  } catch (eC) {}
  var sh = ss.getSheetByName(PENDING_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return out;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 15).getValues();
  for (var i = 0; i < data.length; i++) {
    var n = String(data[i][0] || '').trim();
    if (!names[n]) continue;
    var st = String(data[i][10]);
    if (st !== 'sent' && st !== 'skipped') continue;
    var p; try { p = rowToProperty(data[i]); } catch (e) { continue; }
    var rid = String(data[i][2] || '');
    var imgs = (p.selectedImageUrls && p.selectedImageUrls.length) ? p.selectedImageUrls : (p.imageUrls || []);
    var ms = _cellToEpochMs_(data[i][12]);
    var day = ms ? Utilities.formatDate(new Date(ms), 'Asia/Tokyo', 'M/d') : '';
    var item = { roomId: rid, building: p.buildingName || '', room: p.roomNumber || '',
      rent: p.rent || '', fee: p.managementFee || '', layout: p.layout || '', area: p.area || '', station: p.stationInfo || '',
      image: imgs[0] || '', comment: String(data[i][14] || ''), ms: ms, url: _crmSourceUrl_(p) };
    var o = out[n] = out[n] || { sent: [], skipped: [] };
    if (st === 'sent') { item.sentAt = day; item.closed = closedBy[n + '|' + rid] || ''; o.sent.push(item); }
    else { item.at = day; o.skipped.push(item); }
  }
  var uniq = function (list) {
    var seen = {};
    return list.sort(function (a, b) { return b.ms - a.ms; }).filter(function (x) { if (seen[x.roomId]) return false; seen[x.roomId] = true; return true; }).slice(0, 60);
  };
  Object.keys(out).forEach(function (n) { out[n].sent = uniq(out[n].sent); out[n].skipped = uniq(out[n].skipped); });
  return out;
}

/** 元のページのアドレス。REINSは物件のアドレスを持たないので、物件番号から詳細ページを開くリンクを作る（拡張が開いてくれる）。 */
function _crmSourceUrl_(p) {
  if (p && p.url) return String(p.url);
  var num = String((p && (p.reins_property_number || p.reinsPropertyNumber)) || '').replace(/\D/g, '');
  return num ? 'https://system.reins.jp/main/BK/GBK004100#bukken=' + num : '';
}
