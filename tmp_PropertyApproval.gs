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

// ===== google.script.run 用ラッパー（単一承認） =====
function confirmApproveFromClient(formData) {
  var e = { parameter: formData };
  try {
    handleConfirmApprove(e); // 実処理（LINE送信・シート更新）
    return { success: true, message: (formData.buildingName || '物件') + ' を ' + formData.customer + ' さんに LINE 送信しました。' };
  } catch (err) {
    console.error('confirmApproveFromClient Error: ' + err.message + '\nStack: ' + err.stack);
    return { success: false, message: err.message };
  }
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

  // ── 編集値の適用（POSTフォームから） ──
  if (e.parameter.buildingName !== undefined) {
    var editFields = ['buildingName','roomNumber','layout','buildingAge','floorText','storyText',
      'structure','totalUnits','sunlight','moveInDate','stationInfo','address',
      'deposit','keyMoney','shikibiki','petDeposit','renewalFee','fireInsurance',
      'renewalAdminFee','guaranteeInfo','keyExchangeFee','leaseType','contractPeriod',
      'cancellationNotice','renewalInfo','freeRent','facilities'];
    for (var j = 0; j < editFields.length; j++) {
      var f = editFields[j];
      if (e.parameter[f] !== undefined) {
        prop[f] = e.parameter[f];
      }
    }
    if (e.parameter.rent !== undefined) prop.rent = Number(e.parameter.rent) || 0;
    if (e.parameter.managementFee !== undefined) prop.managementFee = Number(e.parameter.managementFee) || 0;
    if (e.parameter.area !== undefined) prop.area = Number(e.parameter.area) || 0;
    if (e.parameter.otherStations !== undefined) {
      prop.otherStations = e.parameter.otherStations.split('\n').filter(function(s) { return s.trim() !== ''; });
    }
  }

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

  // 編集値をシートに反映
  if (e.parameter.buildingName !== undefined) {
    updateSheetWithEdits(row.rowIndex, prop);
  }

  // ビューURL（GAS Web App で表示 — URL短縮のため直接レンダリング）
  var viewUrl = getGasBaseUrl() + '?action=view&customer=' + encodeURIComponent(customerName) + '&room_id=' + roomId;

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

// ===== google.script.run 用ラッパー（一括承認） =====
function confirmApproveAllFromClient(formData) {
  var e = { parameter: formData };
  try {
    handleConfirmApproveAll(e);
    return { success: true, message: formData.customer + ' さんに物件を LINE 送信しました。' };
  } catch (err) {
    console.error('confirmApproveAllFromClient Error: ' + err.message + '\nStack: ' + err.stack);
    return { success: false, message: err.message };
  }
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

    // 画像を含める場合、全画像を選択済みとして保存
    var selectedUrls = [];
    if (includeImage) {
      selectedUrls = prop.imageUrls && prop.imageUrls.length > 0 ? prop.imageUrls : (prop.imageUrl ? [prop.imageUrl] : []);
      if (selectedUrls.length > 0) {
        saveSelectedImages(rows[i].rowIndex, selectedUrls);
      }
    }

    var viewUrl = getGasBaseUrl() + '?action=view&customer=' + encodeURIComponent(customerName) + '&room_id=' + rid;

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
    images: viewImages,
    // 追加詳細情報
    storyText: prop.storyText,
    otherStations: prop.otherStations,
    moveInDate: prop.moveInDate,
    floorText: prop.floorText,
    structure: prop.structure,
    totalUnits: prop.totalUnits,
    leaseType: prop.leaseType,
    contractPeriod: prop.contractPeriod,
    cancellationNotice: prop.cancellationNotice,
    renewalInfo: prop.renewalInfo,
    sunlight: prop.sunlight,
    facilities: prop.facilities,
    shikibiki: prop.shikibiki,
    petDeposit: prop.petDeposit,
    freeRent: prop.freeRent,
    renewalFee: prop.renewalFee,
    fireInsurance: prop.fireInsurance,
    renewalAdminFee: prop.renewalAdminFee,
    guaranteeInfo: prop.guaranteeInfo,
    keyExchangeFee: prop.keyExchangeFee
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

/** 「入力なし」「なし」などの無効値を空文字に正規化 */
function _normalizeValue(val) {
  if (!val || val === '入力なし' || val === 'なし') return '';
  return val;
}

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
    deposit: _normalizeValue(extra.deposit),
    keyMoney: _normalizeValue(extra.key_money),
    address: extra.address || '',
    url: extra.url || '',
    imageUrl: extra.image_url || '',
    imageUrls: extra.image_urls || [],
    selectedImageUrls: extra.selected_image_urls || null,
    roomNumber: _normalizeValue(extra.room_number),
    buildingAge: _normalizeValue(extra.building_age),
    floor: extra.floor || 0,
    // 追加詳細情報
    storyText: _normalizeValue(extra.story_text),
    otherStations: extra.other_stations || [],
    moveInDate: _normalizeValue(extra.move_in_date),
    floorText: _normalizeValue(extra.floor_text),
    structure: _normalizeValue(extra.structure),
    totalUnits: _normalizeValue(extra.total_units),
    leaseType: _normalizeValue(extra.lease_type),
    contractPeriod: _normalizeValue(extra.contract_period),
    cancellationNotice: _normalizeValue(extra.cancellation_notice),
    renewalInfo: _normalizeValue(extra.renewal_info),
    sunlight: _normalizeValue(extra.sunlight),
    facilities: _normalizeValue(extra.facilities),
    shikibiki: _normalizeValue(extra.shikibiki),
    petDeposit: _normalizeValue(extra.pet_deposit),
    freeRent: _normalizeValue(extra.free_rent),
    renewalFee: _normalizeValue(extra.renewal_fee),
    fireInsurance: _normalizeValue(extra.fire_insurance),
    renewalAdminFee: _normalizeValue(extra.renewal_admin_fee),
    guaranteeInfo: _normalizeValue(extra.guarantee_info),
    keyExchangeFee: _normalizeValue(extra.key_exchange_fee)
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

// ===== 編集値をシートに反映 =====
function updateSheetWithEdits(rowIndex, prop) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);

  // メイン列を更新: D=物件名, E=賃料, F=管理費, G=間取り, H=面積, I=最寄駅
  sheet.getRange(rowIndex, 4).setValue(prop.buildingName);
  sheet.getRange(rowIndex, 5).setValue(prop.rent);
  sheet.getRange(rowIndex, 6).setValue(prop.managementFee);
  sheet.getRange(rowIndex, 7).setValue(prop.layout);
  sheet.getRange(rowIndex, 8).setValue(prop.area);
  sheet.getRange(rowIndex, 9).setValue(prop.stationInfo);

  // J列のJSONを更新
  var cell = sheet.getRange(rowIndex, 10);
  var extra = {};
  try { extra = JSON.parse(cell.getValue() || '{}'); } catch(e) {}

  extra.room_number = prop.roomNumber || '';
  extra.deposit = prop.deposit || '';
  extra.key_money = prop.keyMoney || '';
  extra.address = prop.address || '';
  extra.building_age = prop.buildingAge || '';
  extra.floor_text = prop.floorText || '';
  extra.story_text = prop.storyText || '';
  extra.structure = prop.structure || '';
  extra.total_units = prop.totalUnits || '';
  extra.sunlight = prop.sunlight || '';
  extra.move_in_date = prop.moveInDate || '';
  extra.lease_type = prop.leaseType || '';
  extra.contract_period = prop.contractPeriod || '';
  extra.cancellation_notice = prop.cancellationNotice || '';
  extra.renewal_info = prop.renewalInfo || '';
  extra.facilities = prop.facilities || '';
  extra.shikibiki = prop.shikibiki || '';
  extra.pet_deposit = prop.petDeposit || '';
  extra.free_rent = prop.freeRent || '';
  extra.renewal_fee = prop.renewalFee || '';
  extra.fire_insurance = prop.fireInsurance || '';
  extra.renewal_admin_fee = prop.renewalAdminFee || '';
  extra.guarantee_info = prop.guaranteeInfo || '';
  extra.key_exchange_fee = prop.keyExchangeFee || '';
  extra.other_stations = prop.otherStations || [];

  cell.setValue(JSON.stringify(extra));
}

// ===== ビューURL生成（データをハッシュに埋め込み、API不要で即時表示） =====
function buildViewUrl(customerName, roomId, prop, viewImageUrls) {
  var d = {};
  if (prop.buildingName) d.bn = prop.buildingName;
  if (prop.roomNumber) d.rn = prop.roomNumber;
  if (prop.rent) d.r = prop.rent;
  if (prop.managementFee) d.mf = prop.managementFee;
  if (prop.layout) d.l = prop.layout;
  if (prop.area) d.a = prop.area;
  if (prop.buildingAge) d.ba = prop.buildingAge;
  if (prop.stationInfo) d.si = prop.stationInfo;
  if (prop.address) d.ad = prop.address;
  if (prop.deposit) d.d = prop.deposit;
  if (prop.keyMoney) d.k = prop.keyMoney;
  if (prop.floorText) d.ft = prop.floorText;
  else if (prop.floor) d.fl = prop.floor;
  if (prop.storyText) d.st = prop.storyText;
  if (prop.structure) d.str = prop.structure;
  if (prop.totalUnits) d.tu = prop.totalUnits;
  if (prop.sunlight) d.sl = prop.sunlight;
  if (prop.moveInDate) d.md = prop.moveInDate;
  if (prop.leaseType) d.lt = prop.leaseType;
  if (prop.contractPeriod) d.cp = prop.contractPeriod;
  if (prop.cancellationNotice) d.cn = prop.cancellationNotice;
  if (prop.renewalInfo) d.ri = prop.renewalInfo;
  if (prop.freeRent) d.fr = prop.freeRent;
  if (prop.shikibiki) d.sb = prop.shikibiki;
  if (prop.petDeposit) d.pd = prop.petDeposit;
  if (prop.renewalFee) d.rf = prop.renewalFee;
  if (prop.fireInsurance) d.fi = prop.fireInsurance;
  if (prop.renewalAdminFee) d.ra = prop.renewalAdminFee;
  if (prop.guaranteeInfo) d.gi = prop.guaranteeInfo;
  if (prop.keyExchangeFee) d.ke = prop.keyExchangeFee;
  // 設備: objectでもstringでもそのまま
  if (prop.facilities) d.fac = prop.facilities;
  if (prop.otherStations && prop.otherStations.length > 0) d.os = prop.otherStations;
  if (viewImageUrls && viewImageUrls.length > 0) d.imgs = viewImageUrls;

  var jsonStr = JSON.stringify(d);
  var encoded = Utilities.base64EncodeWebSafe(Utilities.newBlob(jsonStr).getBytes());
  return 'https://form.ehomaki.com/property.html?customer=' + encodeURIComponent(customerName) + '&room_id=' + roomId + '#' + encoded;
}

// ===== Flex Message =====
function buildPropertyFlex(prop, options) {
  options = options || {};
  var includeImage = options.includeImage !== false;
  var viewUrl = options.viewUrl || '';

  var rentMan = prop.rent ? String(prop.rent / 10000) : '0';
  var mgmtMan = prop.managementFee ? String(prop.managementFee / 10000) : '0';

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
  if (includeImage && heroUrl && heroUrl.indexOf('https://') === 0) {
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

// ===== HTML: 承認プレビュー（単一・編集可能） =====
function makePreviewHtml(prop, customerName, roomId) {
  var baseUrl = getGasBaseUrl();
  var rentMan = prop.rent ? String(prop.rent / 10000) : '0';
  var mgmtMan = prop.managementFee ? String(prop.managementFee / 10000) : '0';

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
    + '.section-header{font-size:13px;color:#888;font-weight:bold;margin:16px 0 8px;padding-bottom:4px;border-bottom:2px solid #e0e0e0;letter-spacing:1px}'
    + '.detail-row{display:flex;align-items:center;padding:5px 0;border-bottom:1px solid #f5f5f5;font-size:14px}'
    + '.detail-label{color:#888;width:110px;flex-shrink:0;font-size:13px}'
    + '.detail-input{flex:1;border:1px solid #e0e0e0;border-radius:6px;padding:5px 8px;font-size:14px;color:#333;background:#fafafa}'
    + '.detail-input:focus{border-color:#4CAF50;outline:none;background:#fff}'
    + '.detail-textarea{flex:1;border:1px solid #e0e0e0;border-radius:6px;padding:5px 8px;font-size:14px;color:#333;background:#fafafa;resize:vertical;min-height:50px;font-family:inherit}'
    + '.detail-textarea:focus{border-color:#4CAF50;outline:none;background:#fff}'
    + '.images-title{font-size:15px;font-weight:bold;color:#333;margin:16px 0 8px;display:flex;align-items:center;justify-content:space-between}'
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
    + '<h2>\uD83D\uDD0D \u627F\u8A8D\u30D7\u30EC\u30D3\u30E5\u30FC\uFF08\u7DE8\u96C6\u53EF\uFF09</h2>'
    + '<div class="prop-name">' + _esc(prop.buildingName) + (prop.roomNumber ? ' ' + _esc(prop.roomNumber) : '') + '</div>'
    + '<div class="price">' + rentMan + '\u4E07\u5186 <span class="price-sub">\u7BA1\u7406\u8CBB ' + mgmtMan + '\u4E07\u5186</span></div>';

  // ── 物件情報 ──
  html += '<div class="section-header">\u7269\u4EF6\u60C5\u5831</div>';
  html += _inputRow('\u7269\u4EF6\u540D', 'buildingName', prop.buildingName);
  html += _inputRow('\u90E8\u5C4B\u756A\u53F7', 'roomNumber', prop.roomNumber);
  html += _inputRow('\u9593\u53D6\u308A', 'layout', prop.layout);
  html += _inputRow('\u9762\u7A4D(m\u00B2)', 'area', prop.area || '');
  html += _inputRow('\u7BC9\u5E74\u6570', 'buildingAge', prop.buildingAge);
  html += _inputRow('\u6240\u5728\u968E', 'floorText', prop.floorText || (prop.floor ? prop.floor + '\u968E' : ''));
  html += _inputRow('\u968E\u5EFA\u3066', 'storyText', prop.storyText);
  html += _inputRow('\u69CB\u9020', 'structure', prop.structure);
  html += _inputRow('\u7DCF\u6238\u6570', 'totalUnits', prop.totalUnits);
  html += _inputRow('\u4E3B\u8981\u63A1\u5149\u9762', 'sunlight', prop.sunlight);
  html += _inputRow('\u5165\u5C45\u53EF\u80FD\u6642\u671F', 'moveInDate', prop.moveInDate);

  // ── アクセス ──
  html += '<div class="section-header">\u30A2\u30AF\u30BB\u30B9</div>';
  html += _inputRow('\u6700\u5BC4\u99C5', 'stationInfo', prop.stationInfo);
  html += _inputRow('\u4F4F\u6240', 'address', prop.address);
  html += _textareaRow('\u4ED6\u306E\u6700\u5BC4\u99C5', 'otherStations', (prop.otherStations || []).join('\n'));

  // ── 費用 ──
  html += '<div class="section-header">\u8CBB\u7528</div>';
  html += _inputRow('\u8CC3\u6599(\u5186)', 'rent', prop.rent || '');
  html += _inputRow('\u7BA1\u7406\u8CBB(\u5186)', 'managementFee', prop.managementFee || '');
  html += _inputRow('\u6577\u91D1', 'deposit', prop.deposit);
  html += _inputRow('\u793C\u91D1', 'keyMoney', prop.keyMoney);
  html += _inputRow('\u6577\u5F15\u304D/\u511F\u5374', 'shikibiki', prop.shikibiki);
  html += _inputRow('\u30DA\u30C3\u30C8\u6577\u91D1\u8FFD\u52A0', 'petDeposit', prop.petDeposit);
  html += _inputRow('\u66F4\u65B0\u6599', 'renewalFee', prop.renewalFee);
  html += _inputRow('\u706B\u707D\u4FDD\u967A', 'fireInsurance', prop.fireInsurance);
  html += _inputRow('\u66F4\u65B0\u4E8B\u52D9\u624B\u6570\u6599', 'renewalAdminFee', prop.renewalAdminFee);
  html += _textareaRow('\u4FDD\u8A3C\u6599', 'guaranteeInfo', prop.guaranteeInfo);
  html += _inputRow('\u9375\u4EA4\u63DB\u8CBB\u7528', 'keyExchangeFee', prop.keyExchangeFee);

  // ── 契約条件 ──
  html += '<div class="section-header">\u5951\u7D04\u6761\u4EF6</div>';
  html += _inputRow('\u5951\u7D04\u533A\u5206', 'leaseType', prop.leaseType);
  html += _inputRow('\u5951\u7D04\u671F\u9593', 'contractPeriod', prop.contractPeriod);
  html += _inputRow('\u89E3\u7D04\u4E88\u544A', 'cancellationNotice', prop.cancellationNotice);
  html += _inputRow('\u66F4\u65B0/\u518D\u5951\u7D04', 'renewalInfo', prop.renewalInfo);
  html += _inputRow('\u30D5\u30EA\u30FC\u30EC\u30F3\u30C8', 'freeRent', prop.freeRent);

  // ── 設備・詳細 ──
  html += '<div class="section-header">\u8A2D\u5099\u30FB\u8A73\u7D30</div>';
  html += _textareaRow('\u8A2D\u5099', 'facilities', prop.facilities);

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
    + 'var gasBaseUrl=' + JSON.stringify(baseUrl) + ';'
    + 'var customerName=' + JSON.stringify(customerName) + ';'
    + 'var roomId=' + JSON.stringify(String(roomId)) + ';'
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
    + 'var btn=document.getElementById("approveBtn");'
    + 'btn.textContent="\\u2B50 \\u9001\\u4FE1\\u4E2D...";btn.style.opacity="0.6";btn.style.pointerEvents="none";'
    + 'var fd={};'
    + 'fd.action="confirm_approve";'
    + 'fd.customer=customerName;'
    + 'fd.room_id=roomId;'
    + 'var cbs=document.querySelectorAll(".img-cb");'
    + 'var sel=[];'
    + 'for(var i=0;i<cbs.length;i++){if(cbs[i].checked)sel.push(cbs[i].getAttribute("data-idx"))}'
    + 'fd.include_image=sel.length>0?"1":"0";'
    + 'fd.selected_images=sel.join(",");'
    + 'var inputs=document.querySelectorAll(".detail-input,.detail-textarea");'
    + 'for(var i=0;i<inputs.length;i++){fd[inputs[i].name]=inputs[i].value}'
    + 'google.script.run'
    + '.withSuccessHandler(function(r){'
    + 'if(r.success){'
    + 'document.body.innerHTML="<div style=\\"text-align:center;padding:60px;font-family:sans-serif\\"><h2 style=\\"color:#4CAF50\\">\\u2705 "+r.message+"</h2></div>"'
    + '}else{'
    + 'document.body.innerHTML="<div style=\\"text-align:center;padding:60px;font-family:sans-serif\\"><h2 style=\\"color:#e74c3c\\">\\u26A0 \\u30A8\\u30E9\\u30FC</h2><p>"+r.message+"</p><p><a href=\\"javascript:history.back()\\">\\u2190 \\u623B\\u308B</a></p></div>"'
    + '}})'
    + '.withFailureHandler(function(err){'
    + 'document.body.innerHTML="<div style=\\"text-align:center;padding:60px;font-family:sans-serif\\"><h2 style=\\"color:#e74c3c\\">\\u26A0 \\u30A8\\u30E9\\u30FC</h2><p>"+err.message+"</p><p><a href=\\"javascript:history.back()\\">\\u2190 \\u623B\\u308B</a></p></div>"'
    + '})'
    + '.confirmApproveFromClient(fd);'
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
    var rentMan = p.rent ? String(p.rent / 10000) : '0';
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
    + 'var btn=document.getElementById("approveAllBtn");'
    + 'btn.textContent="\\u2B50 \\u9001\\u4FE1\\u4E2D...";btn.style.opacity="0.6";btn.style.pointerEvents="none";'
    + 'var cbs=document.querySelectorAll(".img-cb");'
    + 'var ids=[];'
    + 'for(var i=0;i<cbs.length;i++){if(cbs[i].checked)ids.push(cbs[i].getAttribute("data-room"))}'
    + 'var fd={action:"confirm_approve_all",customer:' + JSON.stringify(customerName) + ',images:ids.join(",")};'
    + 'google.script.run'
    + '.withSuccessHandler(function(r){'
    + 'if(r.success){'
    + 'document.body.innerHTML="<div style=\\"text-align:center;padding:60px;font-family:sans-serif\\"><h2 style=\\"color:#4CAF50\\">\\u2705 "+r.message+"</h2></div>"'
    + '}else{'
    + 'document.body.innerHTML="<div style=\\"text-align:center;padding:60px;font-family:sans-serif\\"><h2 style=\\"color:#e74c3c\\">\\u26A0 \\u30A8\\u30E9\\u30FC</h2><p>"+r.message+"</p><p><a href=\\"javascript:history.back()\\">\\u2190 \\u623B\\u308B</a></p></div>"'
    + '}})'
    + '.withFailureHandler(function(err){'
    + 'document.body.innerHTML="<div style=\\"text-align:center;padding:60px;font-family:sans-serif\\"><h2 style=\\"color:#e74c3c\\">\\u26A0 \\u30A8\\u30E9\\u30FC</h2><p>"+err.message+"</p><p><a href=\\"javascript:history.back()\\">\\u2190 \\u623B\\u308B</a></p></div>"'
    + '})'
    + '.confirmApproveAllFromClient(fd);'
    + '}'
    + '</script>';

  html += '</div></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('\u4E00\u62EC\u627F\u8A8D\u30D7\u30EC\u30D3\u30E5\u30FC')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== HTML: お客さん向け物件資料ページ =====
function makeViewHtml(prop) {
  var rentMan = prop.rent ? String(prop.rent / 10000) : '0';
  var mgmtMan = prop.managementFee ? String(prop.managementFee / 10000) : '0';

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
  if (prop.floorText) details.push(['\u6240\u5728\u968E', prop.floorText]);
  else if (prop.floor) details.push(['\u6240\u5728\u968E', prop.floor + '\u968E']);
  if (prop.storyText) details.push(['\u968E\u5EFA\u3066', prop.storyText]);
  if (prop.structure) details.push(['\u69CB\u9020', prop.structure]);
  if (prop.totalUnits) details.push(['\u7DCF\u6238\u6570', prop.totalUnits]);
  if (prop.sunlight) details.push(['\u4E3B\u8981\u63A1\u5149\u9762', prop.sunlight]);
  if (prop.moveInDate) details.push(['\u5165\u5C45\u53EF\u80FD\u6642\u671F', prop.moveInDate]);

  for (var i = 0; i < details.length; i++) {
    html += '<div class="row"><span class="row-label">' + details[i][0] + '</span><span class="row-value">' + _esc(details[i][1]) + '</span></div>';
  }
  html += '</div>';

  html += '<div class="section">'
    + '<div class="section-title">\u30A2\u30AF\u30BB\u30B9</div>';
  if (prop.stationInfo) html += '<div class="row"><span class="row-label">\u6700\u5BC4\u99C5</span><span class="row-value">' + _esc(prop.stationInfo) + '</span></div>';
  var others = prop.otherStations || [];
  for (var i = 0; i < others.length; i++) {
    html += '<div class="row"><span class="row-label">' + (i === 0 ? '\u4ED6\u306E\u99C5' : '') + '</span><span class="row-value">' + _esc(others[i]) + '</span></div>';
  }
  if (prop.address) html += '<div class="row"><span class="row-label">\u4F4F\u6240</span><span class="row-value">' + _esc(prop.address) + '</span></div>';
  html += '</div>';

  // 費用
  var costRows = [];
  if (prop.shikibiki) costRows.push(['\u6577\u5F15\u304D/\u511F\u5374', prop.shikibiki]);
  if (prop.petDeposit) costRows.push(['\u30DA\u30C3\u30C8\u6577\u91D1\u8FFD\u52A0', prop.petDeposit]);
  if (prop.renewalFee) costRows.push(['\u66F4\u65B0\u6599', prop.renewalFee]);
  if (prop.fireInsurance) costRows.push(['\u706B\u707D\u4FDD\u967A\u6599', prop.fireInsurance]);
  if (prop.renewalAdminFee) costRows.push(['\u66F4\u65B0\u4E8B\u52D9\u624B\u6570\u6599', prop.renewalAdminFee]);
  if (prop.guaranteeInfo) costRows.push(['\u4FDD\u8A3C\u6599', prop.guaranteeInfo]);
  if (prop.keyExchangeFee) costRows.push(['\u9375\u4EA4\u63DB\u8CBB\u7528', prop.keyExchangeFee]);
  if (costRows.length > 0) {
    html += '<div class="section"><div class="section-title">\u8CBB\u7528</div>';
    for (var i = 0; i < costRows.length; i++) {
      html += '<div class="row"><span class="row-label">' + costRows[i][0] + '</span><span class="row-value">' + _esc(costRows[i][1]) + '</span></div>';
    }
    html += '</div>';
  }

  // 契約条件
  var contractRows = [];
  if (prop.leaseType) contractRows.push(['\u5951\u7D04\u533A\u5206', prop.leaseType]);
  if (prop.contractPeriod) contractRows.push(['\u5951\u7D04\u671F\u9593', prop.contractPeriod]);
  if (prop.cancellationNotice) contractRows.push(['\u89E3\u7D04\u4E88\u544A', prop.cancellationNotice]);
  if (prop.renewalInfo) contractRows.push(['\u66F4\u65B0\u30FB\u518D\u5951\u7D04\u53EF\u5426', prop.renewalInfo]);
  if (prop.freeRent) contractRows.push(['\u30D5\u30EA\u30FC\u30EC\u30F3\u30C8', prop.freeRent]);
  if (contractRows.length > 0) {
    html += '<div class="section"><div class="section-title">\u5951\u7D04\u6761\u4EF6</div>';
    for (var i = 0; i < contractRows.length; i++) {
      html += '<div class="row"><span class="row-label">' + contractRows[i][0] + '</span><span class="row-value">' + _esc(contractRows[i][1]) + '</span></div>';
    }
    html += '</div>';
  }

  // 設備・詳細
  var facStr = prop.facilities || '';
  if (facStr) {
    html += '<div class="section"><div class="section-title">\u8A2D\u5099\u30FB\u8A73\u7D30</div>'
      + '<div style="font-size:13px;color:#555;line-height:1.7;white-space:pre-wrap">' + _esc(facStr) + '</div></div>';
  }

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

// ===== HTML: 編集可能な入力行 =====
function _inputRow(label, name, value) {
  var v = (value !== undefined && value !== null && String(value) !== '' && value !== 0) ? String(value) : '\u30FC';
  return '<div class="detail-row"><span class="detail-label">' + label + '</span>'
    + '<input class="detail-input" name="' + name + '" value="' + _esc(v) + '"></div>';
}

function _textareaRow(label, name, value) {
  var v = (value !== undefined && value !== null && String(value) !== '') ? String(value) : '\u30FC';
  return '<div class="detail-row"><span class="detail-label">' + label + '</span>'
    + '<textarea class="detail-textarea" name="' + name + '">' + _esc(v) + '</textarea></div>';
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
