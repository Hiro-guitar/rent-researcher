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

    // --- スマホから置かれた検索指示を「実行した」と報告する (Chrome拡張から) ---
    if (json.action === 'search_request_done') {
      if (!_validateReinsApiKey(json.api_key)) {
        return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'invalid api_key' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      return handleSearchRequestDone(json);
    }

    // --- 募集図面(PDF)をGeminiに読ませて初期費用を拾う (Chrome拡張から) ---
    if (json.action === 'read_drawing') {
      if (!_validateReinsApiKey(json.api_key)) {
        return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'invalid api_key' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      return handleReadDrawing(json);
    }

    // --- 初期費用概算書のテンプレートに値を流し込む (Chrome拡張パネルから) ---
    if (json.action === 'make_estimate_doc') {
      if (!_validateReinsApiKey(json.api_key)) {
        return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'invalid api_key' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      return handleMakeEstimateDoc(json);
    }

    // --- 内見依頼書・広告掲載依頼書のテンプレートに値を流し込む (Chrome拡張パネルから) ---
    if (json.action === 'make_request_doc') {
      if (!_validateReinsApiKey(json.api_key)) {
        return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'invalid api_key' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      return handleMakeRequestDoc(json);
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
    // 未送信物件をキャンセル待ちに登録（手動送信パネルから）
    if (json.action === 'add_cancellation_watch') {
      if (!_validateReinsApiKey(json.api_key)) {
        return ContentService.createTextOutput(JSON.stringify({ ok: false, message: 'invalid api_key' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      var _wRes = { ok: false, added: 0, failed: [] };
      try {
        var _wName = String(json.customer_name || '').trim();
        var _wProps = Array.isArray(json.properties) ? json.properties : [];
        for (var _wi = 0; _wi < _wProps.length; _wi++) {
          var _r = addCancellationWatchOnly(_wName, _wProps[_wi]);
          if (_r && _r.ok) _wRes.added++;
          else _wRes.failed.push((_wProps[_wi] && _wProps[_wi].buildingName || '?') + ': ' + (_r && _r.message));
        }
        _wRes.ok = (_wRes.failed.length === 0);
      } catch (eW) {
        _wRes.message = eW.message;
      }
      return ContentService.createTextOutput(JSON.stringify(_wRes))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (json.action === 'update_suumo_listing_stats') {
      return handleUpdateSuumoListingStats(json);
    }
    if (json.action === 'record_daily_pv') {
      return ContentService.createTextOutput(JSON.stringify(recordDailyPv_(json)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (json.action === 'record_daily_competition') {
      return ContentService.createTextOutput(JSON.stringify(recordDailyCompetition_(json.entries || [], json.compDate)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (json.action === 'get_listed_for_rank') {
      return handleGetListedForRank(json);
    }
    if (json.action === 'update_listing_rank') {
      return handleUpdateListingRank(json);
    }
    if (json.action === 'get_suumo_settings') {
      return handleGetSuumoSettings(json);
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
          'お部屋のお問い合わせをいただいた方は、お問い合わせ時のメールアドレスをこちらに送信してください。\n\n' +
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

      // 条件登録ボタン（遅延返信Flex／空室確認カードの「いいえ、条件を自分で決める」）
      // 登録済みなら条件変更フローへ振り替える
      if (data === '条件登録') {
        // テストユーザーだけは登録済みでも初回の質問フローを流す。
        // 実顧客がこのカードを見るのは条件未登録のときだけなので、本番では
        // 必ず startSearchFlow に入る。テスト時だけ「すでに条件が登録されています」に
        // 振り替わってしまい、本番の挙動を確認できなかったため。
        var _mcName = (typeof _getLineUserName_ === 'function') ? _getLineUserName_(userId) : '';
        if (TEST_ALLOWED_NAMES.indexOf(_mcName) !== -1) {
          console.log('[テスト] 条件登録postback: 登録済みだが初回フローを流す (' + _mcName + ')');
          startSearchFlow(replyToken, userId);
          return;
        }
        startSearchOrChangeFlow(replyToken, userId);
        return;
      }

      // 「この条件で探してもらう」（遅延返信Flexのpostback）
      //   data="action=auto_criteria&name=...&room=..."
      // 空室確認で見た終了物件のスペックから暫定条件を作って登録する。
      // 検索自体は拡張側の顧客フィルタが既定OFFなので、担当者がチェックを入れるまで走らない。
      if (typeof data === 'string' && data.indexOf('action=auto_criteria') === 0) {
        var _acParams = {};
        data.split('&').forEach(function (kv) {
          var p = kv.split('=');
          if (p.length === 2) _acParams[p[0]] = decodeURIComponent(p[1] || '');
        });
        // テストユーザーは登録済みでも通しで確認できるよう、上書きを許可する
        var _acName = (typeof _getLineUserName_ === 'function') ? _getLineUserName_(userId) : '';
        var _acIsTester = (TEST_ALLOWED_NAMES.indexOf(_acName) !== -1);
        var _acRes = (typeof registerAutoCriteriaFromProperty === 'function')
          ? registerAutoCriteriaFromProperty(userId, _acParams.name || '', _acParams.room || '', { force: _acIsTester })
          : { ok: false, message: 'function not defined' };

        if (_acRes.ok) {
          // 条件の内容は直前のカードに出ているので繰り返さない（長いと読まれない）
          var _acMsg = '承知しました。この条件でお探しします。';
          // テストで既存条件を潰した場合はその場で分かるようにする
          if (_acRes.overwrote) {
            _acMsg += '\n\n【テスト】既存の登録条件を上書きしました。';
          }
          // 登録は済ませたうえで、自動では作れない4項目（理由・居住者・年齢・入居時期）を聞く。
          // 質問を登録の前提にはしない（途中でやめても条件は残る）。
          if (typeof startAutoFollowupQuestions === 'function') {
            startAutoFollowupQuestions(replyToken, userId, _acMsg);
          } else {
            replyMessage(replyToken, [textMsgWithQuickReply(_acMsg, [qrMessage('条件を変更する', '条件変更')])]);
          }
          try { _notifyAutoCriteriaToDiscord_(userId, _acParams.name, _acParams.room, _acRes); } catch (_eD) {}
        } else if (_acRes.message === 'already_registered') {
          // 既に条件がある人は上書きしない（クリック連打・古いカードの再タップ対策）
          replyMessage(replyToken, [textMsg(
            'すでにご希望条件をお預かりしています。\n' +
            '条件を見直したい場合は「条件変更」とお送りください。'
          )]);
        } else {
          // 変換に失敗したら通常の条件登録フローへ逃がす（行き止まりにしない）
          startSearchOrChangeFlow(replyToken, userId);
        }
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
            ? setCancellationWatch(params.customer, params.room_id, true)
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
      // 登録済みのユーザーが「条件登録」を送った場合は条件変更フローへ振り替える
      // 【テスト用】登録済みでも質問フローを最初から流す。
      // 通常の「条件登録」は登録済みだと条件変更（＝条件選択ページ直行）に
      // 振り替わるため、質問と進捗ゲージを確認できないので用意している。
      // ⚠️ 最後まで進めると既存の登録条件は上書きされる。
      if (message === 'テスト条件登録') {
        var _trName = (typeof _getLineUserName_ === 'function') ? _getLineUserName_(userId) : '';
        if (TEST_ALLOWED_NAMES.indexOf(_trName) === -1) return;
        startSearchFlow(replyToken, userId);
        return;
      }

      if (message === '条件登録' || message === 'じょうけんとうろく') {
        // [PERF-doPost] 計測用
        console.log('[PERF-doPost] +' + (Date.now() - _doPostT) + 'ms startSearchOrChangeFlow直前');
        startSearchOrChangeFlow(replyToken, userId);
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

      // 【テスト用】「テストカード <物件名> <部屋番号>」で暫定条件カードを自分に出す。
      // 条件登録済みだと本来テキストしか届かず、カードの確認ができないため。
      // 許可した顧客名のときだけ動く（TEST_ALLOWED_NAMES）。
      if (message.indexOf('テストカード') === 0) {
        var _tcName = (typeof _getLineUserName_ === 'function') ? _getLineUserName_(userId) : '';
        if (TEST_ALLOWED_NAMES.indexOf(_tcName) === -1) {
          // 許可外のお客様には反応しない（通常の未認識メッセージと同じ扱い）
          return;
        }
        var _tcArgs = message.replace(/^テストカード\s*/, '').trim().split(/[\s\u3000]+/);
        var _tcProp = _tcArgs[0] || '';
        var _tcRoom = _tcArgs[1] || '';
        if (!_tcProp) {
          replyMessage(replyToken, [textMsg('使い方: テストカード <物件名> <部屋番号>\n例: テストカード ディナック吉祥寺 309')]);
          return;
        }
        var _tcDisplay = _tcProp + (_tcRoom ? ' ' + _tcRoom + '号室' : '');
        globalThis._forceVacancyFlexForTest = true;
        try {
          replyMessage(replyToken, _buildVacancyUnavailableMessages_(userId, _tcDisplay, _tcProp, _tcRoom));
        } finally {
          globalThis._forceVacancyFlexForTest = false;
        }
        return;
      }

      // コマンド: 空室確認 → state を WAITING_VACANCY にして案内文返信
      if (message === '空室確認' || message === 'くうしつかくにん') {
        saveState(userId, {
          step: STEPS.WAITING_VACANCY,
          data: { vacancyExpireAt: Date.now() + VACANCY_MODE_TTL_MS }
        });
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
        // 有効期限切れ → モードを抜けて通常のメッセージとして扱う。
        // （放置された空室確認モードが、後日の無関係なメッセージを
        //   検索クエリとして拾ってしまうのを防ぐ）
        var _vacExp = state.data && state.data.vacancyExpireAt;
        if (_vacExp && Date.now() > _vacExp) {
          console.log('[空室確認] モード期限切れのため解除: ' + userId);
          clearState(userId);
        } else {
          handleVacancyQuery(replyToken, userId, message);
          return;
        }
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

// ══════════════════════════════════════════════════════════
//  条件フォーム(criteria.html)の初期状態
//  doGet(action=criteria_state) と、LINEリンクへの埋め込みで共用する。
// ══════════════════════════════════════════════════════════

/** criteria.html が必要とする初期状態を組み立てる。 */
function _buildCriteriaStatePayload_(stateC) {
  var d = (stateC && stateC.data) || {};
  return {
    success: true,
    selectedRoutes: (stateC && stateC.selectedRoutes) || [],
    selectedStations: (stateC && stateC.selectedStations) || {},
    selectedCities: (stateC && stateC.selectedCities) || [],
    selectedTowns: (stateC && stateC.selectedTowns) || {},
    areaMethod: (stateC && stateC.areaMethod) || 'route',
    rentMax: d.rent_max || '',
    layouts: d.layouts || [],
    walkMax: d.walk || '',
    areaMin: d.area_min || '',
    buildingAge: d.building_age || '',
    buildingStructures: d.building_structures || [],
    equipment: d.equipment || [],
    petType: d.petType || '',
    carModel: d.carModel || '',
    otherConditions: d.otherConditions || '',
    moveInDate: d.move_in_date || '',
    moveInStrict: !!d.move_in_strict
  };
}

/**
 * 条件フォームのURLに埋め込む初期状態（base64url）。
 *
 * criteria.html は開いた直後に GAS へ状態を取りに行っており、その1往復が
 * 実測 3.2〜3.7秒（存在しないIDで即エラーを返させても3.2秒＝GAS Web Appの固定コスト）。
 * ページ自体は静的で0.05〜0.25秒なので、待ち時間はほぼ全部これ。
 * 物件ページ(property.html)が一瞬で出るのは、データをURLに埋め込んで
 * サーバーを呼ばないため。条件フォームも同じ方式にする。
 *
 * 空値を落としてから base64 にし、それでも長い場合は諦めて '' を返す
 * （criteria.html は s= が無ければ従来どおり fetch する）。
 */
function _criteriaStateParam_(userId) {
  try {
    var st = getState(userId);
    if (!isCriteriaPageAllowed(st.step)) return '';
    var payload = _buildCriteriaStatePayload_(st);
    // 埋め込みが古すぎる場合に criteria.html 側で捨てられるようにする
    payload.t = Date.now();
    // 空の項目は落とす。criteria.html 側は各項目を個別に判定しているので問題ない。
    Object.keys(payload).forEach(function (k) {
      var v = payload[k];
      if (v === '' || v === false || (Array.isArray(v) && v.length === 0) ||
          (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) {
        delete payload[k];
      }
    });
    payload.success = true;
    // '=' パディングは落とす（criteria.html 側で付け直す）。URLに混ぜたくないため。
    var b64 = Utilities.base64EncodeWebSafe(JSON.stringify(payload), Utilities.Charset.UTF_8).replace(/=+$/, '');
    // LINEのURI actionは1000文字上限。基底URL・userId分の余裕を見て750で打ち切る。
    if (b64.length > 750) {
      console.log('[criteria] URL埋め込み断念（長すぎ） size=' + b64.length);
      return '';
    }
    return b64;
  } catch (e) {
    console.warn('[criteria] URL埋め込み失敗: ' + (e && e.message));
    return '';
  }
}

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
      return ContentService.createTextOutput(JSON.stringify(_buildCriteriaStatePayload_(_stateC)))
        .setMimeType(ContentService.MimeType.JSON);
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
        + '<div class="summary">該当 ' + lcRows.length + ' 件 (対象顧客の物件検索時にチェック / キャンセル発生時は担当のDiscordに通知。顧客への自動LINEはしません)</div>'
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
        watchOnly: e.parameter.watch_only === '1',
        customer: e.parameter.customer || ''
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
        ? setCancellationWatch(custW, roomW, true)
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

  // スタッフが Discord で「公式LINEの空室確認(要確認物件)」の結果を返答するエンドポイント
  //   Discord ボタンのリンククリックで呼ばれ、お客さんに LINE で結果を返信する
  if (action === 'staff_reply_vacancy') {
    try {
      if (!_validateReinsApiKey(e.parameter.api_key)) {
        return HtmlService.createHtmlOutput('<h2>❌ 認証エラー</h2><p>api_keyが不正です。</p>');
      }
      var uidSV = e.parameter.user_id || '';
      var bldgSV = e.parameter.building || '';
      var roomSV = e.parameter.room || '';
      var statusSV = e.parameter.status || '';
      if (['available', 'closed'].indexOf(statusSV) < 0) {
        return HtmlService.createHtmlOutput('<h2>❌ エラー</h2><p>不正なstatus: ' + statusSV + '</p>');
      }
      if (!uidSV) {
        return HtmlService.createHtmlOutput('<h2>❌ エラー</h2><p>user_id が空です。</p>');
      }
      var resSV = _replyVacancyResultToCustomer_(uidSV, bldgSV, roomSV, statusSV);
      var statusLabelSV = (statusSV === 'available') ? '🟢 募集中' : '🔴 ご案内不可';
      var html = '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">'
        + '<title>空室確認の返信</title>'
        + '<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f7fa;padding:30px 20px;color:#1a2538}'
        + '.card{background:#fff;border-radius:12px;padding:30px;max-width:500px;margin:0 auto;box-shadow:0 4px 16px rgba(0,0,0,0.08)}'
        + 'h2{color:#3d6909;margin-bottom:16px}'
        + 'table{width:100%;margin:16px 0}td{padding:8px 0;font-size:14px}td:first-child{color:#6b7280;width:120px}'
        + '.note{margin-top:20px;padding:12px;background:#f0faf4;border-radius:8px;font-size:13px;color:#3d6909}'
        + '</style></head><body>'
        + '<div class="card">'
        + '<h2>' + (resSV.ok ? '✅ お客様にLINEで通知しました' : '⚠️ 返信失敗') + '</h2>'
        + '<table>'
        + '<tr><td>物件</td><td>' + (resSV.displayName || (bldgSV + ' ' + roomSV)) + '</td></tr>'
        + '<tr><td>返信内容</td><td>' + statusLabelSV + '</td></tr>'
        + '</table>'
        + (resSV.ok
          ? '<div class="note">✓ お客様にLINEで結果を送信しました。<br>このタブは閉じてOKです。</div>'
          : '<div class="note" style="color:#9b1c1c">' + (resSV.message || '不明なエラー') + '</div>')
        + '</div></body></html>';
      return HtmlService.createHtmlOutput(html);
    } catch (eSV) {
      return HtmlService.createHtmlOutput('<h2>❌ エラー</h2><pre>' + eSV.message + '</pre>');
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
      // 「終了」ステージの顧客を毎朝5時にアーカイブするトリガーも bootstrap
      var _hasArchive = false;
      for (var _ia = 0; _ia < _triggers.length; _ia++) {
        if (_triggers[_ia].getHandlerFunction() === 'autoArchiveFinishedCustomers') { _hasArchive = true; break; }
      }
      if (!_hasArchive && typeof autoArchiveFinishedCustomers === 'function') {
        ScriptApp.newTrigger('autoArchiveFinishedCustomers').timeBased().atHour(5).everyDays(1).create();
        console.log('[keepalive] bootstrap: 終了顧客の自動アーカイブ (毎朝5時) を登録');
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

    // --- スマホから物件検索を回す（画面／指示の受け渡し）---
    if (action === 'mobile_search') {
      if (!_validateReinsApiKey(e.parameter.api_key)) {
        // このページは自分のサイトのiframeに入るので、エラーも埋め込めないと
        // 枠が真っ白になって原因が分からなくなる
        return HtmlService.createHtmlOutput(
          '<body style="background:#181818;color:#eee;font:15px/1.7 sans-serif;padding:20px">'
          + '<h2>認証エラー</h2><p>api_keyが不正です。顧客管理のリンクから開いてください。</p></body>')
          .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
      }
      return handleMobileSearchPage(e);
    }
    if (action === 'search_request_poll') {
      if (!_validateReinsApiKey(e.parameter.api_key)) {
        return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'invalid api_key' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      return handleSearchRequestPoll(e.parameter);
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
            carModel: existing.carModel,
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
    // テンプレートへはJSON文字列で渡す（改行/引用符でJSが壊れるのを防ぐ）
    // その他要望: 条件フォームは otherConditions、シート/シードは notes に入るため両対応
    template.petTypeJson = JSON.stringify(d.petType || '');
    template.carModelJson = JSON.stringify(d.carModel || '');
    template.otherConditionsJson = JSON.stringify(d.otherConditions || d.notes || '');
    template.allowedFloorsJson = JSON.stringify(d.allowedFloors || '');
    template.roomDigitSumsJson = JSON.stringify(d.roomDigitSums || '');
    template.minFloorJson = JSON.stringify(d.minFloor || '');
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

  // ── 掲載物件ダッシュボード ──
  if (action === 'listing_dashboard') {
    return handleListingDashboard(e);
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

  // ── お客様向け地図ページ: 送った物件を緯度経度つきで返す ──
  if (action === 'customer_map') {
    return handleCustomerMapApi(e);
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
    // おすすめ条件エディタ（rec::トークン）からの送信は、顧客フローに一切触れず
    // おすすめ検索条件シートに保存して終了する。
    if (String(userId || '').indexOf('rec::') === 0) {
      return _saveRecommendFromForm_(userId, criteria);
    }

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
    state.data.carModel = criteria.carModel || '';
    if (criteria.allowedFloors !== undefined) state.data.allowedFloors = criteria.allowedFloors || '';
    if (criteria.roomDigitSums !== undefined) state.data.roomDigitSums = criteria.roomDigitSums || '';
    if (criteria.minFloor !== undefined) state.data.minFloor = criteria.minFloor || '';
    state.data.otherConditions = criteria.otherConditions || '';
    // フォームの「その他」をnotesとして保存（確認画面で表示）
    // 空で送られたら消したということなので、そのまま空にする
    state.data.notes = criteria.otherConditions || '';

    // このフォームが必ず送ってくる項目。空＝「選択をなしにした」なので引き継がない。
    // ⚠️ ここに載せ忘れると、その項目は空にする変更が打ち消されて適用されなくなる。
    //   （1LDK → 指定なし が何度やっても戻る事故 2026-08-21）
    var _formFields = ['rent_max', 'layouts', 'walk', 'area_min', 'building_age',
      'building_structures', 'equipment', 'petType', 'carModel', 'notes'];
    if (criteria.allowedFloors !== undefined) _formFields.push('allowedFloors');
    if (criteria.roomDigitSums !== undefined) _formFields.push('roomDigitSums');
    if (criteria.minFloor !== undefined) _formFields.push('minFloor');
    // 入居時期（フォームから送信された場合）
    if (criteria.move_in_date) {
      state.data.move_in_date = criteria.move_in_date;
    }
    state.data.move_in_strict = !!criteria.move_in_strict;

    // 条件変更フローの場合は直接保存して完了
    if (state.isChangeFlow) {
      var beforeChange = null;
      try { beforeChange = readLatestCriteria(userId); } catch (_) {}
      try { _carryOverUntouchedCriteria_(state, beforeChange, { explicitFields: _formFields }); }
      catch (eC) { console.error('[条件変更] 引き継ぎ失敗(条件フォーム): ' + eC.message + '\n' + eC.stack); }
      writeToSheet(userId, state);
      // ⚠️ カードは state ではなく「保存された結果」から作ること (2026-08-16)。
      //   state は経路によって一部の項目を持たないため、そのまま描くと
      //   シートには値が残っているのに「→ 指定なし」と表示されてしまう。
      var afterSaved = null;
      try { afterSaved = readLatestCriteria(userId); }
      catch (eA) { console.warn('保存後の再読込に失敗: ' + eA.message); }
      clearState(userId);
      pushMessage(userId, buildConditionUpdateMessages_(afterSaved || state, beforeChange));
      return { success: true, message: '条件を更新しました。' };
    }

    // 直接保存して完了
    writeToSheet(userId, state);
    clearState(userId);

    pushMessage(userId, [
      buildConditionSummaryFlex(state, 'ご登録ありがとうございます'),
      textMsg(_criteriaCardFollowupText_())
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
  if (d.carModel) summary += '・駐車場(車種): ' + d.carModel + '\n';

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
    // 同名で複数行あるケース(IDを変更すると saveLineUser が旧行を残して追記するため)に対応。
    //   admin_ プレースホルダー(LINE未連携)は無視し、有効なIDのうち最後(=最新)を返す。
    var found = null;
    for (let i = 1; i < data.length; i++) {
      if (data[i][1] === customerName) {
        var uid = String(data[i][0] || '').trim();
        if (!uid || uid.indexOf('admin_') === 0) continue; // 未連携プレースホルダーは採用しない
        found = uid;
      }
    }
    return found;
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
  // 顧客1人につき LINE API へ1リクエスト投げるので、対象は必要な人だけに絞る。
  //
  // 2026-08-01: 顧客が増えて get_criteria が拡張側のタイムアウト(30秒)を越え、
  //   ブロック判定という付随機能のせいで物件検索そのものが止まる事故が起きた。
  //   ブロック検知は「配信している相手に逃げられていないか」を見るためのものなので、
  //   そもそも物件を送らない相手を判定する意味がない。以下を対象外にする:
  //     - paused / auto_paused          … 配信を止めている
  //     - snoozed                       … 一時停止中
  //     - アーカイブ済み(AS列=45)        … 看板から外した終了顧客
  //     - 営業ステージ「終了」(AG列=33)  … 追客していない
  //     - 検索条件が空のリード           … まだ物件を送っていない
  // ⚠️ どこで時間を食っているか必ず残すこと (2026-08-19)。
  //   get_criteria が拡張のタイムアウト(30秒)を越えて検索が止まる事故が
  //   何度も起きているのに、内訳が分からず原因を追えなかった。
  var _t0 = Date.now();
  var _tMark = {};
  var _lap = function (label) { _tMark[label] = Date.now() - _t0; };

  var lineUserIdMap = _getLineUserIdMapByCustomerName_();
  _lap('LINE Users読み込み');
  var data = sheet.getDataRange().getValues();
  _lap('検索条件シート読み込み');

  // ── シートへの書き込みはためて最後に列ごと1回で行う ──
  // 1セルずつ setValue すると顧客数だけシート往復が発生する。
  // 対象列: S(19)配信ステータス / U(21)停止・ブロック日時 / V(22)スヌーズ解除
  //         X(24)最終配信日時 / AG(33)営業ステージ
  var _pending = {};   // 列番号 -> { 行index(0始まり, ヘッダー除く) -> 値 }
  var _setCell = function (rowIdx0, col, value) {
    if (!_pending[col]) _pending[col] = {};
    _pending[col][rowIdx0] = value;
    if (data[rowIdx0 + 1]) data[rowIdx0 + 1][col - 1] = value;   // 後続の判定にも反映
  };
  var _flushPending = function () {
    var writes = 0;
    for (var col in _pending) {
      var changes = _pending[col];
      var idxs = Object.keys(changes).map(Number);
      if (idxs.length === 0) continue;
      var minI = Math.min.apply(null, idxs), maxI = Math.max.apply(null, idxs);
      var block = [];
      for (var r = minI; r <= maxI; r++) block.push([data[r + 1][col - 1]]);
      sheet.getRange(minI + 2, Number(col), block.length, 1).setValues(block);
      writes++;
    }
    return writes;
  };

  // 候補となる「配信している」顧客の userId を先に集める
  var allUserIds = [];
  var nameToUserId = {}; // name -> userId
  var noUserIdNames = []; // userId 未紐付けの顧客名 (デバッグ用)
  var skippedCount = 0;
  var seenUserIds = {};  // 同じ userId を二重に問い合わせない
  for (var pi = 1; pi < data.length; pi++) {
    var pname = String(data[pi][1] || '').trim();
    if (!pname) continue;
    var pstatus = String(data[pi][18] || '').trim().toLowerCase();
    if (pstatus === 'paused' || pstatus === 'auto_paused' || pstatus === 'snoozed') { skippedCount++; continue; }
    if (String(data[pi][44] || '').trim()) { skippedCount++; continue; }            // AS列(45): アーカイブ済み
    // ⚠️ 既に blocked の人は必ず判定する。
    //    ブロック検知時に営業ステージを「終了」に落とす仕様なので、
    //    「終了」を除外条件にするとブロック解除の自動復活が二度と効かなくなる。
    if (pstatus !== 'blocked') {
      if (String(data[pi][32] || '').trim() === '終了') { skippedCount++; continue; } // AG列(33): 営業ステージ
      // 条件が空のリードはまだ物件を送っていないのでブロック判定の対象外
      var pHasCrit = (typeof _rowHasCriteria_ === 'function') ? _rowHasCriteria_(data[pi]) : true;
      if (!pHasCrit) { skippedCount++; continue; }
    }
    var puid = lineUserIdMap[pname];
    if (puid) {
      if (seenUserIds[puid]) continue;
      seenUserIds[puid] = true;
      nameToUserId[pname] = puid;
      allUserIds.push(puid);
    } else {
      noUserIdNames.push(pname);
    }
  }
  console.log('[LINEブロック判定] 対象顧客数=' + allUserIds.length
    + ' / 対象外=' + skippedCount
    + ' / userId未紐付け=' + noUserIdNames.length
    + (noUserIdNames.length > 0 ? ' [' + noUserIdNames.slice(0, 5).join(',') + '...]' : ''));

  // 並列ブロック判定
  var blockedMap = (allUserIds.length > 0) ? bulkCheckLineBlocked(allUserIds) : {};
  _lap('LINEブロック判定');

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
  var deliverableNames = {}; // 配信ゲートを通過した顧客名（おすすめ条件の検索可否判定に使う）
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
          _setCell(i - 1, 19, 'active');
          _setCell(i - 1, 22, '');
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
          _setCell(i - 1, 19, 'blocked');  // S列: 配信ステータス
          // U列(21): 停止/ブロック日時を記録 (まだ未記録の場合のみ — 1週間カウントの起点)
          var existingTs = data[i][20];   // U列。読み直さずメモリ上の値を使う
          if (!existingTs) {
            _setCell(i - 1, 21, new Date());
          }
          // 新規ブロック検知時: カンバンの営業ステージ(AG列=33)を「終了」に移す
          // (一度だけ。以降 wasBlocked=true でスキップ → スタッフが手動で戻しても上書きしない)
          if (!wasBlocked) {
            _setCell(i - 1, 33, '終了');
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
            _setCell(i - 1, 19, 'active');
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
      _setCell(i - 1, 24, new Date());
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

    // この顧客は配信ゲート（停止/ブロック/スヌーズ/頻度）を通過した＝配信対象。
    // 本人の検索条件が空でも、おすすめ条件は検索したいのでここで記録しておく。
    deliverableNames[name] = true;

    // ── 検索エリア(市区町村/路線/駅/町名)が無い行はスキップ ──
    // 賃料や間取りだけ設定されていてもエリアが無いと「全件ヒット」になるため、
    // エリア未設定＝条件未入力の顧客(電話リード等)とみなし自動検索しない。
    var _hasArea = (_splitCSV(row[3]).length > 0)            // C 市区町村
      || allRoutes.length > 0                                  // E 路線
      || allStations.length > 0                                // F 駅
      || (selectedTowns && Object.keys(selectedTowns).length > 0); // Y 町名丁目
    if (!_hasArea) {
      console.log('[エリア未設定スキップ] ' + name + ' (status=' + deliveryStatus + ') 検索対象外');
      continue;
    }

    // AE列(30, index 30): バストイレ別の処理モード ('alert' or 'skip', 空=未設定→グローバル設定にフォールバック)
    var btMode = String(row[30] || '').trim().toLowerCase();
    if (btMode && btMode !== 'skip' && btMode !== 'none') btMode = 'alert';
    var senmenMode = String(row[40] || '').trim().toLowerCase();
    // 特殊フィルタ: AP列(42)=希望階数, AQ列(43)=部屋番号の数字合計
    var allowedFloors = String(row[41] || '').trim();
    var roomDigitSums = String(row[42] || '').trim();
    var minFloor = String(row[43] || '').trim();
    if (senmenMode && senmenMode !== 'skip' && senmenMode !== 'none') senmenMode = 'alert';
    // 空文字のまま返す → Chrome拡張側でグローバル設定にフォールバック

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
      move_in_early_months: String(row[35] || ''),  // AJ列(36): 入居可能の早すぎ許容(月数, 空=OFF)
      notes: String(row[15] || ''),
      selectedTowns: selectedTowns,
      lastReinsSearch: lastReinsSearchStr,
      btMode: btMode,
      senmenMode: senmenMode,
      allowedFloors: allowedFloors,
      roomDigitSums: roomDigitSums,
      minFloor: minFloor
    });
  }

  _lap('顧客ループ');

  // ためた変更をまとめて書き込む（列ごと1回）
  var _writeCount = 0;
  try { _writeCount = _flushPending(); } catch (eFlush) { console.error('[get_criteria] 書き込み失敗: ' + eFlush.message); }
  _lap('シート書き込み');

  // ── おすすめ検索条件（裏条件）を追加 ──
  // お客さんの登録条件とは別に、こちらが設定した条件でも検索する。
  // 配信対象（deliverableNames）の顧客に紐づくものだけを対象にする。
  try {
    if (typeof _appendRecommendCriteria_ === 'function') {
      _appendRecommendCriteria_(criteria, deliverableNames);
    }
  } catch (eRec) {
    console.warn('[おすすめ条件] 追加に失敗: ' + (eRec && eRec.message));
  }

  _lap('おすすめ条件');
  var _prev = 0, _parts = [];
  ['LINE Users読み込み', '検索条件シート読み込み', 'LINEブロック判定', '顧客ループ', 'シート書き込み', 'おすすめ条件'].forEach(function (k) {
    if (_tMark[k] === undefined) return;
    _parts.push(k + ' ' + (_tMark[k] - _prev) + 'ms');
    _prev = _tMark[k];
  });
  var _perf = '合計 ' + (Date.now() - _t0) + 'ms / ' + _parts.join(' / ')
    + ' / 条件' + criteria.length + '件 / 書き込み' + _writeCount + '回';
  console.log('[get_criteria] ' + _perf);

  // 内訳を応答にも載せる。Apps Scriptの実行ログを開かなくても
  // 拡張のログ画面で「どこが重いか」が分かるようにするため。
  return ContentService
    .createTextOutput(JSON.stringify({ criteria: criteria, _perf: _perf }))
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

  // おすすめ条件（裏検索）の場合は、おすすめ条件シート側のAC列に記録する（本人条件と独立）。
  var recommendId = String(json.recommend_id || '').trim();
  if (recommendId) {
    var rRes = { ok: false };
    try {
      if (typeof setRecommendLastReinsSearch === 'function') {
        rRes = setRecommendLastReinsSearch(recommendId, searchDate);
      }
    } catch (eR) { rRes = { ok: false, message: eR.message }; }
    return ContentService.createTextOutput(JSON.stringify({
      ok: !!rRes.ok, recommend_id: recommendId, date: searchDate
    })).setMimeType(ContentService.MimeType.JSON);
  }

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
      // O列(15)='watch_only' は「送っていないがキャンセル待ちで見ている」行。
      // 送信済みではないので seen_ids に入れない。入れると自動検索が飛ばしてしまい、
      // 募集中に戻ってもお客様に届かなくなる（addCancellationWatchOnly 参照）。
      if (String(sData[i][14] || '').trim() === 'watch_only') continue;
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
      var cutoffMs = nowMs - 7 * 24 * 60 * 60 * 1000; // 7日間保持（拡張が同期を逃した場合に備えて）
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
        // building_name / rent / management_fee は再送付(_getPendingPropForFlex_)が
        // property_data_json から読むため必須。欠落するとREINS等の再送で
        // 物件名が空・賃料/管理費が0円になる。
        building_name: p.building_name || '',
        room_number: p.room_number || '',
        rent: p.rent || 0,
        management_fee: p.management_fee || 0,
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
        station_info: p.station_info || '',
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
              // 送付日時は再クロール時刻(now)ではなく、元の送付日時を保持する。
              // existingData は2498行で書き込み前に取得済み。M列(updated_at, idx12)=元の送信時刻、無ければL列(created_at, idx11)。
              // これがないと、巡回が既送信物件を再クロールするたびに送付日時が「今」に化け、
              // お客さんには何も送られていないのに顧客管理ページの送付日時だけ更新されてしまう。
              var origSentAt = existingData[rowNum - 1][12] || existingData[rowNum - 1][11] || now;
              seenSh.appendRow([customerName, roomId, p.building_name || '', origSentAt, source, '', '', sourceRef]);
              console.log('[SEEN補完] ' + customerName + ' / ' + roomId + ' をSEEN_SHEETに追加 (sent_at=' + origSentAt + ')');
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
    // （lead は除外しない。getExistingCustomers_ は管理ページ・再送付ページの顧客一覧にも
    //   使われるため、ここで lead を除くと管理ページに出ず条件変更ができなくなる。
    //   リードを自動検索から外したい場合は、検索側で「条件未登録ならスキップ」で扱う。）
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
      // admin_ プレースホルダー(LINE未連携)は無視し、本物のIDのみ採用する。
      // （同名で admin_ 行と U… 行が混在する場合に admin_ で上書きしないよう findLineUserId と挙動を揃える）
      if (!luId || luId.indexOf('admin_') === 0) continue;
      for (var j = 0; j < customers.length; j++) {
        if (customers[j].name === luName) {
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
    if (btMode && btMode !== 'skip' && btMode !== 'none') btMode = 'alert';
    var senmenMode = String(latestRow[40] || '').trim().toLowerCase();
    var allowedFloors = String(latestRow[41] || '').trim();  // AP列(42)
    var roomDigitSums = String(latestRow[42] || '').trim();  // AQ列(43)
    var minFloor = String(latestRow[43] || '').trim();       // AR列(44)
    if (senmenMode && senmenMode !== 'skip' && senmenMode !== 'none') senmenMode = 'alert';

    // 閲覧統計を集計
    var viewCount = 0;
    var lastViewAt = '';
    try {
      var propSs = SpreadsheetApp.openById(SPREADSHEET_ID);
      // アクションログから view を集計
      var actionSheet = propSs.getSheetByName('アクションログ');
      if (actionSheet) {
        var aData = actionSheet.getDataRange().getValues();
        for (var ai = 1; ai < aData.length; ai++) {
          if (String(aData[ai][0] || '').trim() !== customerName) continue;
          if (String(aData[ai][2] || '') === 'view') {
            viewCount++;
            var aTs = aData[ai][8];
            var aStr = '';
            if (aTs instanceof Date) {
              aStr = Utilities.formatDate(aTs, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
            } else if (aTs) {
              aStr = String(aTs).substring(0, 16); // 'yyyy/MM/dd HH:mm'
            }
            if (aStr && aStr > lastViewAt) lastViewAt = aStr;
          }
        }
      }
      // 閲覧ログからも加算
      var viewLogSheet = propSs.getSheetByName('閲覧ログ');
      if (viewLogSheet) {
        var vData = viewLogSheet.getDataRange().getValues();
        for (var vi = 1; vi < vData.length; vi++) {
          if (String(vData[vi][0] || '').trim() !== customerName) continue;
          viewCount++;
          var vTs = vData[vi][3]; // D列 = 閲覧日時
          var vStr = '';
          if (vTs instanceof Date) {
            vStr = Utilities.formatDate(vTs, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
          } else if (vTs) {
            vStr = String(vTs).substring(0, 16);
          }
          if (vStr && vStr > lastViewAt) lastViewAt = vStr;
        }
      }
    } catch(ve) { console.warn('閲覧統計取得エラー: ' + ve.message); }

    return {
      name: customerName,
      phone: String(latestRow[34] || ''),  // AI列(35): 手動登録の電話番号
      reason: reason,
      resident: resident,
      move_in_date: moveInDate,
      move_in_strict: moveInStrict,
      move_in_early_months: String(latestRow[35] || ''),  // AJ列(36): 入居可能の早すぎ許容
      rent_max: rentMax,
      layouts: layouts,
      walk: walk || '指定しない',
      area_min: areaMin || '指定しない',
      building_age: buildingAge || '指定しない',
      building_structures: buildingStructures,
      equipment: equipment,
      petType: petType,
      carModel: String(latestRow[39] || ''),  // AN列(40): 車種
      notes: notes,
      areaMethod: cities.length > 0 ? 'city' : 'route',
      selectedRoutes: routes,
      selectedCities: cities,
      selectedStations: selectedStations,
      selectedTowns: selectedTownsObj,
      btMode: btMode,
      senmenMode: senmenMode,
      allowedFloors: allowedFloors,
      roomDigitSums: roomDigitSums,
      minFloor: minFloor,
      viewCount: viewCount,
      lastViewAt: lastViewAt
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
function processAdminCriteria(customerName, lineUserId, criteria, phone) {
  try {
    if (!customerName) {
      return { success: false, message: '顧客名を入力してください。' };
    }

    // 駅/市区町村は必須にしない（条件を聞けていない顧客を先に登録できるようにする）。
    // エリア未設定の顧客は get_criteria 側でエリア無しとして自動検索から除外される。

    // writeToSheet に渡すための state オブジェクトを構築
    var state = {
      data: {
        name: customerName,
        rent_max: criteria.rentMax || '',
        layouts: criteria.layouts || [],
        walk: criteria.walkMax || '',
        area_min: criteria.areaMin || '',
        building_age: criteria.buildingAge || '',
        building_structures: criteria.buildingStructures || [],
        equipment: criteria.equipment || [],
        petType: criteria.petType || '',
        carModel: criteria.carModel || '',
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

    // 管理画面のフォームに無い項目を、変更前の値で引き継ぐ。
    // ⚠️ 以前は理由・入居時期・居住者の3つだけを個別に戻していたため、
    //   フォームに無い他の項目（探し理由・車種など）が消えていた。
    //   LINEの条件変更と同じ表(_CARRY_OVER_FIELDS)を使い、項目を増やしても漏れないようにする。
    //   エリアは管理画面で明示的に編集できるので引き継がない（空＝消したとみなす）。
    var existing = loadCustomerCriteriaByName(customerName);
    if (existing) {
      // 管理画面もフォームに項目がある分は必ず送ってくるので、空は「消した」として扱う。
      // ⚠️ ここに載せ忘れると、その項目は空にする変更が打ち消されて適用されなくなる。
      var _adminFields = ['rent_max', 'layouts', 'walk', 'area_min', 'building_age',
        'building_structures', 'equipment', 'petType', 'carModel', 'notes', 'move_in_date'];
      try { _carryOverUntouchedCriteria_(state, existing, { skipArea: true, explicitFields: _adminFields }); }
      catch (eC2) { console.error('[条件変更] 引き継ぎ失敗(管理画面): ' + eC2.message + '\n' + eC2.stack); }
      // 入居時期を変更していないなら厳守フラグも変更前のまま。
      // boolean は「未入力」と区別できず汎用処理では拾えないので個別に扱う。
      if (!criteria.moveInDate) state.data.move_in_strict = !!existing.move_in_strict;
    }

    // userId: 画面から渡されたIDを優先。空でも、この顧客名で本物のIDが既に
    // 登録済みなら admin_ で上書きせず再利用する。どちらも無ければダミー。
    var userId = lineUserId || findLineUserId(customerName) || 'admin_' + Date.now();

    // 「条件変更として送信」(任意)時に差分を表示するため、保存前の条件をキャッシュ
    try {
      if (existing) {
        CacheService.getScriptCache().put('condBefore_' + customerName, JSON.stringify(existing), 3600);
      }
    } catch (eCacheBefore) {}

    // 誰が変えたかを記録する。指定しないと _criteriaChangeSource_ の既定
    // 「お客様による条件変更」に倒れ、担当者が管理画面で直した分まで
    // お客様が変更したものとしてDiscordに通知されていた（2026-08-10）。
    state.changeSource = '担当者による条件変更';

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
    // 独立洗面台モード（AO列=41）
    if (criteria.senmenMode) {
      try {
        var ssS = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
        var sheetS = ssS.getSheetByName(CRITERIA_SHEET_NAME);
        if (sheetS) {
          var dataS = sheetS.getDataRange().getValues();
          for (var si = dataS.length - 1; si >= 1; si--) {
            if (String(dataS[si][1] || '').trim() === customerName) {
              sheetS.getRange(si + 1, 41).setValue(criteria.senmenMode);
              break;
            }
          }
        }
      } catch (snErr) {
        console.warn('senmenMode保存エラー: ' + snErr.message);
      }
    }
    // 特殊フィルタ: 希望階数(AP列=42) / 部屋番号の数字合計(AQ列=43)
    // 空文字も明示的に書き込む（条件を外した時にクリアされるように）
    if (criteria.allowedFloors !== undefined || criteria.roomDigitSums !== undefined || criteria.minFloor !== undefined) {
      try {
        var ssF = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
        var sheetF = ssF.getSheetByName(CRITERIA_SHEET_NAME);
        if (sheetF) {
          var dataF = sheetF.getDataRange().getValues();
          for (var fi = dataF.length - 1; fi >= 1; fi--) {
            if (String(dataF[fi][1] || '').trim() === customerName) {
              sheetF.getRange(fi + 1, 42).setValue(String(criteria.allowedFloors || ''));
              sheetF.getRange(fi + 1, 43).setValue(String(criteria.roomDigitSums || ''));
              sheetF.getRange(fi + 1, 44).setValue(String(criteria.minFloor || ''));
              break;
            }
          }
        }
      } catch (fErr) {
        console.warn('特殊フィルタ保存エラー: ' + fErr.message);
      }
    }

    // LINE User IDが指定されていれば LINE Users シートにも保存
    if (lineUserId) {
      saveLineUser(lineUserId, customerName);
    }

    // 電話番号を AI列(35) に保存（手動登録。CRM表示・架電可否判定に使う）
    if (typeof phone !== 'undefined' && phone !== null) {
      try {
        var ssP = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
        var sheetP = ssP.getSheetByName(CRITERIA_SHEET_NAME);
        if (sheetP) {
          var dataP = sheetP.getDataRange().getValues();
          for (var pi = dataP.length - 1; pi >= 1; pi--) {
            if (String(dataP[pi][1] || '').trim() === customerName) {
              sheetP.getRange(pi + 1, 35).setValue(String(phone).trim());
              break;
            }
          }
        }
      } catch (pErr) {
        console.warn('電話番号保存エラー: ' + pErr.message);
      }
    }

    // 入居可能の早すぎ許容(月数) を AJ列(36) に保存（''=OFF / '0' / '1' / '2'）
    if (typeof criteria.earlyMonths !== 'undefined') {
      try {
        var ssE = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
        var sheetE = ssE.getSheetByName(CRITERIA_SHEET_NAME);
        if (sheetE) {
          var dataE = sheetE.getDataRange().getValues();
          for (var ei = dataE.length - 1; ei >= 1; ei--) {
            if (String(dataE[ei][1] || '').trim() === customerName) {
              sheetE.getRange(ei + 1, 36).setValue(String(criteria.earlyMonths || ''));
              break;
            }
          }
        }
      } catch (eErr) {
        console.warn('早すぎ許容保存エラー: ' + eErr.message);
      }
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
/**
 * 条件サマリーカードに添えるテキスト。
 * 以前はカード内のフッターに入れていたが、カードの下部は読み飛ばされるため
 * メッセージ本文に出している（2026-08-06）。カード側に戻さないこと。
 */
function _criteriaCardFollowupText_() {
  return '条件に合う新着物件が見つかり次第、お知らせいたします。\n\n'
       + '条件の変更はメニューの「お部屋探しの条件を変える」からいつでもできます。';
}

function _buildRichConditionBubble_(summaryRows, isChanged, customerName) {
  // カラーテーマ
  var primary = isChanged ? '#e67e22' : '#1a7f37';
  var primaryLight = isChanged ? '#fef5ec' : '#eaf7ed';
  var primaryBorder = isChanged ? '#f5d5b0' : '#b8e0c0';

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
          wrap: true
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
        // ⚠️ ここにフッター文言を戻さないこと（2026-08-06 削除）。
        //   「この条件でお探しします」は直後のテキストメッセージと内容が重複していた。
        //   条件変更の導線もカード内の小さな灰色文字では読まれないため、
        //   _criteriaCardFollowupText_() としてメッセージ本文へ移した。
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
    // ⚠️ カードが描く項目を落とさないこと (2026-08-16)。
    //   ここに reason と resident が無かったため、変更前(キャッシュ)には値があるのに
    //   変更後が空になり、「就職 → 指定なし」「一人暮らし → 指定なし」と
    //   実際には起きていない変更がお客様に通知されていた。
    //   シートの値は正しく、カードだけが嘘をついていた。
    //   _buildConditionSummaryRows_ が読む項目（reason/resident/move_in_date/
    //   rent_max/layouts/walk/area_min/building_age/building_structures/
    //   equipment/petType/age/notes）を全部渡すこと。
    var state = {
      data: {
        reason: criteria.reason || '',
        resident: criteria.resident || '',
        age: criteria.age || '',
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
        carModel: criteria.carModel || '',
        notes: criteria.notes || ''
      },
      areaMethod: criteria.areaMethod || 'route',
      selectedRoutes: criteria.selectedRoutes || [],
      selectedCities: criteria.selectedCities || [],
      selectedStations: criteria.selectedStations || {},
      selectedTowns: criteria.selectedTowns || {}
    };

    var isChanged = (messageType === 'changed');

    // 「条件変更として送信」時は、保存前キャッシュを取得して各行に「変更前→変更後」を表示
    var beforeCriteria = null;
    if (isChanged) {
      try {
        var cachedBefore = CacheService.getScriptCache().get('condBefore_' + customerName);
        if (cachedBefore) beforeCriteria = JSON.parse(cachedBefore);
      } catch (eDiff) {
        console.error('sendConditionSummaryToLine diff error: ' + eDiff.message);
      }
    }

    var summaryRows = _buildConditionSummaryRows_(state, beforeCriteria);

    // リッチなFlexバブルを構築（変更点は各行に表示）
    var bubble = _buildRichConditionBubble_(summaryRows, isChanged, customerName);

    var flexMessage = {
      type: 'flex',
      altText: isChanged ? '検索条件を変更しました' : customerName + ' 様のお部屋探し条件',
      contents: bubble
    };

    pushMessage(lineUserId, [flexMessage, textMsg(_criteriaCardFollowupText_())]);

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
    carModel: existing.carModel,
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
    // テンプレートへはJSON文字列で渡す（改行/引用符でJSが壊れるのを防ぐ）
    // その他要望: 条件フォームは otherConditions、シート/シードは notes に入るため両対応
    template.petTypeJson = JSON.stringify(d.petType || '');
    template.carModelJson = JSON.stringify(d.carModel || '');
    template.otherConditionsJson = JSON.stringify(d.otherConditions || d.notes || '');
    template.allowedFloorsJson = JSON.stringify(d.allowedFloors || '');
    template.roomDigitSumsJson = JSON.stringify(d.roomDigitSums || '');
    template.minFloorJson = JSON.stringify(d.minFloor || '');
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

/**
 * メールが「LINE登録メール」シートに入っているか。
 * 入っていれば reply.py はフォローアップを送らない（LINEに移ったお客さん）。
 */
function _isEmailLineRegistered_(email) {
  email = String(email || '').trim();
  if (!email) return false;
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sh = ss.getSheetByName(LINE_EMAIL_SHEET_NAME);
    if (!sh) return false;
    var data = sh.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0] || '').trim().toLowerCase() === email.toLowerCase()) return true;
    }
  } catch (e) {}
  return false;
}

/** メールが配信停止(UNSUBSCRIBEシート)に入っているか。 */
function _isEmailUnsubscribed_(email) {
  email = String(email || '').trim();
  if (!email) return false;
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sh = ss.getSheetByName(UNSUBSCRIBE_SHEET_NAME);
    if (!sh) return false;
    var data = sh.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0] || '').trim().toLowerCase() === email.toLowerCase()) return true;
    }
  } catch (e) {}
  return false;
}

/**
 * CRMから顧客のメール配信(自動フォローアップ)を停止/再開する。
 * 顧客のメール(AF列32)をUNSUBSCRIBEシートに追加/削除する。reply.py が送信時に参照。
 * @param {string} customerName
 * @param {boolean} unsubscribe true=停止 / false=再開
 */
function setCustomerEmailUnsubscribe(customerName, unsubscribe) {
  try {
    customerName = String(customerName || '').trim();
    if (!customerName) return { success: false, message: '顧客名がありません' };

    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return { success: false, message: '検索条件シートが見つかりません' };
    var data = sheet.getDataRange().getValues();
    var email = '';
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1] || '').trim() === customerName) {
        var em = String(data[i][31] || '').trim(); // AF列(32)=メール（最新の非空を採用）
        if (em) email = em;
      }
    }
    if (!email) return { success: false, message: 'この顧客にはメールアドレスが登録されていません' };

    var unsub = ss.getSheetByName(UNSUBSCRIBE_SHEET_NAME);
    if (!unsub) { unsub = ss.insertSheet(UNSUBSCRIBE_SHEET_NAME); unsub.appendRow(['メールアドレス', '停止日時']); }
    var uData = unsub.getDataRange().getValues();
    var foundRow = -1;
    for (var j = 1; j < uData.length; j++) {
      if (String(uData[j][0] || '').trim().toLowerCase() === email.toLowerCase()) { foundRow = j + 1; break; }
    }
    if (unsubscribe) {
      if (foundRow < 0) unsub.appendRow([email, new Date().toISOString()]);
      return { success: true, unsubscribed: true, email: email, message: 'メール配信を停止しました（' + email + '）' };
    } else {
      if (foundRow > 0) unsub.deleteRow(foundRow);
      return { success: true, unsubscribed: false, email: email, message: 'メール配信を再開しました（' + email + '）' };
    }
  } catch (e) {
    return { success: false, message: 'エラー: ' + e.message };
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

function getAdminPageUrl(optCustomerName) {
  var baseUrl = ScriptApp.getService().getUrl();
  var apiKey = PropertiesService.getScriptProperties().getProperty('REINS_API_KEY') || '';
  var url = baseUrl + '?action=admin&api_key=' + encodeURIComponent(apiKey);
  if (optCustomerName) url += '&customer=' + encodeURIComponent(optCustomerName);
  return url;
}

function handleListingDashboard(e) {
  if (!_validateReinsApiKey(e.parameter.api_key)) {
    return HtmlService.createHtmlOutput(
      '<html><body style="text-align:center;padding:40px;font-family:sans-serif;">' +
      '<h3>認証エラー</h3><p>api_key が正しくありません。</p></body></html>'
    ).setTitle('認証エラー');
  }
  return HtmlService.createHtmlOutputFromFile('ListingDashboard')
    .setTitle('掲載物件ダッシュボード')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
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
  template.customersJson = _jsonForInlineScript_(customerList);
  template.initCustomer = _jsonForInlineScript_(initCustomer);
  // スマホ検索ページのURLは、ここで埋め込んでリンクのhrefにする。
  // google.script.run の応答を待ってから window.open すると、GASのiframeでは
  // ユーザー操作の有効期限が切れていてトップフレームの遷移がブロックされる。
  template.mobileSearchUrl = getMobileSearchWrappedUrl();

  return template.evaluate()
    .setTitle('顧客管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * google.script.run 用: CRM顧客一覧を返す（ページ再描画に使用）。
 */
function setCustomerArchived(customerName, archived) {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return { success: false, message: '検索条件シートが見つかりません' };
    var nameTrim = String(customerName || '').trim();
    if (!nameTrim) return { success: false, message: '顧客名がありません' };
    var data = sheet.getDataRange().getValues();
    var hit = 0;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1] || '').trim() !== nameTrim) continue;
      sheet.getRange(i + 1, 45).setValue(archived ? new Date() : '');  // AS列(45)
      hit++;
    }
    if (!hit) return { success: false, message: nameTrim + ' が見つかりません' };
    return { success: true, archived: !!archived };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * 「終了」ステージの顧客をまとめてアーカイブする（データは消さず看板から隠すだけ）。
 * 最終アクション（無ければ登録日）から days 日以上経過したものだけを対象にする。
 * @param {number} days 経過日数のしきい値（既定30日。0なら経過日数を問わない）
 */
function bulkArchiveFinishedCustomers(days) {
  try {
    var th = (days === 0 || days) ? Number(days) : 30;
    if (isNaN(th) || th < 0) th = 30;
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return { success: false, message: '検索条件シートが見つかりません' };
    var data = sheet.getDataRange().getValues();

    // 最終アクション日を アクションログ から集計（顧客名 → 最新日時ms）
    var lastActionMs = {};
    try {
      var aSheet = ss.getSheetByName('アクションログ');
      if (aSheet && aSheet.getLastRow() > 1) {
        var aData = aSheet.getDataRange().getValues();
        for (var a = 1; a < aData.length; a++) {
          var an = String(aData[a][0] || '').trim();
          if (!an) continue;
          var raw = aData[a][8];
          var d = (raw instanceof Date) ? raw : (raw ? new Date(String(raw).replace(/-/g, '/')) : null);
          if (!d || isNaN(d.getTime())) continue;
          if (!lastActionMs[an] || d.getTime() > lastActionMs[an]) lastActionMs[an] = d.getTime();
        }
      }
    } catch (eA) {}

    var nowMs = Date.now();
    var cutoff = th * 24 * 60 * 60 * 1000;
    var archivedNames = [];
    for (var i = 1; i < data.length; i++) {
      var name = String(data[i][1] || '').trim();
      if (!name) continue;
      if (String(data[i][32] || '').trim() !== '終了') continue;  // AG列(33): 営業ステージ
      if (String(data[i][44] || '').trim()) continue;            // 既にアーカイブ済み
      // 経過日数の判定（最終アクション → 無ければ登録日）
      var baseMs = lastActionMs[name] || 0;
      if (!baseMs) {
        var reg = data[i][0];
        if (reg instanceof Date) baseMs = reg.getTime();
      }
      if (th > 0 && baseMs && (nowMs - baseMs) < cutoff) continue;
      sheet.getRange(i + 1, 45).setValue(new Date());
      archivedNames.push(name);
    }
    return {
      success: true,
      count: archivedNames.length,
      names: archivedNames,
      message: archivedNames.length > 0
        ? archivedNames.length + '名をアーカイブしました'
        : 'アーカイブ対象はありませんでした'
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * 【日次トリガー】「終了」ステージの顧客を毎朝まとめてアーカイブする。
 * 経過日数は問わない(0)。看板に「終了」が溜まって邪魔になるため。
 * データは消さず、看板から隠すだけ。
 *
 * ⚠️ ブロック中の人も対象にしている（本人の指定）。アーカイブすると
 *    get_criteria のブロック再判定から外れるので(AS列のチェック)、
 *    ブロックを解除されても自動では復活しなくなる。戻すときは手で
 *    アーカイブを解除すること。
 */
function autoArchiveFinishedCustomers() {
  var r = bulkArchiveFinishedCustomers(0);
  console.log('[終了アーカイブ] ' + ((r && r.message) || '結果なし')
    + (r && r.names && r.names.length ? ' → ' + r.names.join(', ') : ''));
  return r;
}

function getCustomerListForCRM() {
  return _getCustomerListForCRM_();
}

/**
 * シートのセルから日時を取り出す。
 * ⚠️ Date型とは限らない。閲覧ログの閲覧日時や通知済み物件の送信日時は
 *   Utilities.formatDate で 'yyyy/MM/dd HH:mm:ss' の文字列として書かれている
 *   （PropertyApproval.js:990 など）。instanceof Date だけで判定すると全行落ちて
 *   「全員が未閲覧」になる（2026-08-10）。
 * @return {number} エポックミリ秒。取れなければ 0
 */
function _cellToEpochMs_(v) {
  if (v instanceof Date) return v.getTime();
  var t = String(v == null ? '' : v).trim();
  if (!t) return 0;
  // 'yyyy/MM/dd HH:mm:ss' / 'yyyy-MM-dd HH:mm:ss' / ISO を受ける
  var d = new Date(t.replace(/\//g, '-').replace(' ', 'T'));
  if (isNaN(d.getTime())) d = new Date(t);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * カンバンの列指定(AG列)をまとめて消して、状態からの自動判定に戻す。
 *
 * ドラッグすると setKanbanOrder がその列に見えているカード全員のAG列を書き換えるため、
 * 列を作り替えた直後などに意図せず全員へ同じ列が焼き付くことがある。
 * そうなると _fillDefaultStages_ の既定が一切効かなくなるので、戻せる口を用意する。
 *
 * 申込・成約・終了は商談の事実なので消さない。
 *
 * @return {{ok:boolean, cleared:number, kept:number}}
 */
function resetKanbanStages() {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!sheet) return { ok: false, message: '検索条件シートが見つかりません' };
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { ok: true, cleared: 0, kept: 0 };
    var KEEP = ['申込', '成約', '終了'];
    var rng = sheet.getRange(2, 33, lastRow - 1, 1);   // AG列
    var vals = rng.getValues();
    var cleared = 0, kept = 0;
    for (var i = 0; i < vals.length; i++) {
      var v = String(vals[i][0] || '').trim();
      if (!v) continue;
      if (KEEP.indexOf(v) >= 0) { kept++; continue; }
      vals[i][0] = '';
      cleared++;
    }
    if (cleared > 0) rng.setValues(vals);
    console.log('[カンバン] 列指定を解除: ' + cleared + '件 / 申込以降を維持: ' + kept + '件');
    return { ok: true, cleared: cleared, kept: kept };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/**
 * 営業ステージ(AG列)。カンバンの列そのもの。
 *
 * '内見' は列から外した（内見してダメなら追客に戻り、良ければ申込に進むだけで、
 * 留まる場所ではなかった）。
 * 一時期 'pin:<列キー>@日付' という自動判定の上書き指定を書いていたが、
 * 列を人が動かす方式に戻したので未設定と同じ扱いにする。
 *
 * 空欄のときの既定は _fillDefaultStages_ で決める（電話番号の有無を見るため、
 * 問い合わせシートからの電話番号補完が終わってから入れる必要がある）。
 */
// ⚠️ '追客中（優先）' は担当者が手で入れる列。_fillDefaultStages_ で自動割り当てしないこと。
//   優先すべきかはデータから判定できず、人の判断だけで決まる。
//   一度入れたら状態が変わっても勝手に動かさない。
// '検索のみ' は一度作ったが使わないことにしたので列から外した(2026-08-22)。
//   AG列に残っている行は未設定と同じ扱いになり、状態から自動で振り分けられる。
var KANBAN_STAGE_LIST = ['メールのみ', '未接続', '追客中', '追客中（優先）', '申込', '成約', '終了'];
function _normalizeStageCell_(raw) {
  var v = String(raw == null ? '' : raw).trim();
  if (v === '問い合わせ') return '未接続';   // 旧名。列の意味は引き継ぐ
  return (KANBAN_STAGE_LIST.indexOf(v) >= 0) ? v : '';
}

/**
 * ステージ未設定の顧客に既定の列を入れる。
 *
 *   メールのみ … 条件が無く、LINEも電話も無い。自動メールが流れるだけの層
 *   未接続     … 電話番号があるのにまだ話せておらず、LINEにも来ていない。架電リストそのもの
 *   追客中     … それ以外（話せたことがある / LINEで繋がっている / メールでしか届かない）
 *
 * ⚠️ 条件・電話番号・LINE紐付け・話せた記録が揃ってから呼ぶこと。
 */
function _fillDefaultStages_(customers) {
  for (var i = 0; i < customers.length; i++) {
    var c = customers[i];
    // シートに列が書かれている人は尊重する。どちらで決まったかは画面に出す。
    // （ドラッグすると setKanbanOrder がその列の全員のAG列を書き換えるので、
    //   意図せず全員に同じ列が焼き付いていないか気づけるようにするため）
    c.stageFromSheet = !!c.stage;
    if (c.stage) continue;
    if (_isMailOnlyCustomer_(c)) { c.stage = 'メールのみ'; continue; }
    // 電話で話せたことが無く、LINEにも来ていない＝こちらから接触できていない。
    // ⚠️ 電話番号がある人に限ること。未接続はそのまま架電リストとして使うので、
    //   かけられない人が混ざると使い物にならない（ユーザー指摘 2026-08-16）。
    //   条件はあるがメールしか届かない人は追客中に置く。
    var everTalked = (c.daysSinceTalk !== null && c.daysSinceTalk !== undefined);
    c.stage = (c.hasPhone && !everTalked && !c.hasLine) ? '未接続' : '追客中';
  }
}

/**
 * 「メールのみ」列に入る人か。
 *
 * 条件が入っていない かつ 連絡手段がメールしかない人。
 * 自動メールが流れるだけで、こちらから追客のしようがない層。
 *
 * ⚠️ 条件が入っていれば入れないこと。条件がある＝探しているので追客の対象。
 * ⚠️ LINEで登録してくれている人も入れないこと。メールしか無いように見えても
 *   LINEで連絡が取れるため（ユーザー指摘 2026-08-16）。
 * ⚠️ 電話番号があれば電話で追えるので入れない。
 */
function _isMailOnlyCustomer_(c) {
  return !c.hasCriteria && !c.hasLine && !c.hasPhone;
}

/**
 * HTMLに直接埋め込む JSON を作る。
 *
 * CustomerPage は  var customers = JSON.parse('<?!= customersJson ?>');  のように
 * シングルクォートの文字列リテラルへ流し込む。JSON.stringify は " は escape するが
 * ' は escape しないため、値に ' が1つでも入るとリテラルが閉じてしまい、
 * ページのスクリプト全体が構文エラーで動かなくなる（読み込み中のまま固まる）。
 *
 * 顧客名・メール・対応ログのメモなど自由入力が入るので必ずこれを通すこと。
 * <?!= ?> は escape なしで出力されるため </script> の遮断も併せて行う。
 *
 * @param {*} obj JSON化する値
 * @return {string} シングルクォート文字列リテラルに安全に入れられる JSON 文字列
 */
function _jsonForInlineScript_(obj) {
  return JSON.stringify(obj)
    .replace(/\\/g, '\\\\')     // まず自身のバックスラッシュを二重化
    .replace(/'/g, "\\'")         // リテラルを閉じさせない
    .replace(/</g, '\\u003c')     // </script> を作らせない
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * 対応ログ1行が「話せた」のか「かけたがつながらなかった」のかを判定する。
 *
 * 種別に結果が入っていればそれに従う（電話（話せた）/ 電話（つながらず））。
 * 旧形式の '電話' は結果を持たないのでメモから推定する。
 * LINE と 内見 は、失敗を記録する種類のものではないので常に会話とみなす。
 *
 * @param {string} type 対応種別（C列）
 * @param {string} memo メモ（D列）
 * @return {string} 'talked' | 'failed' | 'unknown'
 */
var _CONTACT_FAILED_WORDS = ['つながらず', 'つながらない', '繋がらない', '不在', '留守電', '応答なし',
  '出ない', 'でない', '不通', '圏外', '未接続', '出られず', 'コールのみ'];
function _contactLogOutcome_(type, memo) {
  var t = String(type || '').trim();
  var m = String(memo || '');
  if (!t) return 'unknown';
  if (t === 'LINE' || t === '内見') return 'talked';
  if (t.indexOf('電話') < 0) return 'unknown';   // その他 等は会話として数えない
  // 種別に結果が書いてあるならそれが最優先
  if (t.indexOf('話せた') >= 0) return 'talked';
  for (var i = 0; i < _CONTACT_FAILED_WORDS.length; i++) {
    if (t.indexOf(_CONTACT_FAILED_WORDS[i]) >= 0) return 'failed';
  }
  // 旧形式の '電話'。メモに不在・留守電などが書かれていれば つながらなかった扱い。
  for (var j = 0; j < _CONTACT_FAILED_WORDS.length; j++) {
    if (m.indexOf(_CONTACT_FAILED_WORDS[j]) >= 0) return 'failed';
  }
  return 'talked';
}

/**
 * 引越し時期の文字列を「期限の日」に直す。
 *
 * 検索条件シートO列に入る値は年を持たない（ConversationFlow の選択肢がそう作る）:
 *   'いい物件見つかり次第' … 期限は無いが今すぐ動ける人。急ぎ扱いにする
 *   '9月上旬' / '9月中旬' / '9月下旬' … その月の 5日 / 15日 / 25日 とみなす
 *   '9月1日' … その月日
 *   '2026/09/01' … Sheets が Date に変換したものを整形した形
 * 年が無いものは「今日以降で最初に来るその月日」と解釈する。
 * ただし1ヶ月以内の過去は「過ぎたばかりの期限」として来年送りにしない
 * （8/16に『8月上旬』なら来年8月ではなく、期限切れとして扱いたい）。
 *
 * @param {string} raw O列の値
 * @return {{ms:number, asap:boolean, approx:boolean}|null} 解釈できなければ null
 */
function _parseMoveInDeadline_(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (s.indexOf('見つかり次第') >= 0 || s.indexOf('すぐ') >= 0) {
    return { ms: 0, asap: true, approx: false };
  }
  if (s.indexOf('未定') >= 0) return null;

  var now = new Date();
  var y = now.getFullYear();

  // 'yyyy/MM/dd' または 'yyyy-MM-dd'（年が入っている形）
  var mFull = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (mFull) {
    return { ms: new Date(Number(mFull[1]), Number(mFull[2]) - 1, Number(mFull[3])).getTime(), asap: false, approx: false };
  }

  var month = 0, day = 0, approx = false;
  var mPeriod = s.match(/(\d{1,2})\s*月\s*(上旬|中旬|下旬)/);
  var mDay = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  var mMonthOnly = s.match(/(\d{1,2})\s*月/);
  if (mPeriod) {
    month = Number(mPeriod[1]);
    day = (mPeriod[2] === '上旬') ? 5 : (mPeriod[2] === '中旬' ? 15 : 25);
    approx = true;
  } else if (mDay) {
    month = Number(mDay[1]); day = Number(mDay[2]);
  } else if (mMonthOnly) {
    month = Number(mMonthOnly[1]); day = 15; approx = true;   // 月だけなら月半ばとみなす
  } else {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  var d = new Date(y, month - 1, day);
  // 1ヶ月以上前になるなら来年のその月日とみなす（年をまたぐ指定への対応）
  if (d.getTime() < now.getTime() - 31 * 24 * 60 * 60 * 1000) d = new Date(y + 1, month - 1, day);
  return { ms: d.getTime(), asap: false, approx: approx };
}

/**
 * エポックミリ秒を JST の暦日番号に変換する（1970-01-01 JST = 0）。
 *
 * ⚠️ 「何日前か」は必ずこれの差で数えること (2026-08-16)。
 *   以前は Math.floor((now - t) / 86400000) と経過時間で割っていたため、
 *   同じ 8/15 でも 8/15 19:00 送信 → 15時間経過 → 「本日」、
 *   8/15 08:00 送信 → 26時間経過 → 「1日前」と、
 *   カンバン上で同じ日付が別の日数として並んでいた。
 */
function _jstDayIndex_(ms) {
  var n = Number(ms);
  if (!n) return 0;
  return Math.floor((n + 9 * 60 * 60 * 1000) / 86400000);
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
    // AG列(33列目, index32): 営業ステージ。未設定なら status から推定。
    // （AE列=31=btMode は既存利用のため、stage は AG=33 を使う）
    // AG列(33): 営業ステージ。_parseStageCell_ の説明を参照。
    // ⚠️ 空欄を '問い合わせ'/'追客中' で補完しないこと (2026-08-16)。
    //   カンバンの左5列は顧客の状態から自動で決まるようになったので、
    //   ここで埋めると全員が手動扱いになり自動判定に載らなくなる。
    var stage = _normalizeStageCell_(data[i][32]);
    // AH列(34列目, index33): カンバン並び順（数値・小さいほど上）。未設定は大きい値扱い。
    var orderRaw = data[i][33];
    var order = (orderRaw === '' || orderRaw === null || orderRaw === undefined) ? 999999 : Number(orderRaw);
    if (isNaN(order)) order = 999999;
    var regDate = data[i][0];
    var regStr = '';
    if (regDate instanceof Date) {
      regStr = Utilities.formatDate(regDate, 'Asia/Tokyo', 'yyyy/MM/dd');
    }

    if (!nameMap[name]) {
      nameMap[name] = {
        name: name, status: status, stage: stage, order: order,
        registeredAt: regStr, lastAction: '',
        email: String(data[i][31] || '').trim(),  // AF列(32): メール
        // AS列(45): アーカイブ日時（入っていれば看板から隠す）
        archived: !!String(data[i][44] || '').trim(),
        archivedAt: (function(v){
          if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy/MM/dd');
          return String(v || '').trim().substring(0, 10);
        })(data[i][44]),
        phone: String(data[i][34] || '').trim(),  // AI列(35): 手動登録の電話番号
        hasPhone: !!String(data[i][34] || '').trim(),
        // AU列(47): 最後にこの顧客を確認した日(yyyy-MM-dd)。
        // 「1日1回、追客中の顧客について必ず考える」運用のための印。
        // 日付で持つので翌日になれば自動で未確認に戻る。
        checkedDate: (function (v) {
          if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
          return String(v == null ? '' : v).trim().substring(0, 10).replace(/\//g, '-');
        })(data[i][46]),
        hasCriteria: false,   // 検索条件が入っているか（同名行のどれかに入っていれば true）
        moveIn: '',           // O列(15): 引越し時期
        moveInStrict: false   // AA列(27): 入居時期厳守
      };
      customers.push(nameMap[name]);
    }

    var _rec = nameMap[name];

    // ⚠️ 行そのものから決まる項目は「最後の行」の値で上書きすること (2026-08-22)。
    //   保存側（setCustomerStage / setKanbanOrder / setCustomerCheckedToday /
    //   writeToSheet / readLatestCriteria）はすべて同名行の最後の行を対象にしている。
    //   ここだけ最初の行を読んでいたため、行が2つ以上ある顧客では
    //   「完了にしても戻る」「動かした列が戻る」が必ず起きていた。
    _rec.status = status;
    _rec.stage = stage;
    _rec.order = order;
    _rec.registeredAt = regStr;
    _rec.email = String(data[i][31] || '').trim();
    _rec.archived = !!String(data[i][44] || '').trim();
    _rec.archivedAt = (function (v) {
      if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy/MM/dd');
      return String(v || '').trim().substring(0, 10);
    })(data[i][44]);
    _rec.phone = String(data[i][34] || '').trim();
    _rec.hasPhone = !!_rec.phone;
    _rec.checkedDate = (function (v) {
      if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
      return String(v == null ? '' : v).trim().substring(0, 10).replace(/\//g, '-');
    })(data[i][46]);

    // 条件の有無と引越し時期は「同名の行のうち入っている方」を採る。
    // 同じ人が複数行あるとき、先頭行が空でも別の行に条件が入っていることがあるため。
    if (!_rec.hasCriteria) {
      try {
        if (typeof _rowHasCriteria_ === 'function' && _rowHasCriteria_(data[i])) _rec.hasCriteria = true;
      } catch (eHC) {}
    }
    if (!_rec.moveIn) {
      var _mv = data[i][14];   // O列(15): 引越し時期
      _rec.moveIn = (_mv instanceof Date)
        ? Utilities.formatDate(_mv, 'Asia/Tokyo', 'yyyy/MM/dd')
        : String(_mv == null ? '' : _mv).trim();
      if (_rec.moveIn) _rec.moveInStrict = String(data[i][26] || '').trim().toLowerCase() === 'true';
    }
  }

  // 電話番号を 問い合わせシート(TEL) から付与（メール一致 or 名前一致）。架電可否を看板で示す用。
  try {
    var inqSheet = ss.getSheetByName(INQUIRY_SHEET_NAME);
    if (inqSheet && inqSheet.getLastRow() > 1) {
      var inq = inqSheet.getRange(2, 1, inqSheet.getLastRow() - 1, INQUIRY_HEADERS.length).getValues();
      var telByEmail = {}, telByName = {};
      for (var q = 0; q < inq.length; q++) {
        var qTel = String(inq[q][5] || '').trim();   // F列: TEL
        if (!qTel) continue;
        var qEmail = String(inq[q][4] || '').trim().toLowerCase(); // E列: メール
        var qName = String(inq[q][2] || '').trim();   // C列: 名前
        if (qEmail && !telByEmail[qEmail]) telByEmail[qEmail] = qTel;
        if (qName && !telByName[qName]) telByName[qName] = qTel;
      }
      for (var ci = 0; ci < customers.length; ci++) {
        var cc = customers[ci];
        if (cc.hasPhone) continue; // 手動登録済みは優先
        var em = String(cc.email || '').toLowerCase();
        var tel = (em && telByEmail[em]) || telByName[cc.name] || '';
        if (tel) { cc.phone = tel; cc.hasPhone = true; }
      }
    }
  } catch (ePhone) { console.warn('電話番号付与エラー: ' + ePhone.message); }

  // 最終送信日を 通知済み物件 から取得（条件を緩めるべき人を見つけるため）
  // 「配信中なのに長く物件を送れていない」＝条件が厳しすぎる可能性が高い、という判断に使う。
  // A列=顧客名 / D列=送信日時 の2列だけ読む（全列だと重いため）。
  try {
    var seenSheet2 = ss.getSheetByName('通知済み物件');
    if (seenSheet2 && seenSheet2.getLastRow() > 1) {
      var seenRows = seenSheet2.getRange(2, 1, seenSheet2.getLastRow() - 1, 4).getValues();
      var lastSentMs = {};
      for (var si = 0; si < seenRows.length; si++) {
        var sName = String(seenRows[si][0] || '').trim();
        if (!sName || !nameMap[sName]) continue;
        var ms = _cellToEpochMs_(seenRows[si][3]);
        if (!ms) continue;
        if (!lastSentMs[sName] || ms > lastSentMs[sName]) lastSentMs[sName] = ms;
      }
      var nowMs = Date.now();
      for (var ni = 0; ni < customers.length; ni++) {
        var cn = customers[ni];
        var lm = lastSentMs[cn.name];
        if (lm) {
          cn.lastSentAt = Utilities.formatDate(new Date(lm), 'Asia/Tokyo', 'yyyy/MM/dd');
          cn.daysSinceSent = _jstDayIndex_(nowMs) - _jstDayIndex_(lm);
        } else {
          cn.lastSentAt = '';
          cn.daysSinceSent = null;   // 一度も送れていない
        }
      }
    }
  } catch (eSent) { console.warn('最終送信日取得エラー: ' + eSent.message); }

  // 最終閲覧日を アクションログ の view 行から取得する。
  // 「送っているのに見ていない」人を見つける手がかりになる。
  // ⚠️ 閲覧ログシートは見ないこと。存在しない古い機能で、そこだけ見ると
  //   全員が未閲覧になる（2026-08-10）。書き手の handleTrackView は
  //   track_view ルートに残っているが property.html から呼ばれておらず、
  //   実際の閲覧は action_type=view → handlePropertyAction → アクションログ に入る。
  try {
    var lastViewMs = {};
    var _takeView = function (name, cell) {
      if (!name || !nameMap[name]) return;
      var ms = _cellToEpochMs_(cell);
      if (!ms) return;
      if (!lastViewMs[name] || ms > lastViewMs[name]) lastViewMs[name] = ms;
    };

    // アクションログ: 顧客名(A) / アクション(C) / 日時(I)
    // ⚠️ このシートは行数が多いので読むのは1回だけにすること (2026-08-16)。
    //   以前は最終閲覧用にA〜I列、最終アクション用に getDataRange() で全列と
    //   2回読んでいて、顧客管理ページが開くまでとても待たされていた。
    //   最終アクションもここで同時に拾う（必要なのは同じ A列 と I列）。
    var actSheet2 = ss.getSheetByName('アクションログ');
    if (actSheet2 && actSheet2.getLastRow() > 1) {
      var actRows = actSheet2.getRange(2, 1, actSheet2.getLastRow() - 1, 9).getValues();
      var lastActionMs = {};
      for (var ai2 = 0; ai2 < actRows.length; ai2++) {
        var _an = String(actRows[ai2][0] || '').trim();
        if (!_an || !nameMap[_an]) continue;
        if (String(actRows[ai2][2] || '').trim().toLowerCase() === 'view') {
          _takeView(_an, actRows[ai2][8]);
        }
        var _ams = _cellToEpochMs_(actRows[ai2][8]);
        if (_ams && (!lastActionMs[_an] || _ams > lastActionMs[_an])) lastActionMs[_an] = _ams;
      }
      for (var _ak in lastActionMs) {
        nameMap[_ak].lastAction = Utilities.formatDate(new Date(lastActionMs[_ak]), 'Asia/Tokyo', 'yyyy/MM/dd');
      }
    }

    {
      var nowMs2 = Date.now();
      for (var vn = 0; vn < customers.length; vn++) {
        var vc = customers[vn];
        var vm = lastViewMs[vc.name];
        if (vm) {
          vc.lastViewedAt = Utilities.formatDate(new Date(vm), 'Asia/Tokyo', 'yyyy/MM/dd');
          vc.daysSinceViewed = _jstDayIndex_(nowMs2) - _jstDayIndex_(vm);
        } else {
          vc.lastViewedAt = '';
          vc.daysSinceViewed = null;   // 一度も閲覧していない
        }
      }
    }
  } catch (eView) { console.warn('最終閲覧日取得エラー: ' + eView.message); }

  // ── 「話せているか」の材料を集める ──
  // 顧客の仕分け（メールのみ／連絡がつかない／話したが見ていない／見ているだけ／
  // 話せていて見ている）に使う。閲覧(アクションログ)とは別の軸。
  //
  // ⚠️ LINE Activity は message と postback の両方で更新される（コード.js の doPost）。
  //   つまり物件ページのボタンを押しただけでも日付が入るので、
  //   これ単体では「話せている」の根拠にならない。確実なのは手動記録の対応ログの方。
  //   両方持って画面側で区別できるようにしておく。
  try {
    // 対応ログ: 顧客名(A) / 対応日時(B) / 対応種別(C) / メモ(D)
    //
    // ⚠️ 「電話」の記録には、出なかった時・留守電の時も残っている（ユーザー確認済み）。
    //   そのまま会話として数えると、留守電を入れただけの人が「話せている」になり、
    //   本当は「連絡がつかない」列に居るべき人が追客対象から外れてしまう。
    //   種別に結果を持たせた（電話（話せた）/ 電話（つながらず））が、
    //   それ以前の '電話' はメモから推定するしかない。
    //   話せた最終日と、つながらなかった架電の最終日を別々に持つ。
    var clSheet = ss.getSheetByName(CONTACT_LOG_SHEET_NAME);
    if (clSheet && clSheet.getLastRow() > 1) {
      var clRows = clSheet.getRange(2, 1, clSheet.getLastRow() - 1, 4).getValues();
      for (var cli = 0; cli < clRows.length; cli++) {
        var clName = String(clRows[cli][0] || '').trim();
        if (!clName || !nameMap[clName]) continue;
        var clType = String(clRows[cli][2] || '').trim();
        var clMemo = String(clRows[cli][3] || '');
        var clMs = _cellToEpochMs_(clRows[cli][1]);
        if (!clMs) continue;
        var _r = nameMap[clName];
        var _res = _contactLogOutcome_(clType, clMemo);
        if (_res === 'talked') {
          if (!_r._talkMs || clMs > _r._talkMs) { _r._talkMs = clMs; _r.lastTalkType = clType; _r.lastTalkMemo = clMemo.substring(0, 40); }
        } else if (_res === 'failed') {
          if (!_r._callTryMs || clMs > _r._callTryMs) { _r._callTryMs = clMs; }
        }
      }
    }
  } catch (eCL) { console.warn('対応ログ取得エラー: ' + eCL.message); }

  try {
    // LINE紐付けの有無は「メールのみ」列の判定に使うので、
    // LINE Activity シートが無くても必ずセットする（LINE Users だけで分かる）。
    var uidByName = (typeof _getLineUserIdMapByCustomerName_ === 'function')
      ? _getLineUserIdMapByCustomerName_() : {};
    for (var lni = 0; lni < customers.length; lni++) {
      customers[lni].hasLine = !!uidByName[customers[lni].name];
    }
    // LINE Activity: userId(A) / lastMessageAt(B)。最終反応日はここから。
    var laSheet = ss.getSheetByName('LINE Activity');
    if (laSheet && laSheet.getLastRow() > 1) {
      var msByUid = {};
      var laRows = laSheet.getRange(2, 1, laSheet.getLastRow() - 1, 2).getValues();
      for (var lai = 0; lai < laRows.length; lai++) {
        var laUid = String(laRows[lai][0] || '').trim();
        if (!laUid) continue;
        var laMs = _cellToEpochMs_(laRows[lai][1]);
        if (laMs && (!msByUid[laUid] || laMs > msByUid[laUid])) msByUid[laUid] = laMs;
      }
      for (var lni2 = 0; lni2 < customers.length; lni2++) {
        var lc = customers[lni2];
        var lms = uidByName[lc.name] ? msByUid[uidByName[lc.name]] : 0;
        if (lms) lc._lineMs = lms;
      }
    }
  } catch (eLA) { console.warn('LINE Activity取得エラー: ' + eLA.message); }

  // 日付文字列と経過日数に直す（画面が扱いやすい形にする。日数は暦日差）
  var _todayIdx = _jstDayIndex_(Date.now());
  for (var fi = 0; fi < customers.length; fi++) {
    var fc = customers[fi];

    if (fc._talkMs) {
      fc.lastTalkAt = Utilities.formatDate(new Date(fc._talkMs), 'Asia/Tokyo', 'yyyy/MM/dd');
      fc.daysSinceTalk = _todayIdx - _jstDayIndex_(fc._talkMs);
    } else { fc.lastTalkAt = ''; fc.daysSinceTalk = null; }
    // つながらなかった架電の最終日（「連絡がつかない」列で、何度かけているかを見るため）
    if (fc._callTryMs) {
      fc.lastCallTryAt = Utilities.formatDate(new Date(fc._callTryMs), 'Asia/Tokyo', 'yyyy/MM/dd');
      fc.daysSinceCallTry = _todayIdx - _jstDayIndex_(fc._callTryMs);
    } else { fc.lastCallTryAt = ''; fc.daysSinceCallTry = null; }
    if (fc._lineMs) {
      fc.lastLineAt = Utilities.formatDate(new Date(fc._lineMs), 'Asia/Tokyo', 'yyyy/MM/dd');
      fc.daysSinceLine = _todayIdx - _jstDayIndex_(fc._lineMs);
    } else { fc.lastLineAt = ''; fc.daysSinceLine = null; }
    delete fc._talkMs; delete fc._lineMs; delete fc._callTryMs;

    // 引越し期限までの日数（マイナスなら過ぎている）。急ぎの人を上に出すのに使う。
    var _mi = _parseMoveInDeadline_(fc.moveIn);
    fc.moveInAsap = !!(_mi && _mi.asap);
    fc.moveInApprox = !!(_mi && _mi.approx);
    fc.daysToMoveIn = (_mi && !_mi.asap) ? (_jstDayIndex_(_mi.ms) - _todayIdx) : null;
  }

  // 今日すでに確認したかを付ける（画面で未確認だけを先に出すため）
  var _todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  for (var ck = 0; ck < customers.length; ck++) {
    customers[ck].checkedToday = (customers[ck].checkedDate === _todayStr);
  }

  // 既定の列を決める。
  // ⚠️ 条件・電話番号・LINE紐付けが揃ってから呼ぶこと。
  //   電話番号は問い合わせシートから、LINE紐付けは LINE Users から後で入るので、
  //   前に出すと全員が「メールのみ」に落ちる。
  _fillDefaultStages_(customers);

  // 未完了タスクの集計（カンバン/リストのマーク用）
  try {
    var taskSum = _getTaskSummaryByCustomer_(ss);
    for (var ti = 0; ti < customers.length; ti++) {
      var ts = taskSum[customers[ti].name];
      customers[ti].openTasks = ts ? ts.open : 0;
      customers[ti].overdueTasks = ts ? ts.overdue : 0;
      customers[ti].nextDue = ts ? ts.nextDue : '';
    }
  } catch(e) { console.warn('タスク集計エラー: ' + e.message); }

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
    if (btMode && btMode !== 'skip' && btMode !== 'none') btMode = 'alert';
    var senmenMode = String(data[i][40] || '').trim().toLowerCase();
    if (senmenMode && senmenMode !== 'skip' && senmenMode !== 'none') senmenMode = 'alert';

    info = {
      name: name,
      status: status,
      email: String(data[i][31] || ''),          // AF列(32): メール（問い合わせ由来）
      stage: String(data[i][32] || ''),          // AG列(33): 営業ステージ
      phone: String(data[i][34] || ''),          // AI列(35): 電話番号（手動登録）
      registeredAt: regStr,
      reason: String(data[i][13] || ''),        // N列
      moveInDate: String(data[i][14] || ''),     // O列
      resident: String(data[i][17] || ''),       // R列: 居住者
      age: String(data[i][27] || ''),            // AB列(28): 年齢
      rentMax: '',
      layouts: '',
      area: '',
      areaMin: '',
      buildingAge: '',
      walk: '',
      structures: '',
      equipment: '',
      notes: '',
      btMode: btMode,
      senmenMode: senmenMode
    };

    // エリア: 路線+駅(E列) or 市区町村+町名(D列 + Y列/町名JSON)
    var routeStation = String(data[i][4] || ''); // E列
    var cityWithTowns = _formatCityWithTowns_(data[i][3], data[i][24]); // D列 + Y列(index24)
    info.area = routeStation || cityWithTowns || '';
    // 駅徒歩 (G列 index 6)
    if (data[i][6]) info.walk = String(data[i][6]);
    // 賃料上限 (H列 index 7)
    if (data[i][7]) info.rentMax = String(data[i][7]);
    // 間取り (I列 index 8)
    if (data[i][8]) info.layouts = String(data[i][8]);
    // 広さ (J列 index 9)
    if (data[i][9]) info.areaMin = String(data[i][9]);
    // 築年数 (K列 index 10)
    if (data[i][10]) info.buildingAge = String(data[i][10]);
    // 構造 (L列 index 11)
    if (data[i][11]) info.structures = String(data[i][11]);
    // 設備 (M列 index 12)
    if (data[i][12]) info.equipment = String(data[i][12]);
    // 備考 (P列 index 15)
    if (data[i][15]) info.notes = String(data[i][15]);
  }

  if (!info) return { error: '顧客が見つかりません: ' + customerName };

  // メール配信停止(UNSUBSCRIBE)状態
  info.mailUnsubscribed = _isEmailUnsubscribed_(info.email);
  // LINE登録済みでも reply.py はフォローアップを送らない（check_followup_status 参照）。
  // 止まっているのに画面では「配信中」と出ていて、止まっていることに気づけなかったので、
  // 理由が分かるように返す。
  info.mailStoppedByLine = _isEmailLineRegistered_(info.email);
  // 送付済み物件の地図ページ(map.html)のURL。お客様に渡すのと同じもの。
  // いまは社内で下見するためだけに使う（お客様には配っていない）。
  try { info.mapUrl = getCustomerMapUrl(customerName).url || ''; } catch (eMap) { info.mapUrl = ''; }

  // 自動返信メール履歴（reply.py が記録する「メール送信履歴」を、この顧客のメールで集約）
  info.mailHistory = [];
  try {
    var emailKey = String(info.email || '').trim().toLowerCase();
    if (emailKey) {
      var mSheet = ss.getSheetByName('メール送信履歴');
      if (mSheet && mSheet.getLastRow() > 1) {
        var mdata = mSheet.getRange(2, 1, mSheet.getLastRow() - 1, 7).getValues();
        for (var mi = 0; mi < mdata.length; mi++) {
          if (String(mdata[mi][1] || '').trim().toLowerCase() !== emailKey) continue;
          var mdt = mdata[mi][0];
          var days = mdata[mi][5];
          info.mailHistory.push({
            dateStr: (mdt instanceof Date) ? Utilities.formatDate(mdt, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm') : String(mdt || ''),
            ts: (mdt instanceof Date) ? mdt.getTime() : (new Date(String(mdt)).getTime() || 0),
            type: String(mdata[mi][4] || '') + ((days !== '' && days != null && String(days) !== '0') ? '（' + days + '日目）' : '')
          });
        }
        info.mailHistory.sort(function(a, b) { return b.ts - a.ts; });
      }
    }
  } catch (eMH) {}

  // 電話番号が未登録なら、問い合わせシートのTELで補完表示（保存はしない）
  if (!String(info.phone || '').trim()) {
    try {
      var inqSheetP = ss.getSheetByName(INQUIRY_SHEET_NAME);
      if (inqSheetP && inqSheetP.getLastRow() > 1) {
        var inqP = inqSheetP.getRange(2, 1, inqSheetP.getLastRow() - 1, INQUIRY_HEADERS.length).getValues();
        var emK = String(info.email || '').trim().toLowerCase();
        for (var pi = 0; pi < inqP.length; pi++) {
          var t = String(inqP[pi][5] || '').trim();
          if (!t) continue;
          var e2 = String(inqP[pi][4] || '').trim().toLowerCase();
          var n2 = String(inqP[pi][2] || '').trim();
          if ((emK && e2 === emK) || n2 === customerName) { info.phone = t; break; }
        }
      }
    } catch (ePh) {}
  }

  // 問い合わせ物件（SUUMO反響）— 物件詳細URL付きで一覧表示する
  info.inquiries = [];
  try {
    var inqSheetI = ss.getSheetByName(INQUIRY_SHEET_NAME);
    if (inqSheetI && inqSheetI.getLastRow() > 1) {
      var inqI = inqSheetI.getRange(2, 1, inqSheetI.getLastRow() - 1, INQUIRY_HEADERS.length).getValues();
      var emKI = String(info.email || '').trim().toLowerCase();
      for (var ii = 0; ii < inqI.length; ii++) {
        var iEmail = String(inqI[ii][4] || '').trim().toLowerCase();
        var iName = String(inqI[ii][2] || '').trim();
        if (!((emKI && iEmail === emKI) || iName === customerName)) continue;
        var iDt = inqI[ii][0];
        info.inquiries.push({
          dateStr: (iDt instanceof Date) ? Utilities.formatDate(iDt, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm') : String(iDt || ''),
          ts: (iDt instanceof Date) ? iDt.getTime() : (new Date(String(iDt)).getTime() || 0),
          propertyName: String(inqI[ii][8] || ''),  // I列: 物件名
          rent: String(inqI[ii][10] || ''),         // K列: 賃料
          url: String(inqI[ii][15] || '')           // P列: 物件詳細URL
        });
      }
      info.inquiries.sort(function(a, b) { return b.ts - a.ts; });
    }
  } catch (eInq) {}

  // 送付済み物件
  info.properties = _getCustomerProperties_(ss, customerName);

  // 対応ログ
  info.contactLogs = _getContactLogs_(ss, customerName);

  // タイムライン
  info.timeline = _buildCustomerTimeline_(ss, customerName, data);

  // タスク（todo）
  info.tasks = getCustomerTasks(customerName);

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
          viewCount: 0,
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
          propMap[vRoomId].viewCount++;
          var vDate = viewData[i][3]; // D列 = 閲覧日時（C列は物件名）
          var vDateStr = '';
          if (vDate instanceof Date) {
            vDateStr = Utilities.formatDate(vDate, tz, 'yyyy/MM/dd HH:mm');
          } else if (vDate) {
            vDateStr = String(vDate).substring(0, 16);
          }
          if (vDateStr && vDateStr > propMap[vRoomId].viewedAt) {
            propMap[vRoomId].viewedAt = vDateStr;
          }
        }
      }
    }
  } catch(e) { console.warn('閲覧ログ取得エラー: ' + e.message); }

  // 3. アクションログからアクションを反映（viewも閲覧として処理）
  try {
    var actionSheet = ss.getSheetByName('アクションログ');
    if (actionSheet) {
      var aData = actionSheet.getDataRange().getValues();
      for (var i = 1; i < aData.length; i++) {
        if (String(aData[i][0] || '').trim() !== customerName) continue;
        var aRoomId = String(aData[i][1] || '');
        var actionType = String(aData[i][2] || '');
        if (!propMap[aRoomId]) continue;
        var aDate = aData[i][8];
        var aDateStr = '';
        if (aDate instanceof Date) {
          aDateStr = Utilities.formatDate(aDate, tz, 'yyyy/MM/dd HH:mm');
        }
        if (actionType === 'view') {
          // viewもviewed扱いにする（閲覧ログに無い場合のカバー）
          propMap[aRoomId].viewed = true;
          propMap[aRoomId].viewCount++;
          if (!aDateStr && aData[i][8]) {
            aDateStr = String(aData[i][8]).substring(0, 16);
          }
          if (aDateStr && (!propMap[aRoomId].viewedAt || aDateStr > propMap[aRoomId].viewedAt)) {
            propMap[aRoomId].viewedAt = aDateStr;
          }
        } else {
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
    var dateLocal = '';
    if (d instanceof Date) {
      dateStr = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
      dateLocal = Utilities.formatDate(d, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm");
    } else if (d) {
      dateStr = String(d);
    }
    logs.push({
      date: dateStr,
      dateLocal: dateLocal,
      type: String(data[i][2] || ''),
      memo: String(data[i][3] || ''),
      author: String(data[i][4] || ''),
      rowIndex: i + 1  // シート上の行番号（編集・削除のキー）
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
 * 対応ログを編集する（google.script.run から呼ばれる）。
 * rowNum で行を特定し、誤操作防止のため A列(顧客名)が customerName と一致するか検証してから更新する。
 */
function updateContactLog(rowNum, customerName, type, dateStr, memo) {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CONTACT_LOG_SHEET_NAME);
    if (!sheet) return { success: false, message: '対応ログシートが見つかりません' };
    rowNum = parseInt(rowNum, 10);
    if (!rowNum || rowNum < 2 || rowNum > sheet.getLastRow()) {
      return { success: false, message: '対象の行が見つかりません（再読み込みしてください）' };
    }
    var rowCustomer = String(sheet.getRange(rowNum, 1).getValue() || '').trim();
    if (rowCustomer !== String(customerName).trim()) {
      return { success: false, message: 'ログがずれている可能性があります。ページを再読み込みしてください' };
    }
    var date = new Date(dateStr);
    sheet.getRange(rowNum, 2).setValue(date);  // B: 対応日時
    sheet.getRange(rowNum, 3).setValue(type);  // C: 対応種別
    sheet.getRange(rowNum, 4).setValue(memo);  // D: メモ
    return { success: true };
  } catch(e) {
    return { success: false, message: e.message };
  }
}

/**
 * 対応ログを削除する（google.script.run から呼ばれる）。
 * rowNum で行を特定し、誤操作防止のため A列(顧客名)が customerName と一致するか検証してから削除する。
 */
function deleteContactLog(rowNum, customerName) {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(CONTACT_LOG_SHEET_NAME);
    if (!sheet) return { success: false, message: '対応ログシートが見つかりません' };
    rowNum = parseInt(rowNum, 10);
    if (!rowNum || rowNum < 2 || rowNum > sheet.getLastRow()) {
      return { success: false, message: '対象の行が見つかりません（再読み込みしてください）' };
    }
    var rowCustomer = String(sheet.getRange(rowNum, 1).getValue() || '').trim();
    if (rowCustomer !== String(customerName).trim()) {
      return { success: false, message: 'ログがずれている可能性があります。ページを再読み込みしてください' };
    }
    sheet.deleteRow(rowNum);
    return { success: true };
  } catch(e) {
    return { success: false, message: e.message };
  }
}

// ══════════════════════════════════════════════════════════
//  申込物件の進捗管理
//  シート「申込管理」:
//    A顧客名 / B room_id / C物件名 / D部屋番号 / E賃料 / F申込日
//    G進捗 / Hメモ / I進捗更新日時
//  行番号(rowNum)をIDとして扱う（タスク・対応ログと同じ方式）。
//
//  「お申し込み希望」ボタン(アクションログの hold)からは自動で取り込む。
//  REINS等から手動で申し込んだ物件は、顧客詳細から手で追加する。
// ══════════════════════════════════════════════════════════
var APPLICATION_SHEET_NAME = '申込管理';
var APPLICATION_COLS = 9;
var APPLICATION_HEADERS = ['顧客名', 'room_id', '物件名', '部屋番号', '賃料', '申込日', '進捗', 'メモ', '進捗更新日時'];

// 進行中の段階（この順に進む）
var APPLICATION_STAGES = ['申込受付', '入居審査中', '審査承認', '契約手続き', '入居完了'];
// 終了扱いの段階（一覧では下にまとめる）
var APPLICATION_CLOSED_STAGES = ['否決', 'キャンセル'];
var APPLICATION_STAGE_DEFAULT = '申込受付';

function _allApplicationStages_() {
  return APPLICATION_STAGES.concat(APPLICATION_CLOSED_STAGES);
}

function _normalizeApplicationStage_(v) {
  var s = String(v == null ? '' : v).trim();
  var all = _allApplicationStages_();
  for (var i = 0; i < all.length; i++) {
    if (s === all[i]) return s;
  }
  return APPLICATION_STAGE_DEFAULT;
}

function _getApplicationSheet_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(APPLICATION_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(APPLICATION_SHEET_NAME);
    sheet.appendRow(APPLICATION_HEADERS);
    try {
      sheet.getRange(1, 1, 1, APPLICATION_COLS).setFontWeight('bold').setBackground('#e0e0e0');
      sheet.setFrozenRows(1);
    } catch (e) {}
    return sheet;
  }
  try {
    if (sheet.getMaxColumns() < APPLICATION_COLS) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), APPLICATION_COLS - sheet.getMaxColumns());
    }
  } catch (eMig) {
    console.warn('[申込管理] 列の追加に失敗（続行）: ' + eMig.message);
  }
  return sheet;
}

/** 申込の重複判定キー。room_id があればそれ、無ければ 物件名|部屋番号。 */
function _applicationKey_(roomId, name, room) {
  var rid = String(roomId || '').trim();
  if (rid) return 'rid:' + rid;
  return 'nm:' + String(name || '').trim() + '|' + String(room || '').trim();
}

/**
 * アクションログの「お申し込み希望」(hold) のうち、まだ申込管理に無いものを取り込む。
 * ボタン経由の申込を手入力させないため。既存行の進捗は触らない。
 * @return {number} 取り込んだ件数
 */
function _syncApplicationsFromActionLog_(customerName) {
  var added = 0;
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var logSheet = ss.getSheetByName('アクションログ');
    if (!logSheet || logSheet.getLastRow() < 2) return 0;
    var sheet = _getApplicationSheet_();
    var nameTrim = String(customerName || '').trim();

    // 既存キーを集める
    var known = {};
    if (sheet.getLastRow() > 1) {
      var cur = sheet.getRange(2, 1, sheet.getLastRow() - 1, APPLICATION_COLS).getValues();
      for (var c = 0; c < cur.length; c++) {
        if (String(cur[c][0] || '').trim() !== nameTrim) continue;
        known[_applicationKey_(cur[c][1], cur[c][2], cur[c][3])] = true;
      }
    }

    var logs = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 10).getValues();
    var rowsToAdd = [];
    for (var i = 0; i < logs.length; i++) {
      if (String(logs[i][0] || '').trim() !== nameTrim) continue;
      if (String(logs[i][2] || '').trim() !== 'hold') continue;   // 申し込み希望のみ
      var key = _applicationKey_(logs[i][1], logs[i][3], logs[i][4]);
      if (known[key]) continue;
      known[key] = true;   // 同じ物件を複数回押していても1件だけ
      var appliedAt = logs[i][8];
      var appliedDate = (appliedAt instanceof Date) ? appliedAt
        : (appliedAt ? new Date(String(appliedAt).replace(/\//g, '-').replace(' ', 'T') + '+09:00') : '');
      if (appliedDate && isNaN(appliedDate.getTime())) appliedDate = '';
      rowsToAdd.push([
        nameTrim,
        String(logs[i][1] || ''),
        String(logs[i][3] || ''),
        String(logs[i][4] || ''),
        logs[i][5] || '',
        appliedDate,
        APPLICATION_STAGE_DEFAULT,
        '',
        new Date()
      ]);
    }
    if (rowsToAdd.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAdd.length, APPLICATION_COLS).setValues(rowsToAdd);
      added = rowsToAdd.length;
    }
  } catch (e) {
    console.warn('[申込管理] アクションログからの取り込みに失敗（続行）: ' + e.message);
  }
  return added;
}

/**
 * 顧客の申込物件と進捗を返す（google.script.run から呼ばれる）。
 * 呼ぶたびにアクションログの申し込み希望を取り込むので、
 * ボタン経由の申込は自動で並ぶ。
 */
function getCustomerApplications(customerName) {
  try {
    var nameTrim = String(customerName || '').trim();
    if (!nameTrim) return { applications: [], stages: _allApplicationStages_() };
    _syncApplicationsFromActionLog_(nameTrim);

    var sheet = _getApplicationSheet_();
    if (sheet.getLastRow() < 2) {
      return { applications: [], stages: _allApplicationStages_(), activeStages: APPLICATION_STAGES };
    }
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, APPLICATION_COLS).getValues();
    var out = [];
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0] || '').trim() !== nameTrim) continue;
      var stage = _normalizeApplicationStage_(data[i][6]);
      var applied = data[i][5];
      var updated = data[i][8];
      var sinceBase = (updated instanceof Date) ? updated : ((applied instanceof Date) ? applied : null);
      out.push({
        rowNum: i + 2,
        roomId: String(data[i][1] || ''),
        name: String(data[i][2] || ''),
        room: String(data[i][3] || ''),
        rent: data[i][4] === '' || data[i][4] == null ? '' : String(data[i][4]),
        appliedAt: (applied instanceof Date)
          ? Utilities.formatDate(applied, 'Asia/Tokyo', 'yyyy-MM-dd') : String(applied || '').substring(0, 10),
        stage: stage,
        memo: String(data[i][7] || ''),
        closed: (APPLICATION_CLOSED_STAGES.indexOf(stage) !== -1),
        stageDays: sinceBase ? Math.max(0, _jstDayIndex_(Date.now()) - _jstDayIndex_(sinceBase.getTime())) : null
      });
    }
    // 進行中を上に、同じ進行度なら止まっている期間が長い順（＝催促すべき順）
    var order = _allApplicationStages_();
    out.sort(function (a, b) {
      if (a.closed !== b.closed) return a.closed ? 1 : -1;
      var oa = order.indexOf(a.stage), ob = order.indexOf(b.stage);
      if (oa !== ob) return oa - ob;
      var da = (a.stageDays == null ? -1 : a.stageDays);
      var db = (b.stageDays == null ? -1 : b.stageDays);
      return db - da;
    });
    return { applications: out, stages: _allApplicationStages_(), activeStages: APPLICATION_STAGES };
  } catch (e) {
    console.error('getCustomerApplications エラー: ' + e.message);
    return { applications: [], stages: _allApplicationStages_(), error: e.message };
  }
}

/** 行の存在＋顧客名一致を検証（誤操作防止）。 */
function _checkApplicationRow_(rowNum, customerName) {
  var sheet = _getApplicationSheet_();
  rowNum = parseInt(rowNum, 10);
  if (!rowNum || rowNum < 2 || rowNum > sheet.getLastRow()) {
    return { ok: false, message: '対象の申込が見つかりません（再読み込みしてください）' };
  }
  if (String(sheet.getRange(rowNum, 1).getValue() || '').trim() !== String(customerName).trim()) {
    return { ok: false, message: '表示がずれている可能性があります。ページを再読み込みしてください' };
  }
  return { ok: true, sheet: sheet, rowNum: rowNum };
}

/** 進捗を変更する。変えた時刻を記録して「この段階で何日止まっているか」を数えられるようにする。 */
function setApplicationStage(rowNum, customerName, stage) {
  var chk = _checkApplicationRow_(rowNum, customerName);
  if (!chk.ok) return { success: false, message: chk.message };
  var normalized = _normalizeApplicationStage_(stage);
  var prev = _normalizeApplicationStage_(chk.sheet.getRange(chk.rowNum, 7).getValue());
  chk.sheet.getRange(chk.rowNum, 7).setValue(normalized);
  if (prev !== normalized) chk.sheet.getRange(chk.rowNum, 9).setValue(new Date());
  return { success: true, stage: normalized };
}

/** メモを更新する。 */
function updateApplicationMemo(rowNum, customerName, memo) {
  var chk = _checkApplicationRow_(rowNum, customerName);
  if (!chk.ok) return { success: false, message: chk.message };
  chk.sheet.getRange(chk.rowNum, 8).setValue(String(memo == null ? '' : memo));
  return { success: true };
}

/** 手動で申込を追加する（REINS等、物件ページ経由でない申込用）。 */
function addCustomerApplication(customerName, propertyName, room, rent, appliedStr) {
  try {
    var nameTrim = String(customerName || '').trim();
    var propName = String(propertyName || '').trim();
    if (!nameTrim) return { success: false, message: '顧客名がありません' };
    if (!propName) return { success: false, message: '物件名を入力してください' };
    var applied = new Date();
    if (appliedStr) {
      var d = new Date(String(appliedStr).replace(/-/g, '/'));
      if (!isNaN(d.getTime())) applied = d;
    }
    var sheet = _getApplicationSheet_();
    sheet.appendRow([
      nameTrim, '', propName, String(room || '').trim(), rent || '',
      applied, APPLICATION_STAGE_DEFAULT, '', new Date()
    ]);
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/** 申込を削除する（誤登録の取り消し用）。 */
function deleteCustomerApplication(rowNum, customerName) {
  var chk = _checkApplicationRow_(rowNum, customerName);
  if (!chk.ok) return { success: false, message: chk.message };
  chk.sheet.deleteRow(chk.rowNum);
  return { success: true };
}

// ══════════════════════════════════════════════════════════
//  顧客ごとのタスク（todo）
//  シート「タスク」:
//    A顧客名 / B内容 / C期限(Date) / D完了(TRUE/'') / E作成日時
//    F ボール（誰が動く番か: 自分 / お客さん / 管理会社） / G ボール更新日時
//  行番号(rowNum)をIDとして扱う（対応ログと同じ方式）。
// ══════════════════════════════════════════════════════════
var TASK_SHEET_NAME = 'タスク';
var TASK_COLS = 7;
var TASK_HEADERS = ['顧客名', '内容', '期限', '完了', '作成日時', 'ボール', 'ボール更新日時'];

// ボール（誰が動く番か）。'自分' 以外は「相手待ち」として扱う。
var TASK_OWNERS = ['自分', 'お客さん', '管理会社'];
var TASK_OWNER_DEFAULT = '自分';

/** 入力値を正規の担当名に丸める（不明な値・空は既定の「自分」）。 */
function _normalizeTaskOwner_(v) {
  var s = String(v == null ? '' : v).trim();
  for (var i = 0; i < TASK_OWNERS.length; i++) {
    if (s === TASK_OWNERS[i]) return s;
  }
  return TASK_OWNER_DEFAULT;
}

function _getTaskSheet_() {
  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var sheet = ss.getSheetByName(TASK_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TASK_SHEET_NAME);
    sheet.appendRow(TASK_HEADERS);
    try {
      sheet.getRange(1, 1, 1, TASK_COLS).setFontWeight('bold').setBackground('#e0e0e0');
      sheet.setFrozenRows(1);
    } catch (e) {}
    return sheet;
  }
  // 既存シートに ボール列(F,G) が無ければ足す（既存データは触らない）。
  // 値が空の行は読み出し時に既定の「自分」として扱うので、行の埋め直しは不要。
  try {
    if (sheet.getMaxColumns() < TASK_COLS) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), TASK_COLS - sheet.getMaxColumns());
    }
    var head = sheet.getRange(1, 1, 1, TASK_COLS).getValues()[0];
    var needsHeader = false;
    for (var h = 0; h < TASK_COLS; h++) {
      if (String(head[h] || '').trim() !== TASK_HEADERS[h]) { needsHeader = true; break; }
    }
    if (needsHeader) {
      sheet.getRange(1, 1, 1, TASK_COLS).setValues([TASK_HEADERS]);
      sheet.getRange(1, 1, 1, TASK_COLS).setFontWeight('bold').setBackground('#e0e0e0');
    }
  } catch (eMig) {
    console.warn('[タスク] ボール列の追加に失敗（続行）: ' + eMig.message);
  }
  return sheet;
}

/**
 * 相手ボールになってから何日経ったかを返す（自分ボール・完了済みは null）。
 * ボール更新日時(G)が無い既存行は作成日時(E)で代用する。
 */
function _taskWaitDays_(ownerSince, createdAt, owner, done) {
  if (done || owner === TASK_OWNER_DEFAULT) return null;
  var base = (ownerSince instanceof Date) ? ownerSince
           : ((createdAt instanceof Date) ? createdAt : null);
  if (!base) return null;
  var days = _jstDayIndex_(Date.now()) - _jstDayIndex_(base.getTime());
  return days < 0 ? 0 : days;
}

/** 顧客のタスク一覧を返す（未完了→期限昇順、完了は末尾）。google.script.run から呼ばれる。 */
function getCustomerTasks(customerName) {
  try {
    var sheet = _getTaskSheet_();
    var last = sheet.getLastRow();
    if (last < 2) return [];
    var data = sheet.getRange(2, 1, last - 1, TASK_COLS).getValues();
    var nameTrim = String(customerName).trim();
    var todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    var out = [];
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() !== nameTrim) continue;
      var due = data[i][2];
      var dueStr = (due instanceof Date) ? Utilities.formatDate(due, 'Asia/Tokyo', 'yyyy-MM-dd') : (due ? String(due).substring(0, 10) : '');
      var done = String(data[i][3] || '') === 'TRUE' || data[i][3] === true;
      var owner = _normalizeTaskOwner_(data[i][5]);
      out.push({
        rowNum: i + 2,
        content: String(data[i][1] || ''),
        due: dueStr,
        done: done,
        overdue: (!done && dueStr && dueStr < todayStr),
        owner: owner,
        waiting: (owner !== TASK_OWNER_DEFAULT),
        waitDays: _taskWaitDays_(data[i][6], data[i][4], owner, done)
      });
    }
    out.sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;   // 未完了が上
      if (!a.due && !b.due) return 0;
      if (!a.due) return 1;                            // 期限なしは後ろ
      if (!b.due) return -1;
      return a.due < b.due ? -1 : (a.due > b.due ? 1 : 0);
    });
    return out;
  } catch (e) {
    return [];
  }
}

/** タスク追加。google.script.run から呼ばれる。 */
function addCustomerTask(customerName, content, dueStr, owner) {
  try {
    content = String(content || '').trim();
    if (!content) return { success: false, message: '内容を入力してください' };
    var sheet = _getTaskSheet_();
    var due = '';
    if (dueStr) { var d = new Date(String(dueStr).replace(/-/g, '/')); if (!isNaN(d.getTime())) due = d; }
    var now = new Date();
    sheet.appendRow([
      String(customerName).trim(), content, due, '', now,
      _normalizeTaskOwner_(owner), now
    ]);
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * ボール（誰が動く番か）だけを切り替える。やること列からワンタップで変える用。
 * 切り替えた時刻を記録して「相手待ち◯日」を数えられるようにする。
 */
function setTaskOwner(rowNum, customerName, owner) {
  var chk = _checkTaskRow_(rowNum, customerName);
  if (!chk.ok) return { success: false, message: chk.message };
  var normalized = _normalizeTaskOwner_(owner);
  var prev = _normalizeTaskOwner_(chk.sheet.getRange(chk.rowNum, 6).getValue());
  chk.sheet.getRange(chk.rowNum, 6).setValue(normalized);
  // 同じ担当への付け替えでは待ち日数をリセットしない
  if (prev !== normalized) chk.sheet.getRange(chk.rowNum, 7).setValue(new Date());
  return { success: true, owner: normalized };
}

/** タスクの完了/未完了を切り替える。 */
function toggleCustomerTask(rowNum, customerName, done) {
  var chk = _checkTaskRow_(rowNum, customerName);
  if (!chk.ok) return { success: false, message: chk.message };
  chk.sheet.getRange(chk.rowNum, 4).setValue(done ? 'TRUE' : '');
  return { success: true };
}

/** タスクの内容/期限/ボールを編集する。 */
function updateCustomerTask(rowNum, customerName, content, dueStr, owner) {
  var chk = _checkTaskRow_(rowNum, customerName);
  if (!chk.ok) return { success: false, message: chk.message };
  content = String(content || '').trim();
  if (!content) return { success: false, message: '内容を入力してください' };
  var due = '';
  if (dueStr) { var d = new Date(String(dueStr).replace(/-/g, '/')); if (!isNaN(d.getTime())) due = d; }
  chk.sheet.getRange(chk.rowNum, 2).setValue(content);
  chk.sheet.getRange(chk.rowNum, 3).setValue(due);
  // owner 未指定（旧UIからの呼び出し）ではボールを触らない
  if (owner !== undefined && owner !== null && owner !== '') {
    var normalized = _normalizeTaskOwner_(owner);
    var prev = _normalizeTaskOwner_(chk.sheet.getRange(chk.rowNum, 6).getValue());
    chk.sheet.getRange(chk.rowNum, 6).setValue(normalized);
    if (prev !== normalized) chk.sheet.getRange(chk.rowNum, 7).setValue(new Date());
  }
  return { success: true };
}

/** タスクを削除する。 */
function deleteCustomerTask(rowNum, customerName) {
  var chk = _checkTaskRow_(rowNum, customerName);
  if (!chk.ok) return { success: false, message: chk.message };
  chk.sheet.deleteRow(chk.rowNum);
  return { success: true };
}

/** 行の存在＋顧客名一致を検証（誤操作防止）。 */
function _checkTaskRow_(rowNum, customerName) {
  var sheet = _getTaskSheet_();
  rowNum = parseInt(rowNum, 10);
  if (!rowNum || rowNum < 2 || rowNum > sheet.getLastRow()) {
    return { ok: false, message: '対象のタスクが見つかりません（ページを再読み込みしてください）' };
  }
  if (String(sheet.getRange(rowNum, 1).getValue() || '').trim() !== String(customerName).trim()) {
    return { ok: false, message: 'タスクがずれている可能性があります。ページを再読み込みしてください' };
  }
  return { ok: true, sheet: sheet, rowNum: rowNum };
}

/**
 * 全顧客のタスクを横断で返す（顧客管理トップの「やることリスト」用）。
 * 顧客ページを開かないとタスクが見えなかったので、一覧の上に常設表示するために追加。
 *
 * 並び: 未完了が先 → 期限が早い順（期限なしは未完了の末尾）→ 完了は最後。
 * アーカイブ済み顧客のタスクも「見落とし防止」のため返す（archived フラグを立てる）。
 *
 * @param {boolean} includeDone - true なら完了済みタスクも含める
 * @return {{tasks: Array, counts: {open:number, overdue:number, today:number}}}
 */
function getAllTasks(includeDone) {
  try {
    var sheet = _getTaskSheet_();
    var last = sheet.getLastRow();
    if (last < 2) return { tasks: [], counts: { open: 0, overdue: 0, today: 0 } };
    var data = sheet.getRange(2, 1, last - 1, TASK_COLS).getValues();
    var todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

    // アーカイブ済み顧客（AS列=45に日時が入っている）を拾っておく
    var archivedMap = {};
    try {
      var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
      var cSheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
      if (cSheet) {
        var cData = cSheet.getDataRange().getValues();
        for (var ci = 1; ci < cData.length; ci++) {
          var cn = String(cData[ci][1] || '').trim();
          if (cn && String(cData[ci][44] || '').trim()) archivedMap[cn] = true;
        }
      }
    } catch (eArch) {
      console.warn('[getAllTasks] アーカイブ判定に失敗（続行）: ' + eArch.message);
    }

    var out = [];
    var openCount = 0, overdueCount = 0, todayCount = 0, mineCount = 0, waitingCount = 0;
    for (var i = 0; i < data.length; i++) {
      var nm = String(data[i][0] || '').trim();
      if (!nm) continue;
      var content = String(data[i][1] || '');
      if (!content) continue;
      var done = String(data[i][3] || '') === 'TRUE' || data[i][3] === true;
      var due = data[i][2];
      var dueStr = (due instanceof Date)
        ? Utilities.formatDate(due, 'Asia/Tokyo', 'yyyy-MM-dd')
        : (due ? String(due).substring(0, 10) : '');
      var isOverdue = (!done && !!dueStr && dueStr < todayStr);
      var isToday = (!done && dueStr === todayStr);
      var owner = _normalizeTaskOwner_(data[i][5]);
      var waiting = (owner !== TASK_OWNER_DEFAULT);
      if (!done) {
        openCount++;
        if (isOverdue) overdueCount++;
        if (isToday) todayCount++;
        if (waiting) waitingCount++; else mineCount++;
      }
      if (done && !includeDone) continue;
      out.push({
        rowNum: i + 2,
        customer: nm,
        content: content,
        due: dueStr,
        done: done,
        overdue: isOverdue,
        today: isToday,
        owner: owner,
        waiting: waiting,
        waitDays: _taskWaitDays_(data[i][6], data[i][4], owner, done),
        archived: !!archivedMap[nm]
      });
    }

    out.sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;    // 未完了が上
      // 自分ボールを先に（相手待ちは眺めるだけなので下に置く）
      if (a.waiting !== b.waiting) return a.waiting ? 1 : -1;
      if (a.waiting) {
        // 相手待ちは「待たせている期間が長い順」＝催促すべき順
        var wa = (a.waitDays == null ? -1 : a.waitDays);
        var wb = (b.waitDays == null ? -1 : b.waitDays);
        if (wa !== wb) return wb - wa;
      }
      if (!a.due && !b.due) return a.customer < b.customer ? -1 : 1;
      if (!a.due) return 1;                             // 期限なしは後ろ
      if (!b.due) return -1;
      if (a.due !== b.due) return a.due < b.due ? -1 : 1;
      return a.customer < b.customer ? -1 : 1;
    });

    return {
      tasks: out,
      counts: {
        open: openCount, overdue: overdueCount, today: todayCount,
        mine: mineCount, waiting: waitingCount
      },
      owners: TASK_OWNERS
    };
  } catch (e) {
    console.error('getAllTasks エラー: ' + e.message);
    return {
      tasks: [],
      counts: { open: 0, overdue: 0, today: 0, mine: 0, waiting: 0 },
      owners: TASK_OWNERS,
      error: e.message
    };
  }
}

/** 顧客ごとの未完了タスク集計（カンバンのマーク用）。 name -> {open, overdue, nextDue} */
function _getTaskSummaryByCustomer_(ss) {
  var summary = {};
  try {
    var sheet = ss.getSheetByName(TASK_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return summary;
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
    var todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    for (var i = 0; i < data.length; i++) {
      var nm = String(data[i][0] || '').trim();
      if (!nm) continue;
      var done = String(data[i][3] || '') === 'TRUE' || data[i][3] === true;
      if (done) continue;
      if (!summary[nm]) summary[nm] = { open: 0, overdue: 0, nextDue: '' };
      summary[nm].open++;
      var due = data[i][2];
      var dueStr = (due instanceof Date) ? Utilities.formatDate(due, 'Asia/Tokyo', 'yyyy-MM-dd') : '';
      if (dueStr) {
        if (dueStr < todayStr) summary[nm].overdue++;
        if (!summary[nm].nextDue || dueStr < summary[nm].nextDue) summary[nm].nextDue = dueStr;
      }
    }
  } catch (e) {}
  return summary;
}

/**
 * 全アクションを時系列で統合したタイムラインを構築する。
 */
function _buildCustomerTimeline_(ss, customerName, criteriaData) {
  var timeline = [];
  var tz = 'Asia/Tokyo';

  // 0. 条件変更履歴（SheetWriter が writeToSheet のたびに差分を残している）
  try {
    var histSheet = ss.getSheetByName('条件変更履歴');
    if (histSheet && histSheet.getLastRow() > 1) {
      var hData = histSheet.getRange(2, 1, histSheet.getLastRow() - 1, 4).getValues();
      for (var hi = 0; hi < hData.length; hi++) {
        if (String(hData[hi][1] || '').trim() !== customerName) continue;
        var hd = hData[hi][0];
        if (!(hd instanceof Date)) continue;
        timeline.push({
          date: Utilities.formatDate(hd, tz, 'yyyy/MM/dd HH:mm'),
          ts: hd.getTime(),
          // CRM側に既にある type（色・ラベル定義済み）に合わせる。
          // 詳細のフィールド名は details（detail だと表示されない）。
          type: 'condition_change',
          summary: '条件変更（' + String(hData[hi][2] || '') + '）',
          details: String(hData[hi][3] || '')
        });
      }
    }
  } catch (eHist) {
    console.warn('[タイムライン] 条件変更履歴の読み込み失敗（続行）: ' + eHist.message);
  }

  // 1. 登録日 (検索条件シート A列)
  for (var i = 1; i < criteriaData.length; i++) {
    if (String(criteriaData[i][1] || '').trim() !== customerName) continue;
    var reg = criteriaData[i][0];
    // 条件が空のリード（カンバンに追加しただけ）では「条件登録」を出さない。
    var _hasCrit = (typeof _rowHasCriteria_ === 'function') ? _rowHasCriteria_(criteriaData[i]) : true;
    if (reg instanceof Date && _hasCrit) {
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

  // 3. 閲覧ログ  (列: 顧客名A / room_id B / 物件名C / 閲覧日時D)
  // ※ 閲覧日時は文字列で保存されることがあるため Date/文字列の両対応にする
  //   閲覧はアクションログ(view)にも入るため、room_id|分 で重複排除する
  var viewKeys = {};
  try {
    var viewSheet = ss.getSheetByName('閲覧ログ');
    if (viewSheet) {
      var viewData = viewSheet.getDataRange().getValues();
      for (var i = 1; i < viewData.length; i++) {
        if (String(viewData[i][0] || '').trim() !== customerName) continue;
        var vRaw = viewData[i][3]; // D列 = 閲覧日時
        var vDateObj = (vRaw instanceof Date) ? vRaw : (vRaw ? new Date(String(vRaw).replace(/-/g, '/')) : null);
        if (!vDateObj || isNaN(vDateObj.getTime())) continue;
        var vDateStr3 = Utilities.formatDate(vDateObj, tz, 'yyyy/MM/dd HH:mm');
        var vKey3 = String(viewData[i][1] || '') + '|' + vDateStr3;
        if (viewKeys[vKey3]) continue;
        viewKeys[vKey3] = true;
        timeline.push({
          date: vDateStr3,
          ts: vDateObj.getTime(),
          type: 'view',
          summary: String(viewData[i][2] || '物件') + ' を閲覧'  // C列 = 物件名
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
        var aRaw = aData[i][8]; // I列 = 日時 (Date/文字列 両対応)
        var aDate = (aRaw instanceof Date) ? aRaw : (aRaw ? new Date(String(aRaw).replace(/-/g, '/')) : null);
        if (!aDate || isNaN(aDate.getTime())) continue;
        var actionType = String(aData[i][2] || ''); // C列 = アクション
        var bldgName = String(aData[i][3] || '');   // D列 = 物件名
        var actionLabels = {
          'favorite': 'お気に入り',
          'hold': '申し込み希望',
          'hold_intent': '申し込み画面を開いた',
          'not_interested': '興味なし',
          'viewing': '内見希望',
          'view': '閲覧'
        };
        var label = actionLabels[actionType] || actionType;
        var aDateStr = Utilities.formatDate(aDate, tz, 'yyyy/MM/dd HH:mm');
        // view は「閲覧」として表示（閲覧ログと重複する場合は room_id|分 で排除）
        if (actionType === 'view') {
          var vKey4 = String(aData[i][1] || '') + '|' + aDateStr;
          if (viewKeys[vKey4]) continue;
          viewKeys[vKey4] = true;
          timeline.push({
            date: aDateStr,
            ts: aDate.getTime(),
            type: 'view',
            summary: (bldgName || '物件') + ' を閲覧',
            details: String(aData[i][1] || '') // room_id
          });
          continue;
        }
        timeline.push({
          date: aDateStr,
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

/**
 * 直近の検索実行一覧を取得（AdminPage「検索リセット」用）
 * 承認待ち物件と通知済み物件のタイムスタンプから検索実行をグループ化して返す。
 * 10分以上の空白がある場合は別の実行とみなす。
 */
function getRecentSearchRuns(optCustomerName) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var GAP_MS = 10 * 60 * 1000; // 10分の空白で別実行とみなす
  var DAYS_BACK = 7; // 直近7日分
  var cutoff = Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000;
  var filterCustomer = optCustomerName ? String(optCustomerName).trim() : '';

  // タイムスタンプとメタ情報を収集
  var entries = []; // { ts, customer, source }

  // 承認待ち物件 — L列(index 11) = created_at, A列 = 顧客名
  var pendingSheet = ss.getSheetByName('承認待ち物件');
  if (pendingSheet && pendingSheet.getLastRow() > 1) {
    var pData = pendingSheet.getDataRange().getValues();
    for (var i = 1; i < pData.length; i++) {
      var custName = String(pData[i][0] || '').trim();
      if (filterCustomer && custName !== filterCustomer) continue;
      var createdAt = pData[i][11];
      var ts = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
      if (ts >= cutoff && !isNaN(ts)) {
        entries.push({ ts: ts, customer: custName, source: 'pending' });
      }
    }
  }

  // 通知済み物件 — D列(index 3) = sent_at, A列 = 顧客名
  var seenSheet = ss.getSheetByName('通知済み物件');
  if (seenSheet && seenSheet.getLastRow() > 1) {
    var sData = seenSheet.getDataRange().getValues();
    for (var i = 1; i < sData.length; i++) {
      var custName2 = String(sData[i][0] || '').trim();
      if (filterCustomer && custName2 !== filterCustomer) continue;
      var sentAt = sData[i][3];
      var ts2 = sentAt instanceof Date ? sentAt.getTime() : new Date(sentAt).getTime();
      if (ts2 >= cutoff && !isNaN(ts2)) {
        entries.push({ ts: ts2, customer: custName2, source: 'seen' });
      }
    }
  }

  if (entries.length === 0) return [];

  // タイムスタンプ順にソート
  entries.sort(function(a, b) { return a.ts - b.ts; });

  // 10分ギャップでグルーピング
  var runs = [];
  var currentRun = { start: entries[0].ts, end: entries[0].ts, customers: {}, count: 0 };
  currentRun.customers[entries[0].customer] = true;
  currentRun.count = 1;

  for (var i = 1; i < entries.length; i++) {
    if (entries[i].ts - currentRun.end > GAP_MS) {
      runs.push(currentRun);
      currentRun = { start: entries[i].ts, end: entries[i].ts, customers: {}, count: 0 };
    }
    currentRun.end = entries[i].ts;
    currentRun.customers[entries[i].customer] = true;
    currentRun.count++;
  }
  runs.push(currentRun);

  // 新しい順にソート & フォーマット
  runs.sort(function(a, b) { return b.start - a.start; });

  var fmt = function(ms) {
    var d = new Date(ms);
    return Utilities.formatDate(d, 'Asia/Tokyo', 'HH:mm');
  };
  var fmtDate = function(ms) {
    var d = new Date(ms);
    return Utilities.formatDate(d, 'Asia/Tokyo', 'MM/dd (EEE)');
  };

  return runs.slice(0, 10).map(function(r) {
    return {
      dateLabel: fmtDate(r.start),
      timeRange: fmt(r.start) + ' 〜 ' + fmt(r.end),
      customerCount: Object.keys(r.customers).length,
      propertyCount: r.count,
      startTime: r.start,
      endTime: r.end
    };
  });
}

/**
 * 指定時間帯の検索結果をリセット（AdminPage「検索リセット」用）
 * @param {number} startTime - 開始タイムスタンプ(ms)
 * @param {number} endTime - 終了タイムスタンプ(ms)
 */
function resetSearchRun(startTime, endTime, optCustomerName) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var deletedPending = 0;
  var deletedSeen = 0;
  var dedupKeysToReset = [];
  var filterCustomer = optCustomerName ? String(optCustomerName).trim() : '';

  // 1. 承認待ち物件 — L列(12列目, index 11) = created_at
  var pendingSheet = ss.getSheetByName('承認待ち物件');
  if (pendingSheet) {
    var pData = pendingSheet.getDataRange().getValues();
    var rowsToDelete = [];
    for (var i = 1; i < pData.length; i++) {
      var customer = String(pData[i][0] || '').trim();
      if (filterCustomer && customer !== filterCustomer) continue;
      var createdAt = pData[i][11];
      var ts = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
      if (ts >= startTime && ts <= endTime) {
        rowsToDelete.push(i + 1);
        try {
          var json = JSON.parse(String(pData[i][9] || ''));
          var dk = _buildDedupKeyForGas_({ address: json.address, room_number: json.room_number, area: json.area, layout: json.layout });
          if (dk && customer) dedupKeysToReset.push({ customer: customer, key: dk });
        } catch(_) {}
      }
    }
    for (var j = rowsToDelete.length - 1; j >= 0; j--) {
      pendingSheet.deleteRow(rowsToDelete[j]);
      deletedPending++;
    }
  }

  // 2. 通知済み物件 — D列(4列目, index 3) = sent_at
  var seenSheet = ss.getSheetByName('通知済み物件');
  if (seenSheet) {
    var sData = seenSheet.getDataRange().getValues();
    var rowsToDelete2 = [];
    for (var i = 1; i < sData.length; i++) {
      var customer2 = String(sData[i][0] || '').trim();
      if (filterCustomer && customer2 !== filterCustomer) continue;
      var sentAt = sData[i][3];
      var ts2 = sentAt instanceof Date ? sentAt.getTime() : new Date(sentAt).getTime();
      if (ts2 >= startTime && ts2 <= endTime) {
        rowsToDelete2.push(i + 1);
        var roomId2 = String(sData[i][1] || '');
        if (customer2 && roomId2) dedupKeysToReset.push({ customer: customer2, roomId: roomId2 });
      }
    }
    for (var j = rowsToDelete2.length - 1; j >= 0; j--) {
      seenSheet.deleteRow(rowsToDelete2[j]);
      deletedSeen++;
    }
  }

  // 3. pending_dedup_resets に追加（Chrome拡張が次回同期で30日マップから消す）
  var props = PropertiesService.getScriptProperties();
  var existing = [];
  try { existing = JSON.parse(props.getProperty('pending_dedup_resets') || '[]'); } catch(_) {}
  var nowMs = Date.now();
  for (var k = 0; k < dedupKeysToReset.length; k++) {
    existing.push({ customer: dedupKeysToReset[k].customer, key: dedupKeysToReset[k].key || '', roomId: dedupKeysToReset[k].roomId || '', ts: nowMs });
  }
  props.setProperty('pending_dedup_resets', JSON.stringify(existing));

  // 4. 対象顧客のlastReinsSearch(AC列)をリセット開始日の前日に巻き戻す
  //    → 次回REINS検索で登録年月日フィルタがリセット期間をカバーする
  var affectedCustomers = {};
  for (var dk = 0; dk < dedupKeysToReset.length; dk++) {
    var cn = dedupKeysToReset[dk].customer;
    if (cn) affectedCustomers[cn] = true;
  }
  var customerNames = Object.keys(affectedCustomers);
  if (customerNames.length > 0) {
    try {
      var rollbackStr = Utilities.formatDate(new Date(startTime), 'Asia/Tokyo', 'yyyy-MM-dd');

      var critSs = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
      var critSheet = critSs.getSheetByName(CRITERIA_SHEET_NAME);
      if (critSheet) {
        var critData = critSheet.getDataRange().getValues();
        for (var ci = 1; ci < critData.length; ci++) {
          var cName = String(critData[ci][1] || '').trim();
          if (affectedCustomers[cName]) {
            var currentVal = critData[ci][28] ? String(critData[ci][28]) : '';
            // 現在の値がrollback先より新しい場合のみ巻き戻す
            if (!currentVal || currentVal > rollbackStr) {
              critSheet.getRange(ci + 1, 29).setValue(rollbackStr); // AC列
            }
          }
        }
      }
    } catch(reinsErr) { console.warn('lastReinsSearch巻き戻しエラー: ' + reinsErr.message); }
  }

  return { deletedPending: deletedPending, deletedSeen: deletedSeen, dedupResets: dedupKeysToReset.length, reinsDateRolledBack: customerNames.length };
}

// ══════════════════════════════════════════════════════════
//  顧客統合（マージ）
// ══════════════════════════════════════════════════════════

/**
 * 統合候補（同一人物と思われる2行）を推測して返す。
 *
 * LINEから自動で条件登録されると LINE の表示名で行が作られるため、
 * メール問い合わせ由来の行（実名）と二重になる。担当者は
 * 「問い合わせが来た物件 / 問い合わせ時期 / 名前の類似」で当たりを付けて
 * 手で統合していたので、その突き合わせを機械的にやる。
 *
 * ⚠️ 自動では統合しない。別人を統合すると元に戻せないため、候補を出すだけにして
 *   既存の比較プレビュー→確認のフローに乗せる。
 *
 * @return {Array<{nameA, nameB, score, reasons:Array<string>}>}
 */
// ── 統合しないと判断した組（統合除外）─────────────────────────
//   シート「統合除外」に残す。ScriptProperties だと容量上限があるのと、
//   「やっぱり統合したい」ときに行を消すだけで戻せるようにするためシートにする。
var MERGE_DISMISS_SHEET_NAME = '統合除外';

/** 2名から順序に依存しないキーを作る。A×B と B×A を同じものとして扱う。 */
function _mergeDismissKey_(a, b) {
  var x = String(a || '').trim();
  var y = String(b || '').trim();
  return (x <= y) ? (x + '\u0000' + y) : (y + '\u0000' + x);
}

function _getMergeDismissedSet_() {
  var set = {};
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(MERGE_DISMISS_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return set;
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < data.length; i++) {
      var a = String(data[i][0] || '').trim();
      var b = String(data[i][1] || '').trim();
      if (a && b) set[_mergeDismissKey_(a, b)] = true;
    }
  } catch (e) {
    console.warn('_getMergeDismissedSet_ error: ' + e.message);
  }
  return set;
}

/**
 * 複数の統合候補をまとめて「統合しない」にする。
 * 1組ずつ消すのは手間なので、チェックした分を一度に書き込む。
 * @param {Array<{nameA:string,nameB:string}>} pairs
 */
function dismissCustomerMergeCandidates(pairs) {
  try {
    if (!pairs || !pairs.length) return { success: false, message: '選択されていません。' };
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(MERGE_DISMISS_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(MERGE_DISMISS_SHEET_NAME);
      sheet.appendRow(['顧客A', '顧客B', '除外日時']);
    }
    var already = _getMergeDismissedSet_();
    var now = new Date();
    var rows = [];
    for (var i = 0; i < pairs.length; i++) {
      var a = String(pairs[i] && pairs[i].nameA || '').trim();
      var b = String(pairs[i] && pairs[i].nameB || '').trim();
      if (!a || !b) continue;
      var k = _mergeDismissKey_(a, b);
      if (already[k]) continue;
      already[k] = true;   // 同じ組が2つ入っていても1行だけにする
      rows.push([a, b, now]);
    }
    if (rows.length === 0) return { success: true, message: 'すでに除外済みです。', added: 0 };
    // 1行ずつ appendRow すると件数分だけ往復して遅いのでまとめて書く
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
    return { success: true, message: rows.length + '組を候補から外しました。', added: rows.length };
  } catch (e) {
    console.error('dismissCustomerMergeCandidates error: ' + (e.stack || e.message));
    return { success: false, message: e.message };
  }
}

/**
 * 統合候補を「統合しない」として今後出さないようにする。
 * AdminPage から google.script.run で呼ばれる。
 */
function dismissCustomerMergeCandidate(nameA, nameB) {
  try {
    if (!nameA || !nameB) return { success: false, message: '顧客名が不正です。' };
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var sheet = ss.getSheetByName(MERGE_DISMISS_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(MERGE_DISMISS_SHEET_NAME);
      sheet.appendRow(['顧客A', '顧客B', '除外日時']);
    }
    var already = _getMergeDismissedSet_();
    if (already[_mergeDismissKey_(nameA, nameB)]) {
      return { success: true, message: 'すでに除外済みです。' };
    }
    sheet.appendRow([nameA, nameB, new Date()]);
    return { success: true, message: '「' + nameA + ' ← ' + nameB + '」を候補から外しました。' };
  } catch (e) {
    console.error('dismissCustomerMergeCandidate error: ' + (e.stack || e.message));
    return { success: false, message: e.message };
  }
}

function listCustomerMergeCandidates() {
  try {
    var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var critSheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
    if (!critSheet || critSheet.getLastRow() < 2) return [];
    var crit = critSheet.getDataRange().getValues();

    // LINE紐付けのある顧客名（＝LINE由来で行が作られた可能性がある側）
    var lineNames = {};
    var nameToUid = {};
    try {
      var lu = ss.getSheetByName(LINE_USERS_SHEET_NAME);
      if (lu && lu.getLastRow() > 1) {
        var luData = lu.getDataRange().getValues();
        for (var l = 1; l < luData.length; l++) {
          var ln = String(luData[l][1] || '').trim();
          if (!ln) continue;
          lineNames[ln] = true;
          if (!nameToUid[ln]) nameToUid[ln] = String(luData[l][0] || '').trim();
        }
      }
    } catch (_eLu) {}

    // LINE登録メール（メール / userId / 表示名 / 登録日時）。
    // メールで突き合わせられれば推測ではなく確定できるので最優先で使う。
    var uidToEmail = {};
    try {
      var le = ss.getSheetByName(LINE_EMAIL_SHEET_NAME);
      if (le && le.getLastRow() > 1) {
        var leData = le.getDataRange().getValues();
        for (var m = 1; m < leData.length; m++) {
          var lem = String(leData[m][0] || '').trim().toLowerCase();
          var luid = String(leData[m][1] || '').trim();
          if (lem && luid && !uidToEmail[luid]) uidToEmail[luid] = lem;
        }
      }
    } catch (_eLe) {}

    // 問い合わせ: 名前 → { 物件名, 受信日時 }
    var inquiries = [];
    try {
      var inq = ss.getSheetByName(INQUIRY_SHEET_NAME);
      if (inq && inq.getLastRow() > 1) {
        var iData = inq.getRange(2, 1, inq.getLastRow() - 1, INQUIRY_HEADERS.length).getValues();
        for (var q = 0; q < iData.length; q++) {
          var qName = String(iData[q][2] || '').trim();
          if (!qName) continue;
          inquiries.push({
            name: qName,
            email: String(iData[q][4] || '').trim().toLowerCase(),
            building: _mcNormBuilding_(iData[q][8]),
            at: (iData[q][0] instanceof Date) ? iData[q][0].getTime() : 0
          });
        }
      }
    } catch (_eInq) {}

    // LINE側がどの物件から来たかを 返信キュー から取る。
    // 列: userId / 物件名 / 部屋番号 / 受付時刻 / 送信予定時刻 / ステータス / ユーザー名
    //
    // ⚠️ アクションログは使えない。あちらに行が入るのは handlePropertyAction、
    //   つまり「こちらが送った物件ページでお気に入り等を押した時」だけなので、
    //   問い合わせ直後の新規LINE友だちは1行も持たない。統合が必要なのはまさに
    //   その人たちなので、肝心なケースで一致しなかった（2026-08-10）。
    //   返信キューは空室確認を受け付けた時点で必ず1行入るので、こちらが正しい。
    var actedBuildings = {};
    try {
      var rq = ss.getSheetByName('返信キュー');
      if (rq && rq.getLastRow() > 1) {
        var rqData = rq.getDataRange().getValues();
        var rqHead = rqData[0].map(function (h) { return String(h || '').trim(); });
        var cUid = rqHead.indexOf('userId');
        var cBld = rqHead.indexOf('物件名');
        var cUsr = rqHead.indexOf('ユーザー名');
        var cAt = rqHead.indexOf('受付時刻');
        // userId → 顧客名（LINE Users 側の名前に寄せる）
        var uidToName = {};
        for (var nk in nameToUid) { if (nameToUid[nk]) uidToName[nameToUid[nk]] = nk; }
        for (var r2 = 1; r2 < rqData.length; r2++) {
          var rUid = cUid >= 0 ? String(rqData[r2][cUid] || '').trim() : '';
          var rName = uidToName[rUid] || (cUsr >= 0 ? String(rqData[r2][cUsr] || '').trim() : '');
          var rBld = _mcNormBuilding_(cBld >= 0 ? rqData[r2][cBld] : '');
          if (!rName || !rBld) continue;
          if (!actedBuildings[rName]) actedBuildings[rName] = {};
          actedBuildings[rName][rBld] = (cAt >= 0 && rqData[r2][cAt] instanceof Date)
            ? rqData[r2][cAt].getTime() : true;
        }
      }
    } catch (_eRq) {}

    // 検索条件シートの行（名前ごとに最初の1行）
    var rows = {};
    for (var i = 1; i < crit.length; i++) {
      var nm = String(crit[i][1] || '').trim();
      if (!nm || rows[nm]) continue;
      rows[nm] = {
        name: nm,
        registeredAt: (crit[i][0] instanceof Date) ? crit[i][0].getTime() : 0,
        email: String(crit[i][31] || '').trim().toLowerCase(),
        status: String(crit[i][18] || '').trim().toLowerCase(),
        hasCriteria: (typeof _rowHasCriteria_ === 'function') ? !!_rowHasCriteria_(crit[i]) : false
      };
    }

    var dismissed = _getMergeDismissedSet_();

    var names = Object.keys(rows);
    var DAY = 24 * 60 * 60 * 1000;
    var out = [];
    for (var x = 0; x < names.length; x++) {
      for (var y = x + 1; y < names.length; y++) {
        var A = rows[names[x]], B = rows[names[y]];
        // 「統合しない」と判断済みの組は出さない
        if (dismissed[_mergeDismissKey_(A.name, B.name)]) continue;
        // 両方ともLINE紐付け済み or 両方とも未紐付け なら二重の典型形ではない
        var aLine = !!lineNames[A.name], bLine = !!lineNames[B.name];
        if (aLine === bLine) continue;
        // メールが両方あって違う → 別人
        if (A.email && B.email && A.email !== B.email) continue;

        var lineSide = aLine ? A : B;
        var inqSide = aLine ? B : A;

        // LINE登録メールと問い合わせ側のメールが両方あって違う → 別人
        var _lineEmailPre = uidToEmail[nameToUid[lineSide.name] || ''] || '';
        if (_lineEmailPre && inqSide.email && _lineEmailPre !== inqSide.email) continue;

        var reasons = [];
        var score = 0;

        // ① 同じ物件（問い合わせ物件 と LINE側が触れた物件）
        // ⚠️ 完全一致では取りこぼす。問い合わせシートは部屋番号込みの
        //   「Branche荻窪201」、返信キューは建物名だけの「Branche荻窪」なので、
        //   どちらかがもう一方の先頭に一致すれば同じ物件とみなす。
        var acted = actedBuildings[lineSide.name] || {};
        var actedKeys = Object.keys(acted);
        var matchedBuilding = '';
        for (var ii = 0; ii < inquiries.length && !matchedBuilding; ii++) {
          if (inquiries[ii].name !== inqSide.name) continue;
          var ib = inquiries[ii].building;
          if (!ib) continue;
          for (var ak = 0; ak < actedKeys.length; ak++) {
            var qb = actedKeys[ak];
            if (!qb) continue;
            if (ib === qb || ib.indexOf(qb) === 0 || qb.indexOf(ib) === 0) {
              matchedBuilding = (ib.length >= qb.length) ? ib : qb;
              break;
            }
          }
        }
        var strong = false;   // 決め手になる根拠があるか

        // ⓪ メール一致（LINE登録メール × 問い合わせ/検索条件シートのメール）
        // これは推測ではなく確定なので最優先。
        var lineEmail = uidToEmail[nameToUid[lineSide.name] || ''] || '';
        if (lineEmail) {
          var inqEmail = inqSide.email;
          if (!inqEmail) {
            for (var ei = 0; ei < inquiries.length; ei++) {
              if (inquiries[ei].name === inqSide.name && inquiries[ei].email) { inqEmail = inquiries[ei].email; break; }
            }
          }
          if (inqEmail && inqEmail === lineEmail) {
            score += 10; strong = true;
            reasons.push('メールが一致（' + lineEmail + '）');
          }
        }

        if (matchedBuilding) { score += 3; strong = true; reasons.push('同じ物件に問い合わせ（' + matchedBuilding + '）'); }

        // ② 時期の近さ（登録日どうし）
        if (A.registeredAt && B.registeredAt) {
          var diff = Math.abs(A.registeredAt - B.registeredAt);
          if (diff <= 3 * DAY) {
            // ⚠️ 時期の近さは補強材料であって決め手ではない。
            //   +2 にすると「条件はLINE側だけ」と合わせて総当たりが全部候補になり、
            //   同じLINE顧客が何人もの別人と組まれた（2026-08-10）。
            score += 1;
            reasons.push('登録が' + (diff < DAY ? '同日' : Math.round(diff / DAY) + '日差'));
          }
        }

        // ③ 名前の類似
        // ⚠️ 「姓が同じ」だけで候補にしないこと。佐藤香奈と佐藤智奈美のような
        //   別人が並んでしまう。完全一致・包含は強く、姓一致は弱く数える。
        var sim = _mcNameSimilar_(A.name, B.name);
        if (sim) {
          score += (sim === '姓が同じ') ? 1 : 2;
          if (sim !== '姓が同じ') strong = true;
          reasons.push('名前が類似（' + sim + '）');
        }

        // ④ 片方だけ条件を持っている
        // ⚠️ 加点しないこと。LINE顧客はほぼ全員条件を持ち、リードはほぼ全員持たないので
        //   ほぼ全組で成立してしまい、根拠として意味がない。表示だけする。
        if (lineSide.hasCriteria && !inqSide.hasCriteria) {
          reasons.push('条件はLINE側だけにある');
        }

        // 決め手（同じ物件 or 名前の一致）が無いものは出さない。
        // 時期や姓の一致だけでは別人が大量に並ぶ。
        if (strong && score >= 3) {
          out.push({
            nameA: inqSide.name,      // 名前は問い合わせ側を優先するのでAに置く
            nameB: lineSide.name,
            score: score,
            reasons: reasons
          });
        }
      }
    }
    out.sort(function (p, q) { return q.score - p.score; });
    return out.slice(0, 50);
  } catch (e) {
    console.error('listCustomerMergeCandidates error: ' + (e.stack || e.message));
    return [];
  }
}

/** 物件名を突き合わせ用に正規化（全角半角・空白・号室を吸収）。 */
function _mcNormBuilding_(v) {
  var t = String(v == null ? '' : v).trim();
  if (!t) return '';
  t = t.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  });
  t = t.replace(/\s+/g, '').replace(/号室$/, '');
  return t.toLowerCase();
}

/** 名前が似ているか。似ていれば理由の文字列、違えば ''。 */
function _mcNameSimilar_(a, b) {
  var na = String(a || '').replace(/[\s　]/g, '');
  var nb = String(b || '').replace(/[\s　]/g, '');
  if (!na || !nb) return '';
  if (na === nb) return '完全一致';
  // 片方がもう片方を含む（「對馬実」と「對馬」など）
  if (na.length >= 2 && nb.indexOf(na) >= 0) return '一方が他方を含む';
  if (nb.length >= 2 && na.indexOf(nb) >= 0) return '一方が他方を含む';
  // 先頭2文字が一致（姓が同じ）
  if (na.length >= 2 && nb.length >= 2 && na.substring(0, 2) === nb.substring(0, 2)) return '姓が同じ';
  return '';
}

function getCustomerMergePreview(nameA, nameB) {
  if (!nameA || !nameB || nameA === nameB) {
    return { error: '異なる2つの顧客名を指定してください。' };
  }

  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var critSheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
  var luSheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);

  var critData = critSheet.getDataRange().getValues();
  var rowA = null, rowB = null;
  for (var i = 1; i < critData.length; i++) {
    var n = String(critData[i][1] || '').trim();
    if (n === nameA) rowA = critData[i];
    if (n === nameB) rowB = critData[i];
  }
  if (!rowA && !rowB) return { error: '両方の顧客が見つかりません。' };
  if (!rowA) return { error: nameA + ' が見つかりません。' };
  if (!rowB) return { error: nameB + ' が見つかりません。' };

  var FIELD_LABELS = [
    { col: 3, label: '市区町村' },
    { col: 4, label: '路線(駅名)' },
    { col: 5, label: '駅名' },
    { col: 6, label: '駅徒歩' },
    { col: 7, label: '賃料上限' },
    { col: 8, label: '間取り' },
    { col: 9, label: '専有面積' },
    { col: 10, label: '築年数' },
    { col: 11, label: '構造' },
    { col: 12, label: '設備' },
    { col: 13, label: '理由' },
    { col: 14, label: '入居時期' },
    { col: 15, label: 'その他希望' },
    { col: 16, label: 'ペット種別' },
    { col: 17, label: '入居者' },
    { col: 24, label: '町名丁目' },
    { col: 26, label: '入居時期厳守' },
    { col: 27, label: '年齢' },
    { col: 30, label: 'btMode' },
    { col: 31, label: 'メール' },
    { col: 32, label: '営業ステージ' },
  ];

  var fields = [];
  for (var fi = 0; fi < FIELD_LABELS.length; fi++) {
    var f = FIELD_LABELS[fi];
    var valA = String(rowA[f.col] || '').trim();
    var valB = String(rowB[f.col] || '').trim();
    var status = 'same';
    if (!valA && valB) status = 'onlyB';
    else if (valA && !valB) status = 'onlyA';
    else if (valA !== valB) status = 'conflict';
    fields.push({ col: f.col, label: f.label, valA: valA, valB: valB, status: status });
  }

  // LINE userId
  var lineA = '', lineB = '';
  if (luSheet) {
    var luData = luSheet.getDataRange().getValues();
    for (var li = 1; li < luData.length; li++) {
      var ln = String(luData[li][1] || '').trim();
      if (ln === nameA && luData[li][0]) lineA = String(luData[li][0]);
      if (ln === nameB && luData[li][0]) lineB = String(luData[li][0]);
    }
  }

  // 履歴件数
  var propSs = SpreadsheetApp.openById(PROPERTY_SHEET_ID);
  var countA = { seen: 0, action: 0, view: 0 };
  var countB = { seen: 0, action: 0, view: 0 };
  try {
    var seenSh = propSs.getSheetByName('通知済み物件');
    if (seenSh) {
      var sd = seenSh.getDataRange().getValues();
      for (var si = 1; si < sd.length; si++) {
        var sn = String(sd[si][0] || '').trim();
        if (sn === nameA) countA.seen++;
        if (sn === nameB) countB.seen++;
      }
    }
  } catch(e) {}
  try {
    var actSh = propSs.getSheetByName('アクションログ');
    if (actSh) {
      var ad = actSh.getDataRange().getValues();
      for (var ai = 1; ai < ad.length; ai++) {
        var an = String(ad[ai][0] || '').trim();
        if (an === nameA) countA.action++;
        if (an === nameB) countB.action++;
      }
    }
  } catch(e) {}
  try {
    var vlSh = propSs.getSheetByName('閲覧ログ');
    if (vlSh) {
      var vd = vlSh.getDataRange().getValues();
      for (var vi = 1; vi < vd.length; vi++) {
        var vn = String(vd[vi][0] || '').trim();
        if (vn === nameA) countA.view++;
        if (vn === nameB) countB.view++;
      }
    }
  } catch(e) {}

  // 配信ステータス
  var statusA = String(rowA[18] || '').trim();
  var statusB = String(rowB[18] || '').trim();
  // 営業ステージ（AG列 = index 32）。空のときは status から推定される
  // （_getCustomerListForCRM_ と同じ規則）ので、画面でもそう見せる。
  var stageA = String(rowA[32] || '').trim();
  var stageB = String(rowB[32] || '').trim();

  return {
    nameA: nameA,
    nameB: nameB,
    lineA: lineA,
    lineB: lineB,
    statusA: statusA,
    statusB: statusB,
    stageA: stageA,
    stageB: stageB,
    fields: fields,
    countA: countA,
    countB: countB,
  };
}

function executeCustomerMerge(keepName, mergeName, fieldOverrides) {
  if (!keepName || !mergeName || keepName === mergeName) {
    return { success: false, message: '統合元と統合先が不正です。' };
  }

  var ss = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
  var critSheet = ss.getSheetByName(CRITERIA_SHEET_NAME);
  var luSheet = ss.getSheetByName(LINE_USERS_SHEET_NAME);
  // 通知済み物件・承認待ち等は ss(=SPREADSHEET_ID=CRITERIA_SHEET_ID) にあり、
  // 検索の送付済み判定(handleGetSeenIds)もここを読む。別スプレッドシートは使わない。

  // 1. 検索条件シート — mergeNameの条件をkeepName行に反映して、mergeName行を削除
  var critData = critSheet.getDataRange().getValues();
  var keepRow = -1, mergeRow = -1;
  for (var i = 1; i < critData.length; i++) {
    var n = String(critData[i][1] || '').trim();
    if (n === keepName && keepRow < 0) keepRow = i + 1;
    if (n === mergeName && mergeRow < 0) mergeRow = i + 1;
  }
  if (keepRow < 0) return { success: false, message: keepName + ' が見つかりません。' };
  if (mergeRow < 0) return { success: false, message: mergeName + ' が見つかりません。' };

  // fieldOverrides: { col: value } — conflictフィールドでmerge側を選んだ場合
  if (fieldOverrides) {
    for (var colStr in fieldOverrides) {
      var col = parseInt(colStr, 10);
      critSheet.getRange(keepRow, col + 1).setValue(fieldOverrides[colStr]);
    }
  }

  // onlyB フィールド(keepに無くmergeにある) → keep行に反映
  var keepData = critSheet.getRange(keepRow, 1, 1, critSheet.getLastColumn()).getValues()[0];
  var mergeData = critSheet.getRange(mergeRow, 1, 1, critSheet.getLastColumn()).getValues()[0];
  var CRITERIA_COLS = [3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,24,26,27,30,31,32];
  for (var ci = 0; ci < CRITERIA_COLS.length; ci++) {
    var c = CRITERIA_COLS[ci];
    if (fieldOverrides && fieldOverrides.hasOwnProperty(String(c))) continue;
    var kv = String(keepData[c] || '').trim();
    var mv = String(mergeData[c] || '').trim();
    if (!kv && mv) {
      critSheet.getRange(keepRow, c + 1).setValue(mergeData[c]);
    }
  }

  // merge行を削除
  critSheet.deleteRow(mergeRow);

  // 2. LINE Users — mergeNameのuserIdをkeepNameに紐付け直す
  var mergeLineUserId = '';
  if (luSheet) {
    var luData = luSheet.getDataRange().getValues();
    var keepHasLine = false;
    for (var li = 1; li < luData.length; li++) {
      var ln = String(luData[li][1] || '').trim();
      if (ln === keepName && luData[li][0]) keepHasLine = true;
    }
    for (var li = luData.length - 1; li >= 1; li--) {
      var ln = String(luData[li][1] || '').trim();
      if (ln === mergeName) {
        mergeLineUserId = String(luData[li][0] || '');
        if (!keepHasLine && mergeLineUserId) {
          luSheet.getRange(li + 1, 2).setValue(keepName);
          keepHasLine = true;
        } else {
          luSheet.deleteRow(li + 1);
        }
      }
    }
  }

  // 3. 関連シートの顧客名を mergeName → keepName に一括変更
  //    ※ 以前は別スプレッドシート(PROPERTY_SHEET_ID)を書き換えていたため、実データの
  //      通知済み物件が付け替わらず、統合後の検索で送付済み物件が再送されていた。
  //    ※ 対応ログ・タスクも漏れていたので追加。
  var renamedSheets = [];
  var logSheets = ['通知済み物件', 'アクションログ', '閲覧ログ', '物件コメント', '対応ログ', 'タスク'];
  for (var si = 0; si < logSheets.length; si++) {
    var shName = logSheets[si];
    try {
      var sh = ss.getSheetByName(shName);
      if (!sh) continue;
      var data = sh.getDataRange().getValues();
      var changed = 0;
      for (var ri = 1; ri < data.length; ri++) {
        if (String(data[ri][0] || '').trim() === mergeName) {
          sh.getRange(ri + 1, 1).setValue(keepName);
          changed++;
        }
      }
      if (changed > 0) renamedSheets.push(shName + '(' + changed + '件)');
    } catch(e) {
      console.warn(shName + ' 顧客名変更エラー: ' + e.message);
    }
  }

  // 承認待ちシートも変更（正しいシート名・同じスプレッドシート）
  try {
    var pendSh = ss.getSheetByName(PENDING_SHEET_NAME);
    if (pendSh) {
      var pData = pendSh.getDataRange().getValues();
      var pc = 0;
      for (var pi = 1; pi < pData.length; pi++) {
        if (String(pData[pi][0] || '').trim() === mergeName) {
          pendSh.getRange(pi + 1, 1).setValue(keepName);
          pc++;
        }
      }
      if (pc > 0) renamedSheets.push('承認待ち(' + pc + '件)');
    }
  } catch(e) {}

  return {
    success: true,
    message: mergeName + ' → ' + keepName + ' に統合しました。\n' +
      '履歴更新: ' + (renamedSheets.length > 0 ? renamedSheets.join(', ') : 'なし') +
      (mergeLineUserId ? '\nLINE userId: ' + mergeLineUserId + ' を ' + keepName + ' に紐付け' : ''),
  };
}

/**
 * 顧客名を変更する（oldName → newName）。関連シートの顧客名を一括で書き換える。
 * newName が既に別顧客として存在する場合は拒否（統合は executeCustomerMerge を使う）。
 */
function renameCustomer(oldName, newName) {
  oldName = String(oldName || '').trim();
  newName = String(newName || '').trim();
  if (!oldName || !newName) return { success: false, message: '名前を入力してください' };
  if (oldName === newName) return { success: true, message: '同じ名前です', newName: newName };

  try {
    var critSs = SpreadsheetApp.openById(CRITERIA_SHEET_ID);
    var critSheet = critSs.getSheetByName(CRITERIA_SHEET_NAME);

    // 存在チェック（oldは必須・newは別顧客として既存なら拒否）
    var critData = critSheet.getDataRange().getValues();
    var oldExists = false, newExists = false;
    for (var i = 1; i < critData.length; i++) {
      var n = String(critData[i][1] || '').trim();
      if (n === oldName) oldExists = true;
      if (n === newName) newExists = true;
    }
    if (!oldExists) return { success: false, message: oldName + ' が見つかりません' };
    if (newExists) return { success: false, message: '「' + newName + '」は既に別の顧客として存在します。統合したい場合は統合機能を使ってください。' };

    var updated = [];
    // 指定シートの col列(1-based)の顧客名を旧→新に書き換える
    function renameCol(sheet, col, label) {
      if (!sheet) return;
      try {
        var last = sheet.getLastRow();
        if (last < 2) return;
        var vals = sheet.getRange(2, col, last - 1, 1).getValues();
        var cnt = 0;
        for (var r = 0; r < vals.length; r++) {
          if (String(vals[r][0] || '').trim() === oldName) { sheet.getRange(r + 2, col).setValue(newName); cnt++; }
        }
        if (cnt) updated.push(label + '(' + cnt + ')');
      } catch (e) {}
    }

    // 1. 顧客条件スプレッドシート(CRITERIA_SHEET_ID = SPREADSHEET_ID)。
    //    CRMが送付済み物件・対応ログ等を読むのはこのスプレッドシート。
    renameCol(critSheet, 2, '検索条件');                                   // B列=名前
    renameCol(critSs.getSheetByName(LINE_USERS_SHEET_NAME), 2, 'LINE');    // B列=名前
    renameCol(critSs.getSheetByName(CONTACT_LOG_SHEET_NAME), 1, '対応ログ'); // A列
    renameCol(critSs.getSheetByName('通知済み物件'), 1, '送付済み');         // A列
    renameCol(critSs.getSheetByName('アクションログ'), 1, 'アクション');
    renameCol(critSs.getSheetByName('閲覧ログ'), 1, '閲覧');
    renameCol(critSs.getSheetByName('物件コメント'), 1, 'コメント');
    // 承認待ち物件シート（送付済み物件の詳細・画像の引き元。旧コードは 'シート1' で取り違えていた）
    try { renameCol(critSs.getSheetByName(PENDING_SHEET_NAME), 1, '承認待ち'); } catch (e) {}
    renameCol(critSs.getSheetByName('シート1'), 1, 'シート1');
    try { renameCol(critSs.getSheetByName(RECOMMEND_SHEET_NAME), 2, 'おすすめ条件'); } catch (e) {} // 顧客名=2列目

    // 2. 物件スプレッドシート(PROPERTY_SHEET_ID)にも同名シートがあれば更新（保険）
    try {
      if (typeof PROPERTY_SHEET_ID !== 'undefined' && PROPERTY_SHEET_ID && PROPERTY_SHEET_ID !== CRITERIA_SHEET_ID) {
        var propSs = SpreadsheetApp.openById(PROPERTY_SHEET_ID);
        var ps = ['通知済み物件', 'アクションログ', '閲覧ログ', '物件コメント', 'シート1'];
        for (var pi = 0; pi < ps.length; pi++) renameCol(propSs.getSheetByName(ps[pi]), 1, 'P:' + ps[pi]);
      }
    } catch (e) {}

    return { success: true, newName: newName, message: '「' + oldName + '」→「' + newName + '」に変更しました（' + (updated.join(', ') || '対象なし') + '）' };
  } catch (err) {
    return { success: false, message: 'エラー: ' + err.message };
  }
}
