/**
 * PropertyApproval.gs — 物件承認・プレビュー・物件資料ページ
 *
 * 承認フロー:
 *   approve → プレビューページ表示 → confirm_approve → LINE送信
 *   approve_all → 一括プレビュー → confirm_approve_all → LINE送信
 *   skip → スキップ
 *   view → お客さん向け物件資料ページ
 */

/** 円単位の金額を万円表示文字列に変換（14万→'14', 14.3万→'14.3'） */
function _fmtMan(yen) {
  if (!yen) return '0';
  return String(yen / 10000);
}

var PENDING_SHEET_NAME = '承認待ち物件';
var SEEN_SHEET_NAME = '通知済み物件';
var SPREADSHEET_ID = '1u6NHowKJNqZm_Qv-MQQEDzMWjPOJfJiX1yhaO4Wj6lY';

// ===== ntfy.sh プッシュ通知（スマホ用） =====
var NTFY_TOPIC = 'ehomaki-rent';

function sendPushNotification(message, title) {
  try {
    UrlFetchApp.fetch('https://ntfy.sh/' + NTFY_TOPIC, {
      method: 'post',
      headers: { 'Title': title || '物件通知' },
      payload: message,
      muteHttpExceptions: true
    });
  } catch (e) {
    console.error('ntfy error: ' + e.message);
  }
}

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
      'renewalAdminFee','guaranteeInfo','keyExchangeFee',
      'supportFee24h','rightsFee','additionalDeposit','guaranteeDeposit',
      'waterBilling','parkingFee','bicycleParkingFee','motorcycleParkingFee',
      'otherMonthlyFee','otherOnetimeFee','moveInConditions','moveOutDate',
      'freeRentDetail','layoutDetail',
      'leaseType','contractPeriod',
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

  // 統合画像URL（順序指定）
  var selectedImageUrls = [];
  var selectedImageCategories = [];
  if (e.parameter.ordered_image_urls) {
    try { selectedImageUrls = JSON.parse(e.parameter.ordered_image_urls); } catch(ex) {}
  }
  if (e.parameter.ordered_image_categories) {
    try { selectedImageCategories = JSON.parse(e.parameter.ordered_image_categories); } catch(ex) {}
  }
  // フォールバック: 旧形式（ordered_image_urls がない場合）
  if (selectedImageUrls.length === 0) {
    if (includeImage && selectedIndices.length > 0 && prop.imageUrls.length > 0) {
      for (var i = 0; i < selectedIndices.length; i++) {
        var idx = parseInt(selectedIndices[i], 10);
        if (!isNaN(idx) && idx >= 0 && idx < prop.imageUrls.length) {
          selectedImageUrls.push(prop.imageUrls[idx]);
          selectedImageCategories.push((prop.imageCategories || [])[idx] || '');
        }
      }
    } else if (includeImage && prop.imageUrl) {
      selectedImageUrls = [prop.imageUrl];
      selectedImageCategories = [''];
    }
  }
  if (selectedImageUrls.length > 0) {
    includeImage = true;
  }

  // 選択画像をシートに保存（viewページで使用）
  if (selectedImageUrls.length > 0) {
    saveSelectedImages(row.rowIndex, selectedImageUrls, selectedImageCategories);
  }

  // 編集値をシートに反映
  if (e.parameter.buildingName !== undefined) {
    updateSheetWithEdits(row.rowIndex, prop);
  }

  // ビューURL（hashUrl 最速 → minimalUrl フォールバック → plainUrl 最終手段）
  var plainUrl = 'https://form.ehomaki.com/property.html?customer=' + encodeURIComponent(customerName) + '&room_id=' + roomId;
  var hashUrl = buildViewUrl(customerName, roomId, prop, []); // 画像なし → URL短縮
  var minimalUrl = buildMinimalViewUrl(customerName, roomId, prop);
  var viewUrl = hashUrl.length <= 1000 ? hashUrl : (minimalUrl.length <= 1000 ? minimalUrl : plainUrl); // 通常 minimalUrl が選ばれる // LINE URI action 1000文字制限

  // 画像URLをキャッシュ（property.html からの非同期取得用）
  cachePropertyImages(customerName, roomId, selectedImageUrls, selectedImageCategories);

  var flex = buildPropertyFlex(prop, {
    includeImage: selectedImageUrls.length > 0,
    heroImageUrl: selectedImageUrls.length > 0 ? selectedImageUrls[0] : '',
    viewUrl: viewUrl
  });

  pushMessage(lineUserId, [flex]);
  updatePendingStatus(row.rowIndex, 'sent', viewUrl);
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
    var selectedCats = [];
    if (includeImage) {
      selectedUrls = prop.imageUrls && prop.imageUrls.length > 0 ? prop.imageUrls : (prop.imageUrl ? [prop.imageUrl] : []);
      selectedCats = prop.imageCategories || [];
      if (selectedUrls.length > 0) {
        saveSelectedImages(rows[i].rowIndex, selectedUrls, selectedCats);
      }
    }

    var plainUrl = 'https://form.ehomaki.com/property.html?customer=' + encodeURIComponent(customerName) + '&room_id=' + rid;
    var hashUrl = buildViewUrl(customerName, rid, prop, []); // 画像なし → URL短縮
    var minimalUrl = buildMinimalViewUrl(customerName, rid, prop);
    var viewUrl = hashUrl.length <= 1000 ? hashUrl : (minimalUrl.length <= 1000 ? minimalUrl : plainUrl); // 通常 minimalUrl が選ばれる

    // 画像URLをキャッシュ（property.html からの非同期取得用）
    cachePropertyImages(customerName, rid, selectedUrls, selectedCats);

    var flex = buildPropertyFlex(prop, {
      includeImage: includeImage,
      heroImageUrl: selectedUrls.length > 0 ? selectedUrls[0] : '',
      viewUrl: viewUrl
    });

    pushMessage(lineUserId, [flex]);
    updatePendingStatus(rows[i].rowIndex, 'sent', viewUrl);
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

  // sent または pending の物件を表示（LINE送信失敗時でも閲覧可能に）
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (!sheet) {
    return makeHtml('エラー', 'シートが見つかりません。');
  }

  var data = sheet.getDataRange().getValues();
  var prop = null;
  for (var i = 1; i < data.length; i++) {
    var status = String(data[i][10]);
    if (String(data[i][0]) === String(customerName) &&
        String(data[i][2]) === String(roomId) &&
        (status === 'sent' || status === 'pending')) {
      prop = rowToProperty(data[i]);
      break;
    }
  }

  if (!prop) {
    return makeHtml('注意', 'この物件情報は表示できません。');
  }

  // property.html へリダイレクト（GASバナー回避 — target="_top" でGAS iframeから脱出）
  var viewImages = prop.selectedImageUrls || prop.imageUrls || [];
  if (viewImages.length === 0 && prop.imageUrl) {
    viewImages = [prop.imageUrl];
  }
  var redirectUrl = buildViewUrl(customerName, roomId, prop, viewImages);
  var redirectHtml = '<html><head><meta charset="utf-8">'
    + '<style>body{display:flex;align-items:center;justify-content:center;min-height:80vh;font-family:sans-serif;color:#888}</style>'
    + '</head><body><p>\u8AAD\u307F\u8FBC\u307F\u4E2D...</p>'
    + '<a id="r" href="' + _esc(redirectUrl) + '" target="_top" style="display:none">redirect</a>'
    + '<script>document.getElementById("r").click();</script>'
    + '</body></html>';
  return HtmlService.createHtmlOutput(redirectHtml)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== 画像キャッシュ（承認時に保存、property.html から非同期取得） =====
function cachePropertyImages(customerName, roomId, imageUrls, imageCategories) {
  if (!imageUrls || imageUrls.length === 0) return;
  try {
    var cache = CacheService.getScriptCache();
    var key = 'imgs_' + customerName + '_' + roomId;
    var data = {images: imageUrls};
    if (imageCategories && imageCategories.length > 0) {
      data.categories = imageCategories;
    }
    cache.put(key, JSON.stringify(data), 86400); // 24時間
  } catch(e) {
    // キャッシュ失敗は無視（フォールバックでシートから取得）
  }
}

// ===== 画像専用 API（property.html からの非同期取得用、高速） =====
function handlePropertyImagesApi(e) {
  var customerName = e.parameter.customer;
  var roomId = e.parameter.room_id;

  if (!customerName || !roomId) {
    return ContentService.createTextOutput(JSON.stringify({images: []}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 1. キャッシュから取得（高速 < 100ms）
  var nocache = e.parameter.nocache === '1';
  try {
    var cache = CacheService.getScriptCache();
    var key = 'imgs_' + customerName + '_' + roomId;
    if (nocache) {
      cache.remove(key);
    } else {
      var cached = cache.get(key);
      if (cached) {
        var cachedData = JSON.parse(cached);
        // 新形式: {images:[...], categories:[...]} / 旧形式: [url, ...]
        if (Array.isArray(cachedData)) {
          // 旧形式キャッシュ → 新形式に変換
          return ContentService.createTextOutput(JSON.stringify({images: cachedData, categories: []}))
            .setMimeType(ContentService.MimeType.JSON);
        }
        return ContentService.createTextOutput(JSON.stringify({
          images: cachedData.images || [],
          categories: cachedData.categories || []
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }
  } catch(e) {}

  // 2. フォールバック: シートから取得
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({images: [], categories: []}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var status = String(data[i][10]);
    if (String(data[i][0]) === String(customerName) &&
        String(data[i][2]) === String(roomId) &&
        (status === 'sent' || status === 'pending')) {
      var prop = rowToProperty(data[i]);
      var imgs = prop.selectedImageUrls || prop.imageUrls || [];
      var cats = prop.selectedImageCategories || prop.imageCategories || [];
      if (imgs.length === 0 && prop.imageUrl) { imgs = [prop.imageUrl]; cats = ['']; }
      // 次回用にキャッシュ
      cachePropertyImages(customerName, roomId, imgs, cats);
      return ContentService.createTextOutput(JSON.stringify({images: imgs, categories: cats}))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  return ContentService.createTextOutput(JSON.stringify({images: [], categories: []}))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== お客さん向け物件資料 JSON API（GitHub Pages から呼ばれる） =====
function handlePropertyViewApi(e) {
  var customerName = e.parameter.customer;
  var roomId = e.parameter.room_id;

  if (!customerName || !roomId) {
    return ContentService.createTextOutput(JSON.stringify({error: 'パラメータが不足しています。'}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 1. キャッシュから取得（高速）
  var nocache = e.parameter.nocache === '1';
  try {
    var cache = CacheService.getScriptCache();
    var cacheKey = 'prop2_' + customerName + '_' + roomId;
    if (nocache) {
      cache.remove(cacheKey);
      // 画像キャッシュもクリア
      cache.remove('imgs_' + customerName + '_' + roomId);
    } else {
      var cached = cache.get(cacheKey);
      if (cached) {
        return ContentService.createTextOutput(cached)
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
  } catch(e) {}

  // 2. フォールバック: シートから取得
  // sent または pending の物件を表示（LINE送信失敗時でも閲覧可能に）
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({error: 'シートが見つかりません。'}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var data = sheet.getDataRange().getValues();
  var prop = null;
  for (var i = 1; i < data.length; i++) {
    var status = String(data[i][10]);
    if (String(data[i][0]) === String(customerName) &&
        String(data[i][2]) === String(roomId) &&
        (status === 'sent' || status === 'pending')) {
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
  var viewCategories = prop.selectedImageCategories || prop.imageCategories || [];
  if (viewImages.length === 0 && prop.imageUrl) {
    viewImages = [prop.imageUrl];
    viewCategories = [''];
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
    imageCategories: viewCategories,
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
    keyExchangeFee: prop.keyExchangeFee,
    supportFee24h: prop.supportFee24h,
    rightsFee: prop.rightsFee,
    additionalDeposit: prop.additionalDeposit,
    guaranteeDeposit: prop.guaranteeDeposit,
    waterBilling: prop.waterBilling,
    parkingFee: prop.parkingFee,
    bicycleParkingFee: prop.bicycleParkingFee,
    motorcycleParkingFee: prop.motorcycleParkingFee,
    otherMonthlyFee: prop.otherMonthlyFee,
    otherOnetimeFee: prop.otherOnetimeFee,
    cleaningFee: prop.cleaningFee,
    moveInConditions: prop.moveInConditions,
    freeRentDetail: prop.freeRentDetail,
    layoutDetail: prop.layoutDetail,
    adFee: prop.adFee,
    currentStatus: prop.currentStatus
  };

  // キャッシュに保存（24時間）
  try {
    var cache = CacheService.getScriptCache();
    var resultJson = JSON.stringify(result);
    cache.put('prop2_' + customerName + '_' + roomId, resultJson, 86400);
  } catch(e) {}

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== 閲覧トラッキング =====
var VIEW_LOG_SHEET_NAME = '閲覧ログ';

function handleTrackView(e) {
  var customerName = e.parameter.customer;
  var roomId = e.parameter.room_id;

  if (!customerName || !roomId) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'missing params' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  // 物件名を取得（承認待ちシートから）
  var buildingName = '';
  var pendingSheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (pendingSheet) {
    var data = pendingSheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(customerName) && String(data[i][2]) === String(roomId)) {
        buildingName = String(data[i][3] || '');
        break;
      }
    }
  }

  // 閲覧ログシートに記録
  var logSheet = ss.getSheetByName(VIEW_LOG_SHEET_NAME);
  if (!logSheet) {
    logSheet = ss.insertSheet(VIEW_LOG_SHEET_NAME);
    logSheet.appendRow(['顧客名', 'room_id', '物件名', '閲覧日時']);
  }

  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  var isFirstView = true;

  // 初回閲覧チェック（同じ customer + room_id が既にあるか）
  var logData = logSheet.getDataRange().getValues();
  for (var i = 1; i < logData.length; i++) {
    if (String(logData[i][0]) === String(customerName) && String(logData[i][1]) === String(roomId)) {
      isFirstView = false;
      break;
    }
  }

  logSheet.appendRow([customerName, roomId, buildingName, now]);

  // 初回閲覧時のみ Discord 通知
  if (isFirstView) {
    try {
      var webhookUrl = PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK_URL');
      if (webhookUrl) {
        // 顧客専用スレッドに送信（なければ顧客名でスレッド新規作成）
        var threadId = PropertiesService.getScriptProperties().getProperty('DISCORD_THREAD_' + customerName);
        var time = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm');
        var msg = '<@1459814543600390341>\n\uD83D\uDC40 **' + customerName + '** 様が「' + (buildingName || 'room_id: ' + roomId) + '」を閲覧しました (' + time + ')';

        var url = webhookUrl + (threadId ? '?thread_id=' + threadId : '?wait=true');
        var payload = { content: msg, allowed_mentions: { users: ['1459814543600390341'] } };
        if (!threadId) {
          payload.thread_name = '\uD83C\uDFE0 ' + customerName;
        }

        var resp = UrlFetchApp.fetch(url, {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });

        // 新規スレッド作成時は顧客専用スレッドIDとして保存
        if (!threadId && resp.getResponseCode() === 200) {
          try {
            var body = JSON.parse(resp.getContentText());
            if (body.channel_id) {
              PropertiesService.getScriptProperties().setProperty('DISCORD_THREAD_' + customerName, body.channel_id);
            }
          } catch(e) {}
        }
      }
      // スマホ向けプッシュ通知
      try { sendPushNotification(customerName + ' 様が「' + (buildingName || roomId) + '」を閲覧', '👀 閲覧通知'); } catch(e) {}
    } catch(e) {
      console.error('Discord view notification error: ' + e.message);
    }
  }

  return ContentService.createTextOutput(JSON.stringify({ ok: true, first: isFirstView }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== 物件アクション（統合: 押さえたい/内見/お気に入り/興味なし） =====
var ACTION_LOG_SHEET_NAME = 'アクションログ';

// action_type: 'hold', 'viewing', 'favorite', 'not_interested', 'clear'
function handlePropertyAction(e) {
  var customerName = e.parameter.customer;
  var roomId = e.parameter.room_id;
  var actionType = e.parameter.action_type;
  var buildingName = e.parameter.building_name || '';
  var roomNumber = e.parameter.room_number || '';
  var rent = e.parameter.rent || '';
  var layout = e.parameter.layout || '';
  var stationInfo = e.parameter.station_info || '';
  var applicationType = e.parameter.application_type || '';
  var applicantName = e.parameter.applicant_name || '';
  var furigana = e.parameter.furigana || '';
  var email = e.parameter.email || '';
  var phone = e.parameter.phone || '';
  var contactInfo = e.parameter.contact_info || '';
  if (!contactInfo && (applicantName || furigana || email || phone)) {
    contactInfo = [applicantName ? '氏名: ' + applicantName : '', furigana ? 'フリガナ: ' + furigana : '', email ? 'Email: ' + email : '', phone ? 'Tel: ' + phone : ''].filter(Boolean).join(' / ');
  }

  if (!customerName || !roomId || !actionType) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'missing parameters' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(ACTION_LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ACTION_LOG_SHEET_NAME);
    sheet.appendRow(['顧客名', 'room_id', 'アクション', '物件名', '部屋番号', '賃料', '間取り', '最寄駅', '日時', '申込区分', '連絡先']);
  }

  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  var loggedRowIdx = 0;
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
    sheet.appendRow([customerName, roomId, actionType, buildingName, roomNumber, rent, layout, stationInfo, now, applicationType, contactInfo]);
    SpreadsheetApp.flush();
    loggedRowIdx = sheet.getLastRow();
  } catch(e) {
    console.error('appendRow lock error: ' + e.message);
  } finally {
    try { lock.releaseLock(); } catch(e) {}
  }
  var discordStatus = '';

  // お気に入り件数を計算（favorite/not_interested/clear の場合）
  var favoriteCount = 0;
  var isFeedback = (actionType === 'favorite' || actionType === 'not_interested' || actionType === 'clear');
  if (isFeedback) {
    favoriteCount = countFavorites(sheet, customerName);
  }

  // Discord 通知（clear 以外の全アクション）
  if (actionType !== 'clear') {
    try {
      var webhookUrl = PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK_URL');
      if (webhookUrl) {
        // 顧客専用スレッドに送信（なければ顧客名でスレッド新規作成）
        var threadId = PropertiesService.getScriptProperties().getProperty('DISCORD_THREAD_' + customerName);
        var time = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm');
        var rentText = rent ? _fmtMan(parseInt(rent)) + '万円' : '';
        var propLabel = buildingName || ('room_id: ' + roomId);
        if (roomNumber) propLabel += ' ' + roomNumber;

        var msgMap = {
          'hold': '\uD83C\uDFE0 **' + customerName + '** 様が「' + propLabel + '」に **お申し込み希望** をされました！',
          'hold_intent': '\uD83D\uDC40 **' + customerName + '** 様が「' + propLabel + '」の **お申し込み希望画面を開きました**（未送信）',
          'favorite': '\u2B50 **' + customerName + '** 様が「' + propLabel + '」を **お気に入り** に追加しました',
          'not_interested': '\uD83D\uDC4E **' + customerName + '** 様が「' + propLabel + '」を **興味なし** にしました',
          'view': '\uD83D\uDCC4 **' + customerName + '** 様が「' + propLabel + '」を閲覧しました'
        };
        var msg = msgMap[actionType] || '';
        if (!msg) return ContentService.createTextOutput(JSON.stringify({ ok: true, favoriteCount: favoriteCount })).setMimeType(ContentService.MimeType.JSON);
        msg = '<@1459814543600390341>\n' + msg;

        // お申し込みの場合、申込区分・申込者情報を表示
        if (actionType === 'hold') {
          msg += '\n> 申込区分: ' + (applicationType || '未指定');
          if (applicantName) msg += '\n> 氏名: ' + applicantName;
          if (furigana) msg += '\n> フリガナ: ' + furigana;
          if (email) msg += '\n> Email: ' + email;
          if (phone) msg += '\n> Tel: ' + phone;
          msg += '\n> → お電話でお申し込み方法のご案内をお願いします';
        }
        if (rentText || layout) {
          msg += '\n> ' + [rentText, layout].filter(Boolean).join(' / ');
        }
        msg += ' (' + time + ')';

        var url = webhookUrl + (threadId ? '?thread_id=' + threadId : '?wait=true');
        var payload = { content: msg, allowed_mentions: { users: ['1459814543600390341'] } };
        if (!threadId) {
          payload.thread_name = '\uD83C\uDFE0 ' + customerName;
        }

        var fetchOpts = {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        };
        var resp = UrlFetchApp.fetch(url, fetchOpts);
        var code = resp.getResponseCode();
        // 429 はリトライ
        if (code === 429) {
          var waitMs = 1000;
          try {
            var rb = JSON.parse(resp.getContentText());
            if (rb && rb.retry_after) waitMs = Math.ceil(parseFloat(rb.retry_after) * 1000) + 100;
          } catch(e) {}
          if (waitMs > 5000) waitMs = 5000;
          Utilities.sleep(waitMs);
          resp = UrlFetchApp.fetch(url, fetchOpts);
          code = resp.getResponseCode();
          discordStatus = 'code=429→' + code;
        } else {
          discordStatus = 'code=' + code;
        }
        console.log('Discord webhook code=' + code + ' threadId=' + threadId + ' body=' + resp.getContentText().substring(0, 200));

        // スレッドが死んでいる場合（404 等）→ thread_id を消して新規作成
        var isCustomerThread = !!PropertiesService.getScriptProperties().getProperty('DISCORD_THREAD_' + customerName);
        if (threadId && (code === 404 || code === 400)) {
          // 顧客スレッドが無効化された場合はプロパティを削除して再作成
          PropertiesService.getScriptProperties().deleteProperty('DISCORD_THREAD_' + customerName);
          var retryPayload = { content: msg, thread_name: '\uD83C\uDFE0 ' + customerName, allowed_mentions: { users: ['1459814543600390341'] } };
          var retryResp = UrlFetchApp.fetch(webhookUrl + '?wait=true', {
            method: 'post',
            contentType: 'application/json',
            payload: JSON.stringify(retryPayload),
            muteHttpExceptions: true
          });
          discordStatus += ' retry=' + retryResp.getResponseCode();
          console.log('Discord retry code=' + retryResp.getResponseCode());
          if (retryResp.getResponseCode() === 200) {
            try {
              var rbody = JSON.parse(retryResp.getContentText());
              if (rbody.channel_id) {
                PropertiesService.getScriptProperties().setProperty('DISCORD_THREAD_' + customerName, rbody.channel_id);
              }
            } catch(e) {}
          }
        } else if (!threadId && code === 200) {
          try {
            var body = JSON.parse(resp.getContentText());
            if (body.channel_id) {
              PropertiesService.getScriptProperties().setProperty('DISCORD_THREAD_' + customerName, body.channel_id);
            }
          } catch(e) {}
        }
      } else {
        discordStatus = 'no_webhook';
      }
      // スマホ向けプッシュ通知
      var pushMsgMap = {
        'hold': { msg: customerName + ' 様が「' + propLabel + '」に申込希望！', title: '🏠 申込希望' },
        'hold_intent': { msg: customerName + ' 様が「' + propLabel + '」の申込画面を表示', title: '👀 申込画面表示' },
        'favorite': { msg: customerName + ' 様が「' + propLabel + '」をお気に入り', title: '⭐ お気に入り' },
        'not_interested': null,
        'view': { msg: customerName + ' 様が「' + propLabel + '」を閲覧', title: '📄 閲覧' }
      };
      var pushInfo = pushMsgMap[actionType];
      if (pushInfo) { try { sendPushNotification(pushInfo.msg, pushInfo.title); } catch(e) {} }
    } catch(e) {
      discordStatus = 'exception:' + ((e && e.message ? e.message : String(e))).substring(0, 100);
      console.error('Discord action notification error: ' + e.message);
    }
    // L列(12)に応答コードを記録
    try { sheet.getRange(loggedRowIdx, 12).setValue(discordStatus); } catch(e) {}
  }

  // 仮押さえの場合、顧客にLINE確認メッセージを送信
  if (actionType === 'hold') {
    try {
      var lineUserId = findLineUserId(customerName);
      if (lineUserId) {
        var propLabel = buildingName || ('room_id: ' + roomId);
        if (roomNumber) propLabel += ' ' + roomNumber;
        var flex = {
          type: 'flex',
          altText: 'お申し込み希望を受け付けました',
          contents: {
            type: 'bubble',
            body: {
              type: 'box',
              layout: 'vertical',
              spacing: 'md',
              contents: [
                { type: 'text', text: '✅ お申し込み希望受付', weight: 'bold', size: 'lg', color: '#2E7D32' },
                { type: 'separator' },
                { type: 'text', text: propLabel, weight: 'bold', size: 'md', wrap: true },
                { type: 'box', layout: 'vertical', spacing: 'sm', margin: 'md', contents: [
                  { type: 'text', text: [rentText, layout].filter(Boolean).join(' / '), size: 'sm', color: '#666666' },
                  { type: 'text', text: '申込区分: ' + (applicationType || '未指定'), size: 'sm', color: '#666666' }
                ]},
                { type: 'separator' },
                { type: 'text', text: 'この後、担当者がお電話にてお申し込み方法のご案内のためご連絡いたします。しばらくお待ちください。', size: 'sm', color: '#888888', wrap: true }
              ]
            }
          }
        };
        pushMessage(lineUserId, [flex]);
      }
    } catch(e) {
      console.error('LINE hold notification error: ' + e.message);
    }
  }

  return ContentService.createTextOutput(JSON.stringify({ ok: true, favoriteCount: favoriteCount }))
    .setMimeType(ContentService.MimeType.JSON);
}

// 顧客のお気に入り件数を集計（各room_idの最新feedbackが 'favorite' のものをカウント）
function countFavorites(sheet, customerName) {
  var data = sheet.getDataRange().getValues();
  var latestFeedback = {}; // room_id → 最新の feedback action
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== String(customerName)) continue;
    var act = String(data[i][2]);
    if (act === 'favorite' || act === 'not_interested' || act === 'clear') {
      latestFeedback[String(data[i][1])] = act;
    }
  }
  var count = 0;
  for (var rid in latestFeedback) {
    if (latestFeedback[rid] === 'favorite') count++;
  }
  return count;
}

// ===== お気に入り一覧コマンド（LINE「お気に入り」で発火） =====
function handleFavoritesCommand(replyToken, userId) {
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);

    // userId → 顧客名
    var luSheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);
    var customerName = '';
    if (luSheet) {
      var luData = luSheet.getDataRange().getValues();
      for (var i = 1; i < luData.length; i++) {
        if (String(luData[i][0]).trim() === String(userId).trim()) { customerName = String(luData[i][1] || '').trim(); break; }
      }
    }
    if (!customerName) {
      replyMessage(replyToken, [textMsg('ご希望条件が未登録のようです。まずは「条件登録」からお願いいたします。')]);
      return;
    }

    // アクションログから最新が favorite の room_id を抽出
    var logSheet = ss.getSheetByName(ACTION_LOG_SHEET_NAME);
    if (!logSheet) {
      replyMessage(replyToken, [textMsg('お気に入り物件はまだありません。')]);
      return;
    }
    var logData = logSheet.getDataRange().getValues();
    var latest = {}; // room_id → action
    var matchedRows = 0;
    for (var i = 1; i < logData.length; i++) {
      if (String(logData[i][0]).trim() !== customerName) continue;
      matchedRows++;
      var act = String(logData[i][2]).trim();
      if (act === 'favorite' || act === 'not_interested' || act === 'clear') {
        latest[String(logData[i][1]).trim()] = act;
      }
    }
    var favRoomIds = {};
    var favCount = 0;
    for (var rid in latest) {
      if (latest[rid] === 'favorite') { favRoomIds[rid] = true; favCount++; }
    }
    if (favCount === 0) {
      replyMessage(replyToken, [textMsg('お気に入りはまだありません。\n\n通知された物件で「お気に入り」を押すと、こちらで一覧を確認できます。')]);
      return;
    }

    // 承認待ち物件シートから物件情報を取得（rowToProperty で完全な prop を作る）
    var pendSheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PENDING_SHEET_NAME);
    var favRows = [];
    if (pendSheet) {
      var pData = pendSheet.getDataRange().getValues();
      for (var i = 1; i < pData.length; i++) {
        if (String(pData[i][0]).trim() !== customerName) continue;
        var rid = String(pData[i][2]).trim();
        if (!favRoomIds[rid]) continue;
        favRows.push(pData[i]);
      }
    }

    if (favRows.length === 0) {
      replyMessage(replyToken, [textMsg('お気に入り物件はまだありません。\n\n物件ページの ⭐ ボタンでお気に入りに追加できます。')]);
      return;
    }

    // 承認時と同じ Flex を構築（buildPropertyFlex）
    var bubbles = [];
    var max = Math.min(favRows.length, 10);
    for (var i = 0; i < max; i++) {
      var prop = rowToProperty(favRows[i]);
      var rid = String(favRows[i][2]);
      var savedViewUrl = String(favRows[i][13] || '');
      var plainUrl = 'https://form.ehomaki.com/property.html?customer=' + encodeURIComponent(customerName) + '&room_id=' + rid;
      var minimalUrl = buildMinimalViewUrl(customerName, rid, prop);
      var viewUrl = savedViewUrl || (minimalUrl.length <= 1000 ? minimalUrl : plainUrl);

      var heroImageUrl = (prop.imageUrls && prop.imageUrls.length > 0) ? prop.imageUrls[0] : (prop.imageUrl || '');
      var flex = buildPropertyFlex(prop, {
        includeImage: !!heroImageUrl,
        heroImageUrl: heroImageUrl,
        viewUrl: viewUrl
      });
      // buildPropertyFlex は { type:'flex', altText, contents:bubble } を返すので bubble だけ取り出す
      if (flex && flex.contents) {
        bubbles.push(flex.contents);
      }
    }

    if (bubbles.length === 0) {
      replyMessage(replyToken, [textMsg('お気に入り物件の表示に失敗しました。')]);
      return;
    }

    var altText = '⭐ お気に入り物件 ' + favRows.length + '件';
    if (favRows.length > 10) altText += '（10件まで表示）';

    if (bubbles.length === 1) {
      replyMessage(replyToken, [{ type: 'flex', altText: altText, contents: bubbles[0] }]);
    } else {
      replyMessage(replyToken, [{
        type: 'flex',
        altText: altText,
        contents: { type: 'carousel', contents: bubbles }
      }]);
    }
  } catch (err) {
    console.error('handleFavoritesCommand error: ' + err.message + '\n' + err.stack);
    try { replyMessage(replyToken, [textMsg('お気に入り一覧の取得に失敗しました。時間をおいて再度お試しください。')]); } catch(e) {}
  }
}

// 配信ステータスを取得する (userId → 'paused' | 'active')
function getDeliveryStatus(userId) {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var luSheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);
    if (!luSheet) return 'active';
    var luData = luSheet.getDataRange().getValues();
    var customerName = null;
    for (var i = 1; i < luData.length; i++) {
      if (luData[i][0] === userId) { customerName = luData[i][1]; break; }
    }
    if (!customerName) return 'active';
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return 'active';
    var data = sheet.getDataRange().getValues();
    var latestStatus = 'active';
    for (var j = 1; j < data.length; j++) {
      if (data[j][1] === customerName) {
        var s = String(data[j][18] || '').trim().toLowerCase();
        latestStatus = (s === 'paused') ? 'paused' : 'active';
      }
    }
    return latestStatus;
  } catch (err) {
    console.error('getDeliveryStatus error: ' + err.message);
    return 'active';
  }
}

// 配信ステータスを更新する (userId に紐づく最新行の S列を書き換え)
function setDeliveryStatus(userId, status) {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var luSheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);
  if (!luSheet) return { ok: false, error: 'no_line_users_sheet' };
  var luData = luSheet.getDataRange().getValues();
  var customerName = null;
  for (var i = 1; i < luData.length; i++) {
    if (luData[i][0] === userId) { customerName = luData[i][1]; break; }
  }
  if (!customerName) return { ok: false, error: 'no_customer' };
  var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'no_criteria_sheet' };
  var data = sheet.getDataRange().getValues();
  var targetRow = -1;
  for (var j = 1; j < data.length; j++) {
    if (data[j][1] === customerName) targetRow = j + 1; // 最新行(末尾)
  }
  if (targetRow < 0) return { ok: false, error: 'no_criteria_row' };
  sheet.getRange(targetRow, 19).setValue(status); // S列 = 19
  if (status === 'active') {
    sheet.getRange(targetRow, 22).setValue(''); // V列: スヌーズ解除
  }
  return { ok: true, customerName: customerName };
}

// 配信停止コマンド: まずは理由を聞く（ステータスは確定時に変更）
function handleDeliveryStopCommand(replyToken, userId) {
  try {
    var loc = _findCustomerRow(userId);
    if (!loc) {
      replyMessage(replyToken, [textMsg('ご希望条件が未登録のようです。まずは「条件登録」からお願いいたします。')]);
      return;
    }
    saveState(userId, { step: STEPS.WAITING_STOP_REASON, data: {} });
    replyMessage(replyToken, [{
      type: 'text',
      text: '配信停止の前に、差し支えなければ理由を教えていただけますか？\n' +
        '今後のサービス改善に活用させていただきます。\n\n' +
        'やめる場合は「キャンセル」とお送りください。',
      quickReply: {
        items: [
          { type: 'action', action: { type: 'message', label: '引越し先が決まった', text: '停止理由:引越し先が決まった' } },
          { type: 'action', action: { type: 'message', label: '忙しくて見る時間がない', text: '停止理由:忙しくて見る時間がない' } },
          { type: 'action', action: { type: 'message', label: '希望に合わない', text: '停止理由:希望に合わない' } },
          { type: 'action', action: { type: 'message', label: '通知が多い', text: '停止理由:通知が多い' } },
          { type: 'action', action: { type: 'message', label: 'その他', text: '停止理由:その他' } }
        ]
      }
    }]);
  } catch (err) {
    console.error('handleDeliveryStopCommand error: ' + err.message + '\n' + err.stack);
    try { replyMessage(replyToken, [textMsg('配信停止の処理に失敗しました。時間をおいて再度お試しください。')]); } catch(e) {}
  }
}

// userId に紐づく最新行の U列に停止日時を記録する
function _recordStopTimestamp(userId) {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var luSheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);
    if (!luSheet) return;
    var luData = luSheet.getDataRange().getValues();
    var customerName = null;
    for (var i = 1; i < luData.length; i++) {
      if (luData[i][0] === userId) { customerName = luData[i][1]; break; }
    }
    if (!customerName) return;
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return;
    var data = sheet.getDataRange().getValues();
    var targetRow = -1;
    for (var j = 1; j < data.length; j++) {
      if (data[j][1] === customerName) targetRow = j + 1;
    }
    if (targetRow > 0) sheet.getRange(targetRow, 21).setValue(new Date()); // U列 = 21
  } catch (err) {
    console.error('_recordStopTimestamp error: ' + err.message);
  }
}

// 停止理由をシートに保存する (T列 = 20)
function _saveStopReason(userId, reason) {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var luSheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);
    if (!luSheet) return;
    var luData = luSheet.getDataRange().getValues();
    var customerName = null;
    for (var i = 1; i < luData.length; i++) {
      if (luData[i][0] === userId) { customerName = luData[i][1]; break; }
    }
    if (!customerName) return;
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return;
    var data = sheet.getDataRange().getValues();
    var targetRow = -1;
    for (var j = 1; j < data.length; j++) {
      if (data[j][1] === customerName) targetRow = j + 1;
    }
    if (targetRow > 0) sheet.getRange(targetRow, 20).setValue(reason); // T列 = 20
  } catch (err) {
    console.error('_saveStopReason error: ' + err.message);
  }
}

// 停止理由フローのテキスト処理 (WAITING_STOP_REASON / WAITING_STOP_REASON_CUSTOM 中)
// 返り値 true: ハンドル済み / false: 未ハンドル
function handleStopReasonText(replyToken, userId, message, state) {
  try {
    if (state.step === STEPS.WAITING_STOP_REASON_CUSTOM) {
      // 自由入力フェーズ: ここで初めて配信停止を確定
      _finalizeStop(userId, message);
      clearState(userId);
      replyMessage(replyToken, [textMsg(
        '配信を停止しました。ご回答ありがとうございます。\n\n' +
        '再開したくなったら、「配信再開」とお送りいただくか、「使い方」メニューから再開できます。'
      )]);
      return true;
    }

    if (state.step !== STEPS.WAITING_STOP_REASON) return false;

    if (message.indexOf('停止理由:') !== 0) {
      // 選択肢外: 再度選択肢を提示
      replyMessage(replyToken, [{
        type: 'text',
        text: 'お手数ですが、下の選択肢から選んでください。',
        quickReply: {
          items: [
            { type: 'action', action: { type: 'message', label: '引越し先が決まった', text: '停止理由:引越し先が決まった' } },
            { type: 'action', action: { type: 'message', label: '忙しくて見る時間がない', text: '停止理由:忙しくて見る時間がない' } },
            { type: 'action', action: { type: 'message', label: '希望に合わない', text: '停止理由:希望に合わない' } },
            { type: 'action', action: { type: 'message', label: '通知が多い', text: '停止理由:通知が多い' } },
            { type: 'action', action: { type: 'message', label: 'その他', text: '停止理由:その他' } },
            { type: 'action', action: { type: 'message', label: 'キャンセル', text: 'キャンセル' } }
          ]
        }
      }]);
      return true;
    }

    var reason = message.substring('停止理由:'.length);

    if (reason === 'その他') {
      // 自由入力に遷移（まだ停止は確定しない）
      saveState(userId, { step: STEPS.WAITING_STOP_REASON_CUSTOM, data: {} });
      replyMessage(replyToken, [textMsg('差し支えなければ、理由をお聞かせください。')]);
      return true;
    }

    // 忙しくて/通知が多い は下で分岐して status 変更しない

    if (reason === '忙しくて見る時間がない') {
      // スヌーズ案内
      saveState(userId, { step: STEPS.WAITING_SNOOZE_PERIOD, data: {} });
      replyMessage(replyToken, [{
        type: 'text',
        text: 'かしこまりました。\nもしよろしければ、完全に停止する代わりに「一定期間だけお休み」することもできます。期間が経過すると自動で配信を再開いたします。\n\n期間を選ぶか、このまま配信を停止する場合は「配信停止」を選んでください。',
        quickReply: {
          items: [
            { type: 'action', action: { type: 'message', label: '24時間休む', text: '24時間停止' } },
            { type: 'action', action: { type: 'message', label: '3日休む', text: '3日間停止' } },
            { type: 'action', action: { type: 'message', label: '1週間休む', text: '1週間停止' } },
            { type: 'action', action: { type: 'message', label: '2週間休む', text: '2週間停止' } },
            { type: 'action', action: { type: 'message', label: '1ヶ月休む', text: '1ヶ月停止' } },
            { type: 'action', action: { type: 'message', label: '配信停止', text: '配信停止（期間なし）' } },
            { type: 'action', action: { type: 'message', label: 'キャンセル', text: 'キャンセル' } }
          ]
        }
      }]);
      return true;
    }

    if (reason === '希望に合わない') {
      // 完全停止の代わりに条件変更を提案
      saveState(userId, { step: STEPS.WAITING_MISMATCH_CHOICE, data: {} });
      replyMessage(replyToken, [{
        type: 'text',
        text: 'ご希望に沿えず申し訳ございません。\nよろしければ、希望条件を変更してみませんか？条件を見直すと、よりマッチする物件をお届けできるかもしれません。\n\n条件を変更するか、このまま配信を停止する場合は「配信停止」を選んでください。',
        quickReply: {
          items: [
            { type: 'action', action: { type: 'message', label: '条件を変更する', text: '条件変更' } },
            { type: 'action', action: { type: 'message', label: '配信停止', text: 'ミスマッチ:停止' } },
            { type: 'action', action: { type: 'message', label: 'キャンセル', text: 'キャンセル' } }
          ]
        }
      }]);
      return true;
    }

    if (reason === '通知が多い') {
      // 完全停止の代わりに頻度を下げる提案。いったん paused のまま選択を待つ
      saveState(userId, { step: STEPS.WAITING_FREQUENCY, data: {} });
      replyMessage(replyToken, [{
        type: 'text',
        text: '通知が多くてご不便をおかけして申し訳ございません。\nもしよろしければ、完全に停止する代わりに通知の頻度を下げることもできます。\n\n頻度を選ぶか、このまま配信を停止する場合は「配信停止」を選んでください。',
        quickReply: {
          items: [
            { type: 'action', action: { type: 'message', label: '2日に1回', text: '頻度:2日に1回' } },
            { type: 'action', action: { type: 'message', label: '3日に1回', text: '頻度:3日に1回' } },
            { type: 'action', action: { type: 'message', label: '週1回', text: '頻度:週1回' } },
            { type: 'action', action: { type: 'message', label: '配信停止', text: '頻度:停止' } },
            { type: 'action', action: { type: 'message', label: 'キャンセル', text: 'キャンセル' } }
          ]
        }
      }]);
      return true;
    }

    // 引越し先が決まった など → 停止確定
    _finalizeStop(userId, reason);
    clearState(userId);
    replyMessage(replyToken, [textMsg(
      '配信を停止しました。ご回答ありがとうございます。\n\n' +
      '再開したくなったら、「配信再開」とお送りいただくか、「使い方」メニューから再開できます。'
    )]);
    return true;
  } catch (err) {
    console.error('handleStopReasonText error: ' + err.message + '\n' + err.stack);
    try { clearState(userId); } catch(e) {}
    try { replyMessage(replyToken, [textMsg('ご回答ありがとうございます。')]); } catch(e) {}
    return true;
  }
}

// 条件シートの1行目にヘッダ項目名をセットする（手動で1回実行すればOK）
function setupCriteriaHeaders() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
  if (!sheet) throw new Error('criteria sheet not found');
  var headers = [
    'タイムスタンプ', '名前', '都道府県', '市区町村', '路線(駅名)', '駅名',
    '徒歩', '賃料上限', '間取り', '面積', '築年数', '構造',
    '設備', '理由', '引越し時期', 'その他', 'ペット', '居住者',
    '配信ステータス', '停止理由', '停止日時', 'スヌーズ解除日時', '配信頻度', '最終配信日時'
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

// 配信停止を確定する: 理由保存 + status=paused + 停止日時
function _finalizeStop(userId, reason) {
  try {
    if (reason) _saveStopReason(userId, reason);
    setDeliveryStatus(userId, 'paused');
    _recordStopTimestamp(userId);
  } catch (err) {
    console.error('_finalizeStop error: ' + err.message);
  }
}

// 顧客の最新行を取得するヘルパー
function _findCustomerRow(userId) {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var luSheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);
  if (!luSheet) return null;
  var luData = luSheet.getDataRange().getValues();
  var customerName = null;
  for (var i = 1; i < luData.length; i++) {
    if (luData[i][0] === userId) { customerName = luData[i][1]; break; }
  }
  if (!customerName) return null;
  var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  var targetRow = -1;
  for (var j = 1; j < data.length; j++) {
    if (data[j][1] === customerName) targetRow = j + 1;
  }
  if (targetRow < 0) return null;
  return { sheet: sheet, row: targetRow, customerName: customerName };
}

// V列(22) にスヌーズ解除日時を記録し、ステータスを snoozed に
function _setSnoozeUntil(userId, untilDate) {
  try {
    var loc = _findCustomerRow(userId);
    if (!loc) return false;
    loc.sheet.getRange(loc.row, 19).setValue('snoozed'); // S列
    loc.sheet.getRange(loc.row, 22).setValue(untilDate); // V列
    return true;
  } catch (err) {
    console.error('_setSnoozeUntil error: ' + err.message);
    return false;
  }
}

// W列(23) に配信頻度を記録 ('daily' / 'weekly' / 'biweekly')
function _setFrequency(userId, freq) {
  try {
    var loc = _findCustomerRow(userId);
    if (!loc) return false;
    loc.sheet.getRange(loc.row, 23).setValue(freq); // W列
    // 頻度変更時は last_sent_at(X列=24) をリセットしてすぐに次回検索が走るようにする
    loc.sheet.getRange(loc.row, 24).setValue('');
    return true;
  } catch (err) {
    console.error('_setFrequency error: ' + err.message);
    return false;
  }
}

// スヌーズ期間選択ハンドラ
function handleSnoozePeriodText(replyToken, userId, message) {
  try {
    var label = null;
    if (message === '24時間停止') label = '24時間';
    else if (message === '3日間停止') label = '3日';
    else if (message === '1週間停止') label = '1週間';
    else if (message === '2週間停止') label = '2週間';
    else if (message === '1ヶ月停止') label = '1ヶ月';
    else if (message === '配信停止（期間なし）') label = '停止';
    else {
      replyMessage(replyToken, [textMsg('選択肢から選んでください。')]);
      return true;
    }
    if (label === '停止') {
      _finalizeStop(userId, null);
      clearState(userId);
      replyMessage(replyToken, [textMsg(
        '新着物件の配信を停止しました。\n\n' +
        '再開したくなったら、「配信再開」とお送りいただくか、「使い方」メニューから再開できます。'
      )]);
      return true;
    }
    var hours = 0;
    if (label === '24時間') hours = 24;
    else if (label === '3日') hours = 24 * 3;
    else if (label === '1週間') hours = 24 * 7;
    else if (label === '2週間') hours = 24 * 14;
    else if (label === '1ヶ月') hours = 24 * 30;
    else {
      replyMessage(replyToken, [textMsg('選択肢から選んでください。')]);
      return true;
    }
    var until = new Date();
    until.setTime(until.getTime() + hours * 60 * 60 * 1000);
    _setSnoozeUntil(userId, until);
    clearState(userId);
    var ymdhm = Utilities.formatDate(until, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
    replyMessage(replyToken, [textMsg(
      label + 'のあいだ配信を停止しました。\n' +
      ymdhm + ' に自動で配信を再開いたします。\n\n' +
      'すぐに再開したい場合は「配信再開」とお送りください。\n\n' +
      '※再開後も新着物件がない場合は通知は届きません。'
    )]);
    return true;
  } catch (err) {
    console.error('handleSnoozePeriodText error: ' + err.message + '\n' + err.stack);
    try { clearState(userId); } catch(e) {}
    try { replyMessage(replyToken, [textMsg('処理に失敗しました。時間をおいて再度お試しください。')]); } catch(e) {}
    return true;
  }
}

// 配信頻度選択ハンドラ
function handleFrequencyText(replyToken, userId, message) {
  try {
    if (message.indexOf('頻度:') !== 0) {
      replyMessage(replyToken, [textMsg('「毎日」「週2回」「週1回」のいずれかを選んでください。')]);
      return true;
    }
    var label = message.substring('頻度:'.length);
    if (label === '停止') {
      _finalizeStop(userId, null);
      clearState(userId);
      replyMessage(replyToken, [textMsg(
        '新着物件の配信を停止しました。\n\n' +
        '再開したくなったら、「配信再開」とお送りいただくか、「使い方」メニューから再開できます。'
      )]);
      return true;
    }
    var freq = '';
    if (label === '2日に1回') freq = 'every2';
    else if (label === '3日に1回') freq = 'every3';
    else if (label === '週1回') freq = 'weekly';
    else {
      replyMessage(replyToken, [textMsg('選択肢から選んでください。')]);
      return true;
    }
    _setFrequency(userId, freq);
    setDeliveryStatus(userId, 'active');
    clearState(userId);
    replyMessage(replyToken, [textMsg(
      '配信頻度を「' + label + '」に変更して配信を再開しました。\n' +
      '今後はこの頻度で新着物件をお届けいたします。\n\n' +
      '※新着物件がない場合は通知は届きません。'
    )]);
    return true;
  } catch (err) {
    console.error('handleFrequencyText error: ' + err.message + '\n' + err.stack);
    try { clearState(userId); } catch(e) {}
    try { replyMessage(replyToken, [textMsg('処理に失敗しました。時間をおいて再度お試しください。')]); } catch(e) {}
    return true;
  }
}

// 「希望に合わない」選択後の選択肢ハンドラ
function handleMismatchChoiceText(replyToken, userId, message) {
  try {
    if (message === 'ミスマッチ:停止') {
      _finalizeStop(userId, '希望に合わない');
      clearState(userId);
      replyMessage(replyToken, [textMsg(
        '配信を停止しました。ご回答ありがとうございます。\n\n' +
        '再開したくなったら、「配信再開」とお送りいただくか、「使い方」メニューから再開できます。'
      )]);
      return true;
    }
    // 選択肢外
    replyMessage(replyToken, [{
      type: 'text',
      text: 'お手数ですが、下の選択肢から選んでください。',
      quickReply: {
        items: [
          { type: 'action', action: { type: 'message', label: '条件を変更する', text: '条件登録' } },
          { type: 'action', action: { type: 'message', label: '配信停止', text: 'ミスマッチ:停止' } },
          { type: 'action', action: { type: 'message', label: 'キャンセル', text: 'キャンセル' } }
        ]
      }
    }]);
    return true;
  } catch (err) {
    console.error('handleMismatchChoiceText error: ' + err.message);
    try { clearState(userId); } catch(e) {}
    return true;
  }
}

// 配信再開コマンド
function handleDeliveryResumeCommand(replyToken, userId) {
  try {
    var result = setDeliveryStatus(userId, 'active');
    if (!result.ok) {
      replyMessage(replyToken, [textMsg('ご希望条件が未登録のようです。まずは「条件登録」からお願いいたします。')]);
      return;
    }
    replyMessage(replyToken, [textMsg(
      '新着物件の配信を再開しました。\n\n' +
      'ご希望に合う物件が見つかり次第、お届けいたします。'
    )]);
  } catch (err) {
    console.error('handleDeliveryResumeCommand error: ' + err.message + '\n' + err.stack);
    try { replyMessage(replyToken, [textMsg('配信再開の処理に失敗しました。時間をおいて再度お試しください。')]); } catch(e) {}
  }
}

// 使い方ガイド（Flex carousel）
function handleHelpCommand(replyToken, userId) {
  try {
    var currentStatus = getDeliveryStatus(userId);
    var isPaused = (currentStatus === 'paused');
    var features = [
      {
        title: '空室確認',
        desc: '気になる物件の空室状況をその場で確認できます。物件名・所在地・最寄駅・専有面積・募集ページURLのいずれかを送ってください。',
        trigger: '空室確認'
      },
      {
        title: '条件登録',
        desc: 'お引越し条件（エリア・賃料・間取りなど）を登録すると、条件に合う物件をスタッフが厳選してお届けします。',
        trigger: '条件登録'
      },
      {
        title: '条件変更',
        desc: '登録済みの希望条件をいつでも見直せます。お引越し時期や予算が変わった際にご利用ください。',
        trigger: '条件変更'
      },
      {
        title: 'お気に入り',
        desc: 'これまでに⭐ボタンで保存した物件を一覧で確認できます。後からまとめて見比べたいときに便利です。',
        trigger: 'お気に入り'
      },
      {
        title: 'その他ご質問',
        desc: '内見予約・お申込み・契約・その他なんでもご相談ください。担当スタッフが順番にお返事いたします。',
        trigger: 'その他ご質問'
      },
      isPaused ? {
        title: '配信を再開',
        desc: '現在、新着物件の配信を停止中です。再開するとご希望条件に合う物件のお届けを再開します。',
        trigger: '配信再開',
        btnLabel: '配信を再開する'
      } : {
        title: '配信を停止',
        desc: '新着物件のお届けを一時的に止めたいときにご利用ください。再開はいつでもできます。条件登録は残ります。',
        trigger: '配信停止',
        btnLabel: '配信を停止する'
      }
    ];

    var bubbles = features.map(function(f) {
      return {
        type: 'bubble',
        size: 'kilo',
        body: {
          type: 'box', layout: 'vertical', spacing: 'md',
          contents: [
            { type: 'text', text: f.title, weight: 'bold', size: 'lg', color: '#8ec41d' },
            { type: 'separator' },
            { type: 'text', text: f.desc, wrap: true, size: 'sm', color: '#555555' }
          ]
        },
        footer: {
          type: 'box', layout: 'vertical',
          contents: [{
            type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
            action: { type: 'message', label: f.btnLabel || '使ってみる', text: f.trigger }
          }]
        }
      };
    });

    replyMessage(replyToken, [{
      type: 'flex',
      altText: '使い方ガイド',
      contents: { type: 'carousel', contents: bubbles }
    }]);
  } catch (err) {
    console.error('handleHelpCommand error: ' + err.message + '\n' + err.stack);
    try { replyMessage(replyToken, [textMsg('使い方の表示に失敗しました。時間をおいて再度お試しください。')]); } catch(e) {}
  }
}

// 状態チェック（feedback + action 両方返す）
function handleCheckAction(e) {
  var customerName = e.parameter.customer;
  var roomId = e.parameter.room_id;

  if (!customerName || !roomId) {
    return ContentService.createTextOutput(JSON.stringify({ action_type: null, feedback: null, favoriteCount: 0 }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(ACTION_LOG_SHEET_NAME);
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ action_type: null, feedback: null, favoriteCount: 0 }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var data = sheet.getDataRange().getValues();
  var foundAction = null;  // hold / viewing
  var foundFeedback = null; // favorite / not_interested

  // 新しい順に探す
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) !== String(customerName) || String(data[i][1]) !== String(roomId)) continue;
    var act = String(data[i][2]);

    if (!foundAction && (act === 'hold' || act === 'viewing')) {
      foundAction = act;
    }
    if (!foundFeedback && (act === 'favorite' || act === 'not_interested' || act === 'clear')) {
      foundFeedback = (act === 'clear') ? null : act;
    }
    if (foundAction !== null && foundFeedback !== undefined) break;
  }

  var favoriteCount = countFavorites(sheet, customerName);

  return ContentService.createTextOutput(JSON.stringify({
    action_type: foundAction,
    feedback: foundFeedback || null,
    favoriteCount: favoriteCount
  })).setMimeType(ContentService.MimeType.JSON);
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

function updatePendingStatus(rowIndex, newStatus, viewUrl) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  sheet.getRange(rowIndex, 11).setValue(newStatus);
  sheet.getRange(rowIndex, 13).setValue(new Date().toISOString().replace('T', ' ').substring(0, 19));
  if (viewUrl) {
    sheet.getRange(rowIndex, 14).setValue(viewUrl);
  }
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

/** 「入力なし」「なし」「-」「ー」などの無効値を空文字に正規化 */
function _normalizeValue(val) {
  if (!val || val === '入力なし' || val === 'なし' || val === '-' || val === 'ー') return '';
  return val;
}

/**
 * 火災保険の値を正規化する。
 * 「住宅保険料」等の名称部分を除去し、金額・期間のみにする。
 */
function _normalizeFireInsurance(val) {
  val = _normalizeValue(val);
  if (!val) return '';
  // 保険の名称ラベルを除去（住宅保険料、火災保険料、少額短期保険 等）
  val = val.replace(/少額短期保険料?/g, '').replace(/住宅保険料?/g, '').replace(/火災保険料?/g, '').trim();
  // 先頭の区切り文字を除去
  val = val.replace(/^[：:\s、,]+/, '').trim();
  return val;
}

/**
 * 築年月テキストを「築○年」形式に変換する。
 * "2007/03" → "築19年", "築15年" → "築15年", "9年" → "築9年"
 */
function _normalizeBuildingAge(val) {
  if (!val) return '';
  val = String(val).trim();
  if (/^築\d+年/.test(val) || val === '新築') return val;
  var m1 = val.match(/^(\d+)年$/);
  if (m1) return '築' + m1[1] + '年';
  // REINS形式: "2026年（令和 8年） 3月" or "1992年（平成 4年） 4月"
  var mReins = val.match(/(\d{4})年[\s\S]*?(\d{1,2})月/);
  if (mReins) {
    var now = new Date();
    var years = now.getFullYear() - parseInt(mReins[1], 10);
    if (now.getMonth() + 1 < parseInt(mReins[2], 10)) years--;
    return years < 1 ? '新築' : '築' + years + '年';
  }
  var m2 = val.match(/(\d{4})\s*[\/\-年]\s*(\d{1,2})/);
  if (m2) {
    var now = new Date();
    var years = now.getFullYear() - parseInt(m2[1], 10);
    if (now.getMonth() + 1 < parseInt(m2[2], 10)) years--;
    return years < 1 ? '新築' : '築' + years + '年';
  }
  var m3 = val.match(/^(\d{4})年?$/);
  if (m3) {
    var y = new Date().getFullYear() - parseInt(m3[1], 10);
    return y < 1 ? '新築' : '築' + y + '年';
  }
  return val;
}

/**
 * 入居可能時期を日付表記に変換する。
 * "2026/03/29" → "2026年3月29日", "2026/04" → "2026年4月"
 */
function _normalizeMoveInDate(val) {
  if (!val) return '';
  val = String(val).trim().replace(/^(予定|期日指定)\s*/, '');
  var m1 = val.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(.*)$/);
  if (m1) return parseInt(m1[1],10) + '年' + parseInt(m1[2],10) + '月' + parseInt(m1[3],10) + '日' + m1[4];
  var m2 = val.match(/^(\d{4})[\/\-](\d{1,2})(.*)$/);
  if (m2) return parseInt(m2[1],10) + '年' + parseInt(m2[2],10) + '月' + m2[3];
  return val;
}

/**
 * 物件名から部屋番号を分離する。
 * "ふるーる東中野 202" → { name: "ふるーる東中野", room: "202" }
 */
function _splitRoomNumber(buildingName, roomNumber) {
  if (roomNumber) return { name: buildingName, room: roomNumber };
  if (!buildingName) return { name: '', room: '' };
  var m = buildingName.match(/^(.+?)\s+(\d{2,5}[A-Za-z]?)$/);
  if (m) return { name: m[1], room: m[2] };
  return { name: buildingName, room: '' };
}

function rowToProperty(row) {
  var extra = {};
  try { extra = JSON.parse(row[9] || '{}'); } catch(e) {}
  var rawRoomNumber = _normalizeValue(extra.room_number);
  var rawBuildingName = row[3] || '';
  var split = _splitRoomNumber(rawBuildingName, rawRoomNumber);
  return {
    customerName: row[0],
    buildingId: row[1],
    roomId: row[2],
    buildingName: split.name,
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
    imageCategories: extra.image_categories || [],
    selectedImageUrls: extra.selected_image_urls || null,
    selectedImageCategories: extra.selected_image_categories || null,
    roomNumber: split.room,
    buildingAge: _normalizeBuildingAge(_normalizeValue(extra.building_age)),
    floor: extra.floor || 0,
    // 追加詳細情報
    storyText: _normalizeValue(extra.story_text),
    otherStations: extra.other_stations || [],
    moveInDate: _normalizeMoveInDate(_normalizeValue(extra.move_in_date)),
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
    fireInsurance: _normalizeFireInsurance(extra.fire_insurance),
    renewalAdminFee: _normalizeValue(extra.renewal_admin_fee),
    guaranteeInfo: _normalizeValue(extra.guarantee_info),
    cleaningFee: _normalizeValue(extra.cleaning_fee),
    keyExchangeFee: _normalizeValue(extra.key_exchange_fee),
    supportFee24h: _normalizeValue(extra.support_fee_24h),
    rightsFee: _normalizeValue(extra.rights_fee),
    additionalDeposit: _normalizeValue(extra.additional_deposit),
    guaranteeDeposit: _normalizeValue(extra.guarantee_deposit),
    waterBilling: _normalizeValue(extra.water_billing),
    parkingFee: _normalizeValue(extra.parking_fee),
    bicycleParkingFee: _normalizeValue(extra.bicycle_parking_fee),
    motorcycleParkingFee: _normalizeValue(extra.motorcycle_parking_fee),
    otherMonthlyFee: _normalizeValue(extra.other_monthly_fee),
    otherOnetimeFee: _normalizeValue(extra.other_onetime_fee),
    moveInConditions: _normalizeValue(extra.move_in_conditions),
    moveOutDate: _normalizeValue(extra.move_out_date),
    freeRentDetail: _normalizeValue(extra.free_rent_detail),
    layoutDetail: _normalizeValue(extra.layout_detail),
    adFee: _normalizeValue(extra.ad_fee),
    currentStatus: _normalizeValue(extra.current_status)
  };
}

// 確認時に選択された画像URLをシートのJSONに保存
function saveSelectedImages(rowIndex, selectedImageUrls, selectedImageCategories) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  var cell = sheet.getRange(rowIndex, 10); // J列
  var extra = {};
  try { extra = JSON.parse(cell.getValue() || '{}'); } catch(e) {}
  extra.selected_image_urls = selectedImageUrls;
  if (selectedImageCategories && selectedImageCategories.length > 0) {
    extra.selected_image_categories = selectedImageCategories;
  }
  cell.setValue(JSON.stringify(extra));
}

// ===== 画像アップロード（catbox.moe — 手動アップロード用） =====
// 承認ページからの手動アップロードは少量のため catbox を使用。
// 一括スクレイピングの画像は Python 側で Google Drive にアップロードされる。
function uploadPropertyImage(base64Data, filename, mimeType) {
  try {
    var decoded = Utilities.base64Decode(base64Data);
    var mime = mimeType || 'image/jpeg';
    var fname = filename || 'upload.jpg';
    var blob = Utilities.newBlob(decoded, mime, fname);

    var response = UrlFetchApp.fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      payload: {
        reqtype: 'fileupload',
        fileToUpload: blob
      },
      muteHttpExceptions: true
    });

    var url = response.getContentText().trim();
    if (url.startsWith('https://')) {
      return { success: true, url: url };
    } else {
      return { success: false, message: 'Upload failed: ' + url };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
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
  extra.cleaning_fee = prop.cleaningFee || '';
  extra.key_exchange_fee = prop.keyExchangeFee || '';
  extra.support_fee_24h = prop.supportFee24h || '';
  extra.rights_fee = prop.rightsFee || '';
  extra.additional_deposit = prop.additionalDeposit || '';
  extra.guarantee_deposit = prop.guaranteeDeposit || '';
  extra.water_billing = prop.waterBilling || '';
  extra.parking_fee = prop.parkingFee || '';
  extra.bicycle_parking_fee = prop.bicycleParkingFee || '';
  extra.motorcycle_parking_fee = prop.motorcycleParkingFee || '';
  extra.other_monthly_fee = prop.otherMonthlyFee || '';
  extra.other_onetime_fee = prop.otherOnetimeFee || '';
  extra.move_in_conditions = prop.moveInConditions || '';
  extra.move_out_date = prop.moveOutDate || '';
  extra.free_rent_detail = prop.freeRentDetail || '';
  extra.layout_detail = prop.layoutDetail || '';
  extra.other_stations = prop.otherStations || [];
  extra.ad_fee = prop.adFee || '';
  extra.current_status = prop.currentStatus || '';

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
  if (prop.supportFee24h) d.sf24 = prop.supportFee24h;
  if (prop.rightsFee) d.rig = prop.rightsFee;
  if (prop.additionalDeposit) d.adp = prop.additionalDeposit;
  if (prop.guaranteeDeposit) d.gd = prop.guaranteeDeposit;
  if (prop.waterBilling) d.wb = prop.waterBilling;
  if (prop.parkingFee) d.pk = prop.parkingFee;
  if (prop.bicycleParkingFee) d.bp = prop.bicycleParkingFee;
  if (prop.motorcycleParkingFee) d.mp = prop.motorcycleParkingFee;
  if (prop.otherMonthlyFee) d.omf = prop.otherMonthlyFee;
  if (prop.otherOnetimeFee) d.oof = prop.otherOnetimeFee;
  if (prop.moveInConditions) d.mic = prop.moveInConditions;
  if (prop.freeRentDetail) d.frd = prop.freeRentDetail;
  if (prop.layoutDetail) d.ld = prop.layoutDetail;
  if (prop.adFee) d.af = prop.adFee;
  if (prop.currentStatus) d.cs = prop.currentStatus;
  // 設備: objectでもstringでもそのまま
  if (prop.facilities) d.fac = prop.facilities;
  if (prop.otherStations && prop.otherStations.length > 0) d.os = prop.otherStations;
  if (viewImageUrls && viewImageUrls.length > 0) {
    d.imgs = viewImageUrls;
    // カテゴリがある場合のみ含める（URL長短縮のため）
    var viewCats = prop.selectedImageCategories || prop.imageCategories || [];
    if (viewCats.length > 0 && viewCats.some(function(c) { return c; })) {
      d.imgc = viewCats;
    }
  }

  var jsonStr = JSON.stringify(d);
  var encoded = Utilities.base64EncodeWebSafe(Utilities.newBlob(jsonStr).getBytes());
  // クエリパラメータ d= に埋め込み（LINE がハッシュ # を削除するため）
  return 'https://form.ehomaki.com/property.html?customer=' + encodeURIComponent(customerName) + '&room_id=' + roomId + '&d=' + encoded;
}

// ===== 最小ビューURL生成（hashUrlが1000字を超えた時のフォールバック） =====
// 主要フィールドだけ埋め込み、property.html は即座にカード骨格を表示しつつ
// 残りを view_api で並列フェッチする → 体感の待ち時間を激減させる
function buildMinimalViewUrl(customerName, roomId, prop) {
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
  var baseUrl = 'https://form.ehomaki.com/property.html?customer=' + encodeURIComponent(customerName) + '&room_id=' + roomId + '&m=';
  var build = function(obj) {
    var j = JSON.stringify(obj);
    var enc = Utilities.base64EncodeWebSafe(Utilities.newBlob(j).getBytes());
    return baseUrl + enc;
  };
  // 1枚目だけ即表示用に埋め込む。残り全枚数は property.html が非同期で取りに来る
  if (prop.imageUrl) {
    d.imgs = [prop.imageUrl];
    var u = build(d);
    if (u.length <= 1000) return u;
    delete d.imgs;
  }
  var url = build(d);
  if (url.length <= 1000) return url;
  // それでも超える場合、長いフィールドを段階的に削除（重要度の低い順）
  var dropOrder = ['ad', 'ft', 'si', 'k', 'd', 'ba', 'mf'];
  for (var i = 0; i < dropOrder.length; i++) {
    delete d[dropOrder[i]];
    url = build(d);
    if (url.length <= 1000) return url;
  }
  return url; // それでも超えた場合でも m= 付きを返す（plainUrlフォールバックは廃止）
}

// ===== Flex Message =====
function buildPropertyFlex(prop, options) {
  options = options || {};
  var includeImage = options.includeImage !== false;
  var viewUrl = options.viewUrl || '';

  var rentMan = prop.rent ? _fmtMan(prop.rent) : '0';
  var mgmtMan = prop.managementFee ? _fmtMan(prop.managementFee) : '0';

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
  details.push(['\u6577\u91D1/\u793C\u91D1', (prop.deposit || '0') + ' / ' + (prop.keyMoney || '0')]);

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
  var rentMan = prop.rent ? _fmtMan(prop.rent) : '0';
  var mgmtMan = prop.managementFee ? _fmtMan(prop.managementFee) : '0';

  var images = prop.imageUrls && prop.imageUrls.length > 0 ? prop.imageUrls : (prop.imageUrl ? [prop.imageUrl] : []);
  var imageCategories = prop.imageCategories || [];

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
    + '.img-item .img-cat{position:absolute;bottom:24px;left:0;right:0;text-align:center;font-size:10px;color:#fff;pointer-events:none}'
    + '.img-item .img-cat span{background:rgba(0,0,0,0.55);padding:1px 6px;border-radius:3px}'
    + '.actions{margin-top:20px;text-align:center}'
    + '.btn{display:inline-block;padding:12px 32px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;cursor:pointer;border:none}'
    + '.btn-approve{background:#4CAF50;color:#fff;margin-bottom:12px}'
    + '.btn-skip{background:none;color:#999;font-size:14px;text-decoration:underline;border:none;cursor:pointer}'
    + '.modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:100;justify-content:center;align-items:center}'
    + '.modal-overlay.active{display:flex}'
    + '.modal-overlay img{max-width:85%;max-height:85vh;object-fit:contain}'
    + '.modal-close{position:fixed;top:16px;right:16px;color:#fff;font-size:32px;cursor:pointer;z-index:101}'
    + '.modal-nav{position:fixed;top:50%;color:#fff;font-size:40px;cursor:pointer;z-index:101;user-select:none;padding:12px 16px;background:rgba(255,255,255,0.15);border-radius:50%;line-height:1;transform:translateY(-50%)}'
    + '.modal-nav:active{background:rgba(255,255,255,0.3)}'
    + '.modal-prev{left:8px}'
    + '.modal-next{right:8px}'
    + '.modal-counter{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);color:#fff;font-size:14px;z-index:101;background:rgba(0,0,0,0.5);padding:4px 14px;border-radius:12px}'
    + '.upload-area{margin:12px 0;padding:16px;border:2px dashed #ccc;border-radius:8px;text-align:center;background:#fafafa;transition:border-color 0.2s,background 0.2s}'
    + '.upload-area.dragover{border-color:#4CAF50;background:#e8f5e9}'
    + '.upload-btn{display:inline-block;padding:8px 20px;background:#2196F3;color:#fff;border-radius:6px;cursor:pointer;font-size:14px;border:none}'
    + '.upload-btn:active{background:#1976D2}'
    + '.upload-progress{font-size:13px;color:#666;margin:6px 0}'
    + '.upload-progress .bar{height:4px;background:#e0e0e0;border-radius:2px;overflow:hidden;margin-top:4px}'
    + '.upload-progress .bar-fill{height:100%;background:#4CAF50;transition:width 0.3s}'
    + '.img-arrows{position:absolute;bottom:2px;left:0;right:0;display:flex;justify-content:center;gap:4px;padding:0 2px}'
    + '.img-arrows button{background:rgba(0,0,0,0.55);color:#fff;border:none;border-radius:3px;width:24px;height:20px;cursor:pointer;font-size:11px;padding:0;line-height:20px}'
    + '.img-arrows button:disabled{opacity:0.3;cursor:default}'
    + '.insert-pos{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:14px}'
    + '.insert-pos select{padding:5px 8px;border-radius:6px;border:1px solid #ccc;font-size:14px;background:#fff}'
    + '</style></head><body><div class="card">'
    + '<h2>\uD83D\uDD0D \u627F\u8A8D\u30D7\u30EC\u30D3\u30E5\u30FC\uFF08\u7DE8\u96C6\u53EF\uFF09</h2>'
    + '<div class="prop-name"><input class="detail-input" name="headerBuildingName" value="' + _esc(prop.buildingName) + '" style="font-size:20px;font-weight:bold;color:#222;border:1px solid #e0e0e0;max-width:70%;display:inline-block" oninput="document.querySelector(\'input[name=buildingName]\').value=this.value"> <input class="detail-input" name="headerRoomNumber" value="' + _esc(prop.roomNumber || '') + '" style="font-size:20px;font-weight:bold;color:#222;border:1px solid #e0e0e0;width:80px;display:inline-block" oninput="document.querySelector(\'input[name=roomNumber]\').value=this.value"></div>'
    + '<div class="price"><input class="detail-input" name="headerRent" value="' + rentMan + '" style="font-size:24px;font-weight:bold;color:#E05252;width:80px;display:inline-block;border:1px solid #e0e0e0" oninput="document.querySelector(\'input[name=rent]\').value=Math.round(parseFloat(this.value)*10000)||0">\u4E07\u5186 <span class="price-sub">\u7BA1\u7406\u8CBB <input class="detail-input" name="headerMgmt" value="' + mgmtMan + '" style="font-size:14px;color:#888;width:60px;display:inline-block;border:1px solid #e0e0e0" oninput="document.querySelector(\'input[name=managementFee]\').value=Math.round(parseFloat(this.value)*10000)||0">\u4E07\u5186</span></div>';

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
  html += _textareaRow('\u706B\u707D\u4FDD\u967A', 'fireInsurance', prop.fireInsurance);
  html += _inputRow('\u66F4\u65B0\u4E8B\u52D9\u624B\u6570\u6599', 'renewalAdminFee', prop.renewalAdminFee);
  html += _textareaRow('\u4FDD\u8A3C\u6599', 'guaranteeInfo', prop.guaranteeInfo);
  html += _inputRow('\u30AF\u30EA\u30FC\u30CB\u30F3\u30B0\u8CBB\u7528', 'cleaningFee', prop.cleaningFee);
  html += _inputRow('\u9375\u4EA4\u63DB\u8CBB\u7528', 'keyExchangeFee', prop.keyExchangeFee);
  html += _inputRow('24\u6642\u9593\u30B5\u30DD\u30FC\u30C8\u8CBB', 'supportFee24h', prop.supportFee24h);
  html += _inputRow('\u6A29\u5229\u91D1', 'rightsFee', prop.rightsFee);
  html += _inputRow('\u6577\u91D1\u7A4D\u307F\u5897\u3057', 'additionalDeposit', prop.additionalDeposit);
  html += _inputRow('\u4FDD\u8A3C\u91D1', 'guaranteeDeposit', prop.guaranteeDeposit);
  html += _inputRow('\u6C34\u9053\u6599\u91D1\u5F62\u614B', 'waterBilling', prop.waterBilling);
  html += _inputRow('\u99D0\u8ECA\u5834', 'parkingFee', prop.parkingFee);
  html += _inputRow('\u99D0\u8F2A\u5834', 'bicycleParkingFee', prop.bicycleParkingFee);
  html += _inputRow('\u30D0\u30A4\u30AF\u7F6E\u304D\u5834', 'motorcycleParkingFee', prop.motorcycleParkingFee);
  html += _inputRow('\u305D\u306E\u4ED6\u6708\u6B21\u8CBB\u7528', 'otherMonthlyFee', prop.otherMonthlyFee);
  html += _inputRow('\u305D\u306E\u4ED6\u4E00\u6642\u91D1', 'otherOnetimeFee', prop.otherOnetimeFee);

  // ── 契約条件 ──
  html += '<div class="section-header">\u5951\u7D04\u6761\u4EF6</div>';
  html += _inputRow('\u5951\u7D04\u533A\u5206', 'leaseType', prop.leaseType);
  html += _inputRow('\u5951\u7D04\u671F\u9593', 'contractPeriod', prop.contractPeriod);
  html += _inputRow('\u89E3\u7D04\u4E88\u544A', 'cancellationNotice', prop.cancellationNotice);
  html += _inputRow('\u66F4\u65B0/\u518D\u5951\u7D04', 'renewalInfo', prop.renewalInfo);
  html += _inputRow('\u30D5\u30EA\u30FC\u30EC\u30F3\u30C8', 'freeRent', prop.freeRent);
  html += _inputRow('\u30D5\u30EA\u30FC\u30EC\u30F3\u30C8\u8A73\u7D30', 'freeRentDetail', prop.freeRentDetail);
  html += _inputRow('\u9000\u53BB\u65E5', 'moveOutDate', prop.moveOutDate);
  html += _textareaRow('\u5165\u5C45\u6761\u4EF6', 'moveInConditions', prop.moveInConditions);
  html += _inputRow('\u9593\u53D6\u308A\u8A73\u7D30', 'layoutDetail', prop.layoutDetail);

  // ── 設備・詳細 ──
  html += '<div class="section-header">\u8A2D\u5099\u30FB\u8A73\u7D30</div>';
  html += _textareaRow('\u8A2D\u5099', 'facilities', prop.facilities);

  // 画像セクション（統合グリッド + アップロード）
  html += '<div class="images-title">'
    + '<span>\uD83D\uDDBC\uFE0F \u753B\u50CF (<span id="imgCount">' + images.length + '</span>\u679A)'
    + '<span class="select-btns"><span onclick="selectAllUnified(true)">\u5168\u9078\u629E</span><span onclick="selectAllUnified(false)">\u5168\u89E3\u9664</span></span></span>'
    + '</div>'
    + '<div class="img-grid" id="unifiedGrid"></div>';

  // 画像アップロードエリア
  html += '<div class="images-title" style="margin-top:16px">'
    + '<span>\uD83D\uDCF7 \u753B\u50CF\u3092\u8FFD\u52A0</span>'
    + '</div>'
    + '<div class="insert-pos">'
    + '<label>\uD83D\uDCCD \u633F\u5165\u4F4D\u7F6E\uFF1A</label>'
    + '<select id="insertPos"></select>'
    + '</div>'
    + '<div class="upload-area" id="uploadArea">'
    + '<input type="file" id="fileInput" accept="image/*" multiple style="display:none" onchange="handleFiles(this.files)">'
    + '<button class="upload-btn" onclick="document.getElementById(\'fileInput\').click()">\u7AEF\u672B\u304B\u3089\u753B\u50CF\u3092\u9078\u629E</button>'
    + '<p style="margin-top:8px;font-size:12px;color:#999">\u307E\u305F\u306F\u753B\u50CF\u3092\u3053\u3053\u306B\u30C9\u30E9\u30C3\u30B0\uFF06\u30C9\u30ED\u30C3\u30D7</p>'
    + '<div id="uploadProgress"></div>'
    + '</div>';

  var skipUrl = baseUrl + '?action=skip&customer=' + encodeURIComponent(customerName) + '&room_id=' + roomId;

  html += '<div class="actions">'
    + '<a id="approveBtn" class="btn btn-approve" href="#" onclick="submitApprove();return false;">\u2705 \u627F\u8A8D\u3057\u3066LINE\u9001\u4FE1</a><br>'
    + '<a class="btn-skip" href="' + _esc(skipUrl) + '">\u30B9\u30AD\u30C3\u30D7</a>'
    + '</div>';

  // 画像モーダル（前/次ナビ付き）
  html += '<div id="modal" class="modal-overlay" onclick="closeModalBg(event)">'
    + '<span class="modal-close" onclick="event.stopPropagation();closeModal()">&times;</span>'
    + '<span class="modal-nav modal-prev" onclick="event.stopPropagation();navModal(-1)">&#10094;</span>'
    + '<img id="modalImg" src="" onclick="event.stopPropagation()">'
    + '<span class="modal-nav modal-next" onclick="event.stopPropagation();navModal(1)">&#10095;</span>'
    + '<span id="modalCounter" class="modal-counter"></span>'
    + '</div>';

  html += '<script>'
    + 'var gasBaseUrl=' + JSON.stringify(baseUrl) + ';'
    + 'var customerName=' + JSON.stringify(customerName) + ';'
    + 'var roomId=' + JSON.stringify(String(roomId)) + ';'
    + 'var origImages=' + JSON.stringify(images) + ';'
    + 'var origCategories=' + JSON.stringify(imageCategories) + ';'
    // ── 統合画像管理 ──
    + 'var allImages=[];'
    + 'for(var i=0;i<origImages.length;i++){allImages.push({url:origImages[i],cat:origCategories[i]||"",checked:true,isUp:false})}'
    // タイルHTML生成
    + 'function makeImgTile(i){'
    + 'var im=allImages[i];var bg=im.isUp?"33,150,243":"0,0,0";'
    + 'var h="<div class=\\"cb-wrap\\"><input type=\\"checkbox\\" "+(im.checked?"checked":"")+" onchange=\\"toggleU("+i+")\\"></div>";'
    + 'h+="<span class=\\"idx\\" style=\\"background:rgba("+bg+",0.6)\\">"+(i+1)+"</span>";'
    + 'h+="<img src=\\""+im.url+"\\" onclick=\\"openModal(this.src)\\">";'
    + 'if(im.cat){h+="<div class=\\"img-cat\\"><span>"+im.cat+"</span></div>"}'
    + 'h+="<div class=\\"img-arrows\\">";'
    + 'h+="<button onclick=\\"moveImg("+i+",-1)\\""+((i===0)?" disabled":"")+">\\u25C0</button>";'
    + 'h+="<button onclick=\\"moveImg("+i+",1)\\""+((i===allImages.length-1)?" disabled":"")+">\\u25B6</button>";'
    + 'h+="</div>";return h}'
    // グリッド描画
    + 'function renderGrid(){'
    + 'var grid=document.getElementById("unifiedGrid");grid.innerHTML="";'
    + 'document.getElementById("imgCount").textContent=allImages.length;'
    + 'for(var i=0;i<allImages.length;i++){'
    + 'var d=document.createElement("div");'
    + 'd.className="img-item"+(allImages[i].checked?"":" unchecked");d.id="uimg_"+i;'
    + 'd.innerHTML=makeImgTile(i);grid.appendChild(d)}'
    + 'updateInsertOpts()}'
    // チェックボックス
    + 'function toggleU(idx){allImages[idx].checked=!allImages[idx].checked;renderGrid()}'
    + 'function selectAllUnified(c){for(var i=0;i<allImages.length;i++)allImages[i].checked=c;renderGrid()}'
    // 画像並び替え
    + 'function moveImg(idx,dir){'
    + 'var n=idx+dir;if(n<0||n>=allImages.length)return;'
    + 'var t=allImages[idx];allImages[idx]=allImages[n];allImages[n]=t;renderGrid()}'
    // 挿入位置ドロップダウン更新
    + 'function updateInsertOpts(){'
    + 'var s=document.getElementById("insertPos");var prev=s.value;s.innerHTML="";'
    + 'for(var i=0;i<=allImages.length;i++){'
    + 'var o=document.createElement("option");o.value=i;'
    + 'if(i===0)o.text="\\u5148\\u982D (1\\u679A\\u76EE)";'
    + 'else if(i===allImages.length)o.text="\\u6700\\u5F8C ("+(i+1)+"\\u679A\\u76EE)";'
    + 'else o.text=(i+1)+"\\u679A\\u76EE";'
    + 's.appendChild(o)}'
    + 'if(prev!==""){var pi=parseInt(prev,10);if(pi>=0&&pi<=allImages.length)s.value=prev}'
    + '}'
    // モーダル（前/次ナビ + キーボード + スワイプ対応）
    + 'var currentModalIdx=-1;'
    + 'function openModal(src){var m=document.getElementById("modal");document.getElementById("modalImg").src=src;'
    + 'currentModalIdx=-1;for(var i=0;i<allImages.length;i++){if(allImages[i].url===src){currentModalIdx=i;break}}'
    + 'updateModalCounter();m.classList.add("active")}'
    + 'function closeModal(){document.getElementById("modal").classList.remove("active");currentModalIdx=-1}'
    + 'function closeModalBg(e){if(e.target.id==="modal")closeModal()}'
    + 'function navModal(dir){if(currentModalIdx<0)return;var n=currentModalIdx+dir;'
    + 'if(n<0||n>=allImages.length)return;currentModalIdx=n;'
    + 'document.getElementById("modalImg").src=allImages[n].url;updateModalCounter()}'
    + 'function updateModalCounter(){var el=document.getElementById("modalCounter");'
    + 'if(currentModalIdx>=0)el.textContent=(currentModalIdx+1)+" / "+allImages.length;else el.textContent=""}'
    + 'document.addEventListener("keydown",function(e){'
    + 'if(currentModalIdx<0)return;'
    + 'if(e.key==="ArrowLeft"){e.preventDefault();navModal(-1)}'
    + 'else if(e.key==="ArrowRight"){e.preventDefault();navModal(1)}'
    + 'else if(e.key==="Escape")closeModal()});'
    + '(function(){var sx=0;var modal=document.getElementById("modal");'
    + 'modal.addEventListener("touchstart",function(e){sx=e.touches[0].clientX},{passive:true});'
    + 'modal.addEventListener("touchend",function(e){'
    + 'var dx=e.changedTouches[0].clientX-sx;'
    + 'if(Math.abs(dx)>50){if(dx>0)navModal(-1);else navModal(1)}},{passive:true})})();'
    // ── アップロード機能 ──
    + 'var uploadCount=0;'
    + '(function(){'
    + 'var ua=document.getElementById("uploadArea");'
    + 'ua.addEventListener("dragover",function(e){e.preventDefault();ua.classList.add("dragover")});'
    + 'ua.addEventListener("dragleave",function(){ua.classList.remove("dragover")});'
    + 'ua.addEventListener("drop",function(e){e.preventDefault();ua.classList.remove("dragover");handleFiles(e.dataTransfer.files)});'
    + '})();'
    + 'function handleFiles(files){for(var i=0;i<files.length;i++){uploadSingleFile(files[i])}}'
    + 'function uploadSingleFile(file){'
    + 'if(!file.type.startsWith("image/"))return;'
    + 'if(file.size>10*1024*1024){alert(file.name+" \\u306F10MB\\u3092\\u8D85\\u3048\\u3066\\u3044\\u307E\\u3059\\u3002");return}'
    + 'var pid="prog_"+(++uploadCount);'
    + 'var pd=document.getElementById("uploadProgress");'
    + 'pd.innerHTML+="<div id=\\""+pid+"\\" class=\\"upload-progress\\">"+file.name+" \\u30A2\\u30C3\\u30D7\\u30ED\\u30FC\\u30C9\\u4E2D...<div class=\\"bar\\"><div class=\\"bar-fill\\" style=\\"width:20%\\"></div></div></div>";'
    + 'var MAX_DIM=2048;'
    + 'var reader=new FileReader();'
    + 'reader.onload=function(ev){'
    + 'var img=new Image();'
    + 'img.onload=function(){'
    + 'var w=img.width,h=img.height;'
    + 'if(w>MAX_DIM||h>MAX_DIM){var ratio=Math.min(MAX_DIM/w,MAX_DIM/h);w=Math.round(w*ratio);h=Math.round(h*ratio)}'
    + 'var canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;'
    + 'canvas.getContext("2d").drawImage(img,0,0,w,h);'
    + 'var dataUrl=canvas.toDataURL("image/jpeg",0.8);'
    + 'var b64=dataUrl.split(",")[1];'
    + 'var pel=document.getElementById(pid);if(pel)pel.querySelector(".bar-fill").style.width="50%";'
    + 'google.script.run'
    + '.withSuccessHandler(function(r){'
    + 'var el=document.getElementById(pid);'
    + 'if(r.success){if(el)el.remove();addUploadedImage(r.url)}'
    + 'else{if(el)el.innerHTML=file.name+" \\u30A8\\u30E9\\u30FC: "+r.message}'
    + '})'
    + '.withFailureHandler(function(err){'
    + 'var el=document.getElementById(pid);if(el)el.innerHTML=file.name+" \\u30A8\\u30E9\\u30FC: "+err.message'
    + '})'
    + '.uploadPropertyImage(b64,file.name,"image/jpeg");'
    + '};'
    + 'img.src=ev.target.result;'
    + '};'
    + 'reader.readAsDataURL(file);'
    + '}'
    // アップロード画像を指定位置に挿入
    + 'function addUploadedImage(url){'
    + 'var pos=parseInt(document.getElementById("insertPos").value,10);'
    + 'allImages.splice(pos,0,{url:url,cat:"",checked:true,isUp:true});'
    + 'renderGrid();'
    + 'var np=Math.min(pos+1,allImages.length);'
    + 'document.getElementById("insertPos").value=String(np);'
    + '}'
    // 送信
    + 'function submitApprove(){'
    + 'var btn=document.getElementById("approveBtn");'
    + 'btn.textContent="\\u2B50 \\u9001\\u4FE1\\u4E2D...";btn.style.opacity="0.6";btn.style.pointerEvents="none";'
    + 'var fd={};'
    + 'fd.action="confirm_approve";'
    + 'fd.customer=customerName;'
    + 'fd.room_id=roomId;'
    + 'var selUrls=[];var selCats=[];'
    + 'for(var i=0;i<allImages.length;i++){if(allImages[i].checked){selUrls.push(allImages[i].url);selCats.push(allImages[i].cat||"")}}'
    + 'fd.ordered_image_urls=JSON.stringify(selUrls);'
    + 'fd.ordered_image_categories=JSON.stringify(selCats);'
    + 'fd.include_image=selUrls.length>0?"1":"0";'
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
    // 初期化
    + 'renderGrid();document.getElementById("insertPos").value="0";'
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
    var rentMan = p.rent ? _fmtMan(p.rent) : '0';
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
  var rentMan = prop.rent ? _fmtMan(prop.rent) : '0';
  var mgmtMan = prop.managementFee ? _fmtMan(prop.managementFee) : '0';

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
    + '.fac-cat{margin-bottom:10px}'
    + '.fac-cat-name{font-size:12px;color:#888;font-weight:bold;margin-bottom:4px}'
    + '.fac-tags{display:flex;flex-wrap:wrap;gap:4px}'
    + '.fac-tag{display:inline-block;font-size:12px;color:#444;background:#f0f4f8;border-radius:4px;padding:2px 8px;line-height:1.6}'
    + '.cond-ok{background:#e8f5e9;color:#2e7d32}'
    + '.cond-ng{background:#f5f5f5;color:#999}'
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
    + '<div class="price-sub">\u7BA1\u7406\u8CBB ' + mgmtMan + '\u4E07\u5186 | \u6577\u91D1 ' + _esc(prop.deposit || '0') + ' | \u793C\u91D1 ' + _esc(prop.keyMoney || '0') + '</div>'
    + '</div>';

  // 値が有効か判定（「ー」「-」「入力なし」「なし」は非表示）
  function _hv(v) { return v && v !== '\u30FC' && v !== '-' && v !== '\u5165\u529B\u306A\u3057'; }

  // 設備文字列をカテゴリ分けしてタグHTMLを生成
  // カテゴリはItandi BB入稿ページ準拠
  function _buildFacilityTags(facStr) {
    // Itandi形式（【カテゴリ】アイテム / アイテム）の場合はそのまま解析
    if (facStr.indexOf('\u3010') >= 0) {
      return _buildFacilityTagsFromItandi(facStr);
    }
    // ES-Square等：カンマ区切りテキストをキーワードでカテゴリ分け
    var cats = [
      { name: '\u30AC\u30B9\u30FB\u6C34\u9053', keys: ['\u90FD\u5E02\u30AC\u30B9','\u30D7\u30ED\u30D1\u30F3','\u30AC\u30B9\u306A\u3057','\u4E0B\u6C34\u9053','\u6D44\u5316\u69FD','\u6C34\u9053\u516C\u55B6','\u4E95\u6238'] },
      { name: '\u30D0\u30B9\u30FB\u30C8\u30A4\u30EC', keys: ['\u30D0\u30B9','\u30C8\u30A4\u30EC','\u6D17\u9762','\u6D74\u5BA4','\u6E29\u6C34\u6D17\u6D44','\u6696\u623F\u4FBF\u5EA7','\u8FFD\u711A','\u8FFD\u3044\u713C','\u8FFD\u3044\u7119','\u30AA\u30FC\u30C8\u30D0\u30B9','\u30B7\u30E3\u30EF\u30FC','\u30DF\u30B9\u30C8\u30B5\u30A6\u30CA','\u30DC\u30A4\u30E9\u30FC','\u6D17\u6FEF\u6A5F','\u30B3\u30A4\u30F3\u30E9\u30F3\u30C9\u30EA\u30FC','\u30A8\u30B3\u30AD\u30E5\u30FC\u30C8','\u30A8\u30B3\u30B8\u30E7\u30FC\u30BA'] },
      { name: '\u30AD\u30C3\u30C1\u30F3', keys: ['\u30AD\u30C3\u30C1\u30F3','IH','\u30B3\u30F3\u30ED','\u30AC\u30B9\u30B3\u30F3\u30ED','\u30AA\u30FC\u30EB\u96FB\u5316','\u7D66\u6E6F','\u30C7\u30A3\u30B9\u30DD\u30FC\u30B6\u30FC','\u6D44\u6C34\u5668','\u98DF\u6D17','\u98DF\u5668\u6D17\u6D44','\u30B0\u30EA\u30EB'] },
      { name: '\u51B7\u6696\u623F', keys: ['\u30A8\u30A2\u30B3\u30F3','\u5E8A\u6696\u623F','\u6696\u623F','\u51B7\u623F','FF\u6696\u623F','\u63DB\u6C17','\u30BB\u30F3\u30C8\u30E9\u30EB\u7A7A\u8ABF','\u500B\u5225\u7A7A\u8ABF','\u8907\u5C64\u30AC\u30E9\u30B9','\u706F\u6CB9','\u5800\u3054\u305F\u3064'] },
      { name: '\u53CE\u7D0D', keys: ['\u53CE\u7D0D','\u30AF\u30ED\u30FC\u30BC\u30C3\u30C8','\u30A6\u30A9\u30FC\u30AF\u30A4\u30F3','\u30B7\u30E5\u30FC\u30BA','\u5E8A\u4E0B\u53CE\u7D0D','\u30B0\u30EB\u30CB\u30A8','\u30C8\u30E9\u30F3\u30AF\u30EB\u30FC\u30E0','\u7384\u95A2\u53CE\u7D0D','\u5168\u5BA4\u53CE\u7D0D','\u7269\u7F6E','\u62BC\u5165'] },
      { name: 'TV\u30FB\u901A\u4FE1', keys: ['\u30C7\u30B8\u30BF\u30EB\u653E\u9001','BS','CS','CATV','\u5149\u30D5\u30A1\u30A4\u30D0','\u30A4\u30F3\u30BF\u30FC\u30CD\u30C3\u30C8','\u30CD\u30C3\u30C8\u7121\u6599','\u30CD\u30C3\u30C8\u5BFE\u5FDC','\u6709\u7DDA\u653E\u9001','\u7121\u7DDALN','LAN','\u30B1\u30FC\u30D6\u30EB\u30C6\u30EC\u30D3','Wi-Fi'] },
      { name: '\u30BB\u30AD\u30E5\u30EA\u30C6\u30A3', keys: ['\u30AA\u30FC\u30C8\u30ED\u30C3\u30AF','\u30A4\u30F3\u30BF\u30FC\u30DB\u30F3','\u30A4\u30F3\u30BF\u30DB\u30F3','\u30E2\u30CB\u30BF\u30FC\u4ED8','\u96FB\u5B50\u30ED\u30C3\u30AF','\u30C7\u30A3\u30F3\u30D7\u30EB','\u30AB\u30FC\u30C9\u30AD\u30FC','\u30C0\u30D6\u30EB\u30ED\u30C3\u30AF','\u9632\u72AF\u30AB\u30E1\u30E9','\u9632\u72AF','\u30BB\u30AD\u30E5\u30EA\u30C6\u30A3','\u7BA1\u7406\u4EBA','\u5B85\u914D\u30DC\u30C3\u30AF\u30B9'] },
      { name: '\u305D\u306E\u4ED6\u8A2D\u5099', keys: ['\u5BB6\u5177\u4ED8','\u5BB6\u5177\u5BB6\u96FB','\u5BB6\u96FB\u4ED8','\u51B7\u8535\u5EAB','\u30D9\u30C3\u30C9','\u7167\u660E','\u96FB\u8A71\u6A5F','\u30BB\u30F3\u30B5\u30FC','\u706B\u707D\u8B66\u5831','\u30D5\u30ED\u30FC\u30EA\u30F3\u30B0','\u30A8\u30EC\u30D9\u30FC\u30BF\u30FC','\u30ED\u30D5\u30C8','\u548C\u5BA4','\u5730\u4E0B\u5BA4','\u5BA4\u5185\u7269\u5E72','\u51FA\u7A93','\u30D0\u30EB\u30B3\u30CB\u30FC','\u30D9\u30E9\u30F3\u30C0','\u30EB\u30FC\u30D5\u30D0\u30EB\u30B3\u30CB\u30FC','\u30A4\u30F3\u30CA\u30FC\u30D0\u30EB\u30B3\u30CB\u30FC','\u30C6\u30E9\u30B9','\u30A6\u30C3\u30C9\u30C7\u30C3\u30AD','\u5EAD','\u5C02\u7528\u5EAD','\u9632\u97F3','\u4E8C\u91CD\u5E8A','\u5439\u304D\u629C\u3051','\u99D0\u8F2A','\u30D0\u30A4\u30AF\u7F6E','\u99D0\u8ECA','\u30AD\u30C3\u30BA','\u30ED\u30FC\u30C9\u30D2\u30FC\u30C6\u30A3\u30F3\u30B0','\u30B7\u30E3\u30C3\u30BF\u30FC','\u8FB2\u5730','\u52D5\u529B\u96FB\u6E90','OA\u30D5\u30ED\u30A2'] },
      { name: '\u5165\u5C45\u6761\u4EF6', keys: ['\u30DA\u30C3\u30C8','\u697D\u5668','\u4E8B\u52D9\u6240','\u30EB\u30FC\u30E0\u30B7\u30A7\u30A2','\u9AD8\u9F62\u8005','\u5973\u6027\u9650\u5B9A','\u5916\u56FD\u4EBA'] },
      { name: '\u7279\u8A18\u4E8B\u9805', keys: ['\u30AA\u30FC\u30CA\u30FC\u30C1\u30A7\u30F3\u30B8','\u89D2\u90E8\u5C4B','\u6700\u4E0A\u968E','\u30C7\u30B6\u30A4\u30CA\u30FC\u30BA','\u5206\u8B72','\u30BF\u30EF\u30FC\u30DE\u30F3\u30B7\u30E7\u30F3','\u30EA\u30CE\u30D9\u30FC\u30B7\u30E7\u30F3','\u30EA\u30D5\u30A9\u30FC\u30E0','\u5916\u65AD\u71B1','\u30B9\u30B1\u30EB\u30C8\u30F3','\u592A\u967D\u5149','\u30D5\u30EA\u30FC\u30EC\u30F3\u30C8','DIY','\u5C45\u629C\u304D','\u65E5\u5F53\u305F\u308A','\u9589\u9759','\u8155\u58C1','\u30E1\u30BE\u30CD\u30C3\u30C8','\u5236\u9707','\u514D\u9707','\u8010\u9707'] }
    ];
    // 設備文字列を分割
    var items = facStr.split(/[,、\/\n]+/).map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
    // 各アイテムをカテゴリに振り分け
    var buckets = {};
    for (var c = 0; c < cats.length; c++) buckets[cats[c].name] = [];
    buckets['\u305D\u306E\u4ED6'] = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i], matched = false;
      for (var c = 0; c < cats.length; c++) {
        for (var k = 0; k < cats[c].keys.length; k++) {
          if (item.indexOf(cats[c].keys[k]) >= 0) {
            buckets[cats[c].name].push(item);
            matched = true; break;
          }
        }
        if (matched) break;
      }
      if (!matched) buckets['\u305D\u306E\u4ED6'].push(item);
    }
    return _renderFacBuckets(cats.map(function(c) { return c.name; }), buckets);
  }

  // Itandi形式（【カテゴリ】アイテム / アイテム）を解析
  function _buildFacilityTagsFromItandi(facStr) {
    var lines = facStr.split('\n');
    var order = [], buckets = {};
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\u3010(.+?)\u3011(.*)$/);
      if (m) {
        var cat = m[1], rest = m[2];
        if (!buckets[cat]) { buckets[cat] = []; order.push(cat); }
        var items = rest.split(/[\/ \/]+/).map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
        for (var j = 0; j < items.length; j++) buckets[cat].push(items[j]);
      }
    }
    return _renderFacBuckets(order, buckets);
  }

  // カテゴリ別バケットからタグHTMLを生成（共通）
  function _renderFacBuckets(order, buckets) {
    var out = '';
    // orderに含まれるカテゴリ + その他
    var allOrder = order.slice();
    if (buckets['\u305D\u306E\u4ED6'] && buckets['\u305D\u306E\u4ED6'].length > 0 && allOrder.indexOf('\u305D\u306E\u4ED6') < 0) allOrder.push('\u305D\u306E\u4ED6');
    for (var o = 0; o < allOrder.length; o++) {
      var name = allOrder[o], arr = buckets[name];
      if (!arr || arr.length === 0) continue;
      out += '<div class="fac-cat"><div class="fac-cat-name">' + _esc(name) + '</div><div class="fac-tags">';
      for (var j = 0; j < arr.length; j++) {
        out += '<span class="fac-tag">' + _esc(arr[j]) + '</span>';
      }
      out += '</div></div>';
    }
    return out;
  }

  html += '<div class="section">'
    + '<div class="section-title">\u7269\u4EF6\u60C5\u5831</div>';

  var details = [];
  if (_hv(prop.layout)) details.push(['\u9593\u53D6\u308A', prop.layout]);
  if (_hv(prop.layoutDetail)) details.push(['\u9593\u53D6\u308A\u8A73\u7D30', prop.layoutDetail]);
  if (prop.area) details.push(['\u9762\u7A4D', prop.area + 'm\u00B2']);
  if (_hv(prop.buildingAge)) details.push(['\u7BC9\u5E74\u6570', prop.buildingAge]);
  if (_hv(prop.floorText)) details.push(['\u6240\u5728\u968E', prop.floorText]);
  else if (prop.floor) details.push(['\u6240\u5728\u968E', prop.floor + '\u968E']);
  if (_hv(prop.storyText)) details.push(['\u968E\u5EFA\u3066', prop.storyText]);
  if (_hv(prop.structure)) details.push(['\u69CB\u9020', prop.structure]);
  if (_hv(prop.totalUnits)) details.push(['\u7DCF\u6238\u6570', prop.totalUnits]);
  if (_hv(prop.sunlight)) details.push(['\u4E3B\u8981\u63A1\u5149\u9762', prop.sunlight]);
  if (_hv(prop.moveInDate)) details.push(['\u5165\u5C45\u53EF\u80FD\u6642\u671F', prop.moveInDate]);

  for (var i = 0; i < details.length; i++) {
    html += '<div class="row"><span class="row-label">' + details[i][0] + '</span><span class="row-value">' + _esc(details[i][1]) + '</span></div>';
  }
  html += '</div>';

  html += '<div class="section">'
    + '<div class="section-title">\u30A2\u30AF\u30BB\u30B9</div>';
  if (_hv(prop.stationInfo)) html += '<div class="row"><span class="row-label">\u6700\u5BC4\u99C5</span><span class="row-value">' + _esc(prop.stationInfo) + '</span></div>';
  var others = prop.otherStations || [];
  for (var i = 0; i < others.length; i++) {
    if (_hv(others[i])) {
      html += '<div class="row"><span class="row-label">' + (i === 0 ? '\u4ED6\u306E\u99C5' : '') + '</span><span class="row-value">' + _esc(others[i]) + '</span></div>';
    }
  }
  if (_hv(prop.address)) html += '<div class="row"><span class="row-label">\u4F4F\u6240</span><span class="row-value">' + _esc(prop.address) + '</span></div>';
  html += '</div>';

  // 費用
  var costRows = [];
  if (_hv(prop.shikibiki)) costRows.push(['\u6577\u5F15\u304D/\u511F\u5374', prop.shikibiki]);
  if (_hv(prop.petDeposit)) costRows.push(['\u30DA\u30C3\u30C8\u6577\u91D1\u8FFD\u52A0', prop.petDeposit]);
  if (_hv(prop.renewalFee)) costRows.push(['\u66F4\u65B0\u6599', prop.renewalFee]);
  if (_hv(prop.fireInsurance)) costRows.push(['\u706B\u707D\u4FDD\u967A', prop.fireInsurance]);
  if (_hv(prop.renewalAdminFee)) costRows.push(['\u66F4\u65B0\u4E8B\u52D9\u624B\u6570\u6599', prop.renewalAdminFee]);
  if (_hv(prop.guaranteeInfo)) costRows.push(['\u4FDD\u8A3C\u6599', prop.guaranteeInfo]);
  if (_hv(prop.cleaningFee)) costRows.push(['\u30AF\u30EA\u30FC\u30CB\u30F3\u30B0\u8CBB\u7528', prop.cleaningFee]);
  if (_hv(prop.keyExchangeFee)) costRows.push(['\u9375\u4EA4\u63DB\u8CBB\u7528', prop.keyExchangeFee]);
  if (_hv(prop.supportFee24h)) costRows.push(['24\u6642\u9593\u30B5\u30DD\u30FC\u30C8\u8CBB', prop.supportFee24h]);
  if (_hv(prop.rightsFee)) costRows.push(['\u6A29\u5229\u91D1', prop.rightsFee]);
  if (_hv(prop.additionalDeposit)) costRows.push(['\u6577\u91D1\u7A4D\u307F\u5897\u3057', prop.additionalDeposit]);
  if (_hv(prop.guaranteeDeposit)) costRows.push(['\u4FDD\u8A3C\u91D1', prop.guaranteeDeposit]);
  if (_hv(prop.waterBilling)) costRows.push(['\u6C34\u9053\u6599\u91D1\u5F62\u614B', prop.waterBilling]);
  // 駐車場代に駐輪場/バイク置き場の空き状況が混入している場合を分解
  if (_hv(prop.parkingFee)) {
    var pkVal = prop.parkingFee;
    var bikeAvail = pkVal.match(/(駐輪場)\s*[：:]\s*([^,，、\s：:]+)/);
    var motoAvail = pkVal.match(/(バイク置き?場)\s*[：:]\s*([^,，、\s：:]+)/);
    if (bikeAvail || motoAvail) {
      if (bikeAvail && !_hv(prop.bicycleParkingFee)) costRows.push(['駐輪場', bikeAvail[2]]);
      if (motoAvail && !_hv(prop.motorcycleParkingFee)) costRows.push(['バイク置き場', motoAvail[2]]);
      var stripped = pkVal.replace(/駐輪場\s*[：:]\s*[^,，、\s：:]+/, '').replace(/バイク置き?場\s*[：:]\s*[^,，、\s：:]+/, '').replace(/[,，、\s]+/g, '');
      if (stripped && /\d/.test(stripped)) costRows.push([/\d/.test(stripped) ? '駐車場代' : '駐車場', stripped]);
    } else {
      costRows.push([/\d/.test(pkVal) ? '駐車場代' : '駐車場', pkVal]);
    }
  }
  if (_hv(prop.bicycleParkingFee)) costRows.push([/\d/.test(prop.bicycleParkingFee) ? '駐輪場代' : '駐輪場', prop.bicycleParkingFee]);
  if (_hv(prop.motorcycleParkingFee)) costRows.push([/\d/.test(prop.motorcycleParkingFee) ? 'バイク置き場代' : 'バイク置き場', prop.motorcycleParkingFee]);
  if (_hv(prop.otherMonthlyFee)) costRows.push(['\u305D\u306E\u4ED6\u6708\u6B21\u8CBB\u7528', prop.otherMonthlyFee]);
  if (_hv(prop.otherOnetimeFee)) costRows.push(['\u305D\u306E\u4ED6\u4E00\u6642\u91D1', prop.otherOnetimeFee]);
  if (costRows.length > 0) {
    html += '<div class="section"><div class="section-title">\u8CBB\u7528</div>';
    for (var i = 0; i < costRows.length; i++) {
      html += '<div class="row"><span class="row-label">' + costRows[i][0] + '</span><span class="row-value">' + _esc(costRows[i][1]).replace(/\n/g, '<br>') + '</span></div>';
    }
    html += '</div>';
  }

  // 契約条件
  var contractRows = [];
  if (_hv(prop.leaseType)) contractRows.push(['\u5951\u7D04\u533A\u5206', prop.leaseType]);
  if (_hv(prop.contractPeriod)) contractRows.push(['\u5951\u7D04\u671F\u9593', prop.contractPeriod]);
  if (_hv(prop.cancellationNotice)) contractRows.push(['\u89E3\u7D04\u4E88\u544A', prop.cancellationNotice]);
  if (_hv(prop.renewalInfo)) contractRows.push(['\u66F4\u65B0\u30FB\u518D\u5951\u7D04\u53EF\u5426', prop.renewalInfo]);
  if (_hv(prop.freeRent)) contractRows.push(['\u30D5\u30EA\u30FC\u30EC\u30F3\u30C8', prop.freeRent]);
  if (_hv(prop.freeRentDetail)) contractRows.push(['\u30D5\u30EA\u30FC\u30EC\u30F3\u30C8\u8A73\u7D30', prop.freeRentDetail]);
  if (contractRows.length > 0) {
    html += '<div class="section"><div class="section-title">\u5951\u7D04\u6761\u4EF6</div>';
    for (var i = 0; i < contractRows.length; i++) {
      html += '<div class="row"><span class="row-label">' + contractRows[i][0] + '</span><span class="row-value">' + _esc(contractRows[i][1]) + '</span></div>';
    }
    html += '</div>';
  }

  // 入居条件（チップ/バッジ表示）
  var condStr = prop.moveInConditions || '';
  if (_hv(condStr)) {
    html += '<div class="section"><div class="section-title">\u5165\u5C45\u6761\u4EF6</div><div class="fac-tags">';
    var condItems = condStr.split(/[,、\/\n]+/).map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
    for (var ci = 0; ci < condItems.length; ci++) {
      var cond = condItems[ci];
      var tagClass = 'fac-tag';
      if (/\u4E0D\u53EF/.test(cond)) {
        tagClass = 'fac-tag cond-ng';
      } else if (/\u53EF|\u76F8\u8AC7|\u6B53\u8FE1|\u4E0D\u8981|\u5411\u304D/.test(cond)) {
        tagClass = 'fac-tag cond-ok';
      }
      html += '<span class="' + tagClass + '">' + _esc(cond) + '</span>';
    }
    html += '</div></div>';
  }

  // 設備・詳細（カテゴリ分けタグ表示）
  var facStr = prop.facilities || '';
  if (_hv(facStr)) {
    html += '<div class="section"><div class="section-title">\u8A2D\u5099\u30FB\u8A73\u7D30</div>';
    html += _buildFacilityTags(facStr);
    html += '</div>';
  }

  html += '<div class="footer">\u203B \u8A73\u7D30\u306F\u62C5\u5F53\u8005\u306B\u304A\u554F\u3044\u5408\u308F\u305B\u304F\u3060\u3055\u3044</div>';
  html += '</div>';

  // カルーセルJS（複数画像時のみ）
  if (viewImages.length > 1) {
    html += '<script>'
      + 'var cur=0,total=' + viewImages.length + ';'
      + 'function goTo(n){cur=n;update()}'
      + 'function slide(d){if(total<=0)return;cur=((cur+d)%total+total)%total;update()}'
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
