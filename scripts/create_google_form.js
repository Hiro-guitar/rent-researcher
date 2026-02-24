/**
 * Google Apps Script: 物件検索条件フォーム作成スクリプト
 *
 * 使い方:
 *   1. https://script.google.com/home でプロジェクトを作成
 *   2. このコードを貼り付けて SPREADSHEET_ID を設定
 *   3. createSearchForm() を実行
 *   4. フォームが作成され、スプレッドシートの「検索条件」シートに連携される
 */

// ★ ここにスプレッドシート ID を入力してください
const SPREADSHEET_ID = "YOUR_SPREADSHEET_ID_HERE";

function createSearchForm() {
  const form = FormApp.create("物件検索条件フォーム");
  form.setDescription(
    "お客様の物件検索条件を入力してください。\n" +
    "入力された条件で itandi BB を自動検索し、新着物件を Discord に通知します。"
  );
  form.setConfirmationMessage("検索条件を登録しました。新着物件が見つかり次第、Discord で通知します。");

  // ── B列: お客様名（必須） ──────────────────────────────
  form.addTextItem()
    .setTitle("お客様名")
    .setHelpText("例: 山田太郎")
    .setRequired(true);

  // ── C列: 都道府県（必須） ──────────────────────────────
  form.addListItem()
    .setTitle("都道府県")
    .setHelpText("検索するエリアの都道府県を選択してください")
    .setChoiceValues([
      "東京都", "神奈川県", "埼玉県", "千葉県",
      "大阪府", "京都府", "兵庫県",
      "愛知県", "福岡県",
      "北海道", "宮城県", "広島県", "沖縄県"
    ])
    .setRequired(true);

  // ── D列: 市区町村 ─────────────────────────────────────
  form.addTextItem()
    .setTitle("市区町村")
    .setHelpText("カンマ区切りで複数指定可\n例: 千代田区, 中央区, 港区");

  // ── E列: 駅徒歩 ───────────────────────────────────────
  form.addListItem()
    .setTitle("駅徒歩（分以内）")
    .setHelpText("最寄り駅からの徒歩時間の上限")
    .setChoiceValues([
      "指定なし", "1", "3", "5", "7", "10", "15", "20"
    ]);

  // ── F列: 賃料下限 ─────────────────────────────────────
  form.addListItem()
    .setTitle("賃料下限（万円）")
    .setHelpText("家賃の下限（管理費除く）")
    .setChoiceValues([
      "指定なし",
      "3", "3.5", "4", "4.5", "5", "5.5", "6", "6.5", "7", "7.5",
      "8", "8.5", "9", "9.5", "10", "10.5", "11", "12", "13", "14", "15",
      "20", "25", "30", "35", "40", "50", "100"
    ]);

  // ── G列: 賃料上限 ─────────────────────────────────────
  form.addListItem()
    .setTitle("賃料上限（万円）")
    .setHelpText("家賃の上限（管理費除く）")
    .setChoiceValues([
      "指定なし",
      "3", "3.5", "4", "4.5", "5", "5.5", "6", "6.5", "7", "7.5",
      "8", "8.5", "9", "9.5", "10", "10.5", "11", "12", "13", "14", "15",
      "20", "25", "30", "35", "40", "50", "100"
    ]);

  // ── H列: 間取り ───────────────────────────────────────
  form.addCheckboxItem()
    .setTitle("間取り")
    .setHelpText("希望する間取りを選択してください（複数選択可）")
    .setChoiceValues([
      "1R", "1K", "1DK", "1LDK",
      "2K", "2DK", "2LDK",
      "3K", "3DK", "3LDK",
      "4K", "4DK", "4LDK"
    ]);

  // ── I列: 専有面積下限 ─────────────────────────────────
  form.addListItem()
    .setTitle("専有面積下限（m²）")
    .setChoiceValues([
      "指定なし", "15", "20", "25", "30", "35", "40", "50", "60", "70", "80", "100"
    ]);

  // ── J列: 専有面積上限 ─────────────────────────────────
  form.addListItem()
    .setTitle("専有面積上限（m²）")
    .setChoiceValues([
      "指定なし", "15", "20", "25", "30", "35", "40", "50", "60", "70", "80", "100"
    ]);

  // ── K列: 築年数 ───────────────────────────────────────
  form.addListItem()
    .setTitle("築年数")
    .setHelpText("築何年以内の物件を検索するか")
    .setChoiceValues([
      "指定なし", "新築", "1", "3", "5", "7", "10", "15", "20", "25", "30"
    ]);

  // ── L列: 建物種別 ─────────────────────────────────────
  form.addCheckboxItem()
    .setTitle("建物種別")
    .setHelpText("希望する建物タイプを選択してください（複数選択可）")
    .setChoiceValues([
      "マンション", "アパート", "一戸建て",
      "テラスハウス", "タウンハウス"
    ]);

  // ── M列: 構造 ─────────────────────────────────────────
  form.addCheckboxItem()
    .setTitle("構造")
    .setHelpText("希望する建物構造を選択してください（複数選択可）")
    .setChoiceValues([
      "RC", "SRC", "鉄骨造", "軽量鉄骨造", "木造"
    ]);

  // ── N列: 所在階 ───────────────────────────────────────
  form.addListItem()
    .setTitle("所在階（以上）")
    .setHelpText("何階以上の物件を検索するか")
    .setChoiceValues([
      "指定なし", "2階以上", "3階以上", "5階以上", "10階以上"
    ]);

  // ── O列: 必須設備 ─────────────────────────────────────
  form.addCheckboxItem()
    .setTitle("必須設備")
    .setHelpText("必ず必要な設備を選択してください（複数選択可）")
    .setChoiceValues([
      "バス・トイレ別",
      "エアコン",
      "室内洗濯機置場",
      "独立洗面台",
      "2口以上コンロ",
      "追い焚き",
      "温水洗浄便座",
      "オートロック",
      "モニター付きインターホン",
      "宅配ボックス",
      "浴室乾燥機",
      "ペット可"
    ]);

  // ── P列: 広告転載可 ───────────────────────────────────
  form.addMultipleChoiceItem()
    .setTitle("広告転載可のみ")
    .setHelpText("広告転載可の物件のみ検索するか")
    .setChoiceValues(["はい", "いいえ"]);

  // ── Q列: 取引態様 ─────────────────────────────────────
  // (社内向け項目なので省略可)

  // ── R列: 情報更新日 ───────────────────────────────────
  form.addListItem()
    .setTitle("情報更新日")
    .setHelpText("何日以内に更新された物件を検索するか")
    .setChoiceValues([
      "指定なし", "1日以内", "3日以内", "7日以内", "14日以内", "30日以内"
    ]);

  // ── スプレッドシートに連携 ─────────────────────────────
  form.setDestination(FormApp.DestinationType.SPREADSHEET, SPREADSHEET_ID);

  Logger.log("フォームが作成されました: " + form.getEditUrl());
  Logger.log("回答URL: " + form.getPublishedUrl());
  Logger.log("");
  Logger.log("【重要】フォーム回答がスプレッドシートに保存されますが、");
  Logger.log("シート名が「フォームの回答 1」になります。");
  Logger.log("sheets.py の CRITERIA_RANGE と合わせるため、");
  Logger.log("シート名を「検索条件」にリネームしてください。");
}
