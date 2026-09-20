/**
 * vacancy-check-trigger.js — 顧客管理ページ → 拡張ブリッジ（content script）
 *
 * 顧客管理ページ(CustomerPage.html)で「空室確認してから送る」が押され、
 * GASへの依頼登録が成功すると、ページ内JSが
 *   window.postMessage({ type: 'VACANCY_CHECK_REQUESTED' }, '*')
 * を送る。これを受けて background に伝え、その場で空室確認を始めさせる。
 *
 * なぜ要るか（2026-09-20）:
 *   依頼はGASのシートに印を付けるだけなので、拡張は1分ごとのポーリングまで気づかない。
 *   担当者は画面の前で待っているので、その1分が体感でかなり長い。
 *   押した瞬間に伝えれば待ち時間がゼロになる。
 *   （自動再送のほうは急がないので、今までどおりポーリングで拾えばよい）
 *
 * 作りは suumo-approval-trigger.js と同じ。GASの画面はGoogleのiframeで描画されるため
 * manifest では all_frames: true にしてある。
 */

(function () {
  'use strict';

  // 読み込み確認ログ（このスクリプトが実際にそのフレームで走っているかの確認用）。
  // GASの画面はGoogleのiframeで描画されるので、どのフレームに入ったかも出す。
  console.log('[空室確認トリガー] content script loaded, url=' + location.href);

  // 連打・iframe二重読み込みでの多重送信を抑える
  var _lastSentAt = 0;

  window.addEventListener('message', function (ev) {
    try {
      var d = ev && ev.data;
      if (!d || d.type !== 'VACANCY_CHECK_REQUESTED') return;

      // 5秒以内の再送は無視（同じ押下が複数フレームから届くことがある）
      var now = Date.now();
      if (now - _lastSentAt < 5000) return;
      _lastSentAt = now;

      console.log('[空室確認トリガー] 依頼を検知 → backgroundへ');
      chrome.runtime.sendMessage({ type: 'VACANCY_CHECK_NOW' }, function () {
        if (chrome.runtime.lastError) {
          // 拡張が止まっている等。ポーリングが拾うので致命的ではない。
          console.warn('[空室確認トリガー] 送信できず: ' + chrome.runtime.lastError.message);
        }
      });
    } catch (e) {
      console.warn('[空室確認トリガー] 失敗: ' + e.message);
    }
  }, false);
})();
