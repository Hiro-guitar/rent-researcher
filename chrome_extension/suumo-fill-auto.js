/**
 * suumo-fill-auto.js — ForRent自動入稿（content script）
 *
 * ForRent管理画面（www.fn.forrent.jp）のiframe内で動作する。
 * chrome.storage.local の suumoFillQueue から承認済み物件を取得し、
 * フォームに自動入力→保存まで実行する。
 *
 * 既存の suumo-competitor-checker/suumo-fill.js のロジックを移植。
 * 差異: 手動ボタン→キュー駆動、chrome.storage.local→メッセージ経由
 *
 * manifest.json content_scripts:
 *   matches: ["https://www.fn.forrent.jp/fn/*"]
 *   all_frames: true
 */

(function () {
  'use strict';

  // ForRentは<frameset>構造:
  //   トップ: frameset (bodyなし)
  //   frame[name=navi]: ナビバー
  //   frame[name=main]: メインコンテンツ（入力フォームがここ）
  //
  // content script は all_frames:true で全フレームにロードされる。
  // mainフレーム内でキュー監視＋フォーム入力の両方を行う。

  const isTopFrame = (window.top === window);
  const isNaviFrame = (window.name === 'navi');
  const isMainFrame = (window.name === 'main');

  // ── ネット掲載数 自動キャプチャ ──
  // ForRent管理画面 main_r.action のトップページ (TOP1R0000.action) には
  // 「ネット掲載 N 指示 / 50 枠 残り... 枠」がリアルタイム表示されている。
  // そのページが表示されるたびにこの値を chrome.storage.local に保存して、
  // 入稿前の50件チェックがストレージから即読み取れるようにする。
  // (background.js の重い ForRent状態同期 を使わずに済む)
  (function captureSuumoListedCount() {
    const tryCapture = () => {
      try {
        const text = (document.body && document.body.innerText) || '';
        const m = text.match(/ネット掲載\s+(\d+)\s*指示\s*\/\s*(\d+)\s*枠/);
        if (m) {
          const listed = parseInt(m[1], 10);
          const max = parseInt(m[2], 10);
          if (isFinite(listed) && isFinite(max) && max > 0) {
            chrome.storage.local.set({
              suumoListedCount: listed,
              suumoListedMax: max,
              suumoListedCapturedAt: Date.now()
            });
            return true;
          }
        }
      } catch (_) {}
      return false;
    };

    // 即時試行 → ダメなら load イベント後 → さらに少し待ってから
    if (tryCapture()) return;
    const after = () => { setTimeout(tryCapture, 800); };
    if (document.readyState === 'complete') after();
    else window.addEventListener('load', after, { once: true });
  })();

  // ── 入稿タブ判定 ──
  // background.jsに「このタブは入稿専用タブか？」を問い合わせる。
  // suumoFillTabId と sender.tab.id が一致するときだけ true が返る。
  // 手動で開いたForRentタブでは絶対に入稿処理は動かない。
  //
  // タイミング問題対策:
  //   chrome.tabs.create → await setStorageData({suumoFillTabId}) の間に
  //   ログインページが document_idle になって content script が走るケースがあり得るため、
  //   false が返った場合は短い間隔でリトライする（手動タブでは結局最終的にfalseで諦める）。
  function askAmIFillTab(callback, opts) {
    const retries = (opts && opts.retries !== undefined) ? opts.retries : 6;
    const retryDelayMs = (opts && opts.retryDelayMs !== undefined) ? opts.retryDelayMs : 500;
    const attempt = (left) => {
      try {
        chrome.runtime.sendMessage({ type: 'AM_I_FILL_TAB' }, (resp) => {
          if (chrome.runtime.lastError) {
            console.warn('[SUUMO自動入稿] AM_I_FILL_TAB応答エラー:', chrome.runtime.lastError.message);
            if (left > 0) return setTimeout(() => attempt(left - 1), retryDelayMs);
            callback(false);
            return;
          }
          console.log(`[SUUMO自動入稿] AM_I_FILL_TAB結果: isFillTab=${resp && resp.isFillTab} tabId=${resp && resp.tabId} fillTabId=${resp && resp.fillTabId} (残りリトライ${left})`);
          if (resp && resp.isFillTab) {
            callback(true);
          } else if (left > 0) {
            // race conditionの可能性 → 少し待ってリトライ
            setTimeout(() => attempt(left - 1), retryDelayMs);
          } else {
            callback(false);
          }
        });
      } catch (e) {
        console.warn('[SUUMO自動入稿] AM_I_FILL_TAB送信失敗:', e);
        if (left > 0) return setTimeout(() => attempt(left - 1), retryDelayMs);
        callback(false);
      }
    };
    attempt(retries);
  }

  // ── ログインページ検知＆自動ログイン ──
  // ログインページはframeset構造ではなく単純なページ（isTopFrame === true）
  // login.action へPOSTするフォームがあればログインページと判定
  if (isTopFrame) {
    const loginForm = document.querySelector('form[action*="login.action"]');
    // 注: ForRentログインHTMLで実際に name="${loginForm.loginId}" の input が描画されている
    //     （JSP/Strutsのテンプレート評価されていない表記がそのまま出ている）。
    //     念のため従来通りの候補セレクタも試し、見つかった方を使う。
    const loginIdInput = document.querySelector('input[name="${loginForm.loginId}"]')
      || (loginForm && (loginForm.querySelector('input[type="text"]') || loginForm.querySelector('input[name*="login"]')));
    console.log(`[SUUMO自動入稿] ログインページ検知判定: loginForm=${!!loginForm} loginIdInput=${!!loginIdInput} url=${window.location.href}`);
    if (loginForm && loginIdInput) {
      console.log('[SUUMO自動入稿] ログインページ検知');
      // ログイン判定は「URLに?suumo_fill=true が含まれるか」で行う（以前の方式）。
      // タブID照合（askAmIFillTab）はbackgroundのstorage書き込みとのrace conditionが起きやすいため、
      // ログインページだけはURLパラメータで判定する。
      // 手動でログインページを開いた人は ?suumo_fill=true が付いていないので自動ログインしない。
      const urlHasFillParam = window.location.href.includes('suumo_fill=true');
      if (!urlHasFillParam) {
        console.log('[SUUMO自動入稿] ?suumo_fill=true なし（手動アクセス） → 自動ログインスキップ');
        return;
      }
      chrome.storage.local.get(['forrentLoginId', 'forrentPassword'], (data) => {
        if (!data.forrentLoginId || !data.forrentPassword) {
          console.log('[SUUMO自動入稿] ForRent認証情報が未設定 → 手動ログインが必要');
          return;
        }
        console.log('[SUUMO自動入稿] ?suumo_fill=true 検知 → 自動ログイン実行');
        // ログイン後に ?suumo_fill=true が消えるので、suumoFillModeフラグで引き継ぐ
        // set完了を待ってからログインボタンをクリック
        chrome.storage.local.set({ suumoFillMode: true, suumoFillModeSetAt: Date.now() }, () => {
          console.log('[SUUMO自動入稿] suumoFillModeセット完了 → ログイン送信');
          loginIdInput.value = data.forrentLoginId;
          const pwInput = document.querySelector('input[name="${loginForm.password}"]')
            || loginForm.querySelector('input[type="password"]');
          if (pwInput) pwInput.value = data.forrentPassword;
          const submitBtn = document.getElementById('Image7')
            || loginForm.querySelector('input[type="image"]')
            || loginForm.querySelector('input[type="submit"]')
            || loginForm.querySelector('button[type="submit"]');
          if (submitBtn) {
            console.log('[SUUMO自動入稿] ログイン送信ボタン発見:', submitBtn.tagName, submitBtn.id || submitBtn.name || '(no id/name)');
            setTimeout(() => submitBtn.click(), 300);
          } else {
            console.warn('[SUUMO自動入稿] ログイン送信ボタンが見つからない');
          }
        });
      });
      return;
    }
    // ログインページ以外のトップフレーム
    // ForRentの画面構成には2種類ある:
    //   (a) 旧: frameset（<frameset>＋<frame name="navi">＋<frame name="main">）
    //       → トップは何もしない。main/naviフレーム側にcontent scriptが注入される
    //   (b) 新: 単一ページ（main_r.action など。/fn/下で動作）
    //       → トップフレームが本体。ここで監視＋フォーム入力をする必要がある
    if (document.querySelector('frameset')) {
      console.log('[SUUMO自動入稿] framesetトップ - 各フレームに処理を委譲');
      return;
    }
    console.log('[SUUMO自動入稿] 単一ページ（responsive版）検出 → トップフレームで監視開始');
    // fall through: 下のmainフレーム相当の処理に進む
  } else if (isNaviFrame) {
    // ナビフレーム - スキップ
    console.log('[SUUMO自動入稿] naviフレーム - スキップ');
    return;
  }

  // mainフレーム / 単一ページのトップフレーム / その他のフレーム → フォーム入力＋キュー監視
  console.log('[SUUMO自動入稿] main相当フレーム - スクリプト起動, URL:', window.location.href);
  // デバッグ用: DOMにマーカーを追加して読み込み確認
  if (document.body) {
    document.body.setAttribute('data-suumo-fill-auto', 'loaded-' + Date.now());
  }

  // ── Phase 5: 確認画面到達を検知したら background に通知 ──
  // 入力フォーム → 「確認画面へ」クリックで画面遷移 → このcontent scriptが
  // 確認画面で再注入されたタイミングで発火。
  // storage にフラグ suumoPendingConfirmCheck があるときだけ動く(手動で
  // 確認画面を開いた場合には反応しないように制限)。
  (function bootstrapPhase5Notify() {
    try {
      const url = window.location.href;
      if (!/REG1R12001\.action/.test(url)) return;
      if (!document.getElementById('jikko')) return; // 登録ボタンが無い = 確認画面じゃない

      chrome.storage.local.get(['suumoPendingConfirmCheck'], (data) => {
        const ctx = data && data.suumoPendingConfirmCheck;
        if (!ctx) {
          console.log('[SUUMO自動入稿/Phase5] 確認画面を開いたが pending フラグなし(手動操作扱い、何もしない)');
          return;
        }
        // 古すぎる(10分以上前)のフラグは無効扱いして掃除
        if (!ctx.at || (Date.now() - ctx.at) > 10 * 60 * 1000) {
          console.log('[SUUMO自動入稿/Phase5] pending が古いためクリア');
          chrome.storage.local.remove(['suumoPendingConfirmCheck']);
          return;
        }
        // 一度きりなので即クリア
        chrome.storage.local.remove(['suumoPendingConfirmCheck'], () => {
          console.log('[SUUMO自動入稿/Phase5] 確認画面検知 → SUUMO_CONFIRM_REACHED 送信');
          chrome.runtime.sendMessage({
            type: 'SUUMO_CONFIRM_REACHED',
            imageGenresCount: ctx.imageGenresCount || 0,
            imageUploadStats: ctx.imageUploadStats || {},
          }, (resp) => {
            if (chrome.runtime.lastError) {
              console.warn('[SUUMO自動入稿/Phase5] 通知エラー:', chrome.runtime.lastError.message);
              return;
            }
            console.log('[SUUMO自動入稿/Phase5] 結果:', JSON.stringify(resp));
          });
        });
      });
    } catch (e) {
      console.warn('[SUUMO自動入稿/Phase5] bootstrap 例外:', e.message);
    }
  })();

  // キュー監視の二重起動防止フラグ
  let _monitorStarted = false;

  // suumoFillModeフラグがONならキュー監視を開始（ログイン後・承認後どちらでも）
  // フラグはログイン時の content script がセットする。
  // ただしフラグは 30分で自動失効。古いフラグで勝手に入稿が開始されるのを防ぐ。
  const SUUMO_FILL_MODE_TTL_MS = 30 * 60 * 1000;
  chrome.storage.local.get(['suumoFillMode', 'suumoFillModeSetAt'], (data) => {
    // 30分経過していれば期限切れとみなしてクリア
    if (data.suumoFillMode && data.suumoFillModeSetAt && (Date.now() - data.suumoFillModeSetAt > SUUMO_FILL_MODE_TTL_MS)) {
      console.log('[SUUMO自動入稿] suumoFillMode 30分経過で期限切れ → クリアして通常モード');
      chrome.storage.local.remove(['suumoFillMode', 'suumoFillModeSetAt']);
      data.suumoFillMode = false;
    }
    if (data.suumoFillMode) {
      console.log('[SUUMO自動入稿] suumoFillModeフラグ検知 → キュー監視開始 & 即時ポーリング');
      // background.jsにキュー再取得を依頼（ログイン中にキューがクリアされた場合の復旧）
      chrome.runtime.sendMessage({ type: 'SUUMO_QUEUE_POLL_NOW' }, (resp) => {
        if (chrome.runtime.lastError) {
          console.warn('[SUUMO自動入稿] 即時ポーリング送信エラー:', chrome.runtime.lastError.message);
        } else {
          console.log('[SUUMO自動入稿] 即時ポーリング結果:', resp);
        }
      });
      initMainFrameMonitor();
    } else {
      // URLの?suumo_fill=trueもチェック（承認ページからの直接起動時、ログイン不要でトップに来た場合）
      const topUrl = (() => {
        try { return window.top.location.href; } catch (e) { return window.location.href; }
      })();
      if (topUrl.includes('suumo_fill=true')) {
        console.log('[SUUMO自動入稿] ?suumo_fill=true 検知 → キュー監視開始 & 即時ポーリング');
        chrome.storage.local.set({ suumoFillMode: true, suumoFillModeSetAt: Date.now() });
        chrome.runtime.sendMessage({ type: 'SUUMO_QUEUE_POLL_NOW' }, (resp) => {
          if (chrome.runtime.lastError) {
            console.warn('[SUUMO自動入稿] 即時ポーリング送信エラー:', chrome.runtime.lastError.message);
          } else {
            console.log('[SUUMO自動入稿] 即時ポーリング結果:', resp);
          }
        });
        initMainFrameMonitor();
      } else {
        // フラグもURLパラメータもない → タブID照合でも判定（background.jsが先にIDを書いたケース）
        askAmIFillTab((isFillTab) => {
          if (isFillTab) {
            console.log('[SUUMO自動入稿] タブID照合で入稿タブと確認 → キュー監視開始');
            chrome.storage.local.set({ suumoFillMode: true, suumoFillModeSetAt: Date.now() });
            initMainFrameMonitor();
          } else {
            console.log('[SUUMO自動入稿] 手動利用 → キュー監視スキップ');
          }
        });
      }
    }
  });

  // デバッグ用: ページコンテキストからのテストデータ受信
  window.addEventListener('message', async (event) => {
    if (event.data && event.data.type === 'SUUMO_TEST_FILL') {
      console.log('[SUUMO自動入稿] テストデータ受信:', event.data.propertyData?.building_name);
      const normalized = normalizePropertyData(event.data.propertyData);
      try {
        await fillForrentForm(normalized, event.data.imageGenres || {}, event.data.featureIds || []);
        document.body.setAttribute('data-suumo-fill-result', 'success');
      } catch (err) {
        console.error('[SUUMO自動入稿] テスト入力エラー:', err);
        document.body.setAttribute('data-suumo-fill-result', 'error: ' + err.message);
      }
    }
  });

  // ── フォーム入力待機（レガシー: background.jsからのメッセージ経由） ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SUUMO_FILL_START') {
      const normalized = normalizePropertyData(msg.data);
      console.log('[SUUMO自動入稿] メッセージ経由フォーム入力開始:', normalized.building);
      fillForrentForm(normalized, msg.imageGenres, msg.featureIds || [])
        .then(() => sendResponse({ success: true }))
        .catch(err => {
          console.error('[SUUMO自動入稿] エラー:', err);
          sendResponse({ success: false, error: err.message });
        });
      return true;
    }
  });

  // ══════════════════════════════════════════════════════════
  //  itandi/ES-Square/いえらぶ → ForRent 形式 正規化
  // ══════════════════════════════════════════════════════════

  function normalizePropertyData(data) {
    if (!data) return {};

    // 既にREINS形式（building, room等のフィールド）ならそのまま返す
    if (data.building && data.addr1 && data.town) return data;

    const d = Object.assign({}, data);

    // ── 建物名・部屋番号 ──
    d.building = d.building || d.building_name || d.buildingName || d.property_name || d.propertyName || '';
    d.room = d.room || d.room_number || d.roomNumber || '';

    // ── 賃料（円→万円） ──
    if (typeof d.rent === 'number' && d.rent > 1000) {
      // 円単位 → 万円単位の文字列（例: 134000 → "13.4"）
      d.rent = (d.rent / 10000).toString();
    } else if (typeof d.rent === 'string') {
      // "13.4万" のような文字列から数値抽出
      const m = d.rent.match(/([\d.]+)/);
      if (m) {
        const v = parseFloat(m[1]);
        // 1000以上なら円単位と判断
        if (v > 1000) {
          d.rent = (v / 10000).toString();
        } else {
          d.rent = v.toString();
        }
      }
    }

    // ── 管理費（円→円テキスト or そのまま） ──
    if (typeof d.management_fee === 'number') {
      d.managementFee = d.management_fee > 0 ? d.management_fee + '円' : '';
      d.commonServiceFee = d.managementFee;
    } else {
      d.managementFee = d.managementFee || d.management_fee || d.commonServiceFee || '';
      d.commonServiceFee = d.commonServiceFee || d.managementFee;
    }

    // ── 敷金・礼金 ──
    // itandi形式: "1ヶ月" or "10万円" → そのまま使える
    d.deposit = d.deposit || '';
    d.gratuity = d.gratuity || d.key_money || '';

    // ── 物件種別 ──
    d.propertyType = d.propertyType || d.property_type || '';
    if (!d.propertyType && d.structure) {
      d.propertyType = /木造/.test(d.structure) ? 'アパート' : 'マンション';
    }

    // ── 住所パース ──
    if (!d.addr1 && d.address) {
      const parsed = parseAddress(d.address);
      d.pref = parsed.pref || d.pref || d.prefecture || '東京都';
      d.addr1 = parsed.city || '';      // 市区郡
      d.town = parsed.town || '';       // 町名
      d.chome = parsed.chome || '';     // 丁目
      d.addr3 = parsed.banchi || '';    // 番地
    }
    if (!d.pref) d.pref = d.pref || d.prefecture || '東京都';

    // ── 階数パース ──
    // 「地上31階, 地下2階建」「地上31階建」「地下2階」「31階建」等の表記に対応
    // 注: 単純な /(\d+)階建/ だと「地下2階建」を先にマッチして地上階を誤認するため
    //     地上/地下 を別々に抽出する
    if (d.story_text) {
      // 地上階
      if (!d.floorsAbove) {
        const aboveMatch = d.story_text.match(/地上\s*(\d+)\s*階/);
        if (aboveMatch) {
          d.floorsAbove = aboveMatch[1];
        } else {
          // 「地上」表記なし & 「地下」も含まれない場合に限り、X階建 を地上階として採用
          // (地下が混ざっている文字列に対して /(\d+)階建/ は誤マッチするため除外)
          if (!/地下/.test(d.story_text)) {
            const buildMatch = d.story_text.match(/(\d+)\s*階建/);
            if (buildMatch) d.floorsAbove = buildMatch[1];
          }
        }
      }
      // 地下階
      if (!d.floorsBelow) {
        const belowMatch = d.story_text.match(/地下\s*(\d+)\s*階/);
        if (belowMatch) d.floorsBelow = belowMatch[1];
      }
    }
    if (!d.floorLocation && d.floor_text) {
      // "3階" → "3", "B1階" → "B1"
      const m = d.floor_text.match(/(B?\d+)/);
      if (m) d.floorLocation = m[1];
    }

    // ── 間取りパース ──
    if (!d.madoriType && d.layout) {
      const layoutMatch = d.layout.match(/^(\d*)(ワンルーム|R|K|DK|SDK|LDK|SLDK|LK|SK|SLK)$/i);
      if (layoutMatch) {
        d.madoriRoomCount = layoutMatch[1] || '';
        d.madoriType = layoutMatch[2];
      } else {
        // 全角対応
        const hw = toHalfWidth(d.layout).toUpperCase();
        const layoutMatch2 = hw.match(/^(\d*)(R|K|DK|SDK|LDK|SLDK|LK|SK|SLK)$/);
        if (layoutMatch2) {
          d.madoriRoomCount = layoutMatch2[1] || '';
          d.madoriType = layoutMatch2[2];
        }
      }
    }

    // ── 面積 ──
    if (!d.usageArea && d.area) {
      d.usageArea = String(d.area);
    }

    // ── 築年月パース ──
    // itandi形式: building_age = "2010年3月(築16年)" or "新築"
    d.builtYear = d.builtYear || d.built_year || '';
    d.builtMonth = d.builtMonth || d.built_month || '';

    if (!d.builtYear && d.building_age) {
      const ageStr = String(d.building_age);

      // 新築判定: "新築" or "2025年7月(新築)"
      if (ageStr.includes('新築')) {
        d.isNewConstruction = true;
      }

      if (ageStr === '新築') {
        // 年月情報なし → builtYearは空のまま、新築フラグのみ
      } else {
        // "2010年3月(築16年)" → 西暦年・月を抽出
        const dateMatch = ageStr.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
        if (dateMatch) {
          d.builtYear = dateMatch[1];
          d.builtMonth = dateMatch[2];
        } else {
          // "2010年" のみ（月なし）
          const yearOnly = ageStr.match(/(\d{4})\s*年/);
          if (yearOnly) {
            d.builtYear = yearOnly[1];
          } else {
            // "築16年" → 築年数から逆算
            const ageOnly = ageStr.match(/(\d+)/);
            if (ageOnly) {
              const age = parseInt(ageOnly[1]);
              if (age < 100) {
                d.builtYear = String(new Date().getFullYear() - age);
              } else if (age > 1900) {
                d.builtYear = String(age);
              }
            }
          }
        }
      }
    }

    // ── 構造 ──
    d.structure = d.structure || '';

    // ── 交通情報パース ──
    if (!d.access || d.access.length === 0) {
      d.access = [];
      const mainStation = d.station_info || d.traffic || '';
      if (mainStation) {
        const parsed = parseStationInfo(mainStation);
        if (parsed) d.access.push(parsed);
      }
      if (d.other_stations && Array.isArray(d.other_stations)) {
        for (const s of d.other_stations) {
          const parsed = parseStationInfo(s);
          if (parsed) d.access.push(parsed);
        }
      }
    }

    // ── 画像 ──
    d.images = d.images || d.image_urls || [];

    // ── 設備 → features（カンマ区切り文字列） ──
    if (!d.features && d.facilities) {
      // facilities は改行区切りテキスト、カテゴリ行を除いてフラットにする
      const items = [];
      const lines = String(d.facilities).split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // カテゴリのみの行（末尾:）はスキップ
        if (trimmed.match(/[:：]$/)) continue;
        // 【カテゴリ】設備名 の形式 → カテゴリ部分を除去して設備名を抽出
        let content = trimmed;
        const bracketMatch = content.match(/^[■▼●]?【[^】]+】\s*(.*)/);
        if (bracketMatch) {
          content = bracketMatch[1];
          if (!content) continue; // カテゴリ名のみの行はスキップ
        } else if (content.match(/^[■▼●]/)) {
          // ■カテゴリ名 のみの行はスキップ
          if (!content.match(/[,、\/／]/)) continue;
        }
        // カン���・スラッシュ区切り���分解
        const parts = content.split(/[,、\/／]/);
        for (const p of parts) {
          const item = p.trim();
          if (item) items.push(item);
        }
      }
      d.features = items.join(',');
    }

    // ── ソース情報 ──
    d.sourceType = d.sourceType || d.source || '';
    d.sourceUrl = d.sourceUrl || d.url || '';

    // ── 保証会社 ──
    d.guaranteeCompany = d.guaranteeCompany || d.guarantee_info || '';

    console.log('[SUUMO自動入稿] 正規化結果:', JSON.stringify({
      building: d.building, room: d.room, rent: d.rent,
      pref: d.pref, addr1: d.addr1, town: d.town,
      floorsAbove: d.floorsAbove, floorLocation: d.floorLocation,
      madoriRoomCount: d.madoriRoomCount, madoriType: d.madoriType,
      access: d.access?.length, images: d.images?.length
    }));

    return d;
  }

  /**
   * 住所テキストをパースして分割
   * 例: "東京都三鷹市下連雀3-28-14" → { pref, city, town, chome, banchi }
   */
  function parseAddress(addr) {
    if (!addr) return {};
    let s = String(addr);
    const result = {};

    // 都道府県
    const prefMatch = s.match(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/);
    if (prefMatch) {
      result.pref = prefMatch[1];
      s = s.slice(prefMatch[1].length);
    }

    // 市区郡（「市」「区」「郡」で終わるもの。政令市の区は「○○市○○区」）
    const cityMatch = s.match(/^(.+?[市区郡])(.+?区)?/);
    if (cityMatch) {
      result.city = cityMatch[1] + (cityMatch[2] || '');
      s = s.slice(result.city.length);
    }

    // 残りから町名・丁目・番地を分離
    // パターン1: "下連雀3丁目28-14" or "下連雀３丁目28-14"
    // パターン2: "下連雀3-28-14"
    // パターン3: "下連雀三丁目28番14号"
    const townMatch = s.match(/^([^\d\uff10-\uff19]+?)([\d\uff10-\uff19])/);
    if (townMatch) {
      result.town = townMatch[1];
      s = s.slice(result.town.length);

      // 丁目があるか？
      // 全角数字を半角に変換してからパース
      s = s.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
      const chomeMatch = s.match(/^(\d+)丁目(.*)$/);
      if (chomeMatch) {
        result.chome = chomeMatch[1] + '丁目';
        result.banchi = chomeMatch[2].replace(/^[-ー]/, '');
      } else {
        // 丁目の明示表記なし。ハイフン分割で丁目を推定するのは危険なので慎重に:
        //   "下連雀3-28-14"  → 3丁目+28-14 と推定できる(3パート以上)
        //   "南元町17-25"    → 丁目なし・番地17-25 (2パートなら丁目なしとして残す)
        //   "南元町17"       → 丁目なし・番地17 (1パート、そのまま番地)
        // 3パート以上の場合のみ最初の数字を丁目扱いする。
        const parts = s.split(/[-ーー]/);
        if (parts.length >= 3) {
          result.chome = parts[0] + '丁目';
          result.banchi = parts.slice(1).join('-');
        } else {
          // 丁目なし物件として扱う。番地欄に全て入れる。
          result.chome = '';
          result.banchi = s;
        }
      }
    } else {
      // 町名が見つからない場合は残り全体を番地に
      result.town = s;
    }

    return result;
  }

  /**
   * 駅情報テキストをパース
   * 例: "JR中央線 三鷹 徒歩10分" → { line, station, walk }
   */
  function parseStationInfo(info) {
    if (!info) return null;
    const s = String(info);

    // パターン: "路線名 駅名 徒歩N分" or "路線名/駅名/徒歩N分"
    const walkMatch = s.match(/徒歩(\d+)分/);
    const walk = walkMatch ? walkMatch[1] : '';

    // 駅名の前の部分が路線名
    const parts = s.replace(/徒歩\d+分/, '').replace(/駅$/, '').trim().split(/[\s　]+/);
    let line = '', station = '';

    if (parts.length >= 2) {
      line = parts[0];
      station = parts[1].replace(/駅$/, '');
    } else if (parts.length === 1) {
      station = parts[0].replace(/駅$/, '');
    }

    if (!station) return null;
    return { line, station, walk };
  }

  // ══════════════════════════════════════════════════════════
  //  ForRent フォーム入力ロジック
  //  （suumo-competitor-checker/suumo-fill.js からの移植）
  // ══════════════════════════════════════════════════════════

  async function fillForrentForm(data, imageGenres, featureIds) {
    if (!data) throw new Error('物件データがありません');

    // ── 建物名 ──
    setInputById('bukkenNm', data.building || '');

    // ── 階数・部屋番号 ──
    const fieldMappings = [
      { id: 'kai', key: 'floorsAbove' },
      { id: 'chikaInput', key: 'floorsBelow' },
      { id: 'kaibubun', key: 'floorLocation' },
      { id: 'heyaNoInput', key: 'room' }
    ];
    fieldMappings.forEach(({ id, key }) => {
      if (data[key]) setInputById(id, data[key]);
    });

    // ── 物件種別 ──
    const buildingTypeMap = {
      'マンション': '01', 'アパート': '02', '一戸建て': '11',
      'テラス・タウンハウス': '16', 'その他': '99'
    };
    setSelectByName('${bukkenInputForm.bukkenShuCd}', buildingTypeMap[data.propertyType] || '');

    // ── 建物構造 ──
    if (data.structure) {
      const structureMap = {
        'RC': '01', 'RC造': '01', '鉄筋コンクリート': '01', '鉄筋コンクリート造': '01',
        'SRC': '02', 'SRC造': '02', '鉄骨鉄筋コンクリート': '02', '鉄骨鉄筋コンクリート造': '02',
        '木造': '05',
        '鉄骨造': '06', '鉄骨': '06', 'S造': '06',
        '軽量鉄骨': '07', '軽量鉄骨造': '07',
        'その他': '99'
      };
      const key = toHalfWidth(data.structure).trim();
      setSelectByName('${bukkenInputForm.kozoShuCd}', structureMap[key] || '');
    }

    // ── 築年月 ──
    if (data.builtYear) {
      setInputByIdWithEvents('Wareki2Seireki1', data.builtYear);
    }
    if (data.builtMonth) {
      const allMonthInputs = document.querySelectorAll('.getsuInput');
      allMonthInputs.forEach(input => {
        if (input.closest('tr')?.id === 'err9') {
          setInputWithEvents(input, String(data.builtMonth).padStart(2, '0'));
        }
      });
    }

    // ── 新築/中古/未入居 ──
    // デフォルトは中古(shinchikuKbnCd1=2)、新築の場合のみshinchikuKbnCd2(=1)に切替
    if (data.isNewConstruction) {
      const shinchikuRadio = document.getElementById('shinchikuKbnCd2');
      if (shinchikuRadio) {
        shinchikuRadio.checked = true;
        shinchikuRadio.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    // ── 住所（カスケード） ──
    await fillAddress(data);

    // ── 交通情報 ──
    fillTrafficInfo(data);

    // ── 賃料 ──
    if (data.rent) {
      const rentStr = String(data.rent);
      const [intPart, decPart] = rentStr.split('.');
      setInputByName('${bukkenInputForm.chinryo1}', intPart || '');
      setInputByName('${bukkenInputForm.chinryo2}', decPart || '0');
    }

    // ── 管理費 ──
    fillManagementFee(data);

    // ── 敷金・礼金 ──
    fillDepositAndKey(data);

    // ── 間取り ──
    fillLayout(data);

    // ── 専有面積 ──
    if (data.usageArea) {
      const [intPart, decPart] = data.usageArea.split('.');
      setInputById('mensekiIntegerInput', intPart || '');
      setInputById('mensekiDecimalInput', (decPart || '0').padEnd(2, '0'));
    }

    // ── 画像アップロード ──
    const imgDebug = {
      imagesType: typeof data.images,
      imagesIsArray: Array.isArray(data.images),
      imagesLength: data.images?.length || 0,
      imagesSample: Array.isArray(data.images) ? data.images.slice(0, 2).map(u => String(u).substring(0, 80)) : String(data.images).substring(0, 200),
      imageGenresType: typeof imageGenres,
      imageGenresKeys: imageGenres ? Object.keys(imageGenres) : null,
      imageGenresValues: imageGenres ? Object.values(imageGenres).slice(0, 5) : null,
    };
    document.body.setAttribute('data-suumo-img-debug', JSON.stringify(imgDebug));
    console.log('[SUUMO自動入稿] 画像デバッグ:', JSON.stringify(imgDebug));

    if (data.images && data.images.length > 0 && imageGenres && Object.keys(imageGenres).length > 0) {
      try {
        console.log('[SUUMO自動入稿] 画像アップロード開始:', data.images.length, '枚, ジャンル:', Object.keys(imageGenres).length, '件');
        await uploadImages(data.images, imageGenres);
        document.body.setAttribute('data-suumo-img-result', 'success');
        console.log('[SUUMO自動入稿] 画像アップロード完了');
      } catch (imgErr) {
        document.body.setAttribute('data-suumo-img-result', 'error: ' + imgErr.message);
        console.error('[SUUMO自動入稿] 画像アップロードエラー（続行）:', imgErr);
      }
    } else {
      document.body.setAttribute('data-suumo-img-result', 'skipped');
      console.warn('[SUUMO自動入稿] 画像スキップ');
    }

    // ── 設備チェック ──
    if (data.features) {
      fillFeatures(data.features);
    }
    // 承認ページで手動チェックされた設備IDも反映
    if (featureIds && featureIds.length > 0) {
      featureIds.forEach(id => {
        const cb = document.getElementById(id);
        if (cb && !cb.checked) {
          cb.checked = true;
        }
      });
    }

    // ── 損保（火災保険） ──
    fillSonpo(data);

    // ── その他初期費用 ──
    fillOtherInitialCosts(data);

    // ── その他月額費用 ──
    fillOtherMonthlyCosts(data);

    // ── 会社間流通のチェックを外す ──
    ['bukkenNmDispFlg', 'heyaNoDispFlg', 'heyaNoTokkiFlg', 'shosaiJushoDispFlg1', 'bukkenNmTokkiFlg'].forEach(id => {
      const cb = document.getElementById(id);
      if (cb && cb.checked) {
        cb.checked = false;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    // ── 入居予定: 相談 ──
    const nyukyoSodan = document.getElementById('nyukyoKbnCd2');
    if (nyukyoSodan) nyukyoSodan.checked = true;

    // ── 取引態様: 仲介先物 ──
    const torihikiSelect = document.getElementById('torihikiTaiyoKbnCd');
    if (torihikiSelect) {
      torihikiSelect.value = '4';
      torihikiSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ── 元付会社情報 ──
    // REINS: shougo/tel、他ソース: owner_company/owner_phone
    const ownerCompany = data.shougo || data.owner_company || '';
    const ownerPhone = data.tel || data.owner_phone || '';
    if (ownerCompany) {
      setInputByName('${bukkenInputForm.mototsukeGyoshaNm}', ownerCompany.slice(0, 30));
    }
    setInputByName('${bukkenInputForm.mototsukeTantoNm}', '元付担当者');
    if (ownerPhone) {
      setInputByName('${bukkenInputForm.mototsukeTelNo}', ownerPhone);
    }
    const dateInput = document.querySelector('input[name="${bukkenInputForm.mototsukeKakuninDate}"]');
    if (dateInput) {
      const today = new Date();
      dateInput.value = today.getFullYear() + '/' + String(today.getMonth() + 1).padStart(2, '0') + '/' + String(today.getDate()).padStart(2, '0');
    }

    // ── 掲載設定 ──
    const shijiIsizeSelect = document.getElementById('shijiIsize');
    if (shijiIsizeSelect) {
      shijiIsizeSelect.value = '1';
      shijiIsizeSelect.dispatchEvent(new Event('change'));
    }

    // ── キャッチコピー ──
    setInputById('netCatch', '★人気のデザイナーズ物件に空きが出ました★');
    setInputById('netFreeMemo', '★現地集合での内見可能★類似物件も一緒に内見可能★オンライン内見・オンライン契約可能★一人暮らしのお部屋探しなら当社にお任せください★まずはお気軽にお問い合わせください★');

    // ── フリーコメント ──
    const freeMemo = document.getElementById('freeMemo');
    if (freeMemo) {
      if (data.sourceType === 'reins') {
        freeMemo.value = sanitizeSuumoText('REINS 物件番号: ' + (data.propertyNumber || ''));
      } else if (data.sourceUrl) {
        freeMemo.value = sanitizeSuumoText(data.sourceUrl);
      }
    }

    // ── 単身者: 可 ──
    const tanshinRadio = document.getElementById('tanshinKbnCd2');
    if (tanshinRadio) tanshinRadio.checked = true;

    // ── 契約条件（features + 個別フィールドから判定） ──
    fillContractConditions(data);

    // ── 定期借家 ──
    fillTeikiShakuya(data);

    // ── 保証会社 ──
    fillGuaranteeCompany(data);

    // ── 確認画面へ遷移 ──
    // ForRentのフォーム登録は2段階: 「確認画面へ」→ 確認画面で「登録」
    const confirmBtn = document.getElementById('regButton2');
    if (confirmBtn) {
      console.log('[SUUMO自動入稿] フォーム入力完了 → 「確認画面へ」を自動クリック');

      // Phase 5 用のコンテキスト情報を保存。
      // 「確認画面へ」クリックで現在ページが破棄され content script も死ぬため、
      // 遷移先の確認画面でこの情報を読めるように chrome.storage.local に保存しておく。
      try {
        const imgStatsAttr = document.body.getAttribute('data-suumo-img-stats') || '{}';
        const imgStats = JSON.parse(imgStatsAttr);
        const imageGenresCount = (typeof imageGenres === 'object' && imageGenres) ? Object.keys(imageGenres).length : 0;
        await new Promise(resolve => {
          chrome.storage.local.set({
            suumoPendingConfirmCheck: {
              at: Date.now(),
              imageGenresCount,
              imageUploadStats: imgStats,
            }
          }, resolve);
        });
        console.log('[SUUMO自動入稿] Phase5用コンテキスト保存 (images=' + imageGenresCount + ', stats=' + JSON.stringify(imgStats) + ')');
      } catch (e) {
        console.warn('[SUUMO自動入稿] Phase5コンテキスト保存エラー:', e.message);
      }

      await new Promise(r => setTimeout(r, 500));
      confirmBtn.click();
    } else {
      console.warn('[SUUMO自動入稿] 「確認画面へ」ボタン(#regButton2)が見つかりません');
      console.log('[SUUMO自動入稿] フォーム入力完了（確認画面への遷移は手動で行ってください）');
    }
  }

  // ── 住所カスケード入力 ──
  async function fillAddress(data) {
    const prefSelect = document.getElementById('todofukenList');
    if (!prefSelect) return;

    // 都道府県コードを判定（デフォルト: 東京都=13）
    const prefCode = getPrefCode(data.pref || data.prefecture || '東京都');
    prefSelect.value = prefCode;
    prefSelect.dispatchEvent(new Event('change'));

    await waitFor(800);

    const citySelect = document.getElementById('shigunkuList');
    if (citySelect && data.addr1) {
      const cityOpt = findOptionByText(citySelect, data.addr1);
      if (cityOpt) {
        citySelect.value = cityOpt.value;
        citySelect.dispatchEvent(new Event('change'));

        await waitFor(800);

        const townSelect = document.getElementById('chosonList');
        if (townSelect && data.town) {
          const townOpt = findOptionByText(townSelect, data.town);
          if (townOpt) {
            townSelect.value = townOpt.value;
            townSelect.dispatchEvent(new Event('change'));

            await waitFor(800);

            const azaSelect = document.getElementById('azaList');
            if (azaSelect) {
              // 「(字丁目なし)」オプションを探すヘルパー
              const findNoChomeOpt = () => Array.from(azaSelect.options).find(opt =>
                opt.value === '000'
                || /字?丁目なし|(字丁目なし)|なし/.test((opt.text || '').trim())
              );

              let azaOpt;
              if (!data.chome || data.chome.trim() === '') {
                // パース結果で丁目なし → 「(字丁目なし)」を選ぶ
                azaOpt = findNoChomeOpt();
              } else {
                // まず完全一致で検索
                azaOpt = findOptionByText(azaSelect, data.chome);
                if (!azaOpt) {
                  // 「3丁目」→数字部分「3」を抽出し、全角変換して「３」でマッチ
                  const chomeNum = data.chome.replace(/[^\d]/g, '');
                  if (chomeNum) {
                    const zenNum = chomeNum.replace(/\d/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0xFEE0));
                    azaOpt = Array.from(azaSelect.options).find(opt => opt.text.trim() === zenNum || opt.text.trim() === chomeNum);
                  }
                }
                // それでも見つからない → 「(字丁目なし)」にフォールバック
                // (例: パースで "17丁目" と推定したが実際は町名のみで丁目がない町の物件)
                if (!azaOpt) {
                  console.warn(`[SUUMO自動入稿] 丁目 "${data.chome}" がドロップダウンに無いため(字丁目なし)にフォールバック`);
                  azaOpt = findNoChomeOpt();
                }
              }
              if (azaOpt) {
                azaSelect.value = azaOpt.value;
                azaSelect.dispatchEvent(new Event('change'));

                await waitFor(1000);
                // (字丁目なし)を選んだ場合は元の data.chome + '-' + data.banchi を番地欄に入れる
                // (パースで誤って chome="17丁目"、banchi="25"になっていた場合を復元する)
                let banchiValue = data.addr3 || data.banchi || '';
                if (azaOpt.value === '000' && data.chome && data.banchi) {
                  const chomeNumOnly = data.chome.replace(/[^\d]/g, '');
                  if (chomeNumOnly && !banchiValue.startsWith(chomeNumOnly)) {
                    banchiValue = chomeNumOnly + '-' + data.banchi;
                  }
                }
                setInputById('banchiNm', banchiValue);
              }
            }
          }
        }
      }
    }
  }

  // ── 交通情報 ──
  function fillTrafficInfo(data) {
    if (!data.access || data.access.length === 0) return;
    const maxTraffic = 3;
    // 駅名重複を除去: ForRentは「交通1と交通2が同じです」で弾くため、
    // 同一駅名の2つ目以降は入れない(路線が違っても駅名が同じだとNG判定)。
    const dedupedAccess = [];
    const seenStations = new Set();
    for (const t of data.access) {
      if (!t) continue;
      const stationKey = (t.station || '').replace(/\s+/g, '').trim();
      if (!stationKey) continue;
      if (seenStations.has(stationKey)) continue;
      seenStations.add(stationKey);
      dedupedAccess.push(t);
    }

    for (let i = 0; i < Math.min(dedupedAccess.length, maxTraffic); i++) {
      const num = i === 0 ? '' : String(i + 1);
      const t = dedupedAccess[i];
      if (!t) continue;

      // station-data.js が読み込まれていれば路線・駅コードを補完
      let lineCode = t.lineCode || '';
      let stationCode = t.stationCode || '';
      if ((!lineCode || !stationCode) && window.stationData) {
        const match = findStationMatch(t.line || '', t.station || '');
        if (match) {
          if (!lineCode) lineCode = match.lineCode;
          if (!stationCode) stationCode = match.stationCode;
        }
      }

      setInputById('pkgEnsenNmDisp' + num, t.line || '');
      setInputById('pkgEnsenNm' + num, t.line || '');
      if (lineCode) {
        setInputByIdWithEvents('pkgEnsenCd' + num, lineCode);
      }

      setInputById('pkgEkiNmDisp' + num, t.station || '');
      setInputById('pkgEkiNm' + num, t.station || '');
      if (stationCode) {
        const code = stationCode.length > 5 ? stationCode.slice(-5) : stationCode;
        setInputByIdWithEvents('pkgEkiCd' + num, code);
      }

      const walkValue = (t.walk || '').replace(/[^\d]/g, '');
      setInputById('tohofun' + num, walkValue);

      const tohoRadio = document.getElementById('toho' + num) || document.getElementById('toho');
      if (tohoRadio) {
        tohoRadio.checked = true;
        tohoRadio.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // 表示制御: 「駅から」ブロックを表示、バス・車ブロックを非表示
      const ekimadeMap = { '': 'DEkimade', '2': 'DEkimade3', '3': 'DEkimade4' };
      const busteiMap = { '': 'DBustei', '2': 'DBustei3', '3': 'DBustei4' };
      const kurumaMap = { '': 'DKurumade', '2': 'DKurumade3', '3': 'DKurumade4' };

      const ekimadeDiv = document.getElementById(ekimadeMap[num]);
      if (ekimadeDiv) {
        ekimadeDiv.style.display = 'block';
        ekimadeDiv.style.visibility = 'visible';
        ekimadeDiv.classList.remove('defaultHidden');
      }
      const busDiv = document.getElementById(busteiMap[num]);
      const carDiv = document.getElementById(kurumaMap[num]);
      if (busDiv) busDiv.style.display = 'none';
      if (carDiv) carDiv.style.display = 'none';
    }

    // 既存駅が3未満なら SUUMO の「らくらく交通入力」で空きスロットを補完
    // (既存駅は触らず、空きスロットだけ追加する)
    const filledCount = Math.min(dedupedAccess.length, maxTraffic);
    if (filledCount > 0 && filledCount < maxTraffic) {
      autoFillEmptyStationSlots(filledCount).catch(err => {
        console.warn('[SUUMO自動入稿] 駅補完エラー:', err && err.message);
      });
    }
  }

  /**
   * SUUMO の「らくらく交通入力」相当の駅候補を取得して空きスロット (2/3) に
   * 近隣駅を自動補完する。
   *
   * - 既存駅 (スロット1=空きスロット番号未満) は絶対上書きしない
   * - ポップアップは popup-blocker でブロックされるため、fetch() で直接候補HTMLを取得
   * - 候補データを親フォームの空きスロットに直接書き込む (SUUMO の「登録」ボタンは使わない)
   *
   * @param {number} filledCount 既存スロット数 (1 or 2)
   */
  async function autoFillEmptyStationSlots(filledCount) {
    console.log('[SUUMO自動入稿] 駅補完開始 (filledCount=' + filledCount + ')');
    try {
      // らくらく交通入力ページをfetch (現在のセッションcookieで)
      // 注: 直接 fetch だと SUUMO 側セッションに住所が未登録で 0件返る場合があるため、
      //     SUUMOの「らくらく交通入力」ボタンクリックで内部 setup を発動してから fetch する
      const trigBtn = document.getElementById('rakurakuKotsu');
      if (trigBtn) {
        // window.open をフックしてポップアップ自動close + クリック実行
        const origOpen = window.open;
        let triggered = false;
        window.open = function() {
          triggered = true;
          // 開くフリだけして閉じる(セッション設定だけ済ませる)
          const w = origOpen.apply(this, arguments);
          if (w) { try { w.close(); } catch(_){} }
          return w;
        };
        try { trigBtn.click(); } catch(_){}
        window.open = origOpen;
        if (triggered) {
          // setup を発動できた → 少し待ってから fetch
          await new Promise(r => setTimeout(r, 500));
          console.log('[SUUMO自動入稿] らくらく交通入力 setup発動成功');
        } else {
          console.log('[SUUMO自動入稿] setup発動できず (ボタンclick失敗)');
        }
      } else {
        console.log('[SUUMO自動入稿] らくらく交通入力ボタン無し');
      }

      const res = await fetch('https://www.fn.forrent.jp/fn/COM1R02167.action', {
        credentials: 'include'
      });
      console.log('[SUUMO自動入稿] fetch結果 status=' + res.status);
      if (!res.ok) {
        console.warn('[SUUMO自動入稿] らくらく交通入力 fetch失敗:', res.status);
        return;
      }
      const html = await res.text();
      console.log('[SUUMO自動入稿] HTML長=' + html.length + ' / ekiNm1含む=' + html.includes('ekiNm1'));
      const doc = new DOMParser().parseFromString(html, 'text/html');

      // 候補抽出
      const candidates = [];
      for (let i = 1; ; i++) {
        const ekiNmEl = doc.getElementById('ekiNm' + i);
        if (!ekiNmEl) break;
        candidates.push({
          idx: i,
          ensenCd: doc.getElementById('ensenCd' + i)?.value || '',
          ensenNm: doc.getElementById('ensenNm' + i)?.value || '',
          ekiCd: doc.getElementById('ekiCd' + i)?.value || '',
          ekiNm: ekiNmEl.value || '',
          tohofun: parseInt(doc.getElementById('tohofun' + i)?.value || '0', 10) || 0
        });
      }
      console.log('[SUUMO自動入稿] 候補数=' + candidates.length, candidates.map(c => c.ekiNm + '/' + c.tohofun + '分'));

      if (candidates.length === 0) {
        console.warn('[SUUMO自動入稿] 駅候補0件 (セッション未確立の可能性)');
        return;
      }

      // 既存スロットの駅名を収集 (重複排除用)
      const existingStations = new Set();
      ['', '2', '3'].forEach(n => {
        const v = (document.getElementById('pkgEkiNmDisp' + n)?.value || '').trim();
        if (v) existingStations.add(v);
      });

      // 既存駅と重複しない候補を徒歩分昇順で必要数選定
      const needed = 3 - filledCount;
      const eligibleCandidates = candidates
        .filter(c => !existingStations.has(c.ekiNm))
        .sort((a, b) => a.tohofun - b.tohofun)
        .slice(0, needed);

      if (eligibleCandidates.length === 0) {
        console.warn('[SUUMO自動入稿] 重複しない駅候補なし');
        return;
      }

      // 空きスロット (filledCount+1, +2, ...) に直接書き込み
      // 既存駅は触らない (スロット1は filledCount=1なら2,3に、=2なら3だけに書く)
      for (let i = 0; i < eligibleCandidates.length; i++) {
        const slotNum = filledCount + i + 1;
        const num = slotNum === 1 ? '' : String(slotNum);
        const c = eligibleCandidates[i];

        setInputById('pkgEnsenNmDisp' + num, c.ensenNm);
        setInputById('pkgEnsenNm' + num, c.ensenNm);
        if (c.ensenCd) {
          setInputByIdWithEvents('pkgEnsenCd' + num, c.ensenCd);
        }

        setInputById('pkgEkiNmDisp' + num, c.ekiNm);
        setInputById('pkgEkiNm' + num, c.ekiNm);
        if (c.ekiCd) {
          // 駅コードは下5桁が SUUMO 内部での値
          const code = c.ekiCd.length > 5 ? c.ekiCd.slice(-5) : c.ekiCd;
          setInputByIdWithEvents('pkgEkiCd' + num, code);
        }

        setInputById('tohofun' + num, String(c.tohofun));

        // 「駅から」ラジオを ON
        const tohoRadio = document.getElementById('toho' + num) || (slotNum === 1 ? document.getElementById('toho') : null);
        if (tohoRadio) {
          tohoRadio.checked = true;
          tohoRadio.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // 「駅から」ブロック表示・バス/車ブロック非表示
        const ekimadeMap = { '': 'DEkimade', '2': 'DEkimade3', '3': 'DEkimade4' };
        const busteiMap = { '': 'DBustei', '2': 'DBustei3', '3': 'DBustei4' };
        const kurumaMap = { '': 'DKurumade', '2': 'DKurumade3', '3': 'DKurumade4' };
        const ekimadeDiv = document.getElementById(ekimadeMap[num]);
        if (ekimadeDiv) {
          ekimadeDiv.style.display = 'block';
          ekimadeDiv.style.visibility = 'visible';
          ekimadeDiv.classList.remove('defaultHidden');
        }
        const busDiv = document.getElementById(busteiMap[num]);
        const carDiv = document.getElementById(kurumaMap[num]);
        if (busDiv) busDiv.style.display = 'none';
        if (carDiv) carDiv.style.display = 'none';
      }

      console.log('[SUUMO自動入稿] 空きスロットに'
        + eligibleCandidates.length + '駅を直接追加: '
        + eligibleCandidates.map(c => c.ekiNm + '(徒歩' + c.tohofun + '分)').join(', '));
    } catch (e) {
      console.warn('[SUUMO自動入稿] 駅補完エラー:', e && e.message);
    }
  }

  /**
   * station-data.js から路線名・駅名でコードを検索
   */
  function findStationMatch(lineName, stationName) {
    if (!window.stationData || !stationName) return null;

    // 路線名の正規化（全角→半角、ＪＲ削除など）
    const normLine = normalizeLine(lineName);
    const normStation = stationName.replace(/駅$/, '').trim();

    // 駅名で候補を絞り込み
    const candidates = window.stationData.filter(s =>
      s.stationName === normStation
    );

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // 路線名でさらに絞り込み
    if (normLine) {
      const lineMatch = candidates.find(s =>
        normalizeLine(s.lineName) === normLine ||
        s.lineName.includes(normLine) ||
        normLine.includes(s.lineName)
      );
      if (lineMatch) return lineMatch;
    }

    return candidates[0]; // 路線名マッチなしなら最初の候補
  }

  function normalizeLine(name) {
    return (name || '')
      .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/　/g, ' ')
      .replace(/^JR|^ＪＲ/, '')
      .replace(/線$/, '')
      .trim();
  }

  // ── 管理費 ──
  function fillManagementFee(data) {
    function parseYenToMan(str) {
      if (!str || str === 'なし') return null;
      const num = parseInt(str.replace(/[^\d]/g, ''), 10);
      if (isNaN(num)) return null;
      const man = num / 10000;
      const s = man.toString();
      const [intPart, decPart] = s.split('.');
      return { intPart, decPart: decPart || '0' };
    }

    function isNonZero(s) {
      if (!s) return false;
      const num = parseInt(s.replace(/[^\d]/g, ''), 10);
      return !isNaN(num) && num > 0;
    }

    const feeStr = isNonZero(data.commonServiceFee) ? data.commonServiceFee
                 : isNonZero(data.managementFee) ? data.managementFee : '';
    const parts = parseYenToMan(feeStr);
    const feeCheckbox = document.querySelector('input[name="${bukkenInputForm.kanrihiFlg}"]');

    if (parts) {
      if (feeCheckbox) {
        feeCheckbox.checked = true;
        feeCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      setInputByName('${bukkenInputForm.kanrihi1}', parts.intPart);
      setInputByName('${bukkenInputForm.kanrihi2}', parts.decPart);
    } else {
      if (feeCheckbox) {
        feeCheckbox.checked = false;
        feeCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  // ── 敷金・礼金 ──
  function fillDepositAndKey(data) {
    function parseVal(str) {
      if (!str || str === 'なし') return null;
      const num = parseFloat(str.replace(/[^\d.]/g, ''));
      if (isNaN(num)) return null;
      const unit = str.includes('万円') ? 'man' : str.includes('ヶ月') ? 'month' : null;
      if (!unit) return null;
      const [intPart, dec] = num.toFixed(1).split('.');
      return { intPart, decPart: (dec || '0').padEnd(1, '0'), unit };
    }

    // 礼金
    const reikin = parseVal(data.gratuity);
    const reikinFlg = document.getElementById('reikinFlg');
    const DReikin = document.getElementById('DReikin');
    if (reikin && reikinFlg) {
      reikinFlg.checked = true;
      if (DReikin) DReikin.style.visibility = 'visible';
      setInputByName('${bukkenInputForm.reikin1}', reikin.intPart);
      setInputByName('${bukkenInputForm.reikin2}', reikin.decPart);
      const kbnId = reikin.unit === 'month' ? 'reikinKbnCd1' : 'reikinKbnCd2';
      const radio = document.getElementById(kbnId);
      if (radio) radio.checked = true;
    } else if (reikinFlg) {
      reikinFlg.checked = false;
      if (DReikin) DReikin.style.visibility = 'hidden';
    }

    // 敷金
    const shikikin = parseVal(data.deposit);
    const shikikinFlg = document.getElementById('shikikinFlg');
    const DShikikin = document.getElementById('DShikikin');
    if (shikikin && shikikinFlg) {
      shikikinFlg.checked = true;
      if (DShikikin) DShikikin.style.visibility = 'visible';
      setInputByName('${bukkenInputForm.shikikin1}', shikikin.intPart);
      setInputByName('${bukkenInputForm.shikikin2}', shikikin.decPart);
      const kbnId = shikikin.unit === 'month' ? 'shikikinKbnCd1' : 'shikikinKbnCd2';
      const radio = document.getElementById(kbnId);
      if (radio) radio.checked = true;
    } else if (shikikinFlg) {
      shikikinFlg.checked = false;
      if (DShikikin) DShikikin.style.visibility = 'hidden';
    }
  }

  // ── 間取り ──
  function fillLayout(data) {
    const madoriType = toHalfWidth(data.madoriType || '').toUpperCase();
    const roomCount = (data.madoriRoomCount || '').match(/\d+/);
    const roomCountNum = roomCount ? roomCount[0] : '';

    const madoriSelect = document.querySelector('select[name="${bukkenInputForm.madoriTypeKbnCd}"]');
    const heyaCnt = document.getElementById('heyaCntInput');
    if (!madoriSelect || !heyaCnt) return;

    const typeMap = {
      'K': '02', 'DK': '03', 'SDK': '04', 'LDK': '05',
      'SLDK': '06', 'LK': '07', 'SK': '08', 'SLK': '09'
    };

    if (madoriType === 'ワンルーム' || madoriType === 'R') {
      heyaCnt.value = '';
      madoriSelect.value = '01';
    } else {
      heyaCnt.value = roomCountNum;
      madoriSelect.value = typeMap[madoriType] || '';
    }
  }

  // ── 画像アップロード ──
  async function uploadImages(images, genres) {
    // genres: { imageIndex: genreName }
    const genreToValue = {
      '外観': 'gaikan', 'リビング': '040101', 'その他部屋': '040102',
      'キッチン': '040103', 'バス': '040104', 'トイレ': '040105',
      '洗面': '040106', '収納': '040107', 'バルコニー': '040108',
      '庭': '040109', '玄関': '040110', 'セキュリティ': '040111',
      '設備': '040199', '眺望': '050101', 'エントランス': '030101',
      'ロビー': '030102', '駐車場': '030103', '共用部': '030199', 'その他': '999999'
    };

    // アップロード結果統計
    const stats = { tried: 0, success: 0, failed: 0 };
    const recordResult = (r) => {
      stats.tried++;
      if (r && r.ok) stats.success++; else stats.failed++;
    };

    // 間取り画像
    const madoriIdx = Object.keys(genres).find(k => genres[k] === '間取り');
    if (madoriIdx !== undefined && images[madoriIdx]) {
      recordResult(await uploadToInput(images[madoriIdx], 'file_up_clientMadori'));
    }

    // 外観画像
    const gaikanIdx = Object.keys(genres).find(k => genres[k] === '外観');
    if (gaikanIdx !== undefined && images[gaikanIdx]) {
      recordResult(await uploadToInput(images[gaikanIdx], 'file_up_gaikan'));
    }

    // リビング画像
    const livingIdx = Object.keys(genres).find(k => genres[k] === 'リビング');
    if (livingIdx !== undefined && images[livingIdx]) {
      recordResult(await uploadToInputWithCategory(images[livingIdx], 'file_up_shitsunai', 'shitsunaiShashinCategory', '040101'));
    }

    // その他の画像
    const otherTargets = [
      { fileId: 'file_up_shashin1', selectId: 'shashin1Category' },
      { fileId: 'file_up_shashin2', selectId: 'shashin2Category' },
      { fileId: 'file_up_shashin3', selectId: 'shashin3Category' },
      { fileId: 'file_up_tsuikaGazo1', selectId: 'tsuikaGazo1Category' },
      { fileId: 'file_up_tsuikaGazo2', selectId: 'tsuikaGazo2Category' },
      { fileId: 'file_up_tsuikaGazo3', selectId: 'tsuikaGazo3Category' },
      { fileId: 'file_up_tsuikaGazo4', selectId: 'tsuikaGazo4Category' },
      { fileId: 'file_up_tsuikaGazo5', selectId: 'tsuikaGazo5Category' },
      { fileId: 'file_up_tsuikaGazo6', selectId: 'tsuikaGazo6Category' },
      { fileId: 'file_up_tsuikaGazo7', selectId: 'tsuikaGazo7Category' },
      { fileId: 'file_up_tsuikaGazo8', selectId: 'tsuikaGazo8Category' },
    ];

    const otherIndexes = Object.keys(genres).filter(k =>
      !['間取り', '外観', 'リビング'].includes(genres[k])
    );

    for (let i = 0; i < otherIndexes.length && i < otherTargets.length; i++) {
      const idx = otherIndexes[i];
      const genre = genres[idx];
      const value = genreToValue[genre] || '999999';
      recordResult(await uploadToInputWithCategory(images[idx], otherTargets[i].fileId, otherTargets[i].selectId, value));
    }

    console.log(`[SUUMO自動入稿] 画像アップロード結果: 試行${stats.tried}件 成功${stats.success}件 失敗${stats.failed}件`);
    if (document.body) {
      document.body.setAttribute('data-suumo-img-stats', JSON.stringify(stats));
    }
  }

  async function uploadToInput(imageUrl, inputId) {
    // 1枚ごとに例外をトラップし、他の画像のアップロードが止まらないようにする。
    // (以前は 1枚のfetch失敗で uploadImages 全体が throw → 残りの画像が全部スキップ)
    try {
      const input = document.getElementById(inputId);
      if (!input || !imageUrl) return { ok: false, reason: 'input/url missing' };

      const file = await urlToFile(imageUrl, inputId + '.jpg');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    } catch (err) {
      console.warn(`[SUUMO自動入稿] 画像 ${inputId} アップロード失敗: ${err.message} (URL: ${String(imageUrl).substring(0, 80)})`);
      return { ok: false, reason: err.message };
    }
  }

  async function uploadToInputWithCategory(imageUrl, inputId, selectId, categoryValue) {
    const r = await uploadToInput(imageUrl, inputId);
    // アップロード成功時のみカテゴリを設定
    if (r && r.ok) {
      try {
        const select = document.getElementById(selectId);
        if (select && categoryValue) {
          select.value = categoryValue;
          select.dispatchEvent(new Event('change'));
        }
      } catch (err) {
        console.warn(`[SUUMO自動入稿] カテゴリ設定失敗 ${selectId}: ${err.message}`);
      }
    }
    return r;
  }

  async function urlToFile(url, filename) {
    if (url.startsWith('data:')) {
      return base64ToFile(url, filename);
    }
    // 画像URLは各ソースサイトのドメインにあるため、ForRentページから直接fetchすると
    // CORS/認証エラーになる。background service worker経由でfetchしてbase64で受け取る。
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'FETCH_IMAGE_AS_BASE64', url },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (response && response.ok) {
              resolve(response.dataUrl);
            } else {
              reject(new Error(response?.error || '画像取得失敗'));
            }
          }
        );
      });
      return base64ToFile(dataUrl, filename);
    } catch (bgErr) {
      console.warn('[SUUMO自動入稿] background経由画像取得失敗、直接fetchを試行:', bgErr.message);
      // フォールバック: 直接fetch（公開URLの場合は成功する可能性あり）
      const response = await fetch(url);
      const blob = await response.blob();
      return new File([blob], filename, { type: blob.type });
    }
  }

  function base64ToFile(base64, filename) {
    const arr = base64.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) u8arr[n] = bstr.charCodeAt(n);
    return new File([u8arr], filename, { type: mime });
  }

  // ── 設備チェックボックス ──
  function fillFeatures(featuresStr) {
    const featureList = featuresStr.split(',').map(f => f.trim());
    const featureMap = {
      // ■構造・工法・仕様
      'タワーマンション': '0231', 'タワー型マンション': '0231',
      'デザイナーズ': '0233', 'デザイナーズマンション': '0233', 'デザイナーズ物件': '0233',
      '分譲タイプ': '0256', '分譲賃貸': '0256',
      // ■階・フロア
      '最上階': '0305',
      // ■共用部
      'エレベータ': '0501', 'エレベーター': '0501', 'EV': '0501',
      'エレベーター2基': '0502', 'エレベータ2基': '0502',
      '宅配ボックス': '0517', '宅配BOX': '0517', '宅配ＢＯＸ': '0517',
      '24時間ゴミ出し可': '0527', '２４時間ゴミ出し可': '0527',
      '常時ゴミ出し可能': '0527', '敷地内ゴミ置き場': '0527', '敷地内ごみ置き場': '0527',
      'ゴミ出し24時間OK': '0527',
      // ■駐車・駐輪
      '平面駐車場': '0813',
      '自走式駐車場': '0814',
      '駐輪場': '0816', '駐輪場：有': '0816', '駐輪場あり': '0816',
      'バイク置き場': '0817', 'バイク置場': '0817', 'バイク置き場：有': '0817',
      // ■陽当たり・採光
      '南向き': '1001',
      '東南向き': '1002', '南東向き': '1002',
      '南西向き': '1003', '西南向き': '1003',
      '角住戸': '1007', '角部屋': '1007',
      '東南角住戸': '1008', '南東角住戸': '1008',
      '3方角住戸': '1009', '３方角住戸': '1009',
      '南西角住戸': '1010', '西南角住戸': '1010',
      '南面リビング': '1017',
      // ■庭
      '専用庭': '1108',
      // ■管理・防犯
      'オートロック': '1201', 'モニタ付オートロック': '1201',
      'モニター付きオートロック': '1201', 'オートロック付': '1201',
      '防犯カメラ': '1211',
      // ■間取り
      'ロフト': '1326', 'ロフト付き': '1326', 'ロフト付': '1326',
      'メゾネット': '1327',
      // ■キッチン
      'システムキッチン': '1401',
      '対面式キッチン': '1403', 'カウンターキッチン': '1403', '対面キッチン': '1403',
      'L字型キッチン': '1405', 'Ｌ字型キッチン': '1405',
      'アイランドキッチン': '1408',
      'ガスコンロ': '1412', 'ガスコンロ対応': '1412', 'ガスコンロ可': '1412',
      'ガスコンロ設置可': '1412',
      'ガスレンジ付': '1413', 'ガスレンジ付き': '1413',
      'ガスコンロ設置済み': '1413', 'ガスコンロ設置済': '1413',
      '2口コンロ': '1414', '２口コンロ': '1414', 'コンロ2口': '1414', 'コンロ２口': '1414',
      '3口以上コンロ': '1415', '３口以上コンロ': '1415', 'コンロ3口': '1415',
      'コンロ3口以上': '1415', 'コンロ３口以上': '1415',
      'IHクッキングヒーター': '1416', 'ＩＨクッキングヒーター': '1416', 'IHコンロ': '1416',
      '都市ガス': '1436', 'ガス：都市ガス': '1436',
      // ■浴室
      'バス・トイレ別': '1501', 'バストイレ別': '1501', 'Ｂ・Ｔ別': '1501',
      'BT別': '1501', 'ＢＴ別': '1501',
      '追焚機能': '1505', '追焚き機能': '1505', '追い焚き風呂': '1505',
      '追い焚き': '1505', '追焚': '1505', '追い焚き機能': '1505',
      '追焚機能浴室': '1505',
      '浴室乾燥機': '1507', '浴室乾燥': '1507',
      // ■トイレ
      '温水洗浄便座': '1603', 'ウォシュレット': '1603', 'シャワートイレ': '1603',
      // ■洗面所
      '洗面台': '1701', '洗面所独立': '1701', '独立洗面台': '1701',
      '洗面化粧台': '1701', '洗髪洗面化粧台': '1701', '独立洗面': '1701',
      // ■冷暖房・空調
      '床暖房': '1806',
      // ■バルコニー・テラス
      'バルコニー': '2001', 'ワイドバルコニー': '2001',
      'ルーフバルコニー': '2002',
      '南面バルコニー': '2005',
      '2面バルコニー': '2006', '２面バルコニー': '2006', 'バルコニー2面': '2006',
      'バルコニー２面': '2006',
      '両面バルコニー': '2008',
      // ■室内設備・仕様
      'フローリング': '2101',
      '室内洗濯機置場': '2129', '室内洗濯機置き場': '2129', '室内洗濯置場': '2129',
      '洗濯機置場（室内）': '2129',
      // ■収納
      'ウォークインクローゼット': '2204', 'ウォークインクロゼット': '2204', 'WIC': '2204',
      'ウォークインクローゼット2': '2205', 'ウォークインクロゼット2': '2205',
      'ウォークインクロゼット2ヶ所': '2205', 'ウォークインクローゼット2ヶ所': '2205',
      'ウォークスルークローゼット': '2206', 'ウォークスルークロゼット': '2206',
      'シューズボックス': '2207', '玄関収納': '2207', 'シューズBOX': '2207',
      'シューズインクローゼット': '2208', 'シューズWIC': '2208',
      '床下収納': '2221',
      'トランクルーム': '2223',
      // ■情報設備・回線
      'BS・CS': '2401', 'BS･CS': '2401', 'BS/CS': '2401', 'BS，CS': '2401', 'BSCS': '2401',
      'BS': '2402', 'BSアンテナ': '2402', 'BS端子': '2402',
      'CS': '2403', 'CSアンテナ': '2403',
      'CATV': '2404', 'ケーブルTV': '2404', 'ケーブルテレビ': '2404',
      'インターネット使用料無料': '2406', 'インターネット無料': '2406',
      'ネット使用料不要': '2406', 'ネット無料': '2406',
      '光ファイバー': '2410', '光回線': '2410', '光インターネット': '2410',
      'CATVインターネット': '2411',
      'モニター付きインターホン': '2414', 'モニタ付インターホン': '2414',
      'モニター付インターホン': '2414',
      'ＴＶインターホン': '2414', 'TVインターホン': '2414',
      'TVモニターホン': '2414', 'テレビモニタ付インターホン': '2414',
      // ■リフォーム
      'リノベーション': '2609', 'リノベーション物件': '2609',
      // ■費用・入居・条件
      'ペット相談': '2705', 'ペット可': '2705', 'ペット相談可': '2705',
      '事務所使用可': '2710', '事務所相談': '2710', '事務所使用相談': '2710',
      '事務所相談可': '2710',
      // ■家具・家電
      'エアコン': '2801', 'エアコン付き': '2801', 'エアコン付': '2801',
      'エアコン2台': '2802', 'エアコン２台': '2802',
    };

    // 必須項目は常にチェック
    ['3001', '0233', '2737', '2801'].forEach(id => {
      const cb = document.getElementById(id);
      if (cb) cb.checked = true;
    });

    featureList.forEach(name => {
      const id = featureMap[name];
      if (id) {
        const cb = document.getElementById(id);
        if (cb) cb.checked = true;
      }
    });
  }

  // ── 損保（火災保険） ──
  function fillSonpo(data) {
    const raw = data.fire_insurance || data.fireInsurance;
    if (!raw || raw === 'なし' || raw === '0' || raw === '0円') return;

    const rawStr = String(raw);

    // 「2年間 16,550円」→ 年数と金額を分離してパース
    let years = 2; // デフォルト2年
    let amountYen = 0;

    // 年数を抽出: 「2年間」「2年」
    const yearMatch = rawStr.match(/(\d+)\s*年/);
    if (yearMatch) years = parseInt(yearMatch[1]);

    // 金額を抽出: 「16,550円」「16550」— 年数部分を除いた後の数値
    // 「円」の前の数値、またはカンマ区切り数値を探す
    const amountMatch = rawStr.match(/([\d,]+)\s*円/);
    if (amountMatch) {
      amountYen = parseFloat(amountMatch[1].replace(/,/g, ''));
    } else {
      // 「円」がない場合：年数部分を除去してから数値を取得
      const withoutYears = rawStr.replace(/\d+\s*年\s*(間\s*)?/, '');
      amountYen = parseFloat(withoutYears.replace(/[^\d.]/g, ''));
    }

    if (isNaN(amountYen) || amountYen <= 0) return;

    // 万円に変換（正確な値をそのまま入力）
    const manYen = amountYen / 10000;
    const intPart = String(Math.floor(manYen));
    // 小数部をそのまま: 16550円→1.655万円→小数部"655"
    const remainder = amountYen % 10000;
    const decPart = remainder > 0 ? String(remainder) : '0';

    const sonpoFlg = document.getElementById('sonpoFlg');
    if (sonpoFlg) {
      sonpoFlg.checked = true;
      if (typeof sonpoFlg.onclick === 'function') sonpoFlg.onclick();
      // 表示切替
      const sonpoDiv = sonpoFlg.closest('tr')?.querySelector('[id*="Sonpo"], [id*="sonpo"]')
        || document.getElementById('DSonpo');
      if (sonpoDiv) { sonpoDiv.style.display = 'block'; sonpoDiv.style.visibility = 'visible'; }
    }

    // IDが無いのでname属性で取得
    const kingaku1 = document.querySelector('input[name="${bukkenInputForm.sonpoKingaku1}"]');
    const kingaku2 = document.querySelector('input[name="${bukkenInputForm.sonpoKingaku2}"]');
    if (kingaku1) kingaku1.value = intPart;
    if (kingaku2) kingaku2.value = decPart.replace(/0+$/, '') || '0';

    // 契約年数
    const keiyakuCnt = document.querySelector('input[name="${bukkenInputForm.sonpoKeiyakuCnt}"]');
    if (keiyakuCnt) keiyakuCnt.value = String(years);

    console.log('[SUUMO自動入稿] 損保:', amountYen, '円 →', intPart + '.' + decPart, '万円, 契約年数:', years, '年');
  }

  // ── その他初期費用 ──
  function fillOtherInitialCosts(data) {
    const items = [];
    // 単一金額の抽出（"2,500円" → 2500）
    const parseAmount = (val) => {
      if (!val) return 0;
      const s = String(val).replace(/[,，、]/g, ''); // カンマ除去
      const m = s.match(/\d+(?:\.\d+)?/);
      return m ? parseFloat(m[0]) : 0;
    };
    const addItem = (name, val) => {
      if (!val || val === 'なし' || val === '0' || val === '0円') return;
      const amount = parseAmount(val);
      if (amount <= 0) return;
      items.push({ name, amount, text: String(val) });
    };
    // 複数項目を含むテキストから各金額を抽出（例: "A:2,500円 B:11,000円..."）
    const addMultiItem = (defaultName, val) => {
      if (!val || val === 'なし') return;
      const s = String(val).replace(/[,，、](?=\d)/g, ''); // 桁区切りカンマを削除
      const regex = /([^\s:：]+)[:：]\s*(\d+)\s*円/g;
      let matched = false;
      let m;
      while ((m = regex.exec(s)) !== null) {
        const amount = parseFloat(m[2]);
        if (amount > 0) {
          items.push({ name: m[1], amount, text: m[2] + '円' });
          matched = true;
        }
      }
      if (!matched) {
        // 「名前: 金額円」パターンが見つからない → 単一金額として扱う
        addItem(defaultName, val);
      }
    };

    addItem('鍵交換費用', data.key_exchange_fee || data.keyExchangeFee);
    addItem('クリーニング費', data.cleaning_fee || data.cleaningFee);
    // 火災保険は損保セクションで処理するためここでは除外
    if (data.other_onetime_fee || data.otherOneTimeFee) {
      addMultiItem('その他', data.other_onetime_fee || data.otherOneTimeFee);
    }
    // REINS形式互換
    for (let i = 1; i <= 5; i++) {
      if (data['otherFeeName' + i]) addItem(data['otherFeeName' + i], data['otherFeeAmount' + i]);
    }

    if (items.length === 0) return;

    const totalAmount = items.reduce((sum, i) => sum + i.amount, 0);
    // ForRentは万円単位
    const manYen = totalAmount / 10000;
    const [intPart, decPart] = manYen.toFixed(2).split('.');
    const detailText = items.map(i => `${i.name} ${i.text}`).join('\n');

    const etcFlg = document.getElementById('etcHiyoFlg');
    const etcDiv = document.getElementById('DEtcHiyo');
    const etcDetail = document.getElementById('DEtcHiyoShosai');
    const inputs = document.querySelectorAll('#DEtcHiyo input.kingakuMInput, #DEtcHiyo input.kingakuLInput');
    const etcTotal1 = inputs[0] || null;
    const etcTotal2 = inputs[1] || null;
    const etcTextarea = document.getElementById('etcHiyoShosaiInput');

    if (etcFlg) {
      etcFlg.checked = true;
      if (etcDiv) { etcDiv.style.display = 'block'; etcDiv.style.visibility = 'visible'; }
      if (etcDetail) { etcDetail.style.display = 'block'; etcDetail.style.visibility = 'visible'; }
      if (typeof etcFlg.onclick === 'function') etcFlg.onclick();
    }
    if (etcTotal1) etcTotal1.value = intPart;
    if (etcTotal2) etcTotal2.value = decPart;
    if (etcTextarea) etcTextarea.value = sanitizeSuumoText(detailText);
  }

  // ── その他月額費用 ──
  function fillOtherMonthlyCosts(data) {
    // 金額データが空き状況（「無」「有」「駐車場：無」等）しか含まない場合は除外
    const isAvailabilityOnly = (v) => {
      if (!v) return true;
      const s = String(v).trim();
      if (!s) return true;
      // 「無」「有」「なし」「あり」「不要」のみの値や、コロン付き空き状況表記を除外
      if (/^(無|有|なし|あり|不要|-|−|―)$/.test(s)) return true;
      // 「駐車場：無」「駐輪場：無」「バイク置き場：無」等は金額ではないため除外
      if (/[:：](\s*)(無|有|なし|あり|不要)\s*$/.test(s)) return true;
      // 数字が1つも含まれていなければ金額でない
      if (!/\d/.test(s)) return true;
      return false;
    };

    const items = [];
    if (data.parking_fee || data.parkingFee) {
      const v = data.parking_fee || data.parkingFee;
      if (v !== 'なし' && v !== '0' && v !== '0円' && !isAvailabilityOnly(v)) items.push('駐車場 ' + v);
    }
    if (data.other_monthly_fee || data.otherMonthlyAmount) {
      const name = data.otherMonthlyName || 'その他';
      const v = data.other_monthly_fee || data.otherMonthlyAmount;
      if (v && v !== 'なし' && !isAvailabilityOnly(v)) items.push(name + ' ' + v);
    }
    if (data.otherMonthlyName2 && data.otherMonthlyAmount2) {
      if (!isAvailabilityOnly(data.otherMonthlyAmount2)) {
        items.push(data.otherMonthlyName2 + ' ' + data.otherMonthlyAmount2);
      }
    }

    if (items.length === 0) return;

    const flg = document.getElementById('etcShohiyoFlg');
    const div = document.getElementById('DEtcShohiyoFlg');
    const textarea = document.getElementById('etcShohiyoShosaiInput');

    if (flg) {
      flg.checked = true;
      if (div) { div.style.display = 'block'; div.style.visibility = 'visible'; }
      if (typeof flg.onclick === 'function') flg.onclick();
    }
    if (textarea) textarea.value = sanitizeSuumoText(items.join('\n'));
  }

  // ── 保証会社 ──
  function fillGuaranteeCompany(data) {
    // 「-」「−」「ー」「―」等のハイフン類や空白のみの値は「空欄」として扱う
    const raw = String(data.guaranteeCompany || '').trim();
    const isEmptyLike = !raw || /^[-−ー―‐‑‒–—]+$/.test(raw);
    const text = isEmptyLike ? '指定保証会社加入要　条件により異なるため、お問い合わせください' : raw;
    const cb = document.getElementById('hoshoninDaikoFlg');
    if (cb && !cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event('click'));
    }
    const requiredRadio = document.getElementById('hoshoninDaikoKbnCd2');
    if (requiredRadio) requiredRadio.checked = true;
    const select = document.getElementById('hoshoninDaikoKaishaKbnCd');
    if (select) {
      select.value = '2';
      select.dispatchEvent(new Event('change'));
    }
    const textarea = document.getElementById('hoshoninDaikoShosai');
    if (textarea) textarea.value = sanitizeSuumoText(text);
  }

  // ── 契約条件（二人入居・子供・ペット・楽器・事務所・ルームシェア・フリーレント） ──
  function fillContractConditions(data) {
    // facilities, move_in_conditions, free_rent から条件を判定
    const facilities = String(data.facilities || '');
    const moveIn = String(data.move_in_conditions || '');
    const combined = facilities + ' ' + moveIn;

    // --- 二人入居 ---
    // 「二人入居可」「2人入居可」「２人入居可」「二人入居(可)」「２人入居相談」
    if (/[二2２]人入居[可相]/.test(combined)) {
      const el = document.getElementById('futariKbnCd2'); // 可
      if (el) el.checked = true;
    }

    // --- 子供 ---
    // 「子供可」「子供(可)」→ 可にする。不可はチェックしない
    if (/子供[可(（]/.test(combined) && !/子供[不(（]不/.test(combined)) {
      // 子供(可) の判定: ES-Square形式 "子供(可)" or 単純 "子供可"
      if (/子供\(可\)/.test(combined) || /子供可/.test(combined)) {
        const el = document.getElementById('kodomoKbnCd2'); // 可
        if (el) el.checked = true;
      }
    }

    // --- ペット ---
    // 「ペット相談」「ペット可」「ペット相談可」「ペット対応」「猫可」「猫相談」
    // ペット不可は除外
    const petPositive = /ペット(相談|可|対応)|猫(可|相談)/.test(combined);
    const petNegative = /ペット不可|ペット\(不可\)/.test(combined);
    if (petPositive && !petNegative) {
      const el = document.getElementById('petKbnCd2'); // 相談
      if (el) {
        el.checked = true;
        // onclick="tokuchoToggle(this, '2705')" を発火
        el.click();
      }
    }

    // --- 楽器 ---
    // 「楽器相談」「楽器相談可」「楽器使用(可)」
    // 楽器不可・楽器使用(不可) は除外
    const gakkiPositive = /楽器(相談|可)|楽器使用\(可\)/.test(combined);
    const gakkiNegative = /楽器不可|楽器使用\(不可\)/.test(combined);
    if (gakkiPositive && !gakkiNegative) {
      const el = document.getElementById('gakkiKbnCd2'); // 相談
      if (el) {
        el.checked = true;
        // onclick="tokuchoToggle(this, '2711')" を発火
        el.click();
      }
    }

    // --- 事務所利用 ---
    // 「事務所使用可」「事務所(可)」→ 相談にする。不可はチェックしない
    const jimushoPositive = /事務所(使用可|利用可|\(可\))/.test(combined);
    const jimushoNegative = /事務所(使用不可|不可|\(不可\))/.test(combined);
    if (jimushoPositive && !jimushoNegative) {
      const el = document.getElementById('jimushoRiyoKbnCd2'); // 相談
      if (el) {
        el.checked = true;
        el.click();
      }
    }

    // --- ルームシェア ---
    // 「ルームシェア相談」「ルームシェア(可)」→ 相談にする。不可はチェックしない
    const rsPositive = /ルームシェア(相談|可|\(可\))/.test(combined);
    const rsNegative = /ルームシェア(不可|\(不可\))/.test(combined);
    if (rsPositive && !rsNegative) {
      const el = document.getElementById('roomShareKbnCd2'); // 相談
      if (el) {
        el.checked = true;
        el.click();
      }
    }

    // --- フリーレント ---
    const freeRent = String(data.free_rent || '');
    // facilitiesに「フリーレント」がある or free_rentフィールドに値がある（「無」「なし」以外）
    const hasFreeRent = /フリーレント/.test(facilities) ||
      (freeRent && !/^(無|なし|ー|-|0|)$/.test(freeRent.trim()));

    if (hasFreeRent) {
      // チェックボックスをON
      const cb = document.getElementById('freeRentFlg');
      if (cb && !cb.checked) {
        cb.checked = true;
        cb.click(); // onclickハンドラ発火
      }

      // 月数を抽出: 「該当2ヶ月」「1ヶ月間」「2ヶ月」「フリーレント1ヶ月」等
      let months = '';
      const monthMatch = (freeRent + ' ' + facilities).match(/(\d+)\s*[ヶケか]?\s*月/);
      if (monthMatch) {
        months = monthMatch[1];
      }

      if (months) {
        const input = document.getElementById('freeRentInput');
        if (input) input.value = months;
        // 「○ヶ月」ラジオ
        const kbnRadio = document.getElementById('freeRentKbnCd1');
        if (kbnRadio) kbnRadio.checked = true;
      }
    }

    console.log('[SUUMO自動入稿] 契約条件設定完了');
  }

  // ── 定期借家判定・期間/期限入力 ──
  function fillTeikiShakuya(data) {
    const leaseType = String(data.lease_type || '');
    const contractPeriod = String(data.contract_period || '');

    // 定期借家判定: lease_typeに「定期」を含む
    const isTeiki = /定期/.test(leaseType);

    if (!isTeiki) {
      // 普通借家（デフォルト）
      const normalRadio = document.getElementById('teikiShakuyaFlg0');
      if (normalRadio) normalRadio.checked = true;
      console.log('[SUUMO自動入稿] 普通借家');
      return;
    }

    // 定期借家をチェック + onchangeハンドラ (selectRentHouseFlg) を確実に発火
    const teikiRadio = document.getElementById('teikiShakuyaFlg1');
    if (teikiRadio) {
      teikiRadio.checked = true;
      // change イベントをディスパッチして onchange="selectRentHouseFlg(false);" を実行
      teikiRadio.dispatchEvent(new Event('change', { bubbles: true }));
      // インラインonchange属性を直接実行（保険）
      if (typeof teikiRadio.onchange === 'function') {
        try { teikiRadio.onchange({ target: teikiRadio, currentTarget: teikiRadio }); } catch (e) {}
      }
    }

    if (!contractPeriod) {
      console.log('[SUUMO自動入稿] 定期借家（期間情報なし）');
      return;
    }

    // --- 期限モード判定: 「YYYY年M月まで」「YYYY/MM/DDまで」「YYYY年M月D日まで」等 ---
    // パターン1: 「2027年3月まで」「2027年03月まで」「2027年3月31日まで」
    const deadlineMatch1 = contractPeriod.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    // パターン2: 「2027/03/31まで」「2027-03-31」
    const deadlineMatch2 = contractPeriod.match(/(\d{4})[\/\-](\d{1,2})/);

    // 「まで」を含む or 西暦4桁で始まる → 期限モード
    const hasDeadlineKeyword = /まで/.test(contractPeriod);
    const startsWithYear = /^\d{4}[年\/\-]/.test(contractPeriod);

    if ((hasDeadlineKeyword || startsWithYear) && (deadlineMatch1 || deadlineMatch2)) {
      // 期限モード（○年○月まで）
      const match = deadlineMatch1 || deadlineMatch2;
      const year = match[1];
      const month = match[2];

      // 「指定なし」→期間ラジオの切替は不要（期限は teikiShakuyaKbnCd0 = 指定なし のまま年月を入れる）
      // 実際には「期間」ラジオを選択して期限として入力
      const kbnRadio = document.getElementById('teikiShakuyaKbnCd1');
      if (kbnRadio) {
        kbnRadio.checked = true;
        kbnRadio.dispatchEvent(new Event('change', { bubbles: true }));
        if (typeof kbnRadio.onchange === 'function') {
          try { kbnRadio.onchange({ target: kbnRadio, currentTarget: kbnRadio }); } catch (e) {}
        }
      }

      // ForRentのname属性は文字通り '${bukkenInputForm.xxx}' （JSP ELが未展開）
      setInputByName('${bukkenInputForm.teikiShakuyaNen}', year);
      setInputByName('${bukkenInputForm.teikiShakuyaGetsu}', String(parseInt(month, 10)));

      console.log(`[SUUMO自動入稿] 定期借家（期限: ${year}年${month}月まで）`);
      return;
    }

    // --- 期間モード: 「2年」「3年6ヶ月」「2年間」「24ヶ月」等 ---
    let periodYear = 0;
    let periodMonth = 0;

    // 「N年Mヶ月」「N年M月」パターン
    const ymMatch = contractPeriod.match(/(\d+)\s*年\s*(\d+)\s*[ヶケか]?\s*月/);
    if (ymMatch) {
      periodYear = parseInt(ymMatch[1], 10);
      periodMonth = parseInt(ymMatch[2], 10);
    } else {
      // 「N年」パターン
      const yMatch = contractPeriod.match(/(\d+)\s*年/);
      if (yMatch) {
        periodYear = parseInt(yMatch[1], 10);
      }
      // 「Nヶ月」パターン（年なし）
      const mMatch = contractPeriod.match(/(\d+)\s*[ヶケか]?\s*月/);
      if (mMatch && !yMatch) {
        periodMonth = parseInt(mMatch[1], 10);
      }
    }

    if (periodYear > 0 || periodMonth > 0) {
      // 「期間」ラジオを選択 + onchangeハンドラ (selectRentHouseKbn) を確実に発火
      const kbnRadio = document.getElementById('teikiShakuyaKbnCd1');
      if (kbnRadio) {
        kbnRadio.checked = true;
        kbnRadio.dispatchEvent(new Event('change', { bubbles: true }));
        if (typeof kbnRadio.onchange === 'function') {
          try { kbnRadio.onchange({ target: kbnRadio, currentTarget: kbnRadio }); } catch (e) {}
        }
      }

      // 定期借家行（id="err44"の<tr>または#DTeisyaku div）から text inputを直接探す
      // name属性に ${...} を含むため、クラス/コンテキストで特定する方が確実
      const teisyakuDiv = document.getElementById('DTeisyaku');
      let yearEl = null, monthEl = null;
      if (teisyakuDiv) {
        const textInputs = teisyakuDiv.querySelectorAll('input[type="text"]');
        console.log('[SUUMO自動入稿] #DTeisyaku 内のtext input数:', textInputs.length);
        if (textInputs.length >= 2) {
          yearEl = textInputs[0];
          monthEl = textInputs[1];
        }
      }
      // フォールバック: kingakuLInput / kingakuSInput クラスから探す
      if (!yearEl || !monthEl) {
        const row = document.getElementById('teikiShakuyaKbnCd1')?.closest('tr');
        if (row) {
          const lInput = row.querySelector('input.kingakuLInput');
          const sInput = row.querySelector('input.kingakuSInput');
          if (!yearEl) yearEl = lInput;
          if (!monthEl) monthEl = sInput;
        }
      }

      console.log('[SUUMO自動入稿] year input:', yearEl, ' month input:', monthEl);

      if (yearEl) {
        yearEl.focus();
        yearEl.value = String(periodYear);
        yearEl.dispatchEvent(new Event('input', { bubbles: true }));
        yearEl.dispatchEvent(new Event('change', { bubbles: true }));
        yearEl.blur();
        console.log('[SUUMO自動入稿] 年入力後:', yearEl.value);
      } else {
        console.warn('[SUUMO自動入稿] 年入力要素が見つからない');
      }
      if (monthEl) {
        monthEl.focus();
        monthEl.value = String(periodMonth);
        monthEl.dispatchEvent(new Event('input', { bubbles: true }));
        monthEl.dispatchEvent(new Event('change', { bubbles: true }));
        monthEl.blur();
        console.log('[SUUMO自動入稿] 月入力後:', monthEl.value);
      } else {
        console.warn('[SUUMO自動入稿] 月入力要素が見つからない');
      }

      console.log(`[SUUMO自動入稿] 定期借家（期間: ${periodYear}年${periodMonth}ヶ月）`);
    } else {
      console.log(`[SUUMO自動入稿] 定期借家（期間パース失敗: "${contractPeriod}"）`);
    }
  }

  // ── 周辺環境ポップアップ → 保存ボタン ──
  async function waitAndClickShuhenButton() {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const btn = document.querySelector('#rakurakuShuhenKankyo');
        if (btn && !btn.disabled) {
          clearInterval(checkInterval);
          btn.click();
          // ポップアップ処理後、保存を試みる
          setTimeout(() => {
            clickSaveButton();
            resolve();
          }, 3000);
        }
      }, 500);

      // 30秒タイムアウト
      setTimeout(() => {
        clearInterval(checkInterval);
        clickSaveButton();
        resolve();
      }, 30000);
    });
  }

  function clickSaveButton() {
    // ForRentの登録フローは2段階:
    //   入力フォーム → 「確認画面へ」(#regButton2) → 確認画面 → 「登録」
    // まず「確認画面へ」を探し、なければ確認画面の登録ボタンを探す
    const confirmBtn = document.getElementById('regButton2');
    if (confirmBtn) {
      console.log('[SUUMO自動入稿] 「確認画面へ」をクリック');
      confirmBtn.click();
      return;
    }
    // 確認画面の登録ボタン（将来の全自動モード用）
    const registerBtn = document.querySelector('input[type="submit"][value*="登録"]') ||
                        document.querySelector('button[type="submit"]') ||
                        document.querySelector('#submitBtn');
    if (registerBtn) {
      console.log('[SUUMO自動入稿] 登録ボタンをクリック');
      registerBtn.click();
    } else {
      console.warn('[SUUMO自動入稿] 確認/登録ボタンが見つかりません');
    }
  }

  // ══════════════════════════════════════════════════════════
  //  ユーティリティ
  // ══════════════════════════════════════════════════════════

  function setInputById(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = sanitizeSuumoText(value) || '';
  }

  function setInputByIdWithEvents(id, value) {
    const el = document.getElementById(id);
    if (el) {
      el.focus();
      el.value = sanitizeSuumoText(value) || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    }
  }

  function setInputByName(name, value) {
    const el = document.querySelector('input[name="' + name + '"]');
    if (el) {
      el.value = sanitizeSuumoText(value) || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function setSelectByName(name, value) {
    const el = document.querySelector('select[name="' + name + '"]');
    if (el && value) {
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function setInputWithEvents(el, value) {
    el.focus();
    el.value = value || '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  function findOptionByText(select, text) {
    return Array.from(select.options).find(opt => opt.text.trim() === text);
  }

  function toHalfWidth(str) {
    return (str || '').replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/　/g, ' ');
  }

  /**
   * SUUMO禁止文字サニタイズ
   * 半角カタカナ→全角、半角記号→全角、環境依存文字→安全な表記に変換
   */
  function sanitizeSuumoText(str) {
    if (!str) return str;
    var s = str;

    // 1) 半角カタカナ → 全角カタカナ
    const hankakuMap = {
      'ｦ':'ヲ','ｧ':'ァ','ｨ':'ィ','ｩ':'ゥ','ｪ':'ェ','ｫ':'ォ','ｬ':'ャ','ｭ':'ュ','ｮ':'ョ','ｯ':'ッ',
      'ｰ':'ー','ｱ':'ア','ｲ':'イ','ｳ':'ウ','ｴ':'エ','ｵ':'オ','ｶ':'カ','ｷ':'キ','ｸ':'ク','ｹ':'ケ','ｺ':'コ',
      'ｻ':'サ','ｼ':'シ','ｽ':'ス','ｾ':'セ','ｿ':'ソ','ﾀ':'タ','ﾁ':'チ','ﾂ':'ツ','ﾃ':'テ','ﾄ':'ト',
      'ﾅ':'ナ','ﾆ':'ニ','ﾇ':'ヌ','ﾈ':'ネ','ﾉ':'ノ','ﾊ':'ハ','ﾋ':'ヒ','ﾌ':'フ','ﾍ':'ヘ','ﾎ':'ホ',
      'ﾏ':'マ','ﾐ':'ミ','ﾑ':'ム','ﾒ':'メ','ﾓ':'モ','ﾔ':'ヤ','ﾕ':'ユ','ﾖ':'ヨ',
      'ﾗ':'ラ','ﾘ':'リ','ﾙ':'ル','ﾚ':'レ','ﾛ':'ロ','ﾜ':'ワ','ﾝ':'ン',
      'ﾞ':'゛','ﾟ':'゜','｡':'。','｢':'「','｣':'」','､':'、','･':'・'
    };
    // 半角カタカナ濁点・半濁点の結合処理（ｶﾞ→ガ等）
    s = s.replace(/([ｳｶ-ｺｻ-ｿﾀ-ﾄﾊ-ﾎ])ﾞ/g, (_, ch) => {
      const base = hankakuMap[ch];
      if (!base) return ch + '゛';
      const code = base.charCodeAt(0);
      return String.fromCharCode(code + 1); // カ→ガ etc.
    });
    s = s.replace(/([ﾊ-ﾎ])ﾟ/g, (_, ch) => {
      const base = hankakuMap[ch];
      if (!base) return ch + '゜';
      const code = base.charCodeAt(0);
      return String.fromCharCode(code + 2); // ハ→パ etc.
    });
    s = s.replace(/[ｦ-ﾟ]/g, ch => hankakuMap[ch] || ch);

    // 2) 半角記号 → 全角記号
    // 金額の桁区切りカンマ（数字と数字の間のカンマ）は削除
    // 例: "2,500円" → "2500円"、"2,500,000" → "2500000"
    while (/(\d),(\d)/.test(s)) {
      s = s.replace(/(\d),(\d)/g, '$1$2');
    }
    // 残りのカンマ（文中の区切り等）は全角「、」に変換
    s = s.replace(/,/g, '、');

    // 半角ASCII記号→全角記号(SUUMOの禁止文字対策を広めにカバー)
    // 「-」はハイフンだが半角のままだと禁止扱いされる場合があるため「ー」(長音)に変換
    const symbolMap = {
      '!':'！','"':'”','#':'＃','$':'＄','%':'％','&':'＆','\'':'’',
      '(':'（',')':'）','*':'＊','+':'＋','-':'ー','.':'．','/':'／',
      ':':'：',';':'；','<':'＜','=':'＝','>':'＞','?':'？','@':'＠',
      '[':'［','\\':'＼',']':'］','^':'＾','_':'＿','`':'｀',
      '{':'｛','|':'｜','}':'｝','~':'〜'
    };
    s = s.replace(/[!"#$%&'()*+\-./:;<=>?@[\\\]^_`{|}~]/g, ch => symbolMap[ch] || ch);

    // 半角スペースは全角スペースに（文中の区切り用途の場合）
    // ただし英数字間のスペースは残す
    s = s.replace(/(?<=[^\x20-\x7E]) (?=[^\x20-\x7E])/g, '　');

    // 制御文字・不可視文字を除去(NULL, タブ除く改行以外、ZWS等)
    s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    // ゼロ幅スペース類も除去(名前コピペで紛れ込みがち)
    s = s.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '');

    // 3) 環境依存の距離単位 → 安全な表記
    s = s.replace(/㌖/g, 'キロリットル');
    s = s.replace(/㍍/g, 'メートル');
    s = s.replace(/㌔/g, 'キロ');
    s = s.replace(/㎞/g, 'km');
    s = s.replace(/㎡/g, 'm2');
    s = s.replace(/㎝/g, 'cm');
    s = s.replace(/㏄/g, 'cc');
    s = s.replace(/㍉/g, 'ミリ');

    // 4) ギリシャ文字・ロシア文字の見た目そっくり → ローマ字
    const lookalike = {
      'Α':'A','Β':'B','Ε':'E','Ζ':'Z','Η':'H','Ι':'I','Κ':'K','Μ':'M','Ν':'N',
      'Ο':'O','Ρ':'P','Τ':'T','Υ':'Y','Χ':'X',
      'α':'a','β':'b','ε':'e','ι':'i','κ':'k','μ':'m','ν':'n','ο':'o','ρ':'p','τ':'t','υ':'u','χ':'x',
      'А':'A','В':'B','С':'C','Е':'E','Н':'H','К':'K','М':'M','О':'O','Р':'P','Т':'T','Х':'X',
      'а':'a','с':'c','е':'e','о':'o','р':'p','х':'x'
    };
    s = s.replace(/[ΑΒΕΖΗΙΚΜΝΟΡΤΥΧαβειι κμνορτυχАВСЕНКМОРТХасеорх]/g, ch => lookalike[ch] || ch);

    // 5) 顔文字でよく使う特殊文字を除去/置換
    s = s.replace(/[ωдΩ℃℉†‡‰‱]/g, '');
    // 全角中黒点゜は残す（SUUMO許可）が半角゜は問題なし

    console.log('[SUUMO禁止文字] サニタイズ適用');
    return s;
  }

  function waitFor(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** 都道府県名からコードを返す */
  function getPrefCode(pref) {
    const prefMap = {
      '北海道': '01', '青森県': '02', '岩手県': '03', '宮城県': '04', '秋田県': '05',
      '山形県': '06', '福島県': '07', '茨城県': '08', '栃木県': '09', '群馬県': '10',
      '埼玉県': '11', '千葉県': '12', '東京都': '13', '神奈川県': '14',
      '新潟県': '15', '富山県': '16', '石川県': '17', '福井県': '18', '山梨県': '19',
      '長野県': '20', '岐阜県': '21', '静岡県': '22', '愛知県': '23', '三重県': '24',
      '滋賀県': '25', '京都府': '26', '大阪府': '27', '兵庫県': '28', '奈良県': '29',
      '和歌山県': '30', '鳥取県': '31', '島根県': '32', '岡山県': '33', '広島県': '34',
      '山口県': '35', '徳島県': '36', '香川県': '37', '愛媛県': '38', '高知県': '39',
      '福岡県': '40', '佐賀県': '41', '長崎県': '42', '熊本県': '43', '大分県': '44',
      '宮崎県': '45', '鹿児島県': '46', '沖縄県': '47'
    };
    return prefMap[pref] || '13';
  }

  // ══════════════════════════════════════════════════════════
  //  mainフレーム: 入稿キュー監視
  // ══════════════════════════════════════════════════════════

  let _suumoFillBusy = false;

/**
 * mainフレーム内でのキュー監視を初期化
 * ForRentは<frameset>構造のため、mainフレーム内で全て処理する
 */
function initMainFrameMonitor() {
  if (_monitorStarted) {
    console.log('[SUUMO自動入稿] 監視は既に開始済み');
    return;
  }
  _monitorStarted = true;
  console.log('[SUUMO自動入稿] mainフレーム監視を初期化（入稿モード）');

  // background.jsからのメッセージ受信
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SUUMO_NAVIGATE_NEW_REGISTRATION') {
      console.log('[SUUMO自動入稿] 新規物件登録へ遷移指示');
      clickNewRegistrationTab();
      sendResponse({ ok: true });
    }
  });

  // 5秒ごとにキューをチェック
  setInterval(checkFillQueue, 5000);
  // 初回チェック
  setTimeout(checkFillQueue, 2000);
}

/**
 * 「新規物件登録」タブリンクをクリック（mainフレーム内のナビ）
 */
function clickNewRegistrationTab() {
  // タグを問わず「新規物件登録」に該当する要素を探す
  // （responsive版は <a>/<button>/<li> 等、frameset版はtitle属性付き画像リンクの可能性）
  const candidates = document.querySelectorAll(
    'a, button, input[type="button"], input[type="submit"], input[type="image"], li, span, div'
  );
  for (const el of candidates) {
    const text = (el.textContent || '').trim();
    const val = (el.value || '').trim();
    const alt = (el.alt || '').trim();
    const title = (el.title || '').trim();
    const match = text === '新規物件登録' || val === '新規物件登録' || alt === '新規物件登録' || title === '新規物件登録';
    // textContent===でマッチしない場合の緩い判定（親の<a>等含むため短い要素に限定）
    const looseMatch = !match && text.length < 30 && text.includes('新規物件登録');
    if (match || looseMatch) {
      // クリック対象はできるだけ「本来クリックされる要素」にしたい
      // aタグかbutton/inputならそのまま、それ以外は内包する<a>/<button>があればそちらを優先
      let target = el;
      if (!['A', 'BUTTON', 'INPUT'].includes(el.tagName)) {
        const nested = el.querySelector('a, button, input[type="button"], input[type="submit"], input[type="image"]');
        if (nested) target = nested;
      }
      console.log('[SUUMO自動入稿] 「新規物件登録」をクリック (tag:' + target.tagName + ' id:' + (target.id || '(none)') + ')');
      target.click();
      return true;
    }
  }
  // ナビフレーム経由（parent.navi）— 旧frameset版対応
  try {
    const naviFrame = window.parent?.frames?.navi;
    if (naviFrame) {
      const naviLinks = naviFrame.document.querySelectorAll('a, button, input[type="image"]');
      for (const link of naviLinks) {
        const text = (link.textContent || '').trim();
        const title = (link.title || '').trim();
        const alt = (link.alt || '').trim();
        if (text.includes('新規物件登録') || title === '新規物件登録' || alt === '新規物件登録') {
          console.log('[SUUMO自動入稿] naviフレームの「新規物件登録」をクリック');
          link.click();
          return true;
        }
      }
    }
  } catch (e) { /* cross-origin */ }

  console.warn('[SUUMO自動入稿] 「新規物件登録」リンクが見つかりません');
  return false;
}

/**
 * 現在のmainフレームが新規物件登録フォームかどうか判定
 */
function isNewRegistrationPage() {
  // 物件名入力フィールドの存在で判定
  if (document.getElementById('bukkenNm')) return true;
  // 画像アップロード要素の存在で判定
  if (document.getElementById('gazoUploadInfo')) return true;
  // ページテキストで判定
  const pageText = document.body?.textContent || '';
  if (pageText.includes('新規物件登録') && pageText.includes('物件名')) return true;
  return false;
}

async function checkFillQueue() {
  if (_suumoFillBusy) return;

  // ① まずキューの有無だけをread-onlyで確認（PEEK）。書込はしないので race しない
  const data = await new Promise(resolve => {
    chrome.storage.local.get(['suumoFillQueue'], resolve);
  });

  const queue = data.suumoFillQueue || [];
  // デバッグ: キュー状態をDOMに書き出し
  if (document.body) {
    document.body.setAttribute('data-suumo-queue', JSON.stringify({ len: queue.length, first: queue[0]?.building || queue[0]?.propertyData?.building_name || 'none', ts: Date.now() }));
  }
  if (queue.length === 0) return;

  const peekItem = queue[0];
  console.log('[SUUMO自動入稿] キューに物件あり:', peekItem.building || peekItem.propertyData?.building_name);

  // ② 新規物件登録ページかチェック（未遷移ならPOPせず遷移だけして次の機会に再度チェック）
  if (!isNewRegistrationPage()) {
    console.log('[SUUMO自動入稿] 新規登録ページではない → 「新規物件登録」をクリック');
    clickNewRegistrationTab();
    return;
  }

  // ②-b フォームに既にデータが入っている場合は上書きしない
  // （禁止文字エラー等でページがリロードされた場合、前回入力したデータが残っている）
  const existingBukkenNm = document.getElementById('bukkenNm');
  if (existingBukkenNm && existingBukkenNm.value && existingBukkenNm.value.trim().length > 0) {
    console.log('[SUUMO自動入稿] フォームに既にデータあり（前回入力が未登録） → 上書きスキップ。物件名:', existingBukkenNm.value);
    return;
  }

  console.log('[SUUMO自動入稿] 新規登録フォーム（空）検出 → 入力開始');

  _suumoFillBusy = true;

  try {
    // ③ background経由で atomic に POP
    // （background側は mutex で直列化されているので、append との競合が起きない）
    const popResp = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'POP_FILL_QUEUE_HEAD' }, (r) => {
        if (chrome.runtime.lastError) {
          console.warn('[SUUMO自動入稿] POP応答エラー:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(r);
        }
      });
    });
    if (!popResp || !popResp.ok || !popResp.item) {
      // キューが空 or 競合でpopできなかった → 次ループで再挑戦
      console.log('[SUUMO自動入稿] POP失敗または空 → スキップ');
      _suumoFillBusy = false;
      return;
    }
    const item = popResp.item;

    const rawData = item.propertyData || item;
    // デバッグ: 正規化前のデータをDOMに書き出し
    if (document.body) {
      const rawKeys = Object.keys(rawData);
      const rawSample = {};
      for (const k of rawKeys) {
        const v = rawData[k];
        rawSample[k] = typeof v === 'string' ? v.substring(0, 100) : (typeof v === 'object' && v !== null ? (Array.isArray(v) ? `[${v.length}]` : '{...}') : v);
      }
      document.body.setAttribute('data-suumo-raw', JSON.stringify(rawSample));
    }
    const normalized = normalizePropertyData(rawData);
    // デバッグ: 正規化後のデータもDOMに書き出し
    if (document.body) {
      document.body.setAttribute('data-suumo-normalized', JSON.stringify({
        building: normalized.building, room: normalized.room, rent: normalized.rent,
        pref: normalized.pref, addr1: normalized.addr1, town: normalized.town,
        floorsAbove: normalized.floorsAbove, floorLocation: normalized.floorLocation,
        madoriRoomCount: normalized.madoriRoomCount, madoriType: normalized.madoriType,
        usageArea: normalized.usageArea, builtYear: normalized.builtYear,
        propertyType: normalized.propertyType, deposit: normalized.deposit,
        gratuity: normalized.gratuity, managementFee: normalized.managementFee,
        access: normalized.access?.length, structure: normalized.structure,
        features: (normalized.features || '').substring(0, 200),
        facilities: (normalized.facilities || '').substring(0, 100)
      }));
    }
    console.log('[SUUMO自動入稿] フォーム入力開始:', normalized.building || item.building || item.buildingName);

    // mainフレーム内で直接フォーム入力を実行
    await fillForrentForm(normalized, item.imageGenres || {}, item.featureIds || []);

    console.log('[SUUMO自動入稿] 入力完了');

    // 完了報告をbackground.jsに送信
    chrome.runtime.sendMessage({
      type: 'SUUMO_FILL_COMPLETE',
      data: {
        propertyKey: item.propertyKey || item.key || '',
        building: item.building || item.buildingName || '',
        room: item.room || item.roomNumber || '',
        success: true
      }
    });

  } catch (err) {
    console.error('[SUUMO自動入稿] エラー:', err);
    // エラー時もキューを復元しない（無限ループ防止）
    chrome.runtime.sendMessage({
      type: 'SUUMO_FILL_COMPLETE',
      data: {
        propertyKey: item.propertyKey || item.key || '',
        building: item.building || item.buildingName || '',
        room: item.room || item.roomNumber || '',
        success: false,
        error: err.message
      }
    });
    // エラー時のみ busy を解除（次回 checkFillQueue で再試行可能にする）
    _suumoFillBusy = false;
  }
  // 成功時は _suumoFillBusy = true のまま保持。
  // ユーザーが保存→ページリロード → content script再初期化でリセットされる。
  // これにより、保存前に次の物件で上書きされることを防ぐ。
}

})();
