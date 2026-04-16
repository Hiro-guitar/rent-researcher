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

  var _alreadyFired = new Set();

  function fireApprovalTrigger(propertyKey, building, room) {
    if (!propertyKey) return;
    if (_alreadyFired.has(propertyKey)) return;
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
    if (!data || data.type !== 'SUUMO_APPROVAL_SUCCESS') return;
    fireApprovalTrigger(data.propertyKey, data.building, data.room);
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
