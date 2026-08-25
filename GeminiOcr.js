/**
 * 募集図面(PDF)をGeminiに読ませて初期費用の項目を拾う。
 *
 * BBサイトのDOMから取れる値を「正」として、図面はその補完と照合に使う。
 * AIの読み取りをそのまま概算書に流さないのは、金額の読み違いが顧客に出る事故を避けるため。
 *
 * なぜ図面を読むのか（実物で確認した結果）:
 *   図面には「ホームマイスター 16500」「室内消毒施工代 18700」のような、
 *   BBサイトの構造化項目には出てこない費目が載っている。
 *   一方でREINSの図面は時期（契約時/退去時）が書かれていないことが多く、
 *   itandiのDOMは逆に時期が明記されている。両方を突き合わせると補い合う。
 *
 * モデルの使い分け（無料枠はモデルごとに上限がある）:
 *   通常          gemini-3.7-flash        1日20回  ← 概算書は多くて10件/日
 *   1日の上限時    gemini-3.5-flash-lite   1日500回
 *   ※ 家計簿が使っている gemini-3.6-flash とは別枠なので、互いの枠を食わない
 */

var GEMINI_OCR = {
  PRIMARY: 'gemini-3.7-flash',
  FALLBACK: 'gemini-3.5-flash-lite',
  ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models/',
  // 実物の図面で medium なら全項目正解だった。low は未検証なので上げてある。
  THINKING_LEVEL: 'medium'
};

/**
 * 図面から初期費用を読み取らせるプロンプト。
 * 実物の募集図面で1項目ずつ突き合わせて詰めたもの。安易に短くしないこと。
 *
 * 特に効いている規則:
 *   ・「有 2年 - 2万円」から年数(2)ではなく金額(20000)を取らせる
 *   ・クリーニング代の時期を敷金の有無で判定させる（業界の実務に合わせている）
 *   ・timing_reason を書かせて、判断が間違っていれば人が気づけるようにする
 */
var GEMINI_DRAWING_PROMPT = [
  'この募集図面から「契約時に借主が払う初期費用」を抜き出して、JSONで返してください。',
  '',
  '【時期の判定】',
  '図面に「契約時」「退去時」「更新時」と書かれていればそれに従う。書かれていない場合は次の実務ルールで判定し、根拠を timing_reason に書く。',
  '',
  '- クリーニング代・室内清掃費用（必ず「契約時」か「退去時」のどちらかに決めること。"不明"にしない）:',
  '  ・「契約時」「入居時」の記載があれば契約時',
  '  ・「退去時」「解約時」の記載があれば退去時 → 除外',
  '  ・記載が無く、敷金がある物件 → 退去時に敷金から精算されるのが通例なので退去時 → 除外',
  '  ・記載が無く、敷金が0（なし）の物件 → 契約時に前払いするのが通例なので契約時',
  '- 契約時とみなしてよいもの: 鍵交換費用、火災保険・損害保険、消毒/抗菌/防虫の施工代、',
  '  室内サポートや設備保証などのサービス料（「ホームマイスター」等の商品名を含む）、初回保証料、仲介手数料',
  '- 必ず除外するもの: 更新料、更新事務手数料、更新時の保証料、短期解約違約金、退去時の費用',
  '',
  '【その他】',
  '- 敷金・礼金は「ヶ月数」で返す。金額しか書かれていなければ月数は null。',
  '- 金額は数値のみ（円やカンマを付けない）。「総賃料の50%」のように率で書かれているものは',
  '  amount を null にして note に原文を入れる。',
  '- 商品名の費目も、金額が書かれていれば必ず含める。',
  '- 図面に書かれていないものを推測で足さない。金額の桁を勝手に補わない。',
  '',
  '{',
  '  "building_name": "", "room_number": "", "rent": 0, "management_fee": 0,',
  '  "deposit_months": 0, "key_money_months": 0,',
  '  "guarantee_rate_percent": null,',
  '  "initial_costs": [',
  '    {"label": "", "amount": 0, "timing": "契約時|不明",',
  '     "timing_reason": "図面に「契約時」と記載 / 敷金0のため契約時と判断 など",',
  '     "note": "図面の原文"}',
  '  ],',
  '  "excluded": [{"label": "", "amount": 0, "reason": ""}]',
  '}'
].join('\n');

/**
 * 募集図面PDFをGeminiに読ませる。
 * json: { pdfBase64, mimeType }
 */
function handleReadDrawing(json) {
  var out = function (obj) {
    return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
  };

  var b64 = String(json.pdfBase64 || '');
  if (!b64) return out({ ok: false, error: '図面のデータが空です' });
  // GASのPOST上限もあるので、そもそも大きすぎるものは弾く
  if (b64.length > 20 * 1024 * 1024) return out({ ok: false, error: '図面のデータが大きすぎます' });

  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) return out({ ok: false, error: 'GEMINI_API_KEY が未設定です' });

  var mimeType = String(json.mimeType || 'application/pdf');

  // まず精度の高い方。1日の上限に当たっていたら軽い方へ落とす。
  var first = _geminiGenerate_(apiKey, GEMINI_OCR.PRIMARY, mimeType, b64);
  if (first.ok) return out(_drawingResult_(first, GEMINI_OCR.PRIMARY, false));

  if (!first.quotaPerDay) {
    return out({ ok: false, error: first.error, model: GEMINI_OCR.PRIMARY });
  }
  var second = _geminiGenerate_(apiKey, GEMINI_OCR.FALLBACK, mimeType, b64);
  if (second.ok) return out(_drawingResult_(second, GEMINI_OCR.FALLBACK, true));
  return out({ ok: false, error: second.error, model: GEMINI_OCR.FALLBACK, fellBack: true });
}

/**
 * 概算書に載せる項目名を決める。
 *
 * クリーニング費用は退去時精算が一般的なので、初期費用として載せるなら
 * 「先払いである」ことがお客さんに分かる必要がある。項目名に付ける。
 * （備考欄ではなく項目名に入れるのは、備考は空のことが多く見落とされるため）
 */
function _drawingDisplayLabel_(label, timing) {
  var t = String(label || '').trim();
  if (!t) return t;
  if (String(timing || '') !== '契約時') return t;
  if (!/クリーニング|清掃/.test(t)) return t;
  if (/先払|前払/.test(t)) return t;              // 既に書いてあれば重ねない
  return t + '（先払い）';
}

/**
 * クリーニング代の時期を必ず決める。
 *
 * クリーニング代は図面に時期が明記されているのが普通だが、書かれていない図面もある。
 * その場合も「不明」で放置せず、敷金の有無で決まる:
 *   敷金あり → 退去時に敷金から精算される  → 初期費用ではない
 *   敷金なし → 契約時に前払いする          → 初期費用
 * プロンプトでも同じ指示をしているが、モデルの判断が揺れても結果が変わらないよう
 * こちらでも決めておく。金額が大きい項目なので、入る/入らないを運任せにしない。
 *
 * deposit_months は「金額しか書かれていない」とき null になる（＝敷金はある）。
 * 0 だけが「敷金なし」。
 */
function _resolveCleaningTiming_(data) {
  if (!data || !Array.isArray(data.initial_costs)) return;
  var dep = data.deposit_months;
  var noDeposit = (dep === 0 || dep === '0');
  var kept = [];
  var moved = [];

  for (var i = 0; i < data.initial_costs.length; i++) {
    var it = data.initial_costs[i] || {};
    var label = String(it.label || '');
    if (!/クリーニング|清掃/.test(label)) { kept.push(it); continue; }
    if (it.timing === '契約時') { kept.push(it); continue; }

    if (noDeposit) {
      it.timing = '契約時';
      it.timing_reason = '図面に時期の記載が無く、敷金が0のため先払いと判断';
      kept.push(it);
    } else {
      moved.push({
        label: it.label,
        amount: it.amount,
        reason: (it.timing === '退去時')
          ? '図面に退去時と記載'
          : '図面に時期の記載が無く、敷金があるため退去時に精算されると判断'
      });
    }
  }

  data.initial_costs = kept;
  if (moved.length) data.excluded = (data.excluded || []).concat(moved);
}

function _drawingResult_(res, model, fellBack) {
  try {
    // クリーニング代の時期を先に確定させてから項目名を決める
    _resolveCleaningTiming_(res.data);
    var items = (res.data && res.data.initial_costs) || [];
    for (var i = 0; i < items.length; i++) {
      items[i].display_label = _drawingDisplayLabel_(items[i].label, items[i].timing);
    }
  } catch (e) {}

  return {
    ok: true,
    model: model,
    fellBack: fellBack,
    data: res.data,
    // 使ったトークン数。無料枠の残りを気にするときに見る
    usage: res.usage || null
  };
}

/**
 * Gemini を1回呼ぶ。
 * 戻り: { ok, data } / { ok:false, error, quotaPerDay }
 * quotaPerDay は「1日の上限に当たった」ときだけ true（分あたりの上限とは区別する）。
 */
function _geminiGenerate_(apiKey, model, mimeType, b64) {
  var payload = {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: mimeType, data: b64 } },
        { text: GEMINI_DRAWING_PROMPT }
      ]
    }],
    generationConfig: {
      temperature: 0,             // 金額を読む作業なので揺らさない
      maxOutputTokens: 8000,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel: GEMINI_OCR.THINKING_LEVEL }
    }
  };

  var res;
  try {
    res = UrlFetchApp.fetch(GEMINI_OCR.ENDPOINT + model + ':generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (e) {
    return { ok: false, error: '通信に失敗しました: ' + e.message, quotaPerDay: false };
  }

  var code = res.getResponseCode();
  var text = res.getContentText();

  if (code === 429) {
    var q = _geminiQuotaInfo_(text);
    return {
      ok: false,
      quotaPerDay: q.perDay,
      error: q.perDay
        ? (model + ' の1日の上限に達しました')
        : (model + ' の分あたりの上限に達しました。少し待ってからお試しください')
    };
  }
  if (code !== 200) {
    return { ok: false, error: 'Gemini エラー(' + code + '): ' + text.slice(0, 300), quotaPerDay: false };
  }

  var body;
  try { body = JSON.parse(text); } catch (e) {
    return { ok: false, error: '応答を解析できませんでした', quotaPerDay: false };
  }

  if (body.promptFeedback && body.promptFeedback.blockReason) {
    return { ok: false, error: '入力がブロックされました: ' + body.promptFeedback.blockReason, quotaPerDay: false };
  }
  var cand = (body.candidates || [])[0];
  if (!cand) return { ok: false, error: '応答が空でした', quotaPerDay: false };
  if (cand.finishReason === 'MAX_TOKENS') {
    return { ok: false, error: '出力が途中で切れました（項目が多すぎる可能性）', quotaPerDay: false };
  }

  // thinking部分(thought:true)は本文ではないので混ぜない
  var parts = (cand.content && cand.content.parts) || [];
  var outText = '';
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].text && !parts[i].thought) outText += parts[i].text;
  }
  outText = outText.replace(/```json/g, '').replace(/```/g, '').trim();
  if (!outText) return { ok: false, error: '本文が空でした（' + cand.finishReason + '）', quotaPerDay: false };

  var data;
  try { data = JSON.parse(outText); } catch (e) {
    return { ok: false, error: 'JSONとして読めませんでした: ' + outText.slice(0, 200), quotaPerDay: false };
  }
  return { ok: true, data: data, usage: body.usageMetadata || null };
}

/**
 * 429のレスポンスから「1日の上限か、分あたりの上限か」を判別する。
 * 本文の details に QuotaFailure（違反した quotaId）が入っていて、
 * quotaId の名前に PerDay / PerMinute が出るので、こちらで推測する必要はない。
 * （家計簿(kakeibo)の実装と同じ考え方）
 */
function _geminiQuotaInfo_(body) {
  var out = { perDay: false, ids: [] };
  try {
    var err = (JSON.parse(body) || {}).error || {};
    var details = err.details || [];
    for (var i = 0; i < details.length; i++) {
      var d = details[i] || {};
      var vios = d.violations || d.quotaViolations || [];
      for (var v = 0; v < vios.length; v++) {
        var id = String(vios[v].quotaId || vios[v].subject || '');
        if (id) out.ids.push(id);
        if (/PerDay/i.test(id)) out.perDay = true;
      }
    }
  } catch (e) {}
  return out;
}

/**
 * APIキーが入っているかだけを確かめる。キーそのものはログに出さない。
 * Apps Scriptのエディタでこの関数を選んで実行し、実行ログを見る。
 */
function checkGeminiKey() {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) {
    Logger.log('GEMINI_API_KEY: 未設定です');
    return false;
  }
  Logger.log('GEMINI_API_KEY: 設定済み（' + key.length + '文字, 末尾4桁 ...' + key.slice(-4) + '）');
  return true;
}
