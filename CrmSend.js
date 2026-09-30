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
  try {
    var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PENDING_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return out;
    var data = sh.getRange(2, 1, sh.getLastRow() - 1, 14).getValues();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][10]) !== 'pending') continue;
      var name = String(data[i][0] || '').trim();
      if (!name) continue;
      var p;
      try { p = rowToProperty(data[i]); } catch (e) { continue; }
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
        found: (data[i][11] instanceof Date) ? Utilities.formatDate(data[i][11], 'Asia/Tokyo', 'M/d') : ''
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
      var viewUrl = _bestViewUrl_(customerName, rid, prop, { staffComment: '' });
      cachePropertyImages(customerName, rid, sel, prop.selectedImageCategories || []);
      var flex = buildPropertyFlex(prop, { includeImage: sel.length > 0, heroImageUrls: sel, viewUrl: viewUrl, customerStations: stations });
      if (flex && flex.contents) bubbles.push(flex.contents);
      sentTargets.push({ rowIndex: r.rowIndex, prop: prop, viewUrl: viewUrl });
    });
    messages = _splitBubblesIntoCarousels_(bubbles, text ? text.split('\n')[0].substring(0, 100) : 'お探しの物件が見つかりました');
  }
  // スタッフの一言は、物件のあとに普通の文で（カードにしない）
  if (text) messages.push(textMsg(text));
  for (var m = 0; m < messages.length; m += 5) pushMessage(uid, messages.slice(m, m + 5));

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
