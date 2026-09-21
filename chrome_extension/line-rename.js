/**
 * line-rename.js — LINE公式アカウントマネージャーの表示名を自動で直す（content script）
 *
 * 狙い（2026-09-21）:
 *   トーク一覧に出るのはLINEのニックネーム（tatsuyuki / Amanda など）で、誰なのか分からない。
 *   こちらは userId と顧客名を持っているので、開いたトークの表示名を自動で顧客名にする。
 *
 * ⚠️ LINEのAPIには表示名を変える口が無い。これは画面の「表示名を変更」モーダルを
 *   コードから操作している。つまりLINE側の画面が変わると動かなくなる。
 *   止まっても「改名されないだけ」で壊れるものは無いので、気づいたら直せばよい。
 *
 * ⚠️ 手で直した名前を絶対に上書きしないこと。
 *   モーダルには「友だちが設定した名前」が出ている。今の表示名がそれと同じなら未改名、
 *   違えば担当者が手で直したもの。違うときは何もせずキャンセルする。
 *
 * 画面の作り（2026-09-21 実測。IDもdata-testidも無く、構造とBootstrapのクラスだけ）:
 *   鉛筆      #content-thirdly h3 a
 *   表示名    #content-thirdly h3 span
 *   モーダル  .modal-content
 *   元の名前  .modal-body .mb-3 span
 *   入力欄    .modal-content input.form-control（20文字まで）
 *   保存      .modal-footer .btn-primary
 *   キャンセル .modal-footer .btn-secondary
 */

(function () {
  'use strict';

  console.log('[LINE表示名] content script loaded');

  var NAME_MAX = 20;          // 入力欄の上限（画面の 9/20 表示より）
  var handled = {};           // 同じ人を何度も処理しない
  var lastUrl = '';
  var busy = false;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** URLから相手の userId を取る。/chat/U... の形。 */
  function currentUserId() {
    var m = location.pathname.match(/\/chat\/(U[0-9a-f]{32})/i);
    return m ? m[1] : '';
  }

  function panelNameEl() { return document.querySelector('#content-thirdly h3 span'); }
  function pencilEl() { return document.querySelector('#content-thirdly h3 a'); }

  /** Reactの入力欄に値を入れる。value を直接代入しても React が気づかないため。 */
  function setReactValue(input, value) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** 要素が出てくるまで待つ。出なければ null。 */
  async function waitFor(sel, ms) {
    var until = Date.now() + (ms || 3000);
    while (Date.now() < until) {
      var el = document.querySelector(sel);
      if (el) return el;
      await sleep(100);
    }
    return null;
  }

  async function lookupName(userId) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: 'LINE_LOOKUP_NAME', userId: userId }, function (res) {
          if (chrome.runtime.lastError) { resolve(''); return; }
          resolve((res && res.name) ? String(res.name) : '');
        });
      } catch (e) { resolve(''); }
    });
  }

  async function tryRename(userId) {
    if (busy || handled[userId]) return;
    busy = true;
    try {
      console.log('[LINE表示名] 開いた相手: ' + userId);
      var nameEl = await waitFor('#content-thirdly h3 span', 5000);
      if (!nameEl) {
        // ⚠️ プロフィールパネルが見つからない。LINE側の作りが変わった可能性。
        console.warn('[LINE表示名] 表示名の要素が見つかりません（#content-thirdly h3 span）。'
          + ' h3の数=' + document.querySelectorAll('h3').length
          + ' / #content-thirdly=' + (document.querySelector('#content-thirdly') ? 'あり' : 'なし'));
        return;
      }
      var shown = (nameEl.textContent || '').trim();
      console.log('[LINE表示名] 今の表示名: ' + shown);

      var want = await lookupName(userId);
      if (!want) {
        console.log('[LINE表示名] LINE Users に見つかりません。何もしません: ' + userId);
        handled[userId] = 'お客様が見つからない'; return;
      }
      console.log('[LINE表示名] 顧客名: ' + want);
      want = want.replace(/\s+/g, ' ').trim();
      if (want.length > NAME_MAX) want = want.substring(0, NAME_MAX);
      if (shown === want) { console.log('[LINE表示名] すでにその名前です'); handled[userId] = 'すでにその名前'; return; }

      var pencil = pencilEl();
      if (!pencil) { console.warn('[LINE表示名] 鉛筆が見つかりません（#content-thirdly h3 a）'); handled[userId] = '鉛筆が見つからない'; return; }
      pencil.click();

      var input = await waitFor('.modal-content input.form-control', 3000);
      if (!input) { console.warn('[LINE表示名] モーダルが出ません（.modal-content input.form-control）'); handled[userId] = 'モーダルが出ない'; return; }

      // ⚠️ 手で直した名前は上書きしない。
      //   「友だちが設定した名前」＝LINEのニックネーム。今の表示名がそれと違えば、
      //   担当者が意図して付けた名前なので触らない。
      var origEl = document.querySelector('.modal-body .mb-3 span');
      var original = origEl ? (origEl.textContent || '').trim() : '';
      if (original && shown && original !== shown) {
        var cancel = document.querySelector('.modal-footer .btn-secondary');
        if (cancel) cancel.click();
        handled[userId] = '手で直した名前なので触らない';
        console.log('[LINE表示名] 手で直した名前のため変更しません: ' + shown);
        return;
      }

      setReactValue(input, want);
      await sleep(150);
      var save = document.querySelector('.modal-footer .btn-primary');
      if (!save || save.disabled) {
        var cancel2 = document.querySelector('.modal-footer .btn-secondary');
        if (cancel2) cancel2.click();
        console.warn('[LINE表示名] 保存ボタンが押せません');
        handled[userId] = '保存ボタンが押せない';
        return;
      }
      save.click();
      handled[userId] = '変更: ' + want;
      console.log('[LINE表示名] ' + shown + ' → ' + want);
    } catch (e) {
      console.warn('[LINE表示名] 失敗: ' + e.message);
    } finally {
      busy = false;
    }
  }

  // SPAなのでURLの変化を見張る。トークを切り替えるたびに走らせる。
  setInterval(function () {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    var uid = currentUserId();
    if (uid) setTimeout(function () { tryRename(uid); }, 1200);   // 描画を待つ
  }, 500);
})();
