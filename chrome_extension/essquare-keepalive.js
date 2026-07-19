/**
 * essquare-keepalive.js
 * ES-Square のすべてのページ (検索結果/詳細) に注入される軽量 content script。
 *
 * 目的: バックグラウンドタブの throttling 回避のため、無音 audio を再生して
 *       タブを audible 状態に維持する。
 *
 * 経緯 (2026-05-05):
 *   essquare-content-detail.js は物件詳細ページにしか注入されないため、
 *   検索結果ページの広告可チェック (100件 tooltip ホバー) で throttling 直撃。
 *   keepalive はすべての ES-Square ページに注入されて audio を起動する。
 */
(() => {
  'use strict';

  // 重複注入防止
  if (window.__essquareKeepaliveLoaded) return;
  window.__essquareKeepaliveLoaded = true;

  // ダッシュボードログに転送 (タブを開かずに状態確認するため)
  function diagToBg(msg) {
    try { console.log('[ES-Square keepalive]', msg); } catch (e) {}
    try {
      chrome.runtime.sendMessage({ type: 'DEBUG_LOG', message: '[ES-Square keepalive] ' + msg }, () => {
        if (chrome.runtime.lastError) {} // 無視
      });
    } catch (e) {}
  }

  // Web Audio API (AudioContext + OscillatorNode) で無音を生成
  // dataURL <audio> はESQuareのCSP `media-src` 制限でブロックされるため、
  // src 不要の AudioContext を使用。
  // 起動状態を一度だけダッシュボードに通知するためのフラグ
  var __essqDiagOnce = false;
  function __essqDiag(msg) {
    if (__essqDiagOnce) return;
    __essqDiagOnce = true;
    diagToBg(msg);
  }

  // 無音オシレータを起動/維持する。document_start の早いタイミングや裏タブ・ナビ直後で
  // suspended になったり Chrome に止められることがあるため、ウォッチドッグから繰り返し
  // 呼んで「running な AudioContext + オシレータ」を維持し続ける（＝タブを audible に保つ）。
  function startSilentAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { __essqDiag('AudioContext API なし'); return; }
      let ctx = window.__essquareAudioCtx;
      // コンテキストが無い or 閉じられていたら作り直す
      if (!ctx || ctx.state === 'closed') {
        ctx = new Ctx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        // 人間の可聴域(440Hz)で gain 極小 → 聴感上ほぼ無音だが Chrome の audible 判定は通る。
        // Chrome 150 で 0.001 だと「実質無音」と判定され audible が外れる(スピーカーが一瞬で消える)
        // 事象があったため 0.003 に引き上げ(それでも -50dB 相当でごく小さい)。
        osc.frequency.value = 440;
        gain.gain.value = 0.003;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        window.__essquareAudioCtx = ctx;
      }
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => {
          __essqDiag('AudioContext起動 state=' + ctx.state);
        }).catch(() => {
          // user gesture フォールバック（許可済みなら通常不要）
          const tryResume = () => { try { ctx.resume(); } catch (e) {} };
          ['click', 'keydown', 'touchstart', 'pointerdown'].forEach((ev) =>
            document.addEventListener(ev, tryResume, { capture: true, passive: true, once: true }));
        });
      } else if (ctx.state === 'running') {
        __essqDiag('AudioContext起動 state=running');
      }
    } catch (e) {
      __essqDiag('AudioContext init失敗: ' + (e && e.message || '?'));
    }
  }

  startSilentAudio();
  // ウォッチドッグ: 止められても復活させる。running な間はタブが audible でタイマーは
  // 間引かれないので実質毎3秒。万一 suspended に落ちても次tickで resume する。
  setInterval(startSilentAudio, 3000);
  // タブ表示状態が変わった時も即再確認（裏→表 等）
  document.addEventListener('visibilitychange', startSilentAudio, true);
})();
