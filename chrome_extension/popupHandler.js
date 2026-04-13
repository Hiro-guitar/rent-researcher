/**
 * popupHandler.js — ForRent 周辺環境ポップアップの自動処理
 *
 * ForRentの周辺環境入力ポップアップ（COM1R0214_2.action）で動作する。
 * スーパーの先頭施設にチェックを入れ、登録ボタンを自動クリックする。
 *
 * manifest.json content_scripts:
 *   matches: ["https://www.fn.forrent.jp/fn/COM1R0214_2.action*"]
 *   run_at: "document_idle"
 */
(function () {
  'use strict';
  console.log('📍 周辺環境ポップアップ（スーパーの先頭施設にのみチェック）');

  function checkFirstOfCategory(categoryName) {
    const rows = document.querySelectorAll('#shuhenKankyoTable tbody tr');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const categoryTd = row.querySelector('td.itemName');
      if (categoryTd && categoryTd.textContent.trim() === categoryName) {
        const checkbox = row.querySelector('input[type="checkbox"]');
        if (checkbox) {
          checkbox.checked = true;
          console.log(`[周辺環境] 「${categoryName}」の先頭施設にチェックを入れました`);
        }
        break;
      }
    }
  }

  window.addEventListener('load', () => {
    setTimeout(() => {
      checkFirstOfCategory('スーパー');

      // 登録ボタン押下
      const btn = document.getElementById('comButton1');
      if (btn) {
        setTimeout(() => {
          console.log('[周辺環境] 登録ボタンをクリック');
          btn.click();
        }, 500);
      }
    }, 1000);
  });
})();
