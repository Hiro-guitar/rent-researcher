-- シートの写し。GAS の getValues() と同じ形（行の中身は JSON 配列）。r は 1 始まりのシートの行番号
CREATE TABLE IF NOT EXISTS sheet_rows (
  sheet TEXT NOT NULL,
  r INTEGER NOT NULL,
  v TEXT NOT NULL,
  PRIMARY KEY (sheet, r)
);
CREATE TABLE IF NOT EXISTS sheet_meta (
  sheet TEXT PRIMARY KEY,
  rows INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL DEFAULT 0
);
-- 鍵（GAS が最初に1回だけ登録する。ハッシュだけ持つ）
CREATE TABLE IF NOT EXISTS config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
-- 画面の保存の受け付け（2026-10-25）。受け付けたらすぐ画面に「済み」を返し、GAS への書き込みは後ろで古い順に1件ずつ
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  k TEXT NOT NULL,          -- GAS に渡す鍵（Cookie の値）。書き終えたら行ごと消す
  body TEXT NOT NULL,       -- { fn, args, lite }
  fn TEXT NOT NULL DEFAULT '',
  tries INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
