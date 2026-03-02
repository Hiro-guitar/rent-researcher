/**
 * PropertyApproval.gs — 物件承認・プレビュー・物件資料ページ
 *
 * 承認フロー:
 *   approve → プレビューページ表示 → confirm_approve → LINE送信
 *   approve_all → 一括プレビュー → confirm_approve_all → LINE送信
 *   skip → スキップ
 *   view → お客さん向け物件資料ページ
 */

var PENDING_SHEET_NAME = '承認待ち物件';
var SEEN_SHEET_NAME = '通知済み物件';
var SPREADSHEET_ID = '1u6NHowKJNqZm_Qv-MQQEDzMWjPOJfJiX1yhaO4Wj6lY';

// ===== GAS Base URL =====
function getGasBaseUrl() {
  return ScriptApp.getService().getUrl();
}

// ===== 承認プレビュー（単一物件） =====
function handleApprove(e) {
  var customerName = e.parameter.customer;
  var roomId = e.parameter.room_id;

  if (!customerName || !roomId) {
    return makeHtml('エラー', 'パラメータが不足しています。');
  }

  var row = findPendingRow(customerName, roomId);
  if (!row) {
    return makeHtml('注意', '該当の承認待ち物件が見つかりません。\n既に処理済みの可能性があります。');
  }

  var prop = rowToProperty(row.values);
  return makePreviewHtml(prop, customerName, roomId);
}

// ===== 承認プレビュー（一括） =====
function handleApproveAll(e) {
  var customerName = e.parameter.customer;

  if (!customerName) {
    return makeHtml('エラー', '顧客名が指定されていません。');
  }

  var rows = findAllPendingRows(customerName);
  if (!rows || rows.length === 0) {
    return makeHtml('注意', customerName + ' さんの承認待ち物件がありません。');
  }

  var props = [];
  for (var i = 0; i < rows.length; i++) {
    var p = rowToProperty(rows[i].values);
    p._rowIndex = rows[i].rowIndex;
    p._roomId = rows[i].values[2];
    props.push(p);
  }

  return makePreviewAllHtml(props, customerName);
}

// ===== 確認後LINE送信（単一） =====
function handleConfirmApprove(e) {
  var customerName = e.parameter.customer;
  var roomId = e.parameter.room_id;
  var includeImage = e.parameter.include_image !== '0';
  // 選択された画像インデックス（カンマ区切り）
  var selectedIndices = (e.parameter.selected_images || '').split(',').filter(function(s) { return s !== ''; });

  if (!customerName || !roomId) {
    return makeHtml('エラー', 'パラメータが不足しています。');
  }

  var row = findPendingRow(customerName, roomId);
  if (!row) {
    return makeHtml('注意', '該当の承認待ち物件が見つかりません。\n既に処理済みの可能性があります。');
  }

  var lineUserId = findLineUserId(customerName);
  if (!lineUserId) {
    return makeHtml('エラー', customerName + ' さんの LINE ユーザーが見つかりません。');
  }

  var prop = rowToProperty(row.values);

  // 選択された画像URLを決定
  var selectedImageUrls = [];
  if (includeImage && selectedIndices.length > 0 && prop.imageUrls.length > 0) {
    for (var i = 0; i < selectedIndices.length; i++) {
      var idx = parseInt(selectedIndices[i], 10);
      if (!isNaN(idx) && idx >= 0 && idx < prop.imageUrls.length) {
        selectedImageUrls.push(prop.imageUrls[idx]);
      }
    }
  } else if (includeImage && prop.imageUrl) {
    // フォールバック: 旧形式（image_urls がない場合）
    selectedImageUrls = [prop.imageUrl];
  }

  // 選択画像をシートに保存（viewページで使用）
  if (selectedImageUrls.length > 0) {
    saveSelectedImages(row.rowIndex, selectedImageUrls);
  }

  var viewUrl = 'https://form.ehomaki.com/property.html?customer=' + encodeURIComponent(customerName) + '&room_id=' + roomId;

  var flex = buildPropertyFlex(prop, {
    includeImage: selectedImageUrls.length > 0,
    heroImageUrl: selectedImageUrls.length > 0 ? selectedImageUrls[0] : '',
    viewUrl: viewUrl
  });

  pushMessage(lineUserId, [flex]);
  updatePendingStatus(row.rowIndex, 'sent');
  addToSeenSheet(customerName, prop);

  return makeHtml('完了', prop.buildingName + ' を ' + customerName + ' さんに LINE 送信しました。');
}

// ===== 確認後LINE送信（一括） =====
function handleConfirmApproveAll(e) {
  var customerName = e.parameter.customer;
  var imageRoomIds = (e.parameter.images || '').split(',').filter(function(s) { return s; });

  if (!customerName) {
    return makeHtml('エラー', '顧客名が指定されていません。');
  }

  var rows = findAllPendingRows(customerName);
  if (!rows || rows.length === 0) {
    return makeHtml('注意', customerName + ' さんの承認待ち物件がありません。');
  }

  var lineUserId = findLineUserId(customerName);
  if (!lineUserId) {
    return makeHtml('エラー', customerName + ' さんの LINE ユーザーが見つかりません。');
  }

  var sentCount = 0;

  for (var i = 0; i < rows.length; i++) {
    var prop = rowToProperty(rows[i].values);
    var rid = String(rows[i].values[2]);
    var includeImage = imageRoomIds.indexOf(rid) !== -1;
    var viewUrl = 'https://form.ehomaki.com/property.html?customer=' + encodeURIComponent(customerName) + '&room_id=' + rid;

    // 画像を含める場合、全画像を選択済みとして保存
    var selectedUrls = [];
    if (includeImage) {
      selectedUrls = prop.imageUrls && prop.imageUrls.length > 0 ? prop.imageUrls : (prop.imageUrl ? [prop.imageUrl] : []);
      if (selectedUrls.length > 0) {
        saveSelectedImages(rows[i].rowIndex, selectedUrls);
      }
    }

    var flex = buildPropertyFlex(prop, {
      includeImage: includeImage,
      heroImageUrl: selectedUrls.length > 0 ? selectedUrls[0] : '',
      viewUrl: viewUrl
    });

    pushMessage(lineUserId, [flex]);
    updatePendingStatus(rows[i].rowIndex, 'sent');
    addToSeenSheet(customerName, prop);
    sentCount++;

    if (i < rows.length - 1) {
      Utilities.sleep(500);
    }
  }

  return makeHtml('完了', customerName + ' さんに ' + sentCount + ' 件の物件を LINE 送信しました。');
}

// ===== 単一物件スキップ =====
function handleSkip(e) {
  var customerName = e.parameter.customer;
  var roomId = e.parameter.room_id;

  if (!customerName || !roomId) {
    return makeHtml('エラー', 'パラメータが不足しています。');
  }

  var row = findPendingRow(customerName, roomId);
  if (!row) {
    return makeHtml('注意', '該当の承認待ち物件が見つかりません。');
  }

  updatePendingStatus(row.rowIndex, 'skipped');
  return makeHtml('完了', '物件をスキップしました。');
}

// ===== お客さん向け物件資料ページ =====
function handlePropertyView(e) {
  var customerName = e.parameter.customer;
  var roomId = e.parameter.room_id;

  if (!customerName || !roomId) {
    return makeHtml('エラー', 'パラメータが不足しています。');
  }

  // sent の物件のみ表示（セキュリティ）
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (!sheet) {
    return makeHtml('エラー', 'シートが見つかりません。');
  }

  var data = sheet.getDataRange().getValues();
  var prop = null;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(customerName) &&
        String(data[i][2]) === String(roomId) &&
        String(data[i][10]) === 'sent') {
      prop = rowToProperty(data[i]);
      break;
    }
  }

  if (!prop) {
    return makeHtml('注意', 'この物件情報は表示できません。');
  }

  return makeViewHtml(prop);
}

// ===== お客さん向け物件資料 JSON API（GitHub Pages から呼ばれる） =====
function handlePropertyViewApi(e) {
  var customerName = e.parameter.customer;
  var roomId = e.parameter.room_id;

  if (!customerName || !roomId) {
    return ContentService.createTextOutput(JSON.stringify({error: 'パラメータが不足しています。'}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // sent の物件のみ表示（セキュリティ）
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({error: 'シートが見つかりません。'}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var data = sheet.getDataRange().getValues();
  var prop = null;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(customerName) &&
        String(data[i][2]) === String(roomId) &&
        String(data[i][10]) === 'sent') {
      prop = rowToProperty(data[i]);
      break;
    }
  }

  if (!prop) {
    return ContentService.createTextOutput(JSON.stringify({error: 'この物件情報は表示できません。'}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 表示する画像: 承認時に選択されたものがあればそれ、なければ全画像
  var viewImages = prop.selectedImageUrls || prop.imageUrls || [];
  if (viewImages.length === 0 && prop.imageUrl) {
    viewImages = [prop.imageUrl];
  }

  var result = {
    buildingName: prop.buildingName,
    roomNumber: prop.roomNumber,
    rent: prop.rent,
    managementFee: prop.managementFee,
    layout: prop.layout,
    area: prop.area,
    buildingAge: prop.buildingAge,
    floor: prop.floor,
    stationInfo: prop.stationInfo,
    address: prop.address,
    deposit: prop.deposit,
    keyMoney: prop.keyMoney,
    images: viewImages
  };

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== シート操作 =====
function findPendingRow(customerName, roomId) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (!sheet) return null;

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(customerName) &&
        String(data[i][2]) === String(roomId) &&
        String(data[i][10]) === 'pending') {
      return { rowIndex: i + 1, values: data[i] };
    }
  }
  return null;
}

function findAllPendingRows(customerName) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (!sheet) return [];

  var data = sheet.getDataRange().getValues();
  var results = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(customerName) &&
        String(data[i][10]) === 'pending') {
      results.push({ rowIndex: i + 1, values: data[i] });
    }
  }
  return results;
}

function updatePendingStatus(rowIndex, newStatus) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  sheet.getRange(rowIndex, 11).setValue(newStatus);
  sheet.getRange(rowIndex, 13).setValue(new Date().toISOString().replace('T', ' ').substring(0, 19));
}

function addToSeenSheet(customerName, prop) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SEEN_SHEET_NAME);
  if (!sheet) return;
  sheet.appendRow([
    customerName,
    prop.roomId,
    prop.buildingName,
    new Date().toISOString().replace('T', ' ').substring(0, 19)
  ]);
}

// ===== データ変換 =====
function rowToProperty(row) {
  var extra = {};
  try { extra = JSON.parse(row[9] || '{}'); } catch(e) {}
  return {
    customerName: row[0],
    buildingId: row[1],
    roomId: row[2],
    buildingName: row[3] || '',
    rent: Number(row[4]) || 0,
    managementFee: Number(row[5]) || 0,
    layout: row[6] || '',
    area: Number(row[7]) || 0,
    stationInfo: row[8] || '',
    deposit: extra.deposit || '',
    keyMoney: extra.key_money || '',
    address: extra.address || '',
    url: extra.url || '',
    imageUrl: extra.image_url || '',
    imageUrls: extra.image_urls || [],
    selectedImageUrls: extra.selected_image_urls || null,
    roomNumber: extra.room_number || '',
    buildingAge: extra.building_age || '',
    floor: extra.floor || 0
  };
}

// 確認時に選択された画像URLをシートのJSONに保存
function saveSelectedImages(rowIndex, selectedImageUrls) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  var cell = sheet.getRange(rowIndex, 10); // J列
  var extra = {};
  try { extra = JSON.parse(cell.getValue() || '{}'); } catch(e) {}
  extra.selected_image_urls = selectedImageUrls;
  cell.setValue(JSON.stringify(extra));
}

// ===== Flex Message =====
function buildPropertyFlex(prop, options) {
  options = options || {};
  var includeImage = options.includeImage !== false;
  var viewUrl = options.viewUrl || '';

  var rentMan = prop.rent ? (prop.rent / 10000).toFixed(1) : '0';
  var mgmtMan = prop.managementFee ? (prop.managementFee / 10000).toFixed(1) : '0';

  var bodyContents = [
    { type: 'text', text: prop.buildingName + (prop.roomNumber ? ' ' + prop.roomNumber : ''), weight: 'bold', size: 'lg', wrap: true },
    { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
      { type: 'text', text: rentMan + '\u4E07\u5186', weight: 'bold', size: 'xl', color: '#E05252' },
      { type: 'text', text: '\u7BA1\u7406\u8CBB ' + mgmtMan + '\u4E07\u5186', size: 'sm', color: '#999999', flex: 0 }
    ]},
    { type: 'separator', margin: 'lg' }
  ];

  var details = [];
  if (prop.layout) details.push(['\u9593\u53D6\u308A', prop.layout]);
  if (prop.area) details.push(['\u9762\u7A4D', prop.area + 'm\u00B2']);
  if (prop.buildingAge) details.push(['\u7BC9\u5E74\u6570', prop.buildingAge]);
  if (prop.floor) details.push(['\u968E\u6570', prop.floor + '\u968E']);
  if (prop.address) details.push(['\u6240\u5728\u5730', prop.address]);
  if (prop.stationInfo) details.push(['\u6700\u5BC4\u99C5', prop.stationInfo]);
  if (prop.deposit || prop.keyMoney) {
    details.push(['\u6577\u91D1/\u793C\u91D1', (prop.deposit || '\u306A\u3057') + ' / ' + (prop.keyMoney || '\u306A\u3057')]);
  }

  for (var i = 0; i < details.length; i++) {
    bodyContents.push({
      type: 'box', layout: 'horizontal', margin: 'md', contents: [
        { type: 'text', text: details[i][0], size: 'sm', color: '#555555', flex: 2 },
        { type: 'text', text: details[i][1], size: 'sm', color: '#111111', flex: 5, wrap: true }
      ]
    });
  }

  var bubble = { type: 'bubble', size: 'mega' };

  var heroUrl = options.heroImageUrl || prop.imageUrl || '';
  if (includeImage && heroUrl) {
    bubble.hero = {
      type: 'image', url: heroUrl, size: 'full',
      aspectRatio: '20:13', aspectMode: 'cover'
    };
  }

  bubble.body = { type: 'box', layout: 'vertical', spacing: 'md', contents: bodyContents };

  if (viewUrl) {
    bubble.footer = {
      type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#00AAFF',
          action: { type: 'uri', label: '\u7269\u4EF6\u8A73\u7D30\u3092\u898B\u308B', uri: viewUrl }
        }
      ]
    };
  }

  return {
    type: 'flex',
    altText: prop.buildingName + ' - ' + rentMan + '\u4E07\u5186',
    contents: bubble
  };
}

// ===== HTML: 簡易レスポンス =====
function makeHtml(title, message) {
  var html = '<html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5}'
    + '.card{background:#fff;border-radius:12px;padding:30px;max-width:400px;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,0.1)}'
    + 'h2{color:#333;margin-bottom:16px}.msg{color:#555;line-height:1.6}'
    + '.ok{color:#4CAF50}.err{color:#E05252}.warn{color:#FF9800}</style></head>'
    + '<body><div class="card">';
  if (title === '\u5B8C\u4E86') {
    html += '<h2 class="ok">\u2705 ' + title + '</h2>';
  } else if (title === '\u30A8\u30E9\u30FC') {
    html += '<h2 class="err">\u274C ' + title + '</h2>';
  } else {
    html += '<h2 class="warn">\u26A0\uFE0F ' + title + '</h2>';
  }
  html += '<p class="msg">' + message + '</p>';
  html += '</div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(title)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== HTML: 承認プレビュー（単一） =====
function makePreviewHtml(prop, customerName, roomId) {
  var baseUrl = getGasBaseUrl();
  var rentMan = prop.rent ? (prop.rent / 10000).toFixed(1) : '0';
  var mgmtMan = prop.managementFee ? (prop.managementFee / 10000).toFixed(1) : '0';

  // 表示する画像リスト（image_urls があればそちら、なければ image_url のみ）
  var images = prop.imageUrls && prop.imageUrls.length > 0 ? prop.imageUrls : (prop.imageUrl ? [prop.imageUrl] : []);

  var html = '<html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;padding:16px;background:#f0f2f5}'
    + '.card{background:#fff;border-radius:12px;padding:20px;max-width:600px;margin:0 auto;box-shadow:0 2px 12px rgba(0,0,0,0.1)}'
    + 'h2{color:#333;margin:0 0 16px;font-size:18px}'
    + '.prop-name{font-size:20px;font-weight:bold;color:#222;margin-bottom:4px}'
    + '.price{font-size:24px;font-weight:bold;color:#E05252;margin:8px 0}'
    + '.price-sub{font-size:14px;color:#888;font-weight:normal}'
    + '.detail{display:flex;padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:14px}'
    + '.detail-label{color:#888;width:80px;flex-shrink:0}'
    + '.detail-value{color:#333;flex:1}'
    + '.images-title{font-size:15px;font-weight:bold;color:#333;margin:16px 0 8px;display:flex;align-items:center;justify-content:space-between}'
    + '.images-title .count{font-size:13px;color:#888;font-weight:normal}'
    + '.select-btns{font-size:12px;color:#4CAF50;cursor:pointer;margin-left:8px}'
    + '.select-btns span{margin-left:8px;text-decoration:underline;cursor:pointer}'
    + '.img-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin:8px 0}'
    + '.img-item{position:relative;border-radius:8px;overflow:hidden;border:3px solid #4CAF50;transition:border-color 0.2s,opacity 0.2s}'
    + '.img-item.unchecked{border-color:#ddd;opacity:0.5}'
    + '.img-item img{width:100%;height:120px;object-fit:cover;display:block;cursor:pointer}'
    + '.img-item .cb-wrap{position:absolute;top:4px;left:4px;z-index:2}'
    + '.img-item .cb-wrap input{width:18px;height:18px;cursor:pointer}'
    + '.img-item .idx{position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.6);color:#fff;font-size:11px;padding:2px 6px;border-radius:4px}'
    + '.actions{margin-top:20px;text-align:center}'
    + '.btn{display:inline-block;padding:12px 32px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;cursor:pointer;border:none}'
    + '.btn-approve{background:#4CAF50;color:#fff;margin-bottom:12px}'
    + '.btn-skip{background:none;color:#999;font-size:14px;text-decoration:underline;border:none;cursor:pointer}'
    + '.modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:100;justify-content:center;align-items:center}'
    + '.modal-overlay.active{display:flex}'
    + '.modal-overlay img{max-width:95%;max-height:90vh;object-fit:contain}'
    + '.modal-close{position:fixed;top:16px;right:16px;color:#fff;font-size:32px;cursor:pointer;z-index:101}'
    + '</style></head><body><div class="card">'
    + '<h2>\uD83D\uDD0D \u627F\u8A8D\u30D7\u30EC\u30D3\u30E5\u30FC</h2>'
    + '<div class="prop-name">' + _esc(prop.buildingName) + (prop.roomNumber ? ' ' + _esc(prop.roomNumber) : '') + '</div>'
    + '<div class="price">' + rentMan + '\u4E07\u5186 <span class="price-sub">\u7BA1\u7406\u8CBB ' + mgmtMan + '\u4E07\u5186</span></div>';

  var details = [];
  if (prop.layout) details.push(['\u9593\u53D6\u308A', prop.layout]);
  if (prop.area) details.push(['\u9762\u7A4D', prop.area + 'm\u00B2']);
  if (prop.buildingAge) details.push(['\u7BC9\u5E74\u6570', prop.buildingAge]);
  if (prop.stationInfo) details.push(['\u6700\u5BC4\u99C5', prop.stationInfo]);
  if (prop.address) details.push(['\u6240\u5728\u5730', prop.address]);
  if (prop.deposit || prop.keyMoney) details.push(['\u6577/\u793C', (prop.deposit || '\u306A\u3057') + ' / ' + (prop.keyMoney || '\u306A\u3057')]);

  for (var i = 0; i < details.length; i++) {
    html += '<div class="detail"><span class="detail-label">' + details[i][0] + '</span><span class="detail-value">' + _esc(details[i][1]) + '</span></div>';
  }

  // 画像グリッド
  if (images.length > 0) {
    html += '<div class="images-title">'
      + '<span>\uD83D\uDDBC\uFE0F \u753B\u50CF (' + images.length + '\u679A)'
      + '<span class="select-btns"><span onclick="selectAll(true)">\u5168\u9078\u629E</span><span onclick="selectAll(false)">\u5168\u89E3\u9664</span></span></span>'
      + '</div>'
      + '<div class="img-grid">';

    for (var i = 0; i < images.length; i++) {
      html += '<div class="img-item" id="item_' + i + '">'
        + '<div class="cb-wrap"><input type="checkbox" class="img-cb" data-idx="' + i + '" checked onchange="toggleImg(' + i + ')"></div>'
        + '<span class="idx">' + (i+1) + '</span>'
        + '<img src="' + _esc(images[i]) + '" onclick="openModal(\'' + _esc(images[i]) + '\')">'
        + '</div>';
    }
    html += '</div>';
  }

  var confirmUrl = baseUrl + '?action=confirm_approve&customer=' + encodeURIComponent(customerName) + '&room_id=' + roomId;
  var skipUrl = baseUrl + '?action=skip&customer=' + encodeURIComponent(customerName) + '&room_id=' + roomId;

  html += '<div class="actions">'
    + '<a id="approveBtn" class="btn btn-approve" href="#" onclick="submitApprove();return false;">\u2705 \u627F\u8A8D\u3057\u3066LINE\u9001\u4FE1</a><br>'
    + '<a class="btn-skip" href="' + _esc(skipUrl) + '">\u30B9\u30AD\u30C3\u30D7</a>'
    + '</div>';

  // 画像モーダル
  html += '<div id="modal" class="modal-overlay" onclick="closeModal()">'
    + '<span class="modal-close">&times;</span>'
    + '<img id="modalImg" src="">'
    + '</div>';

  html += '<script>'
    + 'var baseConfirmUrl="' + confirmUrl + '";'
    + 'function toggleImg(idx){'
    + 'var el=document.getElementById("item_"+idx);'
    + 'var cb=el.querySelector(".img-cb");'
    + 'if(cb.checked){el.classList.remove("unchecked")}else{el.classList.add("unchecked")}'
    + '}'
    + 'function selectAll(checked){'
    + 'var cbs=document.querySelectorAll(".img-cb");'
    + 'for(var i=0;i<cbs.length;i++){cbs[i].checked=checked;toggleImg(i)}'
    + '}'
    + 'function openModal(src){var m=document.getElementById("modal");document.getElementById("modalImg").src=src;m.classList.add("active")}'
    + 'function closeModal(){document.getElementById("modal").classList.remove("active")}'
    + 'function submitApprove(){'
    + 'var cbs=document.querySelectorAll(".img-cb");'
    + 'var sel=[];'
    + 'for(var i=0;i<cbs.length;i++){if(cbs[i].checked)sel.push(cbs[i].getAttribute("data-idx"))}'
    + 'var url=baseConfirmUrl+"&include_image="+(sel.length>0?"1":"0")+"&selected_images="+sel.join(",");'
    + 'window.top.location.href=url;'
    + '}'
    + '</script>';

  html += '</div></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('\u627F\u8A8D\u30D7\u30EC\u30D3\u30E5\u30FC')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== HTML: 承認プレビュー（一括） =====
function makePreviewAllHtml(props, customerName) {
  var baseUrl = getGasBaseUrl();

  var html = '<html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;padding:16px;background:#f0f2f5}'
    + '.container{max-width:600px;margin:0 auto}'
    + 'h2{color:#333;font-size:18px;margin-bottom:16px}'
    + '.card{background:#fff;border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:0 1px 6px rgba(0,0,0,0.08)}'
    + '.prop-name{font-size:16px;font-weight:bold;color:#222}'
    + '.price{font-size:18px;font-weight:bold;color:#E05252;margin:4px 0}'
    + '.info{font-size:13px;color:#666;margin:2px 0}'
    + '.img-section{margin:8px 0;text-align:center}'
    + '.img-section img{max-width:100%;border-radius:8px;max-height:250px}'
    + '.img-check{margin:6px 0;font-size:13px;color:#555}'
    + '.img-check input{margin-right:4px}'
    + '.actions{text-align:center;margin:20px 0}'
    + '.btn{display:inline-block;padding:14px 40px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;cursor:pointer;border:none}'
    + '.btn-approve{background:#4CAF50;color:#fff}'
    + '</style></head><body><div class="container">'
    + '<h2>\uD83D\uDD0D \u4E00\u62EC\u627F\u8A8D\u30D7\u30EC\u30D3\u30E5\u30FC (' + props.length + '\u4EF6)</h2>';

  for (var i = 0; i < props.length; i++) {
    var p = props[i];
    var rentMan = p.rent ? (p.rent / 10000).toFixed(1) : '0';
    var rid = String(p._roomId);
    html += '<div class="card">'
      + '<div class="prop-name">' + (i+1) + '. ' + _esc(p.buildingName) + (p.roomNumber ? ' ' + _esc(p.roomNumber) : '') + '</div>'
      + '<div class="price">' + rentMan + '\u4E07\u5186</div>'
      + '<div class="info">' + _esc(p.layout || '') + ' | ' + (p.area || '') + 'm\u00B2 | ' + _esc(p.stationInfo || '') + '</div>';

    var imgs = p.imageUrls && p.imageUrls.length > 0 ? p.imageUrls : (p.imageUrl ? [p.imageUrl] : []);
    if (imgs.length > 0) {
      html += '<div class="img-section">'
        + '<img src="' + _esc(imgs[0]) + '" style="max-height:180px">'
        + (imgs.length > 1 ? '<div style="font-size:12px;color:#888;margin-top:4px">+' + (imgs.length-1) + '\u679A\u306E\u753B\u50CF</div>' : '')
        + '<div class="img-check"><label><input type="checkbox" class="img-cb" data-room="' + rid + '" checked> \u753B\u50CF\u3092\u898B\u305B\u308B</label></div>'
        + '</div>';
    }
    html += '</div>';
  }

  html += '<div class="actions">'
    + '<a id="approveAllBtn" class="btn btn-approve" href="#" onclick="submitAll();return false;">\u2705 \u5168\u3066\u627F\u8A8D\u3057\u3066LINE\u9001\u4FE1</a>'
    + '</div>';

  html += '<script>'
    + 'function submitAll(){'
    + 'var cbs=document.querySelectorAll(".img-cb");'
    + 'var ids=[];'
    + 'for(var i=0;i<cbs.length;i++){if(cbs[i].checked)ids.push(cbs[i].getAttribute("data-room"))}'
    + 'var url="' + baseUrl + '?action=confirm_approve_all&customer=' + encodeURIComponent(customerName) + '&images="+ids.join(",");'
    + 'window.location.href=url;'
    + '}'
    + '</script>';

  html += '</div></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('\u4E00\u62EC\u627F\u8A8D\u30D7\u30EC\u30D3\u30E5\u30FC')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== HTML: お客さん向け物件資料ページ =====
function makeViewHtml(prop) {
  var rentMan = prop.rent ? (prop.rent / 10000).toFixed(1) : '0';
  var mgmtMan = prop.managementFee ? (prop.managementFee / 10000).toFixed(1) : '0';

  // 表示する画像: 承認時に選択されたものがあればそれ、なければ全画像
  var viewImages = prop.selectedImageUrls || prop.imageUrls || [];
  if (viewImages.length === 0 && prop.imageUrl) {
    viewImages = [prop.imageUrl];
  }

  var html = '<html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;background:#f8f9fa;color:#333}'
    + '.carousel{position:relative;width:100%;background:#000;overflow:hidden}'
    + '.carousel-inner{display:flex;transition:transform 0.3s ease;width:100%}'
    + '.carousel-slide{min-width:100%;display:flex;justify-content:center;align-items:center}'
    + '.carousel-slide img{width:100%;max-height:50vh;object-fit:contain}'
    + '.carousel-btn{position:absolute;top:50%;transform:translateY(-50%);background:rgba(255,255,255,0.7);border:none;font-size:24px;padding:8px 12px;cursor:pointer;border-radius:50%;z-index:2}'
    + '.carousel-btn.prev{left:8px}'
    + '.carousel-btn.next{right:8px}'
    + '.carousel-dots{text-align:center;padding:8px;background:#000}'
    + '.carousel-dots .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,0.4);margin:0 3px;cursor:pointer}'
    + '.carousel-dots .dot.active{background:#fff}'
    + '.carousel-counter{position:absolute;bottom:12px;right:12px;background:rgba(0,0,0,0.6);color:#fff;font-size:12px;padding:4px 10px;border-radius:12px;z-index:2}'
    + '.hero{width:100%;max-height:50vh;object-fit:cover;display:block}'
    + '.content{max-width:600px;margin:0 auto;padding:20px}'
    + '.title{font-size:22px;font-weight:bold;color:#222;margin-bottom:8px}'
    + '.price-box{background:linear-gradient(135deg,#E05252,#ff6b6b);color:#fff;border-radius:12px;padding:16px;margin:12px 0}'
    + '.price-main{font-size:28px;font-weight:bold}'
    + '.price-sub{font-size:14px;opacity:0.9;margin-top:4px}'
    + '.section{background:#fff;border-radius:12px;padding:16px;margin:12px 0;box-shadow:0 1px 4px rgba(0,0,0,0.06)}'
    + '.section-title{font-size:14px;color:#888;font-weight:bold;margin-bottom:12px;text-transform:uppercase;letter-spacing:1px}'
    + '.row{display:flex;padding:8px 0;border-bottom:1px solid #f5f5f5}'
    + '.row:last-child{border-bottom:none}'
    + '.row-label{color:#888;font-size:14px;width:90px;flex-shrink:0}'
    + '.row-value{color:#333;font-size:14px;flex:1}'
    + '.footer{text-align:center;padding:20px;color:#aaa;font-size:12px}'
    + '</style></head><body>';

  // 画像表示（複数ならカルーセル、1枚ならヒーロー画像）
  if (viewImages.length > 1) {
    html += '<div class="carousel" id="carousel">'
      + '<div class="carousel-inner" id="carouselInner">';
    for (var i = 0; i < viewImages.length; i++) {
      html += '<div class="carousel-slide"><img src="' + _esc(viewImages[i]) + '" alt="\u7269\u4EF6\u753B\u50CF ' + (i+1) + '"></div>';
    }
    html += '</div>'
      + '<button class="carousel-btn prev" onclick="slide(-1)">&lt;</button>'
      + '<button class="carousel-btn next" onclick="slide(1)">&gt;</button>'
      + '<div class="carousel-counter"><span id="slideNum">1</span> / ' + viewImages.length + '</div>'
      + '</div>'
      + '<div class="carousel-dots" id="dots">';
    for (var i = 0; i < viewImages.length; i++) {
      html += '<span class="dot' + (i === 0 ? ' active' : '') + '" onclick="goTo(' + i + ')"></span>';
    }
    html += '</div>';
  } else if (viewImages.length === 1) {
    html += '<img class="hero" src="' + _esc(viewImages[0]) + '" alt="\u7269\u4EF6\u753B\u50CF">';
  }

  html += '<div class="content">'
    + '<div class="title">' + _esc(prop.buildingName) + (prop.roomNumber ? ' ' + _esc(prop.roomNumber) : '') + '</div>';

  html += '<div class="price-box">'
    + '<div class="price-main">' + rentMan + '\u4E07\u5186<span style="font-size:16px">/\u6708</span></div>'
    + '<div class="price-sub">\u7BA1\u7406\u8CBB ' + mgmtMan + '\u4E07\u5186 | \u6577\u91D1 ' + _esc(prop.deposit || '\u306A\u3057') + ' | \u793C\u91D1 ' + _esc(prop.keyMoney || '\u306A\u3057') + '</div>'
    + '</div>';

  html += '<div class="section">'
    + '<div class="section-title">\u7269\u4EF6\u60C5\u5831</div>';

  var details = [];
  if (prop.layout) details.push(['\u9593\u53D6\u308A', prop.layout]);
  if (prop.area) details.push(['\u9762\u7A4D', prop.area + 'm\u00B2']);
  if (prop.buildingAge) details.push(['\u7BC9\u5E74\u6570', prop.buildingAge]);
  if (prop.floor) details.push(['\u968E\u6570', prop.floor + '\u968E']);

  for (var i = 0; i < details.length; i++) {
    html += '<div class="row"><span class="row-label">' + details[i][0] + '</span><span class="row-value">' + _esc(details[i][1]) + '</span></div>';
  }
  html += '</div>';

  html += '<div class="section">'
    + '<div class="section-title">\u30A2\u30AF\u30BB\u30B9</div>';
  if (prop.stationInfo) html += '<div class="row"><span class="row-label">\u6700\u5BC4\u99C5</span><span class="row-value">' + _esc(prop.stationInfo) + '</span></div>';
  if (prop.address) html += '<div class="row"><span class="row-label">\u4F4F\u6240</span><span class="row-value">' + _esc(prop.address) + '</span></div>';
  html += '</div>';

  html += '<div class="footer">\u203B \u8A73\u7D30\u306F\u62C5\u5F53\u8005\u306B\u304A\u554F\u3044\u5408\u308F\u305B\u304F\u3060\u3055\u3044</div>';
  html += '</div>';

  // カルーセルJS（複数画像時のみ）
  if (viewImages.length > 1) {
    html += '<script>'
      + 'var cur=0,total=' + viewImages.length + ';'
      + 'function goTo(n){cur=n;update()}'
      + 'function slide(d){cur=(cur+d+total)%total;update()}'
      + 'function update(){'
      + 'document.getElementById("carouselInner").style.transform="translateX(-"+cur*100+"%)";'
      + 'document.getElementById("slideNum").textContent=cur+1;'
      + 'var dots=document.querySelectorAll(".dot");'
      + 'for(var i=0;i<dots.length;i++){dots[i].className=i===cur?"dot active":"dot"}'
      + '}'
      + 'var startX=0;'
      + 'var el=document.getElementById("carousel");'
      + 'el.addEventListener("touchstart",function(e){startX=e.touches[0].clientX});'
      + 'el.addEventListener("touchend",function(e){var dx=e.changedTouches[0].clientX-startX;if(Math.abs(dx)>40){slide(dx<0?1:-1)}});'
      + '</script>';
  }

  html += '</body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle(prop.buildingName + ' - \u7269\u4EF6\u60C5\u5831')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== HTML エスケープ =====
function _esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
