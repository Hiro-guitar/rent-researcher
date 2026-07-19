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
 *
 * 経緯 (2026-07-19):
 *   検索遷移 (history.pushState による SPA 内遷移) はドキュメントを切り替えない
 *   ため AudioContext は生き続けるはずだが、実機で「検索条件が入ると ~60秒で
 *   スピーカーが消える」事象。gain 0.001→0.003 と追ってきたが、Chrome の可聴
 *   判定閾値を下回っていた疑いが濃厚。対策として:
 *     (A) 周波数を 440Hz→18000Hz(準超音波)に上げ gain を 0.02 に引き上げる。
 *         高周波なので gain を上げても大半の成人には聞こえないが、Chrome の
 *         音量判定(周波数非依存の RMS)は確実に通す。
 *     (B) statechange イベントで suspended 落ちを即 resume(throttling された
 *         タイマー待ちにしない=最大60秒復帰しない鶏卵問題を回避)。
 *     (C) 診断を「状態変化ごと」に記録し running↔suspended の遷移を可視化。
 */
(() => {
  'use strict';

  // 重複注入防止
  if (window.__essquareKeepaliveLoaded) return;
  window.__essquareKeepaliveLoaded = true;

  // --- 無音トーンのパラメータ ---
  // 18000Hz は大半の成人 (特に30代以降) の可聴域上限を超えるため、gain を
  // 上げても実際にはほぼ聞こえない。一方 Chrome のタブ audible 判定は
  // レンダバッファの RMS パワー (周波数非依存) を見るため、高周波でも
  // 十分なパワーがあれば audible になる。
  // ※ もし faint な高音ノイズが聞こえるとの報告があれば FREQ をさらに上げる
  //    (19000〜19500) か GAIN を下げる。
  const TONE_FREQ = 18000;
  const TONE_GAIN = 0.02;

  // ダッシュボードログに転送 (タブを開かずに状態確認するため)
  function diagToBg(msg) {
    try { console.log('[ES-Square keepalive]', msg); } catch (e) {}
    try {
      chrome.runtime.sendMessage({ type: 'DEBUG_LOG', message: '[ES-Square keepalive] ' + msg }, () => {
        if (chrome.runtime.lastError) {} // 無視
      });
    } catch (e) {}
  }

  // 状態変化ごとにダッシュボードに記録 (running↔suspended の遷移を可視化)。
  // 同一状態の連投は抑制する。
  var __lastDiagState = null;
  function __essqDiag(state) {
    if (state === __lastDiagState) return;
    __lastDiagState = state;
    diagToBg('AudioContext ' + state);
  }

  // Web Audio API (AudioContext + OscillatorNode) で無音を生成
  // dataURL <audio> はESQuareのCSP `media-src` 制限でブロックされるため、
  // src 不要の AudioContext を使用。
  var __statechangeBound = false;

  // 無音オシレータを起動/維持する。document_start の早いタイミングや裏タブ・ナビ直後で
  // suspended になったり Chrome に止められることがあるため、ウォッチドッグから繰り返し
  // 呼んで「running な AudioContext + オシレータ」を維持し続ける（＝タブを audible に保つ）。
  function startSilentAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { __essqDiag('API なし'); return; }
      let ctx = window.__essquareAudioCtx;
      // コンテキストが無い or 閉じられていたら作り直す
      if (!ctx || ctx.state === 'closed') {
        ctx = new Ctx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = TONE_FREQ;
        gain.gain.value = TONE_GAIN;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        window.__essquareAudioCtx = ctx;
        __statechangeBound = false;
      }
      // (B) suspended に落ちた瞬間にイベント駆動で即 resume。
      //     throttling されたウォッチドッグを待たない。
      if (!__statechangeBound) {
        __statechangeBound = true;
        ctx.addEventListener('statechange', () => {
          __essqDiag('statechange→' + ctx.state);
          if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
          }
        });
      }
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => {
          __essqDiag('起動 state=' + ctx.state);
        }).catch(() => {
          // user gesture フォールバック（許可済みなら通常不要）
          const tryResume = () => { try { ctx.resume(); } catch (e) {} };
          ['click', 'keydown', 'touchstart', 'pointerdown'].forEach((ev) =>
            document.addEventListener(ev, tryResume, { capture: true, passive: true, once: true }));
        });
      } else if (ctx.state === 'running') {
        __essqDiag('起動 state=running');
      }
    } catch (e) {
      __essqDiag('init失敗: ' + (e && e.message || '?'));
    }
  }

  startSilentAudio();
  // ウォッチドッグ: 止められても復活させる。running な間はタブが audible でタイマーは
  // 間引かれないので実質毎3秒。万一 suspended に落ちても statechange 即 resume が
  // 一次防衛、これは二次の保険。
  setInterval(startSilentAudio, 3000);
  // タブ表示状態が変わった時も即再確認（裏→表 等）
  document.addEventListener('visibilitychange', startSilentAudio, true);

  // 【診断・一時】throttling検出プローブ。
  // 100ms interval が3秒間に何回発火したかを数える。裏タブ(hidden)のとき:
  //   フラグ無し → Chrome が 100ms を 1000ms にクランプ → 約3回/3秒
  //   --disable-background-timer-throttling 有効 → クランプ解除 → 約30回/3秒
  // 前回 hidden ガードで1件も出なかったので、無条件ログ＋起動時1回＋visibility併記。
  // 原因確定後に撤去。
  diagToBg('throttleProbe起動 vis=' + document.visibilityState);
  (function throttleProbe() {
    let ticks = 0;
    setInterval(function () { ticks++; }, 100); // 理論上3秒で30回
    setInterval(function () {
      diagToBg('throttle計測: 直近3秒で ' + ticks + '回 vis=' + document.visibilityState + ' (hidden&~3=throttled / ~30=解除)');
      ticks = 0;
    }, 3000);
  })();
})();
