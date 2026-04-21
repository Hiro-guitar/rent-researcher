document.addEventListener('DOMContentLoaded', () => {
  // 保存済み設定を読み込み
  chrome.storage.local.get(['gasWebappUrl', 'gasApiKey', 'searchIntervalMinutes', 'pageDelaySeconds', 'discordWebhookUrl', 'suumoDiscordWebhookUrl', 'errorWebhookUrl', 'jitterPercent', 'businessStartHour', 'businessEndHour', 'notifyMode', 'btMode', 'forrentLoginId', 'forrentPassword', 'suumoCompSkipThresholds'], (data) => {
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
      suumoCompSkipThresholds
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
          resultEl.textContent = `完了: 送信${response.count}件 / GAS更新${r.updated || '?'}件・新規${r.inserted || '?'}件`;
          resultEl.style.color = '#065f46';
        } else {
          resultEl.textContent = '失敗: ' + ((response && response.error) || '不明なエラー');
          resultEl.style.color = '#dc2626';
        }
      });
    });
  }
});
