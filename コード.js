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
    const event = json.events[0];
    if (!event) return;

    const replyToken = event.replyToken;
    const userId = event.source.userId;

    // ── やり取り時刻を記録（友だち一覧の並び替えに使用） ──
    if (event.type === 'message' || event.type === 'postback') {
      recordLineActivity(userId);
    }

    // ── Follow イベント（友だち追加時）──
    if (event.type === 'follow') {
      replyMessage(replyToken, [
        textMsg('友だち追加ありがとうございます！\n\n' +
                'このアカウントでは以下のことができます:\n\n' +
                '「条件登録」→ お部屋探しの条件を登録\n' +
                '「条件変更」→ 登録済みの条件を変更\n' +
                '数字を入力 → 専有面積で物件検索\n\n' +
                '条件に合う新着物件が見つかり次第、お知らせします！')
      ]);
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
        '<p style="color:#666;margin-top:12px;">LINEに戻って「条件登録」からやり直してください。</p></body></html>'
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

    const rentText = rent ? (Math.round(parseInt(rent) / 10000 * 10) / 10) + '万円' : '不明';
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
      pushMessage(userId, [
        textMsg('条件を更新しました！\n条件に合う新着物件が見つかり次第、お知らせいたします。\n\n再度変更したい場合は「条件変更」と送ってください。')
      ]);
      return { success: true, message: '条件を更新しました。' };
    }

    // 直接保存して完了
    writeToSheet(userId, state);
    clearState(userId);

    // 登録内容サマリーを構築
    var d = state.data;
    var routes = state.selectedRoutes || [];
    var cities = state.selectedCities || [];
    var stations = state.selectedStations || {};

    var summary = '── 登録内容 ──\n';
    summary += '・お名前: ' + (d.name || '未入力') + '\n';
    summary += '・引越し時期: ' + (d.move_in_date || '未選択') + '\n';

    // エリア
    if (state.areaMethod === 'city' && cities.length > 0) {
      summary += '・エリア: ' + cities.join(', ') + '\n';
    }
    if (state.areaMethod === 'route') {
      if (routes.length > 0) summary += '・路線: ' + routes.join(', ') + '\n';
      var allStations = [];
      for (var i = 0; i < routes.length; i++) {
        var stas = stations[routes[i]] || [];
        for (var j = 0; j < stas.length; j++) {
          if (allStations.indexOf(stas[j]) === -1) allStations.push(stas[j]);
        }
      }
      if (allStations.length > 0) summary += '・駅: ' + allStations.join(', ') + '\n';
    }

    summary += '・賃料上限: ' + (d.rent_max || '未設定') + '\n';
    if (d.layouts && d.layouts.length > 0) summary += '・間取り: ' + d.layouts.join(', ') + '\n';
    if (d.walk && d.walk !== '指定しない') summary += '・駅徒歩: ' + d.walk + '\n';
    if (d.area_min && d.area_min !== '指定しない') summary += '・面積: ' + d.area_min + '\n';
    if (d.building_age && d.building_age !== '指定しない') summary += '・築年数: ' + d.building_age + '\n';
    if (d.building_structures && d.building_structures.length > 0) summary += '・建物構造: ' + d.building_structures.join(', ') + '\n';
    if (d.equipment && d.equipment.length > 0) summary += '・こだわり: ' + d.equipment.join(', ') + '\n';
    if (d.petType) summary += '・ペット: ' + d.petType + '\n';

    pushMessage(userId, [
      textMsg('ご登録ありがとうございます！\n以下の条件で登録しました。\n\n' + summary + '\n条件に合う新着物件が見つかり次第、お知らせいたします。\n\n条件を変更したい場合は「条件変更」と送ってください。')
    ]);

    return { success: true, message: '条件を登録しました。' };
  } catch (err) {
    console.error('processCriteriaSelection Error: ' + err.message + '\nStack: ' + (err.stack || 'N/A'));
    return { success: false, message: 'エラーが発生しました。もう一度お試しください。\n(' + err.message + ')' };
  }
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
