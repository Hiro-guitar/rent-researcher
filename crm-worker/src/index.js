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

export default {
  async fetch(req, env) {
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
        const ins = env.DB.prepare('INSERT INTO sheet_rows (sheet, r, v, u) VALUES (?, ?, ?, ?) ON CONFLICT(sheet, r) DO UPDATE SET v = excluded.v, u = excluded.u');
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
        stmts.push(env.DB.prepare(
          'INSERT INTO sheet_meta (sheet, rows, synced_at) VALUES (?, (SELECT COUNT(*) FROM sheet_rows WHERE sheet = ?), ?) ' +
          'ON CONFLICT(sheet) DO UPDATE SET rows = excluded.rows, synced_at = excluded.synced_at').bind(sheet, sheet, now));
        stmts.push(setCfg(env, 'ver', now));
        if (b.why) stmts.push(setCfg(env, 'why:' + String(b.why), now));
      }
      for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
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
      const { results } = await env.DB.prepare("SELECT sheet, r, v FROM sheet_rows WHERE u > ? AND sheet NOT LIKE '%#new' ORDER BY sheet, r LIMIT 20000").bind(since).all();
      const meta = await env.DB.prepare('SELECT sheet, rows, synced_at FROM sheet_meta').all();
      return new Response('{"now":' + now + ',"rows":[' + results.map((x) => '[' + JSON.stringify(x.sheet) + ',' + x.r + ',' + x.v + ']').join(',') + '],"meta":' + JSON.stringify(meta.results) + ',"ver":' + (Number(await cfg(env, 'ver')) || 0) + '}', {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    // 画面のボタン → GAS の関数（crm_call）。鍵は Cookie から GAS に渡す。中身はそのまま流す（大きい写真でも CPU を使わない）
    if (path === '/api/call' && req.method === 'POST') {
      const key = cookieOf(req, 'crm_key');
      // GAS は答えを googleusercontent に置いて 302 で返す。POST のまま追うと失敗するので、転送先は GET で取りに行く
      const body = await req.text();
      const r1 = await fetch(env.GAS_URL + '?action=crm_call&key=' + encodeURIComponent(key), {
        method: 'POST', body, headers: { 'content-type': 'text/plain' }, redirect: 'manual',
      });
      const loc = r1.headers.get('location');
      const r = loc ? await fetch(loc) : r1;
      return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
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
