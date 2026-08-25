/**
 * 募集図面(PDF)をGeminiに読ませて初期費用の項目を拾う。
 *
 * BBサイトのDOMから取れる値を「正」として、図面はその補完と照合に使う。
 * AIの読み取りをそのまま概算書に流さないのは、金額の読み違いが顧客に出る事故を避けるため。
 *
 * モデルの使い分け（無料枠はモデルごとに上限がある）:
 *   通常          gemini-3.7-flash        1日20回  ← 精度重視。概算書は多くて10件/日
 *   上限に当たったら gemini-3.5-flash-lite   1日500回
 *   ※ 家計簿が使っている gemini-3.6-flash とは別枠なので、互いの枠を食わない
 */

var GEMINI_OCR = {
  PRIMARY: 'gemini-3.7-flash',
  FALLBACK: 'gemini-3.5-flash-lite',
  ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models/',
  THINKING_LEVEL: 'low'
};

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
