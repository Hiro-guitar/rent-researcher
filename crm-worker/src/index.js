// ehomaki CRM（Cloudflare Worker）
// 本物はスプレッドシート。ここ（D1）は写し。GAS が /sync で送ってくる。画面は /api/sheets で写しを受け取り、ブラウザで組み立てる。
// ⚠️ 無料の Workers は 1 回の CPU が 10ms まで。大きな JSON を組み立て直さない（D1 の文字列をつなぐだけにする）。

const enc = new TextEncoder();
async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', enc.encode(String(s)));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const json = (o, status = 200, headers = {}) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const cfg = async (env, k) => (await env.DB.prepare('SELECT v FROM config WHERE k = ?').bind(k).first())?.v || '';
const setCfg = (env, k, v) => env.DB.prepare('INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v));

function cookieOf(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
async function isViewer(req, env) {
  const key = cookieOf(req, 'crm_key');
  if (!key) return false;
  return (await sha256(key)) === (await cfg(env, 'key_hash'));
}
async function isSync(req, env) {
  const t = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!t) return false;
  return (await sha256(t)) === (await cfg(env, 'sync_hash'));
}

// ── 保存の受け付け（outbox）2026-10-25 ──
// 画面の保存は受け付けた時点で「済み」を返す。GAS（スプレッドシート）へは、ここで古い順に1件ずつ書く。
// ⚠️ 順番を守ること（後の保存が先の保存を上書きしないように）。同時に2つ動かないよう config の outbox_lock で1本にする
async function gasCrmCall(env, key, body) {
  const r1 = await fetch(env.GAS_URL + '?action=crm_call&key=' + encodeURIComponent(key), {
    method: 'POST', body, headers: { 'content-type': 'text/plain' }, redirect: 'manual',
  });
  const loc = r1.headers.get('location');
  const r = loc ? await fetch(loc) : r1;
  return { status: r.status, text: await r.text() };
}
async function outboxErr(env, row, msg) {
  let list = [];
  try { list = JSON.parse((await cfg(env, 'outbox_err')) || '[]'); } catch (e) {}
  list.push({ id: row.id, fn: row.fn, msg: String(msg).slice(0, 300), at: Date.now() });
  await setCfg(env, 'outbox_err', JSON.stringify(list.slice(-20))).run();
}
async function drainOutbox(env) {
  let first = null;
  try { first = await env.DB.prepare('SELECT id FROM outbox ORDER BY id LIMIT 1').first(); } catch (e) { return; }
  if (!first) return;
  const now = Date.now();
  // 1本だけ動かす（60秒たっても外れていない鍵は、止まったものとみなして取る）
  const lk = await env.DB.prepare("INSERT INTO config (k, v) VALUES ('outbox_lock', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE CAST(config.v AS INTEGER) < ?")
    .bind(String(now), now - 60000).run();
  if (!lk.meta || !lk.meta.changes) return;
  try {
    while (Date.now() - now < 25000) {
      const row = await env.DB.prepare('SELECT id, k, body, fn, tries FROM outbox ORDER BY id LIMIT 1').first();
      if (!row) break;
      let o = null, netErr = '';
      try {
        const out = await gasCrmCall(env, row.k, row.body);
        try { o = JSON.parse(out.text); } catch (e) { netErr = 'GAS ' + out.status; }
      } catch (e) { netErr = e.message; }
      if (o) {
        // GAS が答えた（成功でも、GAS の中の失敗でも）。失敗はやり直しても同じなので、知らせて次へ
        if (!o.ok) await outboxErr(env, row, o.error || 'GASで失敗');
        await env.DB.prepare('DELETE FROM outbox WHERE id = ?').bind(row.id).run();
        continue;
      }
      // 通信の失敗: 5回まではあとでやり直す（1分ごとの見回りでも拾う）
      if (row.tries >= 5) {
        await outboxErr(env, row, netErr || 'GASにつながりません');
        await env.DB.prepare('DELETE FROM outbox WHERE id = ?').bind(row.id).run();
        continue;
      }
      await env.DB.prepare('UPDATE outbox SET tries = tries + 1 WHERE id = ?').bind(row.id).run();
      break;
    }
  } finally {
    await env.DB.prepare("UPDATE config SET v = '0' WHERE k = 'outbox_lock'").run();
  }
}

export default {
  // 1分ごとの見回り: 書き残した保存があれば書く（ふだんは1行読むだけ）
  async scheduled(event, env, ctx) { ctx.waitUntil(drainOutbox(env)); },

  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;

    // 最初に1回だけ: GAS が鍵を登録する（まだ何も登録されていないときだけ受け付ける）
    if (path === '/register' && req.method === 'POST') {
      if (await cfg(env, 'sync_hash')) return json({ ok: false, error: 'already registered' }, 409);
      const b = await req.json();
      if (!b.sync || !b.key || String(b.sync).length < 32 || String(b.key).length < 32) return json({ ok: false, error: 'bad keys' }, 400);
      await env.DB.batch([setCfg(env, 'sync_hash', await sha256(b.sync)), setCfg(env, 'key_hash', await sha256(b.key))]);
      return json({ ok: true });
    }

    // GAS → 写しを受け取る
    if (path === '/sync' && req.method === 'POST') {
      if (!(await isSync(req, env))) return json({ ok: false, error: 'unauthorized' }, 401);
      const b = await req.json();
      const sheet = String(b.sheet || '');
      if (!sheet) return json({ ok: false, error: 'no sheet' }, 400);
      const now = Date.now();
      const stmts = [];
      // 丸ごと送るときは「#new」に貯めてから入れ替える（送っている途中に画面が空にならないように）
      if (b.mode === 'begin') {
        stmts.push(env.DB.prepare('DELETE FROM sheet_rows WHERE sheet = ?').bind(sheet + '#new'));
      } else if (b.mode === 'chunk' || b.mode === 'rows') {
        const target = b.mode === 'chunk' ? sheet + '#new' : sheet;
        // ⚠️ 中身が同じ行は書かない（WHERE）。無料の書き込みは1日10万行まで。2026-10-07 に丸ごとの送り直しで使い切った
        const ins = env.DB.prepare('INSERT INTO sheet_rows (sheet, r, v, u) VALUES (?, ?, ?, ?) ON CONFLICT(sheet, r) DO UPDATE SET v = excluded.v, u = excluded.u WHERE sheet_rows.v IS NOT excluded.v');
        for (const [r, v] of b.rows || []) stmts.push(ins.bind(target, Number(r), typeof v === 'string' ? v : JSON.stringify(v), now));
        // 行が減ったとき（片付けで消した）: 指定した行数より後ろを消す
        if (b.mode === 'rows' && Number.isFinite(b.truncateAfter)) {
          stmts.push(env.DB.prepare('DELETE FROM sheet_rows WHERE sheet = ? AND r > ?').bind(sheet, Number(b.truncateAfter)));
        }
      } else if (b.mode === 'end') {
        stmts.push(env.DB.prepare('DELETE FROM sheet_rows WHERE sheet = ?').bind(sheet));
        stmts.push(env.DB.prepare('UPDATE sheet_rows SET sheet = ?, u = ? WHERE sheet = ?').bind(sheet, now, sheet + '#new'));
      } else {
        return json({ ok: false, error: 'bad mode' }, 400);
      }
      if (b.mode !== 'begin' && b.mode !== 'chunk') {
        // ⚠️ 行数を COUNT(*) で数え直さないこと。送るたびにシート全体を読み、1日の読み取り上限（500万行）を超えた（2026-10-08）。
        //   行数は「切り詰めたらその数、そうでなければ今までと送った行番号の大きい方」で覚えておく。
        let maxR = 0;
        for (const [r] of b.rows || []) if (Number(r) > maxR) maxR = Number(r);
        if (Number.isFinite(b.truncateAfter)) {
          stmts.push(env.DB.prepare('INSERT INTO sheet_meta (sheet, rows, synced_at) VALUES (?, ?, ?) ON CONFLICT(sheet) DO UPDATE SET rows = excluded.rows, synced_at = excluded.synced_at')
            .bind(sheet, Number(b.truncateAfter), now));
        } else {
          stmts.push(env.DB.prepare('INSERT INTO sheet_meta (sheet, rows, synced_at) VALUES (?, ?, ?) ON CONFLICT(sheet) DO UPDATE SET rows = MAX(sheet_meta.rows, excluded.rows), synced_at = excluded.synced_at')
            .bind(sheet, maxR, now));
        }
        stmts.push(setCfg(env, 'ver', now));
        if (b.why) stmts.push(setCfg(env, 'why:' + String(b.why), now));
      }
      try {
        for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
      } catch (e) {
        // 上限に当たった等。GAS はこれを見てしばらく送るのをやめる
        return json({ ok: false, error: String(e && e.message || e), limit: /limit|exceeded/i.test(String(e && e.message)) }, 503);
      }
      return json({ ok: true, n: (b.rows || []).length });
    }

    // 画面を開く: 鍵付きの URL で来たら Cookie に入れて、鍵の無い URL に移す
    if (path === '/' && url.searchParams.get('key')) {
      const key = url.searchParams.get('key');
      if ((await sha256(key)) !== (await cfg(env, 'key_hash'))) return new Response('鍵が違います', { status: 401 });
      return new Response(null, {
        status: 302,
        headers: {
          location: '/',
          'set-cookie': 'crm_key=' + encodeURIComponent(key) + '; Path=/; Max-Age=15552000; HttpOnly; Secure; SameSite=Lax',
        },
      });
    }

    const vm = path.match(/^\/api\/vcard\/([A-Za-z0-9-]{20,64})(\.vcf)?$/);
    // 置いた連絡先を開く（GET）は鍵なしで通す。ホーム画面に置いたCRMから開く別の画面には Cookie が渡らず、ここで止まって白い画面になっていた（2026-10-25）。
    // 番号は毎回作る使い捨ての長い番号で、1回開いたら消えるので、番号を知らない人には開けない。置く（PUT）方は鍵が要る
    if (vm && req.method === 'GET') {
      // 開く方が置く方より先に着くことがあるので、少し待ちながら見る（最大3秒）
      let v = null;
      for (let i = 0; i < 10 && !v; i++) {
        const row = await env.DB.prepare("SELECT v FROM config WHERE k = ?").bind('vcard:' + vm[1]).first();
        v = row && row.v;
        if (!v) await new Promise(r => setTimeout(r, 300));
      }
      if (!v) return new Response('連絡先が見つかりません。CRMに戻って、もう一度「電話帳に入れる」を押してください。', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      ctx.waitUntil(env.DB.prepare("DELETE FROM config WHERE k = ?").bind('vcard:' + vm[1]).run());
      return new Response(v, { headers: { 'content-type': 'text/x-vcard; charset=utf-8', 'content-disposition': 'inline; filename="contact.vcf"', 'cache-control': 'no-store' } });
    }
    // ここから先は鍵（Cookie）が要る。画面のファイル（GAS のコードを含む）も鍵が無いと返さない
    {
      if (!(await isViewer(req, env))) {
        return !path.startsWith('/api/') ? new Response('ログインが必要です。GASの顧客管理から「Cloudflare版を開く」で入ってください。', { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8' } })
          : json({ ok: false, error: 'unauthorized' }, 401);
      }
    }

    // 写しを返す（行の中身は D1 の文字列をそのままつなぐ。組み立て直さない）
    if (path === '/api/sheets') {
      const now0 = Date.now();   // これより後に変わった行は /api/delta で取る
      const names = (url.searchParams.get('s') || '').split(',').filter(Boolean);
      const parts = [];
      for (const n of names) {
        const { results } = await env.DB.prepare('SELECT r, v FROM sheet_rows WHERE sheet = ? ORDER BY r').bind(n).all();
        parts.push(JSON.stringify(n) + ':[' + results.map((x) => '[' + x.r + ',' + x.v + ']').join(',') + ']');
      }
      const meta = await env.DB.prepare('SELECT sheet, rows, synced_at FROM sheet_meta').all();
      return new Response('{"now":' + now0 + ',"sheets":{' + parts.join(',') + '},"meta":' + JSON.stringify(meta.results) + ',"ver":' + (Number(await cfg(env, 'ver')) || 0) + '}', {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    // 前回から変わった行だけ（since はミリ秒。返す now を次の since にする）。消えた行は meta の rows で切り詰める
    if (path === '/api/delta') {
      const now = Date.now();
      const since = Number(url.searchParams.get('since') || 0);
      // ⚠️ ORDER BY sheet, r や NOT LIKE を付けると、D1 が u の索引を使わず表をまるごと（約2万4千行）読んでいた。
      //   1日200回で480万行になり、無料の読み取り上限を超えた（2026-10-25）。u だけで引いて、並べ替え・#new 除きは手元でする
      const got = (await env.DB.prepare('SELECT sheet, r, v FROM sheet_rows WHERE u > ? LIMIT 20000').bind(since).all()).results;
      const results = got.filter((x) => !String(x.sheet).endsWith('#new'))
        .sort((a, b) => (a.sheet < b.sheet ? -1 : a.sheet > b.sheet ? 1 : a.r - b.r));
      const meta = await env.DB.prepare('SELECT sheet, rows, synced_at FROM sheet_meta').all();
      return new Response('{"now":' + now + ',"rows":[' + results.map((x) => '[' + JSON.stringify(x.sheet) + ',' + x.r + ',' + x.v + ']').join(',') + '],"meta":' + JSON.stringify(meta.results) + ',"ver":' + (Number(await cfg(env, 'ver')) || 0) + '}', {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    // 画面のボタン → GAS の関数（crm_call）。鍵は Cookie から GAS に渡す。中身はそのまま流す（大きい写真でも CPU を使わない）
    // 受け付けた保存がまだ残っているか（画面が、自分の保存が書き終わったかを見る。保存待ちがある間だけ2秒ごと）
    if (path === '/api/outbox') {
      const st = await env.DB.prepare('SELECT MIN(id) AS m, COUNT(*) AS n FROM outbox').first();
      let errs = [];
      try { errs = JSON.parse((await cfg(env, 'outbox_err')) || '[]'); } catch (e) {}
      return json({ min: (st && st.m) || 0, n: (st && st.n) || 0, errs }, 200, { 'cache-control': 'no-store' });
    }

    if (path === '/api/call' && req.method === 'POST') {
      const key = cookieOf(req, 'crm_key');
      // GAS は答えを googleusercontent に置いて 302 で返す。POST のまま追うと失敗するので、転送先は GET で取りに行く
      const body = await req.text();
      let pb = {};
      try { pb = JSON.parse(body); } catch (e) {}
      // 画面が先に済ませた保存（q）は、受け付けてすぐ返す。GAS へは後ろで順番に（2026-10-25）
      if (pb.q) {
        let ins = null;
        try {
          ins = await env.DB.prepare('INSERT INTO outbox (k, body, fn, created) VALUES (?, ?, ?, ?)')
            .bind(key, JSON.stringify({ fn: pb.fn, args: pb.args, lite: true }), String(pb.fn || ''), Date.now()).run();
        } catch (eIns) { ins = null; }   // 受け付けられない（表が無い・上限など）ときは、下の今までどおりの道へ
        if (ins) {
          ctx.waitUntil(drainOutbox(env).catch(() => {}));
          return json({ ok: true, result: { lite: true, queued: true, id: ins.meta.last_row_id } });
        }
      }
      // 受け付け済みの保存が残っていたら、先にそれを書き終えてから（順番を守る）。読むだけの呼び出し（get…）は待たない
      if (!/^get/.test(String(pb.fn || ''))) {
        for (let i = 0; i < 40; i++) {
          let left = null;
          try { left = await env.DB.prepare('SELECT id FROM outbox LIMIT 1').first(); } catch (eL) { left = null; }
          if (!left) break;
          await drainOutbox(env).catch(() => {});
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      // ⚠️ GAS への呼び出しは waitUntil で最後までやり切る。スマホで送信中に Chrome を閉じる・別のアプリに移ると、
      //   画面との接続が切れて、ここでの処理ごと止められることがある（2026-10-13）。GAS に届けば GAS 側は最後まで動く
      const job = (async () => {
        const r1 = await fetch(env.GAS_URL + '?action=crm_call&key=' + encodeURIComponent(key), {
          method: 'POST', body, headers: { 'content-type': 'text/plain' }, redirect: 'manual',
        });
        const loc = r1.headers.get('location');
        const r = loc ? await fetch(loc) : r1;
        return { status: r.status, text: await r.text() };
      })();
      if (ctx && ctx.waitUntil) ctx.waitUntil(job.catch(() => {}));
      const out = await job;
      return new Response(out.text, { status: out.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }

    // 電話帳に入れる: 画面が作った連絡先（vCard）をそのまま返す。iPhone は本物のURLから開いたときだけ「新規連絡先を作成」を出す
    // （手元で作ったファイルを開くと、見るだけの画面になり ✓ を押しても追加されなかった 2026-10-13）。
    // ⚠️ 名前・電話番号はURLに載せない（POST の本文で受け取る）
    // ⚠️ ホーム画面に置いたCRMから開くと、別の画面にフォームの中身が届かず白い画面になった（2026-10-25）。
    //   いまは「先に置く（PUT /api/vcard/<id>）→ 別の画面で普通のアドレスとして開く（GET /api/vcard/<id>.vcf）」。
    //   置いた連絡先は1回開いたら消す。id は画面が毎回作る使い捨ての長い番号（名前・電話番号はURLに載らない）
    if (vm && req.method === 'PUT') {
      const v = await req.text();
      if (!/^BEGIN:VCARD/.test(v) || v.length > 4000) return json({ ok: false, error: 'bad vcard' }, 400);
      await env.DB.prepare("INSERT OR REPLACE INTO config (k, v) VALUES (?, ?)").bind('vcard:' + vm[1], v).run();
      return json({ ok: true });
    }
    if (path === '/api/vcard' && req.method === 'POST') {
      const form = await req.formData();
      const v = String(form.get('vcf') || '');
      if (!/^BEGIN:VCARD/.test(v) || v.length > 4000) return json({ ok: false, error: 'bad vcard' }, 400);
      return new Response(v, { headers: { 'content-type': 'text/x-vcard; charset=utf-8', 'content-disposition': 'inline; filename="contact.vcf"', 'cache-control': 'no-store' } });
    }

    // 写真を回すときに、よそのサイトの写真をこの画面から読めるように中継する（そのままだとブラウザが読ませてくれない）。
    // 画像だけ通す。中身はそのまま流す（CPUを使わない）
    if (path === '/api/img') {
      const u = url.searchParams.get('u') || '';
      if (!/^https?:\/\//.test(u)) return json({ ok: false, error: 'bad url' }, 400);
      const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || !/^image\//.test(ct)) return json({ ok: false, error: 'not image ' + r.status }, 502);
      return new Response(r.body, { headers: { 'content-type': ct, 'cache-control': 'no-store' } });
    }

    // 変わったかどうかだけ（1分ごとに確かめる）
    if (path === '/api/ver') {
      const { results } = await env.DB.prepare("SELECT k, v FROM config WHERE k = 'ver' OR k LIKE 'why:%'").all();
      const out = { ver: 0, whys: {} };
      for (const x of results) {
        if (x.k === 'ver') out.ver = Number(x.v);
        else out.whys[x.k.slice(4)] = Number(x.v);
      }
      return json(out, 200, { 'cache-control': 'no-store' });
    }

    return env.ASSETS.fetch(req);
  },
};
