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
    // [PERF-doPost] 計測用 — 条件登録の遅延調査のため一時的に追加 (2026-04-29)
    var _doPostT = Date.now();
    const json = JSON.parse(e.postData.contents);

    // --- 条件登録フォーム (form.ehomaki.com) からの送信 ---
    if (json.action === 'criteria_submit') {
      var _result = processCriteriaSelection(json.userId, json.criteria);
      return ContentService
        .createTextOutput(JSON.stringify(_result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // --- REINS Chrome拡張からのPOST ---
    if (json.action === 'add_reins_property') {
      return handleAddReinsProperty(json);
    }

    // --- REINS検索完了: 最終検索日を更新 ---
    if (json.action === 'update_reins_search_date') {
      return _handleUpdateReinsSearchDate(json);
    }

    // --- 手動検索で選んだ物件を顧客LINEへ送信 (Chrome拡張パネルから) ---
    if (json.action === 'send_manual_properties') {
      return handleSendManualProperties(json);
    }

    // --- 空室状況の更新 (Chrome拡張から定期/手動で呼ばれる) ---
    if (json.action === 'update_availability') {
      try {
        if (!_validateReinsApiKey(json.api_key)) {
          return ContentService.createTextOutput(JSON.stringify({ error: 'invalid api_key' }))
            .setMimeType(ContentService.MimeType.JSON);
        }
        var items = Array.isArray(json.items) ? json.items : [];
        var results = [];
        var discordNotifyItems = [];  // Chrome拡張側で送信する Discord 通知
        for (var iu = 0; iu < items.length; iu++) {
          var it = items[iu] || {};
          var extras = {
            badgeCount: (typeof it.badge_count === 'number') ? it.badge_count : null,
            canApply: (typeof it.can_apply === 'boolean') ? it.can_apply : null,
            listingStatus: it.listing_status || '',
            application_status: it.application_status || ''
          };
          var r = setPropertyAvailability(it.customer, it.room_id, it.status, extras);
          results.push({ customer: it.customer, room_id: it.room_id, status: it.status, ok: r.ok });
          if (r && Array.isArray(r.discordPayloads)) {
            for (var dp = 0; dp < r.discordPayloads.length; dp++) {
              discordNotifyItems.push(r.discordPayloads[dp]);
            }
          }
        }
        return ContentService.createTextOutput(JSON.stringify({
          ok: true,
          results: results,
          discord_notify_items: discordNotifyItems
        })).setMimeType(ContentService.MimeType.JSON);
      } catch (eU) {
        return ContentService.createTextOutput(JSON.stringify({ error: eU.message }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    // --- 駅名解決失敗ログ ---
    if (json.action === 'log_unresolved_stations') {
      return handleLogUnresolvedStations(json);
    }

    // --- SUUMO自動入稿関連POST ---
    if (json.action === 'add_suumo_candidate') {
      return handleAddSuumoCandidate(json);
    }
    if (json.action === 'create_suumo_patrol_thread') {
      return handleCreateSuumoPatrolThread(json);
    }
    if (json.action === 'mark_suumo_discord_sent') {
      return handleMarkSuumoDiscordSent(json);
    }
    if (json.action === 'confirm_suumo_approve') {
      return handleConfirmSuumoApprove(json);
    }
    if (json.action === 'suumo_post_complete') {
      return handleSuumoPostComplete(json);
    }
    if (json.action === 'update_candidate_inquiry_scores') {
      return handleUpdateSuumoCandidateInquiryScores(json);
    }
    if (json.action === 'update_suumo_performance') {
      return handleUpdateSuumoPerformance(json);
    }
    if (json.action === 'stop_suumo_listing') {
      return handleStopSuumoListing(json);
    }
    if (json.action === 'cleanup_duplicate_listings') {
      return handleCleanupDuplicateListings(json);
    }
    if (json.action === 'update_suumo_listing_stats') {
      return handleUpdateSuumoListingStats(json);
    }
    if (json.action === 'sync_forrent_listing_status') {
      return handleSyncForrentListingStatus(json);
    }
    if (json.action === 'save_patrol_criteria') {
      return handleSavePatrolCriteriaPost(json);
    }
    if (json.action === 'set_suumo_webhook') {
      return handleSetSuumoWebhook(json);
    }

    const event = json.events[0];
    if (!event) return;

    const replyToken = event.replyToken;
    const userId = event.source.userId;

    // ── 返信処理を IIFE で包み、完了後にアクティビティ記録（体感速度向上のため後回し） ──
    (function dispatch() {
    // ── auto_paused 自動復帰: メッセージ受信で配信自動再開 ──
    try {
      if (event.type === 'message' || event.type === 'postback') {
        var _autoPauseStatus = (typeof getDeliveryStatus === 'function')
          ? getDeliveryStatus(userId) : null;
        if (_autoPauseStatus === 'auto_paused') {
          setDeliveryStatus(userId, 'active');
          console.log('[auto_paused 自動復帰] userId=' + userId);
        }
      }
    } catch (_eAutoResume) {
      console.warn('[auto_paused 自動復帰] error: ' + (_eAutoResume && _eAutoResume.message));
    }
    // ── Follow イベント（友だち追加時）──
    // 挨拶メッセージは LINE Manager 側で設定。追加でメアド入力を促す。
    if (event.type === 'follow') {
      try {
        var props = PropertiesService.getUserProperties();
        props.setProperty('email_pending_' + userId, 'true');
        pushMessage(userId, [textMsg(
          'SUUMOからお問い合わせいただいた方は、お問い合わせ時のメールアドレスをこちらに送信してください。\n\n' +
          'メールの配信が自動で停止されます。'
        )]);
      } catch (eFollow) {
        console.error('follow pushMessage error: ' + eFollow.message);
      }
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

      // 条件変更提案 LINE Flex のボタン postback (condsug:...)
      if (typeof data === 'string' && data.indexOf('condsug:') === 0) {
        if (typeof handleConditionSuggestionPostback === 'function') {
          handleConditionSuggestionPostback(replyToken, userId, data);
        }
        return;
      }

      // 空室確認: キャンセル通知希望ボタンの postback
      //   data="action=availability_watch_cancellation&customer=...&room_id=..."
      if (typeof data === 'string' && data.indexOf('action=availability_watch_cancellation') === 0) {
        try {
          var params = {};
          data.split('&').forEach(function(kv) {
            var p = kv.split('=');
            if (p.length === 2) params[p[0]] = decodeURIComponent(p[1] || '');
          });
          var watchRes = (typeof setCancellationWatch === 'function')
            ? setCancellationWatch(params.customer, params.room_id)
            : { ok: false, message: 'function not defined' };
          if (watchRes.ok) {
            replyMessage(replyToken, [textMsg(
              '承知しました。\n\n' +
              'キャンセルが発生次第、すぐにお知らせいたします。'
            )]);
          } else {
            replyMessage(replyToken, [textMsg('登録に失敗しました。お手数ですが、もう一度お試しください。')]);
          }
        } catch (eAW) {
          console.warn('[キャンセル通知希望] エラー: ' + eAW.message);
          try { replyMessage(replyToken, [textMsg('処理に失敗しました。')]); } catch(_) {}
        }
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

      // ── メアド入力待ち（LINE友だち追加後のフォローアップ停止用）──
      var _emailPendingKey = 'email_pending_' + userId;
      var _emailPending = PropertiesService.getUserProperties().getProperty(_emailPendingKey);
      if (_emailPending) {
        PropertiesService.getUserProperties().deleteProperty(_emailPendingKey);
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message)) {
          var _saved = saveLineRegisteredEmail(userId, message);
          if (_saved) {
            replyMessage(replyToken, [textMsg(
              'メールアドレスを登録しました。\n' + message + ' への配信を停止いたします。\n\n' +
              '今後のお部屋探しはこちらのLINEからお気軽にどうぞ！'
            )]);
          } else {
            replyMessage(replyToken, [textMsg(
              'このメールアドレスはすでに登録済みです。\n\nお部屋探しはこちらのLINEからお気軽にどうぞ！'
            )]);
          }
          return;
        }
      }

      // 条件変更提案「自分で入力する」モード中ならそのテキストを数値として受ける
      if (typeof handleConditionSuggestionTextInput === 'function'
          && handleConditionSuggestionTextInput(replyToken, userId, message, state)) {
        return;
      }

      // コマンド: 条件登録
      if (message === '条件登録' || message === 'じょうけんとうろく') {
        // [PERF-doPost] 計測用
        console.log('[PERF-doPost] +' + (Date.now() - _doPostT) + 'ms startSearchFlow直前');
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

      // コマンド: 配信停止 / 配信再開
      if (message === '配信停止' || message === 'はいしんていし') {
        handleDeliveryStopCommand(replyToken, userId);
        return;
      }
      if (message === '配信再開' || message === 'はいしんさいかい') {
        handleDeliveryResumeCommand(replyToken, userId);
        return;
      }
      // コマンド: 配信切替 (リッチメニューの「配信の停止/再開」タイル用)
      //   現在ステータスを見て stop / resume を自動で切り替える。
      if (message === '配信切替' || message === 'はいしんきりかえ') {
        try {
          var currentDeliveryStatus = (typeof getDeliveryStatus === 'function')
            ? getDeliveryStatus(userId) : 'active';
          if (currentDeliveryStatus === 'paused' || currentDeliveryStatus === 'auto_paused') {
            handleDeliveryResumeCommand(replyToken, userId);
          } else {
            handleDeliveryStopCommand(replyToken, userId);
          }
        } catch (e) {
          console.error('配信切替 error: ' + e.message);
          handleDeliveryStopCommand(replyToken, userId); // フォールバック
        }
        return;
      }

      // コマンド: 条件変更 (どのフロー中でも常に効くように上位で受ける)
      if (message === '条件変更' || message === 'じょうけんへんこう') {
        startChangeFlow(replyToken, userId);
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

      // 配信停止理由フロー中: 自由入力 or 選択肢を処理
      if (state.step === STEPS.WAITING_STOP_REASON || state.step === STEPS.WAITING_STOP_REASON_CUSTOM) {
        if (message === 'キャンセル' || message === 'きゃんせる') {
          clearState(userId);
          replyMessage(replyToken, [textMsg('配信停止をキャンセルしました。引き続き新着物件をお届けいたします。')]);
          return;
        }
        if (handleStopReasonText(replyToken, userId, message, state)) return;
      }

      // スヌーズ期間選択中
      if (state.step === STEPS.WAITING_SNOOZE_PERIOD) {
        if (message === 'キャンセル' || message === 'きゃんせる') {
          clearState(userId);
          replyMessage(replyToken, [textMsg('配信停止をキャンセルしました。引き続き新着物件をお届けいたします。')]);
          return;
        }
        if (handleSnoozePeriodText(replyToken, userId, message)) return;
      }

      // 希望に合わない → 条件変更 or 停止 の選択中
      if (state.step === STEPS.WAITING_MISMATCH_CHOICE) {
        if (message === 'キャンセル' || message === 'きゃんせる') {
          clearState(userId);
          replyMessage(replyToken, [textMsg('配信停止をキャンセルしました。引き続き新着物件をお届けいたします。')]);
          return;
        }
        if (message === '条件変更' || message === 'じょうけんへんこう') {
          startChangeFlow(replyToken, userId);
          return;
        }
        if (handleMismatchChoiceText(replyToken, userId, message)) return;
      }

      // 配信頻度選択中
      if (state.step === STEPS.WAITING_FREQUENCY) {
        if (message === 'キャンセル' || message === 'きゃんせる') {
          clearState(userId);
          replyMessage(replyToken, [textMsg('配信停止をキャンセルしました。引き続き新着物件をお届けいたします。')]);
          return;
        }
        if (handleFrequencyText(replyToken, userId, message)) return;
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

      // コマンド: 条件変更 ← 上位でハンドル済みのためここでは省略

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
    })();

    // ── 返信後にアクティビティ記録（遅くても返信済みなので体感に影響しない） ──
    if (event.type === 'message' || event.type === 'postback') {
      try { recordLineActivity(userId); } catch (e) { console.error('recordLineActivity error: ' + e.message); }
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

  // criteria_state: form.ehomaki.com/criteria.html がユーザー現在状態をfetchするためのJSON返却
  if (action === 'criteria_state') {
    var _userIdC = e.parameter.userId;
    if (!_userIdC) {
      return ContentService.createTextOutput(JSON.stringify({ success: false, message: 'userId required' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    try {
      var _stateC = getState(_userIdC);
      if (!isCriteriaPageAllowed(_stateC.step)) {
        _stateC = _restoreStateForCriteriaPage_(_userIdC, _stateC);
        if (!_stateC) {
          return ContentService.createTextOutput(JSON.stringify({
            success: false,
            message: '条件登録から始めてください',
            step: getState(_userIdC).step
          })).setMimeType(ContentService.MimeType.JSON);
        }
      }
      var _dC = _stateC.data || {};
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        selectedRoutes: _stateC.selectedRoutes || [],
        selectedStations: _stateC.selectedStations || {},
        selectedCities: _stateC.selectedCities || [],
        selectedTowns: _stateC.selectedTowns || {},
        areaMethod: _stateC.areaMethod || 'route',
        rentMax: _dC.rent_max || '',
        layouts: _dC.layouts || [],
        walkMax: _dC.walk || '',
        areaMin: _dC.area_min || '',
        buildingAge: _dC.building_age || '',
        buildingStructures: _dC.building_structures || [],
        equipment: _dC.equipment || [],
        petType: _dC.petType || '',
        otherConditions: _dC.otherConditions || '',
        moveInDate: _dC.move_in_date || '',
        moveInStrict: !!_dC.move_in_strict
      })).setMimeType(ContentService.MimeType.JSON);
    } catch (eCS) {
      return ContentService.createTextOutput(JSON.stringify({ success: false, message: eCS.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // LIFF endpoint URL 自動更新 (1回限り、bootstrap用)
  // 使い方: doGet?action=update_liff_endpoint&new_url=...&liff_id=...
  if (action === 'update_liff_endpoint') {
    var _newUrl = e.parameter.new_url;
    var _liffId = e.parameter.liff_id || LIFF_ID;
    if (!_newUrl) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, msg: 'new_url required' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    try {
      var _resp = UrlFetchApp.fetch('https://api.line.me/liff/v1/apps/' + _liffId, {
        method: 'put',
        contentType: 'application/json',
        headers: { 'Authorization': 'Bearer ' + CHANNEL_ACCESS_TOKEN },
        payload: JSON.stringify({
          view: { type: 'tall', url: _newUrl }
        }),
        muteHttpExceptions: true
      });
      var _code = _resp.getResponseCode();
      var _body = _resp.getContentText();
      console.log('[update_liff_endpoint] HTTP ' + _code + ' body=' + _body);
      return ContentService.createTextOutput(JSON.stringify({
        ok: _code >= 200 && _code < 300,
        code: _code,
        body: _body
      })).setMimeType(ContentService.MimeType.JSON);
    } catch (eLF) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, msg: eLF.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // 診断用: 承認待ち物件のJ列(JSON)を新しい順に表示。reins source を優先抽出
  // キャンセル通知希望物件の一覧表示: ?action=list_cancellation_watches
  if (action === 'list_cancellation_watches') {
    try {
      var lcSs = SpreadsheetApp.openById(SPREADSHEET_ID);
      var lcSeen = lcSs.getSheetByName(SEEN_SHEET_NAME);
      var lcPend = lcSs.getSheetByName(PENDING_SHEET_NAME);
      var lcRows = [];
      if (lcSeen) {
        var lcLast = lcSeen.getLastRow();
        if (lcLast >= 2) {
          var lcData = lcSeen.getRange(2, 1, lcLast - 1, 10).getValues();
          for (var lcI = 0; lcI < lcData.length; lcI++) {
            var watchRaw = lcData[lcI][9]; // J列 (index 9)
            if (!watchRaw) continue;
            lcRows.push({
              row: lcI + 2,
              customer: String(lcData[lcI][0] || ''),
              roomId: String(lcData[lcI][1] || ''),
              buildingName: String(lcData[lcI][2] || ''),
              sentAt: (lcData[lcI][3] instanceof Date) ? Utilities.formatDate(lcData[lcI][3], 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : String(lcData[lcI][3] || ''),
              source: String(lcData[lcI][4] || ''),
              currentStatus: String(lcData[lcI][5] || ''),
              statusCheckedAt: (lcData[lcI][6] instanceof Date) ? Utilities.formatDate(lcData[lcI][6], 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : String(lcData[lcI][6] || ''),
              sourceRef: String(lcData[lcI][7] || ''),
              watchedAt: (watchRaw instanceof Date) ? Utilities.formatDate(watchRaw, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : String(watchRaw || '')
            });
          }
        }
      }
      // 顧客名で並べる、 watchedAt 降順
      lcRows.sort(function(a, b) {
        if (a.customer !== b.customer) return a.customer < b.customer ? -1 : 1;
        return (b.watchedAt || '').localeCompare(a.watchedAt || '');
      });

      var srcDisplay = function(s) {
        return ({ reins: 'REINS', itandi: 'itandi', ielove: 'いえらぶ', essquare: 'いい生活' })[String(s).toLowerCase()] || s;
      };
      var statusDisplay = function(s) {
        return ({
          available: '🟢 募集中',
          applied: '🟡 申込あり',
          closed: '🔴 募集終了',
          reins_listed: '⚪ REINS掲載',
          needs_confirmation: '⚪ 要確認',
          unknown: '⚪ 不明',
          '': '― 未確認'
        })[s] || s;
      };
      var rowsHtml = lcRows.map(function(r, idx) {
        var propUrl = (r.source && r.source !== 'reins' && r.sourceRef) ? r.sourceRef
                   : (r.source === 'reins' && r.sourceRef) ? ('https://system.reins.jp/main/BK/GBK004100#bukken=' + r.sourceRef)
                   : '';
        return '<tr id="watch-row-' + idx + '">'
          + '<td>' + r.customer + '</td>'
          + '<td>' + (r.buildingName || '(物件名なし)') + '<br><span class="sub">room_id: ' + r.roomId + '</span></td>'
          + '<td>' + srcDisplay(r.source) + '</td>'
          + '<td>' + statusDisplay(r.currentStatus) + '<br><span class="sub">' + (r.statusCheckedAt || '未チェック') + '</span></td>'
          + '<td>' + (r.watchedAt || '') + '</td>'
          + '<td>' + (propUrl ? '<a href="' + propUrl + '" target="_blank">開く</a>' : '-') + '</td>'
          + '<td><button class="cancel-btn" onclick="cancelWatch(' + idx + ',\'' + r.customer.replace(/'/g, "\\'") + '\',\'' + r.roomId.replace(/'/g, "\\'") + '\')">解除</button></td>'
          + '</tr>';
      }).join('');
      var html = '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><base target="_top">'
        + '<title>キャンセル通知希望物件</title>'
        + '<style>body{font-family:-apple-system,sans-serif;background:#f5f7fa;padding:20px;color:#1a2538;max-width:1100px;margin:0 auto}'
        + 'h1{font-size:20px;color:#3d6909;margin-bottom:8px}'
        + '.summary{font-size:13px;color:#666;margin-bottom:16px}'
        + 'table{width:100%;border-collapse:collapse;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,0.06);border-radius:8px;overflow:hidden}'
        + 'th,td{padding:10px 12px;font-size:13px;text-align:left;border-bottom:1px solid #f0f0f0;vertical-align:top}'
        + 'th{background:#f0faf4;color:#3d6909;font-weight:700;font-size:12px}'
        + 'tr:hover{background:#f9fafb}'
        + '.sub{font-size:11px;color:#999}'
        + 'a{color:#6ea814;text-decoration:none}a:hover{text-decoration:underline}'
        + '.empty{padding:40px;text-align:center;color:#888;background:#fff;border-radius:8px}'
        + '.cancel-btn{background:#e74c3c;color:#fff;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600}'
        + '.cancel-btn:hover{background:#c0392b}'
        + '.cancel-btn:disabled{opacity:0.5;cursor:not-allowed}'
        + '.cancelled{opacity:0.4;text-decoration:line-through}'
        + '</style></head><body>'
        + '<h1>🔔 キャンセル通知希望物件</h1>'
        + '<div class="summary">該当 ' + lcRows.length + ' 件 (30分毎に自動チェック / キャンセル発生で顧客にLINE通知)</div>'
        + (lcRows.length === 0
          ? '<div class="empty">現在、キャンセル通知希望の物件はありません</div>'
          : '<table><thead><tr>'
            + '<th>顧客</th><th>物件</th><th>ソース</th><th>現状ステータス</th><th>希望日時</th><th>詳細</th><th>操作</th>'
            + '</tr></thead><tbody>' + rowsHtml + '</tbody></table>')
        + '<script>'
        + 'function cancelWatch(idx, customer, roomId) {'
        + '  var btn = document.querySelector("#watch-row-" + idx + " .cancel-btn");'
        + '  if (!btn) return;'
        + '  if (!confirm(customer + " のキャンセル監視を解除しますか？")) return;'
        + '  btn.disabled = true;'
        + '  btn.textContent = "解除中...";'
        + '  google.script.run'
        + '    .withSuccessHandler(function() {'
        + '      var row = document.getElementById("watch-row-" + idx);'
        + '      if (row) row.classList.add("cancelled");'
        + '      btn.textContent = "✓ 解除済";'
        + '    })'
        + '    .withFailureHandler(function(err) {'
        + '      btn.disabled = false;'
        + '      btn.textContent = "解除";'
        + '      alert("エラー: " + (err && err.message || err));'
        + '    })'
        + '    .clearCancellationWatch(customer, roomId);'
        + '}'
        + '<\/script>'
        + '</body></html>';
      return HtmlService.createHtmlOutput(html);
    } catch (eLC) {
      return HtmlService.createHtmlOutput('<h2>❌ エラー</h2><pre>' + eLC.message + '</pre>');
    }
  }

  // 顧客の重複検知状態確認: ?action=debug_dedup_state&customer=倉田豊大
  if (action === 'debug_dedup_state') {
    try {
      var dcCustomer = (e.parameter.customer || '').trim();
      if (!dcCustomer) return ContentService.createTextOutput(JSON.stringify({ error: 'customer required' })).setMimeType(ContentService.MimeType.JSON);
      var dcSs = SpreadsheetApp.openById(SPREADSHEET_ID);
      var dcResult = { customer: dcCustomer, pending: [], seen: [] };
      var dcPend = dcSs.getSheetByName(PENDING_SHEET_NAME);
      if (dcPend) {
        var dcPdata = dcPend.getDataRange().getValues();
        var dcNorm = function(s) { return String(s || '').replace(/[\s　]+/g, '').trim(); };
        var dcTarget = dcNorm(dcCustomer);
        for (var dcI = 1; dcI < dcPdata.length; dcI++) {
          if (dcNorm(dcPdata[dcI][0]) !== dcTarget) continue;
          dcResult.pending.push({
            row: dcI + 1,
            building_name: String(dcPdata[dcI][3] || ''),
            room_id: String(dcPdata[dcI][2] || ''),
            status: String(dcPdata[dcI][10] || ''),
            created_at: String(dcPdata[dcI][11] || '')
          });
        }
      }
      var dcSeen = dcSs.getSheetByName(SEEN_SHEET_NAME);
      if (dcSeen) {
        var dcSdata = dcSeen.getDataRange().getValues();
        for (var dcJ = 1; dcJ < dcSdata.length; dcJ++) {
          if (String(dcSdata[dcJ][0] || '').trim() !== dcCustomer) continue;
          dcResult.seen.push({
            row: dcJ + 1,
            room_id: String(dcSdata[dcJ][1] || ''),
            building_name: String(dcSdata[dcJ][2] || ''),
            sent_at: String(dcSdata[dcJ][3] || ''),
            source: String(dcSdata[dcJ][4] || ''),
            current_status: String(dcSdata[dcJ][5] || '')
          });
        }
      }
      dcResult.pendingCount = dcResult.pending.length;
      dcResult.seenCount = dcResult.seen.length;
      return ContentService.createTextOutput(JSON.stringify(dcResult, null, 2))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (eDC) {
      return ContentService.createTextOutput(JSON.stringify({ error: eDC.message })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  if (action === 'debug_pending_json') {
    try {
      var _ss3 = SpreadsheetApp.openById(SPREADSHEET_ID);
      var _ps = _ss3.getSheetByName(PENDING_SHEET_NAME);
      if (!_ps) {
        return ContentService.createTextOutput(JSON.stringify({ error: 'PENDING sheet なし' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      var _lr = _ps.getLastRow();
      if (_lr < 2) return ContentService.createTextOutput(JSON.stringify({ rows: [] }))
        .setMimeType(ContentService.MimeType.JSON);
      var _pData = _ps.getRange(2, 1, _lr - 1, 11).getValues();
      var _out = [];
      for (var _pi = _pData.length - 1; _pi >= 0 && _out.length < 5; _pi--) {
        var _r = _pData[_pi];
        var _json = String(_r[9] || '');
        var _parsed = null;
        try { _parsed = JSON.parse(_json); } catch (_) {}
        var _src = _parsed && _parsed.source || '?';
        var _wt = _parsed && _parsed.warnings_text || '';
        _out.push({
          row: _pi + 2,
          customer: _r[0],
          building: _r[3],
          source: _src,
          hasWarningsKey: _parsed ? ('warnings_text' in _parsed) : false,
          warningsLen: _wt.length,
          warningsPreview: _wt.substring(0, 200),
          jsonSize: _json.length,
          // 警告判定に効く値もスナップショット
          facilities: _parsed && _parsed.facilities ? String(_parsed.facilities).substring(0, 300) : '',
          move_in_date: _parsed && _parsed.move_in_date || '',
          floor_text: _parsed && _parsed.floor_text || '',
          story_text: _parsed && _parsed.story_text || ''
        });
      }
      return ContentService.createTextOutput(JSON.stringify(_out, null, 2))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (e) {
      return ContentService.createTextOutput(JSON.stringify({ error: e.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // 空室状況確認キュー (Chrome拡張から定期的に取得して各物件をチェック)
  if (action === 'get_availability_queue') {
    try {
      if (!_validateReinsApiKey(e.parameter.api_key)) {
        return ContentService.createTextOutput(JSON.stringify({ error: 'invalid api_key' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      var queueOpts = {
        limit: parseInt(e.parameter.limit || '50', 10),
        maxAgeDays: parseInt(e.parameter.max_age_days || '60', 10),
        maxIntervalHours: parseInt(e.parameter.max_interval_hours || '24', 10),
        priorityOnly: e.parameter.priority_only === '1',
        maxPriorityAgeMinutes: parseInt(e.parameter.max_priority_age_minutes || '60', 10),
        watchOnly: e.parameter.watch_only === '1'
      };
      var queue = (typeof getAvailabilityCheckQueue === 'function') ? getAvailabilityCheckQueue(queueOpts) : [];
      var diagInfo = (queue && queue._diag) ? queue._diag : null;
      var itemsClean = Array.isArray(queue) ? queue.slice() : [];
      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        items: itemsClean,
        diag: diagInfo
      })).setMimeType(ContentService.MimeType.JSON);
    } catch (eQ) {
      return ContentService.createTextOutput(JSON.stringify({ error: eQ.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // お客さんからの優先空室確認リクエスト (property.html がボタン押下時に呼ぶ)
  if (action === 'request_priority_check') {
    try {
      var custP = e.parameter.customer || '';
      var roomP = e.parameter.room_id || '';
      var rP = (typeof requestPriorityAvailabilityCheck === 'function')
        ? requestPriorityAvailabilityCheck(custP, roomP)
        : { ok: false, message: 'function not defined' };
      return ContentService.createTextOutput(JSON.stringify(rP))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (eP) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, message: eP.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // お客さんからのキャンセル待ち通知希望 (property.html のボタン押下時に呼ぶ)
  if (action === 'request_cancellation_watch') {
    try {
      var custW = e.parameter.customer || '';
      var roomW = e.parameter.room_id || '';
      var rW = (typeof setCancellationWatch === 'function')
        ? setCancellationWatch(custW, roomW)
        : { ok: false, message: 'function not defined' };
      return ContentService.createTextOutput(JSON.stringify(rW))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (eW) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, message: eW.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // Discord webhook 設定確認 + テスト送信
  if (action === 'check_discord') {
    try {
      // 空室確認用の webhook を優先 (共通 webhook の流用は Cloudflare 1015 を引き起こすため)
      var props2 = PropertiesService.getScriptProperties();
      var dUrl = props2.getProperty('DISCORD_WEBHOOK_AVAILABILITY_URL') || props2.getProperty('DISCORD_WEBHOOK_URL');
      var usedKey = props2.getProperty('DISCORD_WEBHOOK_AVAILABILITY_URL')
        ? 'DISCORD_WEBHOOK_AVAILABILITY_URL (空室確認専用)'
        : 'DISCORD_WEBHOOK_URL (共通)';
      if (!dUrl) {
        return HtmlService.createHtmlOutput(
          '<h2>❌ Discord webhook URL 未設定</h2>'
          + '<p>GASエディタ → 「プロジェクトの設定」 → 「スクリプトプロパティ」で '
          + '<code>DISCORD_WEBHOOK_AVAILABILITY_URL</code> を追加してください。</p>'
          + '<p>Discord 側で webhook URL を取得する方法:</p>'
          + '<ol><li>Discord でチャンネルを選択</li>'
          + '<li>歯車アイコン → 「連携サービス」 → 「ウェブフック」</li>'
          + '<li>「新しいウェブフック」を作成 → URLをコピー</li>'
          + '<li>そのURLをスクリプトプロパティ <code>DISCORD_WEBHOOK_AVAILABILITY_URL</code> に設定</li></ol>'
        );
      }
      // テスト送信
      if (e.parameter.send === '1') {
        try {
          var resp = UrlFetchApp.fetch(dUrl, {
            method: 'post',
            contentType: 'application/json',
            payload: JSON.stringify({ content: '🧪 空室確認システム: テスト通知です' }),
            muteHttpExceptions: true
          });
          var code = resp.getResponseCode();
          var body = resp.getContentText();
          var success = (code >= 200 && code < 300);
          var urlPreview = dUrl.length > 60
            ? dUrl.substring(0, 40) + '...' + dUrl.substring(dUrl.length - 20)
            : dUrl;
          return HtmlService.createHtmlOutput(
            '<!DOCTYPE html><html><head><meta charset="UTF-8"><base target="_top"></head><body>'
            + '<h2>' + (success ? '✅ 送信成功 (HTTP ' + code + ')' : '❌ 送信失敗 (HTTP ' + code + ')') + '</h2>'
            + '<p><b>URL:</b> <code>' + urlPreview + '</code></p>'
            + '<p><b>レスポンス:</b></p>'
            + '<pre style="background:#f5f5f5;padding:10px;border-radius:6px;white-space:pre-wrap">' + (body || '(空レスポンス)') + '</pre>'
            + (success
              ? '<p>Discord を確認してください。</p>'
              : '<p style="color:#9b1c1c">webhook URL が無効または期限切れの可能性があります。Discord で再作成してください。</p>')
            + '</body></html>'
          );
        } catch (eD) {
          return HtmlService.createHtmlOutput('<h2>❌ 送信エラー (例外)</h2><pre>' + eD.message + '</pre>');
        }
      }
      // 設定確認のみ
      var webAppUrlCheck = ScriptApp.getService().getUrl();
      return HtmlService.createHtmlOutput(
        '<!DOCTYPE html><html><head><meta charset="UTF-8"><base target="_top"></head><body>'
        + '<h2>✅ Discord webhook 設定済み</h2>'
        + '<p>使用キー: <code>' + usedKey + '</code></p>'
        + '<p>URL: <code>' + dUrl.substring(0, 60) + '...</code></p>'
        + '<p><a href="' + webAppUrlCheck + '?action=check_discord&send=1">テスト送信してみる</a></p>'
        + '</body></html>'
      );
    } catch (eC) {
      return HtmlService.createHtmlOutput('<h2>❌ エラー</h2><pre>' + eC.message + '</pre>');
    }
  }

  // 空室確認テスト用: ブラウザで開いてフォーム入力 → 1クリックでテスト物件追加
  //   GET ?action=availability_test_form
  //   GET ?action=availability_test_form&url=...&source=... → 追加して結果表示
  //   保護: 顧客名がテストユーザーリストに含まれる場合のみ追加可能
  if (action === 'availability_test_form') {
    try {
      var fUrl = (e.parameter.url || '').trim();
      var fSource = (e.parameter.source || '').trim();
      var fCustomer = (e.parameter.customer || 'Hiroki').trim();
      var fBuilding = (e.parameter.building || 'テスト物件').trim();
      var fReinsNo = (e.parameter.reins_prop_no || '').trim();

      // パラメータあり → 追加処理 (テストユーザー判定で保護)
      var resultHtml = '';
      if (fUrl || (fSource === 'reins' && fReinsNo)) {
        if (!fSource) {
          resultHtml = '<div class="msg err">source が未指定です</div>';
        } else if (typeof isAvailabilityTestUser === 'function' && !isAvailabilityTestUser(fCustomer)) {
          resultHtml = '<div class="msg err">顧客「' + fCustomer + '」はテストユーザーに登録されていません。<br>'
            + 'まず GASエディタで <code>manageAvailabilityTestUsers(\'add\', \'' + fCustomer + '\')</code> を実行してください。</div>';
        } else {
          try {
            var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
            var pendingSheet = ss.getSheetByName(PENDING_SHEET_NAME);
            var seenSheet = ss.getSheetByName(SEEN_SHEET_NAME);
            var roomId = 'test_' + Date.now();
            var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
            var dataJson = JSON.stringify({
              url: fUrl, source: fSource, reins_property_number: fReinsNo,
              building_name: fBuilding, room_number: '',
              rent: 80000, management_fee: 5000, layout: '1K', area: 25,
              building_age: '築15年', station_info: 'テスト駅 徒歩5分',
              address: 'テスト住所', deposit: '1ヶ月', key_money: '1ヶ月',
              image_urls: []
            });
            pendingSheet.appendRow([
              fCustomer, 'test_b_' + roomId, roomId, fBuilding,
              '80000', '5000', '1K', '25', 'テスト駅 徒歩5分',
              dataJson, 'sent', now, now, ''
            ]);
            // SEEN_SHEET: A〜I 列 (I = priority_requested_at をテスト用に即座にセット)
            var setNow = (e.parameter.run_now === '1');
            seenSheet.appendRow([
              fCustomer, roomId, fBuilding, now, fSource,
              '', '', (fSource === 'reins' ? fReinsNo : fUrl),
              setNow ? now : ''  // I列: priority_requested_at
            ]);
            var viewUrl = 'https://form.ehomaki.com/property.html?customer=' +
                          encodeURIComponent(fCustomer) + '&room_id=' + roomId;
            resultHtml = '<div class="msg ok">' +
              '✓ テスト物件を追加しました<br>' +
              '<b>customer:</b> ' + fCustomer + '<br>' +
              '<b>room_id:</b> ' + roomId + '<br>' +
              '<b>source:</b> ' + fSource + '<br>' +
              '<b>URL:</b> ' + (fSource === 'reins' ? ('REINS物件番号: ' + fReinsNo) : fUrl) +
              (setNow ? '<br><b>✓ 優先キューにセット済み</b> (1分以内にChrome拡張がチェック)' : '') +
              '</div>' +
              (setNow
                ? '<div class="note">📱 拡張のダッシュボード(log.html)で「[優先空室確認]」ログを確認してください。<br>1分以内に LINE 通知 or Discord 通知が来るはずです。</div>'
                : '<a href="' + viewUrl + '" target="_blank" class="big-btn">📱 物件詳細ページを開いてテスト</a>'
              + '<div class="note">↑ 押すと別タブで開きます。「空室確認を依頼する」を押してテスト</div>');
          } catch (eAdd) {
            resultHtml = '<div class="msg err">エラー: ' + eAdd.message + '</div>';
          }
        }
      }

      var sources = ['itandi', 'ielove', 'essquare', 'reins'];
      var sourceOptions = sources.map(function(s) {
        return '<option value="' + s + '"' + (s === fSource ? ' selected' : '') + '>' + s + '</option>';
      }).join('');

      var webAppUrl = ScriptApp.getService().getUrl();
      var formHtml = '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">'
        + '<title>空室確認テスト</title>'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<base target="_top">'
        + '<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f7fa;padding:20px;color:#1a2538;max-width:600px;margin:0 auto}'
        + 'h1{font-size:20px;margin-bottom:16px;color:#3d6909}'
        + '.card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 4px 16px rgba(0,0,0,0.08);margin-bottom:16px}'
        + 'label{display:block;margin-top:12px;font-size:13px;color:#6b7280;font-weight:600}'
        + 'input,select{width:100%;padding:10px;font-size:14px;border:1px solid #ddd;border-radius:6px;margin-top:4px;box-sizing:border-box;font-family:inherit}'
        + 'input:focus,select:focus{outline:none;border-color:#6ea814}'
        + 'button{width:100%;padding:12px;margin-top:16px;font-size:15px;font-weight:700;border:none;border-radius:8px;background:#6ea814;color:#fff;cursor:pointer;font-family:inherit}'
        + 'button:hover{background:#5a8810}'
        + '.msg{padding:12px;border-radius:8px;margin-top:8px;font-size:14px;line-height:1.6}'
        + '.msg.ok{background:#f0faf4;color:#3d6909;border:1px solid #d4e7a8}'
        + '.msg.err{background:#fef2f2;color:#9b1c1c;border:1px solid #f5c2c2}'
        + '.big-btn{display:block;text-align:center;margin-top:12px;padding:14px;background:#06C755;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px}'
        + '.big-btn:hover{background:#04a747}'
        + '.note{font-size:12px;color:#888;margin-top:8px;text-align:center}'
        + '.examples{font-size:12px;color:#6b7280;margin-top:6px;line-height:1.6}'
        + '.examples code{background:#f5f5f5;padding:2px 6px;border-radius:3px;font-size:11px;display:inline-block;cursor:pointer}'
        + '.examples code:hover{background:#e0e9d5}'
        + '</style></head><body>'
        + '<h1>🧪 空室確認テスト</h1>'
        + (resultHtml ? ('<div class="card">' + resultHtml + '</div>') : '')
        + '<div class="card">'
        + '<label>顧客名</label>'
        + '<input type="text" id="f_customer" value="' + fCustomer + '" required>'
        + '<label>建物名</label>'
        + '<input type="text" id="f_building" value="' + fBuilding + '">'
        + '<label>ソース</label>'
        + '<select id="f_source" required><option value="">選択してください</option>' + sourceOptions + '</select>'
        + '<label>物件URL <span style="color:#999;font-weight:400;">(REINS以外)</span></label>'
        + '<input type="url" id="f_url" value="' + fUrl + '" placeholder="https://...">'
        + '<label>REINS物件番号 <span style="color:#999;font-weight:400;">(REINSの場合)</span></label>'
        + '<input type="text" id="f_reins" value="' + fReinsNo + '" placeholder="例: 12345">'
        + '<label style="margin-top:16px;display:flex;align-items:center;gap:8px;font-weight:400;">'
        + '<input type="checkbox" id="f_run_now" checked style="width:auto;margin:0;"> '
        + '<span>追加と同時に空室確認を実行 (推奨)</span></label>'
        + '<div style="font-size:11px;color:#888;margin-top:4px;">OFF にすると物件詳細ページのボタン経由でテストする形になります</div>'
        + '<button onclick="submitTest()">🚀 テスト物件を追加</button>'
        + '</div>'
        + '<script>'
        + 'function submitTest(){'
        + ' var u = "' + webAppUrl + '";'
        + ' var p = new URLSearchParams();'
        + ' p.set("action","availability_test_form");'
        + ' p.set("customer", document.getElementById("f_customer").value);'
        + ' p.set("building", document.getElementById("f_building").value);'
        + ' p.set("source", document.getElementById("f_source").value);'
        + ' p.set("url", document.getElementById("f_url").value);'
        + ' p.set("reins_prop_no", document.getElementById("f_reins").value);'
        + ' if (document.getElementById("f_run_now").checked) p.set("run_now", "1");'
        + ' window.top.location.href = u + "?" + p.toString();'
        + '}'
        + 'function setUrl(url){document.getElementById("f_url").value = url;}'
        + '</script>'
        + '<div class="card" style="font-size:12px;color:#666">'
        + '<b>📚 サンプルURL</b><div class="examples">'
        + '<b>ielove:</b><br><code>https://bb.ielove.jp/ielovebb/rent/detail/id/83533980/</code> (申込あり活性)<br>'
        + '<code>https://bb.ielove.jp/ielovebb/rent/detail/id/82911297/</code> (申込N件+物確不要)<br>'
        + '<code>https://bb.ielove.jp/ielovebb/rent/detail/id/83729590/</code> (Web申込NG/募集中)<br>'
        + '<code>https://bb.ielove.jp/ielovebb/rent/detail/id/83850922/</code> (要物確)<br>'
        + '<b>itandi:</b><br><code>https://itandibb.com/rent_rooms/52325996</code> (キャンセル待ち可)<br>'
        + '<code>https://itandibb.com/rent_rooms/74047171</code> (キャンセル待ち不可)<br>'
        + '</div></div>'
        + '</body></html>';
      return HtmlService.createHtmlOutput(formHtml).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    } catch (eF) {
      return HtmlService.createHtmlOutput('<h2>❌ エラー</h2><pre>' + eF.message + '</pre>');
    }
  }

  // スタッフが Discord で空室状況を返答するエンドポイント
  //   Discord メッセージのリンククリックで呼ばれ、HTML レスポンスを返す
  if (action === 'staff_reply_availability') {
    try {
      if (!_validateReinsApiKey(e.parameter.api_key)) {
        return HtmlService.createHtmlOutput('<h2>❌ 認証エラー</h2><p>api_keyが不正です。</p>');
      }
      var custSR = e.parameter.customer || '';
      var roomSR = e.parameter.room_id || '';
      var statusSR = e.parameter.status || '';
      var validStatusesSR = ['available', 'applied', 'closed'];
      if (validStatusesSR.indexOf(statusSR) < 0) {
        return HtmlService.createHtmlOutput('<h2>❌ エラー</h2><p>不正なstatus: ' + statusSR + '</p>');
      }
      var extrasSR = {};
      if (e.parameter.badge_count !== undefined) {
        var bc = parseInt(e.parameter.badge_count, 10);
        if (!isNaN(bc)) extrasSR.badgeCount = bc;
      }
      if (e.parameter.can_apply !== undefined) {
        extrasSR.canApply = (e.parameter.can_apply === '1' || e.parameter.can_apply === 'true');
      }
      var resSR = setPropertyAvailability(custSR, roomSR, statusSR, extrasSR);
      var statusLabel = {
        available: '🟢 募集中 (1番手で申込可)',
        applied: extrasSR.canApply === false ? '🟠 申込あり (キャンセル待ち通知のみ)' : '🟡 申込あり (順番待ちで申込可)',
        closed: '🔴 募集終了'
      }[statusSR] || statusSR;
      var html = '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">'
        + '<title>空室状況更新</title>'
        + '<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f7fa;padding:30px 20px;color:#1a2538}'
        + '.card{background:#fff;border-radius:12px;padding:30px;max-width:500px;margin:0 auto;box-shadow:0 4px 16px rgba(0,0,0,0.08)}'
        + 'h2{color:#3d6909;margin-bottom:16px}'
        + 'table{width:100%;margin:16px 0}td{padding:8px 0;font-size:14px}td:first-child{color:#6b7280;width:120px}'
        + '.note{margin-top:20px;padding:12px;background:#f0faf4;border-radius:8px;font-size:13px;color:#3d6909}'
        + '</style></head><body>'
        + '<div class="card">'
        + '<h2>' + (resSR.ok ? '✅ 更新完了' : '⚠️ 更新失敗') + '</h2>'
        + '<table>'
        + '<tr><td>顧客</td><td>' + custSR + ' 様</td></tr>'
        + '<tr><td>room_id</td><td>' + roomSR + '</td></tr>'
        + '<tr><td>ステータス</td><td>' + statusLabel + '</td></tr>'
        + '</table>'
        + (resSR.ok
          ? '<div class="note">✓ お客さんに自動的にLINE通知が送信されます。<br>このタブは閉じてOKです。</div>'
          : '<div class="note" style="color:#9b1c1c">' + (resSR.message || '不明なエラー') + '</div>')
        + '</div></body></html>';
      return HtmlService.createHtmlOutput(html);
    } catch (eSR) {
      return HtmlService.createHtmlOutput('<h2>❌ エラー</h2><pre>' + eSR.message + '</pre>');
    }
  }

  // 物件1件の現在の空室ステータス取得 (property.html がポーリング)
  if (action === 'get_availability_status') {
    try {
      var custS = e.parameter.customer || '';
      var roomS = e.parameter.room_id || '';
      var rS = (typeof getAvailabilityStatus === 'function')
        ? getAvailabilityStatus(custS, roomS)
        : { found: false, error: 'function not defined' };
      return ContentService.createTextOutput(JSON.stringify(rS))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (eS) {
      return ContentService.createTextOutput(JSON.stringify({ found: false, error: eS.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // 空室確認機能のテストユーザー判定 (property.html がボタン表示の有無を決めるのに使う)
  if (action === 'is_availability_test_user') {
    try {
      var custTu = e.parameter.customer || '';
      var enabled = (typeof isAvailabilityTestUser === 'function') && isAvailabilityTestUser(custTu);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, enabled: !!enabled }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (eTu) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, enabled: false, error: eTu.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // テストユーザーリスト管理 (api_key 必須): add / remove / list
  if (action === 'manage_availability_test_users') {
    try {
      if (!_validateReinsApiKey(e.parameter.api_key)) {
        return ContentService.createTextOutput(JSON.stringify({ error: 'invalid api_key' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      var op = e.parameter.op || 'list';
      var custM = e.parameter.customer || '';
      var userIdM = e.parameter.user_id || '';
      var rM = (typeof manageAvailabilityTestUsers === 'function')
        ? manageAvailabilityTestUsers(op, custM, userIdM)
        : { ok: false, message: 'function not defined' };
      return ContentService.createTextOutput(JSON.stringify(rM))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (eM) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, message: eM.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // keepalive: GASをウォームに保つためのpingエンドポイント (5分ごとにself-fetchで叩く)
  // 初回ヒット時にトリガー未登録なら自動登録する (bootstrap)
  if (action === 'keepalive') {
    try {
      var _triggers = ScriptApp.getProjectTriggers();
      var _hasKA = false;
      for (var _i = 0; _i < _triggers.length; _i++) {
        if (_triggers[_i].getHandlerFunction() === 'pingWebAppKeepAlive_') { _hasKA = true; break; }
      }
      if (!_hasKA) {
        ScriptApp.newTrigger('pingWebAppKeepAlive_').timeBased().everyMinutes(5).create();
        console.log('[keepalive] bootstrap: 5分トリガーを自動登録');
      }
      // cleanup トリガーも一緒に bootstrap (毎朝3時に 30日経過行を削除)
      var _hasCleanup = false;
      for (var _ic = 0; _ic < _triggers.length; _ic++) {
        if (_triggers[_ic].getHandlerFunction() === 'cleanupOldPropertyRecords') { _hasCleanup = true; break; }
      }
      if (!_hasCleanup && typeof cleanupOldPropertyRecords === 'function') {
        ScriptApp.newTrigger('cleanupOldPropertyRecords').timeBased().atHour(3).everyDays(1).create();
        console.log('[keepalive] bootstrap: 日次クリーンアップトリガー (毎朝3時) を登録');
      }
    } catch (_eKA) {
      console.warn('[keepalive] bootstrap失敗: ' + (_eKA && _eKA.message));
    }
    return ContentService
      .createTextOutput('ok')
      .setMimeType(ContentService.MimeType.TEXT);
  }

  // 手動クリーンアップ: doGet?action=cleanup_now&max_age_days=30
  //   30日経過の物件削除 + 1週間経過の paused/blocked/orphan 顧客削除 を一括実行
  if (action === 'cleanup_now') {
    try {
      if (!_validateReinsApiKey(e.parameter.api_key)) {
        return ContentService.createTextOutput(JSON.stringify({ error: 'invalid api_key' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      var days = parseInt(e.parameter.max_age_days || '30', 10);
      var r = cleanupOldPropertyRecords(days);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, result: r }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (eC) {
      return ContentService.createTextOutput(JSON.stringify({ error: eC.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // 配信停止/ブロック/手動削除顧客の物件削除 (1週間経過分のみ): 手動トリガー
  if (action === 'cleanup_inactive_now') {
    try {
      if (!_validateReinsApiKey(e.parameter.api_key)) {
        return ContentService.createTextOutput(JSON.stringify({ error: 'invalid api_key' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      var iDays = parseInt(e.parameter.max_age_days || '7', 10);
      var ir = cleanupInactiveCustomerProperties(iDays);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, result: ir }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (eCI) {
      return ContentService.createTextOutput(JSON.stringify({ error: eCI.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

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

  // --- SUUMO自動入稿関連GETエンドポイント ---
  if (action === 'get_patrol_criteria') {
    return handleGetPatrolCriteria(e);
  }

  if (action === 'get_suumo_queue') {
    return handleGetSuumoQueue(e);
  }

  if (action === 'suumo_approve') {
    return handleSuumoApprovePage(e);
  }

  if (action === 'suumo_patrol_config') {
    return handleSuumoPatrolConfigPage(e);
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
    // [PERF-doGet-criteria] 計測用 — 条件選択ページの遅延調査
    var _tCriteria = Date.now();
    console.log('[PERF-doGet-criteria] start action=' + action);
    const userId = e.parameter.userId;
    if (!userId) {
      return HtmlService.createHtmlOutput(
        '<html><body style="text-align:center;padding:40px;font-family:sans-serif;">' +
        '<p>パラメータが不正です。</p></body></html>'
      ).setTitle('エラー')
       .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    // プリレンダキャッシュチェック (focus パラメータが無い時のみ)
    // focus パラメータは条件変更提案の遷移時に該当セクションをハイライトするため
    // 個別レンダリングが必要なのでキャッシュをスキップする
    var _hasFocus = !!e.parameter.focus;
    if (!_hasFocus) {
      try {
        var _cached = _getCachedCriteriaHtml_(userId);
        if (_cached) {
          console.log('[PERF-doGet-criteria] cache hit +' + (Date.now() - _tCriteria) + 'ms size=' + _cached.length);
          return HtmlService.createHtmlOutput(_cached)
            .setTitle('お部屋の条件選択')
            .addMetaTag('viewport', 'width=device-width, initial-scale=1')
            .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
        }
      } catch (_eC) {
        console.warn('[PERF-doGet-criteria] cache取得失敗: ' + (_eC && _eC.message));
      }
    }

    let state = getState(userId);
    console.log('[PERF-doGet-criteria] +' + (Date.now() - _tCriteria) + 'ms getState完了 step=' + state.step);
    // CRITERIA_SELECT以降のステップならアクセス可能（再編集対応）。
    // ステップ範囲外の場合 (登録完了後の DONE/IDLE 等):
    //   - シートに既存条件があれば自動で読み込んで CRITERIA_SELECT に整備
    //     (条件変更提案メッセージの「まとめて変更する」「エリアを広げる」等で
    //      LIFF 経由でいきなりここに来るケースに対応)
    //   - 既存条件もなければブロック画面を出す
    if (!isCriteriaPageAllowed(state.step)) {
      try {
        var _tRead = Date.now();
        const existing = typeof readLatestCriteria === 'function' ? readLatestCriteria(userId) : null;
        console.log('[PERF-doGet-criteria] +' + (Date.now() - _tCriteria) + 'ms readLatestCriteria完了 (内部' + (Date.now() - _tRead) + 'ms) existing=' + !!existing);
        // NOTE: 以下の state 復元ロジックは _restoreStateForCriteriaPage_ にも複製されている。
        //       prerenderAndCacheCriteriaHtml_ から再利用される。
        if (existing) {
          state.step = STEPS.CRITERIA_SELECT;
          state.isChangeFlow = true;
          state.areaMethod = existing.areaMethod;
          state.selectedRoutes = existing.selectedRoutes;
          state.selectedCities = existing.selectedCities;
          state.selectedTowns = existing.selectedTowns || {};
          state.selectedStations = existing.selectedStations;
          state.data = {
            name: existing.name,
            reason: existing.reason,
            resident: existing.resident,
            move_in_date: existing.move_in_date,
            move_in_strict: existing.move_in_strict || false,
            rent_max: existing.rent_max,
            layouts: existing.layouts,
            walk: existing.walk,
            area_min: existing.area_min,
            building_age: existing.building_age,
            building_structures: existing.building_structures,
            equipment: existing.equipment,
            petType: existing.petType,
            notes: existing.notes
          };
          saveState(userId, state);
        } else {
          return HtmlService.createHtmlOutput(_buildCriteriaPageBlockedHtml(state.step))
            .setTitle('条件選択')
            .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
        }
      } catch (loadErr) {
        console.error('selectCriteria 自動ロード失敗: ' + loadErr.message);
        return HtmlService.createHtmlOutput(_buildCriteriaPageBlockedHtml(state.step))
          .setTitle('条件選択')
          .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
      }
    }
    const d = state.data || {};
    console.log('[PERF-doGet-criteria] +' + (Date.now() - _tCriteria) + 'ms テンプレ生成直前');
    const template = HtmlService.createTemplateFromFile('RouteSelectPage');
    template.userId = userId;
    template.routeCompanies = JSON.stringify(ROUTE_COMPANIES);
    template.selectedRoutes = JSON.stringify(state.selectedRoutes || []);
    template.stationData = JSON.stringify(STATION_DATA);
    template.selectedStations = JSON.stringify(state.selectedStations || {});
    template.tokyoCities = JSON.stringify(TOKYO_CITIES);
    template.selectedCities = JSON.stringify(state.selectedCities || []);
    template.selectedTowns = JSON.stringify(state.selectedTowns || {});
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
    // 条件変更提案のLINEメッセージから飛んできた時、該当セクションへフォーカス
    template.initFocus = String(e.parameter.focus || '').toLowerCase();
    console.log('[PERF-doGet-criteria] +' + (Date.now() - _tCriteria) + 'ms template.evaluate直前');
    var _evaluated = template.evaluate()
      .setTitle('お部屋の条件選択')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    console.log('[PERF-doGet-criteria] +' + (Date.now() - _tCriteria) + 'ms evaluate完了・return');
    return _evaluated;
  }

  // ── 物件再送付ページ ──
  if (action === 'resend') {
    return handleResendPage(e);
  }

  // ── 顧客管理ページ ──
  if (action === 'customer') {
    return handleCustomerPage(e);
  }

  // ── 管理者用 検索条件管理ページ ──
  if (action === 'admin') {
    return handleAdminPage(e);
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

  // ── SUUMO フォローアップメール: 検索条件自動登録 ──
  if (action === 'register_suumo_criteria') {
    return handleRegisterSuumoCriteria(e);
  }

  // ── SUUMO フォローアップメール: 類似物件検索API ──
  if (action === 'get_similar_properties') {
    return handleGetSimilarProperties(e);
  }

  // ── SUUMO フォローアップメール: 配信停止 ──
  if (action === 'unsubscribe') {
    return handleUnsubscribe(e);
  }

  // ── SUUMO フォローアップメール: ステータス確認API ──
  if (action === 'check_followup_status') {
    return handleCheckFollowupStatus(e);
  }

  // ── メール送信履歴ログ ──
  if (action === 'log_email_send') {
    return handleLogEmailSend(e);
  }

  // ── Gemini AI 物件整理 (承認ページから手動実行) ──
  if (action === 'ai_preprocess_property') {
    try {
      var apCustomer = e.parameter.customer || '';
      var apRoomId = e.parameter.room_id || '';
      var apResult = (typeof aiPreprocessProperty === 'function')
        ? aiPreprocessProperty(apCustomer, apRoomId)
        : { ok: false, message: 'function not defined' };
      return ContentService.createTextOutput(JSON.stringify(apResult))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (eAP) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, message: eAP.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // ── Claude AI 自動承認（手動実行用） ──
  if (action === 'auto_approve') {
    var result = autoApprovePendingProperties();
    return ContentService
      .createTextOutput(JSON.stringify(result))
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
 * 条件選択ページにアクセスできない時の親切なガイドHTMLを生成する。
 * 状態に応じて文言を切り替えて、何をすればいいかが分かるようにする。
 *  - state=IDLE/DONE: 「条件登録を最初から始めてください」
 *  - state=途中: 「まだ質問が残っています。LINEで続きをお答えください」
 */
function _buildCriteriaPageBlockedHtml(step) {
  // 条件登録フローの途中ステップ
  var inProgressSteps = [
    STEPS.NAME, STEPS.REASON, STEPS.REASON_CUSTOM,
    STEPS.RESIDENT, STEPS.RESIDENT_CUSTOM,
    STEPS.MOVE_IN_DATE, STEPS.MOVE_IN_PERIOD
  ];
  var inProgress = inProgressSteps.indexOf(step) >= 0;

  var icon = inProgress ? '✏️' : '📋';
  var title = inProgress
    ? '条件登録の途中です'
    : '条件登録から始めてください';
  var msg = inProgress
    ? 'まだ全ての質問にお答えいただいていないようです。<br>LINEのトーク画面に戻って、<br><b>残りの質問にお答えください</b>。'
    : 'このページを開く前に、LINEのトーク画面で<br><b>「条件登録」</b>とメッセージを送って、<br>いくつかの質問にお答えいただく必要があります。';
  var howto = inProgress
    ? '操作中の質問が見つからない場合は<br>「キャンセル」と送ってから、もう一度「条件登録」と送ってください。'
    : 'すでに登録済みの方は<br>「<b>条件変更</b>」と送ってください。';

  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>条件選択</title>'
    + '<style>'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;background:#f8f9fa;color:#333;padding:24px 16px;min-height:100vh}'
    + '.card{background:#fff;border-radius:16px;padding:32px 24px;max-width:480px;margin:24px auto;box-shadow:0 2px 12px rgba(0,0,0,0.08);text-align:center}'
    + '.icon{font-size:56px;margin-bottom:16px;display:block}'
    + 'h2{font-size:18px;margin-bottom:16px;color:#2c3e50;font-weight:bold}'
    + 'p{font-size:15px;line-height:1.8;color:#444;margin-bottom:20px}'
    + 'p.hint{font-size:13px;color:#888;margin-top:24px;padding-top:20px;border-top:1px solid #eee}'
    + '.btn{display:block;width:100%;background:#06C755;color:#fff;padding:14px 24px;border-radius:24px;text-decoration:none;font-weight:bold;font-size:16px;margin:16px 0;border:none;cursor:pointer}'
    + '.btn:active{opacity:0.85}'
    + 'b{color:#06C755}'
    + '</style></head><body>'
    + '<div class="card">'
    + '<span class="icon">' + icon + '</span>'
    + '<h2>' + title + '</h2>'
    + '<p>' + msg + '</p>'
    + '<button class="btn" onclick="window.close()">LINEに戻る</button>'
    + '<p class="hint">' + howto + '</p>'
    + '</div></body></html>';
}

/**
 * Web版総合条件選択ページからの送信処理。
 * google.script.run 経由で呼ばれる。
 */
function processCriteriaSelection(userId, criteria) {
  try {
    var state = getState(userId);
    console.log('processCriteriaSelection: userId=' + userId + ', step=' + state.step);

    if (!isCriteriaPageAllowed(state.step)) {
      state = _restoreStateForCriteriaPage_(userId, state);
      if (!state) {
        // 既存条件がない場合（初回登録中にstateがリセットされたケース）でも
        // フォームから全条件データが来ているので、新しいstateを作って処理を続行する
        console.log('processCriteriaSelection: no existing criteria to restore, creating fresh state');
        state = createInitialState();
        state.step = STEPS.CRITERIA_SELECT;
        state.data = {};
      }
      console.log('processCriteriaSelection: state restored/created, step=' + state.step);
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
    state.selectedTowns = criteria.selectedTowns || {};

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
    // 入居時期（フォームから送信された場合）
    if (criteria.move_in_date) {
      state.data.move_in_date = criteria.move_in_date;
    }
    state.data.move_in_strict = !!criteria.move_in_strict;

    // 条件変更フローの場合は直接保存して完了
    if (state.isChangeFlow) {
      writeToSheet(userId, state);
      clearState(userId);
      pushMessage(userId, [
        buildConditionSummaryFlex(state, '条件を更新しました'),
        textMsg('条件に合う新着物件が見つかり次第、お知らせいたします。')
      ]);
      return { success: true, message: '条件を更新しました。' };
    }

    // 直接保存して完了
    writeToSheet(userId, state);
    clearState(userId);

    pushMessage(userId, [
      buildConditionSummaryFlex(state, 'ご登録ありがとうございます'),
      textMsg('条件に合う新着物件が見つかり次第、お知らせいたします。\n\n条件の変更はメニューの「お部屋探しの条件を変える」からいつでも変更できます。')
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
  // 引越し時期: Date 型のまま渡されるケース (Google Sheets 自動型変換) に備えて日本語化
  var moveInLabel = '未選択';
  if (d.move_in_date instanceof Date) {
    moveInLabel = (d.move_in_date.getMonth() + 1) + '月' + d.move_in_date.getDate() + '日';
  } else if (d.move_in_date) {
    moveInLabel = String(d.move_in_date);
  }
  summary += '・引越し時期: ' + moveInLabel + '\n';

  if (state.areaMethod === 'city' && cities.length > 0) {
    var towns = state.selectedTowns || {};
    for (var ci = 0; ci < cities.length; ci++) {
      var cityName = cities[ci];
      var townList = towns[cityName] || [];
      if (townList.length > 0) {
        summary += '・' + cityName + ': ' + townList.join(', ') + '\n';
      } else {
        summary += '・' + cityName + '\n';
      }
    }
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
 * 顧客名 → LINE userId のマップを取得 (LINE Users シートから)
 */
function _getLineUserIdMapByCustomerName_() {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName('LINE Users');
    if (!sheet) return {};
    var data = sheet.getDataRange().getValues();
    var map = {};
    // 1行目はヘッダー (LINE userId / 顧客名 / 登録日時)
    for (var i = 1; i < data.length; i++) {
      var userId = String(data[i][0] || '').trim();
      var customerName = String(data[i][1] || '').trim();
      if (userId && customerName) map[customerName] = userId;
    }
    return map;
  } catch (e) {
    console.error('_getLineUserIdMapByCustomerName_ error: ' + e.message);
    return {};
  }
}

/**
 * LINE ブロック検知時に Discord (rent-researcher 用 webhook) に通知
 *
 * 通知先: スクリプトプロパティ DISCORD_WEBHOOK_URL
 * (PropertyApproval.js でお客様向け物件通知に使用している webhook と同じ)
 * SUUMO_DISCORD_WEBHOOK_URL は SUUMO 巡回専用なので流用しない。
 *
 * リトライ付き: 429 (レートリミット) のときは Retry-After ヘッダー or
 * Cloudflare 1015 のときは固定 10秒 待機して 最大 3回までリトライ。
 */
function _notifyLineBlockedToDiscord_(customerName) {
  try {
    var webhook = PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK_URL');
    if (!webhook) {
      console.log('[LINEブロック通知] DISCORD_WEBHOOK_URL 未設定でスキップ: ' + customerName);
      return;
    }
    // フォーラムチャンネルの場合は thread_name 必須 (Discord API: code 220001)
    // 通常チャンネルでも thread_name は無視されるだけなので、 安全のため常に付ける
    var payload = JSON.stringify({
      content: '⚠️ **LINE ブロック検知**\n' + customerName + ' 様\n→ 物件検索を自動的に停止しました (ブロック解除されれば次回検索時に自動再開)',
      thread_name: '⚠️ LINE ブロック検知: ' + customerName
    });

    var maxAttempts = 3;
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      var res = UrlFetchApp.fetch(webhook, {
        method: 'post',
        contentType: 'application/json',
        payload: payload,
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      var body = (res.getContentText() || '').substring(0, 200);

      // 成功 (Discord は通常 204 No Content / 200)
      if (code >= 200 && code < 300) {
        console.log('[LINEブロック通知] 送信成功: ' + customerName + ' → HTTP ' + code + ' (試行' + attempt + '/' + maxAttempts + ')');
        return;
      }

      // 429: Discord 側 or Cloudflare 1015 のレートリミット → リトライ
      if (code === 429) {
        // Discord 標準: retry_after (秒, JSON) or Retry-After ヘッダー
        // Cloudflare 1015: 固定で 10 秒待機
        var waitMs = 10000; // デフォルト 10 秒
        try {
          var json = JSON.parse(body);
          if (json && typeof json.retry_after === 'number') waitMs = Math.ceil(json.retry_after * 1000);
        } catch (_) {}
        var headers = res.getAllHeaders ? res.getAllHeaders() : {};
        var retryAfterHeader = headers['Retry-After'] || headers['retry-after'];
        if (retryAfterHeader) waitMs = parseInt(retryAfterHeader, 10) * 1000;
        // Cloudflare 1015 の場合は body に "error code: 1015" が含まれる
        if (body.indexOf('1015') >= 0) waitMs = Math.max(waitMs, 10000);
        // 上限 30 秒 (GAS の 6分制限を圧迫しないため)
        waitMs = Math.min(waitMs, 30000);

        console.log('[LINEブロック通知] レートリミット (HTTP 429): ' + customerName + ' → ' + waitMs + 'ms 待機後リトライ (試行' + attempt + '/' + maxAttempts + ') body=' + body);
        if (attempt < maxAttempts) {
          Utilities.sleep(waitMs);
          continue;
        }
      }

      // その他のエラー (4xx/5xx) → リトライしない
      console.log('[LINEブロック通知] 送信失敗 (リトライ対象外): ' + customerName + ' → HTTP ' + code + ' body=' + body);
      return;
    }

    console.log('[LINEブロック通知] リトライ上限到達で諦め: ' + customerName);
  } catch (e) {
    console.error('_notifyLineBlockedToDiscord_ error: ' + e.message);
  }
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

  // ── LINE ブロック検知 (リアルタイム・並列化) ──
  // 全顧客の userId を集めて UrlFetchApp.fetchAll で一括並列判定。
  // 100件超は自動チャンク分割 (bulkCheckLineBlocked 内)。
  // 50人で 1-2秒 で完了するためキャッシュ不要。
  var lineUserIdMap = _getLineUserIdMapByCustomerName_();
  var data = sheet.getDataRange().getValues();

  // 候補となる active な顧客の userId を先に集める
  var allUserIds = [];
  var nameToUserId = {}; // name -> userId
  var noUserIdNames = []; // userId 未紐付けの顧客名 (デバッグ用)
  for (var pi = 1; pi < data.length; pi++) {
    var pname = String(data[pi][1] || '').trim();
    if (!pname) continue;
    var pstatus = String(data[pi][18] || '').trim().toLowerCase();
    if (pstatus === 'paused' || pstatus === 'auto_paused') continue; // paused/auto_paused は除外、 ブロック判定不要
    var puid = lineUserIdMap[pname];
    if (puid) {
      nameToUserId[pname] = puid;
      allUserIds.push(puid);
    } else {
      noUserIdNames.push(pname);
    }
  }
  console.log('[LINEブロック判定] 対象顧客数=' + allUserIds.length
    + ' / userId未紐付け=' + noUserIdNames.length
    + (noUserIdNames.length > 0 ? ' [' + noUserIdNames.slice(0, 5).join(',') + '...]' : ''));

  // 並列ブロック判定
  var blockedMap = (allUserIds.length > 0) ? bulkCheckLineBlocked(allUserIds) : {};

  // 判定結果のサマリログ
  var blockedTrue = 0, blockedFalse = 0, blockedNull = 0;
  for (var bk in blockedMap) {
    if (blockedMap[bk] === true) blockedTrue++;
    else if (blockedMap[bk] === false) blockedFalse++;
    else blockedNull++;
  }
  console.log('[LINEブロック判定] 結果: ブロック中=' + blockedTrue
    + ' / 通常=' + blockedFalse + ' / 不明=' + blockedNull);
  // Discord webhook 設定確認 (rent-researcher 用)
  var _wh = PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK_URL');
  console.log('[LINEブロック判定] DISCORD_WEBHOOK_URL 設定=' + (_wh ? 'あり' : 'なし'));

  var criteria = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var name = String(row[1] || '').trim();
    if (!name) continue;

    // S列(18): 配信ステータス, Y列(24): 町名丁目（JSON）
    // V列(21): スヌーズ解除日時, W列(22): 配信頻度, X列(23): 最終配信日時
    var deliveryStatus = String(row[18] || '').trim().toLowerCase();
    var snoozeUntil = row[21];
    var frequency = String(row[22] || '').trim().toLowerCase();
    var lastSentAt = row[23];
    var nowMs = Date.now();

    // スヌーズ自動解除: snoozed かつ V列 <= 現在 → active に戻す
    if (deliveryStatus === 'snoozed') {
      if (snoozeUntil instanceof Date && snoozeUntil.getTime() <= nowMs) {
        try {
          sheet.getRange(i + 1, 19).setValue('active');
          sheet.getRange(i + 1, 22).setValue('');
        } catch (e) {}
        deliveryStatus = 'active';
      } else {
        continue; // まだスヌーズ中
      }
    }
    if (deliveryStatus === 'paused' || deliveryStatus === 'auto_paused') continue;

    // ── LINE ブロック状態反映 (事前一括判定の結果を参照) ──
    // ブロック検知 → 配信ステータスを 'blocked' に変更 + Discord 通知 + 検索除外
    // ブロック解除検知 → 'blocked' から 'active' に戻す (自動復活)
    // null (一時障害等で判定不能) は何もせず通常処理
    var customerUserId = nameToUserId[name];
    if (customerUserId) {
      var blocked = blockedMap[customerUserId];
      if (blocked === true) {
        var wasBlocked = (deliveryStatus === 'blocked');
        console.log('[LINEブロック判定] ブロック検知: ' + name + ' status=「' + deliveryStatus + '」 wasBlocked=' + wasBlocked + ' → ' + (wasBlocked ? '既知の為通知スキップ' : '新規検知 → 通知送信'));
        try {
          sheet.getRange(i + 1, 19).setValue('blocked');  // S列: 配信ステータス
          // U列(21): 停止/ブロック日時を記録 (まだ未記録の場合のみ — 1週間カウントの起点)
          var existingTs = sheet.getRange(i + 1, 21).getValue();
          if (!existingTs) {
            sheet.getRange(i + 1, 21).setValue(new Date());
          }
        } catch (e) {}
        // 新規検知時のみ Discord 通知 (既に blocked だった場合は通知しない)
        if (!wasBlocked) {
          _notifyLineBlockedToDiscord_(name);
        }
        continue; // 検索条件から除外
      } else if (blocked === false) {
        // 'blocked' から自動復活 → 'active' に戻す
        if (deliveryStatus === 'blocked') {
          try {
            sheet.getRange(i + 1, 19).setValue('active');
          } catch (e) {}
          deliveryStatus = 'active';
        }
      }
      // null は判定不能 → 既存ステータスのまま処理続行
    }
    if (deliveryStatus === 'blocked') continue;

    // 配信頻度フィルタ
    if (frequency === 'weekly' || frequency === 'every2' || frequency === 'every3' || frequency === 'biweekly') {
      var intervalDays = 7;
      if (frequency === 'every2') intervalDays = 2;
      else if (frequency === 'every3' || frequency === 'biweekly') intervalDays = 3;
      if (lastSentAt instanceof Date) {
        var elapsedMs = nowMs - lastSentAt.getTime();
        if (elapsedMs < intervalDays * 24 * 60 * 60 * 1000) continue;
      }
      // 通過したので最終配信日時を更新
      try { sheet.getRange(i + 1, 24).setValue(new Date()); } catch (e) {}
    }

    // 列マッピング (SheetWriter.js準拠):
    // A(0):タイムスタンプ B(1):名前 C(2):都道府県 D(3):市区町村
    // E(4):路線(駅名) F(5):駅名 G(6):徒歩 H(7):賃料上限
    // I(8):間取り J(9):面積 K(10):築年数 L(11):構造
    // M(12):設備 N(13):理由 O(14):引越し時期 P(15):その他 Q(16):ペット
    // R(17):居住者 S(18):配信ステータス
    var routesWithStations = _parseRoutesWithStations(row[4]);
    var allRoutes = routesWithStations.map(function(r) { return r.route; });
    var allStations = _splitCSV(row[5]);

    // Y列(24): 町名丁目（JSON）
    var townsJson = String(row[24] || '').trim();
    var selectedTowns = {};
    if (townsJson) {
      try { selectedTowns = JSON.parse(townsJson); } catch (e) {}
    }

    // AC列(29): 最終REINS検索日 — REINS検索時の登録年月日フィルタ起点
    var lastReinsSearch = row[28] || '';
    var lastReinsSearchStr = '';
    if (lastReinsSearch instanceof Date) {
      lastReinsSearchStr = Utilities.formatDate(lastReinsSearch, 'Asia/Tokyo', 'yyyy-MM-dd');
    } else if (lastReinsSearch) {
      lastReinsSearchStr = String(lastReinsSearch).trim();
    }

    // AE列(30, index 30): バストイレ別の処理モード ('alert' or 'skip')
    var btMode = String(row[30] || '').trim().toLowerCase();
    if (btMode !== 'skip') btMode = 'alert'; // デフォルト alert

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
      move_in_date: String(row[14] || ''),
      move_in_strict: String(row[26] || '').trim().toLowerCase() === 'true',  // AA列(27): 入居時期厳守
      notes: String(row[15] || ''),
      selectedTowns: selectedTowns,
      lastReinsSearch: lastReinsSearchStr,
      btMode: btMode
    });
  }

  return ContentService
    .createTextOutput(JSON.stringify({ criteria: criteria }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST: REINS検索完了後に顧客ごとの最終検索日をAC列(29)に記録する。
 * Chrome拡張から各顧客のREINS検索が完了するたびに呼ばれる。
 * @param {Object} json - { api_key, customer_name, search_date }
 */
function _handleUpdateReinsSearchDate(json) {
  if (!_validateReinsApiKey(json.api_key)) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'invalid api_key' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var customerName = String(json.customer_name || '').trim();
  if (!customerName) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'customer_name is required' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var searchDate = json.search_date || Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
  var data = sheet.getDataRange().getValues();
  var updated = false;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1] || '').trim() === customerName) {
      sheet.getRange(i + 1, 29).setValue(searchDate); // AC列(29)
      updated = true;
      break;
    }
  }
  return ContentService.createTextOutput(JSON.stringify({ ok: updated, customer: customerName, date: searchDate }))
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
  // dedupキー (住所+部屋番号+面積+間取り) ベースの重複検知用に、 sent 行からも
  // dedupキーを収集して返す。Chrome拡張側で room_id ではなく dedupキーで
  // 照合することで、 itandi の property_id 変動 (再掲載で別IDになる) でも
  // 同じ物件として認識できる。
  var seen_dedup_keys = {};

  // 承認待ち物件
  // status='sent' (送信済み) は 通知済み物件 シートで管理されるためここでは除外。
  // ただし dedupキー生成のために JSON は読み取る。
  var pendingSheet = ss.getSheetByName(PENDING_SHEET_NAME);
  if (pendingSheet) {
    var pData = pendingSheet.getDataRange().getValues();
    for (var i = 1; i < pData.length; i++) {
      var pStatus = String(pData[i][10] || '');
      var customer = String(pData[i][0] || '');
      var roomId = String(pData[i][2] || '');

      // sent 行も含めて dedup キーを生成
      if (pStatus === 'sent' || pStatus === 'pending') {
        try {
          var parsedDk = JSON.parse(String(pData[i][9] || ''));
          var dk = _buildDedupKeyForGas_({
            address: parsedDk.address,
            room_number: parsedDk.room_number,
            area: parsedDk.area,
            layout: parsedDk.layout
          });
          if (dk && customer) {
            if (!seen_dedup_keys[customer]) seen_dedup_keys[customer] = [];
            if (seen_dedup_keys[customer].indexOf(dk) < 0) {
              seen_dedup_keys[customer].push(dk);
            }
          }
        } catch (_) {}
      }

      if (pStatus === 'sent') continue; // room_id は SEEN_SHEET で管理
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

  // Chrome 拡張に伝える「30日重複マップから消すべきエントリ」のリスト
  //   - AdminPage で履歴リセットされた際に蓄積される
  //   - 24時間以内のものを返す (Chrome拡張側は冪等処理なので二重実行OK)
  var pendingDedupResets = [];
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('pending_dedup_resets') || '[]';
    var allList = JSON.parse(raw);
    if (Array.isArray(allList)) {
      var nowMs = Date.now();
      var cutoffMs = nowMs - 24 * 60 * 60 * 1000;
      pendingDedupResets = allList.filter(function(e) {
        return e && e.ts && e.ts > cutoffMs;
      });
    }
  } catch (eR) {
    console.warn('pending_dedup_resets read error: ' + eR.message);
  }

  return ContentService
    .createTextOutput(JSON.stringify({
      seen_ids: seen_ids,
      seen_dedup_keys: seen_dedup_keys,
      pending_dedup_resets: pendingDedupResets
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * dedup キー生成 (Chrome拡張の __buildPropertyDedupKey と同等のロジック)。
 * 住所(町丁目まで) + 部屋番号 + 面積(小数2桁) + 間取り を正規化して連結。
 */
function _buildDedupKeyForGas_(prop) {
  if (!prop) return '';
  // 全角英数字 → 半角
  var toHalf = function(s) {
    return String(s || '').replace(/[Ａ-Ｚａ-ｚ０-９]/g, function(c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
  };
  // 漢数字 → アラビア
  var kanjiMap = { '一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9','十':'10' };
  var kanjiToA = function(s) {
    return String(s || '').replace(/[一二三四五六七八九十]/g, function(c) { return kanjiMap[c] || c; });
  };
  // 都道府県プレフィックス除去
  var stripPref = function(s) {
    return String(s || '').replace(/^(東京都|北海道|大阪府|京都府|.{2,3}県)/, '');
  };
  // 住所処理
  var addr = toHalf(prop.address);
  addr = kanjiToA(addr);
  addr = stripPref(addr);
  addr = addr.replace(/(\d+)丁目.*$/, '$1丁目');
  addr = addr.replace(/\s+/g, '').toLowerCase();
  // 部屋番号
  var room = toHalf(prop.room_number);
  room = kanjiToA(room).replace(/[〇○]/g, '0');
  room = room.replace(/[^\d]/g, '');
  // 面積 (小数2桁にして100倍)
  var area = Math.round((parseFloat(prop.area) || 0) * 100);
  // 間取り
  var layout = toHalf(prop.layout).replace(/\s+/g, '').toLowerCase();
  layout = layout.replace(/ワンルーム|わんるーむ|wanru-mu/g, '1r');
  // 4要素揃わないとキー化不可
  if (!addr || !room || !area || !layout) return '';
  return addr + '|' + room + '|' + area + '|' + layout;
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
  // Discord顧客スレッドIDを保存（Chrome拡張から受信）
  if (json.discord_thread_id && customerName) {
    try {
      PropertiesService.getScriptProperties().setProperty('DISCORD_THREAD_' + customerName, json.discord_thread_id);
    } catch(e) { console.error('discord_thread_id保存失敗: ' + e.message); }
  }
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

  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
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
        area: p.area || 0,
        layout: p.layout || '',
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
        warnings_text: p.warnings_text || '',
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
      // 既存 sent 行の場合、SEEN_SHEET にエントリがなければ補完する
      // (履歴リセット後に SEEN_SHEET が空になると seenIds チェックをすり抜けるため)
      try {
        var existingStatus = String(existingData[rowNum - 1][10] || '');
        if (existingStatus === 'sent') {
          var seenSh = ss.getSheetByName(SEEN_SHEET_NAME);
          if (seenSh) {
            var seenAllData = seenSh.getDataRange().getValues();
            var foundInSeen = false;
            for (var si = 1; si < seenAllData.length; si++) {
              if (String(seenAllData[si][0]) === customerName && String(seenAllData[si][1]) === roomId) {
                foundInSeen = true;
                break;
              }
            }
            if (!foundInSeen) {
              var source = p.source || 'reins';
              var sourceRef = (source === 'reins') ? (p.reins_property_number || '') : (p.url || '');
              seenSh.appendRow([customerName, roomId, p.building_name || '', now, source, '', '', sourceRef]);
              console.log('[SEEN補完] ' + customerName + ' / ' + roomId + ' をSEEN_SHEETに追加');
            }
          }
        }
      } catch (seenErr) {
        console.warn('SEEN_SHEET 補完エラー: ' + seenErr.message);
      }
      skipped++;
      continue;
    }

    sheet.appendRow([
      customerName,                    // A: customer_name
      String(p.building_id || ''),     // B: building_id (text化)
      String(roomId),                  // C: room_id (text化)
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

    // 純粋に数字だけのID(building_id, room_id)が Google Sheets側で数値として
    // 解釈されると、14桁以上だと指数表記(5.34E+13)に化けて精度を失う。
    // 追記直後にセルをテキストフォーマット('@')に設定し、値を文字列で
    // 上書きすることで数値化を防ぐ。
    try {
      var newRowIdx = sheet.getLastRow();
      sheet.getRange(newRowIdx, 2).setNumberFormat('@').setValue(String(p.building_id || ''));
      sheet.getRange(newRowIdx, 3).setNumberFormat('@').setValue(String(roomId));
    } catch (fmtErr) {
      console.warn('承認待ち物件 text format設定失敗: ' + fmtErr.message);
    }

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

// ══════════════════════════════════════════════════════════
//  管理者用 検索条件管理ページ
// ══════════════════════════════════════════════════════════

/**
 * 物件再送付ページのURLを返す（AdminPageから遷移用）
 */
function getResendPageUrl() {
  var baseUrl = ScriptApp.getService().getUrl();
  var apiKey = PropertiesService.getScriptProperties().getProperty('REINS_API_KEY') || '';
  return baseUrl + '?action=resend&api_key=' + encodeURIComponent(apiKey);
}

/**
 * 物件再送付ページを表示する。
 */
function handleResendPage(e) {
  if (!_validateReinsApiKey(e.parameter.api_key)) {
    return HtmlService.createHtmlOutput(
      '<html><body style="text-align:center;padding:40px;font-family:sans-serif;">' +
      '<h3>認証エラー</h3><p>api_key が正しくありません。</p></body></html>'
    ).setTitle('認証エラー');
  }
  var customers = getExistingCustomers_();
  var template = HtmlService.createTemplateFromFile('ResendPage');
  template.adminCustomers = JSON.stringify(customers);
  return template.evaluate()
    .setTitle('物件再送付')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 管理者ページを表示する。api_keyで認証。
 */
function handleAdminPage(e) {
  if (!_validateReinsApiKey(e.parameter.api_key)) {
    return HtmlService.createHtmlOutput(
      '<html><body style="text-align:center;padding:40px;font-family:sans-serif;">' +
      '<h3>認証エラー</h3><p>api_key が正しくありません。</p></body></html>'
    ).setTitle('認証エラー');
  }

  var customers = getExistingCustomers_();
  var initCustomer = e.parameter.customer || '';

  var template = HtmlService.createTemplateFromFile('AdminPage');
  template.routeCompanies = JSON.stringify(ROUTE_COMPANIES);
  template.stationData = JSON.stringify(STATION_DATA);
  template.tokyoCities = JSON.stringify(TOKYO_CITIES);
  template.adminCustomers = JSON.stringify(customers);
  template.initCustomer = JSON.stringify(initCustomer);

  return template.evaluate()
    .setTitle('検索条件管理（管理者）')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 既存顧客の一覧を取得する（管理者ページ用）。
 * @return {Array<{name: string, lineUserId: string}>}
 */
function getExistingCustomers_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var criteriaSheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
  var luSheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);

  // 検索条件シートから顧客名を取得 + S列(index 18)の配信ステータスで除外
  var criteriaData = criteriaSheet.getDataRange().getValues();
  var customers = [];
  var nameSet = {};
  var excludeNames = {};
  for (var i = 1; i < criteriaData.length; i++) {
    var name = String(criteriaData[i][1] || '').trim();
    if (!name) continue;
    // S列 (index 18): 配信ステータス — blocked/paused/auto_paused は除外
    var deliveryStatus = String(criteriaData[i][18] || '').trim().toLowerCase();
    if (deliveryStatus === 'blocked' || deliveryStatus === 'paused' || deliveryStatus === 'auto_paused') {
      excludeNames[name] = true;
      continue;
    }
    if (!nameSet[name]) {
      nameSet[name] = true;
      customers.push({ name: name, lineUserId: '' });
    }
  }

  // LINE Usersシートから userId を紐付け
  if (luSheet) {
    var luData = luSheet.getDataRange().getValues();
    for (var i = 1; i < luData.length; i++) {
      var luName = String(luData[i][1] || '').trim();
      var luId = String(luData[i][0] || '').trim();
      for (var j = 0; j < customers.length; j++) {
        if (customers[j].name === luName && luId) {
          customers[j].lineUserId = luId;
          break;
        }
      }
    }
  }

  return customers;
}

/**
 * 顧客名から検索条件を読み込む（管理者ページの動的読み込み用）。
 * google.script.run から呼ばれる。
 * @param {string} customerName
 * @return {Object|null} readLatestCriteria と同じ形式
 */
function loadCustomerCriteriaByName(customerName) {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return null;

    var data = sheet.getDataRange().getValues();
    var latestRow = null;
    for (var j = 1; j < data.length; j++) {
      if (String(data[j][1] || '').trim() === customerName) {
        latestRow = data[j];
      }
    }
    if (!latestRow) return null;

    function splitCSV(val) {
      if (!val) return [];
      return String(val).split(/[,、]\s*/).filter(function(s) { return s.length > 0; });
    }

    var cities = splitCSV(latestRow[3]);
    var routeStationRaw = String(latestRow[4] || '');
    var stations = splitCSV(latestRow[5]);
    var walkRaw = latestRow[6] ? String(latestRow[6]) : '';
    var rentRaw = latestRow[7] ? String(latestRow[7]) : '';
    var layouts = splitCSV(latestRow[8]);
    var areaRaw = latestRow[9] ? String(latestRow[9]) : '';

    var walk = walkRaw && walkRaw !== '指定しない' && !/分/.test(walkRaw) ? walkRaw + '分以内' : walkRaw;
    var rentMax = rentRaw && !/万円/.test(rentRaw) ? rentRaw + '万円' : rentRaw;
    var areaMin = areaRaw && areaRaw !== '指定しない' && !/m²|m2/.test(areaRaw) ? areaRaw + 'm²' : areaRaw;

    var buildingAge = latestRow[10] ? String(latestRow[10]) : '';
    var buildingStructures = splitCSV(latestRow[11]);
    var equipment = splitCSV(latestRow[12]);
    var reason = latestRow[13] ? String(latestRow[13]) : '';
    var moveInDate = latestRow[14] ? String(latestRow[14]) : '';
    var notes = latestRow[15] ? String(latestRow[15]) : '';
    var petType = latestRow[16] ? String(latestRow[16]) : '';
    var resident = latestRow[17] ? String(latestRow[17]) : '';
    var townsJson = latestRow[24] ? String(latestRow[24]) : '';
    var selectedTownsObj = {};
    if (townsJson) {
      try { selectedTownsObj = JSON.parse(townsJson); } catch(e) {}
    }
    var moveInStrict = String(latestRow[26] || '').trim().toLowerCase() === 'true';

    // 路線(駅名)形式をパース
    var routes = [];
    var selectedStations = {};
    if (routeStationRaw) {
      var parts = [];
      var depth = 0;
      var current = '';
      for (var ci = 0; ci < routeStationRaw.length; ci++) {
        var ch = routeStationRaw[ci];
        if (ch === '(') { depth++; current += ch; }
        else if (ch === ')') { depth--; current += ch; }
        else if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; }
        else { current += ch; }
      }
      if (current.trim()) parts.push(current.trim());

      for (var pi = 0; pi < parts.length; pi++) {
        var part = parts[pi];
        var parenIdx = part.indexOf('(');
        if (parenIdx >= 0 && part.charAt(part.length - 1) === ')') {
          var routeName = part.substring(0, parenIdx).trim();
          var stasStr = part.substring(parenIdx + 1, part.length - 1);
          var stas = stasStr.split(/[,、]\s*/).filter(function(s) { return s.length > 0; });
          routes.push(routeName);
          if (stas.length > 0) selectedStations[routeName] = stas;
        } else {
          var routeName2 = part.trim();
          if (routeName2) {
            routes.push(routeName2);
            var routeStations2 = STATION_DATA[routeName2] || [];
            var matched2 = [];
            for (var s2 = 0; s2 < stations.length; s2++) {
              if (routeStations2.indexOf(stations[s2]) >= 0) {
                matched2.push(stations[s2]);
              }
            }
            if (matched2.length > 0) selectedStations[routeName2] = matched2;
          }
        }
      }
    }

    var btMode = String(latestRow[30] || '').trim().toLowerCase();
    if (btMode !== 'skip') btMode = 'alert';

    return {
      name: customerName,
      reason: reason,
      resident: resident,
      move_in_date: moveInDate,
      move_in_strict: moveInStrict,
      rent_max: rentMax,
      layouts: layouts,
      walk: walk || '指定しない',
      area_min: areaMin || '指定しない',
      building_age: buildingAge || '指定しない',
      building_structures: buildingStructures,
      equipment: equipment,
      petType: petType,
      notes: notes,
      areaMethod: cities.length > 0 ? 'city' : 'route',
      selectedRoutes: routes,
      selectedCities: cities,
      selectedStations: selectedStations,
      selectedTowns: selectedTownsObj,
      btMode: btMode
    };
  } catch (e) {
    console.error('loadCustomerCriteriaByName error: ' + e.message);
    return null;
  }
}

/**
 * 管理者ページから検索条件を保存する。
 * google.script.run 経由で呼ばれる。
 * writeToSheet のロジックを再利用するが、LINE state管理はバイパスする。
 * @param {string} customerName
 * @param {string} lineUserId
 * @param {Object} criteria
 * @return {{success: boolean, message: string}}
 */
function processAdminCriteria(customerName, lineUserId, criteria) {
  try {
    if (!customerName) {
      return { success: false, message: '顧客名を入力してください。' };
    }

    // バリデーション
    if (criteria.areaMethod === 'route') {
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

    // writeToSheet に渡すための state オブジェクトを構築
    var state = {
      data: {
        name: customerName,
        rent_max: criteria.rentMax || '',
        layouts: criteria.layouts || [],
        walk: criteria.walkMax || '指定しない',
        area_min: criteria.areaMin || '指定しない',
        building_age: criteria.buildingAge || '指定しない',
        building_structures: criteria.buildingStructures || [],
        equipment: criteria.equipment || [],
        petType: criteria.petType || '',
        notes: criteria.otherConditions || '',
        reason: '',
        move_in_date: criteria.moveInDate || '',
        move_in_strict: !!criteria.moveInStrict,
        resident: ''
      },
      areaMethod: criteria.areaMethod || 'route',
      selectedRoutes: criteria.selectedRoutes || [],
      selectedStations: criteria.selectedStations || {},
      selectedCities: criteria.selectedCities || [],
      selectedTowns: criteria.selectedTowns || {}
    };

    // 既存の理由・引越し時期・居住者を保持（上書きしない）
    var existing = loadCustomerCriteriaByName(customerName);
    if (existing) {
      if (!state.data.reason && existing.reason) state.data.reason = existing.reason;
      if (!state.data.move_in_date && existing.move_in_date) {
        state.data.move_in_date = existing.move_in_date;
        // 入居時期を変更しなかった場合、既存のstrict設定も保持
        if (!criteria.moveInDate) state.data.move_in_strict = existing.move_in_strict || false;
      }
      if (!state.data.resident && existing.resident) state.data.resident = existing.resident;
    }

    // userId: LINE User IDがあればそれを、なければダミー
    var userId = lineUserId || 'admin_' + Date.now();

    // スプレッドシートに書き込み
    writeToSheet(userId, state);

    // バストイレ別モードを AE列(31) に保存
    if (criteria.btMode) {
      try {
        var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
        var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
        if (sheet) {
          var data = sheet.getDataRange().getValues();
          for (var bi = data.length - 1; bi >= 1; bi--) {
            if (String(data[bi][1] || '').trim() === customerName) {
              sheet.getRange(bi + 1, 31).setValue(criteria.btMode);
              break;
            }
          }
        }
      } catch (btErr) {
        console.warn('btMode保存エラー: ' + btErr.message);
      }
    }

    // LINE User IDが指定されていれば LINE Users シートにも保存
    if (lineUserId) {
      saveLineUser(lineUserId, customerName);
    }

    return { success: true, message: customerName + ' の検索条件を保存しました。' };
  } catch (err) {
    console.error('processAdminCriteria Error: ' + err.message + '\nStack: ' + (err.stack || 'N/A'));
    return { success: false, message: 'エラーが発生しました: ' + err.message };
  }
}

/**
 * リッチな条件サマリーFlex Bubbleを構築する。
 * 新規条件送信・条件変更通知の両方で使用。
 * @param {Array} summaryRows - _buildConditionSummaryRows_ の戻り値
 * @param {boolean} isChanged - 条件変更かどうか
 * @param {string} customerName - 顧客名
 * @returns {Object} LINE Flex Bubble オブジェクト
 */
function _buildRichConditionBubble_(summaryRows, isChanged, customerName) {
  // カラーテーマ
  var primary = isChanged ? '#e67e22' : '#1a7f37';
  var primaryLight = isChanged ? '#fef5ec' : '#eaf7ed';
  var primaryBorder = isChanged ? '#f5d5b0' : '#b8e0c0';
  var accent = isChanged ? '#d35400' : '#15803d';

  // ヘッダー: グラデーション風の2段構成
  var headerTitle = isChanged ? '条件を更新しました' : 'お部屋探しの条件';
  var headerSub = isChanged
    ? '新しい条件でぴったりの物件をお探しします'
    : (customerName ? customerName + ' 様の希望条件をまとめました' : 'ご希望の条件をまとめました');

  var bubble = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: primary,
      paddingAll: 'xl',
      paddingTop: 'xxl',
      paddingBottom: 'xl',
      spacing: 'sm',
      contents: [
        {
          type: 'text',
          text: headerTitle,
          weight: 'bold',
          size: 'xl',
          color: '#ffffff',
          align: 'center',
          adjustMode: 'shrink-to-fit'
        },
        {
          type: 'text',
          text: headerSub,
          size: 'xs',
          color: isChanged ? '#fde8d0' : '#c6f0cd',
          align: 'center',
          wrap: true,
          margin: 'sm'
        }
      ]
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'lg',
      paddingAll: 'xl',
      paddingTop: 'lg',
      contents: [
        // 条件カード
        {
          type: 'box',
          layout: 'vertical',
          backgroundColor: primaryLight,
          cornerRadius: 'lg',
          paddingAll: 'lg',
          spacing: 'md',
          borderColor: primaryBorder,
          borderWidth: '1px',
          contents: summaryRows
        },
        // 区切り線
        { type: 'separator', color: '#e8e8e8', margin: 'sm' },
        // フッターメッセージ
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'xs',
          paddingStart: 'sm',
          paddingEnd: 'sm',
          contents: [
            {
              type: 'text',
              text: isChanged
                ? 'この条件で改めて物件をお探しします。'
                : 'この条件でぴったりの物件をお探しします。',
              size: 'sm',
              color: accent,
              weight: 'bold',
              wrap: true
            },
            {
              type: 'text',
              text: '条件の変更はメニューの「お部屋探しの条件を変える」からいつでもできます。',
              size: 'xxs',
              color: '#999999',
              wrap: true,
              margin: 'sm'
            }
          ]
        }
      ]
    }
  };

  return bubble;
}

/**
 * 管理者ページから顧客にLINEで検索条件サマリーを送信する。
 * google.script.run 経由で呼ばれる。
 * @param {string} customerName
 * @param {string} [messageType='new'] - 'new': 通常の条件送信, 'changed': 条件変更通知
 */
function sendConditionSummaryToLine(customerName, messageType) {
  try {
    if (!customerName) return { success: false, message: '顧客名が指定されていません。' };

    var criteria = loadCustomerCriteriaByName(customerName);
    if (!criteria) return { success: false, message: customerName + ' の検索条件が見つかりません。' };

    var lineUserId = findLineUserId(customerName);
    if (!lineUserId) return { success: false, message: customerName + ' のLINE User IDが登録されていません。' };

    // _buildConditionSummaryRows_ 用の state オブジェクトを構築
    var state = {
      data: {
        move_in_date: criteria.move_in_date || '',
        move_in_strict: criteria.move_in_strict || false,
        rent_max: criteria.rent_max || '',
        layouts: criteria.layouts || [],
        walk: criteria.walk || '指定しない',
        area_min: criteria.area_min || '指定しない',
        building_age: criteria.building_age || '指定しない',
        building_structures: criteria.building_structures || [],
        equipment: criteria.equipment || [],
        petType: criteria.petType || '',
        notes: criteria.notes || ''
      },
      areaMethod: criteria.areaMethod || 'route',
      selectedRoutes: criteria.selectedRoutes || [],
      selectedCities: criteria.selectedCities || [],
      selectedStations: criteria.selectedStations || {},
      selectedTowns: criteria.selectedTowns || {}
    };

    var summaryRows = _buildConditionSummaryRows_(state);

    var isChanged = (messageType === 'changed');

    // リッチなFlexバブルを構築
    var bubble = _buildRichConditionBubble_(summaryRows, isChanged, customerName);

    var flexMessage = {
      type: 'flex',
      altText: isChanged ? '検索条件を変更しました' : customerName + ' 様のお部屋探し条件',
      contents: bubble
    };

    pushMessage(lineUserId, [flexMessage]);

    var label = isChanged ? '条件変更通知' : '条件';
    return { success: true, message: customerName + ' にLINEで' + label + 'を送信しました。' };
  } catch (err) {
    console.error('sendConditionSummaryToLine Error: ' + err.message);
    return { success: false, message: 'エラーが発生しました: ' + err.message };
  }
}

// ══════════════════════════════════════════════════════════
//  条件登録フォームのプリレンダリング & GASキャッシュ
//  (LINEメッセージ送信時にHTMLを事前生成 → CacheServiceに保存 →
//   ユーザーがLIFFタップした時はキャッシュから即返却)
// ══════════════════════════════════════════════════════════

/**
 * state.step が CRITERIA_SELECT 範囲外の場合、シートの既存条件を読み込んで
 * state を CRITERIA_SELECT に復元する。doGet と prerender で共通利用するヘルパ。
 *
 * @param {string} userId
 * @param {Object} state
 * @return {Object|null} 復元後の state、できなければ null
 */
function _restoreStateForCriteriaPage_(userId, state) {
  if (!state) state = getState(userId);
  if (isCriteriaPageAllowed(state.step)) return state;
  var existing = typeof readLatestCriteria === 'function' ? readLatestCriteria(userId) : null;
  if (!existing) return null;
  state.step = STEPS.CRITERIA_SELECT;
  state.isChangeFlow = true;
  state.areaMethod = existing.areaMethod;
  state.selectedRoutes = existing.selectedRoutes;
  state.selectedCities = existing.selectedCities;
  state.selectedTowns = existing.selectedTowns || {};
  state.selectedStations = existing.selectedStations;
  state.data = {
    name: existing.name,
    reason: existing.reason,
    resident: existing.resident,
    move_in_date: existing.move_in_date,
    move_in_strict: existing.move_in_strict || false,
    rent_max: existing.rent_max,
    layouts: existing.layouts,
    walk: existing.walk,
    area_min: existing.area_min,
    building_age: existing.building_age,
    building_structures: existing.building_structures,
    equipment: existing.equipment,
    petType: existing.petType,
    notes: existing.notes
  };
  saveState(userId, state);
  return state;
}

/**
 * 指定 userId のフォームHTMLを事前レンダリングしてCacheServiceに保存する。
 * 保存キー: criteria_html_<userId>  TTL: 10分
 *
 * @param {string} userId
 * @return {boolean} 成功なら true
 */
function prerenderAndCacheCriteriaHtml_(userId) {
  try {
    if (!userId) return false;
    var _t0 = Date.now();
    var state = getState(userId);
    if (!isCriteriaPageAllowed(state.step)) {
      // 登録完了後 (DONE/IDLE 等) → シートの既存条件で state を復元する
      // (条件変更提案メッセージ用のフロー)
      state = _restoreStateForCriteriaPage_(userId, state);
      if (!state) {
        // 既存条件もない → プリレンダ不可
        return false;
      }
    }
    var d = state.data || {};
    var template = HtmlService.createTemplateFromFile('RouteSelectPage');
    template.userId = userId;
    template.routeCompanies = JSON.stringify(ROUTE_COMPANIES);
    template.selectedRoutes = JSON.stringify(state.selectedRoutes || []);
    template.stationData = JSON.stringify(STATION_DATA);
    template.selectedStations = JSON.stringify(state.selectedStations || {});
    template.tokyoCities = JSON.stringify(TOKYO_CITIES);
    template.selectedCities = JSON.stringify(state.selectedCities || []);
    template.selectedTowns = JSON.stringify(state.selectedTowns || {});
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
    template.initFocus = ''; // プリレンダはfocus無し版 (focusありは個別レンダ)

    var html = template.evaluate().getContent();
    var rawSize = html.length;

    // CacheService 値サイズ上限: 100KB (102400 bytes).
    // 通常 評価後HTML は ~100KB前後 → gzip+base64 圧縮して保存
    var compressed = Utilities.gzip(Utilities.newBlob(html, 'text/html'));
    var b64 = Utilities.base64Encode(compressed.getBytes());
    if (b64.length > 95000) {
      console.warn('[prerender] gzip後でも大きすぎてキャッシュ不可 raw=' + rawSize + 'bytes b64=' + b64.length + 'bytes');
      return false;
    }
    CacheService.getScriptCache().put('criteria_html_' + userId, b64, 600); // 10分
    console.log('[prerender] cache保存 userId=' + userId + ' raw=' + rawSize + 'bytes b64=' + b64.length + 'bytes (' + (Date.now() - _t0) + 'ms)');
    return true;
  } catch (e) {
    console.warn('[prerender] error: ' + (e && e.message));
    return false;
  }
}

/**
 * CacheServiceに保存した gzip+base64 HTML を取り出して展開する。
 *
 * @param {string} userId
 * @return {string|null} 展開後HTML、無ければnull
 */
function _getCachedCriteriaHtml_(userId) {
  try {
    var b64 = CacheService.getScriptCache().get('criteria_html_' + userId);
    if (!b64) return null;
    var bytes = Utilities.base64Decode(b64);
    var blob = Utilities.newBlob(bytes, 'application/x-gzip');
    return Utilities.ungzip(blob).getDataAsString();
  } catch (e) {
    console.warn('[cache取得] gzip展開失敗: ' + (e && e.message));
    return null;
  }
}

// ══════════════════════════════════════════════════════════
//  Web App keepalive (条件登録フォームのコールドスタート対策)
// ══════════════════════════════════════════════════════════

/**
 * Web App をウォームに保つために doGet?action=keepalive を定期的に self-fetch する。
 * GAS の時間ベーストリガーから 5 分間隔で実行する想定。
 *
 * 初回セットアップ:
 *   GAS エディタから setupKeepAliveTrigger() を1回手動実行する。
 */
function pingWebAppKeepAlive_() {
  try {
    var url = ScriptApp.getService().getUrl();
    if (!url) return;
    var resp = UrlFetchApp.fetch(url + '?action=keepalive', {
      muteHttpExceptions: true,
      followRedirects: true
    });
    var code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      // 成功時はログ控えめ（毎5分実行のため）
      console.log('[keepalive] ok ' + code);
    } else {
      console.warn('[keepalive] HTTP ' + code);
    }
  } catch (e) {
    console.warn('[keepalive] error: ' + (e && e.message));
  }
}

/**
 * pingWebAppKeepAlive_ を5分ごとに実行するトリガーを登録する。
 * GAS エディタから1回手動実行する。
 */
function setupKeepAliveTrigger() {
  // 既存の同名トリガーを削除
  var existing = ScriptApp.getProjectTriggers();
  var deleted = 0;
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'pingWebAppKeepAlive_') {
      ScriptApp.deleteTrigger(existing[i]);
      deleted++;
    }
  }
  // 5分ごとにトリガー登録
  ScriptApp.newTrigger('pingWebAppKeepAlive_')
    .timeBased()
    .everyMinutes(5)
    .create();
  return '✅ 既存トリガー' + deleted + '個を削除し、5分ごとのkeepaliveトリガーを新規登録しました。';
}

// ══════════════════════════════════════════════════════════════
// SUUMO フォローアップメール関連
// ══════════════════════════════════════════════════════════════

var UNSUBSCRIBE_SECRET = PropertiesService.getScriptProperties().getProperty('UNSUBSCRIBE_SECRET') || 'ehomaki_unsub_2026';
var LINE_EMAIL_SHEET_NAME = 'LINE登録メール';
var UNSUBSCRIBE_SHEET_NAME = '配信停止';

function _generateUnsubscribeToken(emailAddr) {
  var raw = emailAddr + UNSUBSCRIBE_SECRET;
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw);
  var hex = digest.map(function(b) {
    var v = (b < 0) ? b + 256 : b;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
  return hex.substring(0, 32);
}

function handleUnsubscribe(e) {
  var emailAddr = e.parameter.email || '';
  var token = e.parameter.token || '';

  if (!emailAddr || !token) {
    return HtmlService.createHtmlOutput(
      _buildSimpleHtml('パラメータエラー', 'メールアドレスまたはトークンが不正です。', '#e74c3c')
    ).setTitle('配信停止');
  }

  var expected = _generateUnsubscribeToken(emailAddr);
  if (token !== expected) {
    return HtmlService.createHtmlOutput(
      _buildSimpleHtml('リンク無効', 'この配信停止リンクは無効です。', '#e74c3c')
    ).setTitle('配信停止');
  }

  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(UNSUBSCRIBE_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(UNSUBSCRIBE_SHEET_NAME);
      sheet.appendRow(['メールアドレス', '停止日時']);
    }

    var existing = sheet.getDataRange().getValues();
    for (var i = 1; i < existing.length; i++) {
      if (existing[i][0] === emailAddr) {
        return HtmlService.createHtmlOutput(
          _buildSimpleHtml('配信停止済み', 'このメールアドレスはすでに配信停止されています。', '#3498db')
        ).setTitle('配信停止');
      }
    }

    sheet.appendRow([emailAddr, new Date().toISOString()]);

    return HtmlService.createHtmlOutput(
      _buildSimpleHtml('配信停止完了', emailAddr + ' への配信を停止しました。', '#27ae60')
    ).setTitle('配信停止');
  } catch (err) {
    console.error('handleUnsubscribe error: ' + err.message);
    return HtmlService.createHtmlOutput(
      _buildSimpleHtml('エラー', '処理中にエラーが発生しました。', '#e74c3c')
    ).setTitle('配信停止');
  }
}

function handleCheckFollowupStatus(e) {
  var emailAddr = e.parameter.email || '';
  if (!emailAddr) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'email required' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var lineRegistered = false;
    var unsubscribed = false;

    var lineSheet = ss.getSheetByName(LINE_EMAIL_SHEET_NAME);
    if (lineSheet) {
      var lineData = lineSheet.getDataRange().getValues();
      for (var i = 1; i < lineData.length; i++) {
        if (lineData[i][0] === emailAddr) {
          lineRegistered = true;
          break;
        }
      }
    }

    var unsubSheet = ss.getSheetByName(UNSUBSCRIBE_SHEET_NAME);
    if (unsubSheet) {
      var unsubData = unsubSheet.getDataRange().getValues();
      for (var j = 1; j < unsubData.length; j++) {
        if (unsubData[j][0] === emailAddr) {
          unsubscribed = true;
          break;
        }
      }
    }

    return ContentService.createTextOutput(JSON.stringify({
      lineRegistered: lineRegistered,
      unsubscribed: unsubscribed
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    console.error('handleCheckFollowupStatus error: ' + err.message);
    return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function handleLogEmailSend(e) {
  var p = e.parameter;
  if (!p.email) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'email required' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheetName = 'メール送信履歴';
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.appendRow(['送信日時', 'メールアドレス', '名前', '物件名', '種別', '経過日数', '送信回数']);
      sheet.setFrozenRows(1);
    }
    sheet.appendRow([
      new Date(),
      p.email || '',
      p.name || '',
      p.property_name || '',
      p.type || '',
      p.days || '',
      p.send_count || ''
    ]);
    return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    console.error('handleLogEmailSend error: ' + err.message);
    return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function saveLineRegisteredEmail(userId, emailAddr) {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(LINE_EMAIL_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LINE_EMAIL_SHEET_NAME);
    sheet.appendRow(['メールアドレス', 'userId', '表示名', '登録日時']);
  }

  var existing = sheet.getDataRange().getValues();
  for (var i = 1; i < existing.length; i++) {
    if (existing[i][0] === emailAddr) {
      return false;
    }
  }

  var displayName = '';
  try {
    var profile = getLineProfile(userId);
    displayName = (profile && profile.displayName) ? profile.displayName : '';
  } catch (e) {}

  sheet.appendRow([emailAddr, userId, displayName, new Date().toISOString()]);
  return true;
}

function handleRegisterSuumoCriteria(e) {
  var name = e.parameter.name || '';
  var station = e.parameter.station || '';
  var rent = e.parameter.rent || '';
  var layout = e.parameter.layout || '';
  var area = e.parameter.area || '';
  var walk = e.parameter.walk || '';

  if (!name) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'name required' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);

    // 同名の既存行があるか確認
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1]) === name) {
        return ContentService.createTextOutput(JSON.stringify({
          success: true, message: 'already exists', row: i + 1
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    // SUUMOフォーマット「ＪＲ中央線/阿佐ケ谷」を路線名と駅名に分割
    var routeName = '';
    var stationFlat = '';
    var slashIdx = station.indexOf('/');
    if (slashIdx >= 0) {
      routeName = station.substring(0, slashIdx).trim();
      stationFlat = station.substring(slashIdx + 1).trim();
    } else {
      stationFlat = station.replace(/.*線\s*/, '').trim();
      routeName = station.replace(/[\/].*/, '').trim();
    }
    // STATION_DATA から路線名を検証・修正
    if (typeof STATION_DATA !== 'undefined' && routeName) {
      var matchedRoute = _findMatchingRoute(routeName, stationFlat);
      if (matchedRoute) routeName = matchedRoute;
    }
    // 路線(駅名) 形式で構築
    var routeStation = routeName ? routeName + '(' + stationFlat + ')' : stationFlat;

    // 賃料を万円単位の数値に変換
    var rentMax = '';
    if (rent) {
      var rentNum = parseFloat(String(rent).replace(/[万円,\s]/g, ''));
      if (!isNaN(rentNum)) {
        // 上限は問い合わせ賃料の+2万円（幅を持たせる）
        rentMax = String(rentNum + 2);
      }
    }

    // 面積を数値に（下限は-5m²で幅を持たせる）
    var areaMin = '';
    if (area) {
      var areaNum = parseFloat(String(area).replace(/[m²㎡\s]/g, ''));
      if (!isNaN(areaNum)) {
        areaMin = String(Math.max(0, Math.floor(areaNum - 5)));
      }
    }

    // 徒歩分数
    var walkMin = '';
    if (walk) {
      var walkNum = parseInt(String(walk).replace(/[分\s]/g, ''));
      if (!isNaN(walkNum)) {
        walkMin = String(Math.min(walkNum + 5, 20));
      }
    }

    var now = new Date();
    var timestamp = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');

    var row = [
      timestamp,          // A: タイムスタンプ
      name,               // B: お客様名
      '東京都',           // C: 都道府県
      '',                 // D: 市区町村
      routeStation,       // E: 路線(駅名)
      stationFlat,        // F: 駅名（フラット）
      walkMin,            // G: 駅徒歩
      rentMax,            // H: 賃料上限
      layout,             // I: 間取り
      areaMin,            // J: 専有面積下限
      '',                 // K: 築年数
      '',                 // L: 構造
      '',                 // M: 設備
      'SUUMO問い合わせ',  // N: 部屋探しの理由
      '',                 // O: 引越し時期
      '',                 // P: その他ご希望
      '',                 // Q: ペット種類
      '',                 // R: 居住者
    ];

    sheet.appendRow(row);

    return ContentService.createTextOutput(JSON.stringify({
      success: true, message: 'registered', name: name
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    console.error('handleRegisterSuumoCriteria error: ' + err.message);
    return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function handleGetSimilarProperties(e) {
  var customerName = e.parameter.customer || '';

  if (!customerName) {
    return ContentService.createTextOutput(JSON.stringify({ properties: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var results = [];
    var seenRoomIds = {};

    // 承認待ち物件シートからこの顧客の物件を検索
    var pendingSheet = ss.getSheetByName(PENDING_SHEET_NAME);
    if (pendingSheet) {
      var pendData = pendingSheet.getDataRange().getValues();
      for (var j = 1; j < pendData.length; j++) {
        if (String(pendData[j][0]) !== customerName) continue;
        var pRoomId = String(pendData[j][2] || '');
        if (seenRoomIds[pRoomId]) continue;
        seenRoomIds[pRoomId] = true;

        var pExtra = {};
        try { pExtra = JSON.parse(pendData[j][9] || '{}'); } catch(_) {}

        results.push({
          buildingName: String(pendData[j][3] || ''),
          rent: Number(pendData[j][4]) || 0,
          managementFee: Number(pendData[j][5]) || 0,
          layout: String(pendData[j][6] || ''),
          area: Number(pendData[j][7]) || 0,
          stationInfo: String(pendData[j][8] || ''),
          address: pExtra.address || '',
          roomId: pRoomId,
          customerName: customerName
        });
      }
    }

    // 通知済み物件シートからも検索（承認待ちから消えている場合がある）
    var seenSheet = ss.getSheetByName(SEEN_SHEET_NAME);
    if (seenSheet) {
      var seenData = seenSheet.getDataRange().getValues();
      for (var i = 1; i < seenData.length; i++) {
        if (String(seenData[i][0]) !== customerName) continue;
        var roomId = String(seenData[i][1] || '');
        if (seenRoomIds[roomId]) continue;
        // closed は除外
        var currentStatus = String(seenData[i][5] || '').toLowerCase();
        if (currentStatus === 'closed') continue;
        seenRoomIds[roomId] = true;

        // 通知済みシートには詳細がないので承認待ちから補完
        var detail = _findPendingDetail(pendingSheet, roomId);
        if (detail) {
          results.push(detail);
        }
      }
    }

    // 最大3件に絞る
    results = results.slice(0, 3);

    return ContentService.createTextOutput(JSON.stringify({ properties: results }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    console.error('handleGetSimilarProperties error: ' + err.message);
    return ContentService.createTextOutput(JSON.stringify({ properties: [], error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function _findMatchingRoute(routeName, stationName) {
  if (typeof STATION_DATA === 'undefined') return null;
  // まず路線名の完全一致を試す
  if (STATION_DATA[routeName]) {
    if (!stationName || STATION_DATA[routeName].indexOf(stationName) >= 0) {
      return routeName;
    }
  }
  // 部分一致で路線を探す
  var keys = Object.keys(STATION_DATA);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf(routeName) >= 0 || routeName.indexOf(keys[i]) >= 0) {
      if (!stationName || STATION_DATA[keys[i]].indexOf(stationName) >= 0) {
        return keys[i];
      }
    }
  }
  // 駅名だけで路線を逆引き
  if (stationName) {
    for (var j = 0; j < keys.length; j++) {
      if (STATION_DATA[keys[j]].indexOf(stationName) >= 0) {
        return keys[j];
      }
    }
  }
  return null;
}

function _findPendingDetail(pendingSheet, roomId, customerName) {
  if (!pendingSheet) return null;
  var data = pendingSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][2] || '') === roomId) {
      var extra = {};
      try { extra = JSON.parse(data[i][9] || '{}'); } catch(_) {}
      return {
        buildingName: String(data[i][3] || ''),
        rent: Number(data[i][4]) || 0,
        managementFee: Number(data[i][5]) || 0,
        layout: String(data[i][6] || ''),
        area: Number(data[i][7]) || 0,
        stationInfo: String(data[i][8] || ''),
        address: extra.address || '',
        roomId: roomId,
        customerName: customerName || String(data[i][0] || '')
      };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════
//  顧客管理ページ
// ══════════════════════════════════════════════════════════
var CONTACT_LOG_SHEET_NAME = '対応ログ';

function getCustomerPageUrl() {
  var baseUrl = ScriptApp.getService().getUrl();
  var apiKey = PropertiesService.getScriptProperties().getProperty('REINS_API_KEY') || '';
  return baseUrl + '?action=customer&api_key=' + encodeURIComponent(apiKey);
}

function getAdminPageUrl() {
  var baseUrl = ScriptApp.getService().getUrl();
  var apiKey = PropertiesService.getScriptProperties().getProperty('REINS_API_KEY') || '';
  return baseUrl + '?action=admin&api_key=' + encodeURIComponent(apiKey);
}

function handleCustomerPage(e) {
  if (!_validateReinsApiKey(e.parameter.api_key)) {
    return HtmlService.createHtmlOutput(
      '<html><body style="text-align:center;padding:40px;font-family:sans-serif;">' +
      '<h3>認証エラー</h3><p>api_key が正しくありません。</p></body></html>'
    ).setTitle('認証エラー');
  }

  var customerList = _getCustomerListForCRM_();
  var initCustomer = e.parameter.customer || '';

  var template = HtmlService.createTemplateFromFile('CustomerPage');
  template.customersJson = JSON.stringify(customerList);
  template.initCustomer = JSON.stringify(initCustomer);

  return template.evaluate()
    .setTitle('顧客管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * CRM用の顧客一覧を取得する。全顧客を含む（blocked含む）。
 */
function _getCustomerListForCRM_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
  if (!sheet) return [];

  var data = sheet.getDataRange().getValues();
  var customers = [];
  var nameMap = {};

  for (var i = 1; i < data.length; i++) {
    var name = String(data[i][1] || '').trim();
    if (!name) continue;
    var status = String(data[i][18] || '').trim().toLowerCase() || 'active';
    var regDate = data[i][0];
    var regStr = '';
    if (regDate instanceof Date) {
      regStr = Utilities.formatDate(regDate, 'Asia/Tokyo', 'yyyy/MM/dd');
    }

    if (!nameMap[name]) {
      nameMap[name] = { name: name, status: status, registeredAt: regStr, lastAction: '' };
      customers.push(nameMap[name]);
    }
  }

  // 最終アクション日を アクションログ から取得
  try {
    var actionSheet = ss.getSheetByName('アクションログ');
    if (actionSheet) {
      var aData = actionSheet.getDataRange().getValues();
      for (var i = aData.length - 1; i >= 1; i--) {
        var aName = String(aData[i][0] || '').trim();
        if (aName && nameMap[aName] && !nameMap[aName].lastAction) {
          var aDate = aData[i][8]; // I列 = 日時
          if (aDate instanceof Date) {
            nameMap[aName].lastAction = Utilities.formatDate(aDate, 'Asia/Tokyo', 'yyyy/MM/dd');
          } else if (aDate) {
            nameMap[aName].lastAction = String(aDate).substring(0, 10);
          }
        }
      }
    }
  } catch(e) { console.warn('lastAction取得エラー: ' + e.message); }

  return customers;
}

/**
 * 顧客詳細データを取得する（google.script.run から呼ばれる）。
 */
function getCustomerDetail(customerName) {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
  if (!sheet) return { error: '検索条件シートが見つかりません' };

  var data = sheet.getDataRange().getValues();
  var info = null;

  // 最新行を採用（同名複数行の場合）
  for (var i = 1; i < data.length; i++) {
    var name = String(data[i][1] || '').trim();
    if (name !== customerName) continue;

    var status = String(data[i][18] || '').trim().toLowerCase() || 'active';
    var regDate = data[i][0];
    var regStr = '';
    if (regDate instanceof Date) {
      regStr = Utilities.formatDate(regDate, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
    }

    var btMode = String(data[i][30] || '').trim().toLowerCase();
    if (btMode !== 'skip') btMode = 'alert';

    info = {
      name: name,
      status: status,
      registeredAt: regStr,
      reason: String(data[i][13] || ''),        // N列
      moveInDate: String(data[i][14] || ''),     // O列
      rentMax: '',
      layouts: '',
      area: '',
      areaMin: '',
      buildingAge: '',
      walk: '',
      structures: '',
      equipment: '',
      notes: '',
      btMode: btMode
    };

    // 賃料上限 (F列 index 5)
    if (data[i][5]) info.rentMax = String(data[i][5]);
    // 間取り (G列 index 6)
    if (data[i][6]) info.layouts = String(data[i][6]);
    // エリア: 路線+駅 or 市区町村
    var routeStation = String(data[i][4] || ''); // E列
    var city = String(data[i][3] || '');         // D列
    info.area = routeStation || city || '';
    // 広さ (H列 index 7)
    if (data[i][7]) info.areaMin = String(data[i][7]);
    // 築年数 (I列 index 8)
    if (data[i][8]) info.buildingAge = String(data[i][8]);
    // 駅徒歩 (J列 index 9)
    if (data[i][9]) info.walk = String(data[i][9]);
    // 構造 (K列 index 10)
    if (data[i][10]) info.structures = String(data[i][10]);
    // 設備 (L列 index 11)
    if (data[i][11]) info.equipment = String(data[i][11]);
    // 備考 (M列 index 12)
    if (data[i][12]) info.notes = String(data[i][12]);
  }

  if (!info) return { error: '顧客が見つかりません: ' + customerName };

  // 送付済み物件
  info.properties = _getCustomerProperties_(ss, customerName);

  // 対応ログ
  info.contactLogs = _getContactLogs_(ss, customerName);

  // タイムライン
  info.timeline = _buildCustomerTimeline_(ss, customerName, data);

  return info;
}

/**
 * 送付済み物件の一覧を取得する（アクション状況付き）。
 */
function _getCustomerProperties_(ss, customerName) {
  var tz = 'Asia/Tokyo';
  var properties = [];
  var propMap = {}; // roomId → property object

  // 1. 通知済み物件から取得
  try {
    var seenSheet = ss.getSheetByName('通知済み物件');
    if (seenSheet) {
      var seenData = seenSheet.getDataRange().getValues();
      for (var i = 1; i < seenData.length; i++) {
        if (String(seenData[i][0] || '').trim() !== customerName) continue;
        var roomId = String(seenData[i][1] || '');
        var sentDate = seenData[i][3];
        var sentStr = '';
        if (sentDate instanceof Date) {
          sentStr = Utilities.formatDate(sentDate, tz, 'yyyy/MM/dd HH:mm');
        }
        var prop = {
          roomId: roomId,
          buildingName: String(seenData[i][2] || ''),
          sentAt: sentStr,
          source: String(seenData[i][4] || ''),
          availStatus: String(seenData[i][5] || ''),  // F列: 空室ステータス
          viewed: false,
          viewedAt: '',
          actions: [], // お気に入り、内見希望など
          comment: ''
        };
        propMap[roomId] = prop;
        properties.push(prop);
      }
    }
  } catch(e) { console.warn('通知済み物件取得エラー: ' + e.message); }

  // 2. 閲覧ログから閲覧状況を反映
  try {
    var viewSheet = ss.getSheetByName('閲覧ログ');
    if (viewSheet) {
      var viewData = viewSheet.getDataRange().getValues();
      for (var i = 1; i < viewData.length; i++) {
        if (String(viewData[i][0] || '').trim() !== customerName) continue;
        var vRoomId = String(viewData[i][1] || '');
        if (propMap[vRoomId]) {
          propMap[vRoomId].viewed = true;
          var vDate = viewData[i][2];
          if (vDate instanceof Date) {
            propMap[vRoomId].viewedAt = Utilities.formatDate(vDate, tz, 'yyyy/MM/dd HH:mm');
          }
        }
      }
    }
  } catch(e) { console.warn('閲覧ログ取得エラー: ' + e.message); }

  // 3. アクションログからアクションを反映
  try {
    var actionSheet = ss.getSheetByName('アクションログ');
    if (actionSheet) {
      var aData = actionSheet.getDataRange().getValues();
      for (var i = 1; i < aData.length; i++) {
        if (String(aData[i][0] || '').trim() !== customerName) continue;
        var aRoomId = String(aData[i][1] || '');
        var actionType = String(aData[i][2] || '');
        if (actionType === 'view') continue; // 閲覧は別で処理済み
        if (propMap[aRoomId]) {
          var aDate = aData[i][8];
          var aDateStr = '';
          if (aDate instanceof Date) {
            aDateStr = Utilities.formatDate(aDate, tz, 'yyyy/MM/dd HH:mm');
          }
          propMap[aRoomId].actions.push({
            type: actionType,
            date: aDateStr
          });
        }
      }
    }
  } catch(e) { console.warn('アクションログ取得エラー: ' + e.message); }

  // 4. 物件コメントを取得
  try {
    var commentSheet = ss.getSheetByName('物件コメント');
    if (commentSheet) {
      var cData = commentSheet.getDataRange().getValues();
      for (var i = 1; i < cData.length; i++) {
        if (String(cData[i][0] || '').trim() !== customerName) continue;
        var cRoomId = String(cData[i][1] || '');
        if (propMap[cRoomId]) {
          propMap[cRoomId].comment = String(cData[i][2] || '');
        }
      }
    }
  } catch(e) { /* シートがなければ空 */ }

  // 新しい順にソート
  properties.sort(function(a,b) { return (b.sentAt || '').localeCompare(a.sentAt || ''); });

  return properties;
}

/**
 * 物件コメントを保存する（google.script.run から呼ばれる）。
 */
function savePropertyComment(customerName, roomId, comment) {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName('物件コメント');
    if (!sheet) {
      sheet = ss.insertSheet('物件コメント');
      sheet.appendRow(['顧客名', 'room_id', 'コメント', '更新日時']);
      try {
        sheet.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#e0e0e0');
      } catch(e) {}
    }

    // 既存行を検索
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0] || '').trim() === customerName &&
          String(data[i][1] || '').trim() === roomId) {
        // 既存行を更新
        sheet.getRange(i + 1, 3).setValue(comment);
        sheet.getRange(i + 1, 4).setValue(new Date());
        return { success: true };
      }
    }
    // 新規行を追加
    sheet.appendRow([customerName, roomId, comment, new Date()]);
    return { success: true };
  } catch(e) {
    return { success: false, message: e.message };
  }
}

/**
 * 顧客のバストイレ別モードを更新する（google.script.run から呼ばれる）。
 * @param {string} customerName
 * @param {string} mode - 'alert' or 'skip'
 */
function updateBtMode(customerName, mode) {
  try {
    if (mode !== 'alert' && mode !== 'skip') mode = 'alert';
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return { success: false, message: 'シートが見つかりません' };
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1] || '').trim() === customerName) {
        sheet.getRange(i + 1, 31).setValue(mode); // AE列(31)
        return { success: true };
      }
    }
    return { success: false, message: '顧客が見つかりません' };
  } catch(e) {
    return { success: false, message: e.message };
  }
}

/**
 * 対応ログを取得する。
 */
function _getContactLogs_(ss, customerName) {
  var sheet = ss.getSheetByName(CONTACT_LOG_SHEET_NAME);
  if (!sheet) return [];

  var data = sheet.getDataRange().getValues();
  var logs = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0] || '').trim() !== customerName) continue;
    var d = data[i][1];
    var dateStr = '';
    if (d instanceof Date) {
      dateStr = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
    } else if (d) {
      dateStr = String(d);
    }
    logs.push({
      date: dateStr,
      type: String(data[i][2] || ''),
      memo: String(data[i][3] || ''),
      author: String(data[i][4] || '')
    });
  }
  // 新しい順
  logs.sort(function(a,b) { return (b.date || '').localeCompare(a.date || ''); });
  return logs;
}

/**
 * 対応ログを追加する（google.script.run から呼ばれる）。
 */
function addContactLog(customerName, type, dateStr, memo) {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CONTACT_LOG_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(CONTACT_LOG_SHEET_NAME);
      sheet.appendRow(['顧客名', '対応日時', '対応種別', 'メモ', '記録者']);
      try {
        sheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#e0e0e0');
      } catch(e) {}
    }
    var date = new Date(dateStr);
    sheet.appendRow([customerName, date, type, memo, '管理者']);
    return { success: true };
  } catch(e) {
    return { success: false, message: e.message };
  }
}

/**
 * 全アクションを時系列で統合したタイムラインを構築する。
 */
function _buildCustomerTimeline_(ss, customerName, criteriaData) {
  var timeline = [];
  var tz = 'Asia/Tokyo';

  // 1. 登録日 (検索条件シート A列)
  for (var i = 1; i < criteriaData.length; i++) {
    if (String(criteriaData[i][1] || '').trim() !== customerName) continue;
    var reg = criteriaData[i][0];
    if (reg instanceof Date) {
      timeline.push({
        date: Utilities.formatDate(reg, tz, 'yyyy/MM/dd HH:mm'),
        ts: reg.getTime(),
        type: 'registration',
        summary: '条件登録'
      });
    }
    // 条件変更提案送信 (Z列 index 25)
    var sugDate = criteriaData[i][25];
    if (sugDate instanceof Date) {
      var sugCount = Number(criteriaData[i][29]) || 0; // AD列
      timeline.push({
        date: Utilities.formatDate(sugDate, tz, 'yyyy/MM/dd HH:mm'),
        ts: sugDate.getTime(),
        type: 'condition_suggestion',
        summary: '条件変更提案を送信',
        details: sugCount > 0 ? '連続 ' + sugCount + ' 回目' : ''
      });
    }
    // ステータス変更 (T列=停止理由, U列=停止日時)
    var stopDate = criteriaData[i][20]; // U列 index 20
    var stopReason = String(criteriaData[i][19] || ''); // T列 index 19
    if (stopDate instanceof Date) {
      timeline.push({
        date: Utilities.formatDate(stopDate, tz, 'yyyy/MM/dd HH:mm'),
        ts: stopDate.getTime(),
        type: 'status_change',
        summary: '配信停止',
        details: stopReason || ''
      });
    }
    break; // 最新行のみ
  }

  // 2. 通知済み物件 (物件送信)
  try {
    var seenSheet = ss.getSheetByName('通知済み物件');
    if (seenSheet) {
      var seenData = seenSheet.getDataRange().getValues();
      for (var i = 1; i < seenData.length; i++) {
        if (String(seenData[i][0] || '').trim() !== customerName) continue;
        var sentDate = seenData[i][3]; // D列 = sentAt
        if (!(sentDate instanceof Date)) continue;
        timeline.push({
          date: Utilities.formatDate(sentDate, tz, 'yyyy/MM/dd HH:mm'),
          ts: sentDate.getTime(),
          type: 'property_sent',
          summary: String(seenData[i][2] || '物件') + ' を送信', // C列 = buildingName
          details: String(seenData[i][1] || '') // B列 = roomId
        });
      }
    }
  } catch(e) { console.warn('通知済み物件取得エラー: ' + e.message); }

  // 3. 閲覧ログ
  try {
    var viewSheet = ss.getSheetByName('閲覧ログ');
    if (viewSheet) {
      var viewData = viewSheet.getDataRange().getValues();
      for (var i = 1; i < viewData.length; i++) {
        if (String(viewData[i][0] || '').trim() !== customerName) continue;
        var vDate = viewData[i][2]; // C列 = 閲覧日時
        if (!(vDate instanceof Date)) continue;
        timeline.push({
          date: Utilities.formatDate(vDate, tz, 'yyyy/MM/dd HH:mm'),
          ts: vDate.getTime(),
          type: 'view',
          summary: String(viewData[i][1] || '物件') + ' を閲覧'
        });
      }
    }
  } catch(e) { console.warn('閲覧ログ取得エラー: ' + e.message); }

  // 4. アクションログ (お気に入り、保留、内見、興味なし等)
  try {
    var actionSheet = ss.getSheetByName('アクションログ');
    if (actionSheet) {
      var aData = actionSheet.getDataRange().getValues();
      for (var i = 1; i < aData.length; i++) {
        if (String(aData[i][0] || '').trim() !== customerName) continue;
        var aDate = aData[i][8]; // I列 = 日時
        if (!(aDate instanceof Date)) continue;
        var actionType = String(aData[i][2] || ''); // C列 = アクション
        var bldgName = String(aData[i][3] || '');   // D列 = 物件名
        var actionLabels = {
          'favorite': 'お気に入り',
          'hold': '保留',
          'not_interested': '興味なし',
          'viewing': '内見希望',
          'view': '閲覧'
        };
        var label = actionLabels[actionType] || actionType;
        // view は閲覧ログと重複するのでスキップ
        if (actionType === 'view') continue;
        timeline.push({
          date: Utilities.formatDate(aDate, tz, 'yyyy/MM/dd HH:mm'),
          ts: aDate.getTime(),
          type: 'action',
          summary: bldgName + ' → ' + label,
          details: String(aData[i][1] || '') // room_id
        });
      }
    }
  } catch(e) { console.warn('アクションログ取得エラー: ' + e.message); }

  // 5. 対応ログ
  try {
    var contactSheet = ss.getSheetByName(CONTACT_LOG_SHEET_NAME);
    if (contactSheet) {
      var cData = contactSheet.getDataRange().getValues();
      for (var i = 1; i < cData.length; i++) {
        if (String(cData[i][0] || '').trim() !== customerName) continue;
        var cDate = cData[i][1];
        if (!(cDate instanceof Date)) continue;
        timeline.push({
          date: Utilities.formatDate(cDate, tz, 'yyyy/MM/dd HH:mm'),
          ts: cDate.getTime(),
          type: 'contact',
          summary: String(cData[i][2] || '') + ': ' + String(cData[i][3] || ''),
          details: ''
        });
      }
    }
  } catch(e) { console.warn('対応ログ取得エラー: ' + e.message); }

  // 新しい順にソート
  timeline.sort(function(a,b) { return (b.ts || 0) - (a.ts || 0); });

  // ts は返さない（JSONサイズ削減）
  for (var i = 0; i < timeline.length; i++) {
    delete timeline[i].ts;
  }

  return timeline;
}

function _buildSimpleHtml(title, message, color) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;background:#f8f9fa;color:#333;padding:24px 16px;min-height:100vh;display:flex;align-items:center;justify-content:center}'
    + '.card{background:#fff;border-radius:16px;padding:40px 24px;max-width:480px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,0.08);text-align:center}'
    + 'h2{font-size:20px;margin-bottom:16px;color:' + color + '}'
    + 'p{font-size:15px;line-height:1.8;color:#555}'
    + '</style></head><body>'
    + '<div class="card">'
    + '<h2>' + title + '</h2>'
    + '<p>' + message + '</p>'
    + '</div></body></html>';
}
