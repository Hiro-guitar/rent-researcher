/**
 * Code.gs - メインエントリーポイント
 *
 * LINE Webhook (doPost) と オペレーター用 API (doGet) を処理する。
 *
 * ルーティングロジック:
 *   1. Postback イベント:
 *      - 検索条件フロー関連:
 *          reason|, action=back, notes_skip, confirm_ok, confirm_redo
 *        → ConversationFlow
 *      - 既存ボット関連 (apply|, type|, nation|, movein_date) → ExistingBot
 *   2. テキストメッセージ:
 *      - 「条件登録」→ 検索条件フロー開始
 *      - 「条件変更」→ 既存条件を読み込んで条件選択ページへ直接遷移
 *      - 検索条件フロー中のテキスト入力（名前/理由自由入力/その他ご希望）→ ConversationFlow
 *      - 既存ボットのテキスト入力（名前/フリガナ/メール）→ ExistingBot
 *      - 数字入力 → 専有面積検索（ExistingBot）
 *   3. Follow イベント → ウェルカムメッセージ
 */

function doPost(e) {
  // --- 承認フォーム POST（編集値付き） ---
  // フォームPOSTの場合はエラー時もHTMLを返す必要がある
  if (e.parameter && e.parameter.action === 'confirm_approve') {
    try {
      return handleConfirmApprove(e);
    } catch (err) {
      console.error('confirm_approve Error: ' + err.message + '\nStack: ' + err.stack);
      return HtmlService.createHtmlOutput(
        '<html><body style="font-family:sans-serif;text-align:center;padding:40px;">' +
        '<h2 style="color:#e74c3c;">⚠ エラーが発生しました</h2>' +
        '<p>' + err.message + '</p>' +
        '<p><a href="javascript:history.back()">← 戻る</a></p>' +
        '</body></html>'
      ).setTitle('エラー');
    }
  }

  try {
    const json = JSON.parse(e.postData.contents);

    // --- REINS Chrome拡張からのPOST ---
    if (json.action === 'add_reins_property') {
      return handleAddReinsProperty(json);
    }

    // --- 駅名解決失敗ログ ---
    if (json.action === 'log_unresolved_stations') {
      return handleLogUnresolvedStations(json);
    }

    const event = json.events[0];
    if (!event) return;

    const replyToken = event.replyToken;
    const userId = event.source.userId;

    // ── やり取り時刻を記録（友だち一覧の並び替えに使用） ──
    if (event.type === 'message' || event.type === 'postback') {
      recordLineActivity(userId);
    }

    // ── Follow イベント（友だち追加時）──
    // 挨拶メッセージは LINE Manager 側で設定しているため、ここでは何も返さない
    if (event.type === 'follow') {
      return;
    }

    // ── Postback イベント ──
    if (event.type === 'postback') {
      const data = event.postback.data;
      const state = getState(userId);

      // 条件登録ボタン（遅延返信Flexのpostback）
      if (data === '条件登録') {
        startSearchFlow(replyToken, userId);
        return;
      }

      // 検索条件フロー関連の postback（datetimepicker用にeventも渡す）
      if (handleSearchFlowPostback(replyToken, userId, data, state, event)) return;

      // 既存ボット関連の postback
      if (handleExistingPostback(replyToken, userId, data, state, event)) return;

      return;
    }

    // ── テキストメッセージ ──
    if (event.type === 'message' && event.message.type === 'text') {
      const message = event.message.text.trim();
      const state = getState(userId);

      // コマンド: 条件登録
      if (message === '条件登録' || message === 'じょうけんとうろく') {
        startSearchFlow(replyToken, userId);
        return;
      }

      // コマンド: お気に入り一覧
      if (message === 'お気に入り' || message === 'おきにいり') {
        handleFavoritesCommand(replyToken, userId);
        return;
      }

      // コマンド: 使い方
      if (message === '使い方' || message === 'つかいかた') {
        handleHelpCommand(replyToken, userId);
        return;
      }

      // コマンド: 空室確認 → state を WAITING_VACANCY にして案内文返信
      if (message === '空室確認' || message === 'くうしつかくにん') {
        saveState(userId, { step: STEPS.WAITING_VACANCY, data: {} });
        replyMessage(replyToken, [textMsg(
          '空室確認を承ります。\n\n' +
          '以下のいずれかをお送りください：\n\n' +
          '　・物件名（例: ○○マンション101）\n' +
          '　・所在地（例: 渋谷区神宮前）\n' +
          '　・最寄駅（例: 新宿駅）\n' +
          '　・専有面積（例: 25.5）\n' +
          '　・募集ページのURL\n\n' +
          '※空室状況はスタッフが確認の上、改めてご返信する場合がございます。\n\n' +
          '中止する場合は「キャンセル」とお送りください。'
        )]);
        return;
      }

      // 空室確認モード中: 検索ロジックに渡す
      if (state.step === STEPS.WAITING_VACANCY) {
        if (message === 'キャンセル' || message === 'きゃんせる') {
          clearState(userId);
          replyMessage(replyToken, [textMsg('空室確認を終了しました。')]);
          return;
        }
        handleVacancyQuery(replyToken, userId, message);
        return;
      }

      // 類似物件不要（遅延返信Flexの「いいえ」ボタン）
      if (message === '類似物件不要') {
        replyMessage(replyToken, [
          textMsg('承知いたしました。\nまたお部屋探しの際はお気軽にお声がけください。')
        ]);
        return;
      }

      // コマンド: 条件変更
      if (message === '条件変更' || message === 'じょうけんへんこう') {
        startChangeFlow(replyToken, userId);
        return;
      }

      // コマンド: キャンセル（フロー外でも受け付ける）
      if ((message === 'キャンセル' || message === 'きゃんせる') && state.step !== STEPS.IDLE) {
        clearState(userId);
        replyMessage(replyToken, [textMsg('操作をキャンセルしました。')]);
        return;
      }

      // 検索条件フローのテキスト処理
      if (handleSearchFlowText(replyToken, userId, message, state)) return;

      // 既存ボットのテキスト処理（申込フロー + 面積検索）
      if (handleExistingText(replyToken, userId, message, state)) return;

      return;
    }

  } catch (err) {
    console.error('doPost Error: ' + err.message + '\nStack: ' + err.stack);
  }
}

/**
 * doGet - オペレーター用 API エンドポイント / 条件選択ページ
 */
function doGet(e) {
  // 手動実行時（eが未定義）→ 権限承認トリガー用
  if (!e || !e.parameter) {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok', message: 'Auth test passed', sheets: ss.getSheets().length }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // LIFF経由の場合、クエリパラメータがliff.stateに格納されるため展開する
  if (e.parameter['liff.state']) {
    var liffState = e.parameter['liff.state'];
    var pairs = liffState.replace(/^\?/, '').split('&');
    for (var i = 0; i < pairs.length; i++) {
      var kv = pairs[i].split('=');
      if (kv.length === 2 && !e.parameter[kv[0]]) {
        e.parameter[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]);
      }
    }
  }

  const action = e.parameter.action;

  if (action === 'status') {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // --- REINS Chrome拡張用エンドポイント ---
  if (action === 'get_criteria') {
    return handleGetCriteria(e);
  }

  if (action === 'get_seen_ids') {
    return handleGetSeenIds(e);
  }

  // --- 物件承認ハンドラー ---
  if (action === 'approve') {
    return handleApprove(e);
  }

  if (action === 'approve_all') {
    return handleApproveAll(e);
  }

  if (action === 'skip') {
    return handleSkip(e);
  }
    if (action === 'confirm_approve') {
      return handleConfirmApprove(e);
    }

    if (action === 'confirm_approve_all') {
      return handleConfirmApproveAll(e);
    }

    if (action === 'view') {
      return handlePropertyView(e);
    }

        if (action === 'view_api') {
                return handlePropertyViewApi(e);
        }

    if (action === 'images_api') {
      return handlePropertyImagesApi(e);
    }

    if (action === 'track_view') {
      return handleTrackView(e);
    }

    if (action === 'property_action') {
      return handlePropertyAction(e);
    }

    if (action === 'check_action') {
      return handleCheckAction(e);
    }

  // ── 総合条件選択Webページ ──
  if (action === 'selectCriteria' || action === 'selectRoutes') {
    const userId = e.parameter.userId;
    if (!userId) {
      return HtmlService.createHtmlOutput(
        '<html><body style="text-align:center;padding:40px;font-family:sans-serif;">' +
        '<p>パラメータが不正です。</p></body></html>'
      ).setTitle('エラー')
       .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }
    const state = getState(userId);
    // CRITERIA_SELECT以降のステップならアクセス可能（再編集対応）
    if (!isCriteriaPageAllowed(state.step)) {
      return HtmlService.createHtmlOutput(
        '<html><body style="text-align:center;padding:40px;font-family:sans-serif;">' +
        '<h3>このページは現在使用できません</h3>' +
        '<p style="color:#666;margin-top:12px;">LINEに戻って操作をやり直してください。</p></body></html>'
      ).setTitle('条件選択')
       .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }
    const d = state.data || {};
    const template = HtmlService.createTemplateFromFile('RouteSelectPage');
    template.userId = userId;
    template.routeCompanies = JSON.stringify(ROUTE_COMPANIES);
    template.selectedRoutes = JSON.stringify(state.selectedRoutes || []);
    template.stationData = JSON.stringify(STATION_DATA);
    template.selectedStations = JSON.stringify(state.selectedStations || {});
    template.tokyoCities = JSON.stringify(TOKYO_CITIES);
    template.selectedCities = JSON.stringify(state.selectedCities || []);
    template.areaMethod = state.areaMethod || 'route';
    template.selectedRentMax = d.rent_max || '';
    template.selectedLayouts = JSON.stringify(d.layouts || []);
    template.walkMax = d.walk || '';
    template.areaMin = d.area_min || '';
    template.buildingAge = d.building_age || '';
    template.selectedBuildingStructures = JSON.stringify(d.building_structures || []);
    template.selectedEquipment = JSON.stringify(d.equipment || []);
    template.petType = d.petType || '';
    template.otherConditions = d.otherConditions || '';
    return template.evaluate()
      .setTitle('お部屋の条件選択')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // ── LINE友だち一覧（管理者がユーザーを選択して登録） ──
  if (action === 'line_users') {
    return handleLineUsersPage();
  }

  if (action === 'push') {
    const customerName = e.parameter.customer;
    const roomId = e.parameter.room_id;
    const buildingName = e.parameter.building_name || '';
    const rent = e.parameter.rent || '';

    if (!customerName) {
      return ContentService
        .createTextOutput(JSON.stringify({ error: 'customer parameter required' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const lineUserId = findLineUserId(customerName);
    if (!lineUserId) {
      return ContentService
        .createTextOutput(JSON.stringify({ error: 'LINE user not found for: ' + customerName }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const rentText = rent ? _fmtMan(parseInt(rent)) + '万円' : '不明';
    pushMessage(lineUserId, [
      textMsg('新着物件のお知らせ\n\n' +
              '物件名: ' + buildingName + '\n' +
              '賃料: ' + rentText + '\n\n' +
              '詳細はスタッフにお問い合わせください。')
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ success: true, userId: lineUserId }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ error: 'unknown action' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 条件選択ページへのアクセスが許可されるステップかどうか判定する。
 */
function isCriteriaPageAllowed(step) {
  // CRITERIA_SELECT以降の全ステップで許可（再編集対応）
  var allowed = [
    STEPS.CRITERIA_SELECT,
    STEPS.NOTES,
    STEPS.CONFIRM,
    // 旧ステップからの移行対応
    STEPS.ROUTE_FLAT,
    STEPS.STATION_SELECT,
    STEPS.CITY_SELECT,
    STEPS.RENT_MAX,
    STEPS.LAYOUTS,
    STEPS.WALK,
    STEPS.AREA_MIN,
    STEPS.BUILDING_AGE,
    STEPS.BUILDING_TYPE,
    STEPS.EQUIPMENT
  ];
  return allowed.indexOf(step) >= 0;
}

/**
 * Web版総合条件選択ページからの送信処理。
 * google.script.run 経由で呼ばれる。
 */
function processCriteriaSelection(userId, criteria) {
  try {
    const state = getState(userId);
    console.log('processCriteriaSelection: userId=' + userId + ', step=' + state.step);

    if (!isCriteriaPageAllowed(state.step)) {
      return { success: false, message: '無効な状態です。LINEに戻ってやり直してください。（step=' + state.step + '）' };
    }

    // エリア検証
    if (criteria.areaMethod === 'route') {
      if (!criteria.selectedRoutes || criteria.selectedRoutes.length === 0) {
        return { success: false, message: '少なくとも1つの路線を選択してください。' };
      }
      var totalStations = 0;
      for (var route in criteria.selectedStations) {
        if (criteria.selectedStations[route]) totalStations += criteria.selectedStations[route].length;
      }
      if (totalStations === 0) {
        return { success: false, message: '少なくとも1つの駅を選択してください。' };
      }
    } else if (criteria.areaMethod === 'city') {
      if (!criteria.selectedCities || criteria.selectedCities.length === 0) {
        return { success: false, message: '少なくとも1つの市区町村を選択してください。' };
      }
    }

    // State 保存
    state.areaMethod = criteria.areaMethod || 'route';
    state.selectedRoutes = criteria.selectedRoutes || [];
    state.selectedStations = criteria.selectedStations || {};
    state.selectedCities = criteria.selectedCities || [];

    state.data.rent_max = criteria.rentMax || '';
    state.data.layouts = criteria.layouts || [];
    state.data.walk = criteria.walkMax || '指定しない';
    state.data.area_min = criteria.areaMin || '指定しない';
    state.data.building_age = criteria.buildingAge || '指定しない';
    state.data.building_structures = criteria.buildingStructures || [];
    state.data.equipment = criteria.equipment || [];
    state.data.petType = criteria.petType || '';
    state.data.otherConditions = criteria.otherConditions || '';
    // フォームの「その他」をnotesとして保存（確認画面で表示）
    if (criteria.otherConditions) {
      state.data.notes = criteria.otherConditions;
    }

    // 条件変更フローの場合は直接保存して完了
    if (state.isChangeFlow) {
      writeToSheet(userId, state);
      clearState(userId);
      var changeSummary = buildRegistrationSummary(state);
      pushMessage(userId, [
        textMsg('条件を更新しました！\n\n' + changeSummary + '\n条件に合う新着物件が見つかり次第、お知らせいたします。\n\n再度変更したい場合は「条件変更」と送ってください。')
      ]);
      return { success: true, message: '条件を更新しました。' };
    }

    // 直接保存して完了
    writeToSheet(userId, state);
    clearState(userId);

    var regSummary = buildRegistrationSummary(state);
    pushMessage(userId, [
      textMsg('ご登録ありがとうございます！\n以下の条件で登録しました。\n\n' + regSummary + '\n条件に合う新着物件が見つかり次第、お知らせいたします。\n\n条件を変更したい場合は「条件変更」と送ってください。')
    ]);

    return { success: true, message: '条件を登録しました。' };
  } catch (err) {
    console.error('processCriteriaSelection Error: ' + err.message + '\nStack: ' + (err.stack || 'N/A'));
    return { success: false, message: 'エラーが発生しました。もう一度お試しください。\n(' + err.message + ')' };
  }
}

/**
 * 登録内容サマリー文字列を構築する。
 */
function buildRegistrationSummary(state) {
  var d = state.data;
  var routes = state.selectedRoutes || [];
  var cities = state.selectedCities || [];
  var stations = state.selectedStations || {};

  var summary = '── 登録内容 ──\n';
  summary += '・お名前: ' + (d.name || '未入力') + '\n';
  summary += '・引越し時期: ' + (d.move_in_date || '未選択') + '\n';

  if (state.areaMethod === 'city' && cities.length > 0) {
    summary += '・エリア: ' + cities.join(', ') + '\n';
  }
  if (state.areaMethod === 'route') {
    if (routes.length > 0) {
      for (var i = 0; i < routes.length; i++) {
        var stas = stations[routes[i]] || [];
        if (stas.length > 0) {
          summary += '・' + routes[i] + ': ' + stas.join(', ') + '\n';
        } else {
          summary += '・' + routes[i] + '\n';
        }
      }
    }
  }

  summary += '・賃料上限: ' + (d.rent_max || '未設定') + '\n';
  if (d.layouts && d.layouts.length > 0) summary += '・間取り: ' + d.layouts.join(', ') + '\n';
  if (d.walk && d.walk !== '指定しない') summary += '・駅徒歩: ' + d.walk + '\n';
  if (d.area_min && d.area_min !== '指定しない') summary += '・面積: ' + d.area_min + '\n';
  if (d.building_age && d.building_age !== '指定しない') summary += '・築年数: ' + d.building_age + '\n';
  if (d.building_structures && d.building_structures.length > 0) summary += '・建物構造: ' + d.building_structures.join(', ') + '\n';
  if (d.equipment && d.equipment.length > 0) summary += '・こだわり: ' + d.equipment.join(', ') + '\n';
  if (d.petType) summary += '・ペット: ' + d.petType + '\n';

  return summary;
}

/**
 * LINE Users シートから顧客名に対応する userId を検索する。
 */
function findLineUserId(customerName) {
  try {
    const ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    const sheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);
    if (!sheet) return null;

    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][1] === customerName) {
        return data[i][0];
      }
    }
  } catch (e) {
    Logger.log('findLineUserId error: ' + e);
  }
  return null;
}

// ===== LINE友だち一覧ページ =====

/**
 * 友だち一覧ページ（HTML シェルのみ即時返却、データは非同期で取得）
 */
function handleLineUsersPage() {
  var html = '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;padding:16px;background:#f0f2f5}'
    + '.container{max-width:600px;margin:0 auto}'
    + 'h2{color:#333;margin:0 0 16px;font-size:20px}'
    + '.info{background:#e8f5e9;border-radius:8px;padding:12px;margin-bottom:16px;font-size:13px;color:#2e7d32}'
    + '.loading{text-align:center;padding:60px 20px;color:#888;font-size:15px}'
    + '.loading .spinner{display:inline-block;width:28px;height:28px;border:3px solid #e0e0e0;border-top:3px solid #4CAF50;border-radius:50%;animation:spin .8s linear infinite;margin-bottom:12px}'
    + '@keyframes spin{to{transform:rotate(360deg)}}'
    + '.card{background:#fff;border-radius:12px;padding:14px;margin-bottom:10px;box-shadow:0 1px 6px rgba(0,0,0,0.08);display:flex;align-items:center;gap:12px}'
    + '.card.registered{opacity:0.6}'
    + '.avatar{width:48px;height:48px;border-radius:50%;object-fit:cover;background:#e0e0e0;flex-shrink:0}'
    + '.user-info{flex:1;min-width:0}'
    + '.display-name{font-size:15px;font-weight:bold;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.reg-status{font-size:12px;color:#4CAF50;margin-top:2px}'
    + '.name-input{width:100%;border:1px solid #ddd;border-radius:6px;padding:6px 8px;font-size:14px;margin-top:4px;box-sizing:border-box}'
    + '.name-input:focus{border-color:#4CAF50;outline:none}'
    + '.cb{width:20px;height:20px;flex-shrink:0;cursor:pointer}'
    + '.actions{margin-top:20px;text-align:center;display:none}'
    + '.btn{display:inline-block;padding:14px 40px;border-radius:8px;font-size:16px;font-weight:bold;cursor:pointer;border:none;background:#4CAF50;color:#fff}'
    + '.btn:disabled{background:#ccc;cursor:not-allowed}'
    + '.count{font-size:13px;color:#888;margin-bottom:12px}'
    + '.error{background:#ffebee;color:#c62828;border-radius:8px;padding:12px;margin:16px 0;font-size:14px}'
    + '.search-box{width:100%;border:1px solid #ddd;border-radius:8px;padding:10px 12px;font-size:15px;margin-bottom:12px;box-sizing:border-box}'
    + '.search-box:focus{border-color:#4CAF50;outline:none;box-shadow:0 0 0 2px rgba(76,175,80,0.2)}'
    + '</style></head><body><div class="container">'
    + '<h2>\uD83D\uDC65 LINE \u53CB\u3060\u3061\u4E00\u89A7</h2>'
    + '<div class="info">\u767B\u9332\u3057\u305F\u3044\u304A\u5BA2\u3055\u3093\u306B\u30C1\u30A7\u30C3\u30AF\u3092\u5165\u308C\u3001\u9867\u5BA2\u540D\u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002</div>'
    + '<input type="text" id="searchBox" class="search-box" placeholder="\uD83D\uDD0D \u540D\u524D\u3067\u691C\u7D22..." oninput="filterList()" style="display:none">'
    + '<div id="countArea" class="count"></div>'
    + '<div id="loading" class="loading"><div class="spinner"></div><br>\u53CB\u3060\u3061\u4E00\u89A7\u3092\u53D6\u5F97\u4E2D...</div>'
    + '<div id="list"></div>'
    + '<div id="actions" class="actions">'
    + '<button type="button" class="btn" id="submitBtn" disabled onclick="submitForm()">\u9078\u629E\u3057\u305F\u4EBA\u3092\u767B\u9332</button>'
    + '</div>'
    + '</div>'
    + '<script>'
    + 'var usersData=[];'
    + 'function esc(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML}'
    + 'function onDataLoaded(users){'
    + '  usersData=users;'
    + '  document.getElementById("loading").style.display="none";'
    + '  var regCount=0;'
    + '  users.forEach(function(u){if(u.r)regCount++});'
    + '  document.getElementById("countArea").textContent="\u53CB\u3060\u3061: "+users.length+"\u4EBA / \u767B\u9332\u6E08\u307F: "+regCount+"\u4EBA";'
    + '  var html="";'
    + '  for(var i=0;i<users.length;i++){'
    + '    var u=users[i];'
    + '    var img=u.p?"<img class=\\"avatar\\" src=\\""+esc(u.p)+"\\" alt=\\"\\">" : "<div class=\\"avatar\\"></div>";'
    + '    if(u.r){'
    + '      html+="<div class=\\"card registered\\">"+img+"<div class=\\"user-info\\"><div class=\\"display-name\\">"+esc(u.n)+"</div><div class=\\"reg-status\\">\\u2713 \u767B\u9332\u6E08\u307F\\uFF08"+esc(u.rn)+"\\uFF09</div></div></div>";'
    + '    }else{'
    + '      html+="<div class=\\"card\\"><input type=\\"checkbox\\" class=\\"cb\\" data-idx=\\""+i+"\\" onchange=\\"updateBtn()\\">"+img+"<div class=\\"user-info\\"><div class=\\"display-name\\">"+esc(u.n)+"</div><input type=\\"text\\" class=\\"name-input\\" id=\\"name_"+i+"\\" value=\\""+esc(u.n)+"\\" disabled></div></div>";'
    + '    }'
    + '  }'
    + '  document.getElementById("list").innerHTML=html;'
    + '  document.getElementById("searchBox").style.display="block";'
    + '  document.getElementById("actions").style.display="block";'
    + '  document.querySelectorAll(".cb").forEach(function(cb){'
    + '    cb.addEventListener("change",function(){'
    + '      var idx=this.getAttribute("data-idx");'
    + '      document.getElementById("name_"+idx).disabled=!this.checked;'
    + '    });'
    + '  });'
    + '}'
    + 'function onError(err){document.getElementById("loading").innerHTML="<div class=\\"error\\">\\u30A8\\u30E9\\u30FC: "+esc(err.message||err)+"</div>"}'
    + 'function updateBtn(){'
    + '  var cbs=document.querySelectorAll(".cb:checked");'
    + '  var btn=document.getElementById("submitBtn");'
    + '  btn.disabled=cbs.length===0;'
    + '  btn.textContent=cbs.length>0?cbs.length+"\\u4EBA\\u3092\\u767B\\u9332":"\\u9078\\u629E\\u3057\\u305F\\u4EBA\\u3092\\u767B\\u9332";'
    + '}'
    + 'function filterList(){'
    + '  var q=(document.getElementById("searchBox").value||"").toLowerCase();'
    + '  var cards=document.querySelectorAll(".card");'
    + '  cards.forEach(function(c){'
    + '    var name=c.querySelector(".display-name");'
    + '    if(!name)return;'
    + '    c.style.display=name.textContent.toLowerCase().indexOf(q)>=0?"":"none";'
    + '  });'
    + '}'
    + 'function submitForm(){'
    + '  var selected=[];'
    + '  document.querySelectorAll(".cb:checked").forEach(function(cb){'
    + '    var idx=cb.getAttribute("data-idx");'
    + '    var name=(document.getElementById("name_"+idx).value||"").trim();'
    + '    if(name) selected.push({userId:usersData[idx].id,name:name});'
    + '  });'
    + '  if(selected.length===0)return;'
    + '  document.getElementById("submitBtn").disabled=true;'
    + '  document.getElementById("submitBtn").textContent="\\u767B\\u9332\\u4E2D...";'
    + '  google.script.run.withSuccessHandler(function(count){'
    + '    document.getElementById("list").innerHTML="<div style=\\"text-align:center;padding:40px\\"><h2 style=\\"color:#4CAF50\\">\\u2705 "+count+"\\u4EBA\\u3092\\u767B\\u9332\\u3057\\u307E\\u3057\\u305F</h2><p><a href=\\"javascript:location.reload()\\">\\u2190 \\u623B\\u308B</a></p></div>";'
    + '    document.getElementById("actions").style.display="none";'
    + '  }).withFailureHandler(onError).registerLineUsersFromClient(JSON.stringify(selected));'
    + '}'
    + 'google.script.run.withSuccessHandler(onDataLoaded).withFailureHandler(onError).getLineUsersData();'
    + '</script></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('LINE \u53CB\u3060\u3061\u4E00\u89A7')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * google.script.run から呼ばれる: 友だちデータ取得
 */
function getLineUsersData() {
  // LINE Users シートの既存データ取得
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var luSheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);
  var registered = {};
  if (luSheet) {
    var luData = luSheet.getDataRange().getValues();
    for (var i = 1; i < luData.length; i++) {
      if (luData[i][0]) registered[luData[i][0]] = luData[i][1] || '';
    }
  }

  // フォロワー ID 取得
  var followerIds = getFollowerIds(Infinity);

  // アクティビティ（最終やり取り時刻）取得
  var activity = getLineActivityMap();

  // 各フォロワーのプロフィール取得（短縮キーで軽量化）
  var users = [];
  for (var i = 0; i < followerIds.length; i++) {
    var uid = followerIds[i];
    var profile = getLineProfile(uid);
    users.push({
      id: uid,
      n: profile ? profile.displayName : '(\u4E0D\u660E)',
      p: profile ? (profile.pictureUrl || '') : '',
      r: registered.hasOwnProperty(uid),
      rn: registered[uid] || '',
      t: activity[uid] || 0  // 最終やり取り時刻（ms）
    });
  }

  // 直近でやり取りした順にソート（アクティビティがある人が先、その中で新しい順）
  users.sort(function(a, b) { return b.t - a.t; });

  return users;
}

/**
 * google.script.run から呼ばれる: 選択されたユーザーを登録
 */
function registerLineUsersFromClient(jsonStr) {
  var selected = JSON.parse(jsonStr);
  var count = 0;
  for (var i = 0; i < selected.length; i++) {
    if (selected[i].userId && selected[i].name) {
      saveLineUser(selected[i].userId, selected[i].name);
      count++;
    }
  }
  return count;
}

// ===== REINS Chrome拡張用ハンドラー =====

/**
 * APIキー検証
 */
function _validateReinsApiKey(apiKey) {
  var expected = PropertiesService.getScriptProperties().getProperty('REINS_API_KEY');
  if (!expected) return true; // キー未設定時はスキップ
  return apiKey === expected;
}

/**
 * GET: 顧客検索条件を返す
 */
function handleGetCriteria(e) {
  if (!_validateReinsApiKey(e.parameter.api_key)) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'invalid api_key' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'criteria sheet not found' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var data = sheet.getDataRange().getValues();
  var criteria = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var name = String(row[1] || '').trim();
    if (!name) continue;

    // 列マッピング (SheetWriter.js準拠):
    // A(0):タイムスタンプ B(1):名前 C(2):都道府県 D(3):市区町村
    // E(4):路線(駅名) F(5):駅名 G(6):徒歩 H(7):賃料上限
    // I(8):間取り J(9):面積 K(10):築年数 L(11):構造
    // M(12):設備 N(13):理由 O(14):引越し時期 P(15):その他 Q(16):ペット
    var routesWithStations = _parseRoutesWithStations(row[4]);
    var allRoutes = routesWithStations.map(function(r) { return r.route; });
    var allStations = _splitCSV(row[5]);

    criteria.push({
      name: name,
      cities: _splitCSV(row[3]),
      routes: allRoutes,
      stations: allStations,
      routes_with_stations: routesWithStations,
      walk: String(row[6] || ''),
      rent_max: String(row[7] || ''),
      layouts: _splitCSV(row[8]),
      area_min: String(row[9] || ''),
      building_age: String(row[10] || ''),
      structures: _splitCSV(row[11]),
      equipment: String(row[12] || ''),
      move_in_date: String(row[14] || '')
    });
  }

  return ContentService
    .createTextOutput(JSON.stringify({ criteria: criteria }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * GET: 既知の(customer_name, room_id)ペアを返す（重複排除用）
 */
function handleGetSeenIds(e) {
  if (!_validateReinsApiKey(e.parameter.api_key)) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'invalid api_key' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var seen_ids = {};

  // 承認待ち物件
  var pendingSheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (pendingSheet) {
    var pData = pendingSheet.getDataRange().getValues();
    for (var i = 1; i < pData.length; i++) {
      var customer = String(pData[i][0] || '');
      var roomId = String(pData[i][2] || '');
      if (customer && roomId) {
        if (!seen_ids[customer]) seen_ids[customer] = [];
        seen_ids[customer].push(roomId);
      }
    }
  }

  // 通知済み物件
  var seenSheet = ss.getSheetByName(SEEN_SHEET_NAME);
  if (seenSheet) {
    var sData = seenSheet.getDataRange().getValues();
    for (var i = 1; i < sData.length; i++) {
      var customer = String(sData[i][0] || '');
      var roomId = String(sData[i][1] || '');
      if (customer && roomId) {
        if (!seen_ids[customer]) seen_ids[customer] = [];
        if (seen_ids[customer].indexOf(roomId) === -1) {
          seen_ids[customer].push(roomId);
        }
      }
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify({ seen_ids: seen_ids }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST: REINS Chrome拡張から物件データを受信し承認待ちシートに書き込む
 */
function handleLogUnresolvedStations(json) {
  if (!_validateReinsApiKey(json.api_key)) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'invalid api_key' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var data = json.data;
  if (!data || Object.keys(data).length === 0) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: true, message: 'no data' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheetName = '未解決駅ログ';
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(['日時', '顧客名', 'サービス', '未解決駅']);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
  }

  var now = new Date();
  var rows = [];
  for (var customer in data) {
    var services = data[customer];
    for (var svc in services) {
      var stations = services[svc];
      if (stations && stations.length > 0) {
        rows.push([now, customer, svc, stations.join(', ')]);
      }
    }
  }

  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ success: true, logged: rows.length }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleAddReinsProperty(json) {
  if (!_validateReinsApiKey(json.api_key)) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'invalid api_key' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var customerName = json.customer_name;
  var properties = json.properties;
  if (!customerName || !properties || properties.length === 0) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'customer_name and properties required' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (!sheet) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'pending sheet not found' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 既存のpending行を取得（重複チェック）
  var existingData = sheet.getDataRange().getValues();
  var existingIds = {};
  var existingRows = {}; // key → 行番号（1-based）
  for (var i = 1; i < existingData.length; i++) {
    var key = String(existingData[i][0]) + '|' + String(existingData[i][2]);
    existingIds[key] = true;
    existingRows[key] = i + 1; // シートの行番号（1-based、ヘッダー分+1）
  }

  var now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  var added = 0;
  var skipped = 0;

  for (var j = 0; j < properties.length; j++) {
    var p = properties[j];
    var roomId = p.room_id || '';
    var dedupKey = customerName + '|' + roomId;

    // property_data_json を構築
    // Chrome拡張が構築済みの property_data_json がある場合はそれを使用
    // （image_categories 等の全フィールドが含まれている）
    var dataJson;
    if (p.property_data_json) {
      dataJson = p.property_data_json;
    } else {
      dataJson = JSON.stringify({
        address: p.address || '',
        url: p.url || '',
        image_url: p.image_url || '',
        image_urls: p.image_urls || [],
        image_categories: p.image_categories || [],
        room_number: p.room_number || '',
        building_age: p.building_age || '',
        move_in_date: p.move_in_date || '',
        floor: p.floor || 0,
        floor_text: p.floor_text || '',
        story_text: p.story_text || '',
        structure: p.structure || '',
        total_units: p.total_units || '',
        sunlight: p.sunlight || '',
        facilities: p.facilities || '',
        other_stations: p.other_stations || [],
        deposit: p.deposit || '',
        key_money: p.key_money || '',
        lease_type: p.lease_type || '',
        contract_period: p.contract_period || '',
        cancellation_notice: p.cancellation_notice || '',
        renewal_info: p.renewal_info || '',
        renewal_fee: p.renewal_fee || '',
        fire_insurance: p.fire_insurance || '',
        renewal_admin_fee: p.renewal_admin_fee || '',
        guarantee_info: p.guarantee_info || '',
        key_exchange_fee: p.key_exchange_fee || '',
        cleaning_fee: p.cleaning_fee || '',
        parking_fee: p.parking_fee || '',
        free_rent: p.free_rent || '',
        shikibiki: p.shikibiki || '',
        layout_detail: p.layout_detail || '',
        other_monthly_fee: p.other_monthly_fee || '',
        other_onetime_fee: p.other_onetime_fee || '',
        move_in_conditions: p.move_in_conditions || '',
        source: p.source || 'reins',
        reins_property_number: p.reins_property_number || '',
        reins_shougo: p.reins_shougo || '',
        reins_tel: p.reins_tel || '',
        // === REINS第1弾追加フィールド ===
        sqm_price: p.sqm_price || '',
        tsubo_price: p.tsubo_price || '',
        lease_period: p.lease_period || '',
        lease_renewal: p.lease_renewal || '',
        guarantee_money: p.guarantee_money || '',
        key_premium: p.key_premium || '',
        shoukyaku_code: p.shoukyaku_code || '',
        shoukyaku_months: p.shoukyaku_months || '',
        shoukyaku_rate: p.shoukyaku_rate || '',
        renewal_type: p.renewal_type || '',
        key_exchange_type: p.key_exchange_type || '',
        commission_type: p.commission_type || '',
        commission: p.commission || '',
        commission_landlord: p.commission_landlord || '',
        commission_tenant: p.commission_tenant || '',
        commission_motozuke: p.commission_motozuke || '',
        commission_kyakuzuke: p.commission_kyakuzuke || '',
        current_status: p.current_status || '',
        balcony_area: p.balcony_area || '',
        rooms_detail: p.rooms_detail || '',
        parking_available: p.parking_available || '',
        parking_fee_min: p.parking_fee_min || '',
        parking_fee_max: p.parking_fee_max || '',
        insurance_required: p.insurance_required || '',
        insurance_name: p.insurance_name || '',
        insurance_fee: p.insurance_fee || '',
        insurance_period: p.insurance_period || '',
        remarks: p.remarks || ''
      });
    }

    if (existingIds[dedupKey] && existingRows[dedupKey]) {
      // 既存行を更新（status/created_at は保持、他は全て最新データで上書き）
      var rowNum = existingRows[dedupKey];
      sheet.getRange(rowNum, 2, 1, 1).setValue(p.building_id || '');           // B
      sheet.getRange(rowNum, 4, 1, 1).setValue(p.building_name || '');          // D
      sheet.getRange(rowNum, 5, 1, 1).setValue(String(p.rent || 0));            // E
      sheet.getRange(rowNum, 6, 1, 1).setValue(String(p.management_fee || 0)); // F
      sheet.getRange(rowNum, 7, 1, 1).setValue(p.layout || '');                 // G
      sheet.getRange(rowNum, 8, 1, 1).setValue(String(p.area || 0));            // H
      sheet.getRange(rowNum, 9, 1, 1).setValue(p.station_info || '');           // I
      sheet.getRange(rowNum, 10, 1, 1).setValue(dataJson);                       // J
      sheet.getRange(rowNum, 13, 1, 1).setValue(now);                            // M: updated_at
      // キャッシュクリア
      try {
        var cache = CacheService.getScriptCache();
        cache.remove('imgs_' + customerName + '_' + roomId);
        cache.remove('prop2_' + customerName + '_' + roomId);
      } catch(ce) {}
      skipped++;
      continue;
    }

    sheet.appendRow([
      customerName,                    // A: customer_name
      p.building_id || '',             // B: building_id
      roomId,                          // C: room_id
      p.building_name || '',           // D: building_name
      String(p.rent || 0),             // E: rent
      String(p.management_fee || 0),   // F: management_fee
      p.layout || '',                  // G: layout
      String(p.area || 0),             // H: area
      p.station_info || '',            // I: station_info
      dataJson,                        // J: property_data_json
      'pending',                       // K: status
      now,                             // L: created_at
      '',                              // M: updated_at
      buildMinimalViewUrl(customerName, roomId, {
        buildingName: p.building_name || '',
        roomNumber: p.room_number || '',
        rent: p.rent || 0,
        managementFee: p.management_fee || 0,
        layout: p.layout || '',
        area: p.area || 0,
        buildingAge: p.building_age || '',
        stationInfo: p.station_info || '',
        address: p.address || '',
        deposit: p.deposit || '',
        keyMoney: p.key_money || '',
        floorText: p.floor_text || '',
        imageUrl: (p.image_urls && p.image_urls[0]) || p.image_url || ''
      })  // N: view_url（minimalUrl で即時表示可）
    ]);

    added++;
    existingIds[dedupKey] = true;
  }

  return ContentService
    .createTextOutput(JSON.stringify({ success: true, added: added, skipped: skipped }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * CSV文字列をトリムされた配列に分割
 */
function _splitCSV(val) {
  if (!val) return [];
  return String(val).split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
}

/**
 * E列の路線フォーマットをパースする
 * 新フォーマット: "路線名(駅1, 駅2), 路線名(駅1, 駅2)"
 * 旧フォーマット: "路線名, 路線名"
 * @returns {Array<{route: string, stations: string[]}>}
 */
function _parseRoutesWithStations(val) {
  if (!val) return [];
  var str = String(val).trim();
  if (!str) return [];

  var results = [];
  // カッコを考慮してトップレベルのカンマで分割
  var parts = [];
  var depth = 0;
  var current = '';
  for (var c = 0; c < str.length; c++) {
    var ch = str[c];
    if (ch === '(' || ch === '\uff08') { depth++; current += ch; }
    else if (ch === ')' || ch === '\uff09') { depth--; current += ch; }
    else if ((ch === ',' || ch === '\u3001') && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());

  for (var p = 0; p < parts.length; p++) {
    var part = parts[p];
    // "路線名(駅1, 駅2, ...)" パターン
    var parenIdx = part.indexOf('(');
    if (parenIdx < 0) parenIdx = part.indexOf('\uff08');
    if (parenIdx >= 0) {
      var route = part.substring(0, parenIdx).trim();
      var stationsStr = part.substring(parenIdx + 1).replace(/[)\uff09]$/, '');
      var stations = stationsStr.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
      results.push({ route: route, stations: stations });
    } else {
      // 路線名のみ（駅指定なし）
      results.push({ route: part.trim(), stations: [] });
    }
  }
  return results;
}
