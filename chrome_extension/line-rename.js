/**
 * line-rename.js — LINE公式アカウントマネージャーの表示名を自動で直す（content script）
 *
 * 狙い（2026-09-21）:
 *   トーク一覧に出るのはLINEのニックネーム（tatsuyuki / Amanda など）で、誰なのか分からない。
 *   こちらは顧客名を持っているので、開いたトークの表示名を自動で顧客名にする。
 *
 * ⚠️ 背番号（userId）では引けない。実測で確かめたこと:
 *   chat.line.biz が画面に出す userId は、webhook で飛んでくる userId とは別体系。
 *   同じ人でも値が違う（段 志漢さん: 画面 U047e5a39… / 本物 U000834c6…）。
 *   管理画面のAPI /api/v1/bots/{bot}/chats/{chat} の profile.userId まで画面のIDで、
 *   HTML・localStorage・sessionStorage・呼ばれたAPI 64件を全部読んでも本物は出てこない。
 *   → 鍵になるのは、画面に見えている文字そのもの ＝ LINEのニックネームだけ。
 *
 * 改名のしかた（2026-09-22 実測）:
 *   PUT /api/v1/bots/{botId}/chats/{chatId}/nickname   {"nickname":"..."}
 *   Cookie だけだと 403。CSRFトークンを付ける必要がある。
 *   ⚠️ トークンはページの中でしか読めない。拡張のbackgroundから叩いても通らない。
 *
 * ⚠️ トークは開かない。開くと既読が付き、要対応の状態も変わってしまう。
 *   一覧のAPIから chatId を取って、そのままPUTする。
 *
 * ⚠️ 手で直した名前を絶対に上書きしないこと。
 *   一度でも改名した人は nickname が入り、画面に出るのはそちらになる。
 *   対応表はニックネームで引くので、改名済みの人は自然に当たらなくなる。
 *
 * ⚠️ 顧客データを外に出さないこと。
 *   一覧の中身はこのページの中だけで扱う。拡張が外に送るのは
 *   「対応表をください」という問い合わせだけで、誰を見ているかは送らない。
 */

(function () {
  'use strict';

  console.log('[LINE表示名] content script loaded');

  var NAME_MAX = 20;            // 入力欄の上限（画面の 9/20 表示より）
  var SWEEP_EVERY_MS = 2 * 60 * 1000;   // 一覧を見直す間隔
  var PUT_GAP_MS = 1000;        // 1件ごとに空ける。LINE側のレート制限よけ
  var PUT_MAX_PER_SWEEP = 30;   // 1回で改名する上限
  var ID_RE = /^U[0-9a-f]{32}$/;

  var sweeping = false;
  var done = {};                // 同じトークを何度も叩かない

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function botId() {
    var seg = location.pathname.split('/').filter(Boolean);
    return (seg[0] && ID_RE.test(seg[0])) ? seg[0] : '';
  }

  /**
   * CSRFトークン。Cookie だけだと 403 になる。
   * 本家は Cookie の XSRF-TOKEN を X-XSRF-TOKEN ヘッダーに載せている（2026-09-22 採取）。
   */
  function csrfToken() {
    var names = ['XSRF-TOKEN', 'CSRF-TOKEN', 'csrfToken'];
    for (var i = 0; i < names.length; i++) {
      var m = document.cookie.match(new RegExp('(?:^|; )' + names[i] + '=([^;]*)'));
      if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    }
    return '';
  }

  // ページ本体（line-rename-page.js）が拾ったヘッダー。403の鍵はこちら。
  var pageHeaders = {};
  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data || ev.data.__lineRenameHeaders !== true) return;
    pageHeaders = ev.data.headers || {};
  });

  /** うまくいかないときの手がかり。⚠️ 値は出さない。名前だけ。 */
  function cookieNames() {
    try {
      return document.cookie.split(';').map(function (x) { return x.split('=')[0].trim(); })
        .filter(function (x) { return x; }).join(', ');
    } catch (e) { return '(読めません)'; }
  }

  /** LINEの表示名 → 顧客名 の対応表。background が短時間だけ持っている。 */
  function nameMap() {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: 'LINE_NAME_MAP' }, function (res) {
          if (chrome.runtime.lastError) {
            console.warn('[LINE表示名] 拡張に届きません: ' + chrome.runtime.lastError.message);
            resolve({}); return;
          }
          if (!res || !res.ok) console.warn('[LINE表示名] 対応表を取れません:', res && res.message);
          resolve((res && res.map) || {});
        });
      } catch (e) { resolve({}); }
    });
  }

  /**
   * トーク一覧を取る。
   * ⚠️ エンドポイントは決め打ちにしない。このページが実際に呼んだURLの中から
   *   一覧らしきものを拾う。LINE側が版を上げても追随できるように。
   */
  async function fetchChatList() {
    var bot = botId();
    if (!bot) return [];
    var called = [];
    try {
      called = performance.getEntriesByType('resource').map(function (e) { return e.name; })
        .filter(function (n) { return n.indexOf(location.origin + '/api/') === 0; })
        .filter(function (n) { return /\/chats(\?|$)/.test(n.split('#')[0]); });
    } catch (e) {}
    var urls = [];
    var seen = {};
    called.concat([
      location.origin + '/api/v2/bots/' + bot + '/chats?folderType=ALL&limit=100',
      location.origin + '/api/v1/bots/' + bot + '/chats?folderType=ALL&limit=100'
    ]).forEach(function (u) { if (!seen[u]) { seen[u] = true; urls.push(u); } });

    for (var i = 0; i < urls.length; i++) {
      try {
        var r = await fetch(urls[i], { credentials: 'include' });
        if (!r.ok) continue;
        var pairs = collectChats(await r.json());
        if (pairs.length) return pairs;
      } catch (e) {}
    }
    return [];
  }

  /**
   * 応答のどこに何が入っていても拾えるように、まるごと歩いて
   * 「32桁のID」と「画面に出ている名前」の組を集める。
   * 画面に出るのは nickname（改名済み）で、無ければ displayName。
   */
  function collectChats(json) {
    var out = [];
    var seen = {};
    (function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 6) return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }
      var id = '';
      ['chatId', 'userId', 'id', 'targetId'].forEach(function (k) {
        if (!id && typeof node[k] === 'string' && ID_RE.test(node[k])) id = node[k];
      });
      var nick = '', base = '';
      ['nickname', 'chatName'].forEach(function (k) {
        if (!nick && typeof node[k] === 'string') nick = node[k].trim();
      });
      ['displayName', 'name'].forEach(function (k) {
        if (!base && typeof node[k] === 'string') base = node[k].trim();
      });
      var shown = nick || base;
      if (id && shown && !seen[id]) {
        seen[id] = true;
        out.push({ chatId: id, shown: shown, renamed: !!(nick && base && nick !== base) });
      }
      for (var k2 in node) walk(node[k2], depth + 1);
    })(json, 0);
    return out;
  }

  /** 改名する。成功したら true。 */
  async function renameChat(chatId, nickname) {
    var bot = botId();
    if (!bot) return false;
    var headers = { 'Content-Type': 'application/json' };
    // ページが送っている値を最優先。Cookie は保険（今のLINEには入っていない）。
    var token = pageHeaders['x-xsrf-token'] || csrfToken();
    if (token) headers['X-XSRF-TOKEN'] = token;
    if (pageHeaders['x-oa-chat-client-version']) {
      headers['x-oa-chat-client-version'] = pageHeaders['x-oa-chat-client-version'];
    }
    try {
      var r = await fetch(location.origin + '/api/v1/bots/' + bot + '/chats/' + chatId + '/nickname', {
        method: 'PUT',
        credentials: 'include',
        headers: headers,
        body: JSON.stringify({ nickname: nickname })
      });
      if (r.ok) return true;
      // ⚠️ ここで止まったら x-oa-chat-client-version が要るのかもしれない。
      //   その場合はページ側で値を採る必要がある（content script からは本家の
      //   XHR を覗けないため）。
      console.warn('[LINE表示名] 改名できません: ' + r.status
        + '（送ったヘッダー: ' + Object.keys(headers).join(', ') + '）'
        + (token ? '' : ' Cookie名: ' + cookieNames()));
      return false;
    } catch (e) {
      console.warn('[LINE表示名] 改名の通信に失敗: ' + e.message);
      return false;
    }
  }

  /** 一覧を一巡して、対応表に当たった人だけ改名する。 */
  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      // ページがまだ1回もAPIを叩いていないとトークンが無い。次の巡回に回す。
      if (!pageHeaders['x-xsrf-token'] && !csrfToken()) {
        console.log('[LINE表示名] トークンがまだ取れていません。次の巡回で試します');
        return;
      }
      var map = await nameMap();
      if (!Object.keys(map).length) return;
      var chats = await fetchChatList();
      if (!chats.length) { console.warn('[LINE表示名] トーク一覧を取れませんでした'); return; }

      // ⚠️ 一覧の中で同じ表示名が2つ以上あったら、その名前は全部見送る。
      //   どちらが本人か分からないまま実名を付けると、別のお客様のトークに
      //   他人の名前が載る。しかも一度付くと「改名済み」として二度と直らない。
      //   （対応表の側の重複はGASが落としているが、こちらは友だち全員が対象なので別途要る）
      var shownCount = {};
      for (var s0 = 0; s0 < chats.length; s0++) {
        shownCount[chats[s0].shown] = (shownCount[chats[s0].shown] || 0) + 1;
      }
      var warned = {};

      var todo = [];
      for (var i = 0; i < chats.length; i++) {
        var c = chats[i];
        if (done[c.chatId]) continue;
        if (shownCount[c.shown] > 1) {
          if (map[c.shown] && !warned[c.shown]) {
            warned[c.shown] = true;
            console.warn('[LINE表示名] 表示名が重複のためスキップ: ' + c.shown
              + '（' + shownCount[c.shown] + '件）手で付けてください');
          }
          done[c.chatId] = '表示名が重複';
          continue;
        }
        // ⚠️ 手で付けた名前は触らない。改名済みの人は対応表にも当たらないが、念のため。
        if (c.renamed) { done[c.chatId] = '改名済み'; continue; }
        var want = map[c.shown];
        if (!want) continue;
        want = String(want).replace(/\s+/g, ' ').trim();
        if (want.length > NAME_MAX) want = want.substring(0, NAME_MAX);
        if (!want || want === c.shown) { done[c.chatId] = 'そのまま'; continue; }
        todo.push({ chatId: c.chatId, from: c.shown, to: want });
      }
      if (!todo.length) return;

      console.log('[LINE表示名] ' + todo.length + '人を改名します');
      var n = Math.min(todo.length, PUT_MAX_PER_SWEEP);
      for (var t = 0; t < n; t++) {
        var ok = await renameChat(todo[t].chatId, todo[t].to);
        done[todo[t].chatId] = ok ? ('変更: ' + todo[t].to) : '';
        if (ok) console.log('[LINE表示名] ' + todo[t].from + ' → ' + todo[t].to);
        else break;                       // 403 などが出たら打ち切る。連打しない
        if (t < n - 1) await sleep(PUT_GAP_MS);
      }
    } catch (e) {
      console.warn('[LINE表示名] 一巡に失敗: ' + e.message);
    } finally {
      sweeping = false;
    }
  }

  // 読み込み直後に1回、あとは定期的に一覧を見直す。
  // メアドを送ってきた人は一覧の一番上に来るので、これだけで数分以内に名前が付く。
  setTimeout(sweep, 3000);
  setInterval(sweep, SWEEP_EVERY_MS);
})();
