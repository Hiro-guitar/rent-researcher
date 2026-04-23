document.addEventListener('DOMContentLoaded', () => {
  // 保存済み設定を読み込み
  chrome.storage.local.get(['gasWebappUrl', 'gasApiKey', 'searchIntervalMinutes', 'pageDelaySeconds', 'discordWebhookUrl', 'suumoDiscordWebhookUrl', 'errorWebhookUrl', 'jitterPercent', 'businessStartHour', 'businessEndHour', 'notifyMode', 'btMode', 'forrentLoginId', 'forrentPassword', 'suumoCompSkipThresholds', 'suumoBusinessKissCode', 'suumoBusinessFetchUrl', 'suumoBusinessLoginId', 'suumoBusinessPassword', 'suumoBusinessLoginBlocked', 'suumoBusinessLoginBlockedReason', 'suumoForrentStopDryRun', 'suumoSkipLowImageCount', 'itandiUpdatedWithinDays', 'suumoFinalSubmitDryRun'], (data) => {
    if (data.gasWebappUrl) document.getElementById('gasUrl').value = data.gasWebappUrl;
    if (data.gasApiKey) document.getElementById('apiKey').value = data.gasApiKey;
    if (data.discordWebhookUrl) document.getElementById('discordWebhook').value = data.discordWebhookUrl;
    if (data.suumoDiscordWebhookUrl) document.getElementById('suumoDiscordWebhook').value = data.suumoDiscordWebhookUrl;
    if (data.errorWebhookUrl) document.getElementById('errorWebhook').value = data.errorWebhookUrl;
    if (data.searchIntervalMinutes) document.getElementById('interval').value = data.searchIntervalMinutes;
    if (data.pageDelaySeconds) document.getElementById('delay').value = data.pageDelaySeconds;
    if (data.jitterPercent !== undefined) document.getElementById('jitterPercent').value = data.jitterPercent;
    if (data.businessStartHour !== undefined) document.getElementById('startHour').value = data.businessStartHour;
    if (data.businessEndHour !== undefined) document.getElementById('endHour').value = data.businessEndHour;
    const mode = data.notifyMode || 'immediate';
    const radio = document.querySelector(`input[name="notifyMode"][value="${mode}"]`);
    if (radio) radio.checked = true;
    const bt = data.btMode || 'alert';
    const btRadio = document.querySelector(`input[name="btMode"][value="${bt}"]`);
    if (btRadio) btRadio.checked = true;
    if (data.forrentLoginId) document.getElementById('forrentLoginId').value = data.forrentLoginId;
    if (data.forrentPassword) document.getElementById('forrentPassword').value = data.forrentPassword;
    // SUUMO競合スキップ閾値
    const t = data.suumoCompSkipThresholds || {};
    if (t.withNameHighlighted !== undefined && t.withNameHighlighted !== null) document.getElementById('suumoCompSkipWithNameHL').value = t.withNameHighlighted;
    if (t.withName !== undefined && t.withName !== null) document.getElementById('suumoCompSkipWithName').value = t.withName;
    if (t.withoutNameHighlighted !== undefined && t.withoutNameHighlighted !== null) document.getElementById('suumoCompSkipWithoutNameHL').value = t.withoutNameHighlighted;
    if (t.withoutName !== undefined && t.withoutName !== null) document.getElementById('suumoCompSkipWithoutName').value = t.withoutName;
    // SUUMOビジネス設定
    if (data.suumoBusinessKissCode) document.getElementById('suumoBusinessKissCode').value = data.suumoBusinessKissCode;
    if (data.suumoBusinessFetchUrl) document.getElementById('suumoBusinessFetchUrl').value = data.suumoBusinessFetchUrl;
    if (data.suumoBusinessLoginId) document.getElementById('suumoBusinessLoginId').value = data.suumoBusinessLoginId;
    if (data.suumoBusinessPassword) document.getElementById('suumoBusinessPassword').value = data.suumoBusinessPassword;

    // 画像枚数スキップ(デフォルト false = 無効)
    const skipLowImgCheckbox = document.getElementById('suumoSkipLowImageCount');
    if (skipLowImgCheckbox) skipLowImgCheckbox.checked = !!data.suumoSkipLowImageCount;

    // itandi 募集条件更新N日以内(デフォルト空欄 = 制限なし)
    const itandiDaysInput = document.getElementById('itandiUpdatedWithinDays');
    if (itandiDaysInput && data.itandiUpdatedWithinDays !== undefined && data.itandiUpdatedWithinDays !== null && data.itandiUpdatedWithinDays !== '') {
      itandiDaysInput.value = data.itandiUpdatedWithinDays;
    }

    // ForRent停止 ドライラン設定(デフォルト true)
    const dryRunCheckbox = document.getElementById('suumoForrentStopDryRun');
    if (dryRunCheckbox) {
      dryRunCheckbox.checked = (data.suumoForrentStopDryRun === undefined || data.suumoForrentStopDryRun === null)
        ? true
        : !!data.suumoForrentStopDryRun;
    }

    // Phase 5 最終登録 ドライラン設定(デフォルト true = 安全側)
    const finalSubmitDryRunCb = document.getElementById('suumoFinalSubmitDryRun');
    if (finalSubmitDryRunCb) {
      finalSubmitDryRunCb.checked = (data.suumoFinalSubmitDryRun === undefined || data.suumoFinalSubmitDryRun === null)
        ? true
        : !!data.suumoFinalSubmitDryRun;
    }

    // ログインブロック状態表示
    const blockedEl = document.getElementById('suumoBusinessLoginBlockedStatus');
    if (blockedEl) {
      if (data.suumoBusinessLoginBlocked) {
        const reason = data.suumoBusinessLoginBlockedReason || '(理由不明)';
        blockedEl.textContent = '⚠️ ブロック中: ' + reason;
        blockedEl.style.color = '#dc2626';
      } else {
        blockedEl.textContent = '✓ ブロックなし(正常)';
        blockedEl.style.color = '#065f46';
      }
    }
  });

  // 保存
  document.getElementById('saveBtn').addEventListener('click', () => {
    const gasWebappUrl = document.getElementById('gasUrl').value.trim();
    const gasApiKey = document.getElementById('apiKey').value.trim();
    const discordWebhookUrl = document.getElementById('discordWebhook').value.trim();
    const suumoDiscordWebhookUrl = document.getElementById('suumoDiscordWebhook').value.trim();
    const errorWebhookUrl = document.getElementById('errorWebhook').value.trim();
    const searchIntervalMinutes = Math.max(10, Math.min(240, parseInt(document.getElementById('interval').value) || 60));
    const pageDelaySeconds = Math.max(3, Math.min(30, parseInt(document.getElementById('delay').value) || 5));
    const jitterPercent = Math.max(0, Math.min(50, parseInt(document.getElementById('jitterPercent').value) || 0));
    const businessStartHour = Math.max(0, Math.min(23, parseInt(document.getElementById('startHour').value) || 0));
    const businessEndHour = Math.max(1, Math.min(24, parseInt(document.getElementById('endHour').value) || 24));
    const notifyMode = (document.querySelector('input[name="notifyMode"]:checked') || {}).value || 'immediate';
    const btMode = (document.querySelector('input[name="btMode"]:checked') || {}).value || 'alert';
    const forrentLoginId = document.getElementById('forrentLoginId').value.trim();
    const forrentPassword = document.getElementById('forrentPassword').value.trim();
    const suumoBusinessKissCode = (document.getElementById('suumoBusinessKissCode').value || '').trim().replace(/[^0-9]/g, '');
    const suumoBusinessFetchUrl = (document.getElementById('suumoBusinessFetchUrl').value || '').trim();
    const suumoBusinessLoginId = (document.getElementById('suumoBusinessLoginId').value || '').trim();
    const suumoBusinessPassword = document.getElementById('suumoBusinessPassword').value || '';
    const suumoForrentStopDryRun = !!(document.getElementById('suumoForrentStopDryRun') && document.getElementById('suumoForrentStopDryRun').checked);
    const suumoFinalSubmitDryRun = !!(document.getElementById('suumoFinalSubmitDryRun') && document.getElementById('suumoFinalSubmitDryRun').checked);
    const suumoSkipLowImageCount = !!(document.getElementById('suumoSkipLowImageCount') && document.getElementById('suumoSkipLowImageCount').checked);
    // itandiUpdatedWithinDays: 数値(1..30) / 空欄ならnullで「制限なし」
    const itandiDaysRaw = (document.getElementById('itandiUpdatedWithinDays').value || '').trim();
    let itandiUpdatedWithinDays = null;
    if (itandiDaysRaw !== '') {
      const n = parseInt(itandiDaysRaw, 10);
      if (!isNaN(n) && n >= 0 && n <= 30) itandiUpdatedWithinDays = n;
    }

    // SUUMO競合スキップ閾値（空欄なら null で「制限なし」扱い）
    const parseThreshold = (id) => {
      const v = document.getElementById(id).value.trim();
      if (v === '') return null;
      const n = parseInt(v, 10);
      return isNaN(n) || n < 0 ? null : n;
    };
    const suumoCompSkipThresholds = {
      withNameHighlighted: parseThreshold('suumoCompSkipWithNameHL'),
      withName: parseThreshold('suumoCompSkipWithName'),
      withoutNameHighlighted: parseThreshold('suumoCompSkipWithoutNameHL'),
      withoutName: parseThreshold('suumoCompSkipWithoutName'),
    };

    chrome.storage.local.set({
      gasWebappUrl,
      gasApiKey,
      discordWebhookUrl,
      suumoDiscordWebhookUrl,
      errorWebhookUrl,
      searchIntervalMinutes,
      pageDelaySeconds,
      jitterPercent,
      businessStartHour,
      businessEndHour,
      notifyMode,
      btMode,
      forrentLoginId,
      forrentPassword,
      suumoCompSkipThresholds,
      suumoBusinessKissCode,
      suumoBusinessFetchUrl,
      suumoBusinessLoginId,
      suumoBusinessPassword,
      suumoForrentStopDryRun,
      suumoSkipLowImageCount,
      itandiUpdatedWithinDays,
      suumoFinalSubmitDryRun
    }, () => {
      // アラームを再設定
      chrome.runtime.sendMessage({ type: 'UPDATE_ALARM' });

      // SUUMO Discord Webhook URLをGASにも同期
      if (gasWebappUrl && suumoDiscordWebhookUrl) {
        fetch(gasWebappUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'set_suumo_webhook',
            api_key: gasApiKey,
            webhookUrl: suumoDiscordWebhookUrl
          })
        }).catch(err => console.warn('SUUMO Webhook URL同期失敗:', err));
      }

      const msg = document.getElementById('savedMsg');
      msg.style.display = 'block';
      setTimeout(() => { msg.style.display = 'none'; }, 2000);
    });
  });

  // 接続テスト
  document.getElementById('testBtn').addEventListener('click', async () => {
    const resultEl = document.getElementById('testResult');
    resultEl.className = '';
    resultEl.style.display = 'none';
    resultEl.textContent = 'テスト中...';
    resultEl.style.display = 'block';

    const gasUrl = document.getElementById('gasUrl').value.trim();
    const apiKey = document.getElementById('apiKey').value.trim();

    if (!gasUrl) {
      resultEl.className = 'error';
      resultEl.textContent = 'GAS URLを入力してください';
      return;
    }

    try {
      const url = `${gasUrl}?action=status&api_key=${encodeURIComponent(apiKey)}`;
      const resp = await fetch(url, { redirect: 'follow' });
      const json = await resp.json();

      if (json.status === 'ok') {
        resultEl.className = 'success';
        resultEl.textContent = '接続成功';
      } else {
        resultEl.className = 'error';
        resultEl.textContent = '応答エラー: ' + JSON.stringify(json);
      }
    } catch (err) {
      resultEl.className = 'error';
      resultEl.textContent = '接続失敗: ' + err.message;
    }
  });

  // ForRent 停止テスト実行
  const forrentStopBtn = document.getElementById('forrentStopTestBtn');
  if (forrentStopBtn) {
    forrentStopBtn.addEventListener('click', () => {
      const codeInput = document.getElementById('forrentStopTestCode');
      const resultEl = document.getElementById('forrentStopTestResult');
      const dryRun = !!(document.getElementById('suumoForrentStopDryRun') || {}).checked;
      const code = (codeInput.value || '').trim().replace(/[^0-9]/g, '');
      if (!resultEl) return;
      if (!code) {
        resultEl.textContent = 'SUUMO物件コード(12桁)を入力してください';
        resultEl.style.color = '#dc2626';
        return;
      }
      if (code.length !== 12) {
        resultEl.textContent = `物件コードは12桁である必要があります(入力: ${code.length}桁)`;
        resultEl.style.color = '#dc2626';
        return;
      }
      // 本番実行時は最終確認ダイアログ
      if (!dryRun) {
        const confirmed = window.confirm(`⚠️ ドライランOFFで実行します。\n\n物件コード ${code} を ForRent で本当に「保留」に切り替えます。\n\n実行してよろしいですか？`);
        if (!confirmed) {
          resultEl.textContent = 'キャンセルされました';
          resultEl.style.color = '#6b7280';
          return;
        }
      }
      resultEl.textContent = (dryRun ? 'ドライラン実行中...' : '本番実行中...') + '(数十秒かかります)';
      resultEl.style.color = '#374151';
      forrentStopBtn.disabled = true;
      chrome.runtime.sendMessage({ type: 'FORRENT_STOP_TEST', suumoPropertyCode: code, dryRun: dryRun }, (response) => {
        forrentStopBtn.disabled = false;
        if (chrome.runtime.lastError) {
          resultEl.textContent = 'エラー: ' + chrome.runtime.lastError.message;
          resultEl.style.color = '#dc2626';
          return;
        }
        if (!response) {
          resultEl.textContent = '応答なし';
          resultEl.style.color = '#dc2626';
          return;
        }
        if (response.ok) {
          if (response.dryRun) {
            resultEl.textContent = 'ドライラン完了: 一括更新実行の直前で停止しました。開いているタブで目視確認してください';
            resultEl.style.color = '#065f46';
          } else if (response.alreadyStopped) {
            resultEl.textContent = '既に保留状態でした(何もせず終了)';
            resultEl.style.color = '#065f46';
          } else {
            resultEl.textContent = `本番実行完了: ${response.warning || '正常終了'}`;
            resultEl.style.color = response.warning ? '#f59e0b' : '#065f46';
          }
        } else {
          resultEl.textContent = '失敗: ' + (response.error || '不明なエラー');
          resultEl.style.color = '#dc2626';
        }
      });
    });
  }

  // ForRent状態同期 (PUB1R2801直読み)
  const forrentSyncBtn = document.getElementById('forrentStatusSyncBtn');
  if (forrentSyncBtn) {
    forrentSyncBtn.addEventListener('click', () => {
      const resultEl = document.getElementById('forrentStatusSyncResult');
      if (resultEl) {
        resultEl.textContent = 'ForRent PUB1R2801 から現在の成約状態を取得中...(数十秒)';
        resultEl.style.color = '#374151';
      }
      forrentSyncBtn.disabled = true;
      chrome.runtime.sendMessage({ type: 'SUUMO_FORRENT_STATUS_SYNC' }, (response) => {
        forrentSyncBtn.disabled = false;
        if (!resultEl) return;
        if (chrome.runtime.lastError) {
          resultEl.textContent = 'エラー: ' + chrome.runtime.lastError.message;
          resultEl.style.color = '#dc2626';
          return;
        }
        if (response && response.ok) {
          const r = response.result || {};
          resultEl.textContent = `完了: 取得${response.count}件 / stopped化=${r.stopped || 0} 復活=${r.reactivated || 0} 未マッチ=${r.unmatched || 0}`;
          resultEl.style.color = '#065f46';
        } else {
          resultEl.textContent = '失敗: ' + ((response && response.error) || '不明なエラー');
          resultEl.style.color = '#dc2626';
        }
      });
    });
  }

  // SUUMOビジネス ログインブロック解除
  const unblockBtn = document.getElementById('suumoBusinessUnblockBtn');
  if (unblockBtn) {
    unblockBtn.addEventListener('click', () => {
      chrome.storage.local.remove(['suumoBusinessLoginBlocked', 'suumoBusinessLoginBlockedReason'], () => {
        const blockedEl = document.getElementById('suumoBusinessLoginBlockedStatus');
        if (blockedEl) {
          blockedEl.textContent = '✓ ブロックなし(解除済み)';
          blockedEl.style.color = '#065f46';
        }
      });
    });
  }

  // SUUMOビジネス データ取得(手動実行ボタン)
  const suumoBusinessBtn = document.getElementById('suumoBusinessFetchBtn');
  if (suumoBusinessBtn) {
    suumoBusinessBtn.addEventListener('click', () => {
      const resultEl = document.getElementById('suumoBusinessFetchResult');
      if (resultEl) {
        resultEl.textContent = 'SUUMOビジネスを開いてデータ取得中...(数十秒かかることがあります)';
        resultEl.style.color = '#374151';
      }
      suumoBusinessBtn.disabled = true;
      chrome.runtime.sendMessage({ type: 'SUUMO_BUSINESS_FETCH_NOW' }, (response) => {
        suumoBusinessBtn.disabled = false;
        if (!resultEl) return;
        if (chrome.runtime.lastError) {
          resultEl.textContent = 'エラー: ' + chrome.runtime.lastError.message;
          resultEl.style.color = '#dc2626';
          return;
        }
        if (response && response.ok) {
          const r = response.result || {};
          const fmt = (v) => (v === undefined || v === null) ? '?' : v;
          resultEl.textContent = `完了: 送信${response.count}件 / GAS更新${fmt(r.updated)}件・新規${fmt(r.inserted)}件`;
          resultEl.style.color = '#065f46';
        } else {
          resultEl.textContent = '失敗: ' + ((response && response.error) || '不明なエラー');
          resultEl.style.color = '#dc2626';
        }
      });
    });
  }
});
