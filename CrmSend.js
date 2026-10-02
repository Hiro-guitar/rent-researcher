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
function _crmPendingAll_(crits) {
  var out = {};
  // ⚠️ どこから送ったものでも、送り済みは新着に出さない（2026-10-02）。
  //   Discord の承認ページなど別の経路で送ると、承認待ちの行が pending のまま残ることがある。
  //   「送った」の記録は通知済み物件シートに必ず入る（addToSeenSheet）ので、そちらで照らし合わせる。
  var seen = {};
  try {
    var ss0 = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SEEN_SHEET_NAME);
    if (ss0 && ss0.getLastRow() > 1) {
      ss0.getRange(2, 1, ss0.getLastRow() - 1, 2).getValues().forEach(function (r) {
        seen[String(r[0] || '').trim() + '|' + String(r[1] || '').trim()] = true;
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
      var room = String(p.roomNumber || '').replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }).replace(/\D/g, '');
      return room ? name + '|' + norm(p.buildingName) + '|' + room : '';   // 部屋番号が無ければ建物だけでは決めない
    };
    var sentKeys = {};
    for (var j = 0; j < data.length; j++) {
      if (String(data[j][10]) !== 'sent') continue;
      try { var k0 = bkey(String(data[j][0] || '').trim(), rowToProperty(data[j])); if (k0) sentKeys[k0] = true; } catch (_e0) {}
    }
    var shown = {};
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][10]) !== 'pending') continue;
      var name = String(data[i][0] || '').trim();
      if (!name) continue;
      if (seen[name + '|' + String(data[i][2] || '').trim()]) continue;   // もう送った
      var p;
      try { p = rowToProperty(data[i]); } catch (e) { continue; }
      var k = bkey(name, p);
      if (k && (sentKeys[k] || shown[k])) continue;   // 同じ部屋を送った／もう一覧に出した
      if (k) shown[k] = true;
      var cr = (crits && crits[name]) || {};
      var warn = '';
      try { warn = _computePropertyWarningsGAS_(p, (cr.equipment || []).join(','), cr.notes || '') || ''; } catch (_w) {}
      var imgs = (p.imageUrls && p.imageUrls.length) ? p.imageUrls : (p.imageUrl ? [p.imageUrl] : []);
      (out[name] = out[name] || []).push({
        roomId: String(data[i][2] || ''),
        building: p.buildingName || '', room: p.roomNumber || '',
        rent: p.rent || '', fee: p.managementFee || '', layout: p.layout || '', area: p.area || '',
        station: p.stationInfo || '', age: p.buildingAge || '', floor: p.floorText || '',
        image: imgs[0] || '', images: imgs.slice(0, 6), url: p.url || '',
        warnings: String(warn).split('\n').filter(function (s) { return s; }),
        found: (data[i][11] instanceof Date) ? Utilities.formatDate(data[i][11], 'Asia/Tokyo', 'M/d') : '',
        comment: String(data[i][14] || '')   // O列: 担当者コメント（別の人から引き継いだものも）
      });
    }
  } catch (e) { console.warn('[送る物件] 承認待ちを読めません: ' + e.message); }
  return out;
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
    rows.forEach(function (r) {
      var prop = rowToProperty(r.values);
      var rid = String(r.values[2]);
      var sel = (prop.selectedImageUrls && prop.selectedImageUrls.length) ? prop.selectedImageUrls
        : (prop.imageUrls && prop.imageUrls.length ? prop.imageUrls : (prop.imageUrl ? [prop.imageUrl] : []));
      // ⚠️ 担当者コメント（O列）を必ず載せること。以前は読んでおらず、カードにコメントが出ていなかった
      var comment = String(r.values[14] || '').trim();
      var viewUrl = _bestViewUrl_(customerName, rid, prop, { staffComment: comment });
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

  sentTargets.forEach(function (t) {
    updatePendingStatus(t.rowIndex, 'sent', t.viewUrl);
    addToSeenSheet(customerName, t.prop);
  });
  addContactLog(customerName, 'LINE', new Date().toISOString(),
    (sentTargets.length ? '物件' + sentTargets.length + '件' : '') + (sentTargets.length && text ? '＋' : '') + (text ? '一言: ' + text.substring(0, 60) : ''));
  var page = _crmTreeForPage_();
  page.savedMessage = (sentTargets.length ? '物件' + sentTargets.length + '件' : '') + (sentTargets.length && text ? 'と一言' : (text ? '一言' : '')) + 'を送りました';
  return page;
}

/** 画面: 承認待ちの物件を見送る（送らない）。 */
function skipCrmProperty(customerName, roomId) {
  var rows = _findRowsByRoomIdsAnyStatus_(customerName, [roomId]);
  rows.forEach(function (r) { if (String(r.values[10]) === 'pending') updatePendingStatus(r.rowIndex, 'skipped', ''); });
  return _crmTreeForPage_();
}

/** 画面: 文だけ LINE Chat で手で送ったときの記録（コピーボタン）。 */
function logCrmManualMessage(customerName, text) {
  addContactLog(customerName, 'LINE', new Date().toISOString(), 'LINE Chat で送信: ' + String(text || '').substring(0, 60));
  return _crmTreeForPage_();
}

/** 画面: その人に送った物件（最近20件）。「別の人にも送る」の元にする。 */
function getCrmSentProps(customerName) {
  var out = [];
  var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PENDING_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return out;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 15).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0] || '').trim() !== customerName || String(data[i][10]) !== 'sent') continue;
    var p; try { p = rowToProperty(data[i]); } catch (e) { continue; }
    var imgs = (p.selectedImageUrls && p.selectedImageUrls.length) ? p.selectedImageUrls : (p.imageUrls || []);
    var ms = _cellToEpochMs_(data[i][12]);
    out.push({ roomId: String(data[i][2] || ''), building: p.buildingName || '', room: p.roomNumber || '',
      rent: p.rent || '', fee: p.managementFee || '', layout: p.layout || '', area: p.area || '', station: p.stationInfo || '',
      image: imgs[0] || '', comment: String(data[i][14] || ''), ms: ms,
      sentAt: ms ? Utilities.formatDate(new Date(ms), 'Asia/Tokyo', 'M/d') : '' });
  }
  return out.sort(function (a, b) { return b.ms - a.ms; }).slice(0, 20);
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
  var page = _crmTreeForPage_();
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
  var page = _crmTreeForPage_();
  page.savedMessage = '家族のLINEに物件' + bubbles.length + '件を送りました';
  return page;
}
