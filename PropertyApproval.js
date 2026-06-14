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

/**
 * 円単位の金額を、適切な単位付きで表示する。
 *  - 1,100円 / 5,000円 のように1万未満は3桁区切りで「円」付き
 *  - 14万円 / 14.3万円 のように1万以上は「万円」付き
 *  - 顧客向けページで「0.11万円」のような不自然な表記を回避するため
 */
function _fmtPriceFull(yen) {
  if (!yen) return '0円';
  var n = Number(yen);
  if (!isFinite(n) || n <= 0) return '0円';
  if (n < 10000) {
    return n.toLocaleString('ja-JP') + '円';
  }
  return (n / 10000) + '万円';
}

/**
 * 文字列中の「0.XX万円」パターンを「X,XXX円」に置換する。
 * 「書類代: 0.33万円」のように既にフォーマット済みの混在テキストに対して使う。
 *  - "0.33万円" → "3,300円"
 *  - "1万円" / "13.5万円" など1万以上はそのまま維持
 */
function _normalizeYenInText(str) {
  if (!str) return str;
  return String(str).replace(/(\d*\.?\d+)万円/g, function(match, numStr) {
    var n = parseFloat(numStr);
    if (!isFinite(n) || n >= 1) return match;
    var yen = Math.round(n * 10000);
    return yen.toLocaleString('ja-JP') + '円';
  });
}

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
  // pending で見つからない場合は status を問わず room_id で取得（過去に送信済みのREINS等の再送信に対応）
  if (!row) row = _findRowsByRoomIdsAnyStatus_(customerName, [roomId])[0] || null;
  if (!row) {
    return makeHtml('注意', '該当の承認待ち物件が見つかりません。\n既に処理済みの可能性があります。');
  }

  var prop = rowToProperty(row.values);
  // 同じ物件 (roomId) で承認待ちになっている他のお客様を検出
  var otherCustomers = _findOtherPendingCustomersForRoom_(roomId, customerName);

  // 他のお客様の警告アラートをGAS側で再計算（保存値が空/古い場合の補完）
  if (otherCustomers.length > 0) {
    var ocNames = otherCustomers.map(function(oc) { return oc.customerName; });
    var equipMap = _getCustomerEquipmentMap_(ocNames);
    for (var oci = 0; oci < otherCustomers.length; oci++) {
      var ocName = otherCustomers[oci].customerName;
      var ocEquip = equipMap[ocName];
      if (ocEquip) {
        // 常にGAS側で再計算（最新の設備条件を使用）
        var computed = _computePropertyWarningsGAS_(prop, ocEquip.equipment, ocEquip.notes);
        if (computed) {
          otherCustomers[oci].warningsText = computed;
        }
      }
    }
  }

  return makePreviewHtml(prop, customerName, roomId, otherCustomers, e.parameter.collect === '1');
}

// ===== 承認プレビュー（一括） =====
function handleApproveAll(e) {
  var customerName = e.parameter.customer;

  if (!customerName) {
    return makeHtml('エラー', '顧客名が指定されていません。');
  }

  // 対象を限定する room_ids（カート送信から指定）。未指定なら承認待ち全件。
  var filterRoomIds = (e.parameter.room_ids || '').split(',').filter(function(s) { return s; });

  // room_ids 指定時は status を問わず取得（過去に送信済みのREINS等も必ず出す）
  var rows = filterRoomIds.length > 0
    ? _findRowsByRoomIdsAnyStatus_(customerName, filterRoomIds)
    : findAllPendingRows(customerName);
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

  // カート（room_ids 指定）は、普通の承認ページを各物件 iframe で埋め込むフル機能コンテナを返す
  if (filterRoomIds.length > 0) {
    return makeApprovalCartHtml(props, customerName, filterRoomIds.join(','));
  }
  return makePreviewAllHtml(props, customerName, '');
}

// ===== google.script.run 用ラッパー（単一承認） =====
function confirmApproveFromClient(formData) {
  var e = { parameter: formData };
  try {
    globalThis.__lastMultiSendResult = null;
    handleConfirmApprove(e); // 実処理（LINE送信・シート更新）
    var msg = (formData.buildingName || '物件') + ' を ' + formData.customer + ' さんに LINE 送信しました。';
    // 一括送信結果を反映
    var msr = globalThis.__lastMultiSendResult;
    if (msr && msr.count > 0) msg += ' (他 ' + msr.count + ' 名にも同送)';
    if (msr && msr.failed && msr.failed.length > 0) {
      msg += ' [送信失敗: ' + msr.failed.join(', ') + ']';
    }
    return { success: true, message: msg };
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
  // pending で見つからない場合は status を問わず room_id で取得（過去に送信済みのREINS等の再送信に対応）
  if (!row) row = _findRowsByRoomIdsAnyStatus_(customerName, [roomId])[0] || null;
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

  // defer モード（カート一括承認）: 編集・選択画像をシートへ保存だけして送信しない。
  // 送信は親コンテナが全物件確定後に sendCartCarousel() で1カルーセルにまとめて行う。
  // 確定マーカーをスクリプトキャッシュに記録（コンテナがポーリングで検知する。iframe間postMessageに依存しない）。
  if (e.parameter.defer === '1') {
    try { CacheService.getScriptCache().put('cartsave_' + customerName + '_' + roomId, '1', 21600); } catch (eC) {}
    // 担当者コメントもキャッシュに保存（sendCartCarousel が読んでカードに載せる）
    try {
      var _sc = (e.parameter.staff_comment || '').trim();
      if (_sc) CacheService.getScriptCache().put('cartcomment_' + customerName + '_' + roomId, _sc, 21600);
    } catch (eC2) {}
    return makeHtml('保存', (prop.buildingName || '物件') + ' を保存しました（送信は一括で行います）。');
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
    heroImageUrls: selectedImageUrls,
    viewUrl: viewUrl,
    customerStations: _getCustomerSelectedStations_(customerName),
    staffComment: (e.parameter.staff_comment || '')
  });

  pushMessage(lineUserId, [flex]);
  updatePendingStatus(row.rowIndex, 'sent', viewUrl);
  addToSeenSheet(customerName, prop);

  // ── 一括送信: 他のお客様にも同じ内容で送信 ──
  var multiSendList = [];
  try { multiSendList = JSON.parse(e.parameter.multi_send_customers || '[]'); } catch (_) {}
  var multiSentCount = 0;
  var multiFailedInfo = [];
  // 編集フィールドリスト (上の if ブロック内と同じ。スコープ外で参照するため再宣言)
  var _editFieldsForMulti = ['buildingName','roomNumber','layout','buildingAge','floorText','storyText',
    'structure','totalUnits','sunlight','moveInDate','stationInfo','address',
    'deposit','keyMoney','shikibiki','petDeposit','renewalFee','fireInsurance',
    'renewalAdminFee','guaranteeInfo','keyExchangeFee',
    'supportFee24h','rightsFee','additionalDeposit','guaranteeDeposit',
    'waterBilling','parkingFee','bicycleParkingFee','motorcycleParkingFee',
    'otherMonthlyFee','otherOnetimeFee','moveInConditions','moveOutDate',
    'freeRentDetail','layoutDetail',
    'leaseType','contractPeriod',
    'cancellationNotice','renewalInfo','freeRent','facilities'];
  for (var ms = 0; ms < multiSendList.length; ms++) {
    var msName = String(multiSendList[ms] || '').trim();
    if (!msName || msName === customerName) continue;
    try {
      var msRow = findPendingRow(msName, roomId);
      if (!msRow) { multiFailedInfo.push(msName + '(承認待ち行なし)'); continue; }
      var msLineId = findLineUserId(msName);
      if (!msLineId) { multiFailedInfo.push(msName + '(LINEなし)'); continue; }
      var msProp = rowToProperty(msRow.values);
      // メイン顧客の編集値を msProp にも適用
      for (var mef = 0; mef < _editFieldsForMulti.length; mef++) {
        var mfld = _editFieldsForMulti[mef];
        if (e.parameter[mfld] !== undefined) msProp[mfld] = e.parameter[mfld];
      }
      if (e.parameter.rent !== undefined) msProp.rent = Number(e.parameter.rent) || 0;
      if (e.parameter.managementFee !== undefined) msProp.managementFee = Number(e.parameter.managementFee) || 0;
      if (e.parameter.area !== undefined) msProp.area = Number(e.parameter.area) || 0;
      if (e.parameter.otherStations !== undefined) {
        msProp.otherStations = e.parameter.otherStations.split('\n').filter(function(s) { return s.trim() !== ''; });
      }
      // 画像保存
      if (selectedImageUrls.length > 0) {
        saveSelectedImages(msRow.rowIndex, selectedImageUrls, selectedImageCategories);
      }
      // 編集値保存
      if (e.parameter.buildingName !== undefined) {
        updateSheetWithEdits(msRow.rowIndex, msProp);
      }
      // ビューURL生成 (各顧客固有)
      var msPlainUrl = 'https://form.ehomaki.com/property.html?customer=' + encodeURIComponent(msName) + '&room_id=' + roomId;
      var msHashUrl = buildViewUrl(msName, roomId, msProp, []);
      var msMinimalUrl = buildMinimalViewUrl(msName, roomId, msProp);
      var msViewUrl = msHashUrl.length <= 1000 ? msHashUrl : (msMinimalUrl.length <= 1000 ? msMinimalUrl : msPlainUrl);
      // 画像キャッシュ
      cachePropertyImages(msName, roomId, selectedImageUrls, selectedImageCategories);
      // Flex
      var msFlex = buildPropertyFlex(msProp, {
        includeImage: selectedImageUrls.length > 0,
        heroImageUrls: selectedImageUrls,
        viewUrl: msViewUrl,
        customerStations: _getCustomerSelectedStations_(msName),
        staffComment: (e.parameter.staff_comment || '')
      });
      pushMessage(msLineId, [msFlex]);
      updatePendingStatus(msRow.rowIndex, 'sent', msViewUrl);
      addToSeenSheet(msName, msProp);
      multiSentCount++;
    } catch (msErr) {
      console.error('一括送信エラー (' + msName + '): ' + msErr.message);
      multiFailedInfo.push(msName + '(' + msErr.message + ')');
    }
  }
  // confirmApproveFromClient が読むためにモジュール変数に保存
  globalThis.__lastMultiSendResult = { count: multiSentCount, failed: multiFailedInfo };

  var resultMsg = prop.buildingName + ' を ' + customerName + ' さんに LINE 送信しました。';
  if (multiSentCount > 0) resultMsg += ' (他 ' + multiSentCount + ' 名にも同送)';
  if (multiFailedInfo.length > 0) resultMsg += ' [送信失敗: ' + multiFailedInfo.join(', ') + ']';

  return makeHtml('完了', resultMsg);
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
  var imageRoomIds = (e.parameter.images || '').split(',').filter(function(s) { return s; }); // 旧: 画像ありルーム
  // 新: 画像の個別選択マップ { room_id: "0,2,3" }
  var imageMap = {};
  try { imageMap = JSON.parse(e.parameter.image_map || '{}') || {}; } catch (eMap) { imageMap = {}; }
  // 対象を限定する room_ids（カート送信から指定）。未指定なら承認待ち全件。
  var filterRoomIds = (e.parameter.room_ids || '').split(',').filter(function(s) { return s; });

  if (!customerName) {
    return makeHtml('エラー', '顧客名が指定されていません。');
  }

  // room_ids 指定時は status を問わず取得（過去に送信済みのREINS等も必ず送る）
  var rows = filterRoomIds.length > 0
    ? _findRowsByRoomIdsAnyStatus_(customerName, filterRoomIds)
    : findAllPendingRows(customerName);
  if (!rows || rows.length === 0) {
    return makeHtml('注意', customerName + ' さんの承認待ち物件がありません。');
  }

  var lineUserId = findLineUserId(customerName);
  if (!lineUserId) {
    return makeHtml('エラー', customerName + ' さんの LINE ユーザーが見つかりません。');
  }

  // バッチ送信時はお客さん希望駅をループ前に1回だけ取得 (シート読込を減らす)
  var batchCustStations = _getCustomerSelectedStations_(customerName);

  // 全物件のFlexバブルを集め、「1つの横スワイプカルーセル」でまとめて送る
  var bubbles = [];
  var sentTargets = []; // { rowIndex, prop, viewUrl }
  for (var i = 0; i < rows.length; i++) {
    var prop = rowToProperty(rows[i].values);
    var rid = String(rows[i].values[2]);

    // 画像選択: image_map（個別インデックス）優先、無ければ旧 images（ルーム全画像）
    var allImgs = (prop.imageUrls && prop.imageUrls.length > 0) ? prop.imageUrls : (prop.imageUrl ? [prop.imageUrl] : []);
    var allCats = prop.imageCategories || [];
    var selectedUrls = [];
    var selectedCats = [];
    if (imageMap.hasOwnProperty(rid)) {
      var idxs = String(imageMap[rid] || '').split(',').filter(function(s) { return s !== ''; });
      for (var ix = 0; ix < idxs.length; ix++) {
        var ii = parseInt(idxs[ix], 10);
        if (!isNaN(ii) && allImgs[ii]) {
          selectedUrls.push(allImgs[ii]);
          if (allCats[ii]) selectedCats.push(allCats[ii]);
        }
      }
    } else if (imageRoomIds.indexOf(rid) !== -1) {
      selectedUrls = allImgs.slice();
      selectedCats = allCats.slice();
    }
    var includeImage = selectedUrls.length > 0;
    if (includeImage) {
      saveSelectedImages(rows[i].rowIndex, selectedUrls, selectedCats);
    }

    var plainUrl = 'https://form.ehomaki.com/property.html?customer=' + encodeURIComponent(customerName) + '&room_id=' + rid;
    var hashUrl = buildViewUrl(customerName, rid, prop, []); // 画像なし → URL短縮
    var minimalUrl = buildMinimalViewUrl(customerName, rid, prop);
    var viewUrl = hashUrl.length <= 1000 ? hashUrl : (minimalUrl.length <= 1000 ? minimalUrl : plainUrl); // 通常 minimalUrl が選ばれる

    // 画像URLをキャッシュ（property.html からの非同期取得用）
    cachePropertyImages(customerName, rid, selectedUrls, selectedCats);

    var flex = buildPropertyFlex(prop, {
      includeImage: includeImage,
      heroImageUrls: selectedUrls,
      viewUrl: viewUrl,
      customerStations: batchCustStations
    });
    if (flex && flex.contents) bubbles.push(flex.contents);
    sentTargets.push({ rowIndex: rows[i].rowIndex, prop: prop, viewUrl: viewUrl });
  }

  // バブル配列をカルーセル(横スワイプ)に分割。最大12件/45KBで自動分割。
  var messages = _splitBubblesIntoCarousels_(bubbles, 'お探しの物件が見つかりました');
  // pushMessage は1回5メッセージまで（カルーセルが複数になる場合に備えて分割送信）
  for (var m = 0; m < messages.length; m += 5) {
    pushMessage(lineUserId, messages.slice(m, m + 5));
  }

  // 送信成功 → 各物件を sent にし通知済みへ記録
  for (var s = 0; s < sentTargets.length; s++) {
    updatePendingStatus(sentTargets[s].rowIndex, 'sent', sentTargets[s].viewUrl);
    addToSeenSheet(customerName, sentTargets[s].prop);
  }

  return makeHtml('完了', customerName + ' さんに ' + sentTargets.length + ' 件の物件を1つのカルーセルで LINE 送信しました。');
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
    // 30日経過で削除済み or 元々登録されていない物件
    return ContentService.createTextOutput(JSON.stringify({
      error: 'この物件の募集は終了しました。',
      notFound: true
    }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 表示する画像: 承認時に選択されたものがあればそれ、なければ全画像
  var viewImages = prop.selectedImageUrls || prop.imageUrls || [];
  var viewCategories = prop.selectedImageCategories || prop.imageCategories || [];
  if (viewImages.length === 0 && prop.imageUrl) {
    viewImages = [prop.imageUrl];
    viewCategories = [''];
  }

  // 通知済み物件シートから空室状況を取得（Chrome拡張が定期的に更新している）
  var isClosed = false;
  var statusCheckedAt = '';
  var availabilityStatus = '';   // available/applied/needs_confirmation/reins_listed/unknown
  var availCanApply = null;      // true/false/null
  var availBadgeCount = null;    // 申込件数 (number or null)
  var isWatchingCancellation = false;  // キャンセル待ち通知中か
  var availApplicationStatus = '';     // 申込ステータス（"申込1件"等）
  try {
    var seenSheet = ss.getSheetByName(SEEN_SHEET_NAME);
    if (seenSheet) {
      var seenData = seenSheet.getDataRange().getValues();
      for (var si = seenData.length - 1; si >= 1; si--) {
        if (String(seenData[si][0]) === String(customerName) &&
            String(seenData[si][1]) === String(roomId)) {
          var seenStatus = String(seenData[si][5] || '');  // F列: current_status
          availabilityStatus = seenStatus;
          if (seenStatus === 'closed') {
            isClosed = true;
          }
          statusCheckedAt = seenData[si][6] ? String(seenData[si][6]) : '';
          // K列: can_apply
          var canApplyRaw = seenData[si][10];
          if (canApplyRaw === 'TRUE' || canApplyRaw === true) availCanApply = true;
          else if (canApplyRaw === 'FALSE' || canApplyRaw === false) availCanApply = false;
          // L列: badge_count
          var badgeRaw = seenData[si][11];
          if (typeof badgeRaw === 'number' && badgeRaw >= 0) availBadgeCount = badgeRaw;
          else if (badgeRaw !== '' && !isNaN(Number(badgeRaw))) availBadgeCount = Number(badgeRaw);
          // M列: application_status
          var appStatRaw = seenData[si][12];
          if (appStatRaw) availApplicationStatus = String(appStatRaw);
          // J列: キャンセル待ち通知希望
          if (seenData[si][9]) isWatchingCancellation = true;
          break;
        }
      }
    }
  } catch (seenErr) {
    console.warn('seen sheet status check error: ' + seenErr.message);
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
    currentStatus: prop.currentStatus,
    // 空室状況（通知済み物件シートから）
    isClosed: isClosed,
    statusCheckedAt: statusCheckedAt,
    availabilityStatus: availabilityStatus,
    availCanApply: availCanApply,
    availBadgeCount: availBadgeCount,
    availApplicationStatus: availApplicationStatus,
    isWatchingCancellation: isWatchingCancellation,
    // お客さん希望のこだわり条件 (設備タグの強調表示に使う)
    customerEquipment: _getCustomerEquipmentList_(customerName)
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

  // 物件閲覧 → 条件変更提案の連続送信カウントをリセット（AD列=30列目）
  try {
    var critSs = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var critSheet = critSs.getSheetByName(CRITERIA_SHEET_NAME);
    if (critSheet) {
      var critData = critSheet.getDataRange().getValues();
      for (var ci = 1; ci < critData.length; ci++) {
        if (String(critData[ci][1] || '').trim() === String(customerName).trim()) {
          var currentCount = parseInt(critSheet.getRange(ci + 1, 30).getValue()) || 0;
          if (currentCount > 0) {
            critSheet.getRange(ci + 1, 30).setValue(0);
          }
          break;
        }
      }
    }
  } catch (_eViewReset) {
    console.warn('閲覧時カウントリセット失敗: ' + (_eViewReset && _eViewReset.message));
  }

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

  // 閲覧トラッキング用の追加情報（view アクション時に property.html から送信される）
  var trackIp = e.parameter.ip || '';
  var trackCountry = e.parameter.country || '';
  var trackRegion = e.parameter.region || '';
  var trackCity = e.parameter.city || '';
  var trackIsp = e.parameter.isp || '';
  var trackUa = e.parameter.ua || '';
  var trackIsLine = e.parameter.line === '1';

  if (!customerName || !roomId || !actionType) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'missing parameters' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(ACTION_LOG_SHEET_NAME);
  var ACTION_LOG_HEADERS = ['顧客名', 'room_id', 'アクション', '物件名', '部屋番号', '賃料', '間取り', '最寄駅', '日時', '申込区分', '連絡先', 'Discord応答', 'IP', '国', '都道府県', '市区町村', 'ISP', 'UA', 'LINE内'];
  if (!sheet) {
    sheet = ss.insertSheet(ACTION_LOG_SHEET_NAME);
    sheet.appendRow(ACTION_LOG_HEADERS);
    try { sheet.getRange(1, 1, 1, ACTION_LOG_HEADERS.length).setFontWeight('bold').setBackground('#e0e0e0'); } catch(e) {}
  } else {
    // 既存シートの1行目が空 or 古いヘッダーなら最新ヘッダーに更新
    try {
      var firstRow = sheet.getRange(1, 1, 1, ACTION_LOG_HEADERS.length).getValues()[0];
      var needsUpdate = false;
      for (var hi = 0; hi < ACTION_LOG_HEADERS.length; hi++) {
        if (firstRow[hi] !== ACTION_LOG_HEADERS[hi]) { needsUpdate = true; break; }
      }
      if (needsUpdate) {
        // 既存1行目がデータの可能性（顧客名が「顧客名」という文字列でない場合）→ 先頭に新規行を挿入
        var isHeaderRow = firstRow[0] === '顧客名' || firstRow[0] === '' || firstRow[0] == null;
        if (!isHeaderRow) {
          sheet.insertRowBefore(1);
        }
        sheet.getRange(1, 1, 1, ACTION_LOG_HEADERS.length).setValues([ACTION_LOG_HEADERS]);
        sheet.getRange(1, 1, 1, ACTION_LOG_HEADERS.length).setFontWeight('bold').setBackground('#e0e0e0');
      }
    } catch(e) {}
  }

  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  var loggedRowIdx = 0;

  // === 転送疑い検知(view のみ) ===
  // 過去30分以内の同顧客×同物件アクセスで ISP/都市 が異なるログがあれば転送の疑い
  var forwardSuspect = null; // {otherIsp, otherCity, otherIp}
  if (actionType === 'view' && (trackIsp || trackCity)) {
    try {
      var nowMs = new Date().getTime();
      var WINDOW_MS = 30 * 60 * 1000;
      var lastRow = sheet.getLastRow();
      if (lastRow > 1) {
        // 末尾から最大200件を遡ってチェック
        var startRow = Math.max(2, lastRow - 200);
        var data = sheet.getRange(startRow, 1, lastRow - startRow + 1, ACTION_LOG_HEADERS.length).getValues();
        for (var ri = data.length - 1; ri >= 0; ri--) {
          var r = data[ri];
          if (r[0] !== customerName) continue;
          if (r[1] !== roomId) continue;
          if (r[2] !== 'view') continue;
          var dt = r[8]; // '日時' 列
          var dtMs = 0;
          if (dt instanceof Date) dtMs = dt.getTime();
          else if (typeof dt === 'string' && dt) dtMs = new Date(dt.replace(/\//g, '-').replace(' ', 'T') + '+09:00').getTime();
          if (!dtMs || isNaN(dtMs)) continue;
          if (nowMs - dtMs > WINDOW_MS) break; // 30分より古い → 以降の行も古いはず
          var rowIp = r[12] || '';
          var rowCity = r[15] || '';
          var rowIsp = r[16] || '';
          var ispDiff = trackIsp && rowIsp && trackIsp !== rowIsp;
          var cityDiff = trackCity && rowCity && trackCity !== rowCity;
          if (ispDiff || cityDiff) {
            forwardSuspect = { otherIsp: rowIsp, otherCity: rowCity, otherIp: rowIp };
            break;
          }
        }
      }
    } catch (fe) {
      console.error('転送検知エラー: ' + fe.message);
    }
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
    // アクションログには IP/国/都道府県/市区町村/ISP/UA/LINE内 も書き込む(転送検知の履歴源)
    sheet.appendRow([customerName, roomId, actionType, buildingName, roomNumber, rent, layout, stationInfo, now, applicationType, contactInfo,
      '', trackIp, trackCountry, trackRegion, trackCity, trackIsp, trackUa, trackIsLine ? 'LINE' : '']);
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

        // 承認待ちシートから物件のソース元URL (itandi/いえらぶ/ES-Square/REINS等
        // の元サイト物件ページ) を引いてきて、Discordメッセージ内の物件名を
        // クリッカブルリンクに。<URL>で囲んで自動embedプレビューを抑える。
        // 見つからない場合 (シート未登録/古いデータ等) はテキストのままにフォールバック。
        var sourceUrl = _findPendingPropertySourceUrl_(customerName, roomId);
        var propLabelLinked = sourceUrl
          ? '[' + propLabel + '](<' + sourceUrl + '>)'
          : propLabel;

        // viewアクションの場合、以下の場合は警告表示
        //  - LINE外ブラウザからのアクセス
        //  - 30分以内の同顧客×同物件アクセスで ISP/都市 が異なる(転送疑い)
        var viewPrefix = '\uD83D\uDCC4';
        var viewSuffix = '';
        if (actionType === 'view' && trackUa && !trackIsLine) {
          viewPrefix = '\u26A0\uFE0F'; // ⚠️
          viewSuffix += ' **（LINE外ブラウザ）**';
        }
        if (actionType === 'view' && forwardSuspect) {
          viewPrefix = '\u26A0\uFE0F';
          viewSuffix += ' **（転送疑い）**';
        }

        var msgMap = {
          'hold': '\uD83C\uDFE0 **' + customerName + '** 様が「' + propLabelLinked + '」に **お申し込み希望** をされました！',
          'hold_intent': '\uD83D\uDC40 **' + customerName + '** 様が「' + propLabelLinked + '」の **お申し込み希望画面を開きました**（未送信）',
          'favorite': '\u2B50 **' + customerName + '** 様が「' + propLabelLinked + '」を **お気に入り** に追加しました',
          'not_interested': '\uD83D\uDC4E **' + customerName + '** 様が「' + propLabelLinked + '」を **興味なし** にしました',
          'view': viewPrefix + ' **' + customerName + '** 様が「' + propLabelLinked + '」を閲覧しました' + viewSuffix
        };
        var msg = msgMap[actionType] || '';
        if (!msg) return ContentService.createTextOutput(JSON.stringify({ ok: true, favoriteCount: favoriteCount })).setMimeType(ContentService.MimeType.JSON);
        msg = '<@1459814543600390341>\n' + msg;

        // view アクションの場合、地理情報・端末情報を付与
        if (actionType === 'view') {
          var locParts = [];
          if (trackCountry && trackCountry !== 'Japan') locParts.push(trackCountry);
          if (trackRegion) locParts.push(trackRegion);
          if (trackCity) locParts.push(trackCity);
          var locStr = locParts.join(' ');
          if (locStr || trackIsp) {
            msg += '\n> \uD83D\uDCCD ' + (locStr || '(地域不明)') + (trackIsp ? ' / ' + trackIsp : '') + (trackIp ? ' (IP: ' + trackIp + ')' : '');
          }
          // 転送疑いの証拠行
          if (forwardSuspect) {
            var otherParts = [];
            if (forwardSuspect.otherCity) otherParts.push(forwardSuspect.otherCity);
            if (forwardSuspect.otherIsp) otherParts.push(forwardSuspect.otherIsp);
            var otherDesc = otherParts.join(' / ') || '別アクセス';
            msg += '\n> \uD83D\uDCE7 **転送疑い**: 直近30分以内に ' + otherDesc + ' からも閲覧あり';
          }
          if (trackUa) {
            // UAから端末/ブラウザを簡易パース
            var deviceType = /iPhone|iPad|Android|Mobile/.test(trackUa) ? '📱' : '💻';
            var browser = '';
            if (/Line\//.test(trackUa)) browser = 'LINE内ブラウザ';
            else if (/EdgiOS\//.test(trackUa) || /Edg\//.test(trackUa)) browser = 'Edge';
            else if (/CriOS\//.test(trackUa)) browser = 'Chrome'; // iOS Chrome
            else if (/FxiOS\//.test(trackUa)) browser = 'Firefox'; // iOS Firefox
            else if (/OPiOS\//.test(trackUa) || /OPR\//.test(trackUa)) browser = 'Opera';
            else if (/Chrome\//.test(trackUa)) browser = 'Chrome';
            else if (/Firefox\//.test(trackUa)) browser = 'Firefox';
            else if (/Safari\//.test(trackUa)) browser = 'Safari';
            else browser = 'その他ブラウザ';
            var os = '';
            if (/iPhone|iPad/.test(trackUa)) os = 'iOS';
            else if (/Android/.test(trackUa)) os = 'Android';
            else if (/Mac OS X/.test(trackUa)) os = 'Mac';
            else if (/Windows/.test(trackUa)) os = 'Windows';
            msg += '\n> ' + deviceType + ' ' + (os ? os + ' / ' : '') + browser;
          }
        }

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
        // 申し込み送信(hold)以外はサイレント送信。
        // メッセージは届くが Discord クライアントのプッシュ通知音は鳴らない。
        // hold だけは音を鳴らして担当者の対応漏れを防ぐ。
        if (actionType !== 'hold') {
          payload.flags = 4096; // SUPPRESS_NOTIFICATIONS
        }
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
        // 429/503はリトライ（最大5回、指数バックオフ）
        var retryHistory = [];
        var attempt = 0;
        while ((code === 429 || code === 503) && attempt < 5) {
          var waitMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s, 16s
          // Retry-After / retry_after を尊重
          try {
            var rb = JSON.parse(resp.getContentText());
            if (rb && rb.retry_after) {
              var suggestedMs = Math.ceil(parseFloat(rb.retry_after) * 1000) + 100;
              if (suggestedMs > waitMs) waitMs = suggestedMs;
            }
          } catch(e) {}
          try {
            var headers = resp.getAllHeaders();
            var ra = parseFloat(headers['Retry-After'] || headers['retry-after'] || '0');
            if (ra > 0) {
              var raMs = Math.ceil(ra * 1000) + 100;
              if (raMs > waitMs) waitMs = raMs;
            }
          } catch(e) {}
          if (waitMs > 30000) waitMs = 30000; // 最大30秒
          console.log('Discord ' + code + ': ' + waitMs + 'ms待機後リトライ (attempt=' + (attempt + 1) + ')');
          Utilities.sleep(waitMs);
          resp = UrlFetchApp.fetch(url, fetchOpts);
          code = resp.getResponseCode();
          retryHistory.push(code);
          attempt++;
        }
        if (retryHistory.length > 0) {
          discordStatus = 'code=' + retryHistory[0] + '→' + code + '(retry=' + retryHistory.length + ')';
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
    } catch(e) {
      discordStatus = 'exception:' + ((e && e.message ? e.message : String(e))).substring(0, 100);
      console.error('Discord action notification error: ' + e.message);
    }
    // L列(12)に応答コードを記録
    try { sheet.getRange(loggedRowIdx, 12).setValue(discordStatus); } catch(e) {}

    // M-S列(13-19): 閲覧トラッキング情報を記録（view アクション時のみ値あり）
    if (actionType === 'view' && loggedRowIdx > 0) {
      try {
        sheet.getRange(loggedRowIdx, 13, 1, 7).setValues([[
          trackIp,
          trackCountry,
          trackRegion,
          trackCity,
          trackIsp,
          trackUa,
          trackIsLine ? 1 : 0
        ]]);
      } catch(e) {}
    }
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
                { type: 'text', text: '✅ お申し込み希望受付', weight: 'bold', size: 'lg', color: '#2E7D32', wrap: true },
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
    // お気に入り一覧時もお客さん希望駅を1回だけ取得
    var favCustStations = _getCustomerSelectedStations_(customerName);

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

      var heroImageUrls = (prop.imageUrls && prop.imageUrls.length > 0) ? prop.imageUrls : (prop.imageUrl ? [prop.imageUrl] : []);
      var flex = buildPropertyFlex(prop, {
        includeImage: heroImageUrls.length > 0,
        heroImageUrls: heroImageUrls,
        viewUrl: viewUrl,
        customerStations: favCustStations
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
        latestStatus = (s === 'paused' || s === 'auto_paused') ? s : 'active';
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
    sheet.getRange(targetRow, 30).setValue(0);  // AD列: 条件変更提案カウントリセット
  }
  return { ok: true, customerName: customerName };
}

// 顧客名で配信ステータスを変更する（userId 不要 = リードでも使える）。
// google.script.run（顧客管理ページのステータス変更UI）から呼ばれる。
function setCustomerStatusByName(customerName, status) {
  try {
    if (!customerName || !status) return { ok: false, message: '引数不足' };
    var ALLOWED = ['active', 'lead', 'paused', 'snoozed', 'blocked', 'auto_paused'];
    if (ALLOWED.indexOf(status) < 0) return { ok: false, message: '不正なステータス: ' + status };
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return { ok: false, message: '検索条件シートが見つかりません' };
    var data = sheet.getDataRange().getValues();
    var targetRow = -1;
    var nameTrim = String(customerName).trim();
    for (var j = 1; j < data.length; j++) {
      if (String(data[j][1] || '').trim() === nameTrim) targetRow = j + 1; // 最新行（末尾）
    }
    if (targetRow < 0) return { ok: false, message: '顧客が見つかりません' };
    sheet.getRange(targetRow, 19).setValue(status); // S列
    if (status === 'active') {
      sheet.getRange(targetRow, 22).setValue(''); // V列: スヌーズ解除
      sheet.getRange(targetRow, 30).setValue(0);  // AD列: 条件変更提案カウントリセット
    }
    return { ok: true, customerName: customerName, status: status };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// 顧客の営業ステージ(カンバン列)を変更する。検索条件シート AG列(33列目)に保存。
// （AE列=31=btMode は既存利用のため衝突回避で AG=33 を使う）
// google.script.run（顧客管理ページのカンバン・ドラッグ）から呼ばれる。
function setCustomerStage(customerName, stage) {
  try {
    if (!customerName || !stage) return { ok: false, message: '引数不足' };
    var ALLOWED = ['問い合わせ', '追客中', '内見', '申込', '成約', '終了'];
    if (ALLOWED.indexOf(stage) < 0) return { ok: false, message: '不正なステージ: ' + stage };
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return { ok: false, message: '検索条件シートが見つかりません' };
    var data = sheet.getDataRange().getValues();
    var targetRow = -1;
    var nameTrim = String(customerName).trim();
    for (var j = 1; j < data.length; j++) {
      if (String(data[j][1] || '').trim() === nameTrim) targetRow = j + 1; // 最新行
    }
    if (targetRow < 0) return { ok: false, message: '顧客が見つかりません' };
    sheet.getRange(targetRow, 33).setValue(stage); // AG列(33): 営業ステージ
    return { ok: true, customerName: customerName, stage: stage };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/**
 * カンバンの並び順を保存する。指定ステージの順序付き顧客名リストを受け取り、
 * 各顧客に AG列(33)=stage と AH列(34)=順序インデックス を書き込む。
 * @param {string} stage 対象ステージ
 * @param {string[]} orderedNames 上から順の顧客名配列
 * @return {Object} { ok }
 */
function setKanbanOrder(stage, orderedNames) {
  try {
    var ALLOWED = ['問い合わせ', '追客中', '内見', '申込', '成約', '終了'];
    if (ALLOWED.indexOf(stage) < 0) return { ok: false, message: '不正なステージ: ' + stage };
    if (!Array.isArray(orderedNames)) return { ok: false, message: '順序リストがありません' };
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return { ok: false, message: '検索条件シートが見つかりません' };
    var data = sheet.getDataRange().getValues();

    // 顧客名 → 最新行（1-based）
    var nameToRow = {};
    for (var j = 1; j < data.length; j++) {
      var nm = String(data[j][1] || '').trim();
      if (nm) nameToRow[nm] = j + 1;
    }
    var updated = 0;
    for (var i = 0; i < orderedNames.length; i++) {
      var name = String(orderedNames[i] || '').trim();
      var rowNum = nameToRow[name];
      if (!rowNum) continue;
      sheet.getRange(rowNum, 33).setValue(stage); // AG: ステージ
      sheet.getRange(rowNum, 34).setValue(i);     // AH: 並び順
      updated++;
    }
    return { ok: true, updated: updated };
  } catch (e) {
    return { ok: false, message: e.message };
  }
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
        'やめる場合は「キャンセル」を選んでください。',
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
        '再開したくなったら、メニューの「配信の停止/再開」ボタンを押してください。\n\n' +
        '※配信を再開する場合は1週間以内にお願いします。\n1週間を超えると、これまでの登録条件・物件履歴が削除され、再度条件登録からのスタートとなります。'
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

    // 旧仕様: 「忙しい」「希望に合わない」「通知が多い」 は代替案を提示してから停止
    //         していたが、ユーザー要望で撤廃。すべての理由を即停止する。
    //         (スヌーズ案内 / 条件変更提案 / 頻度ダウン提案 のロジックは
    //          関連 STEPS / handler が他に残置されているが、ここからの遷移は行わない)
    _finalizeStop(userId, reason);
    clearState(userId);
    replyMessage(replyToken, [textMsg(
      '配信を停止しました。ご回答ありがとうございます。\n\n' +
      '再開したくなったら、メニューの「配信の停止/再開」ボタンを押してください。'
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
        '再開したくなったら、メニューの「配信の停止/再開」ボタンを押してください。\n\n' +
        '※配信を再開する場合は1週間以内にお願いします。\n1週間を超えると、これまでの登録条件・物件履歴が削除され、再度条件登録からのスタートとなります。'
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
        '再開したくなったら、メニューの「配信の停止/再開」ボタンを押してください。\n\n' +
        '※配信を再開する場合は1週間以内にお願いします。\n1週間を超えると、これまでの登録条件・物件履歴が削除され、再度条件登録からのスタートとなります。'
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
        '再開したくなったら、メニューの「配信の停止/再開」ボタンを押してください。\n\n' +
        '※配信を再開する場合は1週間以内にお願いします。\n1週間を超えると、これまでの登録条件・物件履歴が削除され、再度条件登録からのスタートとなります。'
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
      replyMessage(replyToken, [textMsg('ご希望条件が未登録のようです。まずは「お部屋を探す」からお願いいたします。')]);
      return;
    }

    // 現在登録中の条件サマリーを構築 (再開時に念のため見せる)
    var summary = '';
    try {
      if (typeof readLatestCriteria === 'function' && typeof formatConditionSummary === 'function') {
        var existing = readLatestCriteria(userId);
        if (existing) {
          var stateLike = {
            areaMethod: existing.areaMethod,
            selectedRoutes: existing.selectedRoutes,
            selectedStations: existing.selectedStations,
            selectedCities: existing.selectedCities,
            selectedTowns: existing.selectedTowns || {},
            data: {
              move_in_date: existing.move_in_date,
              rent_max: existing.rent_max,
              layouts: existing.layouts,
              walk: existing.walk,
              area_min: existing.area_min,
              building_age: existing.building_age,
              building_structures: existing.building_structures,
              equipment: existing.equipment,
              petType: existing.petType
            }
          };
          summary = formatConditionSummary(stateLike);
        }
      }
    } catch (e) {
      console.warn('handleDeliveryResumeCommand summary build error: ' + e.message);
    }

    var msg = '新着物件の配信を再開しました。\nご希望に合うお部屋が見つかり次第、お届けいたします。';
    if (summary && summary !== '（条件なし）') {
      msg += '\n\n──── 現在ご登録の条件 ────\n' + summary;
      msg += '\n\n条件を変えたい時は、メニューの「お部屋探しの条件を変える」からご変更ください。';
    }

    replyMessage(replyToken, [textMsg(msg)]);
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
        desc: '気になるお部屋の空室状況をその場で確認できます。物件名・所在地・最寄駅・専有面積・募集ページURLのいずれかを送ってください。',
        trigger: '空室確認'
      },
      {
        title: 'お部屋を探す',
        desc: 'ご希望のエリア・賃料・間取りなどをご登録いただくと、条件にぴったりのお部屋をスタッフが厳選してお届けします。',
        trigger: '条件登録'
      },
      {
        title: 'お部屋探しの条件を変える',
        desc: 'ご登録いただいた条件をいつでも見直せます。エリアを広げたい・予算が変わった・引越し時期が変わったなど、状況に合わせて調整してください。',
        trigger: '条件変更'
      },
      {
        title: 'お気に入り',
        desc: 'これまでに ⭐ ボタンで保存したお部屋を一覧で確認できます。後からまとめて見比べたい時に便利です。',
        trigger: 'お気に入り'
      },
      isPaused ? {
        title: '配信の停止/再開',
        desc: '現在、お部屋情報の配信を停止中です。タップすると配信を再開します。',
        trigger: '配信切替',
        btnLabel: '配信を再開する'
      } : {
        title: '配信の停止/再開',
        desc: 'お部屋情報のお届けを一時的に止めたい時にご利用ください。タップすると停止理由をお伺いします。再開はいつでもできて、ご登録条件は残ります。',
        trigger: '配信切替',
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
            { type: 'text', text: f.title, weight: 'bold', size: 'lg', color: '#8ec41d', wrap: true },
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
/**
 * 承認待ち物件シートから、customer + roomId に該当する物件のソース元URL
 * (itandi / いえらぶ / ES-Square / REINS の物件詳細ページURL) を取得する。
 *
 * Discord 通知メッセージで物件名をクリッカブルにする用途。
 * 該当行が無い / J列(property_data_json)が壊れている / url 未設定 の場合は '' を返す。
 *
 * status は pending/sent どちらでも引っかける (承認済みでもアクションは起き得るため)。
 *
 * URL 解決順:
 *   1. extra.url があればそれ (itandi/いえらぶ/ES-Square は直 URL を持つ)
 *   2. REINS は直 URL を持たないため、reins_property_number から
 *      物件番号検索ページのフラグメント形式 URL を構築
 *      (https://system.reins.jp/main/BK/GBK004100#bukken=NNNNN)
 *      → SuumoPatrol/Chrome拡張の Discord リンクと同じ形式
 */
function _findPendingPropertySourceUrl_(customerName, roomId) {
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
    if (!sheet) return '';
    var data = sheet.getDataRange().getValues();
    var targetCust = String(customerName);
    var targetRoom = String(roomId);
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) !== targetCust) continue;
      // C列(roomId)が数値化されている可能性に備えて文字列照合
      var cellVal = data[i][2];
      var match = (String(cellVal) === targetRoom);
      if (!match && typeof cellVal === 'number' && !isNaN(cellVal)) {
        try { match = (cellVal.toFixed(0) === targetRoom); } catch (_) {}
      }
      if (!match) continue;
      var status = String(data[i][10] || '');
      if (status !== 'pending' && status !== 'sent') continue;
      var extra = {};
      try { extra = JSON.parse(data[i][9] || '{}'); } catch (_) { return ''; }
      // 1. itandi/いえらぶ/ES-Square 等は直接の物件URL
      if (extra.url) return extra.url;
      // 2. REINS は物件番号検索ページの URL を構築
      var num = String(extra.reins_property_number || '').replace(/[^0-9]/g, '');
      if (num) return 'https://system.reins.jp/main/BK/GBK004100#bukken=' + num;
      return '';
    }
  } catch (e) {
    console.error('[_findPendingPropertySourceUrl_] エラー: ' + e.message);
  }
  return '';
}

function findPendingRow(customerName, roomId) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (!sheet) return null;

  var data = sheet.getDataRange().getValues();
  var targetCust = String(customerName);
  var targetRoom = String(roomId);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== targetCust) continue;
    if (String(data[i][10]) !== 'pending') continue;
    // room_id が数値として保存されている場合、精度欠落で完全一致しないことがある。
    // その対策として、指数表記化している可能性のある大きな数値は
    // toFixed(0) でも照合する。
    var cellVal = data[i][2];
    if (String(cellVal) === targetRoom) {
      return { rowIndex: i + 1, values: data[i] };
    }
    // 数値化されているケースのフォールバック
    if (typeof cellVal === 'number' && !isNaN(cellVal)) {
      try {
        var cellStr = cellVal.toFixed(0);
        if (cellStr === targetRoom) {
          return { rowIndex: i + 1, values: data[i] };
        }
      } catch (_) {}
    }
  }
  return null;
}

/**
 * 承認待ち物件シートの B列(building_id) と C列(room_id) を
 * テキストフォーマットに一括変更する管理ユーティリティ
 *
 * 既に数値として保存されて指数表記化した行は精度が失われているため復元不可だが、
 * 列フォーマットを '@'(text) に変えておくことで以後の書き込みで数値化を防ぐ。
 * GASエディタから fixPendingSheetIdColumnsToText を手動実行する想定。
 */
function fixPendingSheetIdColumnsToText() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (!sheet) return { error: 'sheet not found' };

  var lastRow = Math.max(sheet.getLastRow(), 1);
  // B列(building_id)と C列(room_id)を text format に
  sheet.getRange(1, 2, lastRow + 1000, 1).setNumberFormat('@');
  sheet.getRange(1, 3, lastRow + 1000, 1).setNumberFormat('@');

  // 既に数値として保存されている行の値を文字列に書き直す
  // (ただし指数表記で精度が失われた行は toFixed(0) で復元できる最大限を試す)
  var fixed = 0;
  if (lastRow > 1) {
    var data = sheet.getRange(2, 2, lastRow - 1, 2).getValues();
    var writes = [];
    for (var i = 0; i < data.length; i++) {
      var b = data[i][0];
      var c = data[i][1];
      var newB = b;
      var newC = c;
      if (typeof b === 'number' && !isNaN(b)) {
        try { newB = b.toFixed(0); fixed++; } catch (_) {}
      }
      if (typeof c === 'number' && !isNaN(c)) {
        try { newC = c.toFixed(0); fixed++; } catch (_) {}
      }
      writes.push([newB, newC]);
    }
    sheet.getRange(2, 2, writes.length, 2).setValues(writes);
  }
  return { success: true, fixedCells: fixed };
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

// room_id 群で行を取得（status は問わない）。
// カート一括承認では「明示的に選んだ物件」を必ず出すため、過去に送信済み(status='sent')でも対象にする。
function _findRowsByRoomIdsAnyStatus_(customerName, roomIds) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var set = {};
  for (var k = 0; k < roomIds.length; k++) set[String(roomIds[k])] = true;
  var results = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== String(customerName)) continue;
    if (set[String(data[i][2])]) results.push({ rowIndex: i + 1, values: data[i] });
  }
  return results;
}

function updatePendingStatus(rowIndex, newStatus, viewUrl) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  sheet.getRange(rowIndex, 11).setValue(newStatus);
  sheet.getRange(rowIndex, 13).setValue(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'));
  if (viewUrl) {
    sheet.getRange(rowIndex, 14).setValue(viewUrl);
  }
}

function addToSeenSheet(customerName, prop) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SEEN_SHEET_NAME);
  if (!sheet) return;
  // E列にソース (itandi/ielove/essquare/reins) を記録 →
  // サイト別の履歴リセット機能に利用
  var source = '';
  try {
    if (prop && prop.source) {
      source = String(prop.source);
    } else if (prop && prop.url) {
      var u = String(prop.url).toLowerCase();
      if (u.indexOf('itandibb.com') >= 0 || u.indexOf('rent.itandi') >= 0) source = 'itandi';
      else if (u.indexOf('ielove') >= 0 || u.indexOf('homes.co.jp') >= 0) source = 'ielove';
      else if (u.indexOf('es-square') >= 0 || u.indexOf('iisesq') >= 0) source = 'essquare';
      else if (u.indexOf('reins') >= 0) source = 'reins';
    }
  } catch (_) {}
  // F列: current_status (空室状況: 'available' / 'closed' / 'reins_listed' / 'unknown')
  // G列: status_checked_at (最終確認日時)
  // H列: source_ref (空室確認用の参照値)
  //   - itandi/ielove/essquare: 物件URL
  //   - reins: REINS物件番号 (URLが安定しないため番号で再検索)
  // 新規追加時はチェック未実施なので F/G は空で開始する。
  var sourceRef = '';
  if (source === 'reins') {
    sourceRef = String((prop && prop.reinsPropertyNumber) || (prop && prop.reins_property_number) || '');
    if (!sourceRef && prop && prop.url) sourceRef = String(prop.url); // フォールバック
  } else {
    sourceRef = String((prop && prop.url) || '');
  }
  sheet.appendRow([
    customerName,
    prop.roomId,
    prop.buildingName,
    Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'),
    source,
    '', // current_status
    '', // status_checked_at
    sourceRef
  ]);
}

/**
 * 通知済み物件シートの該当行に空室状況を書き込む。
 * Chrome拡張側から定期的に呼ばれる想定。
 *
 * @param {string} customerName
 * @param {string} roomId
 * @param {string} status - 'available' / 'closed' / 'reins_listed' / 'unknown'
 * @return {{ok: boolean, message: string}}
 */
function setPropertyAvailability(customerName, roomId, status, extras) {
  if (!customerName || !roomId) return { ok: false, message: 'customer/roomId が未指定' };
  extras = extras || {};
  // 'applied' = 申込あり (掲載は続いてるが申込が入ってる、再オープン余地あり)
  // 'closed'  = 募集終了 (404/掲載削除/完全終了)
  var validStatuses = ['available', 'applied', 'closed', 'reins_listed', 'needs_confirmation', 'unknown'];
  if (validStatuses.indexOf(status) < 0) return { ok: false, message: '不正なstatus: ' + status };
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(SEEN_SHEET_NAME);
    if (!sheet) return { ok: false, message: 'シートが見つかりません' };
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { ok: false, message: 'シートが空です' };
    // A〜J列を読む (E列=source, C列=building_name, H列=source_ref, I列=priority_requested_at, J列=watch_for_cancellation_at)
    var data = sheet.getRange(2, 1, lastRow - 1, 10).getValues();
    var nameTrim = String(customerName).trim();
    var ridTrim = String(roomId).trim();
    var updated = 0;
    var deleted = 0;
    var rowsToDelete = [];
    var discordPayloads = [];  // Chrome拡張側で送信するDiscord通知ペイロード
    var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() === nameTrim && String(data[i][1]).trim() === ridTrim) {
        var rowNum = i + 2;
        var source = String(data[i][4] || '').trim().toLowerCase();
        var buildingName = String(data[i][2] || '');
        var sourceRef = String(data[i][7] || '');  // REINSの場合は物件番号

        // closed (404/掲載終了) → 確実に募集終了。全サイト共通。
        // 通知済みシートから削除して空室確認の対象外にする (キューが軽くなる)。
        // ※ 削除前に優先依頼があればLINE通知を送る。
        if (status === 'closed') {
          var priorityRawClosed = data[i][8];
          var priorityAtClosed = _parseDateFlexible_(priorityRawClosed);
          var hasRecentPriorityClosed = (priorityAtClosed > 0 && priorityAtClosed > Date.now() - 60 * 60 * 1000);
          if (hasRecentPriorityClosed) {
            try {
              _notifyAvailabilityResultToCustomer_(nameTrim, ridTrim, buildingName, status, extras);
              console.log('[setPropertyAvailability] ' + source + ' closed → LINE通知送信: ' + nameTrim);
            } catch (eRL) {
              console.warn('[setPropertyAvailability] ' + source + ' closed LINE通知失敗: ' + eRL.message);
            }
          }
          rowsToDelete.push(rowNum);
          deleted++;
          continue;
        }

        // キャンセル通知希望 (J列) チェック
        //   watch 中物件で「申込可能」になった = キャンセル発生
        var watchRaw = data[i][9];  // J列 (index 9)
        var isWatching = !!watchRaw;
        if (isWatching) {
          var prevStatus = String(data[i][5] || '');
          // キャンセル発生判定:
          //   - status が available になった
          //   - status が applied で canApply !== false (申込可能になった)
          //   - status が applied で badgeCount が直近より減少 ... は省略 (シンプル化)
          var cancellationDetected = false;
          if (status === 'available') {
            cancellationDetected = true;
          } else if (status === 'applied' && extras.canApply !== false) {
            // 前回 canApply=false → 今回 canApply=true は確実にキャンセル
            // 前回情報が分からない場合も、ボタンが押せるなら通知
            cancellationDetected = true;
          }
          if (cancellationDetected) {
            try {
              _notifyCancellationOccurredToCustomer_(nameTrim, ridTrim, buildingName, status, extras);
              // watch フラグクリア (通知済み)
              sheet.getRange(rowNum, 10).setValue('');
            } catch (eC) {
              console.warn('[setPropertyAvailability] キャンセル通知失敗: ' + eC.message);
            }
          }
        }

        // 優先依頼が直近1時間以内なら、結果に応じてお客さんに通知する。
        var priorityRaw = data[i][8];
        var priorityAt = _parseDateFlexible_(priorityRaw);
        var nowMs = Date.now();
        var hasRecentPriority = (priorityAt > 0 && priorityAt > nowMs - 60 * 60 * 1000);

        if (hasRecentPriority) {
          if ((source === 'reins' && status === 'reins_listed') ||
              status === 'needs_confirmation') {
            // スタッフ確認必要 → Discord通知用 payload を生成して返却
            //   GAS側からは直接送らず、Chrome拡張側でユーザーIPから送信 (Cloudflare 1015対策)
            //   priority_requested_at はクリアしない (スタッフが確認するまで「依頼中」のまま)
            try {
              var dPayload = _buildAvailabilityDiscordPayload_(nameTrim, ridTrim, buildingName, sourceRef, source, status, extras.application_status);
              if (dPayload) discordPayloads.push(dPayload);
            } catch (eN) {
              console.warn('[setPropertyAvailability] Discord payload生成失敗: ' + eN.message);
            }
          } else if (status === 'available' || status === 'applied' || status === 'closed') {
            // 自動で確定 → お客さんにLINEプッシュ通知
            try {
              _notifyAvailabilityResultToCustomer_(nameTrim, ridTrim, buildingName, status, extras);
              // 通知後は priority_requested_at をクリア (依頼完了)
              sheet.getRange(rowNum, 9).setValue('');
            } catch (eL) {
              console.warn('[setPropertyAvailability] LINE通知失敗: ' + eL.message);
            }
          }
        }

        sheet.getRange(rowNum, 6).setValue(status);
        sheet.getRange(rowNum, 7).setValue(now);
        // K列: can_apply, L列: badge_count, M列: application_status (property.html のステータス表示用)
        if (typeof extras.canApply === 'boolean') {
          sheet.getRange(rowNum, 11).setValue(extras.canApply ? 'TRUE' : 'FALSE');
        }
        if (typeof extras.badgeCount === 'number') {
          sheet.getRange(rowNum, 12).setValue(extras.badgeCount);
        } else {
          sheet.getRange(rowNum, 12).setValue('');
        }
        sheet.getRange(rowNum, 13).setValue(extras.application_status || '');
        updated++;
      }
    }
    // 削除は下から行う (行番号がずれないように)
    for (var j = rowsToDelete.length - 1; j >= 0; j--) {
      sheet.deleteRow(rowsToDelete[j]);
    }
    return {
      ok: (updated + deleted) > 0,
      message: updated + '行 更新、' + deleted + '行 削除しました',
      discordPayloads: discordPayloads
    };
  } catch (e) {
    return { ok: false, message: 'エラー: ' + e.message };
  }
}

/**
 * 柔軟な日時パース。
 * - Date オブジェクト
 * - "2026-05-21 13:50:00" / "2026-05-21 4:14:09" (1桁時刻含む)
 * - "2026/05/21 13:50:00"
 * - ISO 8601
 *  すべて JST (Asia/Tokyo) として解釈する。
 *
 * @param {*} raw
 * @return {number} unix ms (0 = parse失敗)
 */
function _parseDateFlexible_(raw) {
  if (!raw) return 0;
  if (raw instanceof Date) return raw.getTime();
  var s = String(raw).trim();
  if (!s) return 0;
  // 「YYYY-MM-DD H(or HH):MM:SS」「YYYY/MM/DD H:MM:SS」を正規表現で分解
  var m = s.match(/^(\d{4})[\-\/](\d{1,2})[\-\/](\d{1,2})[\s T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (m) {
    var y = parseInt(m[1], 10);
    var mo = parseInt(m[2], 10) - 1;
    var d = parseInt(m[3], 10);
    var h = parseInt(m[4], 10);
    var mi = parseInt(m[5], 10);
    var sc = m[6] ? parseInt(m[6], 10) : 0;
    // GAS の Date() は スクリプトのタイムゾーンで解釈される (本プロジェクトは JST 設定)
    var dt = new Date(y, mo, d, h, mi, sc);
    if (!isNaN(dt.getTime())) return dt.getTime();
  }
  // Fallback: 標準パース
  var fb = new Date(s);
  if (!isNaN(fb.getTime())) return fb.getTime();
  return 0;
}

/**
 * 空室状況確認キュー: 通知済み物件のうち、確認が必要な物件のリストを返す。
 *   - sentAt が maxAgeDays 以内 (デフォルト 60日)
 *   - status_checked_at が空 OR maxIntervalHours 以上経過 (デフォルト 24時間)
 * 各物件には URL も付与 (承認待ちシート JSON から取得)
 *
 * @param {{limit?: number, maxAgeDays?: number, maxIntervalHours?: number}} [options]
 * @return {Array<{customer, roomId, source, url, sentAt, currentStatus, statusCheckedAt}>}
 */
function getAvailabilityCheckQueue(options) {
  options = options || {};
  var limit = options.limit || 50;
  var maxAgeDays = options.maxAgeDays || 60;
  var maxIntervalHours = options.maxIntervalHours || 24;
  // priorityOnly=true なら I列 priority_requested_at が直近 maxPriorityAgeMinutes 以内の行のみ返す
  // (お客さんがボタンを押した時の優先処理用)
  var priorityOnly = !!options.priorityOnly;
  var maxPriorityAgeMinutes = options.maxPriorityAgeMinutes || 60;
  // watchOnly=true なら J列 watch_for_cancellation_at が空でない行のみ返す
  // (キャンセル通知希望物件の定期チェック用)
  var watchOnly = !!options.watchOnly;
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var seenSheet = ss.getSheetByName(SEEN_SHEET_NAME);
    var pendingSheet = ss.getSheetByName(PENDING_SHEET_NAME);
    if (!seenSheet) return [];

    // 0. 検索条件シートから paused/blocked 顧客を取得 → 空室確認をスキップ
    var inactiveCustomers = {};
    try {
      var critSs = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
      var critSheet = critSs.getSheetByName(CRITERIA_SHEET_NAME);
      if (critSheet) {
        var critLast = critSheet.getLastRow();
        if (critLast >= 2) {
          var critData = critSheet.getRange(2, 2, critLast - 1, 18).getValues(); // B列〜S列 (B=index0, S=index17)
          for (var ci = 0; ci < critData.length; ci++) {
            var cname = String(critData[ci][0] || '').trim(); // B列
            var cstatus = String(critData[ci][17] || '').trim(); // S列
            if (cname && (cstatus === 'paused' || cstatus === 'auto_paused' || cstatus === 'blocked')) {
              inactiveCustomers[cname] = cstatus;
            }
          }
        }
      }
    } catch (eCrit) {
      console.warn('[availability queue] 検索条件シート読み込み失敗: ' + eCrit.message);
    }

    // 1. 承認待ち から (customer|roomId) → {url, source} のマップを作る
    var urlMap = {};
    if (pendingSheet) {
      var pLast = pendingSheet.getLastRow();
      if (pLast >= 2) {
        var pData = pendingSheet.getRange(2, 1, pLast - 1, 10).getValues();
        for (var i = 0; i < pData.length; i++) {
          var pCust = String(pData[i][0] || '').trim();
          var pRoom = String(pData[i][2] || '').trim();
          if (!pCust || !pRoom) continue;
          try {
            var parsed = JSON.parse(String(pData[i][9] || ''));
            if (parsed && parsed.url) {
              urlMap[pCust + '|' + pRoom] = {
                url: String(parsed.url),
                source: String(parsed.source || 'reins'),
                reinsPropNo: String(parsed.reins_property_number || '')
              };
            }
          } catch (_) {}
        }
      }
    }

    // 2. 通知済み物件 から確認対象を抽出
    var seenLast = seenSheet.getLastRow();
    if (seenLast < 2) return [];
    // 10列 (顧客/room_id/建物名/通知日時/ソース/状態/確認日時/URL/priority_requested_at/watch_for_cancellation_at)
    var sData = seenSheet.getRange(2, 1, seenLast - 1, 10).getValues();
    var now = Date.now();
    var ageCutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
    var intervalCutoff = now - maxIntervalHours * 60 * 60 * 1000;
    var priorityCutoff = now - maxPriorityAgeMinutes * 60 * 1000;
    var rawCandidates = [];  // 先に候補を集めて、優先度順にソートしてから limit 適用
    var staleClosedRows = []; // closed なのに残っている行を削除する
    var diag = { total: sData.length, noCustOrRoom: 0, noSentAt: 0, tooOld: 0,
                  isClosed: 0, recentlyChecked: 0, noUrl: 0, urlMapSize: Object.keys(urlMap).length,
                  urlFromSeen: 0, urlFromPending: 0, priorityCount: 0,
                  inactiveCustomers: Object.keys(inactiveCustomers).length, skippedInactive: 0 };
    for (var j = 0; j < sData.length; j++) {
      var customer = String(sData[j][0] || '').trim();
      var roomId = String(sData[j][1] || '').trim();
      if (!customer || !roomId) { diag.noCustOrRoom++; continue; }
      // 配信停止・ブロック顧客はスキップ (1週間後に物件自体が削除される)
      if (inactiveCustomers[customer]) { diag.skippedInactive++; continue; }
      // D列の通知日時を Date に変換
      var sentRaw = sData[j][3];
      var sentAt = _parseDateFlexible_(sentRaw);
      var sentAtStr = (sentRaw instanceof Date)
        ? Utilities.formatDate(sentRaw, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
        : String(sentRaw || '');
      if (!sentAt) { diag.noSentAt++; continue; }
      if (sentAt < ageCutoff) { diag.tooOld++; continue; }
      var status = String(sData[j][5] || '');
      var checkedRaw = sData[j][6];
      var checkedAt = _parseDateFlexible_(checkedRaw);
      var checkedAtStr = (checkedRaw instanceof Date)
        ? Utilities.formatDate(checkedRaw, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
        : String(checkedRaw || '');

      // I列: priority_requested_at (お客さんからの即時確認依頼)
      var priorityRaw = sData[j][8];
      var priorityAt = _parseDateFlexible_(priorityRaw);
      var isPriority = priorityAt > 0 && priorityAt > priorityCutoff &&
                       (!checkedAt || checkedAt < priorityAt);
      if (isPriority) diag.priorityCount++;

      // J列: watch_for_cancellation_at (キャンセル通知希望)
      var watchRaw = sData[j][9];
      var isWatching = !!watchRaw;

      // watchOnly モードなら watch 中のみ抽出
      if (watchOnly && !isWatching) continue;

      // priorityOnly モードなら優先依頼のみ抽出
      if (priorityOnly && !isPriority) continue;

      // 通常モード: closed / 直近チェック済みはスキップ。ただし優先依頼/watch中があれば例外。
      if (!isPriority && !isWatching) {
        if (status === 'closed') {
          diag.isClosed++;
          staleClosedRows.push(j + 2); // 行番号 (1-indexed, ヘッダー=1行目)
          continue;
        }
        if (checkedAt && checkedAt > intervalCutoff) { diag.recentlyChecked++; continue; }
      }

      // H列を最優先 (REINS は物件番号、その他は URL)
      var seenRef = String(sData[j][7] || '').trim();
      var info = urlMap[customer + '|' + roomId] || {};
      var srcType = String(sData[j][4] || '') || info.source || 'reins';
      var finalUrl = '';
      var finalReinsPropNo = '';
      if (srcType === 'reins') {
        finalReinsPropNo = seenRef || info.reinsPropNo || '';
        if (info.url) finalUrl = info.url;
      } else {
        finalUrl = seenRef || info.url || '';
      }
      var hasInfo = finalUrl || finalReinsPropNo;
      if (!hasInfo) { diag.noUrl++; continue; }
      if (seenRef) diag.urlFromSeen++; else diag.urlFromPending++;

      rawCandidates.push({
        customer: customer,
        roomId: roomId,
        source: srcType,
        url: finalUrl,
        reinsPropNo: finalReinsPropNo,
        sentAt: sentAtStr,
        currentStatus: status,
        statusCheckedAt: checkedAtStr,
        isPriority: isPriority,
        priorityAt: priorityAt
      });
    }

    // 優先依頼を先頭にソート (priorityAt 降順)
    rawCandidates.sort(function(a, b) {
      if (a.isPriority !== b.isPriority) return a.isPriority ? -1 : 1;
      if (a.isPriority && b.isPriority) return b.priorityAt - a.priorityAt;
      return 0;
    });

    var out = rawCandidates.slice(0, limit);
    // isPriority / priorityAt は内部用なので返却時に除去
    out = out.map(function(o) {
      var c = {};
      for (var k in o) {
        if (k === 'isPriority' || k === 'priorityAt') continue;
        c[k] = o[k];
      }
      return c;
    });

    // closed なのにシートに残っている行を掃除 (下から削除して行番号ずれを防ぐ)
    if (staleClosedRows.length > 0) {
      staleClosedRows.sort(function(a, b) { return b - a; });
      for (var dr = 0; dr < staleClosedRows.length; dr++) {
        try { seenSheet.deleteRow(staleClosedRows[dr]); } catch (_) {}
      }
      console.log('[availability queue] closed残留行を ' + staleClosedRows.length + ' 件削除');
      diag.deletedClosedRows = staleClosedRows.length;
    }

    console.log('[availability queue] diag: ' + JSON.stringify(diag) + ' returned: ' + out.length);
    out._diag = diag;
    return out;
  } catch (e) {
    console.warn('getAvailabilityCheckQueue error: ' + e.message);
    return [];
  }
}

/**
 * 空室確認機能のテストユーザーかどうかを判定。
 * ScriptProperties キー 'availability_test_customers' にカンマ区切り or JSON配列で保存。
 *
 * @param {string} customerName
 * @return {boolean}
 */
function isAvailabilityTestUser(customerName) {
  if (!customerName) return false;
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('availability_test_customers');
    if (!raw) return false;
    var list = [];
    try {
      list = JSON.parse(raw);
      if (!Array.isArray(list)) list = [];
    } catch (_) {
      list = String(raw).split(',').map(function(s) { return s.trim(); });
    }
    var trimmed = String(customerName).trim();
    for (var i = 0; i < list.length; i++) {
      if (String(list[i]).trim() === trimmed) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * テストユーザーリストを操作 (追加 / 削除 / 一覧取得)。
 * customerName か userId のどちらかを指定可。userId なら LINE_USERS シートで
 * 顧客名を解決してから登録する。
 *
 * @param {'add'|'remove'|'list'} op
 * @param {string} [customerName]
 * @param {string} [userId] - LINE userId (顧客名の代わりにこれを指定可)
 * @return {{ok:boolean, list:string[], message?:string}}
 */
function manageAvailabilityTestUsers(op, customerName, userId) {
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty('availability_test_customers');
    var list = [];
    if (raw) {
      try {
        list = JSON.parse(raw);
        if (!Array.isArray(list)) list = [];
      } catch (_) {
        list = String(raw).split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
      }
    }

    // userId 指定なら顧客名に解決
    if ((op === 'add' || op === 'remove') && !customerName && userId) {
      customerName = _resolveUserIdToCustomerName_(userId);
      if (!customerName) {
        return { ok: false, message: 'userId に対応する顧客名が見つかりません: ' + userId };
      }
    }

    if (op === 'add') {
      if (!customerName) return { ok: false, message: 'customerName または userId 必須' };
      var nameTrim = String(customerName).trim();
      if (list.indexOf(nameTrim) < 0) list.push(nameTrim);
      props.setProperty('availability_test_customers', JSON.stringify(list));
      return { ok: true, list: list, message: nameTrim + ' を追加しました', resolvedCustomerName: nameTrim };
    }
    if (op === 'remove') {
      if (!customerName) return { ok: false, message: 'customerName または userId 必須' };
      var nameTrim2 = String(customerName).trim();
      list = list.filter(function(s) { return s !== nameTrim2; });
      props.setProperty('availability_test_customers', JSON.stringify(list));
      return { ok: true, list: list, message: nameTrim2 + ' を削除しました' };
    }
    // list
    return { ok: true, list: list };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/**
 * LINE userId → 検索条件シートの顧客名 を解決する。
 */
function _resolveUserIdToCustomerName_(userId) {
  if (!userId) return null;
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var lu = ss.getSheetByName(LINE_USERS_SHEET_NAME);
    if (!lu) return null;
    var data = lu.getDataRange().getValues();
    var uTrim = String(userId).trim();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === uTrim) {
        return String(data[i][1] || '').trim();
      }
    }
    return null;
  } catch (e) {
    console.warn('_resolveUserIdToCustomerName_ error: ' + e.message);
    return null;
  }
}

/**
 * GASエディタから一発で実行できるヘルパー: 特定の LINE userId を
 * 空室確認テストユーザーに登録する。
 *
 * 使い方: GASエディタで右の関数選択から `addTestUserByLineId` を実行
 * (userId は関数内で書き換える)。
 */
function addTestUserByLineId() {
  var userId = 'U182d6e2fac80f959ab835cc96077e9e8';
  var result = manageAvailabilityTestUsers('add', null, userId);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Discord webhook に POST。Cloudflare 1015 / Discord 429 対策で
 * 指数バックオフリトライを実装 (SUUMO patrol と同パターン)。
 *
 * @param {string} webhookUrl
 * @param {object} payload
 * @param {number} [maxAttempts=3]
 * @return {{ok:boolean, code?:number, body?:string, attempt?:number, error?:string}}
 */
function _sendDiscordWithRetry_(webhookUrl, payload, maxAttempts) {
  maxAttempts = maxAttempts || 3;
  // wait=true で Discord が完全に処理完了するまで待つ (より正確なステータス取得)
  var postUrl = (webhookUrl.indexOf('wait=') >= 0)
    ? webhookUrl
    : (webhookUrl + (webhookUrl.indexOf('?') >= 0 ? '&' : '?') + 'wait=true');
  var lastErr = '';
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      var resp = UrlFetchApp.fetch(postUrl, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var code = resp.getResponseCode();
      var body = resp.getContentText();
      if (code >= 200 && code < 300) {
        return { ok: true, code: code, body: body, attempt: attempt };
      }
      // 429 (Discord/Cloudflare) or 5xx → リトライ
      if (code === 429 || code >= 500) {
        var headers = resp.getAllHeaders();
        var retryAfter = parseFloat(headers['Retry-After'] || headers['retry-after'] || '0');
        try {
          var bodyJson = JSON.parse(body);
          if (bodyJson && bodyJson.retry_after) retryAfter = Math.max(retryAfter, parseFloat(bodyJson.retry_after));
        } catch (_) {}
        // Cloudflare 1015 (error code: 1015) は長期制限なので待つ意味なし
        var isCloudflare1015 = (code === 429 && body.indexOf('1015') >= 0);
        if (isCloudflare1015) {
          lastErr = 'Cloudflare 1015 (長期レート制限)';
          // 1015 はリトライ無意味、即終了
          break;
        }
        var waitMs = (retryAfter > 0) ? Math.ceil(retryAfter * 1000) : 5000 * attempt;
        if (waitMs > 60000) {
          lastErr = 'HTTP ' + code + ' / wait ' + waitMs + 'ms > 60s 上限超過';
          break;
        }
        lastErr = 'HTTP ' + code + ' (リトライ ' + attempt + '/' + maxAttempts + ', wait ' + waitMs + 'ms)';
        console.log('[Discord] ' + lastErr);
        Utilities.sleep(waitMs);
        continue;
      }
      // それ以外のエラー (4xx) は致命的なのでリトライしない
      lastErr = 'HTTP ' + code + ': ' + (body || '').substring(0, 100);
      break;
    } catch (e) {
      lastErr = 'fetch error: ' + e.message;
      Utilities.sleep(2000);
    }
  }
  return { ok: false, error: lastErr };
}

/**
 * 空室確認依頼の Discord 通知用ペイロード + webhook URL を生成する。
 * GAS から直接送信せず、Chrome拡張側で送信する (Cloudflare 1015対策)。
 *
 * @return {{webhook_url:string, content:string, customer:string, source:string}|null}
 */
function _buildAvailabilityDiscordPayload_(customerName, roomId, buildingName, sourceRef, source, status, applicationStatus) {
  try {
    var props = PropertiesService.getScriptProperties();
    var webhookUrl = props.getProperty('DISCORD_WEBHOOK_AVAILABILITY_URL')
      || ((typeof DISCORD_WEBHOOK_RENT_RESEARCHER_URL !== 'undefined') ? DISCORD_WEBHOOK_RENT_RESEARCHER_URL : null)
      || props.getProperty('DISCORD_WEBHOOK_URL');
    if (!webhookUrl) return null;

    var srcLabel = (source || '').toLowerCase();
    var statusLabel = (status === 'needs_confirmation') ? '要物確・要確認' : 'REINS掲載中';
    // 申込情報がある場合はステータスラベルに追加 (例: 「要物確・要確認 (申込1件)」)
    if (applicationStatus && status === 'needs_confirmation') {
      statusLabel += ' (' + applicationStatus + ')';
    }
    var sourceDisplay = {
      reins: 'REINS', itandi: 'itandi', ielove: 'いえらぶ', essquare: 'いい生活'
    }[srcLabel] || (source || '不明');

    var propertyUrl = '';
    if (srcLabel === 'reins') {
      var num = String(sourceRef || '').replace(/[^0-9]/g, '');
      if (num) propertyUrl = 'https://system.reins.jp/main/BK/GBK004100#bukken=' + num;
    } else if (sourceRef && /^https?:\/\//.test(sourceRef)) {
      propertyUrl = sourceRef;
    }

    var webAppUrl = ScriptApp.getService().getUrl();
    var apiKey = props.getProperty('REINS_API_KEY') || '';
    function buildReplyUrl(replyStatus, badgeCount, canApply) {
      var params = [
        'action=staff_reply_availability',
        'customer=' + encodeURIComponent(customerName),
        'room_id=' + encodeURIComponent(roomId),
        'status=' + encodeURIComponent(replyStatus),
        'api_key=' + encodeURIComponent(apiKey)
      ];
      if (typeof badgeCount === 'number') params.push('badge_count=' + badgeCount);
      if (typeof canApply === 'boolean') params.push('can_apply=' + (canApply ? '1' : '0'));
      return webAppUrl + '?' + params.join('&');
    }

    var lines = [
      '🔔 **' + sourceDisplay + ' 物件 空室確認依頼** (' + statusLabel + ')',
      '顧客: ' + customerName + ' 様',
      '物件: ' + (buildingName || '(建物名不明)'),
      'room_id: ' + roomId
    ];
    if (srcLabel === 'reins' && sourceRef) lines.push('REINS物件番号: ' + sourceRef);
    // URL を <> で囲んで Discord の自動プレビュー (= 勝手にGETアクセス) を無効化
    if (propertyUrl) lines.push('📋 物件詳細を確認: <' + propertyUrl + '>');
    lines.push('');
    lines.push('→ 元付業者に電話確認のうえ、以下から状況を選択してください:');
    lines.push('🟢 [募集中(1番手で申込可)](<' + buildReplyUrl('available', 0, true) + '>)');
    lines.push('🟡 [申込あり(順番待ちで申込可)](<' + buildReplyUrl('applied', 0, true) + '>)');
    lines.push('🟠 [申込あり(キャンセル待ち通知のみ)](<' + buildReplyUrl('applied', 1, false) + '>)');
    lines.push('🔴 [募集終了](<' + buildReplyUrl('closed') + '>)');
    lines.push('');
    lines.push('※ クリック後、自動でお客さんにLINE通知されます');

    return {
      webhook_url: webhookUrl,
      content: lines.join('\n'),
      customer: customerName,
      source: source
    };
  } catch (e) {
    console.warn('[Discord payload生成] エラー: ' + e.message);
    return null;
  }
}

/**
 * 空室確認依頼を Discord に通知する。
 * お客さんが「最新の空室状況を確認」を押し、Chrome拡張がチェックして
 *   - reins_listed (REINSに掲載あり)
 *   - needs_confirmation (itandi等の「要物確」「要確認」)
 * と判定した時に呼ばれる。重複防止: 同一 顧客×roomId は1日1回まで。
 *
 * @param {string} customerName
 * @param {string} roomId
 * @param {string} buildingName
 * @param {string} sourceRef - URL or REINS物件番号
 * @param {string} [source] - 'reins' / 'itandi' / 'ielove' / 'essquare'
 * @param {string} [status] - 'reins_listed' / 'needs_confirmation'
 */
function _notifyReinsConfirmationRequestToDiscord_(customerName, roomId, buildingName, sourceRef, source, status) {
  try {
    // 専用 webhook (AVAILABILITY) を優先、なければ共通 webhook にフォールバック
    // Cloudflare が同じ webhook URL への多機能アクセスでレート制限 (1015) を課す
    // ため、空室確認は独自の webhook を持つのが安全
    var props = PropertiesService.getScriptProperties();
    var DISCORD_WEBHOOK_URL = props.getProperty('DISCORD_WEBHOOK_AVAILABILITY_URL')
      || ((typeof DISCORD_WEBHOOK_RENT_RESEARCHER_URL !== 'undefined') ? DISCORD_WEBHOOK_RENT_RESEARCHER_URL : null)
      || props.getProperty('DISCORD_WEBHOOK_URL');
    if (!DISCORD_WEBHOOK_URL) {
      console.log('[空室確認依頼] Discord webhook URL 未設定でスキップ: ' + customerName);
      return;
    }
    var srcLabel = (source || '').toLowerCase();
    var statusLabel = (status === 'needs_confirmation') ? '要物確・要確認' : 'REINS掲載中';
    var sourceDisplay = {
      reins: 'REINS',
      itandi: 'itandi',
      ielove: 'いえらぶ',
      essquare: 'いい生活'
    }[srcLabel] || (source || '不明');

    // 物件詳細URL を構築
    //   - itandi/ielove/essquare: sourceRef は物件URL
    //   - reins: sourceRef は物件番号 → REINS検索ページ + #bukken=NNNN
    var propertyUrl = '';
    if (srcLabel === 'reins') {
      var num = String(sourceRef || '').replace(/[^0-9]/g, '');
      if (num) propertyUrl = 'https://system.reins.jp/main/BK/GBK004100#bukken=' + num;
    } else if (sourceRef && /^https?:\/\//.test(sourceRef)) {
      propertyUrl = sourceRef;
    }

    // スタッフ返答用 URL (api_key付き、ステータスごと)
    var webAppUrl = ScriptApp.getService().getUrl();
    var apiKey = PropertiesService.getScriptProperties().getProperty('REINS_API_KEY') || '';
    function buildReplyUrl(replyStatus, badgeCount, canApply) {
      var params = [
        'action=staff_reply_availability',
        'customer=' + encodeURIComponent(customerName),
        'room_id=' + encodeURIComponent(roomId),
        'status=' + encodeURIComponent(replyStatus),
        'api_key=' + encodeURIComponent(apiKey)
      ];
      if (typeof badgeCount === 'number') params.push('badge_count=' + badgeCount);
      if (typeof canApply === 'boolean') params.push('can_apply=' + (canApply ? '1' : '0'));
      return webAppUrl + '?' + params.join('&');
    }

    var lines = [
      '🔔 **' + sourceDisplay + ' 物件 空室確認依頼** (' + statusLabel + ')',
      '顧客: ' + customerName + ' 様',
      '物件: ' + (buildingName || '(建物名不明)'),
      'room_id: ' + roomId
    ];
    if (srcLabel === 'reins' && sourceRef) lines.push('REINS物件番号: ' + sourceRef);
    if (propertyUrl) lines.push('📋 物件詳細を確認: ' + propertyUrl);
    lines.push('');
    lines.push('→ 元付業者に電話確認のうえ、以下から状況を選択してください:');
    lines.push('🟢 [募集中(1番手で申込可)](' + buildReplyUrl('available', 0, true) + ')');
    lines.push('🟡 [申込あり(順番待ちで申込可)](' + buildReplyUrl('applied', 0, true) + ')');
    lines.push('🟠 [申込あり(キャンセル待ち通知のみ)](' + buildReplyUrl('applied', 1, false) + ')');
    lines.push('🔴 [募集終了](' + buildReplyUrl('closed') + ')');
    lines.push('');
    lines.push('※ クリック後、自動でお客さんにLINE通知されます');

    var payload = {
      content: lines.join('\n')
    };
    // 429 / 5xx で指数バックオフリトライ (SUUMO patrol と同じパターン)
    var sendResult = _sendDiscordWithRetry_(DISCORD_WEBHOOK_URL, payload, 3);
    if (sendResult.ok) {
      console.log('[空室確認依頼] Discord通知成功: ' + customerName + ' (' + sourceDisplay + '/' + statusLabel + ') HTTP=' + sendResult.code + ' attempt=' + sendResult.attempt);
    } else {
      console.warn('[空室確認依頼] Discord通知失敗: ' + customerName + ' / ' + sendResult.error);
    }
  } catch (e) {
    console.warn('[空室確認依頼] Discord通知失敗: ' + e.message);
  }
}

/**
 * キャンセル発生をお客さんに LINE プッシュ通知する。
 * watch 中物件で空き (available or applied + canApply=true) になった時に呼ばれる。
 *
 * @param {string} customerName
 * @param {string} roomId
 * @param {string} buildingName
 * @param {string} status
 * @param {object} extras - { badgeCount, canApply, listingStatus }
 */
function _notifyCancellationOccurredToCustomer_(customerName, roomId, buildingName, status, extras) {
  extras = extras || {};
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var luSheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);
    if (!luSheet) return;
    var luData = luSheet.getDataRange().getValues();
    var userId = null;
    var nameTrim = String(customerName).trim();
    for (var i = 1; i < luData.length; i++) {
      if (String(luData[i][1]).trim() === nameTrim) {
        userId = String(luData[i][0]).trim();
        break;
      }
    }
    if (!userId) return;

    var building = buildingName || 'お部屋';
    var badgeCount = (typeof extras.badgeCount === 'number') ? extras.badgeCount : null;
    var orderText = (badgeCount !== null && badgeCount >= 0)
      ? (badgeCount + 1) + '番手'
      : '';
    var text;
    if (status === 'available') {
      text = '【キャンセル発生のお知らせ】\n\n' +
             '以前ご希望いただいていた\n' +
             '「' + building + '」にキャンセルが発生し、再び募集中となりました!\n\n' +
             (orderText ? ('現在 ' + orderText + ' でお申し込みいただけます。\n\n') : '') +
             'お申し込みをご希望の場合は、物件詳細ページの「お申し込み希望」ボタンよりお知らせください。';
    } else if (status === 'applied') {
      text = '【キャンセル発生のお知らせ】\n\n' +
             '以前ご希望いただいていた\n' +
             '「' + building + '」にキャンセルが発生し、お申し込みが可能になりました!\n\n' +
             (orderText ? ('現在 ' + orderText + ' でお申し込みいただけます。\n\n') : '') +
             'お申し込みをご希望の場合はお気軽にお声がけください。';
    } else {
      return;
    }
    if (typeof pushMessage === 'function') {
      pushMessage(userId, [{ type: 'text', text: text }]);
      console.log('[キャンセル発生LINE] 送信: ' + customerName + ' (' + status + ')');
    }
  } catch (e) {
    console.warn('[キャンセル発生LINE] エラー: ' + e.message);
  }
}

/**
 * テスト用: 任意の物件URLを指定して、Hirokiさん用に SEEN_SHEET + PENDING_SHEET に
 * 行を手動追加する。これで「空室確認を依頼する」ボタンの動作をテストできる。
 *
 * 使い方: GASエディタで関数を実行 (内部の url / source を書き換える)
 *
 * @return {{ok:boolean, viewUrl:string, message:string}}
 */
function addTestAvailabilityProperty() {
  // ↓ ここをテストしたい物件に書き換えて実行
  var customerName = 'Hiroki';
  var buildingName = 'テスト物件';
  var url = 'https://bb.ielove.jp/ielovebb/rent/detail/id/82911297/';  // 申込1件+物確不要のURL
  var source = 'ielove';   // 'itandi' / 'ielove' / 'essquare' / 'reins'
  var reinsPropNo = '';     // REINSの場合は物件番号

  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var pendingSheet = ss.getSheetByName(PENDING_SHEET_NAME);
    var seenSheet = ss.getSheetByName(SEEN_SHEET_NAME);
    if (!pendingSheet || !seenSheet) return { ok: false, message: 'シートが見つかりません' };

    var roomId = 'test_' + Date.now();
    var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

    // 最小限の property_data_json
    var dataJson = JSON.stringify({
      url: url,
      source: source,
      reins_property_number: reinsPropNo,
      building_name: buildingName,
      room_number: '',
      rent: 80000,
      management_fee: 5000,
      layout: '1K',
      area: 25,
      building_age: '築15年',
      station_info: 'テスト駅 徒歩5分',
      address: 'テスト住所',
      deposit: '1ヶ月',
      key_money: '1ヶ月',
      image_urls: []
    });

    // PENDING_SHEET (14列) に追加
    pendingSheet.appendRow([
      customerName,                    // A
      'test_building_' + roomId,       // B
      roomId,                          // C
      buildingName,                    // D
      '80000',                         // E
      '5000',                          // F
      '1K',                            // G
      '25',                            // H
      'テスト駅 徒歩5分',                // I
      dataJson,                        // J
      'sent',                          // K (sent扱い、view_apiから取得可能)
      now,                             // L (created_at)
      now,                             // M (updated_at)
      ''                                // N (view_url、空でOK)
    ]);

    // SEEN_SHEET (8列) に追加
    seenSheet.appendRow([
      customerName,                                // A
      roomId,                                      // B
      buildingName,                                // C
      now,                                          // D (sent_at)
      source,                                       // E
      '',                                           // F (current_status)
      '',                                           // G (status_checked_at)
      source === 'reins' ? reinsPropNo : url       // H (source_ref)
    ]);

    var viewUrl = 'https://form.ehomaki.com/property.html?customer=' +
                  encodeURIComponent(customerName) + '&room_id=' + roomId;

    var result = {
      ok: true,
      viewUrl: viewUrl,
      customer: customerName,
      roomId: roomId,
      message: 'テスト物件を追加しました'
    };
    Logger.log(JSON.stringify(result, null, 2));
    Logger.log('▼ このURLを開いて「空室確認を依頼する」ボタンをテスト:');
    Logger.log(viewUrl);
    return result;
  } catch (e) {
    Logger.log('エラー: ' + e.message);
    return { ok: false, message: e.message };
  }
}

/**
 * PENDING_SHEET から物件詳細を取得し、buildPropertyFlex 用の prop オブジェクトを返す。
 * 空室確認結果通知 (LINE Flex) で物件詳細をリッチに表示するために使う。
 *
 * @return {Object|null} prop形式のオブジェクト (rowToProperty相当)
 */
function _getPendingPropForFlex_(customerName, roomId) {
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
    if (!sheet) return null;
    var data = sheet.getDataRange().getValues();
    var nameTrim = String(customerName).trim();
    var ridTrim = String(roomId).trim();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() !== nameTrim) continue;
      if (String(data[i][2]).trim() !== ridTrim) continue;
      var status = String(data[i][10] || '');
      if (status !== 'sent' && status !== 'pending') continue;
      try {
        var d = JSON.parse(String(data[i][9] || ''));
        // buildPropertyFlex が期待する camelCase 形式に変換
        // 送付時に選択された画像を優先、なければ全画像にフォールバック
        var imgs = (d.selected_image_urls && d.selected_image_urls.length > 0)
          ? d.selected_image_urls : (d.image_urls || []);
        return {
          buildingName: d.building_name || '',
          roomNumber: d.room_number || '',
          rent: d.rent || 0,
          managementFee: d.management_fee || 0,
          layout: d.layout || '',
          area: d.area || 0,
          buildingAge: d.building_age || '',
          floor: d.floor || 0,
          floorText: d.floor_text || '',
          stationInfo: d.station_info || '',
          otherStations: d.other_stations || [],
          address: d.address || '',
          deposit: d.deposit || '',
          keyMoney: d.key_money || '',
          imageUrls: imgs,
          imageUrl: imgs[0] || '',
          url: d.url || '',
          reinsPropertyNumber: d.reins_property_number || ''
        };
      } catch (_) { return null; }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────
// 物件再送付機能
// ──────────────────────────────────────────────────────────────────

/**
 * 通知済み物件シートから、指定顧客の再送付候補を取得する。
 * status が available / needs_confirmation / reins_listed / 空 の物件を返す。
 */
function getSeenPropertiesForResend(customerName) {
  if (!customerName) return [];
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(SEEN_SHEET_NAME);
    if (!sheet) return [];
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    var data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
    var nameTrim = String(customerName).trim();

    // アクションログから閲覧回数・最新アクションを一括集計
    // アクションログ: [顧客名, room_id, アクション, ...] でviewも含む
    var viewCounts = {};   // roomId -> count
    var latestActions = {}; // roomId -> 最新のfeedbackアクション
    var actionSheet = ss.getSheetByName(ACTION_LOG_SHEET_NAME);
    if (actionSheet && actionSheet.getLastRow() >= 2) {
      var alData = actionSheet.getDataRange().getValues();
      for (var ai = 1; ai < alData.length; ai++) {
        if (String(alData[ai][0]).trim() !== nameTrim) continue;
        var aRid = String(alData[ai][1]).trim();
        var aType = String(alData[ai][2]).trim();
        if (aType === 'view') {
          viewCounts[aRid] = (viewCounts[aRid] || 0) + 1;
        } else if (aType === 'hold_intent') {
          // hold_intent は hold と同義、hold が未設定の場合のみ採用
          if (!latestActions[aRid]) latestActions[aRid] = 'hold';
        } else if (aType && aType !== '') {
          latestActions[aRid] = aType;
        }
      }
    }

    // 閲覧ログからも加算（旧形式対応）
    var viewLogSheet = ss.getSheetByName(VIEW_LOG_SHEET_NAME);
    if (viewLogSheet && viewLogSheet.getLastRow() >= 2) {
      var vlData = viewLogSheet.getDataRange().getValues();
      for (var vi = 1; vi < vlData.length; vi++) {
        if (String(vlData[vi][0]).trim() !== nameTrim) continue;
        var vRid = String(vlData[vi][1]).trim();
        viewCounts[vRid] = (viewCounts[vRid] || 0) + 1;
      }
    }

    var results = [];
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() !== nameTrim) continue;
      var status = String(data[i][5] || '');
      // closed / applied は除外
      if (status === 'closed' || status === 'applied') continue;
      var roomId = String(data[i][1] || '').trim();
      var pendingProp = _getPendingPropForFlex_(nameTrim, roomId);
      var entry = {
        roomId: roomId,
        buildingName: String(data[i][2] || ''),
        sentAt: (data[i][3] instanceof Date) ? Utilities.formatDate(data[i][3], 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : String(data[i][3] || ''),
        source: String(data[i][4] || ''),
        currentStatus: status,
        statusCheckedAt: (data[i][6] instanceof Date) ? Utilities.formatDate(data[i][6], 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : String(data[i][6] || ''),
        sourceRef: String(data[i][7] || ''),
        hasFullData: !!pendingProp
      };
      if (pendingProp) {
        entry.rent = pendingProp.rent || 0;
        entry.managementFee = pendingProp.managementFee || 0;
        entry.layout = pendingProp.layout || '';
        entry.area = pendingProp.area || 0;
        entry.stationInfo = pendingProp.stationInfo || '';
        entry.address = pendingProp.address || '';
        entry.buildingAge = pendingProp.buildingAge || '';
        entry.floor = pendingProp.floor || 0;
        entry.roomNumber = pendingProp.roomNumber || '';
        entry.deposit = pendingProp.deposit || '';
        entry.keyMoney = pendingProp.keyMoney || '';
        entry.imageUrl = pendingProp.imageUrl || '';
        entry.imageUrls = pendingProp.imageUrls || [];
        entry.sourceUrl = pendingProp.url || '';
        entry.reinsPropertyNumber = pendingProp.reinsPropertyNumber || '';
      }
      // sourceRefからURLをフォールバック取得（PENDINGにデータがない場合）
      if (!entry.sourceUrl && entry.sourceRef) {
        if (entry.sourceRef.indexOf('http') === 0) {
          entry.sourceUrl = entry.sourceRef;
        } else if (entry.source === 'reins' && !entry.reinsPropertyNumber) {
          entry.reinsPropertyNumber = entry.sourceRef;
        }
      }
      // 閲覧・アクション情報
      entry.viewCount = viewCounts[roomId] || 0;
      entry.viewed = entry.viewCount > 0;
      var la = latestActions[roomId] || '';
      entry.favorite = (la === 'favorite');
      entry.hold = (la === 'hold');
      entry.viewing = (la === 'viewing');
      entry.notInterested = (la === 'not_interested');
      entry.latestAction = la;
      results.push(entry);
    }
    results.sort(function(a, b) { return (b.sentAt || '').localeCompare(a.sentAt || ''); });
    return results;
  } catch (e) {
    console.warn('getSeenPropertiesForResend error: ' + e.message);
    return [];
  }
}

/**
 * 選択された物件をLINEで再送付する。
 * @param {string} customerName
 * @param {string[]} roomIds
 * @return {{ok:boolean, sent:number, failed:number, message:string}}
 */
function resendPropertyNotifications(customerName, roomIds) {
  if (!customerName || !Array.isArray(roomIds) || roomIds.length === 0) {
    return { ok: false, sent: 0, failed: 0, message: 'パラメータ不足' };
  }
  var lineUserId = findLineUserId(customerName);
  if (!lineUserId) {
    return { ok: false, sent: 0, failed: 0, message: customerName + ' のLINEユーザーが見つかりません' };
  }

  var flexBubbles = [];   // buildPropertyFlex の bubble (contents) を集める
  var textMessages = [];  // テキストフォールバック
  var failCount = 0;
  var totalCount = roomIds.length;
  var errors = [];
  var customerStations = [];
  try { customerStations = _getCustomerSelectedStations_(customerName); } catch (_) {}

  for (var i = 0; i < roomIds.length; i++) {
    var roomId = String(roomIds[i]).trim();
    var prop = _getPendingPropForFlex_(customerName, roomId);
    console.log('[resend] roomId=' + roomId + ' prop=' + (prop ? 'found' : 'null'));
    if (prop) {
      try {
        var plainUrl = ScriptApp.getService().getUrl() + '?action=property&customer=' + encodeURIComponent(customerName)
          + '&room_id=' + encodeURIComponent(roomId);
        var minimalUrl = buildMinimalViewUrl(customerName, roomId, prop);
        var viewUrl = (minimalUrl && minimalUrl.length <= 1000) ? minimalUrl : plainUrl;
        // 画像キャッシュ更新
        if (prop.imageUrls && prop.imageUrls.length > 0) {
          cachePropertyImages(customerName, roomId, prop.imageUrls, []);
        }
        var flex = buildPropertyFlex(prop, {
          includeImage: !!(prop.imageUrl),
          heroImageUrls: prop.imageUrls || [],
          viewUrl: viewUrl,
          customerStations: customerStations,
          headerTitle: '見逃していませんか？'
        });
        // flex = { type:'flex', altText:..., contents: {type:'bubble',...} }
        flexBubbles.push(flex.contents);
      } catch (eF) {
        console.warn('[resend] flex build failed for ' + roomId + ': ' + eF.message);
        errors.push(roomId + ': flex生成失敗 - ' + eF.message);
        failCount++;
      }
    } else {
      // pendingにデータがない → 建物名だけのテキストメッセージ
      errors.push(roomId + ': PENDINGデータなし（テキスト送信にフォールバック）');
      try {
        var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
        var seenSheet = ss.getSheetByName(SEEN_SHEET_NAME);
        var bName = roomId;
        if (seenSheet) {
          var sData = seenSheet.getRange(2, 1, seenSheet.getLastRow() - 1, 3).getValues();
          for (var si = 0; si < sData.length; si++) {
            if (String(sData[si][0]).trim() === customerName && String(sData[si][1]).trim() === roomId) {
              bName = String(sData[si][2] || roomId);
              break;
            }
          }
        }
        textMessages.push({ type: 'text', text: '【再送】' + bName + '\nこちらの物件は引き続き募集中です。詳細はスタッフまでお問い合わせください。' });
      } catch (eTxt) {
        errors.push(roomId + ': テキスト生成失敗 - ' + eTxt.message);
        failCount++;
      }
    }
  }

  // LINE送信: flexバブルはカルーセルにまとめる（横スワイプ可能）
  // カルーセルは最大12バブル。それ以上は複数カルーセルに分割。
  var sentCount = 0;
  var allMessages = [];

  // Flexバブル → カルーセル化（サイズ・件数上限で分割。12件だとJSONが50KB超でLINEに弾かれるため）
  var _carMsgs = _splitBubblesIntoCarousels_(flexBubbles, '見逃していませんか？');
  for (var c = 0; c < _carMsgs.length; c++) allMessages.push(_carMsgs[c]);

  // テキストフォールバックも追加
  for (var t = 0; t < textMessages.length; t++) {
    allMessages.push(textMessages[t]);
  }

  // pushMessage は1回5メッセージまで
  for (var b = 0; b < allMessages.length; b += 5) {
    var batch = allMessages.slice(b, b + 5);
    // このバッチ内のFlex物件数を数える
    var batchPropCount = 0;
    for (var bi = 0; bi < batch.length; bi++) {
      if (batch[bi].type === 'flex' && batch[bi].contents.type === 'carousel') {
        batchPropCount += batch[bi].contents.contents.length;
      } else {
        batchPropCount += 1;
      }
    }
    try {
      pushMessage(lineUserId, batch);
      sentCount += batchPropCount;
    } catch (eP) {
      console.warn('[resend] pushMessage failed: ' + eP.message + (eP.stack ? '\n' + eP.stack : ''));
      errors.push('LINE送信失敗: ' + eP.message);
      failCount += batchPropCount;
    }
  }

  return {
    ok: sentCount > 0,
    sent: sentCount,
    failed: failCount,
    message: sentCount + '件送信' + (failCount > 0 ? '、' + failCount + '件失敗' : ''),
    errors: errors.length > 0 ? errors : undefined
  };
}

/**
 * 手動検索（Chrome拡張）で選んだ物件を、指定顧客のLINEへ直接送信する。
 * PENDINGシートを介さず、拡張から受け取った物件データをその場でFlex化する。
 * カルーセル化・分割送信ロジックは resendPropertyNotifications と同じ。
 *
 * @param {string} customerName 顧客名
 * @param {Array<Object>} properties 正規化済み物件
 *        （buildingName, roomNumber, rent, managementFee, deposit, keyMoney,
 *          layout, area, buildingAge, floor, stationInfo, address,
 *          imageUrls[], imageUrl, url, source）
 * @return {{ok:boolean, sent:number, failed:number, message:string, errors?:string[]}}
 */
/**
 * 手動送信した物件を 承認待ち物件シート(PENDING_SHEET) と 通知済み物件シート(SEEN_SHEET) に
 * 通常通知と同じ列構成で記録する。これにより view_api が room_id で物件を引けるようになり、
 * 顧客向け詳細ページ(property.html)が「募集終了」にならず正しく表示される。
 * 列構成は addTestAvailabilityProperty() と同一。
 *
 * @param {string} customerName
 * @param {string} roomId   送信時に発行した一意ID（manual_<source>_<ts>_<i>）
 * @param {Object} prop      buildPropertyFlex 互換の正規化済み物件
 * @param {string[]} heroUrls 画像URL配列（正規化済み）
 */
function _recordManualPropertyRow_(customerName, roomId, prop, heroUrls) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var pendingSheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (!pendingSheet) throw new Error('承認待ち物件シートが見つかりません');
  var seenSheet = ss.getSheetByName(SEEN_SHEET_NAME);

  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  var source = prop.source || '';
  var imgs = Array.isArray(heroUrls) ? heroUrls.filter(Boolean) : [];
  var reinsNo = prop.reins_property_number || prop.reinsPropertyNumber || '';

  // J列: property_data_json（rowToProperty が snake_case で読む）
  var dataJson = JSON.stringify({
    url: prop.url || '',
    source: source,
    reins_property_number: reinsNo,
    building_name: prop.buildingName || '',
    room_number: prop.roomNumber || '',
    rent: prop.rent || 0,
    management_fee: prop.managementFee || 0,
    layout: prop.layout || '',
    area: prop.area || '',
    building_age: prop.buildingAge || '',
    floor: prop.floor || '',
    station_info: prop.stationInfo || '',
    address: prop.address || '',
    deposit: prop.deposit || '',
    key_money: prop.keyMoney || '',
    image_urls: imgs,
    image_url: imgs.length > 0 ? imgs[0] : (prop.imageUrl || '')
  });

  // PENDING_SHEET (14列) — status='sent' なので承認待ちキューには出ない
  pendingSheet.appendRow([
    customerName,                        // A 顧客名
    'manual_building_' + roomId,         // B building_id
    roomId,                              // C room_id
    prop.buildingName || '',             // D 建物名
    String(prop.rent || ''),             // E 賃料
    String(prop.managementFee || ''),    // F 管理費
    prop.layout || '',                   // G 間取り
    String(prop.area || ''),             // H 面積
    prop.stationInfo || '',              // I 駅情報
    dataJson,                            // J property_data_json
    'sent',                              // K status（view_api 取得可）
    now,                                 // L created_at
    now,                                 // M updated_at
    ''                                   // N view_url
  ]);

  // SEEN_SHEET (8列) — 空室確認の対象にもなる
  if (seenSheet) {
    var sourceRef = (source === 'reins') ? reinsNo : (prop.url || '');
    seenSheet.appendRow([
      customerName,            // A 顧客名
      roomId,                  // B room_id
      prop.buildingName || '', // C 建物名
      now,                     // D sent_at
      source,                  // E ソース
      '',                      // F current_status
      '',                      // G status_checked_at
      sourceRef                // H source_ref
    ]);
  }
}

function sendManualPropertiesToLine(customerName, properties) {
  if (!customerName || !Array.isArray(properties) || properties.length === 0) {
    return { ok: false, sent: 0, failed: 0, message: 'パラメータ不足（顧客名または物件が空）' };
  }
  var lineUserId = findLineUserId(customerName);
  if (!lineUserId) {
    return { ok: false, sent: 0, failed: 0, message: customerName + ' のLINEユーザーが見つかりません' };
  }

  // お客さん希望駅（メイン路線の昇格判定に使用）
  var customerStations = [];
  try { customerStations = _getCustomerSelectedStations_(customerName); } catch (_) {}

  var flexBubbles = [];
  var failCount = 0;
  var errors = [];

  for (var i = 0; i < properties.length; i++) {
    var prop = properties[i] || {};
    if (!prop.buildingName) { errors.push((i + 1) + '件目: 物件名なしでスキップ'); failCount++; continue; }
    try {
      // 画像URLは配列に正規化（単一 imageUrl も許容）
      var heroUrls = [];
      if (Array.isArray(prop.imageUrls)) heroUrls = prop.imageUrls.filter(Boolean);
      else if (prop.imageUrl) heroUrls = [prop.imageUrl];

      // 顧客向け詳細ページURL（通常送信と同じ form.ehomaki.com のページ）。
      // 業者向けサイトURL（prop.url）ではなく、prop の内容をエンコードした顧客用ページ。
      // 通常フロー（doApprove）と同じく hashUrl→minimalUrl→plainUrl の順でフォールバック。
      var roomId = 'manual_' + (prop.source || 'x') + '_' + Date.now() + '_' + i;
      var plainUrl = 'https://form.ehomaki.com/property.html?customer=' + encodeURIComponent(customerName) + '&room_id=' + roomId;
      var hashUrl = buildViewUrl(customerName, roomId, prop, heroUrls);
      var minimalUrl = buildMinimalViewUrl(customerName, roomId, prop);
      var viewUrl = hashUrl.length <= 1000 ? hashUrl : (minimalUrl.length <= 1000 ? minimalUrl : plainUrl);
      // 画像を property.html の非同期取得用にキャッシュ（詳細ページで全枚数表示）
      if (heroUrls.length > 0) { try { cachePropertyImages(customerName, roomId, heroUrls, []); } catch (_e) {} }

      // 通知済み物件/承認待ち物件シートに記録する。
      // これがないと view_api が room_id を見つけられず、
      // 詳細ページ(property.html)が「募集終了」になってしまう（通常通知と同じ扱いにする）。
      try { _recordManualPropertyRow_(customerName, roomId, prop, heroUrls); }
      catch (eRec) { errors.push((prop.buildingName || (i + 1) + '件目') + ': シート記録失敗 - ' + eRec.message); }

      var flex = buildPropertyFlex(prop, {
        includeImage: heroUrls.length > 0,
        heroImageUrls: heroUrls,
        viewUrl: viewUrl,
        customerStations: customerStations,
        headerTitle: 'お探しの物件が見つかりました'
      });
      flexBubbles.push(flex.contents);
    } catch (eF) {
      errors.push((prop.buildingName || (i + 1) + '件目') + ': flex生成失敗 - ' + eF.message);
      failCount++;
    }
  }

  // Flexバブル → カルーセル化（サイズ・件数上限で分割。12件だとJSONが50KB超でLINEに弾かれるため）
  var allMessages = _splitBubblesIntoCarousels_(flexBubbles, 'お探しの物件が見つかりました');

  // pushMessage は1回5メッセージまで
  var sentCount = 0;
  for (var b = 0; b < allMessages.length; b += 5) {
    var batch = allMessages.slice(b, b + 5);
    var batchPropCount = 0;
    for (var bi = 0; bi < batch.length; bi++) {
      if (batch[bi].type === 'flex' && batch[bi].contents.type === 'carousel') {
        batchPropCount += batch[bi].contents.contents.length;
      } else {
        batchPropCount += 1;
      }
    }
    try {
      pushMessage(lineUserId, batch);
      sentCount += batchPropCount;
    } catch (eP) {
      console.warn('[manual-send] pushMessage failed: ' + eP.message);
      errors.push('LINE送信失敗: ' + eP.message);
      failCount += batchPropCount;
    }
  }

  return {
    ok: sentCount > 0,
    sent: sentCount,
    failed: failCount,
    message: sentCount + '件送信' + (failCount > 0 ? '、' + failCount + '件失敗' : ''),
    errors: errors.length > 0 ? errors : undefined
  };
}

/**
 * doPost: action=send_manual_properties のハンドラ。
 * Chrome拡張の手動検索パネル（REINS・いえらぶ等）から呼ばれる。
 *
 * @param {Object} json { api_key, customer_name, properties[] }
 */
function handleSendManualProperties(json) {
  try {
    if (!_validateReinsApiKey(json.api_key)) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'invalid api_key' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var result = sendManualPropertiesToLine(json.customer_name, json.properties);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (e) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: e.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * 通知済み物件シートの J列 (10) にキャンセル通知希望時刻を記録する。
 * Chrome拡張がこのフラグを参照して、定期的にステータス変化をチェックする。
 *
 * @param {string} customerName
 * @param {string} roomId
 * @return {{ok:boolean, message:string}}
 */
function setCancellationWatch(customerName, roomId) {
  if (!customerName || !roomId) return { ok: false, message: 'customer/roomId が未指定' };
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(SEEN_SHEET_NAME);
    if (!sheet) return { ok: false, message: 'シートが見つかりません' };
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { ok: false, message: 'シートが空です' };
    var data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    var nameTrim = String(customerName).trim();
    var ridTrim = String(roomId).trim();
    var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    var updated = 0;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() === nameTrim && String(data[i][1]).trim() === ridTrim) {
        sheet.getRange(i + 2, 10).setValue(now);  // J列 (10): watch_for_cancellation_at
        updated++;
      }
    }
    return {
      ok: updated > 0,
      message: updated + '行にキャンセル通知希望を記録しました'
    };
  } catch (e) {
    return { ok: false, message: 'エラー: ' + e.message };
  }
}

/**
 * キャンセル通知希望をクリア (キャンセル発生して通知済みの場合に呼ぶ)。
 */
function clearCancellationWatch(customerName, roomId) {
  if (!customerName || !roomId) return;
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(SEEN_SHEET_NAME);
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    var nameTrim = String(customerName).trim();
    var ridTrim = String(roomId).trim();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() === nameTrim && String(data[i][1]).trim() === ridTrim) {
        sheet.getRange(i + 2, 10).setValue('');
      }
    }
  } catch (e) {
    console.warn('[clearCancellationWatch] ' + e.message);
  }
}

/**
 * 管理者が手動で空室ステータスを更新する。
 * REINS物件など自動判定できない場合に、管理画面から直接更新する。
 * キャンセル監視中の物件で available に変更された場合はキャンセル通知を送信。
 *
 * @param {string} customerName
 * @param {string} roomId
 * @param {string} status - available / applied / closed / needs_confirmation / reins_listed
 * @param {boolean|null} canApply
 * @param {number|null} badgeCount
 * @return {{ok: boolean, message: string}}
 */
function manualUpdateAvailabilityStatus(customerName, roomId, status, canApply, badgeCount) {
  if (!customerName || !roomId) return { ok: false, message: 'customer/roomId が未指定' };
  var validStatuses = ['available', 'applied', 'closed', 'reins_listed', 'needs_confirmation'];
  if (validStatuses.indexOf(status) < 0) return { ok: false, message: '不正なstatus: ' + status };
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(SEEN_SHEET_NAME);
    if (!sheet) return { ok: false, message: 'シートが見つかりません' };
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { ok: false, message: 'シートが空です' };
    // A〜J列を読む (C列=建物名, J列=キャンセル監視)
    var data = sheet.getRange(2, 1, lastRow - 1, 10).getValues();
    var nameTrim = String(customerName).trim();
    var ridTrim = String(roomId).trim();
    var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    var updated = 0;
    var cancellationNotified = false;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() === nameTrim && String(data[i][1]).trim() === ridTrim) {
        var rowNum = i + 2;
        var buildingName = String(data[i][2] || '');
        var wasWatching = !!data[i][9]; // J列: キャンセル監視中か

        sheet.getRange(rowNum, 6).setValue(status);         // F列: status
        sheet.getRange(rowNum, 7).setValue(now);             // G列: checked_at
        if (typeof canApply === 'boolean') {
          sheet.getRange(rowNum, 11).setValue(canApply ? 'TRUE' : 'FALSE');  // K列
        }
        if (typeof badgeCount === 'number' && badgeCount >= 0) {
          sheet.getRange(rowNum, 12).setValue(badgeCount);   // L列
        } else {
          sheet.getRange(rowNum, 12).setValue('');
        }
        // M列: 手動更新の場合はクリア
        sheet.getRange(rowNum, 13).setValue('');

        // キャンセル通知: 監視中の物件で available に変更 or applied+canApply に変更
        if (wasWatching && !cancellationNotified) {
          var isCancellation = (status === 'available') ||
            (status === 'applied' && canApply === true);
          if (isCancellation) {
            try {
              var extras = { canApply: canApply, badgeCount: badgeCount };
              _notifyCancellationOccurredToCustomer_(nameTrim, ridTrim, buildingName, status, extras);
              sheet.getRange(rowNum, 10).setValue(''); // J列クリア
              cancellationNotified = true;
              console.log('[手動更新] キャンセル通知送信: ' + nameTrim);
            } catch (eC) {
              console.warn('[手動更新] キャンセル通知失敗: ' + eC.message);
            }
          }
        }
        updated++;
      }
    }
    if (status === 'closed' && updated > 0) {
      // closed の場合は行を削除（通常の自動処理と同じ動き）
      for (var j = data.length - 1; j >= 0; j--) {
        if (String(data[j][0]).trim() === nameTrim && String(data[j][1]).trim() === ridTrim) {
          sheet.deleteRow(j + 2);
        }
      }
      return { ok: true, message: '募集終了として削除しました' };
    }
    return { ok: updated > 0, message: updated > 0 ? 'ステータスを更新しました' : '該当物件が見つかりません' };
  } catch (e) {
    return { ok: false, message: 'エラー: ' + e.message };
  }
}

/**
 * 管理画面用: 通知済み物件の一覧を返す（手動更新のドロップダウン用）
 * @return {Array<{customer: string, roomId: string, building: string, source: string, status: string}>}
 */
function listSeenProperties() {
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(SEEN_SHEET_NAME);
    if (!sheet) return [];
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    var data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
    var result = [];
    for (var i = 0; i < data.length; i++) {
      result.push({
        customer: String(data[i][0] || ''),
        roomId: String(data[i][1] || ''),
        building: String(data[i][2] || ''),
        source: String(data[i][4] || ''),
        status: String(data[i][5] || ''),
        checkedAt: data[i][6] ? String(data[i][6]) : ''
      });
    }
    return result;
  } catch (e) {
    console.warn('[listSeenProperties] ' + e.message);
    return [];
  }
}

/**
 * 空室確認結果をお客さんに LINE プッシュ通知する。
 * 自動で確定できるステータス (available / applied / closed) のみが対象。
 *   - reins_listed / needs_confirmation はスタッフが手動で連絡するため対象外
 *
 * 重複防止: 同一 顧客×roomId×日付 は1回のみ
 *
 * @param {string} customerName
 * @param {string} roomId
 * @param {string} buildingName
 * @param {'available'|'applied'|'closed'} status
 */
function _notifyAvailabilityResultToCustomer_(customerName, roomId, buildingName, status, extras) {
  extras = extras || {};
  try {
    // 顧客 → LINE userId を解決
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var luSheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);
    if (!luSheet) {
      console.warn('[空室結果LINE] LINE_USERSシートが見つかりません');
      return;
    }
    var luData = luSheet.getDataRange().getValues();
    var userId = null;
    var nameTrim = String(customerName).trim();
    for (var i = 1; i < luData.length; i++) {
      if (String(luData[i][1]).trim() === nameTrim) {
        userId = String(luData[i][0]).trim();
        break;
      }
    }
    if (!userId) {
      console.warn('[空室結果LINE] userIdが見つかりません: ' + customerName);
      return;
    }

    // [テスト中] 重複防止は無効化。本番運用時は再度有効化
    //   var props = PropertiesService.getScriptProperties();
    //   var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    //   var dedupKey = 'avail_line_' + customerName + '|' + roomId + '|' + today;
    //   if (props.getProperty(dedupKey)) { ... return; }

    // ステータスごとの文言 + 番手情報
    var building = buildingName || 'お部屋';
    var badgeCount = (typeof extras.badgeCount === 'number') ? extras.badgeCount : null;
    var canApply = (typeof extras.canApply === 'boolean') ? extras.canApply : null;
    var listingStatus = extras.listingStatus || '';
    // 番手 = バッジ + 1 (バッジ取得できた場合)
    var orderText = (badgeCount !== null && badgeCount >= 0)
      ? (badgeCount + 1) + '番手'
      : '';
    var text;
    switch (status) {
      case 'available':
        // 募集中。バッジ取得状況で文言切り分け
        if (orderText && badgeCount >= 1) {
          // バッジあり = 既にお申し込み予約者がいる (テキスト)
          text = '【空室状況のご連絡】\n\n' +
                 '「' + building + '」はお申し込みが入っていますが、\n' +
                 '現在 ' + orderText + ' でお申し込みいただけます。\n\n' +
                 'お申し込みをご希望の場合は、物件詳細ページの「お申し込み希望」ボタンよりお知らせください。';
        } else if (orderText) {
          // バッジ0 = 完全空き → リッチな Flex メッセージ (物件詳細 + 申込ボタン)
          var propUrlAvail = 'https://form.ehomaki.com/property.html?customer=' +
                              encodeURIComponent(customerName) + '&room_id=' + encodeURIComponent(roomId);
          var applyUrlAvail = propUrlAvail + '&apply=1';
          var propDataForFlex = _getPendingPropForFlex_(customerName, roomId);
          if (propDataForFlex && typeof buildPropertyFlex === 'function') {
            var availFlex = buildPropertyFlex(propDataForFlex, {
              viewUrl: propUrlAvail,
              headerTitle: '空室確認の結果',
              headerColor: '#6ea814',
              statusBadge: {
                text: '募集中',
                color: '#6ea814',
                subText: 'お申し込みいただけます。'
              },
              customFooterButtons: [
                { label: 'お申し込みを希望する', uri: applyUrlAvail, style: 'primary', color: '#6ea814' },
                { label: '物件詳細を見る', uri: propUrlAvail, style: 'secondary' }
              ]
            });
            if (typeof pushMessage === 'function') {
              pushMessage(userId, [availFlex]);
              console.log('[空室結果LINE] リッチFlex送信成功 (available/完全空き): ' + customerName);
            }
            return;
          }
          // フォールバック: 物件詳細取得失敗時はシンプルテキスト
          text = '【空室状況のご連絡】\n\n' +
                 '「' + building + '」は現在も募集中です。\n\n' +
                 'お申し込みご希望の場合は以下のURLからどうぞ:\n' +
                 applyUrlAvail;
        } else {
          // バッジ取得できない (itandi以外) は従来通り
          text = '【空室状況のご連絡】\n\n' +
                 '「' + building + '」は現在も募集中でした！\n\n' +
                 'お申し込みをご希望の場合は、物件詳細ページの「お申し込み希望」ボタンよりお知らせください。';
        }
        break;
      case 'applied': {
        // applied: バッジ数・canApply で4パターンに分岐
        var propDataApp = _getPendingPropForFlex_(customerName, roomId);
        var propUrlApp = 'https://form.ehomaki.com/property.html?customer=' +
                         encodeURIComponent(customerName) + '&room_id=' + encodeURIComponent(roomId);
        var applyUrlApp = propUrlApp + '&apply=1';
        var watchPostback = 'action=availability_watch_cancellation&customer=' +
                            encodeURIComponent(customerName) + '&room_id=' + encodeURIComponent(roomId);
        var statusBadgeApp = null;
        var footerBtnsApp = [];
        if (canApply === false) {
          // 🟠 申込あり (キャンセル待ち登録不可だが、キャンセル発生時に通知できる)
          statusBadgeApp = {
            text: '申込あり',
            color: '#f59e0b',
            subText: '現在お申し込みが入っております。キャンセルが発生した際にご通知できます。'
          };
          footerBtnsApp = [
            { label: 'キャンセル通知を希望する', postbackData: watchPostback, style: 'primary', color: '#6ea814' },
            { label: '物件詳細を見る', uri: propUrlApp, style: 'secondary' }
          ];
        } else if (orderText && badgeCount !== null && badgeCount >= 1) {
          // 🟡 N+1番手で申込可
          statusBadgeApp = {
            text: orderText + 'で申込可',
            color: '#f59e0b',
            subText: '現在お申し込みが入っていますが、' + orderText + 'でのお申し込みが可能です。'
          };
          footerBtnsApp = [
            { label: 'お申し込みを希望する', uri: applyUrlApp, style: 'primary', color: '#6ea814' },
            { label: '物件詳細を見る', uri: propUrlApp, style: 'secondary' }
          ];
        } else {
          // 🟡 順番待ち (badgeCount=0 or null、 canApply !== false)
          statusBadgeApp = {
            text: '順番待ちで申込可',
            color: '#f59e0b',
            subText: '現在お申し込みが入っていますが、順番待ちでのお申し込みが可能です。'
          };
          footerBtnsApp = [
            { label: 'お申し込みを希望する', uri: applyUrlApp, style: 'primary', color: '#6ea814' },
            { label: '物件詳細を見る', uri: propUrlApp, style: 'secondary' }
          ];
        }
        if (propDataApp && typeof buildPropertyFlex === 'function') {
          var flexApp = buildPropertyFlex(propDataApp, {
            viewUrl: propUrlApp,
            headerTitle: '空室確認の結果',
            headerColor: '#f59e0b',
            statusBadge: statusBadgeApp,
            customFooterButtons: footerBtnsApp
          });
          if (typeof pushMessage === 'function') {
            pushMessage(userId, [flexApp]);
            console.log('[空室結果LINE] リッチFlex送信成功 (applied): ' + customerName + ' badge=' + (statusBadgeApp && statusBadgeApp.text));
          }
          return;
        }
        // フォールバックテキスト
        if (canApply === false) {
          text = '【空室状況のご連絡】\n\n' +
                 '「' + building + '」は現在お申し込みが入っており、追加のお申し込みはお受けできない状態です。\n\n' +
                 'キャンセル通知をご希望の場合はお気軽にお声がけください。';
        } else if (orderText && badgeCount >= 1) {
          text = '【空室状況のご連絡】\n\n' +
                 '「' + building + '」は ' + orderText + ' でお申し込みいただけます。\n\n' +
                 'ご希望の場合は物件詳細ページの「お申し込み希望」ボタンよりお知らせください。';
        } else if (listingStatus === '申込あり' && badgeCount === 0) {
          text = '【空室状況のご連絡】\n\n' +
                 '「' + building + '」は順番待ちでお申し込みいただけます。\n\n' +
                 'ご希望の場合はお気軽にお声がけください。';
        } else {
          text = '【空室状況のご連絡】\n\n' +
                 '「' + building + '」はお申し込みが入っているようです。\n\n' +
                 'キャンセル待ちのご相談も可能です。';
        }
        break;
      }
      case 'closed': {
        // 🔴 募集終了 → リッチFlex (赤いヘッダー・赤バッジ、 詳細ボタンのみ)
        var propDataC = _getPendingPropForFlex_(customerName, roomId);
        var propUrlC = 'https://form.ehomaki.com/property.html?customer=' +
                       encodeURIComponent(customerName) + '&room_id=' + encodeURIComponent(roomId);
        if (propDataC && typeof buildPropertyFlex === 'function') {
          var flexC = buildPropertyFlex(propDataC, {
            viewUrl: propUrlC,
            headerTitle: '空室確認の結果',
            headerColor: '#dc2626',
            statusBadge: {
              text: '募集終了',
              color: '#dc2626',
              subText: '申し訳ございません、募集を終了しておりました。似たような条件のお部屋が出てきましたら改めてご案内いたします。'
            },
            customFooterButtons: [
              { label: '物件詳細を見る', uri: propUrlC, style: 'secondary' }
            ]
          });
          if (typeof pushMessage === 'function') {
            pushMessage(userId, [flexC]);
            console.log('[空室結果LINE] リッチFlex送信成功 (closed): ' + customerName);
          }
          return;
        }
        text = '【空室状況のご連絡】\n\n' +
               '「' + building + '」は申し訳ございません、募集を終了しておりました。\n\n' +
               '似たような条件のお部屋が出てきましたら、改めてご案内いたします。';
        break;
      }
      default:
        return;
    }

    // LINE プッシュメッセージ送信 (LineApi.js の pushMessage を使用)
    if (typeof pushMessage === 'function') {
      pushMessage(userId, [{ type: 'text', text: text }]);
      // [テスト中] 重複防止 props.setProperty(dedupKey, '1') は無効化
      console.log('[空室結果LINE] 送信成功: ' + customerName + ' (' + status + ')');
    } else {
      console.warn('[空室結果LINE] pushMessage 関数が未定義');
    }
  } catch (e) {
    console.warn('[空室結果LINE] エラー: ' + e.message);
  }
}

/**
 * お客さんからの「最新の空室状況を確認」リクエスト。
 * 該当行の I列 priority_requested_at に現在時刻を記録する。
 * Chrome 拡張が定期ポーリングで優先キューを取得して即実行する。
 *
 * @param {string} customerName
 * @param {string} roomId
 * @return {{ok: boolean, message: string}}
 */
function requestPriorityAvailabilityCheck(customerName, roomId) {
  if (!customerName || !roomId) return { ok: false, message: 'customer/roomId が未指定' };
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(SEEN_SHEET_NAME);
    if (!sheet) return { ok: false, message: 'シートが見つかりません' };
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { ok: false, message: 'シートが空です' };
    var data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    var nameTrim = String(customerName).trim();
    var ridTrim = String(roomId).trim();
    var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    var updated = 0;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() === nameTrim && String(data[i][1]).trim() === ridTrim) {
        sheet.getRange(i + 2, 9).setValue(now);  // I列 (9): priority_requested_at
        updated++;
      }
    }
    return {
      ok: updated > 0,
      message: updated + '行に優先確認依頼を記録しました',
      requestedAt: now
    };
  } catch (e) {
    return { ok: false, message: 'エラー: ' + e.message };
  }
}

/**
 * 再送付前の空室確認: 指定 room_id 群の I列 priority_requested_at に現在時刻を記録し、
 * Chrome拡張の優先キュー(1分毎ポーリング)で「その顧客の物件だけ」オンデマンド確認させる。
 * roomIds が空なら、その顧客の通知済み物件すべてを対象にする。
 * @param {string} customerName
 * @param {string[]} roomIds
 * @return {{ok:boolean, queued:number, message:string}}
 */
function requestVacancyCheckForResend(customerName, roomIds) {
  if (!customerName) return { ok: false, queued: 0, message: '顧客名が未指定' };
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(SEEN_SHEET_NAME);
    if (!sheet) return { ok: false, queued: 0, message: 'シートが見つかりません' };
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { ok: false, queued: 0, message: 'シートが空です' };
    var data = sheet.getRange(2, 1, lastRow - 1, 2).getValues(); // A:顧客名, B:room_id
    var nameTrim = String(customerName).trim();
    var idSet = {};
    var hasFilter = Array.isArray(roomIds) && roomIds.length > 0;
    if (hasFilter) { for (var k = 0; k < roomIds.length; k++) idSet[String(roomIds[k]).trim()] = true; }
    var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    var queued = 0;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() !== nameTrim) continue;
      if (hasFilter && !idSet[String(data[i][1]).trim()]) continue;
      sheet.getRange(i + 2, 9).setValue(now); // I列(9): priority_requested_at
      queued++;
    }
    return { ok: queued > 0, queued: queued, message: queued + '件を空室確認キューに入れました' };
  } catch (e) {
    return { ok: false, queued: 0, message: 'エラー: ' + e.message };
  }
}

/**
 * 物件1件の現在の空室ステータスを取得する。
 * お客さんが property.html でポーリングするための API。
 *
 * @param {string} customerName
 * @param {string} roomId
 * @return {{found:boolean, currentStatus:string, statusCheckedAt:string,
 *           priorityRequestedAt:string, source:string}}
 */
function getAvailabilityStatus(customerName, roomId) {
  if (!customerName || !roomId) return { found: false, error: 'customer/roomId が未指定' };
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(SEEN_SHEET_NAME);
    if (!sheet) return { found: false, error: 'シートが見つかりません' };
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { found: false };
    var data = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
    var nameTrim = String(customerName).trim();
    var ridTrim = String(roomId).trim();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() !== nameTrim) continue;
      if (String(data[i][1]).trim() !== ridTrim) continue;
      var checkedRaw = data[i][6];
      var checkedAtStr = (checkedRaw instanceof Date)
        ? Utilities.formatDate(checkedRaw, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
        : String(checkedRaw || '');
      var priorityRaw = data[i][8];
      var priorityAtStr = (priorityRaw instanceof Date)
        ? Utilities.formatDate(priorityRaw, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
        : String(priorityRaw || '');
      return {
        found: true,
        currentStatus: String(data[i][5] || ''),
        statusCheckedAt: checkedAtStr,
        priorityRequestedAt: priorityAtStr,
        source: String(data[i][4] || '')
      };
    }
    return { found: false };
  } catch (e) {
    return { found: false, error: e.message };
  }
}

/**
 * 通知済み物件・承認待ち物件のうち、一定期間 (デフォルト 30 日) より古い行を削除する。
 *   - 通知済み物件 (SEEN_SHEET): D列 (sent_at) を基準
 *   - 承認待ち物件 (PENDING_SHEET): L列 (created_at, index 11) を基準
 *
 * 空室確認キューにも自動的に乗らなくなるので、対象が無限に貯まるのを防ぐ。
 *
 * @param {number} [maxAgeDays=30]
 * @return {{seen:number, pending:number, cutoff:string}}
 */
function cleanupOldPropertyRecords(maxAgeDays) {
  maxAgeDays = (typeof maxAgeDays === 'number' && maxAgeDays > 0) ? maxAgeDays : 30;
  var nowMs = Date.now();
  var cutoffMs = nowMs - maxAgeDays * 24 * 60 * 60 * 1000;
  var cutoffStr = Utilities.formatDate(new Date(cutoffMs), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  var result = { seen: 0, pending: 0, cutoff: cutoffStr, maxAgeDays: maxAgeDays };

  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);

    // ── SEEN_SHEET (通知済み物件): D列 (index 3) = sent_at ──
    var seen = ss.getSheetByName(SEEN_SHEET_NAME);
    if (seen) {
      var sLast = seen.getLastRow();
      if (sLast >= 2) {
        var sentValues = seen.getRange(2, 4, sLast - 1, 1).getValues();
        var sRows = [];
        for (var i = 0; i < sentValues.length; i++) {
          var t = _parseDateFlexible_(sentValues[i][0]);
          if (t > 0 && t < cutoffMs) sRows.push(i + 2);
        }
        // 下から削除しないと行番号がずれる
        for (var j = sRows.length - 1; j >= 0; j--) {
          seen.deleteRow(sRows[j]);
        }
        result.seen = sRows.length;
      }
    }

    // ── PENDING_SHEET (承認待ち物件): L列 (index 11) = created_at ──
    var pend = ss.getSheetByName(PENDING_SHEET_NAME);
    if (pend) {
      var pLast = pend.getLastRow();
      if (pLast >= 2) {
        var pCreated = pend.getRange(2, 12, pLast - 1, 1).getValues();
        var pRows = [];
        for (var k = 0; k < pCreated.length; k++) {
          var pt = _parseDateFlexible_(pCreated[k][0]);
          if (pt > 0 && pt < cutoffMs) pRows.push(k + 2);
        }
        for (var m = pRows.length - 1; m >= 0; m--) {
          pend.deleteRow(pRows[m]);
        }
        result.pending = pRows.length;
      }
    }

    console.log('[cleanup-old] ' + JSON.stringify(result));

    // 続けて配信停止/ブロック/手動削除 顧客の物件も一括削除 (1週間経過)
    try {
      var inactiveResult = cleanupInactiveCustomerProperties(7);
      result.inactive = inactiveResult;
    } catch (eIn) {
      console.warn('cleanupInactiveCustomerProperties chained error: ' + eIn.message);
    }

    return result;
  } catch (e) {
    console.warn('cleanupOldPropertyRecords error: ' + e.message);
    result.error = e.message;
    return result;
  }
}

/**
 * 配信停止 / ブロック / 検索条件シートから削除 された顧客の物件を一括削除する。
 *
 * 削除対象 (いずれも 1 週間 = maxAgeDays 日経過後):
 *   1. status='paused' or 'blocked' で U列(停止日時)が maxAgeDays 日以上前
 *   2. 検索条件シートから手動削除されてから maxAgeDays 日以上経過した顧客
 *      (孤立顧客の初検出時刻は ScriptProperties に記録、再登録されたら消去)
 *
 * snoozed は対象外 (自動復活が予定されているので残す)。
 *
 * @param {number} [maxAgeDays=7]
 * @return {{deletedSeenRows:number, deletedPendingRows:number, customers:string[]}}
 */
function cleanupInactiveCustomerProperties(maxAgeDays) {
  maxAgeDays = (typeof maxAgeDays === 'number' && maxAgeDays > 0) ? maxAgeDays : 7;
  var nowMs = Date.now();
  var cutoffMs = nowMs - maxAgeDays * 24 * 60 * 60 * 1000;
  var ORPHAN_KEY = 'orphan_customers_tracking_v1';
  var result = {
    deletedSeenRows: 0,
    deletedPendingRows: 0,
    customers: [],
    orphansPending: [],
    maxAgeDays: maxAgeDays
  };

  try {
    // 1. 検索条件シートから「削除すべき顧客」のセットを構築
    var critSs = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var critSheet = critSs.getSheetByName(CRITERIA_SHEET_NAME);
    if (!critSheet) {
      result.error = 'no_criteria_sheet';
      return result;
    }
    var critData = critSheet.getDataRange().getValues();
    var existingCustomers = {};          // 検索条件シートに存在する顧客名
    var toDeleteCustomers = {};          // 1週間経過 paused/blocked
    for (var ci = 1; ci < critData.length; ci++) {
      var cname = String(critData[ci][1] || '').trim();  // B列
      if (!cname) continue;
      existingCustomers[cname] = true;
      var cstatus = String(critData[ci][18] || '').trim();  // S列 (19) = index 18
      if (cstatus !== 'paused' && cstatus !== 'auto_paused' && cstatus !== 'blocked') continue;
      var ctsRaw = critData[ci][20];  // U列 (21) = index 20
      var cts = _parseDateFlexible_(ctsRaw);
      if (!cts) {
        // タイムスタンプ未記録 → 現時点を起点に書き込み (次サイクルで判定)
        try {
          critSheet.getRange(ci + 1, 21).setValue(new Date());
        } catch (_) {}
        continue;
      }
      if (cts < cutoffMs) {
        toDeleteCustomers[cname] = { reason: cstatus, stoppedAt: ctsRaw };
      }
    }

    // 1-b. 孤立顧客 (検索条件シート不在) の追跡
    //   - 初検出時刻を ScriptProperties に記録
    //   - 1週間経過 → 削除対象に追加
    //   - 検索条件シートに戻った顧客 → トラッキングから削除
    var props = PropertiesService.getScriptProperties();
    var orphanMap = {};
    try {
      var raw = props.getProperty(ORPHAN_KEY);
      if (raw) orphanMap = JSON.parse(raw);
    } catch (_) { orphanMap = {}; }
    // 既知の orphan が criteria シートに復活していたら除外
    for (var ok in orphanMap) {
      if (existingCustomers[ok]) delete orphanMap[ok];
    }

    // 2. 物件シートを走査して該当顧客の行を削除
    var propSs = SpreadsheetApp.openById(SPREADSHEET_ID);

    // 先に SEEN + PENDING の顧客名を一度集めて孤立顧客を更新
    var allCustomers = {};
    var seen = propSs.getSheetByName(SEEN_SHEET_NAME);
    var pend = propSs.getSheetByName(PENDING_SHEET_NAME);
    if (seen) {
      var sLast0 = seen.getLastRow();
      if (sLast0 >= 2) {
        var sNamesAll = seen.getRange(2, 1, sLast0 - 1, 1).getValues();
        for (var sa = 0; sa < sNamesAll.length; sa++) {
          var snm = String(sNamesAll[sa][0] || '').trim();
          if (snm) allCustomers[snm] = true;
        }
      }
    }
    if (pend) {
      var pLast0 = pend.getLastRow();
      if (pLast0 >= 2) {
        var pNamesAll = pend.getRange(2, 1, pLast0 - 1, 1).getValues();
        for (var pa = 0; pa < pNamesAll.length; pa++) {
          var pnm = String(pNamesAll[pa][0] || '').trim();
          if (pnm) allCustomers[pnm] = true;
        }
      }
    }
    // 孤立顧客 (物件シートにあるが criteria に無い) を検出
    for (var aname in allCustomers) {
      if (existingCustomers[aname]) continue;
      if (toDeleteCustomers[aname]) continue;  // すでに paused/blocked 経路で削除予定
      if (!orphanMap[aname]) {
        // 初検出: タイムスタンプ記録
        orphanMap[aname] = nowMs;
        result.orphansPending.push(aname);
      } else if (orphanMap[aname] < cutoffMs) {
        // 1週間経過 → 削除対象に追加
        toDeleteCustomers[aname] = { reason: 'orphan', detectedAt: new Date(orphanMap[aname]).toISOString() };
        delete orphanMap[aname];
      } else {
        result.orphansPending.push(aname);
      }
    }
    // 更新した orphanMap を保存
    try {
      props.setProperty(ORPHAN_KEY, JSON.stringify(orphanMap));
    } catch (_) {}

    function shouldDeleteCustomer(name) {
      if (!name) return false;
      return !!toDeleteCustomers[name];
    }

    // 2-1. SEEN_SHEET (通知済み物件): A列 = 顧客名
    if (seen) {
      var sLast = seen.getLastRow();
      if (sLast >= 2) {
        var sNames = seen.getRange(2, 1, sLast - 1, 1).getValues();
        var sRows = [];
        for (var i = 0; i < sNames.length; i++) {
          var sn = String(sNames[i][0] || '').trim();
          if (shouldDeleteCustomer(sn)) {
            sRows.push(i + 2);
            if (result.customers.indexOf(sn) < 0) result.customers.push(sn);
          }
        }
        for (var j = sRows.length - 1; j >= 0; j--) {
          seen.deleteRow(sRows[j]);
        }
        result.deletedSeenRows = sRows.length;
      }
    }

    // 2-2. PENDING_SHEET (承認待ち物件): A列 = 顧客名
    if (pend) {
      var pLast = pend.getLastRow();
      if (pLast >= 2) {
        var pNames = pend.getRange(2, 1, pLast - 1, 1).getValues();
        var pRows = [];
        for (var k = 0; k < pNames.length; k++) {
          var pn = String(pNames[k][0] || '').trim();
          if (shouldDeleteCustomer(pn)) {
            pRows.push(k + 2);
            if (result.customers.indexOf(pn) < 0) result.customers.push(pn);
          }
        }
        for (var m = pRows.length - 1; m >= 0; m--) {
          pend.deleteRow(pRows[m]);
        }
        result.deletedPendingRows = pRows.length;
      }
    }

    console.log('[cleanup-inactive] ' + JSON.stringify(result));
    return result;
  } catch (e) {
    console.warn('cleanupInactiveCustomerProperties error: ' + e.message);
    result.error = e.message;
    return result;
  }
}

/**
 * 日次クリーンアップトリガーから呼ばれるラッパ。
 * cleanupOldPropertyRecords (30日) + cleanupInactiveCustomerProperties (7日) を順番に実行。
 */
function runDailyCleanup() {
  var r1 = cleanupOldPropertyRecords(30);
  var r2 = cleanupInactiveCustomerProperties(7);
  console.log('[daily-cleanup] old=' + JSON.stringify(r1) + ' inactive=' + JSON.stringify(r2));
  return { old: r1, inactive: r2 };
}

/**
 * 日次クリーンアップトリガーを登録 (既に登録済みならスキップ)。
 * 毎朝 03:00 JST に cleanupOldPropertyRecords() を実行。
 *
 * 初回は手動で呼ぶか、bootstrap 経由で自動登録される。
 *
 * @return {{ok:boolean, message:string}}
 */
function registerCleanupTriggerIfMissing() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'cleanupOldPropertyRecords') {
        return { ok: true, message: '既に登録済みです' };
      }
    }
    ScriptApp.newTrigger('cleanupOldPropertyRecords')
      .timeBased()
      .atHour(3)
      .everyDays(1)
      .create();
    return { ok: true, message: '日次クリーンアップトリガー (毎朝3時) を登録しました' };
  } catch (e) {
    return { ok: false, message: 'トリガー登録失敗: ' + e.message };
  }
}

/**
 * 顧客の送付済み物件一覧 + 各物件の空室状況を返す。
 * 顧客の履歴ページや管理者の再送UIで使う。
 *
 * @param {string} customerName
 * @return {Array<{roomId, buildingName, sentAt, source, currentStatus, statusCheckedAt}>}
 */
function getCustomerSentPropertiesWithStatus(customerName) {
  if (!customerName) return [];
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(SEEN_SHEET_NAME);
    if (!sheet) return [];
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    var data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
    var out = [];
    var nameTrim = String(customerName).trim();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0] || '').trim() !== nameTrim) continue;
      out.push({
        roomId: String(data[i][1] || ''),
        buildingName: String(data[i][2] || ''),
        sentAt: String(data[i][3] || ''),
        source: String(data[i][4] || ''),
        currentStatus: String(data[i][5] || ''),
        statusCheckedAt: String(data[i][6] || '')
      });
    }
    // 新しい送付順
    out.sort(function(a, b) { return (b.sentAt || '').localeCompare(a.sentAt || ''); });
    return out;
  } catch (e) {
    console.warn('getCustomerSentPropertiesWithStatus error: ' + e.message);
    return [];
  }
}

/**
 * 通知済み物件シートのソース列 (E列) が空欄の行をバックフィル。
 * 承認待ち物件シートの J列 property_data_json から source を取得し、
 * 見つからなければ 'reins' をデフォルトとして書き込む。
 *
 * @param {string} [customerFilter] - 指定顧客のみ処理 (空・undefined なら全顧客)
 * @return {{updated: number, sourceCounts: Object, message: string}}
 */
function backfillSeenSheetSource(customerFilter) {
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var pendingSheet = ss.getSheetByName(PENDING_SHEET_NAME);
    var seenSheet = ss.getSheetByName(SEEN_SHEET_NAME);
    if (!pendingSheet) return { updated: 0, message: '承認待ち物件シートが見つかりません' };
    if (!seenSheet) return { updated: 0, message: '通知済み物件シートが見つかりません' };

    var filterName = customerFilter ? String(customerFilter).trim() : '';
    var hasFilter = !!filterName;

    // 1. 承認待ち物件から (customer|roomId) → {source, url, reinsPropNo} のマップを作成
    var pendingData = pendingSheet.getDataRange().getValues();
    var infoMap = {};
    for (var i = 1; i < pendingData.length; i++) {
      var pCustomer = String(pendingData[i][0] || '').trim();
      var pRoomId = String(pendingData[i][2] || '').trim();
      if (!pCustomer || !pRoomId) continue;
      if (hasFilter && pCustomer !== filterName) continue;
      var jsonStr = String(pendingData[i][9] || '');
      var pSource = '';
      var pUrl = '';
      var pReinsNo = '';
      try {
        var parsed = JSON.parse(jsonStr);
        if (parsed) {
          if (parsed.source) pSource = String(parsed.source);
          if (parsed.url) pUrl = String(parsed.url);
          if (parsed.reins_property_number) pReinsNo = String(parsed.reins_property_number);
        }
      } catch (_) {}
      if (pSource || pUrl || pReinsNo) {
        infoMap[pCustomer + '|' + pRoomId] = { source: pSource, url: pUrl, reinsPropNo: pReinsNo };
      }
    }

    // 2. 通知済み物件 のソース列(E) / H列(URL or REINS物件番号) 空欄行をバックフィル
    var seenLastRow = seenSheet.getLastRow();
    if (seenLastRow < 2) return { updated: 0, message: '通知済み物件シートが空です' };
    // 8列 (顧客/room_id/建物名/通知日時/ソース/状態/確認日時/参照値)
    var seenData = seenSheet.getRange(2, 1, seenLastRow - 1, 8).getValues();
    var rowsToUpdate = [];
    var counts = {};
    var refBackfilled = 0;
    for (var j = 0; j < seenData.length; j++) {
      var sCustomer = String(seenData[j][0] || '').trim();
      if (hasFilter && sCustomer !== filterName) continue;
      var sRoomId = String(seenData[j][1] || '').trim();
      var existingSource = String(seenData[j][4] || '').trim();
      var existingRef = String(seenData[j][7] || '').trim();
      var info = infoMap[sCustomer + '|' + sRoomId] || {};
      var srcDeterm = existingSource || info.source || 'reins';
      // REINS の場合は物件番号、それ以外は URL を H列に
      var inferredRef = (srcDeterm === 'reins')
        ? (info.reinsPropNo || info.url || '')
        : (info.url || '');
      var needSource = !existingSource;
      var needRef = !existingRef && !!inferredRef;
      if (!needSource && !needRef) continue;
      var newSource = needSource ? srcDeterm : null;
      var newRef = needRef ? inferredRef : null;
      rowsToUpdate.push({ row: j + 2, source: newSource, ref: newRef });
      if (needSource) counts[newSource] = (counts[newSource] || 0) + 1;
      if (needRef) refBackfilled++;
    }

    // 3. シートへ反映 (E列ソース, H列参照値)
    for (var k = 0; k < rowsToUpdate.length; k++) {
      var r = rowsToUpdate[k];
      if (r.source !== null) seenSheet.getRange(r.row, 5).setValue(r.source);
      if (r.ref !== null) seenSheet.getRange(r.row, 8).setValue(r.ref);
    }

    var breakdown = Object.keys(counts).map(function(s) {
      return s + ': ' + counts[s] + '件';
    }).join(', ');
    var scopeLabel = hasFilter ? '「' + filterName + '」' : '全顧客';
    return {
      updated: rowsToUpdate.length,
      sourceCounts: counts,
      message: scopeLabel + ' を ' + rowsToUpdate.length + ' 行バックフィル (ソース: ' + (breakdown || '0件') + ' / URL or REINS番号: ' + refBackfilled + '件)'
    };
  } catch (e) {
    console.error('backfillSeenSheetSource error: ' + e.message);
    return { updated: 0, message: 'エラー: ' + e.message };
  }
}

/**
 * Chrome拡張側の notifiedDedupMap (30日TTL) もリセットするための「シグナル」を
 * ScriptProperties に蓄積する。Chrome拡張は次回 get_seen_ids でこれを受け取って
 * 自分の chrome.storage.local の notifiedDedupMap から該当エントリを削除する。
 *
 * 24時間以内のエントリを保持し、それより古いものは自動でクリーンアップ。
 */
function _appendDedupResetSignal_(customerName, source) {
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty('pending_dedup_resets') || '[]';
    var list;
    try { list = JSON.parse(raw); } catch (_) { list = []; }
    var now = Date.now();
    var cutoff = now - 24 * 60 * 60 * 1000; // 24時間
    list = list.filter(function(entry) { return entry && entry.ts && entry.ts > cutoff; });
    list.push({ customer: String(customerName), source: String(source || '*'), ts: now });
    props.setProperty('pending_dedup_resets', JSON.stringify(list));
  } catch (e) {
    console.warn('_appendDedupResetSignal_ error: ' + e.message);
  }
}

/**
 * 通知済み物件シート + 承認待ち物件シートから、指定顧客 + 指定ソース の行を
 * 両方とも削除する。これで Chrome 拡張の次回検索で seen_ids から消えて
 * 再度 Discord 通知 + 承認待ち追加される。
 *
 * @param {string} customerName
 * @param {string} source - 'itandi' | 'ielove' | 'essquare' | 'reins' | '*' (全件)
 * @return {{deleted: number, message: string}}
 */
function resetSeenForCustomerSource(customerName, source) {
  if (!customerName) return { deleted: 0, message: '顧客名が未指定です' };
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var allSources = !source || source === '*';
    var label = allSources ? '全サイト' : source;
    var nameTrim = String(customerName).trim();

    // 1. 通知済み物件シート (5列: 顧客名/room_id/建物名/通知日時/ソース) から削除
    var seenDeleted = 0;
    var seenSheet = ss.getSheetByName(SEEN_SHEET_NAME);
    if (seenSheet) {
      var seenLast = seenSheet.getLastRow();
      if (seenLast >= 2) {
        var seenData = seenSheet.getRange(2, 1, seenLast - 1, 5).getValues();
        var seenIdxs = [];
        for (var i = 0; i < seenData.length; i++) {
          var rCust = String(seenData[i][0] || '').trim();
          var rSrc = String(seenData[i][4] || '').trim();
          if (rCust !== nameTrim) continue;
          if (!allSources && rSrc !== String(source).trim()) continue;
          seenIdxs.push(i + 2);
        }
        for (var k = seenIdxs.length - 1; k >= 0; k--) {
          seenSheet.deleteRow(seenIdxs[k]);
        }
        seenDeleted = seenIdxs.length;
      }
    }

    // 2. 承認待ち物件シート: status='pending' / 'skipped' のみ削除
    //    status='sent' は お客さんの LINE リンクが指している行なので保護する。
    //    handleGetSeenIds 側で 'sent' は seen_ids から除外しているため、
    //    通知済み物件シートからの削除だけで seen_ids から解放される。
    var pendingDeleted = 0;
    var pendingSheet = ss.getSheetByName(PENDING_SHEET_NAME);
    if (pendingSheet) {
      var pLast = pendingSheet.getLastRow();
      if (pLast >= 2) {
        var pData = pendingSheet.getRange(2, 1, pLast - 1, 11).getValues();
        var pIdxs = [];
        for (var j = 0; j < pData.length; j++) {
          var pCust = String(pData[j][0] || '').trim();
          if (pCust !== nameTrim) continue;
          var pStatus = String(pData[j][10] || '').trim();
          // status='sent' は顧客のリンク先のため保護
          if (pStatus === 'sent') continue;
          // status='pending' / 'skipped' / その他 を削除対象に
          if (allSources) {
            pIdxs.push(j + 2);
          } else {
            var pSrc = '';
            try {
              var parsed = JSON.parse(String(pData[j][9] || ''));
              if (parsed && parsed.source) pSrc = String(parsed.source);
            } catch (_) {}
            // source未設定 → REINSとみなす
            if (!pSrc) pSrc = 'reins';
            if (pSrc === String(source).trim()) pIdxs.push(j + 2);
          }
        }
        for (var m = pIdxs.length - 1; m >= 0; m--) {
          pendingSheet.deleteRow(pIdxs[m]);
        }
        pendingDeleted = pIdxs.length;
      }
    }

    // Chrome拡張側の30日重複マップもクリアするシグナルを残す
    _appendDedupResetSignal_(nameTrim, source || '*');

    var total = seenDeleted + pendingDeleted;
    return {
      deleted: total,
      message: '「' + customerName + '」の' + label + '履歴を削除しました '
        + '(通知済み: ' + seenDeleted + '件 / 承認待ち非sent: ' + pendingDeleted + '件)'
        + '。Chrome拡張側の30日重複も次回検索時に自動クリアされます。'
        + ' ※ status=sent はお客さんのリンク維持のため削除されません'
    };
  } catch (e) {
    return { deleted: 0, message: 'エラー: ' + e.message };
  }
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
  if (roomNumber) {
    // 物件名の末尾に同じ部屋番号が含まれていれば除去する。
    // （いえらぶ等は物件名に部屋番号が入っており、部屋番号フィールドと重複して「○○ 1001 1001」になるため）
    var name = String(buildingName || '');
    var rn = String(roomNumber).trim();
    if (rn) {
      // 末尾の「(空白)+部屋番号」を除去。部屋番号の数字部分でも照合（"1001号室" 等の差異に対応）
      var rnNum = (rn.match(/\d{1,5}[A-Za-z]?/) || [''])[0];
      var esc = function(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
      var stripped = name;
      var reFull = new RegExp('[\\s　]*' + esc(rn) + '$');
      stripped = stripped.replace(reFull, '');
      if (stripped === name && rnNum) {
        stripped = name.replace(new RegExp('[\\s　]*' + esc(rnNum) + '$'), '');
      }
      stripped = stripped.replace(/[\s　]+$/, '');
      if (stripped) name = stripped;
    }
    return { name: name, room: roomNumber };
  }
  if (!buildingName) return { name: '', room: '' };
  var m = buildingName.match(/^(.+?)\s+(\d{2,5}[A-Za-z]?)$/);
  if (m) return { name: m[1], room: m[2] };
  return { name: buildingName, room: '' };
}

// ═══════════════════════════════════════════════════════════════════
// Gemini AI による物件情報整理
// ═══════════════════════════════════════════════════════════════════

/**
 * Gemini API を呼び出す共通ヘルパー。
 * @param {string} systemPrompt
 * @param {Array} userParts - [{text}|{inlineData:{mimeType,data}}]
 * @param {string} [model='gemini-2.5-flash']
 * @return {string} 応答テキスト
 */
function _callGeminiApi_(systemPrompt, userParts, model) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY 未設定');
  model = model || 'gemini-2.5-flash';
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;
  var payload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: userParts }],
    generationConfig: { temperature: 0.0, maxOutputTokens: 2000 }
  };
  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code !== 200) {
    throw new Error('Gemini API error: ' + code + ' ' + resp.getContentText().substring(0, 200));
  }
  var result = JSON.parse(resp.getContentText());
  var text = '';
  if (result.candidates && result.candidates[0] && result.candidates[0].content && result.candidates[0].content.parts) {
    for (var i = 0; i < result.candidates[0].content.parts.length; i++) {
      if (result.candidates[0].content.parts[i].text) {
        text += result.candidates[0].content.parts[i].text;
      }
    }
  }
  return text;
}

/**
 * 物件名から AD/業務連絡/期限などを除去し、 物件名のみを返す。
 */
function _aiCleanBuildingName_(currentName) {
  if (!currentName) return currentName;
  try {
    var sys = 'あなたは不動産物件名のクリーニングを行うアシスタントです。' +
      '入力された物件名から、 純粋な物件名以外の情報 ' +
      '(AD表記、 業務連絡、 仲手、 期限、 注釈、 「@」 で始まる連絡事項、 ★や■などの装飾記号など) を除去し、 ' +
      '建物名 + 部屋番号のみを返してください。\n' +
      '出力は JSON 形式のみ: {"cleaned": "クリーンな物件名"}\n' +
      'もし元から綺麗な場合は同じ文字列を返してください。';
    var userParts = [{ text: '【元の物件名】\n' + currentName }];
    var text = _callGeminiApi_(sys, userParts);
    var m = text.match(/\{[\s\S]*?\}/);
    if (!m) return currentName;
    var parsed = JSON.parse(m[0]);
    return parsed.cleaned || currentName;
  } catch (e) {
    console.warn('[AI物件名] エラー: ' + e.message);
    return currentName;
  }
}

/**
 * アラート (warnings) を分析し、 物件情報を元に「クリア推奨/要確認」 を判定。
 * @return {Array<{alert:string, status:'clear'|'need_check', comment:string}>}
 */
function _aiAnalyzeWarnings_(warningsText, propInfoText) {
  if (!warningsText || warningsText.trim() === '') return [];
  try {
    var sys = 'あなたは不動産物件のアラート項目を分析するアシスタントです。' +
      '各アラート項目について、 物件情報の中にそれを解決する情報があるか確認し、' +
      '"clear" (情報あり、 クリア推奨) または "need_check" (情報なし、 要確認) を判定してください。' +
      '理由 (comment) も短く添えてください。\n' +
      '出力は JSON 形式のみ: {"results": [{"alert": "...", "status": "clear|need_check", "comment": "..."}]}';
    var userText = '【アラート項目 (改行区切り)】\n' + warningsText + '\n\n【物件情報】\n' + propInfoText;
    var text = _callGeminiApi_(sys, [{ text: userText }]);
    var m = text.match(/\{[\s\S]*\}/);
    if (!m) return [];
    var parsed = JSON.parse(m[0]);
    return parsed.results || [];
  } catch (e) {
    console.warn('[AIアラート] エラー: ' + e.message);
    return [];
  }
}

/**
 * 画像URL の配列を Gemini Vision で分類し、 並び替えた URL 配列を返す。
 * 並び順: 1=図面, 2=外観, 3=室内, 4=室内, 残りは適当 (キッチン/浴室/玄関/その他)。
 *
 * @return {{ordered:string[], categories:string[]}}
 */
function _aiClassifyAndReorderImages_(imageUrls) {
  if (!imageUrls || imageUrls.length === 0) return { ordered: [], categories: [] };
  try {
    var sys = 'あなたは不動産物件画像を分類するアシスタントです。' +
      '各画像を以下のカテゴリに分類してください:\n' +
      ' - "floorplan" (間取り図/図面)\n' +
      ' - "exterior" (建物外観)\n' +
      ' - "interior" (室内/リビング/居室)\n' +
      ' - "kitchen" (キッチン)\n' +
      ' - "bath" (浴室/トイレ/洗面所)\n' +
      ' - "entrance" (玄関/共用部/エントランス)\n' +
      ' - "view" (景色/眺望/バルコニー)\n' +
      ' - "other" (その他)\n' +
      '出力は JSON 形式のみ: {"results": [{"index": 0, "category": "floorplan"}, ...]}';
    var parts = [{ text: '画像を順に分類してください。' }];
    var validIndices = [];
    for (var i = 0; i < imageUrls.length; i++) {
      try {
        var imgResp = UrlFetchApp.fetch(imageUrls[i], { muteHttpExceptions: true });
        if (imgResp.getResponseCode() !== 200) continue;
        var blob = imgResp.getBlob();
        var mime = blob.getContentType() || 'image/jpeg';
        if (mime.indexOf('image/') !== 0) continue;
        parts.push({ text: '画像 ' + (validIndices.length) + ':' });
        parts.push({ inlineData: { mimeType: mime, data: Utilities.base64Encode(blob.getBytes()) } });
        validIndices.push(i);
      } catch (_) {}
    }
    if (validIndices.length === 0) return { ordered: imageUrls.slice(), categories: imageUrls.map(function() { return ''; }) };

    var text = _callGeminiApi_(sys, parts);
    var m = text.match(/\{[\s\S]*\}/);
    if (!m) return { ordered: imageUrls.slice(), categories: imageUrls.map(function() { return ''; }) };
    var parsed;
    try { parsed = JSON.parse(m[0]); } catch (e) { return { ordered: imageUrls.slice(), categories: imageUrls.map(function() { return ''; }) }; }
    var classifications = parsed.results || [];

    // index → category マップ (元の imageUrls の index 基準)
    var idxToCat = {};
    for (var c = 0; c < classifications.length; c++) {
      var apiIdx = classifications[c].index;
      if (typeof apiIdx === 'number' && apiIdx < validIndices.length) {
        var origIdx = validIndices[apiIdx];
        idxToCat[origIdx] = classifications[c].category || 'other';
      }
    }

    // カテゴリ別にグループ化
    var byCat = { floorplan: [], exterior: [], interior: [], kitchen: [], bath: [], entrance: [], view: [], other: [] };
    for (var u = 0; u < imageUrls.length; u++) {
      var cat = idxToCat[u] || 'other';
      if (!byCat[cat]) cat = 'other';
      byCat[cat].push({ url: imageUrls[u], cat: cat });
    }

    // 並び替え: 1=floorplan, 2=exterior, 3=interior, 4=interior, 残り
    var ordered = [];
    var cats = [];
    function take(c) {
      if (byCat[c] && byCat[c].length > 0) {
        var item = byCat[c].shift();
        ordered.push(item.url);
        cats.push(item.cat);
      }
    }
    take('floorplan');
    take('exterior');
    take('interior');
    take('interior');
    ['kitchen', 'bath', 'entrance', 'view', 'floorplan', 'exterior', 'interior', 'other'].forEach(function(c) {
      while (byCat[c].length > 0) {
        var item = byCat[c].shift();
        ordered.push(item.url);
        cats.push(item.cat);
      }
    });
    return { ordered: ordered, categories: cats };
  } catch (e) {
    console.warn('[AI画像分類] エラー: ' + e.message);
    return { ordered: imageUrls.slice(), categories: imageUrls.map(function() { return ''; }) };
  }
}

/**
 * 物件情報を AI で整理して PENDING_SHEET を更新する。
 * 承認ページの「🤖 AIで整理」 ボタンから呼ばれる。
 *
 * @return {{ok:boolean, changes:object, message:string}}
 */
function aiPreprocessProperty(customerName, roomId) {
  if (!customerName || !roomId) return { ok: false, message: 'パラメータ不足' };
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
    if (!sheet) return { ok: false, message: 'PENDING_SHEETなし' };
    var data = sheet.getDataRange().getValues();
    var targetRow = -1;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() !== String(customerName).trim()) continue;
      if (String(data[i][2]).trim() !== String(roomId).trim()) continue;
      var st = String(data[i][10] || '');
      if (st !== 'pending' && st !== 'sent') continue;
      targetRow = i + 1;
      break;
    }
    if (targetRow < 0) return { ok: false, message: '対象行なし (' + customerName + '/' + roomId + ')' };

    var prop = rowToProperty(data[targetRow - 1]);
    var changes = {};

    // 1. 物件名クリーニング
    var origName = prop.buildingName + (prop.roomNumber ? ' ' + prop.roomNumber : '');
    var cleanedName = _aiCleanBuildingName_(origName);
    if (cleanedName && cleanedName !== origName) {
      changes.buildingName = { from: origName, to: cleanedName };
    }

    // 2. アラート分析
    var warnings = prop.warningsText || '';
    var aiWarningComments = [];
    if (warnings.trim() !== '') {
      var propInfo = '間取り: ' + (prop.layout || '') +
        ' / 面積: ' + (prop.area || '') + 'm² / 築年数: ' + (prop.buildingAge || '') +
        ' / 構造: ' + (prop.structure || '') +
        ' / 駅: ' + (prop.stationInfo || '') +
        '\n設備: ' + (prop.facilities || '');
      aiWarningComments = _aiAnalyzeWarnings_(warnings, propInfo);
      if (aiWarningComments.length > 0) {
        changes.warningComments = aiWarningComments;
      }
    }

    // 3. 画像分類 + 並び替え
    var imageUrls = prop.imageUrls || (prop.imageUrl ? [prop.imageUrl] : []);
    if (imageUrls.length > 0) {
      var classified = _aiClassifyAndReorderImages_(imageUrls);
      if (classified.ordered.length > 0) {
        var orderChanged = false;
        for (var oi = 0; oi < classified.ordered.length; oi++) {
          if (classified.ordered[oi] !== imageUrls[oi]) { orderChanged = true; break; }
        }
        if (orderChanged) {
          changes.imageOrder = {
            from: imageUrls.slice(0, 4),
            to: classified.ordered.slice(0, 4),
            categories: classified.categories.slice(0, 4)
          };
        }
      }
    }

    // PENDING_SHEET の J列 JSON を更新
    try {
      var jsonRaw = String(data[targetRow - 1][9] || '');
      var jsonObj = jsonRaw ? JSON.parse(jsonRaw) : {};
      if (changes.buildingName) {
        jsonObj.building_name = changes.buildingName.to;
        // D列 (building_name) も更新
        sheet.getRange(targetRow, 4).setValue(changes.buildingName.to);
      }
      if (changes.imageOrder) {
        jsonObj.image_urls = changes.imageOrder.to.concat(
          (jsonObj.image_urls || []).filter(function(u) { return changes.imageOrder.to.indexOf(u) < 0; })
        );
        jsonObj.image_categories = changes.imageOrder.categories.concat(
          (jsonObj.image_categories || []).slice(changes.imageOrder.categories.length)
        );
      }
      if (changes.warningComments) {
        jsonObj.ai_warning_comments = changes.warningComments;
      }
      jsonObj.ai_processed_at = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
      sheet.getRange(targetRow, 10).setValue(JSON.stringify(jsonObj));
    } catch (eUpd) {
      console.warn('[AI整理] JSON更新エラー: ' + eUpd.message);
    }

    return { ok: true, changes: changes, message: 'AI整理完了' };
  } catch (e) {
    return { ok: false, message: 'AI整理エラー: ' + e.message };
  }
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
    currentStatus: _normalizeValue(extra.current_status),
    warningsText: _normalizeValue(extra.warnings_text),
    source: String(extra.source || ''),
    reins_property_number: String(extra.reins_property_number || '')
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

// ===== 画像アップロード（手動アップロード用） =====
// 優先順: Telegra.ph → freeimage.host → imgbb
// 一括スクレイピングの画像は Python 側で Google Drive にアップロードされる。
function uploadPropertyImage(base64Data, filename, mimeType) {
  var errors = [];
  var decoded = Utilities.base64Decode(base64Data);
  var blob = Utilities.newBlob(decoded, mimeType || 'image/jpeg', filename || 'upload.jpg');

  // スクリプトプロパティ IMGBB_API_KEY に個人キーが設定されているか確認
  var personalImgbbKey = null;
  try {
    personalImgbbKey = PropertiesService.getScriptProperties().getProperty('IMGBB_API_KEY');
  } catch (_) {}

  // -1) imgbb (個人キー設定時のみ最優先)
  if (personalImgbbKey) {
    try {
      var respP = UrlFetchApp.fetch('https://api.imgbb.com/1/upload', {
        method: 'POST',
        payload: {
          key: personalImgbbKey,
          image: base64Data,
          name: (filename || 'upload').replace(/\.[^.]+$/, '')
        },
        muteHttpExceptions: true
      });
      var codeP = respP.getResponseCode();
      var bodyP = respP.getContentText();
      if (codeP === 200) {
        var jsonP = JSON.parse(bodyP);
        if (jsonP && jsonP.success && jsonP.data && jsonP.data.url) {
          return { success: true, url: jsonP.data.url };
        }
        errors.push('imgbb(personal) parse: ' + bodyP.substring(0, 200));
      } else {
        errors.push('imgbb(personal) HTTP ' + codeP + ': ' + bodyP.substring(0, 200));
      }
    } catch (eP) {
      errors.push('imgbb(personal): ' + eP.message);
    }
  }

  // 0) catbox.moe (APIキー不要、GASサーバーIPから412の可能性あり)
  try {
    var resp0 = UrlFetchApp.fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      payload: {
        reqtype: 'fileupload',
        fileToUpload: blob
      },
      muteHttpExceptions: true
    });
    var code0 = resp0.getResponseCode();
    var body0 = resp0.getContentText();
    if (code0 === 200 && body0 && body0.indexOf('https://') === 0) {
      return { success: true, url: body0.trim() };
    }
    errors.push('catbox HTTP ' + code0 + ': ' + body0.substring(0, 200));
  } catch (e0) {
    errors.push('catbox: ' + e0.message);
  }

  // 1) Telegra.ph（APIキー不要）
  try {
    var resp1 = UrlFetchApp.fetch('https://telegra.ph/upload', {
      method: 'POST',
      payload: { file: blob },
      muteHttpExceptions: true
    });
    var code1 = resp1.getResponseCode();
    var body1 = resp1.getContentText();
    if (code1 === 200) {
      var json1 = JSON.parse(body1);
      if (Array.isArray(json1) && json1[0] && json1[0].src) {
        return { success: true, url: 'https://telegra.ph' + json1[0].src };
      }
      errors.push('telegraph parse: ' + body1.substring(0, 200));
    } else {
      errors.push('telegraph HTTP ' + code1 + ': ' + body1.substring(0, 200));
    }
  } catch (e1) {
    errors.push('telegraph: ' + e1.message);
  }

  // 2) freeimage.host
  try {
    var resp2 = UrlFetchApp.fetch('https://freeimage.host/api/1/upload', {
      method: 'POST',
      payload: {
        key: '6d207e02198a847aa98d0a2a901485a5',
        source: base64Data,
        format: 'json'
      },
      muteHttpExceptions: true
    });
    var code2 = resp2.getResponseCode();
    var body2 = resp2.getContentText();
    if (code2 === 200) {
      var json2 = JSON.parse(body2);
      if (json2 && json2.image && json2.image.url) {
        return { success: true, url: json2.image.url };
      }
      errors.push('freeimage parse: ' + body2.substring(0, 200));
    } else {
      errors.push('freeimage HTTP ' + code2 + ': ' + body2.substring(0, 200));
    }
  } catch (e2) {
    errors.push('freeimage: ' + e2.message);
  }

  // 3) imgbb（個人APIキー優先、無ければ共有キー）
  // スクリプトプロパティ IMGBB_API_KEY に個人キーを設定すると個別レート枠で使える
  var imgbbKey = '48cdc51fdcc4a2828c3379b59663db7f'; // 旧共有キー(レート制限中)
  try {
    var personalKey = PropertiesService.getScriptProperties().getProperty('IMGBB_API_KEY');
    if (personalKey) imgbbKey = personalKey;
  } catch (_) {}
  try {
    var resp3 = UrlFetchApp.fetch('https://api.imgbb.com/1/upload', {
      method: 'POST',
      payload: {
        key: imgbbKey,
        image: base64Data,
        name: (filename || 'upload').replace(/\.[^.]+$/, '')
      },
      muteHttpExceptions: true
    });
    var code3 = resp3.getResponseCode();
    var body3 = resp3.getContentText();
    if (code3 === 200) {
      var json3 = JSON.parse(body3);
      if (json3 && json3.success && json3.data && json3.data.url) {
        return { success: true, url: json3.data.url };
      }
      errors.push('imgbb parse: ' + body3.substring(0, 200));
    } else {
      errors.push('imgbb HTTP ' + code3 + ': ' + body3.substring(0, 200));
    }
  } catch (e3) {
    errors.push('imgbb: ' + e3.message);
  }

  return { success: false, message: 'Upload failed: ' + errors.join(' | ') };
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
// 「西武新宿線 下落合駅 徒歩7分」のような文字列から駅名のみ抽出。
function _extractStationName_(s) {
  var m = String(s || '').match(/([^\s駅]+)駅/);
  return m ? m[1].trim() : '';
}
// 同じ文字列から「徒歩X分」のX (分) を抽出。なければ大きい値。
function _extractWalkMin_(s) {
  var m = String(s || '').match(/徒歩\s*(\d+)\s*分/);
  return m ? parseInt(m[1], 10) : 9999;
}
// stationStr の駅名が customerStations の中にあるか
function _matchesCustomerStation_(stationStr, customerStations) {
  if (!customerStations || customerStations.length === 0) return false;
  var name = _extractStationName_(stationStr);
  if (!name) return false;
  for (var i = 0; i < customerStations.length; i++) {
    var cs = String(customerStations[i] || '').trim().replace(/駅$/, '');
    if (cs && cs === name) return true;
  }
  return false;
}
/**
 * メイン最寄駅 (prop.stationInfo) がお客さん希望駅でない場合、
 * 「その他の路線」に希望駅があれば、それをメインに昇格して入れ替える。
 * 候補が複数ある場合は徒歩分数が最小の駅を選ぶ。
 *
 * @param {Object} prop - 物件オブジェクト
 * @param {string[]} customerStations - お客さんが選んでいる駅名の配列
 * @return {{main: string, others: string[]}}
 */
function _reorderStationsForCustomer_(prop, customerStations) {
  var main = String(prop && prop.stationInfo || '');
  var others = (prop && prop.otherStations) ? prop.otherStations.slice() : [];
  if (!customerStations || customerStations.length === 0) {
    return { main: main, others: others };
  }
  // 既にメインがお客さん希望駅ならそのまま
  if (_matchesCustomerStation_(main, customerStations)) {
    return { main: main, others: others };
  }
  // others の中で希望駅マッチのもの全てを抽出
  var matchedIdxs = [];
  for (var i = 0; i < others.length; i++) {
    if (_matchesCustomerStation_(others[i], customerStations)) matchedIdxs.push(i);
  }
  if (matchedIdxs.length === 0) {
    return { main: main, others: others };
  }
  // マッチ候補が複数なら徒歩分数最小を選ぶ
  var bestIdx = matchedIdxs[0];
  var bestWalk = _extractWalkMin_(others[bestIdx]);
  for (var k = 1; k < matchedIdxs.length; k++) {
    var w = _extractWalkMin_(others[matchedIdxs[k]]);
    if (w < bestWalk) { bestWalk = w; bestIdx = matchedIdxs[k]; }
  }
  var newMain = others[bestIdx];
  var newOthers = others.slice(0, bestIdx).concat(others.slice(bestIdx + 1));
  // 元のメインを others 先頭に降格
  if (main) newOthers.unshift(main);
  return { main: newMain, others: newOthers };
}

/**
 * 顧客名から検索条件シートを引いて、選択駅の配列を返す。
 * 駅は F列 (index 5) にカンマ/読点区切りで保存されている想定。
 *
 * @param {string} customerName
 * @return {string[]}
 */
function _getCustomerSelectedStations_(customerName) {
  if (!customerName) return [];
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return [];
    var last = sheet.getLastRow();
    if (last < 2) return [];
    var data = sheet.getRange(2, 1, last - 1, 6).getValues();
    // 最終行が最新条件 (同名複数あり得る)
    for (var i = data.length - 1; i >= 0; i--) {
      if (String(data[i][1] || '').trim() === String(customerName).trim()) {
        var raw = String(data[i][5] || '');
        return raw.split(/[,、]\s*/).map(function(s) { return s.trim(); }).filter(function(s) { return s; });
      }
    }
  } catch (e) {
    console.warn('_getCustomerSelectedStations_ error: ' + (e && e.message));
  }
  return [];
}

/**
 * GAS側で物件の警告アラートを計算する。
 * Chrome拡張の __computePropertyWarnings と同等のロジック。
 * 承認プレビューで他のお客様の警告を動的に再計算するために使う。
 *
 * @param {Object} prop - rowToProperty() の結果 (物件データ)
 * @param {string} equipmentStr - カンマ区切りの設備条件文字列 (検索条件シートM列)
 * @param {string} [notesStr] - その他希望 (検索条件シートP列)
 * @return {string} 警告テキスト (改行区切り)。警告なしなら空文字列。
 */
function _computePropertyWarningsGAS_(prop, equipmentStr, notesStr) {
  if (!equipmentStr && !notesStr) return '';
  var equip = String(equipmentStr || '').replace(/[０-９]/g, function(c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  }).toLowerCase();
  var floorMatch = String(prop.floorText || '').replace(/[０-９]/g, function(c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  }).match(/(\d+)/);
  var floorNum = floorMatch ? parseInt(floorMatch[1]) : 0;
  var storyMatch = String(prop.storyText || '').replace(/[０-９]/g, function(c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  }).match(/(\d+)/);
  var storyNum = storyMatch ? parseInt(storyMatch[1]) : 0;
  var fac = prop.facilities || '';
  var warnings = [];

  // 階数系
  if (equip.indexOf('最上階') >= 0 && (floorNum === 0 || storyNum === 0)) {
    warnings.push('⚠️ 最上階かどうか確認してください');
  }
  if (equip.indexOf('2階以上') >= 0 && floorNum === 0) {
    warnings.push('⚠️ 2階以上かどうか確認してください');
  }
  if (equip.indexOf('1階') >= 0 && equip.indexOf('2階以上') < 0 && floorNum === 0) {
    warnings.push('⚠️ 1階かどうか確認してください');
  }
  // 方角
  if (equip.indexOf('南向き') >= 0 && !prop.sunlight) {
    warnings.push('⚠️ 南向きかどうか確認してください');
  }
  // 角部屋
  if (equip.indexOf('角部屋') >= 0 && fac.indexOf('角部屋') < 0 && fac.indexOf('角住戸') < 0) {
    warnings.push('⚠️ 角部屋かどうか確認してください');
  }
  // 追い焚き
  if ((equip.indexOf('追い焚き') >= 0 || equip.indexOf('追いだき') >= 0 || equip.indexOf('追い炊き') >= 0) && fac.indexOf('追焚') < 0 && fac.indexOf('追い焚') < 0 && fac.indexOf('追いだき') < 0) {
    warnings.push('⚠️ 追い焚き機能かどうか確認してください');
  }
  // エレベーター
  if ((equip.indexOf('エレベーター') >= 0 || equip.indexOf('ev') >= 0) && fac.indexOf('エレベータ') < 0 && fac.indexOf('エレベーター') < 0) {
    warnings.push('⚠️ エレベーターかどうか確認してください');
  }
  // バス・トイレ別
  if ((equip.indexOf('バストイレ別') >= 0 || equip.indexOf('バス・トイレ別') >= 0 || equip.indexOf('bt別') >= 0) && fac.indexOf('バス・トイレ別') < 0 && fac.indexOf('バストイレ別') < 0) {
    warnings.push('⚠️ バス・トイレ別かどうか確認してください');
  }
  // 温水洗浄便座
  if ((equip.indexOf('温水洗浄便座') >= 0 || equip.indexOf('ウォシュレット') >= 0) && fac.indexOf('温水洗浄便座') < 0) {
    warnings.push('⚠️ 温水洗浄便座かどうか確認してください');
  }
  // 浴室乾燥機
  if (equip.indexOf('浴室乾燥') >= 0 && fac.indexOf('浴室乾燥') < 0) {
    warnings.push('⚠️ 浴室乾燥機かどうか確認してください');
  }
  // 室内洗濯機置場
  if ((equip.indexOf('室内洗濯機置場') >= 0 || equip.indexOf('室内洗濯') >= 0) && fac.indexOf('室内洗濯機') < 0) {
    warnings.push('⚠️ 室内洗濯機置場かどうか確認してください');
  }
  // エアコン
  if (equip.indexOf('エアコン') >= 0 && fac.indexOf('エアコン') < 0) {
    warnings.push('⚠️ エアコン付きかどうか確認してください');
  }
  // 床暖房
  if (equip.indexOf('床暖房') >= 0 && fac.indexOf('床暖房') < 0) {
    warnings.push('⚠️ 床暖房かどうか確認してください');
  }
  // 独立洗面台
  if (equip.indexOf('独立洗面') >= 0) {
    if (fac.indexOf('シャンプードレッサー') >= 0 || fac.indexOf('独立洗面') >= 0 || fac.indexOf('洗面所独立') >= 0 || fac.indexOf('洗面化粧台') >= 0 || fac.indexOf('シャワー付洗面') >= 0) {
      // 確定 → アラート不要
    } else if (fac.indexOf('洗面台') >= 0) {
      warnings.push('⚠️ 独立洗面台があるかどうか確認してください（洗面台の記載あり、ユニットバスの可能性）');
    } else {
      warnings.push('⚠️ 独立洗面台があるかどうか確認してください');
    }
  }
  // ガスコンロ
  if (equip.indexOf('ガスコンロ') >= 0 && fac.indexOf('ガスコンロ') < 0 && fac.indexOf('ガスキッチン') < 0) {
    warnings.push('⚠️ ガスコンロ対応かどうか確認してください');
  }
  // IH
  if (equip.indexOf('ih') >= 0 && fac.indexOf('ＩＨ') < 0 && fac.indexOf('IH') < 0) {
    warnings.push('⚠️ IHコンロかどうか確認してください');
  }
  // コンロ2口以上
  if (equip.indexOf('コンロ2口以上') >= 0 || equip.indexOf('2口以上') >= 0 || equip.indexOf('コンロ２口以上') >= 0) {
    if (fac.indexOf('2口') < 0 && fac.indexOf('２口') < 0 && fac.indexOf('3口') < 0 && fac.indexOf('３口') < 0) {
      warnings.push('⚠️ コンロ2口以上かどうか確認してください');
    }
  }
  // システムキッチン
  if (equip.indexOf('システムキッチン') >= 0 && fac.indexOf('システムキッチン') < 0) {
    warnings.push('⚠️ システムキッチンかどうか確認してください');
  }
  // カウンターキッチン
  if (equip.indexOf('カウンターキッチン') >= 0 && fac.indexOf('カウンターキッチン') < 0 && fac.indexOf('対面キッチン') < 0 && fac.indexOf('オープンキッチン') < 0 && fac.indexOf('アイランドキッチン') < 0) {
    warnings.push('⚠️ カウンターキッチンかどうか確認してください');
  }
  // 駐輪場
  if (equip.indexOf('駐輪場') >= 0 && fac.indexOf('駐輪場') < 0) {
    warnings.push('⚠️ 駐輪場ありかどうか確認してください');
  }
  // 宅配ボックス
  if ((equip.indexOf('宅配ボックス') >= 0 || equip.indexOf('宅配box') >= 0) && fac.indexOf('宅配ボックス') < 0 && fac.indexOf('宅配BOX') < 0) {
    warnings.push('⚠️ 宅配ボックスかどうか確認してください');
  }
  // ゴミ置場
  if ((equip.indexOf('ゴミ置') >= 0 || equip.indexOf('ごみ置') >= 0 || equip.indexOf('ゴミ捨') >= 0 || equip.indexOf('ごみ捨') >= 0) && fac.indexOf('ゴミ出し') < 0 && fac.indexOf('ゴミ置') < 0 && fac.indexOf('ごみ置') < 0 && fac.indexOf('ごみ出し') < 0) {
    warnings.push('⚠️ 敷地内ゴミ置場かどうか確認してください');
  }
  // ロフト
  if (equip.indexOf('ロフト') >= 0) {
    if (equip.indexOf('ロフトng') >= 0 || equip.indexOf('ロフト不可') >= 0) {
      if (fac.indexOf('ロフト') < 0) warnings.push('⚠️ ロフトがないか確認してください（ロフトNG）');
    } else if (fac.indexOf('ロフト') < 0) {
      warnings.push('⚠️ ロフト付きかどうか確認してください');
    }
  }
  // 家具家電付き
  if (equip.indexOf('家具') >= 0 || equip.indexOf('家電') >= 0) {
    warnings.push('⚠️ 家具家電付きかどうか確認してください');
  }
  // バルコニー
  if (equip.indexOf('バルコニー') >= 0 && equip.indexOf('ルーフバルコニー') < 0) {
    if (fac.indexOf('バルコニー') < 0) {
      warnings.push('⚠️ バルコニー付きかどうか確認してください');
    }
  }
  // ルーフバルコニー
  if (equip.indexOf('ルーフバルコニー') >= 0 && fac.indexOf('ルーフバルコニー') < 0) {
    warnings.push('⚠️ ルーフバルコニー付きかどうか確認してください');
  }
  // 専用庭
  if (equip.indexOf('専用庭') >= 0 && fac.indexOf('専用庭') < 0) {
    warnings.push('⚠️ 専用庭かどうか確認してください');
  }
  // 都市ガス
  if (equip.indexOf('都市ガス') >= 0 && fac.indexOf('都市ガス') < 0 && fac.indexOf('プロパン') < 0 && fac.indexOf('LPガス') < 0 && fac.indexOf('ＬＰガス') < 0) {
    warnings.push('⚠️ 都市ガスかどうか確認してください');
  }
  // プロパンガス
  if ((equip.indexOf('プロパン') >= 0 || equip.indexOf('lpガス') >= 0) && fac.indexOf('プロパン') < 0 && fac.indexOf('LPガス') < 0 && fac.indexOf('ＬＰガス') < 0 && fac.indexOf('都市ガス') < 0) {
    warnings.push('⚠️ プロパンガスかどうか確認してください');
  }
  // オートロック
  if (equip.indexOf('オートロック') >= 0 && fac.indexOf('オートロック') < 0) {
    warnings.push('⚠️ オートロックかどうか確認してください');
  }
  // TVモニタ付きインターホン
  if ((equip.indexOf('tvモニタ') >= 0 || equip.indexOf('モニター付') >= 0 || equip.indexOf('モニタ付') >= 0 || equip.indexOf('tvインターホン') >= 0 || equip.indexOf('tvインターフォン') >= 0) && fac.indexOf('モニター付') < 0 && fac.indexOf('TVインターホン') < 0 && fac.indexOf('ＴＶインターホン') < 0 && fac.indexOf('TVモニタ') < 0) {
    warnings.push('⚠️ TVモニタ付きインターホンかどうか確認してください');
  }
  // 防犯カメラ
  if (equip.indexOf('防犯カメラ') >= 0 && fac.indexOf('防犯カメラ') < 0) {
    warnings.push('⚠️ 防犯カメラかどうか確認してください');
  }
  // 楽器
  if (equip.indexOf('楽器') >= 0 && fac.indexOf('楽器使用可') < 0 && fac.indexOf('楽器相談') < 0) {
    warnings.push('⚠️ 楽器可かどうか確認してください');
  }
  // ルームシェア
  if ((equip.indexOf('ルームシェア') >= 0 || equip.indexOf('シェアハウス') >= 0) && fac.indexOf('ルームシェア') < 0 && fac.indexOf('シェアハウス') < 0) {
    warnings.push('⚠️ ルームシェア可かどうか確認してください');
  }
  // 高齢者
  if (equip.indexOf('高齢者') >= 0 && fac.indexOf('高齢者向') < 0 && fac.indexOf('高齢者相談') < 0 && fac.indexOf('高齢者歓迎') < 0 && fac.indexOf('高齢者限定') < 0 && fac.indexOf('高齢者世帯') < 0) {
    warnings.push('⚠️ 高齢者歓迎かどうか確認してください');
  }
  // インターネット無料
  if ((equip.indexOf('インターネット無料') >= 0 || equip.indexOf('ネット無料') >= 0) && fac.indexOf('インターネット無料') < 0 && fac.indexOf('ネット無料') < 0 && fac.indexOf('ネット使用料不要') < 0) {
    warnings.push('⚠️ インターネット無料かどうか確認してください');
  }
  // 収納
  if (equip.indexOf('収納') >= 0 && equip.indexOf('ウォークイン') < 0 && equip.indexOf('シューズ') < 0) {
    if (fac.indexOf('収納') < 0 && fac.indexOf('クロゼット') < 0 && fac.indexOf('クローゼット') < 0 && fac.indexOf('物置') < 0 && fac.indexOf('グルニエ') < 0) {
      warnings.push('⚠️ 収納があるか確認してください');
    }
  }
  // シューズボックス
  if (equip.indexOf('シューズ') >= 0) {
    if (fac.indexOf('シューズインクローゼット') < 0 && fac.indexOf('シューズボックス') < 0 && fac.indexOf('シューズBOX') < 0 && fac.indexOf('シューズクロゼット') < 0 && fac.indexOf('シューズクローク') < 0 && fac.indexOf('シューズWIC') < 0) {
      warnings.push('⚠️ シューズボックスがあるか確認してください');
    }
  }
  // ウォークインクローゼット
  if (equip.indexOf('ウォークイン') >= 0) {
    if (fac.indexOf('ウォークインクローゼット') < 0 && fac.indexOf('ウォークインクロゼット') < 0 && fac.indexOf('ウォークスルークロゼット') < 0 && fac.indexOf('WIC') < 0) {
      warnings.push('⚠️ ウォークインクローゼットがあるか確認してください');
    }
  }
  // その他ご希望
  if (notesStr && String(notesStr).trim()) {
    warnings.push('⚠️ その他ご希望: ' + String(notesStr).trim());
  }
  return warnings.join('\n');
}

/**
 * 顧客名から設備条件(M列)とその他希望(P列)を取得する。
 * _computePropertyWarningsGAS_ に渡すためのユーティリティ。
 *
 * @param {string[]} customerNames
 * @return {Object<string, {equipment: string, notes: string}>}
 */
function _getCustomerEquipmentMap_(customerNames) {
  if (!customerNames || customerNames.length === 0) return {};
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return {};
    var last = sheet.getLastRow();
    if (last < 2) return {};
    var data = sheet.getRange(2, 1, last - 1, 16).getValues(); // up to P (column 16)
    var nameSet = {};
    for (var n = 0; n < customerNames.length; n++) nameSet[customerNames[n]] = true;
    var result = {};
    for (var i = data.length - 1; i >= 0; i--) {
      var name = String(data[i][1] || '').trim();
      if (nameSet[name] && !result[name]) {
        result[name] = {
          equipment: String(data[i][12] || ''),
          notes: String(data[i][15] || '')
        };
      }
    }
    return result;
  } catch (e) {
    console.warn('_getCustomerEquipmentMap_ error: ' + (e && e.message));
    return {};
  }
}

/**
 * 同じ roomId で承認待ち(pending)になっている、他のお客様の名前リストを返す。
 * 承認画面の「一括送信」機能で他のお客様を検出するために使う。
 *
 * @param {string} roomId
 * @param {string} excludeCustomer
 * @return {Array<{customerName: string, warningsText: string, rowIndex: number}>}
 */
function _findOtherPendingCustomersForRoom_(roomId, excludeCustomer) {
  if (!roomId) return [];
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
    if (!sheet) return [];
    var data = sheet.getDataRange().getValues();
    var out = [];
    for (var i = 1; i < data.length; i++) {
      var status = String(data[i][10] || '');
      if (status !== 'pending') continue;
      var rowCustomer = String(data[i][0] || '');
      var rowRoomId = String(data[i][2] || '');
      if (rowRoomId !== String(roomId)) continue;
      if (excludeCustomer && rowCustomer === excludeCustomer) continue;
      var extra = {};
      try { extra = JSON.parse(data[i][9] || '{}'); } catch (e) {}
      out.push({
        customerName: rowCustomer,
        warningsText: String(extra.warnings_text || ''),
        rowIndex: i + 1
      });
    }
    return out;
  } catch (e) {
    console.warn('_findOtherPendingCustomersForRoom_ error: ' + e.message);
    return [];
  }
}

/**
 * 顧客名から検索条件シートを引いて、選択こだわり条件(設備)の配列を返す。
 * 検索条件シート M列 (index 12) に「ペット可,オートロック,...」形式で保存されている想定。
 *
 * @param {string} customerName
 * @return {string[]}
 */
function _getCustomerEquipmentList_(customerName) {
  if (!customerName) return [];
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return [];
    var last = sheet.getLastRow();
    if (last < 2) return [];
    var data = sheet.getRange(2, 1, last - 1, 13).getValues(); // up to M
    for (var i = data.length - 1; i >= 0; i--) {
      if (String(data[i][1] || '').trim() === String(customerName).trim()) {
        var raw = String(data[i][12] || '');
        return raw.split(/[,、]\s*/).map(function(s) { return s.trim(); }).filter(function(s) { return s; });
      }
    }
  } catch (e) {
    console.warn('_getCustomerEquipmentList_ error: ' + (e && e.message));
  }
  return [];
}

/**
 * Flexバブル配列を、LINEのFlexサイズ上限を超えないようカルーセル(複数メッセージ)に分割する。
 * carouselは最大12バブル、かつ JSON合計が約50KBを超えるとLINEに弾かれる(Too large flex message)ため、
 * 件数とサイズの両方で区切る。
 * @param {Array} flexBubbles - bubble オブジェクトの配列
 * @param {string} altText - メッセージの altText
 * @return {Array} LINEメッセージ(flex)の配列
 */
function _splitBubblesIntoCarousels_(flexBubbles, altText) {
  var SIZE_LIMIT = 45000;  // 50KB上限に対する安全マージン
  var MAX_BUBBLES = 12;
  var messages = [];
  var current = [];
  var currentSize = 80;    // carousel枠のオーバーヘッド概算
  for (var i = 0; i < flexBubbles.length; i++) {
    var bubbleSize = 4000;
    try { bubbleSize = JSON.stringify(flexBubbles[i]).length; } catch (e) {}
    if (current.length > 0 && (current.length >= MAX_BUBBLES || currentSize + bubbleSize > SIZE_LIMIT)) {
      messages.push(_carouselMessage_(current, altText));
      current = [];
      currentSize = 80;
    }
    current.push(flexBubbles[i]);
    currentSize += bubbleSize;
  }
  if (current.length > 0) messages.push(_carouselMessage_(current, altText));
  return messages;
}

function _carouselMessage_(chunk, altText) {
  if (chunk.length === 1) {
    return { type: 'flex', altText: altText, contents: chunk[0] };
  }
  return { type: 'flex', altText: altText + '（' + chunk.length + '件）', contents: { type: 'carousel', contents: chunk } };
}

function buildPropertyFlex(prop, options) {
  options = options || {};
  var includeImage = options.includeImage !== false;
  var viewUrl = options.viewUrl || '';

  // 1万未満は「1,100円」、1万以上は「14万円」のように表示
  var rentText = prop.rent ? _fmtPriceFull(prop.rent) : '0\u5186';
  var mgmtText = prop.managementFee ? _fmtPriceFull(prop.managementFee) : '0\u5186';
  var rentMan = prop.rent ? _fmtMan(prop.rent) : '0'; // altText 用に温存

  // ── タイトル (建物名 + 部屋番号) ──
  var titleBlock = {
    type: 'text',
    text: prop.buildingName + (prop.roomNumber ? ' ' + prop.roomNumber : ''),
    weight: 'bold', size: 'lg', color: '#1a2538', wrap: true
  };

  // ── 賃料ブロック (大きく目立たせる) ──
  // 賃料と「/月」を flex:0 にして隣接させる (default flex:1 だと「/月」が右に押される)。
  // 管理費・敷金礼金は別行で sm サイズに格上げ (前バージョンの xs は見づらかった)。
  var rentBlock = {
    type: 'box', layout: 'vertical', spacing: 'xs', margin: 'sm',
    contents: [
      {
        type: 'box', layout: 'baseline', spacing: 'sm',
        contents: [
          { type: 'text', text: rentText, weight: 'bold', size: 'xxl', color: '#E05252', flex: 0 },
          { type: 'text', text: '/ 月', size: 'xs', color: '#999999', flex: 0 }
        ]
      },
      { type: 'text', text: '管理費 ' + mgmtText, size: 'sm', color: '#666666' },
      { type: 'text',
        text: '敷金 ' + (prop.deposit || '0') + ' / 礼金 ' + (prop.keyMoney || '0'),
        size: 'sm', color: '#666666' }
    ]
  };

  // ── クイックファクト (チップ風: 内容に合わせて自動幅) ──
  // flex:0 + vertical layout で各チップが必要な幅だけ確保。
  // 横並びは justifyContent:'space-around' で適度な間隔を空けて配置。
  function _chip(text) {
    return {
      type: 'box', layout: 'vertical',
      backgroundColor: '#f0faf4',
      cornerRadius: 'md',
      paddingTop: '4px', paddingBottom: '4px',
      paddingStart: 'md', paddingEnd: 'md',
      flex: 0,
      contents: [{
        type: 'text', text: text,
        size: 'xs', color: '#3d6909', weight: 'bold'
      }]
    };
  }
  var chipsContents = [];
  if (prop.layout) chipsContents.push(_chip(prop.layout));
  if (prop.area) chipsContents.push(_chip(prop.area + 'm²'));
  if (prop.buildingAge) chipsContents.push(_chip(prop.buildingAge));
  if (prop.floor) chipsContents.push(_chip(prop.floor + '階'));

  // ── 立地情報 ──
  // お客さん希望駅が「その他の路線」に含まれる場合、メインに昇格させる
  var stationData = _reorderStationsForCustomer_(prop, options.customerStations);
  var locationLines = [];
  if (prop.address) {
    locationLines.push({ type: 'text', text: prop.address, size: 'sm', color: '#444444', wrap: true });
  }
  if (stationData.main) {
    locationLines.push({ type: 'text', text: stationData.main, size: 'sm', color: '#444444', wrap: true });
  }
  // その他の路線: 複数ある場合は1路線1行で表示 (詰まらず読みやすい)
  if (stationData.others && stationData.others.length > 0) {
    locationLines.push({ type: 'text', text: 'その他の路線', size: 'xs', color: '#888888', margin: 'sm' });
    for (var os = 0; os < stationData.others.length; os++) {
      locationLines.push({ type: 'text', text: stationData.others[os],
        size: 'sm', color: '#666666', wrap: true });
    }
  }

  // ── body 組み立て ──
  // ステータスバッジ (オプション): 塗りつぶしの目立つバッジで表示
  //   options.statusBadge.subText: バッジの下に小さい補足テキスト
  var bodyContents = [];
  if (options.statusBadge && options.statusBadge.text) {
    var badgeColor = options.statusBadge.color || '#6ea814';
    bodyContents.push({
      type: 'box', layout: 'vertical',
      backgroundColor: badgeColor,
      cornerRadius: 'md',
      paddingTop: 'md', paddingBottom: 'md',
      paddingStart: 'lg', paddingEnd: 'lg',
      margin: 'none',
      contents: [{
        type: 'text', text: options.statusBadge.text,
        size: 'xl', color: '#ffffff', weight: 'bold', align: 'center', wrap: true
      }]
    });
    if (options.statusBadge.subText) {
      bodyContents.push({
        type: 'text', text: options.statusBadge.subText,
        size: 'sm', color: '#555555', wrap: true, margin: 'md', align: 'center'
      });
    }
  }
  bodyContents.push(titleBlock);
  bodyContents.push(rentBlock);
  if (chipsContents.length > 0) {
    // flex:0 のチップを横並びにして余白は justifyContent で均等配分
    bodyContents.push({
      type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'md',
      justifyContent: 'space-around',
      contents: chipsContents
    });
  }
  if (locationLines.length > 0) {
    bodyContents.push({ type: 'separator', margin: 'lg', color: '#eeeeee' });
    bodyContents.push({ type: 'box', layout: 'vertical', spacing: 'xs', margin: 'md', contents: locationLines });
  }

  // ── 担当者コメント (任意) ──
  if (options.staffComment && String(options.staffComment).trim()) {
    bodyContents.push({
      type: 'box', layout: 'vertical', margin: 'lg', spacing: 'xs',
      backgroundColor: '#fff8e1', cornerRadius: 'md', paddingAll: 'md',
      contents: [
        { type: 'text', text: '💬 担当者より', size: 'xs', color: '#b8860b', weight: 'bold' },
        { type: 'text', text: String(options.staffComment).trim(), size: 'sm', color: '#444444', wrap: true }
      ]
    });
  }

  var bubble = { type: 'bubble', size: 'mega' };

  // ── ヘッダー (オプション): 「空室確認の結果」 等の用途明示 ──
  if (options.headerTitle) {
    bubble.header = {
      type: 'box', layout: 'vertical', paddingAll: 'md',
      backgroundColor: options.headerColor || '#6ea814',
      contents: [{
        type: 'text', text: options.headerTitle,
        size: 'sm', weight: 'bold', color: '#ffffff', align: 'center', wrap: true
      }]
    };
  }

  // ── ヒーロー画像 (1枚 or 1+3サムネ コンポジット) ──
  // options.heroImageUrls (配列) が渡されたら最大4枚をコンポジット表示。
  // 単一の options.heroImageUrl も後方互換でサポート。
  var heroImages = [];
  if (Array.isArray(options.heroImageUrls)) {
    heroImages = options.heroImageUrls.slice(0, 4);
  } else if (options.heroImageUrl) {
    heroImages = [options.heroImageUrl];
  } else if (prop.imageUrls && prop.imageUrls.length > 0) {
    heroImages = prop.imageUrls.slice(0, 4);
  } else if (prop.imageUrl) {
    heroImages = [prop.imageUrl];
  }
  heroImages = heroImages.filter(function(u) {
    return u && typeof u === 'string' && u.indexOf('https://') === 0;
  });

  if (includeImage && heroImages.length > 0) {
    var _imgAction = viewUrl ? { type: 'uri', uri: viewUrl } : undefined;
    function _imgEl(u, ratio, mode) {
      return {
        type: 'image', url: u, size: 'full',
        aspectRatio: ratio, aspectMode: mode,
        backgroundColor: '#F5F5F5',
        action: _imgAction
      };
    }
    if (heroImages.length === 1) {
      // 単一画像: メイン1枚のみ
      bubble.hero = _imgEl(heroImages[0], '4:3', 'fit');
    } else if (heroImages.length === 2) {
      // 2枚: 50/50 で横並び (1:1 fit — 間取り図など見切れ防止のため cover ではなく fit)
      bubble.hero = {
        type: 'box', layout: 'horizontal', spacing: 'xs',
        contents: [
          _imgEl(heroImages[0], '1:1', 'fit'),
          _imgEl(heroImages[1], '1:1', 'fit')
        ]
      };
    } else {
      // 3-4枚: 左に大1枚 + 右に小(縦)のコラージュ。縦幅を抑えてカードをコンパクトに。
      // 右列の合計高さを左の大(1:1)に揃えるため、サムネのアスペクト比を枚数から算出（n:2）。
      var thumbs = heroImages.slice(1, 4);
      var thumbRatio = thumbs.length + ':2';
      bubble.hero = {
        type: 'box', layout: 'horizontal', spacing: 'xs',
        contents: [
          // fit: 画像全体を表示（見切れ防止）。枠と比率が違う場合は余白が出る。
          { type: 'image', url: heroImages[0], size: 'full', aspectRatio: '1:1', aspectMode: 'fit',
            backgroundColor: '#F5F5F5', action: _imgAction, flex: 2 },
          {
            type: 'box', layout: 'vertical', spacing: 'xs', flex: 1,
            contents: thumbs.map(function(u) {
              return { type: 'image', url: u, size: 'full', aspectRatio: thumbRatio, aspectMode: 'fit',
                backgroundColor: '#F5F5F5', action: _imgAction };
            })
          }
        ]
      };
    }
  }

  bubble.body = {
    type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg',
    contents: bodyContents
  };

  // ── footer (オプション: カスタムボタン群を指定可) ──
  if (Array.isArray(options.customFooterButtons) && options.customFooterButtons.length > 0) {
    bubble.footer = {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg',
      contents: options.customFooterButtons.map(function(b) {
        var act;
        if (b.postbackData) {
          act = { type: 'postback', label: b.label, data: b.postbackData,
                  displayText: b.displayText || b.label };
        } else {
          act = { type: 'uri', label: b.label, uri: b.uri };
        }
        return {
          type: 'button',
          style: b.style || 'primary',
          color: b.color,
          height: 'sm',
          action: act
        };
      })
    };
  } else if (viewUrl) {
    bubble.footer = {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg',
      contents: [
        { type: 'button', style: 'primary', color: '#6ea814', height: 'sm',
          action: { type: 'uri', label: '物件詳細を見る', uri: viewUrl }
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
  var isSuccess = (title === '\u5B8C\u4E86'); // \u5B8C\u4E86
  var html = '<html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5}'
    + '.card{background:#fff;border-radius:12px;padding:30px;max-width:400px;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,0.1)}'
    + 'h2{color:#333;margin-bottom:16px}.msg{color:#555;line-height:1.6}'
    + '.ok{color:#4CAF50}.err{color:#E05252}.warn{color:#FF9800}'
    + '.close-hint{margin-top:20px;padding:10px 16px;background:#f0f4f8;border-radius:8px;color:#555;font-size:13px;display:none}'
    + '.close-hint.show{display:block}'
    + '.countdown{display:inline-block;color:#888;font-size:13px;margin-top:12px}'
    + '</style></head>'
    + '<body><div class="card">';
  if (isSuccess) {
    html += '<h2 class="ok">\u2705 ' + title + '</h2>';
  } else if (title === '\u30A8\u30E9\u30FC') {
    html += '<h2 class="err">\u274C ' + title + '</h2>';
  } else {
    html += '<h2 class="warn">\u26A0\uFE0F ' + title + '</h2>';
  }
  html += '<p class="msg">' + message + '</p>';
  if (isSuccess) {
    // \u5B8C\u4E86\u753B\u9762\u306F2\u79D2\u5F8C\u306B\u30BF\u30D6\u3092\u81EA\u52D5\u30AF\u30ED\u30FC\u30BA\u8A66\u884C (\u5931\u6557\u6642\u306F\u624B\u52D5\u30D2\u30F3\u30C8\u3092\u8868\u793A)
    html += '<div class="countdown" id="cd">2\u79D2\u5F8C\u306B\u30BF\u30D6\u3092\u9589\u3058\u307E\u3059\u2026</div>';
    html += '<div class="close-hint" id="closeHint">\u26A0\uFE0F \u30D6\u30E9\u30A6\u30B6\u306E\u5236\u9650\u3067\u30BF\u30D6\u3092\u81EA\u52D5\u3067\u9589\u3058\u3089\u308C\u307E\u305B\u3093\u3067\u3057\u305F\u3002<br>\u3053\u306E\u30BF\u30D6\u306F\u624B\u52D5\u3067\u9589\u3058\u3066\u304F\u3060\u3055\u3044\u3002</div>';
    html += '<script>'
      + '(function(){'
      +   'var n=2;'
      +   'var cd=document.getElementById("cd");'
      +   'var t=setInterval(function(){n--;'
      +     'if(cd)cd.textContent=n+"\u79D2\u5F8C\u306B\u30BF\u30D6\u3092\u9589\u3058\u307E\u3059\u2026";'
      +     'if(n<=0){clearInterval(t);'
      +       'try{window.top.close();}catch(e){}'
      +       'try{window.close();}catch(e){}'
      +       'setTimeout(function(){'
      +         'if(cd)cd.style.display="none";'
      +         'var h=document.getElementById("closeHint");'
      +         'if(h)h.className="close-hint show";'
      +       '},400);'
      +     '}'
      +   '},1000);'
      + '})();'
      + '<\/script>';
  }
  html += '</div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(title)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== HTML: 承認プレビュー（単一・編集可能） =====
function makePreviewHtml(prop, customerName, roomId, otherCustomers, collectMode) {
  otherCustomers = otherCustomers || [];
  collectMode = !!collectMode;
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
    + '.img-item img{width:100%;height:200px;object-fit:contain;background:#222;display:block;cursor:pointer}'
    + '.img-item .rotate-btns{position:absolute;top:32px;right:4px;z-index:3;display:flex;flex-direction:column;gap:2px}'
    + '.img-item .rotate-btn{background:rgba(255,255,255,0.92);border:none;border-radius:3px;padding:2px 5px;font-size:11px;font-weight:700;color:#1a5276;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,0.3);line-height:1}'
    + '.img-item .rotate-btn:disabled{opacity:0.5;cursor:wait}'
    + '.img-item.rotating{opacity:0.5;pointer-events:none}'
    + '.img-item .zoom-link{position:absolute;top:4px;left:32px;z-index:3;background:rgba(255,255,255,0.92);border-radius:3px;padding:3px 6px;font-size:11px;font-weight:700;color:#1a5276;text-decoration:none;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.3)}'
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
    // ホームズ画像検索 (参考画像補完)
    + '.homes-area{margin:12px 0;padding:12px;border:1px solid #d4e6f1;border-radius:8px;background:#fafcff}'
    + '.homes-btn{display:inline-block;padding:8px 16px;background:#1a5276;color:#fff;border-radius:6px;cursor:pointer;font-size:14px;border:none;font-weight:700}'
    + '.homes-btn:disabled{opacity:0.5;cursor:not-allowed}'
    + '.homes-btn:hover:not(:disabled){background:#154160}'
    + '.homes-status{margin-left:10px;font-size:12px;color:#666}'
    + '.homes-cands{margin-top:10px;display:none}'
    + '.homes-cands.active{display:block}'
    + '.homes-cands-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:12px;color:#1a5276;font-weight:700}'
    + '.homes-adopt-btn{padding:6px 14px;background:#27ae60;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:700}'
    + '.homes-adopt-btn:disabled{opacity:0.4;cursor:not-allowed}'
    + '.homes-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:6px}'
    + '.homes-item{position:relative;border:2px solid #ddd;border-radius:6px;overflow:hidden;cursor:pointer;background:#222}'
    + '.homes-item.selected{border-color:#27ae60;box-shadow:0 0 0 2px rgba(39,174,96,0.3)}'
    + '.homes-item img{width:100%;height:120px;object-fit:contain;background:#222;display:block}'
    + '.homes-item .cb{position:absolute;top:4px;left:4px;width:18px;height:18px;cursor:pointer;z-index:2}'
    + '.homes-item .src-link{position:absolute;bottom:4px;right:4px;background:rgba(255,255,255,0.92);border-radius:3px;padding:2px 5px;font-size:10px;font-weight:700;color:#1a5276;text-decoration:none;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,0.3);z-index:3}'
    + '.homes-item .zoom-link{position:absolute;top:4px;right:4px;background:rgba(255,255,255,0.92);border-radius:3px;padding:2px 5px;font-size:11px;font-weight:700;color:#1a5276;text-decoration:none;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,0.3);z-index:3}'
    + '.homes-item .type-badge{position:absolute;bottom:4px;left:4px;border-radius:3px;padding:2px 6px;font-size:10px;font-weight:700;color:#fff;text-shadow:0 1px 1px rgba(0,0,0,0.2);box-shadow:0 1px 2px rgba(0,0,0,0.3);z-index:3;pointer-events:none}'
    + '.homes-item .type-badge.active{background:#27ae60}'
    + '.homes-item .type-badge.archive{background:#d35400}'
    + '.homes-item .type-badge.same-bld{background:#8e44ad}'
    + '.homes-genre-section{margin-bottom:14px}'
    + '.homes-genre-heading{font-size:13px;font-weight:700;color:#1a5276;padding:6px 8px;margin-bottom:6px;background:#eef6ff;border-left:4px solid #2e86c1;border-radius:0 4px 4px 0}'
    + '.img-arrows{position:absolute;bottom:2px;left:0;right:0;display:flex;justify-content:center;gap:4px;padding:0 2px}'
    + '.img-arrows button{background:rgba(0,0,0,0.55);color:#fff;border:none;border-radius:3px;width:24px;height:20px;cursor:pointer;font-size:11px;padding:0;line-height:20px}'
    + '.img-arrows button:disabled{opacity:0.3;cursor:default}'
    // ドラッグ並び替え用
    + '.img-item{cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none}'
    + '.img-item:active{cursor:grabbing}'
    + '.img-item.dragging{opacity:0.4;border-color:#2196F3}'
    + '.img-item.drag-over-left{box-shadow:-4px 0 0 0 #2196F3}'
    + '.img-item.drag-over-right{box-shadow:4px 0 0 0 #2196F3}'
    + 'body.dragging-image,body.dragging-image *{cursor:grabbing !important}'
    + '.insert-pos{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:14px}'
    + '.insert-pos select{padding:5px 8px;border-radius:6px;border:1px solid #ccc;font-size:14px;background:#fff}'
    + '.customer-banner{background:#e8f5e9;border-left:4px solid #4CAF50;padding:10px 14px;border-radius:6px;margin-bottom:12px;font-size:14px;color:#1b5e20;font-weight:bold}'
    + '.ai-section{background:#f0faf4;border:1px solid #c8e6c9;border-radius:8px;padding:10px 12px;margin-bottom:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}'
    + '.ai-btn{background:#6ea814;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:bold;cursor:pointer}'
    + '.ai-btn:hover{background:#5a8810}'
    + '.ai-btn:disabled{opacity:0.6;cursor:not-allowed}'
    + '.ai-status{font-size:12px;color:#3d6909}'
    + '.ai-result{margin-top:8px;font-size:12px;color:#555;line-height:1.5;width:100%}'
    + '.ai-result .change{padding:4px 8px;background:#fff;border-left:3px solid #6ea814;margin:4px 0;border-radius:3px}'
    + '.ai-comments{margin-top:6px}'
    + '.ai-comments .item{padding:4px 8px;margin:3px 0;border-radius:4px;font-size:11px}'
    + '.ai-comments .item.clear{background:#e8f5e9;color:#2e7d32}'
    + '.ai-comments .item.need{background:#fff3e0;color:#e65100}'
    + '</style></head><body><div class="card">'
    + '<h2>\uD83D\uDD0D \u627F\u8A8D\u30D7\u30EC\u30D3\u30E5\u30FC\uFF08\u7DE8\u96C6\u53EF\uFF09</h2>'
    + '<div class="customer-banner">\uD83D\uDC64 ' + _esc(customerName || '') + ' \u69D8 \u3054\u5E0C\u671B\u306E\u7269\u4EF6</div>'
    + '<div class="ai-section">'
    +   '<button class="ai-btn" id="aiPreprocessBtn" onclick="runAiPreprocess()">\uD83E\uDD16 AI\u3067\u6574\u7406</button>'
    +   '<span class="ai-status" id="aiStatus">\u7269\u4EF6\u540D\u30AF\u30EA\u30FC\u30CB\u30F3\u30B0 / \u753B\u50CF\u4E26\u3073\u66FF\u3048 / \u30A2\u30E9\u30FC\u30C8\u30C1\u30A7\u30C3\u30AF</span>'
    +   '<div class="ai-result" id="aiResult"></div>'
    + '</div>'
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

  // \u2500\u2500 \u78BA\u8A8D\u4E8B\u9805\uFF08\u8B66\u544A\u30A2\u30E9\u30FC\u30C8\uFF09 \u2500\u2500
  if (prop.warningsText) {
    html += '<div class="section-header">\u26A0\uFE0F \u78BA\u8A8D\u4E8B\u9805</div>';
    html += '<div class="warnings-box" style="background:#fff8e1;border-left:4px solid #f9a825;padding:10px 14px;border-radius:6px;font-size:13px;white-space:pre-wrap;color:#5d4037;margin-bottom:12px">' + _esc(prop.warningsText) + '</div>';
  }

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

  // \u30DB\u30FC\u30E0\u30BA\u753B\u50CF\u691C\u7D22 (\u53C2\u8003\u753B\u50CF\u3067\u88DC\u5B8C)
  // \u63A1\u7528\u753B\u50CF\u306F cat='\u53C2\u8003\u753B\u50CF\u3067\u3059' \u56FA\u5B9A\u3067 allImages \u306B\u8FFD\u52A0 \u2192 \u627F\u8A8D\u6642\u306B
  // ordered_image_categories \u3068\u3057\u3066 GAS \u4FDD\u5B58 \u2192 property.html \u3067
  // <span class="carousel-cat"> \u306B\u8868\u793A\u3055\u308C\u308B\u3002
  // \u5019\u88DC\u306F same-room (\u540C\u5EFA\u7269+\u540C\u30BF\u30A4\u30D7=\u9593\u53D6\u308A+\u9762\u7A4D\u4E00\u81F4) \u306E\u307F\u8868\u793A\u3002
  html += '<div class="images-title" style="margin-top:16px">'
    + '<span>\uD83C\uDFE0 \u30DB\u30FC\u30E0\u30BA\u753B\u50CF\u3067\u88DC\u5B8C</span>'
    + '</div>'
    + '<div class="homes-area">'
    + '<button id="homesSearchBtn" class="homes-btn" onclick="requestHomesImageSearch()">\uD83C\uDFE0 \u30DB\u30FC\u30E0\u30BA\u753B\u50CF\u3092\u691C\u7D22 (\u53C2\u8003\u753B\u50CF)</button>'
    + '<span id="homesSearchStatus" class="homes-status"></span>'
    + '<div id="homesCands" class="homes-cands">'
    + '<div class="homes-cands-header">'
    + '<span id="homesCandsSummary"></span>'
    + '<button id="homesAdoptBtn" class="homes-adopt-btn" onclick="adoptSelectedHomesImages()" disabled>\u9078\u629E\u753B\u50CF\u3092\u63A1\u7528</button>'
    + '</div>'
    + '<div id="homesGrid" class="homes-grid"></div>'
    + '</div>'
    + '</div>';

  var skipUrl = baseUrl + '?action=skip&customer=' + encodeURIComponent(customerName) + '&room_id=' + roomId;

  // \u2500\u2500 \u4ED6\u306E\u304A\u5BA2\u69D8\u306B\u3082\u4E00\u62EC\u9001\u4FE1\u306E\u30BB\u30AF\u30B7\u30E7\u30F3 (\u540C\u3058\u7269\u4EF6\u304C\u8907\u6570\u9867\u5BA2\u306E\u627F\u8A8D\u5F85\u3061\u306B\u3042\u308B\u6642) \u2500\u2500
  if (otherCustomers && otherCustomers.length > 0) {
    html += '<div class="multi-send-box" style="background:#f5f9ee;border:2px solid #6ea814;border-radius:10px;padding:14px 16px;margin:20px 0;">'
      + '<div style="font-size:14px;font-weight:700;color:#3d6909;margin-bottom:10px;">\uD83D\uDCCB \u4ED6\u306E\u304A\u5BA2\u69D8\u306B\u3082\u540C\u3058\u7269\u4EF6\u304C\u627F\u8A8D\u5F85\u3061\u3067\u3059 (' + otherCustomers.length + '\u540D)</div>'
      + '<label style="display:flex;align-items:center;font-size:13px;color:#3d6909;cursor:pointer;margin-bottom:8px;">'
      +   '<input type="checkbox" id="multiSendMaster" checked onchange="toggleAllMultiSend()" style="margin-right:8px;width:18px;height:18px;accent-color:#6ea814;">'
      +   '<b>\u9078\u629E\u3057\u305F\u304A\u5BA2\u69D8\u306B\u3082\u540C\u3058\u5185\u5BB9\u3067\u9001\u4FE1\u3059\u308B</b>'
      + '</label>'
      + '<div style="padding-left:24px;display:flex;flex-direction:column;gap:6px;">';
    for (var oc = 0; oc < otherCustomers.length; oc++) {
      var ocItem = otherCustomers[oc];
      var ocName = _esc(ocItem.customerName);
      var ocWarn = (ocItem.warningsText || '').replace(/\u26A0\uFE0F\s*/g, '').replace(/\n/g, ' / ').trim();
      var ocWarnLines = (ocItem.warningsText || '').split('\n').filter(function(s) { return s.trim(); });
      var ocWarnLabel = ocWarnLines.length > 0
        ? '<span style="color:#856404;font-size:11px;margin-left:8px;">\u26A0\uFE0F ' + ocWarnLines.length + '\u4EF6: ' + _esc(ocWarn).substring(0, 120) + '</span>'
        : '<span style="color:#3d6909;font-size:11px;margin-left:8px;">\u2713 \u8B66\u544A\u306A\u3057</span>';
      html += '<label style="display:flex;align-items:center;font-size:13px;color:#333;cursor:pointer;">'
        +   '<input type="checkbox" class="multi-send-cb" data-customer="' + ocName + '" checked style="margin-right:8px;width:16px;height:16px;accent-color:#6ea814;">'
        +   '<span style="font-weight:600;">' + ocName + ' \u3055\u3093</span>'
        +   ocWarnLabel
        + '</label>';
    }
    html += '</div></div>';
  }

  // \u62C5\u5F53\u8005\u30B3\u30E1\u30F3\u30C8\uFF08\u4EFB\u610F\uFF09: \u30AB\u30FC\u30C9\u3068\u306F\u5225\u306E\u5439\u304D\u51FA\u3057(\u30C6\u30AD\u30B9\u30C8)\u3067\u304A\u5BA2\u3055\u3093\u306B\u9001\u308B
  html += '<div style="margin:16px 0 4px;">'
    + '<div style="font-size:13px;color:#888;font-weight:bold;margin-bottom:6px;">\uD83D\uDCAC \u62C5\u5F53\u8005\u30B3\u30E1\u30F3\u30C8\uFF08\u4EFB\u610F\u30FB\u7269\u4EF6\u30AB\u30FC\u30C9\u306E\u4E2D\u306B\u8868\u793A\u3055\u308C\u307E\u3059\uFF09</div>'
    + '<textarea id="staffComment" placeholder="\u4F8B\uFF1A\u99C5\u8FD1\u3067\u65E5\u5F53\u305F\u308A\u826F\u597D\u3067\u3059\u3002\u3054\u5E0C\u671B\u306B\u5408\u3046\u3068\u601D\u3044\u307E\u3059\uFF01" '
    + 'style="width:100%;box-sizing:border-box;min-height:64px;border:1px solid #ccc;border-radius:8px;padding:8px;font-size:14px;font-family:inherit;resize:vertical;"></textarea>'
    + '</div>';

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
    + 'var __collect=' + (collectMode ? 'true' : 'false') + ';' // カート一括承認の埋め込み(iframe)モード

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
    + 'h+="<a class=\\"zoom-link\\" href=\\""+im.url+"\\" target=\\"_blank\\" rel=\\"noopener noreferrer\\" onclick=\\"event.stopPropagation()\\" title=\\"\\u753B\\u50CF\\u3092\\u62E1\\u5927\\">\\uD83D\\uDD0D \\u62E1\\u5927</a>";'
    // 90度回転ボタン (時計回り/反時計回り)
    + 'h+="<div class=\\"rotate-btns\\">"'
    +    '+"<button class=\\"rotate-btn\\" onclick=\\"event.stopPropagation();rotateImg("+i+",90)\\" title=\\"\\u6642\\u8A08\\u56DE\\u308A\\u306B90\\u5EA6\\u56DE\\u8EE2\\">\\u21BB</button>"'
    +    '+"<button class=\\"rotate-btn\\" onclick=\\"event.stopPropagation();rotateImg("+i+",-90)\\" title=\\"\\u53CD\\u6642\\u8A08\\u56DE\\u308A\\u306B90\\u5EA6\\u56DE\\u8EE2\\">\\u21BA</button>"'
    +    '+"</div>";'
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
    + 'd.setAttribute("data-idx",i);'
    + 'd.innerHTML=makeImgTile(i);'
    + 'attachDragToItem(d);'
    + 'grid.appendChild(d)}'
    + 'updateInsertOpts()}'
    // ── Pointer Events によるドラッグ並び替え ──
    + 'var _dragSt=null;'
    + 'function attachDragToItem(card){'
    + 'card.addEventListener("pointerdown",function(e){'
    + 'if(e.button!==0)return;'
    // チェックボックス・矢印ボタン・画像クリック(モーダル)はドラッグ扱いしない
    + 'if(e.target.closest("input,button,a"))return;'
    + 'if(e.target.tagName==="IMG")e.preventDefault();'
    + 'var rect=card.getBoundingClientRect();'
    + '_dragSt={card:card,sx:e.clientX,sy:e.clientY,ox:e.clientX-rect.left,oy:e.clientY-rect.top,w:rect.width,h:rect.height,moved:false,ghost:null,pid:e.pointerId};'
    + 'try{card.setPointerCapture(e.pointerId)}catch(_){}})}'
    + 'document.addEventListener("pointermove",function(e){'
    + 'if(!_dragSt)return;var st=_dragSt;'
    + 'if(!st.moved){'
    + 'if(Math.abs(e.clientX-st.sx)<5&&Math.abs(e.clientY-st.sy)<5)return;'
    + 'st.moved=true;'
    + 'var g=st.card.cloneNode(true);'
    + 'g.style.position="fixed";g.style.pointerEvents="none";g.style.opacity="0.75";g.style.zIndex="9999";'
    + 'g.style.width=st.w+"px";g.style.height=st.h+"px";g.style.transform="rotate(-2deg)";g.style.boxShadow="0 8px 20px rgba(0,0,0,0.3)";'
    + 'g.style.left=(e.clientX-st.ox)+"px";g.style.top=(e.clientY-st.oy)+"px";'
    + 'document.body.appendChild(g);st.ghost=g;'
    + 'st.card.classList.add("dragging");'
    + 'document.body.classList.add("dragging-image")}'
    + 'if(st.ghost){st.ghost.style.left=(e.clientX-st.ox)+"px";st.ghost.style.top=(e.clientY-st.oy)+"px"}'
    + 'var grid=document.getElementById("unifiedGrid");if(!grid)return;'
    + 'var cards=grid.querySelectorAll(".img-item");'
    + 'var nearest=null;var nd=Infinity;var insB=false;'
    + 'for(var i=0;i<cards.length;i++){var c=cards[i];if(c===st.card)continue;'
    + 'c.classList.remove("drag-over-left","drag-over-right");'
    + 'var r=c.getBoundingClientRect();var cx=r.left+r.width/2;var cy=r.top+r.height/2;'
    + 'var d=(e.clientX-cx)*(e.clientX-cx)+(e.clientY-cy)*(e.clientY-cy);'
    + 'if(d<nd){nd=d;nearest=c;insB=e.clientX<cx}}'
    + 'st._nearest=nearest;st._insB=insB;'
    + 'if(nearest)nearest.classList.add(insB?"drag-over-left":"drag-over-right")});'
    + 'document.addEventListener("pointerup",function(e){'
    + 'if(!_dragSt)return;var st=_dragSt;_dragSt=null;'
    + 'st.card.classList.remove("dragging");'
    + 'if(st.ghost){try{st.ghost.remove()}catch(_){}}'
    + 'document.body.classList.remove("dragging-image");'
    + 'var grid=document.getElementById("unifiedGrid");'
    + 'if(grid){var all=grid.querySelectorAll(".img-item");for(var k=0;k<all.length;k++){all[k].classList.remove("drag-over-left","drag-over-right","dragging")}}'
    + 'try{st.card.releasePointerCapture(st.pid)}catch(_){}'
    + 'if(!st.moved||!st._nearest)return;'
    // allImages の中身を並び替えて renderGrid
    + 'var fromIdx=parseInt(st.card.getAttribute("data-idx"),10);'
    + 'var toIdx=parseInt(st._nearest.getAttribute("data-idx"),10);'
    + 'if(isNaN(fromIdx)||isNaN(toIdx))return;'
    + 'var item=allImages.splice(fromIdx,1)[0];'
    // splice後は fromIdx < toIdx の場合 toIdx が1つ左にシフト
    + 'var insertAt;'
    + 'if(fromIdx<toIdx){insertAt=st._insB?(toIdx-1):toIdx}'
    + 'else{insertAt=st._insB?toIdx:(toIdx+1)}'
    + 'allImages.splice(insertAt,0,item);'
    + 'renderGrid()});'
    + 'document.addEventListener("pointercancel",function(){'
    + 'if(!_dragSt)return;var st=_dragSt;_dragSt=null;'
    + 'st.card.classList.remove("dragging");'
    + 'if(st.ghost){try{st.ghost.remove()}catch(_){}}'
    + 'document.body.classList.remove("dragging-image");'
    + 'var grid=document.getElementById("unifiedGrid");'
    + 'if(grid){var all=grid.querySelectorAll(".img-item");for(var k=0;k<all.length;k++){all[k].classList.remove("drag-over-left","drag-over-right","dragging")}}});'
    // チェックボックス
    + 'function toggleU(idx){allImages[idx].checked=!allImages[idx].checked;renderGrid()}'
    + 'function selectAllUnified(c){for(var i=0;i<allImages.length;i++)allImages[i].checked=c;renderGrid()}'
    // 画像90度回転 (Chrome拡張のbackground経由でCanvas回転+再アップロード、失敗時は元URL維持)
    + 'var _rotatePending={};'
    + 'function rotateImg(idx,degrees){'
    + 'if(_rotatePending[idx])return;'
    + 'var im=allImages[idx];if(!im||!im.url)return;'
    + 'var card=document.getElementById("uimg_"+idx);if(card)card.classList.add("rotating");'
    + '_rotatePending[idx]=true;'
    + 'var requestId="rot_"+idx+"_"+Date.now();'
    + 'var origUrl=im.url;'
    + 'var done=false;'
    + 'var timeoutId=setTimeout(function(){if(done)return;done=true;_rotatePending[idx]=false;'
    +    'if(card)card.classList.remove("rotating");alert("\\u753B\\u50CF\\u56DE\\u8EE2\\u30BF\\u30A4\\u30E0\\u30A2\\u30A6\\u30C8 (60\\u79D2)\\u3002Chrome\\u62E1\\u5F35\\u304C\\u30A4\\u30F3\\u30B9\\u30C8\\u30FC\\u30EB\\u3055\\u308C\\u3066\\u3044\\u308B\\u304B\\u78BA\\u8A8D\\u3057\\u3066\\u304F\\u3060\\u3055\\u3044");},60000);'
    + 'var listener=function(e){'
    + 'var d=e.data;if(!d||d.type!=="ROTATE_IMAGE_RESPONSE"||d.requestId!==requestId)return;'
    + 'if(done)return;done=true;clearTimeout(timeoutId);'
    + 'window.removeEventListener("message",listener);_rotatePending[idx]=false;'
    + 'if(card)card.classList.remove("rotating");'
    + 'var r=d.result||{};'
    + 'if(r.ok&&r.url){'
    + 'allImages[idx].url=r.url;'
    + 'renderGrid();'
    + '}else{'
    + 'alert("\\u753B\\u50CF\\u56DE\\u8EE2\\u5931\\u6557: "+(r.error||"unknown")+"\\n(\\u5143\\u306E\\u753B\\u50CF\\u3092\\u7DAD\\u6301\\u3057\\u307E\\u3059)");'
    + '}};'
    + 'window.addEventListener("message",listener);'
    + 'try{var msg={type:"ROTATE_IMAGE_REQUEST",requestId:requestId,url:origUrl,degrees:degrees};'
    + 'if(window.parent&&window.parent!==window){window.parent.postMessage(msg,"*")}else{window.postMessage(msg,"*")}'
    + '}catch(e){'
    + 'done=true;clearTimeout(timeoutId);_rotatePending[idx]=false;'
    + 'window.removeEventListener("message",listener);'
    + 'if(card)card.classList.remove("rotating");'
    + 'alert("\\u753B\\u50CF\\u56DE\\u8EE2\\u9001\\u4FE1\\u5931\\u6557: "+e.message);'
    + '}}'
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
    // ── ホームズ画像検索 (参考画像で補完) ──
    + 'var _homesSelected={};'
    + 'var _homesPending={};'
    + 'var _homesReqSeq=0;'
    + 'function _buildHomesInputForCustomer(){'
    + 'var p=' + JSON.stringify({
        address: prop.address || '',
        buildingName: prop.buildingName || '',
        layout: prop.layout || '',
        area: prop.area || null,
        floorText: prop.floorText || ''
      }) + ';'
    + 'var totalFloors=null;'
    + 'if(p.floorText){var fm=String(p.floorText).match(/(\\d+)\\s*階建/);if(fm)totalFloors=parseInt(fm[1],10)}'
    + 'return{prefecture:"",city:"",address:p.address,buildingName:p.buildingName,builtYearMonth:null,totalFloors:totalFloors,layout:p.layout,area:Number(p.area)||null}'
    + '}'
    + 'function requestHomesImageSearch(){'
    + 'var btn=document.getElementById("homesSearchBtn");'
    + 'var statusEl=document.getElementById("homesSearchStatus");'
    + 'if(!btn||btn.disabled)return;'
    + 'btn.disabled=true;statusEl.textContent="検索中... (10〜20秒かかります)";statusEl.style.color="#666";'
    + 'var input=_buildHomesInputForCustomer();'
    + 'var requestId="homes-"+(++_homesReqSeq)+"-"+Date.now();'
    + 'var timeoutId=setTimeout(function(){if(_homesPending[requestId]){delete _homesPending[requestId];_onHomesSearchResult({ok:false,errors:["タイムアウト(180秒)。Chrome拡張が反応しません"],candidates:[]})}},180000);'
    + '_homesPending[requestId]=function(r){clearTimeout(timeoutId);_onHomesSearchResult(r)};'
    + 'try{var msg={type:"HOMES_IMAGE_SEARCH_REQUEST",requestId:requestId,input:input};'
    + 'if(window.parent&&window.parent!==window){window.parent.postMessage(msg,"*")}else{window.postMessage(msg,"*")}'
    + '}catch(e){delete _homesPending[requestId];clearTimeout(timeoutId);'
    + '_onHomesSearchResult({ok:false,errors:["送信失敗: "+e.message],candidates:[]})}'
    + '}'
    + 'window.addEventListener("message",function(e){'
    + 'var d=e.data;if(!d||d.type!=="HOMES_IMAGE_SEARCH_RESPONSE")return;'
    + 'var cb=_homesPending[d.requestId];if(cb){delete _homesPending[d.requestId];cb(d.result)}'
    + '});'
    + 'function _onHomesSearchResult(result){'
    + 'var btn=document.getElementById("homesSearchBtn");'
    + 'var statusEl=document.getElementById("homesSearchStatus");'
    + 'btn.disabled=false;'
    + 'if(!result||!result.ok){'
    + 'var msg=(result&&result.errors&&result.errors.length)?result.errors.join(" / "):"検索失敗";'
    + 'statusEl.textContent="⚠️ "+msg;statusEl.style.color="#e74c3c";return}'
    + '// same-room (同建物+同タイプ=間取り+面積一致) と archive (過去物件・建物全体ギャラリー) を表示\n'
    + 'var all=result.candidates||[];'
    + 'var sameRoom=all.filter(function(c){return c.matchType==="same-room"});'
    + 'var archive=all.filter(function(c){return c.matchType==="archive"});'
    + 'var displayed=sameRoom.concat(archive);'
    + 'var conf=(result.matched&&result.matched.confidence)||"unknown";'
    + 'statusEl.textContent="✅ 同タイプ "+sameRoom.length+"件 + 過去物件 "+archive.length+"件 (全体"+all.length+"件中 / 信頼度: "+conf+")";'
    + 'statusEl.style.color=displayed.length>0?"#27ae60":"#666";'
    + '// 検索URL一覧を append (同タイプ0件でも表示してホームズ側で確認可能に)\n'
    + 'var urls=(result.matched&&result.matched.searchUrls)||[];'
    + 'for(var si=0;si<urls.length;si++){'
    + '(function(s,si){'
    + 'var a=document.createElement("a");'
    + 'a.href=s.url;a.target="_blank";a.rel="noopener noreferrer";'
    + 'a.textContent=" 🔗 "+(s.label||"検索結果")+"を見る";'
    + 'a.style.cssText="color:#1a5276;text-decoration:underline;font-size:11px;margin-left:8px;";'
    + 'a.title=s.query||"";'
    + 'statusEl.appendChild(a)'
    + '})(urls[si],si)'
    + '}'
    // archive 建物URLが無ければ「archive未登録」を表示 (バグと区別するため)
    + 'var hasArchive=urls.some(function(s){return s.label==="archive建物"});'
    + 'if(!hasArchive){'
    + 'var na=document.createElement("span");'
    + 'na.textContent=" (archive未登録)";'
    + 'na.style.cssText="color:#999;font-size:11px;margin-left:8px;font-style:italic;";'
    + 'na.title="ホームズの不動産アーカイブにこの建物のデータがありません";'
    + 'statusEl.appendChild(na)'
    + '}'
    + '_homesSelected={};'
    + '_renderHomesCands(displayed);'
    + '}'
    + 'var HOMES_GENRE_ORDER=["間取り","外観","リビング","リビング/ダイニング","リビング・ダイニング","ダイニング","寝室","洋室","和室","子供部屋","室内","その他部屋","キッチン","浴室","バス","トイレ","洗面","収納","玄関","バルコニー","ベランダ","庭","眺望","エントランス","ロビー","共用部","駐車場","設備","周辺","その他"];'
    + 'function _genreOrderIdx(g){var i=HOMES_GENRE_ORDER.indexOf(g);return i<0?999:i}'
    + 'function _renderHomesCands(list){'
    + 'var area=document.getElementById("homesCands");'
    + 'var grid=document.getElementById("homesGrid");'
    + 'var sum=document.getElementById("homesCandsSummary");'
    + 'var adoptBtn=document.getElementById("homesAdoptBtn");'
    + 'grid.innerHTML="";'
    + 'if(list.length===0){area.classList.remove("active");sum.textContent="";adoptBtn.disabled=true;return}'
    + 'area.classList.add("active");'
    + 'adoptBtn.disabled=true;'
    + 'function updateSelCount(){'
    + 'var n=Object.keys(_homesSelected).length;'
    + 'sum.textContent="選択: "+n+" / "+list.length+"件";'
    + 'adoptBtn.disabled=(n===0);'
    + 'adoptBtn.dataset.list=JSON.stringify(list)'
    + '}'
    // ジャンル別にグルーピング
    + 'var groups={};'
    + 'for(var gi=0;gi<list.length;gi++){var g=list[gi].genre||"その他";if(!groups[g])groups[g]=[];groups[g].push({idx:gi,cand:list[gi]})}'
    + 'var sortedGenres=Object.keys(groups).sort(function(a,b){return _genreOrderIdx(a)-_genreOrderIdx(b)});'
    + 'sum.textContent="選択: 0 / "+list.length+"件 ("+sortedGenres.length+"ジャンル)";'
    // ジャンル別セクション生成
    + 'function makeItem(idx,c){'
    + 'var item=document.createElement("div");'
    + 'item.className="homes-item";'
    + 'var srcLink=c.sourceUrl?"<a class=\\"src-link\\" href=\\""+c.sourceUrl+"\\" target=\\"_blank\\" rel=\\"noopener noreferrer\\" title=\\""+(c.sourceLabel||"取得元")+"\\">\\uD83D\\uDD17 \\u53D6\\u5F97\\u5143</a>":"";'
    + 'var zoomLink="<a class=\\"zoom-link\\" href=\\""+(c.urlHires||c.url)+"\\" target=\\"_blank\\" rel=\\"noopener noreferrer\\" title=\\"\\u753B\\u50CF\\u3092\\u62E1\\u5927\\" onclick=\\"event.stopPropagation()\\">\\uD83D\\uDD0D \\u62E1\\u5927</a>";'
    // matchType バッジ (募集中 / 過去物件)
    + 'var typeBadge="";'
    + 'if(c.matchType==="archive"){typeBadge="<span class=\\"type-badge archive\\">\\uD83D\\uDCE6 \\u904E\\u53BB\\u7269\\u4EF6</span>"}'
    + 'else if(c.matchType==="same-room"){typeBadge="<span class=\\"type-badge active\\">\\uD83D\\uDCCD \\u52DF\\u96C6\\u4E2D</span>"}'
    + 'else if(c.matchType==="same-building"){typeBadge="<span class=\\"type-badge same-bld\\">\\uD83C\\uDFE2 \\u540C\\u5EFA\\u7269</span>"}'
    + 'item.innerHTML="<input type=\\"checkbox\\" class=\\"cb\\"><img src=\\""+c.url+"\\" alt=\\"homes\\">"+zoomLink+srcLink+typeBadge;'
    + 'var cb=item.querySelector(".cb");'
    + 'function toggle(){var on=cb.checked;if(on){_homesSelected[idx]=c.url;item.classList.add("selected")}else{delete _homesSelected[idx];item.classList.remove("selected")}updateSelCount()}'
    + 'cb.addEventListener("change",toggle);'
    + 'item.addEventListener("click",function(e){if(e.target!==cb&&e.target.tagName!=="A"){cb.checked=!cb.checked;toggle()}});'
    + 'return item'
    + '}'
    + 'for(var sgi=0;sgi<sortedGenres.length;sgi++){'
    + 'var genre=sortedGenres[sgi];'
    + 'var section=document.createElement("div");'
    + 'section.className="homes-genre-section";'
    + 'var heading=document.createElement("div");'
    + 'heading.className="homes-genre-heading";'
    + 'heading.textContent=genre+" ("+groups[genre].length+")";'
    + 'section.appendChild(heading);'
    + 'var subgrid=document.createElement("div");'
    + 'subgrid.className="homes-grid";'
    + 'for(var ei=0;ei<groups[genre].length;ei++){'
    + 'var entry=groups[genre][ei];'
    + 'subgrid.appendChild(makeItem(entry.idx,entry.cand))'
    + '}'
    + 'section.appendChild(subgrid);'
    + 'grid.appendChild(section)'
    + '}'
    + 'adoptBtn.dataset.list=JSON.stringify(list)'
    + '}'
    + 'function adoptSelectedHomesImages(){'
    + 'var adoptBtn=document.getElementById("homesAdoptBtn");'
    + 'var listJson=adoptBtn.dataset.list;if(!listJson)return;'
    + 'var list=JSON.parse(listJson);'
    + 'var keys=Object.keys(_homesSelected).map(function(k){return parseInt(k,10)}).sort(function(a,b){return a-b});'
    + 'if(keys.length===0)return;'
    + 'var added=0;'
    + 'var existingUrls={};for(var i=0;i<allImages.length;i++)existingUrls[allImages[i].url]=true;'
    + 'for(var j=0;j<keys.length;j++){'
    + 'var url=list[keys[j]].url;'
    + 'if(existingUrls[url])continue;'
    + 'allImages.push({url:url,cat:"参考画像です",checked:true,isUp:false});'
    + 'added++'
    + '}'
    + 'renderGrid();'
    + 'updateInsertOpts&&updateInsertOpts();'
    + '_homesSelected={};'
    + 'document.getElementById("homesCands").classList.remove("active");'
    + 'var statusEl=document.getElementById("homesSearchStatus");'
    + 'statusEl.textContent="✅ "+added+"件を採用しました (「参考画像です」として追加)";'
    + 'statusEl.style.color="#27ae60";'
    + '}'
    // 送信
    // 一括送信用: マスター切替で全チェックボックスをON/OFF
    + 'function toggleAllMultiSend(){'
    + 'var master=document.getElementById("multiSendMaster");'
    + 'var on=master&&master.checked;'
    + 'var cbs=document.querySelectorAll(".multi-send-cb");'
    + 'for(var i=0;i<cbs.length;i++)cbs[i].checked=on;'
    + '}'
    + 'function runAiPreprocess(){'
    + 'var btn=document.getElementById("aiPreprocessBtn");'
    + 'var st=document.getElementById("aiStatus");'
    + 'var rs=document.getElementById("aiResult");'
    + 'btn.disabled=true;btn.textContent="🤖 AI処理中...";'
    + 'st.textContent="画像分析中 (15-30秒)...";rs.innerHTML="";'
    + 'var url="' + baseUrl + '?action=ai_preprocess_property&customer="+encodeURIComponent(customerName)+"&room_id="+encodeURIComponent(roomId);'
    + 'fetch(url).then(function(r){return r.json()}).then(function(d){'
    + 'btn.disabled=false;btn.textContent="🤖 AIで整理";'
    + 'if(!d.ok){st.textContent="❌ "+(d.message||"失敗");return}'
    + 'st.textContent="✓ 整理完了。 ページを再読み込みします (5秒後)...";'
    + 'var c=d.changes||{};var html="";'
    + 'if(c.buildingName){html+="<div class=\\"change\\"><b>物件名:</b> "+escapeHtml(c.buildingName.from)+" → <b>"+escapeHtml(c.buildingName.to)+"</b></div>"}'
    + 'if(c.imageOrder){html+="<div class=\\"change\\"><b>画像並び替え:</b> "+(c.imageOrder.categories||[]).join(" / ")+"</div>"}'
    + 'if(c.warningComments&&c.warningComments.length>0){html+="<div class=\\"ai-comments\\"><b>アラート判定:</b>";'
    +   'for(var i=0;i<c.warningComments.length;i++){var w=c.warningComments[i];var cls=w.status==="clear"?"clear":"need";html+="<div class=\\"item "+cls+"\\">"+(w.status==="clear"?"✓ クリア推奨":"⚠ 要確認")+": "+escapeHtml(w.alert||"")+" — "+escapeHtml(w.comment||"")+"</div>"}'
    +   'html+="</div>"}'
    + 'if(!html)html="<div style=\\"color:#888\\">整理する項目はありませんでした</div>";'
    + 'rs.innerHTML=html;'
    + 'setTimeout(function(){window.location.reload()},5000);'
    + '}).catch(function(e){btn.disabled=false;btn.textContent="🤖 AIで整理";st.textContent="❌ 通信エラー: "+e.message})'
    + '}'
    + 'function escapeHtml(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}'
    + 'function submitApprove(){'
    + 'var btn=document.getElementById("approveBtn");'
    + 'btn.textContent="\\u2B50 \\u9001\\u4FE1\\u4E2D...";btn.style.opacity="0.6";btn.style.pointerEvents="none";'
    + 'var fd={};'
    + 'fd.action="confirm_approve";'
    + 'fd.customer=customerName;'
    + 'fd.room_id=roomId;'
    + 'if(__collect)fd.defer="1";' // カート埋め込み時は保存のみ（送信は親が一括カルーセル）
    + 'var _sc=document.getElementById("staffComment");fd.staff_comment=_sc?_sc.value:"";' // 担当者コメント（別吹き出し）
    + 'var selUrls=[];var selCats=[];'
    + 'for(var i=0;i<allImages.length;i++){if(allImages[i].checked){selUrls.push(allImages[i].url);selCats.push(allImages[i].cat||"")}}'
    + 'fd.ordered_image_urls=JSON.stringify(selUrls);'
    + 'fd.ordered_image_categories=JSON.stringify(selCats);'
    + 'fd.include_image=selUrls.length>0?"1":"0";'
    + 'var inputs=document.querySelectorAll(".detail-input,.detail-textarea");'
    + 'for(var i=0;i<inputs.length;i++){fd[inputs[i].name]=inputs[i].value}'
    // 一括送信: チェックされた他のお客様名を収集
    + 'var multiNames=[];'
    + 'var multiMaster=document.getElementById("multiSendMaster");'
    + 'if(multiMaster&&multiMaster.checked){'
    +   'var mcbs=document.querySelectorAll(".multi-send-cb");'
    +   'for(var mi=0;mi<mcbs.length;mi++){if(mcbs[mi].checked)multiNames.push(mcbs[mi].getAttribute("data-customer"))}'
    + '}'
    + 'fd.multi_send_customers=JSON.stringify(multiNames);'
    + 'google.script.run'
    + '.withSuccessHandler(function(r){'
    + 'if(__collect){'
    +   'if(r&&r.success){cartSaved(true,"");}else{cartSaved(false,(r&&r.message)||"保存失敗");}'
    +   'return;'
    + '}'
    + 'if(r.success){'
    + 'document.body.innerHTML="<div style=\\"text-align:center;padding:80px 20px;font-family:sans-serif\\"><h2 style=\\"color:#4CAF50;margin-bottom:12px\\">\\u2705 "+r.message+"</h2><p style=\\"color:#888;font-size:13px;margin-top:24px\\">\\u3053\\u306E\\u30BF\\u30D6\\u306F\\u9589\\u3058\\u3066\\u3082OK\\u3067\\u3059</p></div>";'
    + '}else{'
    + 'document.body.innerHTML="<div style=\\"text-align:center;padding:60px;font-family:sans-serif\\"><h2 style=\\"color:#e74c3c\\">\\u26A0 \\u30A8\\u30E9\\u30FC</h2><p>"+r.message+"</p><p><a href=\\"javascript:history.back()\\">\\u2190 \\u623B\\u308B</a></p></div>"'
    + '}})'
    + '.withFailureHandler(function(err){'
    + 'if(__collect){cartSaved(false,(err&&err.message)||"通信エラー");return;}'
    + 'document.body.innerHTML="<div style=\\"text-align:center;padding:60px;font-family:sans-serif\\"><h2 style=\\"color:#e74c3c\\">\\u26A0 \\u30A8\\u30E9\\u30FC</h2><p>"+err.message+"</p><p><a href=\\"javascript:history.back()\\">\\u2190 \\u623B\\u308B</a></p></div>"'
    + '})'
    + '.confirmApproveFromClient(fd);'
    + '}'
    // カート埋め込み(iframe)モード: 親とのやり取り
    + 'function cartPost(o){o.roomId=roomId;var ws=[];try{ws.push(parent)}catch(e){}try{ws.push(parent.parent)}catch(e){}try{ws.push(top)}catch(e){}for(var i=0;i<ws.length;i++){try{if(ws[i]&&ws[i]!==window)ws[i].postMessage(o,"*")}catch(e){}}}'
    + 'function cartHeight(){cartPost({type:"cart-height",height:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)});}'
    + 'function cartSaved(ok,msg){'
    +   'var b=document.getElementById("approveBtn");'
    +   'if(ok){if(b){b.textContent="\\u2705 \\u78BA\\u5B9A\\u6E08\\u307F";b.style.background="#9e9e9e";}}'
    +   'else{if(b){b.textContent="\\u26A0 \\u4FDD\\u5B58\\u5931\\u6557";b.style.opacity="1";b.style.pointerEvents="auto";b.style.background="#e74c3c";}}'
    +   'cartPost({type:"cart-saved",ok:!!ok,message:msg||""});'
    +   'setTimeout(cartHeight,200);'
    + '}'
    + 'if(__collect){'
    +   'window.addEventListener("message",function(ev){var d=ev.data||{};if(d.type==="cart-submit"){submitApprove();}});'
    +   'window.addEventListener("load",function(){setTimeout(cartHeight,300);setTimeout(cartHeight,1200);});'
    +   'try{var _b=document.getElementById("approveBtn");if(_b)_b.textContent="\\u2705 \\u3053\\u306E\\u7269\\u4EF6\\u3092\\u78BA\\u5B9A\\uFF08\\u4FDD\\u5B58\\uFF09";}catch(e){}'
    +   'try{var _ms=document.getElementById("multiSendSection")||document.getElementById("multiSendMaster");if(_ms){var box=_ms.closest?_ms.closest(".section,div"):null;if(box)box.style.display="none";}}catch(e){}'
    +   'cartPost({type:"cart-ready"});'
    + '}'
    // 初期化
    + 'renderGrid();document.getElementById("insertPos").value="0";'
    + (collectMode ? 'setTimeout(cartHeight,500);' : '')
    + '</script>';

  html += '</div></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('\u627F\u8A8D\u30D7\u30EC\u30D3\u30E5\u30FC')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== HTML: 承認プレビュー（一括） =====
function makePreviewAllHtml(props, customerName, roomIdsCsv) {
  var baseUrl = getGasBaseUrl();
  roomIdsCsv = roomIdsCsv || '';

  var drow = function(label, val) {
    if (val === undefined || val === null || val === '') return '';
    return '<div class="drow"><div class="dlabel">' + label + '</div><div class="dval">' + _esc(String(val)) + '</div></div>';
  };

  var html = '<html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;padding:16px;background:#f0f2f5}'
    + '.container{max-width:680px;margin:0 auto}'
    + 'h2{color:#333;font-size:18px;margin-bottom:16px}'
    + '.card{background:#fff;border-radius:12px;padding:16px;margin-bottom:14px;box-shadow:0 1px 6px rgba(0,0,0,0.08)}'
    + '.prop-name{font-size:17px;font-weight:bold;color:#222}'
    + '.price{font-size:20px;font-weight:bold;color:#E05252;margin:6px 0}'
    + '.price .sub{font-size:13px;color:#888;font-weight:normal;margin-left:8px}'
    + '.detail{margin:10px 0 4px}'
    + '.drow{display:flex;padding:4px 0;border-bottom:1px solid #f3f3f3;font-size:13px}'
    + '.dlabel{color:#888;width:96px;flex-shrink:0}'
    + '.dval{color:#333;flex:1;white-space:pre-wrap;word-break:break-word}'
    + '.img-tools{font-size:12px;color:#666;margin:10px 0 4px;display:flex;align-items:center;gap:14px}'
    + '.img-tools b{color:#333}'
    + '.img-tools span{color:#4CAF50;cursor:pointer;text-decoration:underline}'
    + '.img-strip{display:flex;gap:8px;overflow-x:auto;padding:6px 0 10px;-webkit-overflow-scrolling:touch}'
    + '.img-thumb{position:relative;flex:0 0 auto;width:150px}'
    + '.img-thumb img{width:150px;height:150px;object-fit:contain;background:#222;border-radius:8px;display:block;cursor:pointer;border:3px solid #4CAF50}'
    + '.img-thumb.off img{border-color:#ddd;opacity:0.45}'
    + '.img-thumb input{position:absolute;top:6px;left:6px;width:22px;height:22px;z-index:2;cursor:pointer}'
    + '.img-thumb .idx{position:absolute;top:6px;right:6px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;padding:1px 6px;border-radius:4px}'
    + '.noimg{font-size:12px;color:#999;margin-top:6px}'
    + '.actions{text-align:center;margin:20px 0}'
    + '.btn{display:inline-block;padding:14px 40px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;cursor:pointer;border:none}'
    + '.btn-approve{background:#4CAF50;color:#fff}'
    + '.customer-banner{background:#e8f5e9;border-left:4px solid #4CAF50;padding:10px 14px;border-radius:6px;margin-bottom:16px;font-size:15px;color:#1b5e20;font-weight:bold}'
    + '.lb{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.9);z-index:200;justify-content:center;align-items:center}'
    + '.lb.active{display:flex}'
    + '.lb img{max-width:92%;max-height:88vh;object-fit:contain}'
    + '.lb .close{position:fixed;top:14px;right:18px;color:#fff;font-size:34px;cursor:pointer;z-index:201}'
    + '</style></head><body><div class="container">'
    + '<h2>\uD83D\uDD0D \u4E00\u62EC\u627F\u8A8D\u30D7\u30EC\u30D3\u30E5\u30FC (' + props.length + '\u4EF6)</h2>'
    + '<div class="customer-banner">\uD83D\uDC64 ' + _esc(customerName || '') + ' \u69D8 \u3054\u5E0C\u671B\u306E\u7269\u4EF6</div>';

  for (var i = 0; i < props.length; i++) {
    var p = props[i];
    var rentMan = p.rent ? _fmtMan(p.rent) : '0';
    var mgmt = p.managementFee ? (_fmtMan(p.managementFee) + '\u4E07\u5186') : '';
    var rid = String(p._roomId);
    var floorDisp = p.floorText || (p.floor ? (p.floor + '\u968E') : '');

    html += '<div class="card">'
      + '<div class="prop-name">' + (i+1) + '. ' + _esc(p.buildingName) + (p.roomNumber ? ' ' + _esc(p.roomNumber) : '') + '</div>'
      + '<div class="price">' + rentMan + '\u4E07\u5186' + (mgmt ? '<span class="sub">\u7BA1\u7406\u8CBB ' + mgmt + '</span>' : '') + '</div>';

    // \u8A73\u7D30\u30C6\u30FC\u30D6\u30EB\uFF08\u666E\u901A\u306E\u627F\u8A8D\u30DA\u30FC\u30B8\u3068\u540C\u7B49\u306E\u60C5\u5831\u91CF\uFF09
    html += '<div class="detail">'
      + drow('\u6577\u91D1', p.deposit)
      + drow('\u793C\u91D1', p.keyMoney)
      + drow('\u6577\u5F15', p.shikibiki)
      + drow('\u9593\u53D6\u308A', p.layout)
      + drow('\u5C02\u6709\u9762\u7A4D', p.area ? (p.area + 'm\u00B2') : '')
      + drow('\u7BC9\u5E74\u6570', p.buildingAge)
      + drow('\u968E', floorDisp)
      + drow('\u69CB\u9020', p.structure)
      + drow('\u7DCF\u6238\u6570', p.totalUnits)
      + drow('\u65B9\u89D2', p.sunlight)
      + drow('\u6700\u5BC4\u99C5', p.stationInfo)
      + drow('\u305D\u306E\u4ED6\u99C5', (p.otherStations && p.otherStations.length) ? p.otherStations.join(' / ') : '')
      + drow('\u6240\u5728\u5730', p.address)
      + drow('\u5165\u5C45\u53EF\u80FD\u65E5', p.moveInDate)
      + drow('\u5951\u7D04\u5F62\u614B', p.leaseType)
      + drow('\u5951\u7D04\u671F\u9593', p.contractPeriod)
      + drow('\u66F4\u65B0', p.renewalInfo)
      + drow('\u66F4\u65B0\u6599', p.renewalFee)
      + drow('\u89E3\u7D04\u4E88\u544A', p.cancellationNotice)
      + drow('\u706B\u707D\u4FDD\u967A', p.fireInsurance)
      + drow('\u4FDD\u8A3C', p.guaranteeInfo)
      + drow('\u9375\u4EA4\u63DB', p.keyExchangeFee)
      + drow('\u30AF\u30EA\u30FC\u30CB\u30F3\u30B0', p.cleaningFee)
      + drow('24h\u30B5\u30DD\u30FC\u30C8', p.supportFee24h)
      + drow('\u99D0\u8ECA\u5834', p.parkingFee)
      + drow('\u30D5\u30EA\u30FC\u30EC\u30F3\u30C8', p.freeRent)
      + drow('\u8A2D\u5099', p.facilities)
      + '</div>';

    // \u753B\u50CF\uFF08\u5168\u679A\u6570\u3092\u6A2A\u30B9\u30AF\u30ED\u30FC\u30EB\u8868\u793A\u30FB1\u679A\u305A\u3064\u9078\u629E\u53EF\u30FB\u30BF\u30C3\u30D7\u3067\u62E1\u5927\uFF09
    var imgs = p.imageUrls && p.imageUrls.length > 0 ? p.imageUrls : (p.imageUrl ? [p.imageUrl] : []);
    if (imgs.length > 0) {
      html += '<div class="img-tools"><b>\u753B\u50CF ' + imgs.length + '\u679A</b>\uFF08\u9001\u308B\u753B\u50CF\u3092\u9078\u629E\uFF09'
        + '<span onclick="selRoom(\'' + rid + '\',true)">\u5168\u9078\u629E</span>'
        + '<span onclick="selRoom(\'' + rid + '\',false)">\u5168\u89E3\u9664</span></div>';
      html += '<div class="img-strip">';
      for (var k = 0; k < imgs.length; k++) {
        html += '<div class="img-thumb">'
          + '<input type="checkbox" class="img-cb" data-room="' + rid + '" data-idx="' + k + '" checked onchange="tog(this)">'
          + '<span class="idx">' + (k+1) + '</span>'
          + '<img src="' + _esc(imgs[k]) + '" onclick="lb(this.src)">'
          + '</div>';
      }
      html += '</div>';
    } else {
      html += '<div class="noimg">\u753B\u50CF\u306A\u3057</div>';
    }

    html += '</div>';
  }

  html += '<div class="actions">'
    + '<a id="approveAllBtn" class="btn btn-approve" href="#" onclick="submitAll();return false;">\u2705 \u5168\u3066\u627F\u8A8D\u3057\u3066LINE\u9001\u4FE1</a>'
    + '</div>';

  html += '<div class="lb" id="lb" onclick="lbClose()"><span class="close">\u00D7</span><img id="lbimg" src=""></div>';

  html += '<script>'
    + 'function tog(cb){cb.parentNode.classList.toggle("off",!cb.checked);}'
    + 'function selRoom(rid,on){var cbs=document.querySelectorAll(\'.img-cb[data-room="\'+rid+\'"]\');for(var i=0;i<cbs.length;i++){cbs[i].checked=on;tog(cbs[i]);}}'
    + 'function lb(src){document.getElementById("lbimg").src=src;document.getElementById("lb").classList.add("active");}'
    + 'function lbClose(){document.getElementById("lb").classList.remove("active");}'
    + 'function submitAll(){'
    + 'var btn=document.getElementById("approveAllBtn");'
    + 'btn.textContent="\\u2B50 \\u9001\\u4FE1\\u4E2D...";btn.style.opacity="0.6";btn.style.pointerEvents="none";'
    + 'var cbs=document.querySelectorAll(".img-cb");var map={};'
    + 'for(var i=0;i<cbs.length;i++){var rid=cbs[i].getAttribute("data-room");if(!map[rid])map[rid]=[];if(cbs[i].checked)map[rid].push(cbs[i].getAttribute("data-idx"));}'
    + 'var image_map={};for(var k in map){image_map[k]=map[k].join(",");}'
    + 'var fd={action:"confirm_approve_all",customer:' + JSON.stringify(customerName) + ',image_map:JSON.stringify(image_map),room_ids:' + JSON.stringify(roomIdsCsv) + '};'
    + 'google.script.run'
    + '.withSuccessHandler(function(r){'
    + 'if(r.success){'
    + 'document.body.innerHTML="<div style=\\"text-align:center;padding:80px 20px;font-family:sans-serif\\"><h2 style=\\"color:#4CAF50;margin-bottom:12px\\">\\u2705 "+r.message+"</h2><p style=\\"color:#888;font-size:13px;margin-top:24px\\">\\u3053\\u306E\\u30BF\\u30D6\\u306F\\u9589\\u3058\\u3066\\u3082OK\\u3067\\u3059</p></div>";'
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

// ===== HTML: カート一括承認コンテナ（普通の承認ページを物件ごとに iframe 埋め込み） =====
function makeApprovalCartHtml(props, customerName, roomIdsCsv) {
  var baseUrl = getGasBaseUrl();
  var roomIds = [];
  for (var i = 0; i < props.length; i++) roomIds.push(String(props[i]._roomId));

  var html = '<html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;padding:0;background:#eceff1}'
    + '.bar{position:sticky;top:0;z-index:10;background:#1b5e20;color:#fff;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:10px;box-shadow:0 2px 6px rgba(0,0,0,.2)}'
    + '.bar .ttl{font-size:15px;font-weight:bold}'
    + '.bar .sub{font-size:12px;opacity:.9}'
    + '.sendbtn{background:#4CAF50;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-size:14px;font-weight:bold;cursor:pointer;white-space:nowrap}'
    + '.sendbtn:disabled{opacity:.5;cursor:not-allowed}'
    + '.wrap{max-width:680px;margin:0 auto;padding:12px}'
    + '.pcard{background:#fff;border-radius:10px;margin-bottom:14px;overflow:hidden;box-shadow:0 1px 6px rgba(0,0,0,.08)}'
    + '.pcard .head{font-size:13px;font-weight:bold;color:#555;padding:8px 12px;background:#f5f5f5;border-bottom:1px solid #eee}'
    + '.pcard iframe{width:100%;border:none;display:block;height:1200px;background:#fff}'
    + '.status{font-size:12px;color:#fff;opacity:.95}'
    + '</style></head><body>'
    + '<div class="bar"><div><div class="ttl">🛒 一括承認（' + props.length + '件）</div>'
    + '<div class="sub">' + _esc(customerName || '') + ' 様 / 各物件を編集・画像調整して「確定」→ 全部確定したら送信</div></div>'
    + '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">'
    + '<button id="sendBtn" class="sendbtn" onclick="sendAll()" disabled>✅ 確定した物件をカルーセルで送信</button>'
    + '<span id="status" class="status"></span></div></div>'
    + '<div class="wrap">';

  for (var j = 0; j < props.length; j++) {
    var p = props[j];
    var rid = String(p._roomId);
    var src = baseUrl + '?action=approve&customer=' + encodeURIComponent(customerName)
      + '&room_id=' + encodeURIComponent(rid) + '&collect=1';
    html += '<div class="pcard">'
      + '<div class="head">' + (j+1) + '. ' + _esc(p.buildingName || '') + (p.roomNumber ? ' ' + _esc(p.roomNumber) : '') + '</div>'
      + '<iframe id="if_' + _esc(rid) + '" data-room="' + _esc(rid) + '" src="' + _esc(src) + '"></iframe>'
      + '</div>';
  }

  html += '</div>'
    + '<script>'
    + 'var ROOMIDS=' + JSON.stringify(roomIds) + ';'
    + 'var CUSTOMER=' + JSON.stringify(customerName) + ';'
    + 'var expected=ROOMIDS.length;var sending=false;var lastSaved=[];'
    + 'function setStatus(t){document.getElementById("status").textContent=t||"";}'
    + 'function ifByRoom(rid){return document.getElementById("if_"+rid);}'
    // 高さ自動調整(best effort): 子から届けば反映。届かなくても固定高+内部スクロールで動作。
    + 'window.addEventListener("message",function(ev){var d=ev.data||{};if(d&&d.type==="cart-height"&&d.roomId){var f=ifByRoom(d.roomId);if(f&&d.height)f.style.height=(d.height+24)+"px";}});'
    // サーバーへポーリング: 各物件が「確定」(defer保存)されたかをキャッシュ経由で確認
    + 'function poll(){'
    +   'if(sending)return;'
    +   'google.script.run.withSuccessHandler(function(csv){'
    +     'lastSaved=(csv||"").split(",").filter(function(s){return s;});'
    +     'setStatus("確定 "+lastSaved.length+"/"+expected+"件");'
    +     'var b=document.getElementById("sendBtn");b.disabled=(lastSaved.length===0);'
    +     'if(!sending)setTimeout(poll,3000);'
    +   '}).withFailureHandler(function(){if(!sending)setTimeout(poll,5000);})'
    +   '.getCartSaved(CUSTOMER, ROOMIDS.join(","));'
    + '}'
    + 'poll();'
    + 'function sendAll(){'
    +   'if(sending)return;'
    +   'google.script.run.withSuccessHandler(function(csv){'
    +     'var saved=(csv||"").split(",").filter(function(s){return s;});'
    +     'if(saved.length===0){alert("まだ確定された物件がありません。各物件で編集後「確定」を押してください。");return;}'
    +     'if(saved.length<expected){if(!confirm(expected+"件中 "+saved.length+"件が確定済みです。確定した "+saved.length+"件だけ送信しますか？"))return;}'
    +     'sending=true;var b=document.getElementById("sendBtn");b.disabled=true;b.textContent="\\u2B50 \\u9001\\u4FE1\\u4E2D...";setStatus("LINEに送信中...("+saved.length+"件)");'
    +     'google.script.run.withSuccessHandler(function(r){'
    +       'if(r&&r.success){document.body.innerHTML="<div style=\\"text-align:center;padding:80px 20px;font-family:sans-serif\\"><h2 style=\\"color:#4CAF50\\">\\u2705 "+(r.count||saved.length)+"\\u4EF6\\u3092\\u304A\\u5BA2\\u3055\\u3093\\u306B\\u9001\\u4FE1\\u3057\\u307E\\u3057\\u305F</h2><p style=\\"color:#888;font-size:13px;margin-top:20px\\">1\\u3064\\u306E\\u30AB\\u30EB\\u30FC\\u30BB\\u30EB\\u3067\\u5C4A\\u304D\\u307E\\u3059\\u3002\\u3053\\u306E\\u30BF\\u30D6\\u306F\\u9589\\u3058\\u3066OK\\u3067\\u3059\\u3002</p></div>";}'
    +       'else{setStatus("送信失敗: "+((r&&r.message)||""));b.disabled=false;b.textContent="\\u2705 \\u518D\\u9001\\u4FE1";sending=false;setTimeout(poll,1000);}'
    +     '}).withFailureHandler(function(err){setStatus("送信エラー: "+(err&&err.message));b.disabled=false;b.textContent="\\u2705 \\u518D\\u9001\\u4FE1";sending=false;setTimeout(poll,1000);})'
    +     '.sendCartCarousel(CUSTOMER, saved.join(","));'
    +   '}).withFailureHandler(function(err){alert("状態取得に失敗しました: "+(err&&err.message));})'
    +   '.getCartSaved(CUSTOMER, ROOMIDS.join(","));'
    + '}'
    + '</script>'
    + '</body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('一括承認（' + props.length + '件）')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== カート一括承認: 各物件が「確定」(defer保存)済みかをキャッシュで返す（コンテナのポーリング用） =====
function getCartSaved(customerName, roomIdsCsv) {
  try {
    var roomIds = String(roomIdsCsv || '').split(',').filter(function(s) { return s; });
    if (!customerName || roomIds.length === 0) return '';
    var cache = CacheService.getScriptCache();
    var keys = [];
    for (var i = 0; i < roomIds.length; i++) keys.push('cartsave_' + customerName + '_' + roomIds[i]);
    var got = cache.getAll(keys) || {};
    var saved = [];
    for (var j = 0; j < roomIds.length; j++) {
      if (got['cartsave_' + customerName + '_' + roomIds[j]]) saved.push(roomIds[j]);
    }
    return saved.join(',');
  } catch (e) { return ''; }
}

// ===== カート一括承認: 保存済みの全物件を1つのFlexカルーセルでお客さんに送信 =====
function sendCartCarousel(customerName, roomIdsCsv) {
  try {
    if (!customerName) return { success: false, message: '顧客名がありません' };
    var roomIds = String(roomIdsCsv || '').split(',').filter(function(s) { return s; });
    if (roomIds.length === 0) return { success: false, message: '対象物件がありません' };
    var lineUserId = findLineUserId(customerName);
    if (!lineUserId) return { success: false, message: customerName + ' さんのLINEユーザーが見つかりません' };
    var rows = _findRowsByRoomIdsAnyStatus_(customerName, roomIds);
    if (!rows.length) return { success: false, message: '対象の物件が見つかりません' };

    var batchCustStations = _getCustomerSelectedStations_(customerName);
    var bubbles = [];
    var sentTargets = [];
    for (var i = 0; i < rows.length; i++) {
      var prop = rowToProperty(rows[i].values);
      var rid = String(rows[i].values[2]);
      // 承認ページで保存した選択画像を優先（無ければ全画像）
      var sel = (prop.selectedImageUrls && prop.selectedImageUrls.length > 0) ? prop.selectedImageUrls
        : (prop.imageUrls && prop.imageUrls.length > 0 ? prop.imageUrls : (prop.imageUrl ? [prop.imageUrl] : []));
      var selCats = prop.selectedImageCategories || [];
      var plainUrl = 'https://form.ehomaki.com/property.html?customer=' + encodeURIComponent(customerName) + '&room_id=' + rid;
      var hashUrl = buildViewUrl(customerName, rid, prop, []);
      var minimalUrl = buildMinimalViewUrl(customerName, rid, prop);
      var viewUrl = hashUrl.length <= 1000 ? hashUrl : (minimalUrl.length <= 1000 ? minimalUrl : plainUrl);
      cachePropertyImages(customerName, rid, sel, selCats);
      // 承認ページで入力された担当者コメント（defer保存時にキャッシュ）
      var staffComment = '';
      try { staffComment = CacheService.getScriptCache().get('cartcomment_' + customerName + '_' + rid) || ''; } catch (eGc) {}
      var flex = buildPropertyFlex(prop, {
        includeImage: sel.length > 0,
        heroImageUrls: sel,
        viewUrl: viewUrl,
        customerStations: batchCustStations,
        staffComment: staffComment
      });
      if (flex && flex.contents) bubbles.push(flex.contents);
      sentTargets.push({ rowIndex: rows[i].rowIndex, prop: prop, viewUrl: viewUrl });
    }

    var messages = _splitBubblesIntoCarousels_(bubbles, 'お探しの物件が見つかりました');
    for (var m = 0; m < messages.length; m += 5) {
      pushMessage(lineUserId, messages.slice(m, m + 5));
    }
    for (var s = 0; s < sentTargets.length; s++) {
      updatePendingStatus(sentTargets[s].rowIndex, 'sent', sentTargets[s].viewUrl);
      addToSeenSheet(customerName, sentTargets[s].prop);
    }
    // 確定マーカーをクリア（コンテナのポーリングをリセット）
    try {
      var clearKeys = [];
      for (var ck = 0; ck < roomIds.length; ck++) {
        clearKeys.push('cartsave_' + customerName + '_' + roomIds[ck]);
        clearKeys.push('cartcomment_' + customerName + '_' + roomIds[ck]);
      }
      CacheService.getScriptCache().removeAll(clearKeys);
    } catch (eClr) {}
    return { success: true, count: sentTargets.length };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ===== HTML: お客さん向け物件資料ページ =====
function makeViewHtml(prop) {
  // 1万未満は「1,100円」、1万以上は「14万円」のように適切に表示
  var rentText = prop.rent ? _fmtPriceFull(prop.rent) : '0円';
  var mgmtText = prop.managementFee ? _fmtPriceFull(prop.managementFee) : '0円';

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
    + '<div class="price-main">' + rentText + '<span style="font-size:16px">/\u6708</span></div>'
    + '<div class="price-sub">\u7BA1\u7406\u8CBB ' + mgmtText + ' | \u6577\u91D1 ' + _esc(prop.deposit || '0') + ' | \u793C\u91D1 ' + _esc(prop.keyMoney || '0') + '</div>'
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
      html += '<div class="row"><span class="row-label">' + costRows[i][0] + '</span><span class="row-value">' + _esc(_normalizeYenInText(costRows[i][1])).replace(/\n/g, '<br>') + '</span></div>';
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

  // \u78BA\u8A8D\u4E8B\u9805\uFF08\u8B66\u544A\u30A2\u30E9\u30FC\u30C8\uFF09 \u2014 \u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u5411\u3051
  if (prop.warningsText) {
    html += '<div class="section"><div class="section-title">\u26A0\uFE0F \u78BA\u8A8D\u4E8B\u9805</div>';
    html += '<div style="background:#fff8e1;border-left:4px solid #f9a825;padding:10px 14px;border-radius:6px;font-size:13px;white-space:pre-wrap;color:#5d4037">' + _esc(prop.warningsText) + '</div>';
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
  // 「0.33万円」など1万円未満の不自然な万円表記を「3,300円」に正規化 (1万以上は維持)
  v = _normalizeYenInText(v);
  return '<div class="detail-row"><span class="detail-label">' + label + '</span>'
    + '<input class="detail-input" name="' + name + '" value="' + _esc(v) + '"></div>';
}

function _textareaRow(label, name, value) {
  var v = (value !== undefined && value !== null && String(value) !== '') ? String(value) : '\u30FC';
  v = _normalizeYenInText(v);
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

// ===== Claude AI 自動承認 =====

function autoApprovePendingProperties() {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY が未設定です。GASエディタ→プロジェクトの設定→スクリプトプロパティに追加してください。');
    return { processed: 0, error: 'API key not set' };
  }

  if (isDryRun_()) {
    console.log('[DRY_RUN] autoApprovePendingProperties skipped');
    return { processed: 0, dryRun: true };
  }

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (!sheet) return { processed: 0 };

  var data = sheet.getDataRange().getValues();
  var pendingRows = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][10]) === 'pending') {
      pendingRows.push({ rowIndex: i + 1, values: data[i] });
    }
  }

  if (pendingRows.length === 0) return { processed: 0 };

  var processed = 0;
  var approved = 0;
  var rejected = 0;
  var errors = [];
  for (var j = 0; j < pendingRows.length; j++) {
    var row = pendingRows[j];
    var customerName = String(row.values[0]);
    var roomId = String(row.values[2]);
    var prop = rowToProperty(row.values);

    var lineUserId = findLineUserId(customerName);
    if (!lineUserId) {
      console.log('Auto-approve skip: ' + customerName + ' (LINE ID not found)');
      continue;
    }

    var criteria = loadCustomerCriteriaByName(customerName);

    try {
      var evaluation = _evaluatePropertyWithClaude(apiKey, prop, criteria);

      if (evaluation.approve) {
        _autoApproveSingleProperty(customerName, roomId, row, prop, lineUserId);
        approved++;
        console.log('Auto-approved: ' + prop.buildingName + ' → ' + customerName);
      } else {
        updatePendingStatus(row.rowIndex, 'auto_rejected');
        console.log('Auto-rejected: ' + prop.buildingName + ' → ' + customerName + ' (' + evaluation.reason + ')');
        rejected++;
      }
      processed++;
    } catch (err) {
      console.error('Auto-approve error for ' + prop.buildingName + ': ' + err.message);
      errors.push(customerName + '/' + prop.buildingName + ': ' + err.message);
    }
  }

  console.log('Auto-approve done: processed=' + processed + ' approved=' + approved + ' rejected=' + rejected);
  return { processed: processed, approved: approved, rejected: rejected, errors: errors };
}

function _evaluatePropertyWithClaude(apiKey, prop, criteria) {
  var model = PropertiesService.getScriptProperties().getProperty('CLAUDE_MODEL') || 'claude-haiku-4-5-20251001';

  var propertyInfo = '物件名: ' + (prop.buildingName || '不明') + '\n'
    + '賃料: ' + (prop.rent ? (prop.rent / 10000) + '万円' : '不明') + '\n'
    + '管理費: ' + (prop.managementFee ? (prop.managementFee / 10000) + '万円' : '0円') + '\n'
    + '間取り: ' + (prop.layout || '不明') + '\n'
    + '面積: ' + (prop.area ? prop.area + 'm²' : '不明') + '\n'
    + '最寄り駅: ' + (prop.stationInfo || '不明') + '\n'
    + '住所: ' + (prop.address || '不明') + '\n'
    + '築年数: ' + (prop.buildingAge || '不明') + '\n'
    + '敷金: ' + (prop.deposit || 'なし') + '\n'
    + '礼金: ' + (prop.keyMoney || 'なし') + '\n'
    + '階: ' + (prop.floorText || '不明') + '\n'
    + '構造: ' + (prop.structure || '不明') + '\n';

  if (prop.warningsText) {
    propertyInfo += '警告: ' + prop.warningsText + '\n';
  }
  if (prop.leaseType) {
    propertyInfo += '契約種別: ' + prop.leaseType + '\n';
  }
  if (prop.facilities) {
    propertyInfo += '設備: ' + prop.facilities + '\n';
  }

  var criteriaInfo = '（検索条件なし）';
  if (criteria) {
    criteriaInfo = '希望賃料上限: ' + (criteria.rent_max || '指定なし') + '\n'
      + '希望間取り: ' + (criteria.layouts && criteria.layouts.length > 0 ? criteria.layouts.join(', ') : '指定なし') + '\n'
      + '希望面積: ' + (criteria.area_min || '指定なし') + '\n'
      + '希望駅: ' + (criteria.selectedStations ? Object.values(criteria.selectedStations).flat().join(', ') : '指定なし') + '\n'
      + '徒歩: ' + (criteria.walk || '指定なし') + '\n'
      + '築年数: ' + (criteria.building_age || '指定なし') + '\n'
      + '設備: ' + (criteria.equipment && criteria.equipment.length > 0 ? criteria.equipment.join(', ') : '指定なし') + '\n';
  }

  var systemPrompt = 'あなたは不動産仲介会社のアシスタントです。物件データの品質と顧客条件との適合度を評価してください。\n\n'
    + '承認基準:\n'
    + '1. 物件名・賃料・間取り・面積が存在すること（必須項目）\n'
    + '2. 賃料が0円や異常に低い値（1万円未満）でないこと\n'
    + '3. 警告テキストに重大な問題がないこと（例: 取引不可、掲載終了 等）\n'
    + '4. 顧客の検索条件がある場合、大きく逸脱していないこと（賃料が上限の1.2倍以内、間取りや面積が概ね合致）\n'
    + '5. 定期借家の場合でも承認する（顧客に判断を委ねる）\n\n'
    + '軽微な不足（築年数不明、階数不明など）は承認してよい。\n'
    + '必ず以下のJSON形式のみで回答してください:\n'
    + '{"approve": true, "reason": "承認理由"}\n'
    + 'または\n'
    + '{"approve": false, "reason": "却下理由"}';

  var userMessage = '【物件情報】\n' + propertyInfo + '\n【顧客の検索条件】\n' + criteriaInfo;

  var payload = {
    model: model,
    max_tokens: 200,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  };

  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  if (code !== 200) {
    throw new Error('Claude API error: ' + code + ' ' + resp.getContentText().substring(0, 200));
  }

  var result = JSON.parse(resp.getContentText());
  var text = '';
  for (var k = 0; k < result.content.length; k++) {
    if (result.content[k].type === 'text') {
      text += result.content[k].text;
    }
  }

  var jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn('Claude response not JSON: ' + text);
    return { approve: true, reason: 'JSON解析失敗のためデフォルト承認' };
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.warn('Claude JSON parse error: ' + text);
    return { approve: true, reason: 'JSON解析失敗のためデフォルト承認' };
  }
}

function _autoApproveSingleProperty(customerName, roomId, row, prop, lineUserId) {
  var imageUrls = prop.selectedImageUrls || prop.imageUrls || [];
  var imageCategories = prop.selectedImageCategories || prop.imageCategories || [];
  if (imageUrls.length === 0 && prop.imageUrl) {
    imageUrls = [prop.imageUrl];
    imageCategories = [''];
  }
  imageUrls = imageUrls.filter(function(u) {
    return u && typeof u === 'string' && u.indexOf('https://') === 0;
  });

  if (imageUrls.length > 0) {
    saveSelectedImages(row.rowIndex, imageUrls, imageCategories);
  }

  var plainUrl = 'https://form.ehomaki.com/property.html?customer=' + encodeURIComponent(customerName) + '&room_id=' + roomId;
  var hashUrl = buildViewUrl(customerName, roomId, prop, []);
  var minimalUrl = buildMinimalViewUrl(customerName, roomId, prop);
  var viewUrl = hashUrl.length <= 1000 ? hashUrl : (minimalUrl.length <= 1000 ? minimalUrl : plainUrl);

  cachePropertyImages(customerName, roomId, imageUrls, imageCategories);

  var flex = buildPropertyFlex(prop, {
    includeImage: imageUrls.length > 0,
    heroImageUrls: imageUrls.slice(0, 4),
    viewUrl: viewUrl,
    customerStations: _getCustomerSelectedStations_(customerName)
  });

  pushMessage(lineUserId, [flex]);
  updatePendingStatus(row.rowIndex, 'sent', viewUrl);
  addToSeenSheet(customerName, prop);
}

function setupAutoApprovalTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'autoApprovePendingProperties') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger('autoApprovePendingProperties')
    .timeBased()
    .everyMinutes(5)
    .create();
  console.log('Auto-approval trigger set: every 5 minutes');
}

function removeAutoApprovalTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'autoApprovePendingProperties') {
      ScriptApp.deleteTrigger(existing[i]);
      removed++;
    }
  }
  console.log('Removed ' + removed + ' auto-approval trigger(s)');
}
