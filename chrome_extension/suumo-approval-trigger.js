/**
 * suumo-approval-trigger.js — SUUMO承認ページ → 拡張ブリッジ（content script）
 *
 * GAS承認ページ(SuumoApprovalPage.html)で「承認して入稿」ボタンが押下され
 * 承認が成功すると、ページ内JSが window.postMessage({type:'SUUMO_APPROVAL_SUCCESS'}, '*') を送信する。
 *
 * このcontent scriptはそれを受けて background.js に `SUUMO_APPROVED_NOW` を送信し、
 * 即座に新規タブでForRent自動入稿プロセスを開始させる。
 *
 * フォールバック: MutationObserverで data-suumo-approved-key 属性の変化も監視
 * （ページ側のpostMessageが万一失敗した場合に備える）
 *
 * manifest.json content_scripts:
 *   matches: ["https://script.google.com/macros/*", "https://script.googleusercontent.com/*"]
 *   all_frames: true （GAS承認ページはGoogleのiframeで描画されるため）
 */

(function () {
  'use strict';

  // ロード確認ログ(content scriptが実際にページで走っているかの確認)
  console.log('[SUUMO承認トリガー] content script loaded, url=' + location.href);

  var _alreadyFired = new Set();

  function fireApprovalTrigger(propertyKey, building, room) {
    if (!propertyKey) {
      console.warn('[SUUMO承認トリガー] propertyKey空でスキップ');
      return;
    }
    if (_alreadyFired.has(propertyKey)) {
      console.log('[SUUMO承認トリガー] 既に送信済み:', propertyKey);
      return;
    }
    _alreadyFired.add(propertyKey);

    console.log('[SUUMO承認トリガー] 承認検知 → background通知:', propertyKey, building, room);
    try {
      chrome.runtime.sendMessage({
        type: 'SUUMO_APPROVED_NOW',
        propertyKey: propertyKey,
        building: building || '',
        room: room || ''
      }, function (resp) {
        if (chrome.runtime.lastError) {
          console.warn('[SUUMO承認トリガー] background応答エラー:', chrome.runtime.lastError.message);
        } else {
          console.log('[SUUMO承認トリガー] background応答:', resp);
        }
      });
    } catch (e) {
      console.warn('[SUUMO承認トリガー] sendMessage失敗:', e);
    }
  }

  // ── 主経路: window.postMessage を受信 ──
  window.addEventListener('message', function (event) {
    var data = event.data;
    // 全postMessage を一旦ログ(デバッグ用)
    if (data && data.type) {
      console.log('[SUUMO承認トリガー] postMessage受信:', data.type);
    }
    if (!data) return;

    if (data.type === 'SUUMO_APPROVAL_SUCCESS') {
      console.log('[SUUMO承認トリガー] SUUMO_APPROVAL_SUCCESS検知:', data);
      fireApprovalTrigger(data.propertyKey, data.building, data.room);
      return;
    }

    // ホームズ画像検索リクエストを background に転送
    // GAS HTMLは sandbox iframe で動くため content script が直接注入できない場合がある
    // GAS HTML側からは parent.postMessage で送られてくるので、親frameで受けて
    // 結果は event.source.postMessage で子iframeに返送する
    if (data.type === 'HOMES_IMAGE_SEARCH_REQUEST') {
      console.log('[SUUMO承認トリガー] HOMES_IMAGE_SEARCH_REQUEST受信:', data.requestId);
      var sourceWin = event.source || window;
      try {
        chrome.runtime.sendMessage(
          { type: 'HOMES_IMAGE_SEARCH', input: data.input },
          function (result) {
            var err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
            try {
              sourceWin.postMessage({
                type: 'HOMES_IMAGE_SEARCH_RESPONSE',
                requestId: data.requestId,
                result: err ? { ok: false, errors: [err], candidates: [] } : result
              }, '*');
            } catch (e2) {
              console.warn('[SUUMO承認トリガー] response送信失敗:', e2);
            }
          }
        );
      } catch (e) {
        try {
          sourceWin.postMessage({
            type: 'HOMES_IMAGE_SEARCH_RESPONSE',
            requestId: data.requestId,
            result: { ok: false, errors: ['sendMessage例外: ' + e.message], candidates: [] }
          }, '*');
        } catch (_) {}
      }
    }

    // ローカル画像アップロード要求(GAS sandbox iframe からは外部fetchがCSPでブロックされるため
    // 拡張のbackground経由でアップロードする)
    if (data.type === 'UPLOAD_IMAGE_REQUEST') {
      console.log('[SUUMO承認トリガー] UPLOAD_IMAGE_REQUEST受信:', data.requestId, data.filename);
      var srcWin = event.source || window;
      try {
        chrome.runtime.sendMessage(
          {
            type: 'UPLOAD_IMAGE_FROM_GAS',
            base64: data.base64,
            mimeType: data.mimeType,
            filename: data.filename
          },
          function (result) {
            var err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
            try {
              srcWin.postMessage({
                type: 'UPLOAD_IMAGE_RESPONSE',
                requestId: data.requestId,
                result: err ? { ok: false, error: err } : (result || { ok: false, error: 'no result' })
              }, '*');
            } catch (e3) {
              console.warn('[SUUMO承認トリガー] UPLOAD response送信失敗:', e3);
            }
          }
        );
      } catch (e) {
        try {
          srcWin.postMessage({
            type: 'UPLOAD_IMAGE_RESPONSE',
            requestId: data.requestId,
            result: { ok: false, error: 'sendMessage例外: ' + e.message }
          }, '*');
        } catch (_) {}
      }
    }

    // 画像90度回転要求 (承認ページから拡張へブリッジ)
    if (data.type === 'ROTATE_IMAGE_REQUEST') {
      console.log('[SUUMO承認トリガー] ROTATE_IMAGE_REQUEST受信:', data.requestId, data.degrees);
      var srcWin = event.source || window;
      try {
        chrome.runtime.sendMessage(
          {
            type: 'ROTATE_IMAGE_REQUEST',
            url: data.url,
            degrees: data.degrees
          },
          function (result) {
            var err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
            try {
              srcWin.postMessage({
                type: 'ROTATE_IMAGE_RESPONSE',
                requestId: data.requestId,
                result: err ? { ok: false, error: err } : (result || { ok: false, error: 'no result' })
              }, '*');
            } catch (e3) {
              console.warn('[SUUMO承認トリガー] ROTATE response送信失敗:', e3);
            }
          }
        );
      } catch (e) {
        try {
          srcWin.postMessage({
            type: 'ROTATE_IMAGE_RESPONSE',
            requestId: data.requestId,
            result: { ok: false, error: 'sendMessage例外: ' + e.message }
          }, '*');
        } catch (_) {}
      }
    }
  });

  // ── フォールバック: data-suumo-approved-key 属性の変化を監視 ──
  function startMarkerObserver() {
    if (!document.body) {
      setTimeout(startMarkerObserver, 200);
      return;
    }
    var observer = new MutationObserver(function () {
      var key = document.body.getAttribute('data-suumo-approved-key');
      if (key) fireApprovalTrigger(key, '', '');
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-suumo-approved-key']
    });
  }
  startMarkerObserver();
})();
