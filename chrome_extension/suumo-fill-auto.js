/**
 * suumo-fill-auto.js — ForRent自動入稿（content script）
 *
 * ForRent管理画面（www.fn.forrent.jp）のiframe内で動作する。
 * chrome.storage.local の suumoFillQueue から承認済み物件を取得し、
 * フォームに自動入力→保存まで実行する。
 *
 * 既存の suumo-competitor-checker/suumo-fill.js のロジックを移植。
 * 差異: 手動ボタン→キュー駆動、chrome.storage.local→メッセージ経由
 *
 * manifest.json content_scripts:
 *   matches: ["https://www.fn.forrent.jp/fn/*"]
 *   all_frames: true
 */

(function () {
  'use strict';

  // ForRentは<frameset>構造:
  //   トップ: frameset (bodyなし)
  //   frame[name=navi]: ナビバー
  //   frame[name=main]: メインコンテンツ（入力フォームがここ）
  //
  // content script は all_frames:true で全フレームにロードされる。
  // mainフレーム内でキュー監視＋フォーム入力の両方を行う。

  const isTopFrame = (window.top === window);
  const isNaviFrame = (window.name === 'navi');
  const isMainFrame = (window.name === 'main');

  // ── ログインページ検知＆自動ログイン ──
  // ログインページはframeset構造ではなく単純なページ（isTopFrame === true）
  // login.action へPOSTするフォームがあればログインページと判定
  if (isTopFrame) {
    const loginForm = document.querySelector('form[action*="login.action"]');
    const loginIdInput = document.querySelector('input[name="${loginForm.loginId}"]');
    if (loginForm && loginIdInput) {
      console.log('[SUUMO自動入稿] ログインページ検知');
      // ?suumo_fill=true または suumoFillModeフラグがあれば自動ログイン
      const urlHasFillParam = window.location.href.includes('suumo_fill=true');
      chrome.storage.local.get(['forrentLoginId', 'forrentPassword', 'suumoFillMode'], (data) => {
        const shouldAutoLogin = urlHasFillParam || data.suumoFillMode;
        if (!shouldAutoLogin) {
          console.log('[SUUMO自動入稿] 手動アクセスのログインページ → スキップ');
          return;
        }
        if (data.forrentLoginId && data.forrentPassword) {
          console.log('[SUUMO自動入稿] 自動ログイン実行');
          // ログイン後に?suumo_fill=trueが消えるので、フラグで引き継ぐ
          // set完了を待ってからログインボタンをクリック
          chrome.storage.local.set({ suumoFillMode: true }, () => {
            console.log('[SUUMO自動入稿] suumoFillModeセット完了 → ログイン送信');
            loginIdInput.value = data.forrentLoginId;
            const pwInput = document.querySelector('input[name="${loginForm.password}"]');
            if (pwInput) pwInput.value = data.forrentPassword;
            const submitBtn = document.getElementById('Image7') || loginForm.querySelector('input[type="image"]');
            if (submitBtn) {
              setTimeout(() => submitBtn.click(), 300);
            }
          });
        } else {
          console.log('[SUUMO自動入稿] ForRent認証情報が未設定 → 手動ログインが必要');
        }
      });
      return;
    }
    // framesetのトップ（ログインページ以外）- 何もしない
    console.log('[SUUMO自動入稿] framesetトップ - スキップ');
    return;
  }

  if (isNaviFrame) {
    // ナビフレーム - スキップ
    console.log('[SUUMO自動入稿] naviフレーム - スキップ');
    return;
  }

  // mainフレーム or その他のフレーム → フォーム入力（キュー監視はトリガー時のみ）
  console.log('[SUUMO自動入稿] mainフレーム - スクリプト起動, URL:', window.location.href);
  // デバッグ用: DOMにマーカーを追加して読み込み確認
  if (document.body) {
    document.body.setAttribute('data-suumo-fill-auto', 'loaded-' + Date.now());
  }

  // キュー監視の二重起動防止フラグ
  let _monitorStarted = false;

  // suumoFillModeフラグがONならキュー監視を開始（ログイン後・承認後どちらでも）
  // フラグはbackground.jsまたはログインcontent scriptがセットする
  chrome.storage.local.get(['suumoFillMode'], (data) => {
    if (data.suumoFillMode) {
      console.log('[SUUMO自動入稿] suumoFillModeフラグ検知 → キュー監視開始 & 即時ポーリング');
      chrome.runtime.sendMessage({ type: 'SUUMO_QUEUE_POLL_NOW' }, (resp) => {
        console.log('[SUUMO自動入稿] 即時ポーリング結果:', resp);
      });
      initMainFrameMonitor();
    } else {
      // URLの?suumo_fill=trueもチェック（承認ページからの直接起動時）
      const topUrl = (() => {
        try { return window.top.location.href; } catch (e) { return window.location.href; }
      })();
      if (topUrl.includes('suumo_fill=true')) {
        console.log('[SUUMO自動入稿] ?suumo_fill=true 検知 → キュー監視開始');
        chrome.storage.local.set({ suumoFillMode: true });
        chrome.runtime.sendMessage({ type: 'SUUMO_QUEUE_POLL_NOW' }, (resp) => {
          console.log('[SUUMO自動入稿] 即時ポーリング結果:', resp);
        });
        initMainFrameMonitor();
      } else {
        console.log('[SUUMO自動入稿] 手動利用 → キュー監視スキップ');
      }
    }
  });

  // デバッグ用: ページコンテキストからのテストデータ受信
  window.addEventListener('message', async (event) => {
    if (event.data && event.data.type === 'SUUMO_TRIGGER_QUEUE_POLL') {
      // 即座にキューポーリングを実行
      chrome.runtime.sendMessage({ type: 'SUUMO_QUEUE_POLL_NOW' }, (resp) => {
        document.body.setAttribute('data-suumo-poll-result', JSON.stringify(resp || {}));
      });
      document.body.setAttribute('data-suumo-poll-triggered', Date.now().toString());
      return;
    }
    if (event.data && event.data.type === 'SUUMO_TEST_FILL') {
      console.log('[SUUMO自動入稿] テストデータ受信:', event.data.propertyData?.building_name);
      const normalized = normalizePropertyData(event.data.propertyData);
      try {
        await fillForrentForm(normalized, event.data.imageGenres || {}, event.data.featureIds || []);
        document.body.setAttribute('data-suumo-fill-result', 'success');
      } catch (err) {
        console.error('[SUUMO自動入稿] テスト入力エラー:', err);
        document.body.setAttribute('data-suumo-fill-result', 'error: ' + err.message);
      }
    }
  });

  // suumoFillModeがONになったらキュー監視を動的に開始
  // （既存ForRentタブに対してbackground.jsがフラグをセットした場合）
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.suumoFillMode && changes.suumoFillMode.newValue && !_monitorStarted) {
      console.log('[SUUMO自動入稿] suumoFillModeフラグ変更検知 → キュー監視開始');
      chrome.storage.local.set({ suumoFillMode: false });
      _monitorStarted = true;
      initMainFrameMonitor();
    }
  });

  // ── フォーム入力待機（レガシー: background.jsからのメッセージ経由） ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SUUMO_FILL_START') {
      const normalized = normalizePropertyData(msg.data);
      console.log('[SUUMO自動入稿] メッセージ経由フォーム入力開始:', normalized.building);
      fillForrentForm(normalized, msg.imageGenres, msg.featureIds || [])
        .then(() => sendResponse({ success: true }))
        .catch(err => {
          console.error('[SUUMO自動入稿] エラー:', err);
          sendResponse({ success: false, error: err.message });
        });
      return true;
    }
  });

  // ══════════════════════════════════════════════════════════
  //  itandi/ES-Square/いえらぶ → ForRent 形式 正規化
  // ══════════════════════════════════════════════════════════

  function normalizePropertyData(data) {
    if (!data) return {};

    // 既にREINS形式（building, room等のフィールド）ならそのまま返す
    if (data.building && data.addr1 && data.town) return data;

    const d = Object.assign({}, data);

    // ── 建物名・部屋番号 ──
    d.building = d.building || d.building_name || d.buildingName || d.property_name || d.propertyName || '';
    d.room = d.room || d.room_number || d.roomNumber || '';

    // ── 賃料（円→万円） ──
    if (typeof d.rent === 'number' && d.rent > 1000) {
      // 円単位 → 万円単位の文字列（例: 134000 → "13.4"）
      d.rent = (d.rent / 10000).toString();
    } else if (typeof d.rent === 'string') {
      // "13.4万" のような文字列から数値抽出
      const m = d.rent.match(/([\d.]+)/);
      if (m) {
        const v = parseFloat(m[1]);
        // 1000以上なら円単位と判断
        if (v > 1000) {
          d.rent = (v / 10000).toString();
        } else {
          d.rent = v.toString();
        }
      }
    }

    // ── 管理費（円→円テキスト or そのまま） ──
    if (typeof d.management_fee === 'number') {
      d.managementFee = d.management_fee > 0 ? d.management_fee + '円' : '';
      d.commonServiceFee = d.managementFee;
    } else {
      d.managementFee = d.managementFee || d.management_fee || d.commonServiceFee || '';
      d.commonServiceFee = d.commonServiceFee || d.managementFee;
    }

    // ── 敷金・礼金 ──
    // itandi形式: "1ヶ月" or "10万円" → そのまま使える
    d.deposit = d.deposit || '';
    d.gratuity = d.gratuity || d.key_money || '';

    // ── 物件種別 ──
    d.propertyType = d.propertyType || d.property_type || '';
    if (!d.propertyType && d.structure) {
      d.propertyType = /木造/.test(d.structure) ? 'アパート' : 'マンション';
    }

    // ── 住所パース ──
    if (!d.addr1 && d.address) {
      const parsed = parseAddress(d.address);
      d.pref = parsed.pref || d.pref || d.prefecture || '東京都';
      d.addr1 = parsed.city || '';      // 市区郡
      d.town = parsed.town || '';       // 町名
      d.chome = parsed.chome || '';     // 丁目
      d.addr3 = parsed.banchi || '';    // 番地
    }
    if (!d.pref) d.pref = d.pref || d.prefecture || '東京都';

    // ── 階数パース ──
    if (!d.floorsAbove && d.story_text) {
      const m = d.story_text.match(/(\d+)階建/);
      if (m) d.floorsAbove = m[1];
    }
    if (!d.floorLocation && d.floor_text) {
      // "3階" → "3", "B1階" → "B1"
      const m = d.floor_text.match(/(B?\d+)/);
      if (m) d.floorLocation = m[1];
    }

    // ── 間取りパース ──
    if (!d.madoriType && d.layout) {
      const layoutMatch = d.layout.match(/^(\d*)(ワンルーム|R|K|DK|SDK|LDK|SLDK|LK|SK|SLK)$/i);
      if (layoutMatch) {
        d.madoriRoomCount = layoutMatch[1] || '';
        d.madoriType = layoutMatch[2];
      } else {
        // 全角対応
        const hw = toHalfWidth(d.layout).toUpperCase();
        const layoutMatch2 = hw.match(/^(\d*)(R|K|DK|SDK|LDK|SLDK|LK|SK|SLK)$/);
        if (layoutMatch2) {
          d.madoriRoomCount = layoutMatch2[1] || '';
          d.madoriType = layoutMatch2[2];
        }
      }
    }

    // ── 面積 ──
    if (!d.usageArea && d.area) {
      d.usageArea = String(d.area);
    }

    // ── 築年月パース ──
    // itandi形式: building_age = "2010年3月(築16年)" or "新築"
    d.builtYear = d.builtYear || d.built_year || '';
    d.builtMonth = d.builtMonth || d.built_month || '';

    if (!d.builtYear && d.building_age) {
      const ageStr = String(d.building_age);

      // 新築判定: "新築" or "2025年7月(新築)"
      if (ageStr.includes('新築')) {
        d.isNewConstruction = true;
      }

      if (ageStr === '新築') {
        // 年月情報なし → builtYearは空のまま、新築フラグのみ
      } else {
        // "2010年3月(築16年)" → 西暦年・月を抽出
        const dateMatch = ageStr.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
        if (dateMatch) {
          d.builtYear = dateMatch[1];
          d.builtMonth = dateMatch[2];
        } else {
          // "2010年" のみ（月なし）
          const yearOnly = ageStr.match(/(\d{4})\s*年/);
          if (yearOnly) {
            d.builtYear = yearOnly[1];
          } else {
            // "築16年" → 築年数から逆算
            const ageOnly = ageStr.match(/(\d+)/);
            if (ageOnly) {
              const age = parseInt(ageOnly[1]);
              if (age < 100) {
                d.builtYear = String(new Date().getFullYear() - age);
              } else if (age > 1900) {
                d.builtYear = String(age);
              }
            }
          }
        }
      }
    }

    // ── 構造 ──
    d.structure = d.structure || '';

    // ── 交通情報パース ──
    if (!d.access || d.access.length === 0) {
      d.access = [];
      const mainStation = d.station_info || d.traffic || '';
      if (mainStation) {
        const parsed = parseStationInfo(mainStation);
        if (parsed) d.access.push(parsed);
      }
      if (d.other_stations && Array.isArray(d.other_stations)) {
        for (const s of d.other_stations) {
          const parsed = parseStationInfo(s);
          if (parsed) d.access.push(parsed);
        }
      }
    }

    // ── 画像 ──
    d.images = d.images || d.image_urls || [];

    // ── 設備 → features（カンマ区切り文字列） ──
    if (!d.features && d.facilities) {
      // facilities は改行区切りテキスト、カテゴリ行を除いてフラットにする
      const items = [];
      const lines = String(d.facilities).split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // カテゴリのみの行（末尾:）はスキップ
        if (trimmed.match(/[:：]$/)) continue;
        // 【カテゴリ】設備名 の形式 → カテゴリ部分を除去して設備名を抽出
        let content = trimmed;
        const bracketMatch = content.match(/^[■▼●]?【[^】]+】\s*(.*)/);
        if (bracketMatch) {
          content = bracketMatch[1];
          if (!content) continue; // カテゴリ名のみの行はスキップ
        } else if (content.match(/^[■▼●]/)) {
          // ■カテゴリ名 のみの行はスキップ
          if (!content.match(/[,、\/／]/)) continue;
        }
        // カン���・スラッシュ区切り���分解
        const parts = content.split(/[,、\/／]/);
        for (const p of parts) {
          const item = p.trim();
          if (item) items.push(item);
        }
      }
      d.features = items.join(',');
    }

    // ── ソース情報 ──
    d.sourceType = d.sourceType || d.source || '';
    d.sourceUrl = d.sourceUrl || d.url || '';

    // ── 保証会社 ──
    d.guaranteeCompany = d.guaranteeCompany || d.guarantee_info || '';

    console.log('[SUUMO自動入稿] 正規化結果:', JSON.stringify({
      building: d.building, room: d.room, rent: d.rent,
      pref: d.pref, addr1: d.addr1, town: d.town,
      floorsAbove: d.floorsAbove, floorLocation: d.floorLocation,
      madoriRoomCount: d.madoriRoomCount, madoriType: d.madoriType,
      access: d.access?.length, images: d.images?.length
    }));

    return d;
  }

  /**
   * 住所テキストをパースして分割
   * 例: "東京都三鷹市下連雀3-28-14" → { pref, city, town, chome, banchi }
   */
  function parseAddress(addr) {
    if (!addr) return {};
    let s = String(addr);
    const result = {};

    // 都道府県
    const prefMatch = s.match(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/);
    if (prefMatch) {
      result.pref = prefMatch[1];
      s = s.slice(prefMatch[1].length);
    }

    // 市区郡（「市」「区」「郡」で終わるもの。政令市の区は「○○市○○区」）
    const cityMatch = s.match(/^(.+?[市区郡])(.+?区)?/);
    if (cityMatch) {
      result.city = cityMatch[1] + (cityMatch[2] || '');
      s = s.slice(result.city.length);
    }

    // 残りから町名・丁目・番地を分離
    // パターン1: "下連雀3丁目28-14" or "下連雀３丁目28-14"
    // パターン2: "下連雀3-28-14"
    // パターン3: "下連雀三丁目28番14号"
    const townMatch = s.match(/^([^\d\uff10-\uff19]+?)([\d\uff10-\uff19])/);
    if (townMatch) {
      result.town = townMatch[1];
      s = s.slice(result.town.length);

      // 丁目があるか？
      // 全角数字を半角に変換してからパース
      s = s.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
      const chomeMatch = s.match(/^(\d+)丁目(.*)$/);
      if (chomeMatch) {
        result.chome = chomeMatch[1] + '丁目';
        result.banchi = chomeMatch[2].replace(/^[-ー]/, '');
      } else {
        // "3-28-14" → 丁目="3丁目", 番地="28-14"
        const parts = s.split(/[-ーー]/);
        if (parts.length >= 2) {
          result.chome = parts[0] + '丁目';
          result.banchi = parts.slice(1).join('-');
        } else {
          result.banchi = s;
        }
      }
    } else {
      // 町名が見つからない場合は残り全体を番地に
      result.town = s;
    }

    return result;
  }

  /**
   * 駅情報テキストをパース
   * 例: "JR中央線 三鷹 徒歩10分" → { line, station, walk }
   */
  function parseStationInfo(info) {
    if (!info) return null;
    const s = String(info);

    // パターン: "路線名 駅名 徒歩N分" or "路線名/駅名/徒歩N分"
    const walkMatch = s.match(/徒歩(\d+)分/);
    const walk = walkMatch ? walkMatch[1] : '';

    // 駅名の前の部分が路線名
    const parts = s.replace(/徒歩\d+分/, '').replace(/駅$/, '').trim().split(/[\s　]+/);
    let line = '', station = '';

    if (parts.length >= 2) {
      line = parts[0];
      station = parts[1].replace(/駅$/, '');
    } else if (parts.length === 1) {
      station = parts[0].replace(/駅$/, '');
    }

    if (!station) return null;
    return { line, station, walk };
  }

  // ══════════════════════════════════════════════════════════
  //  ForRent フォーム入力ロジック
  //  （suumo-competitor-checker/suumo-fill.js からの移植）
  // ══════════════════════════════════════════════════════════

  async function fillForrentForm(data, imageGenres, featureIds) {
    if (!data) throw new Error('物件データがありません');

    // ── 建物名 ──
    setInputById('bukkenNm', data.building || '');

    // ── 階数・部屋番号 ──
    const fieldMappings = [
      { id: 'kai', key: 'floorsAbove' },
      { id: 'chikaInput', key: 'floorsBelow' },
      { id: 'kaibubun', key: 'floorLocation' },
      { id: 'heyaNoInput', key: 'room' }
    ];
    fieldMappings.forEach(({ id, key }) => {
      if (data[key]) setInputById(id, data[key]);
    });

    // ── 物件種別 ──
    const buildingTypeMap = {
      'マンション': '01', 'アパート': '02', '一戸建て': '11',
      'テラス・タウンハウス': '16', 'その他': '99'
    };
    setSelectByName('${bukkenInputForm.bukkenShuCd}', buildingTypeMap[data.propertyType] || '');

    // ── 建物構造 ──
    if (data.structure) {
      const structureMap = {
        'RC': '01', 'RC造': '01', '鉄筋コンクリート': '01', '鉄筋コンクリート造': '01',
        'SRC': '02', 'SRC造': '02', '鉄骨鉄筋コンクリート': '02', '鉄骨鉄筋コンクリート造': '02',
        '木造': '05',
        '鉄骨造': '06', '鉄骨': '06', 'S造': '06',
        '軽量鉄骨': '07', '軽量鉄骨造': '07',
        'その他': '99'
      };
      const key = toHalfWidth(data.structure).trim();
      setSelectByName('${bukkenInputForm.kozoShuCd}', structureMap[key] || '');
    }

    // ── 築年月 ──
    if (data.builtYear) {
      setInputByIdWithEvents('Wareki2Seireki1', data.builtYear);
    }
    if (data.builtMonth) {
      const allMonthInputs = document.querySelectorAll('.getsuInput');
      allMonthInputs.forEach(input => {
        if (input.closest('tr')?.id === 'err9') {
          setInputWithEvents(input, String(data.builtMonth).padStart(2, '0'));
        }
      });
    }

    // ── 新築/中古/未入居 ──
    // デフォルトは中古(shinchikuKbnCd1=2)、新築の場合のみshinchikuKbnCd2(=1)に切替
    if (data.isNewConstruction) {
      const shinchikuRadio = document.getElementById('shinchikuKbnCd2');
      if (shinchikuRadio) {
        shinchikuRadio.checked = true;
        shinchikuRadio.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    // ── 住所（カスケード） ──
    await fillAddress(data);

    // ── 交通情報 ──
    fillTrafficInfo(data);

    // ── 賃料 ──
    if (data.rent) {
      const rentStr = String(data.rent);
      const [intPart, decPart] = rentStr.split('.');
      setInputByName('${bukkenInputForm.chinryo1}', intPart || '');
      setInputByName('${bukkenInputForm.chinryo2}', decPart || '0');
    }

    // ── 管理費 ──
    fillManagementFee(data);

    // ── 敷金・礼金 ──
    fillDepositAndKey(data);

    // ── 間取り ──
    fillLayout(data);

    // ── 専有面積 ──
    if (data.usageArea) {
      const [intPart, decPart] = data.usageArea.split('.');
      setInputById('mensekiIntegerInput', intPart || '');
      setInputById('mensekiDecimalInput', (decPart || '0').padEnd(2, '0'));
    }

    // ── 画像アップロード ──
    const imgDebug = {
      imagesType: typeof data.images,
      imagesIsArray: Array.isArray(data.images),
      imagesLength: data.images?.length || 0,
      imagesSample: Array.isArray(data.images) ? data.images.slice(0, 2).map(u => String(u).substring(0, 80)) : String(data.images).substring(0, 200),
      imageGenresType: typeof imageGenres,
      imageGenresKeys: imageGenres ? Object.keys(imageGenres) : null,
      imageGenresValues: imageGenres ? Object.values(imageGenres).slice(0, 5) : null,
    };
    document.body.setAttribute('data-suumo-img-debug', JSON.stringify(imgDebug));
    console.log('[SUUMO自動入稿] 画像デバッグ:', JSON.stringify(imgDebug));

    if (data.images && data.images.length > 0 && imageGenres && Object.keys(imageGenres).length > 0) {
      try {
        console.log('[SUUMO自動入稿] 画像アップロード開始:', data.images.length, '枚, ジャンル:', Object.keys(imageGenres).length, '件');
        await uploadImages(data.images, imageGenres);
        document.body.setAttribute('data-suumo-img-result', 'success');
        console.log('[SUUMO自動入稿] 画像アップロード完了');
      } catch (imgErr) {
        document.body.setAttribute('data-suumo-img-result', 'error: ' + imgErr.message);
        console.error('[SUUMO自動入稿] 画像アップロードエラー（続行）:', imgErr);
      }
    } else {
      document.body.setAttribute('data-suumo-img-result', 'skipped');
      console.warn('[SUUMO自動入稿] 画像スキップ');
    }

    // ── 設備チェック ──
    if (data.features) {
      fillFeatures(data.features);
    }
    // 承認ページで手動チェックされた設備IDも反映
    if (featureIds && featureIds.length > 0) {
      featureIds.forEach(id => {
        const cb = document.getElementById(id);
        if (cb && !cb.checked) {
          cb.checked = true;
        }
      });
    }

    // ── 損保（火災保険） ──
    fillSonpo(data);

    // ── その他初期費用 ──
    fillOtherInitialCosts(data);

    // ── その他月額費用 ──
    fillOtherMonthlyCosts(data);

    // ── 会社間流通のチェックを外す ──
    ['bukkenNmDispFlg', 'heyaNoDispFlg', 'heyaNoTokkiFlg', 'shosaiJushoDispFlg1', 'bukkenNmTokkiFlg'].forEach(id => {
      const cb = document.getElementById(id);
      if (cb && cb.checked) {
        cb.checked = false;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    // ── 入居予定: 相談 ──
    const nyukyoSodan = document.getElementById('nyukyoKbnCd2');
    if (nyukyoSodan) nyukyoSodan.checked = true;

    // ── 取引態様: 仲介先物 ──
    const torihikiSelect = document.getElementById('torihikiTaiyoKbnCd');
    if (torihikiSelect) {
      torihikiSelect.value = '4';
      torihikiSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ── 元付会社情報 ──
    // REINS: shougo/tel、他ソース: owner_company/owner_phone
    const ownerCompany = data.shougo || data.owner_company || '';
    const ownerPhone = data.tel || data.owner_phone || '';
    if (ownerCompany) {
      setInputByName('${bukkenInputForm.mototsukeGyoshaNm}', ownerCompany.slice(0, 30));
    }
    setInputByName('${bukkenInputForm.mototsukeTantoNm}', '元付担当者');
    if (ownerPhone) {
      setInputByName('${bukkenInputForm.mototsukeTelNo}', ownerPhone);
    }
    const dateInput = document.querySelector('input[name="${bukkenInputForm.mototsukeKakuninDate}"]');
    if (dateInput) {
      const today = new Date();
      dateInput.value = today.getFullYear() + '/' + String(today.getMonth() + 1).padStart(2, '0') + '/' + String(today.getDate()).padStart(2, '0');
    }

    // ── 掲載設定 ──
    const shijiIsizeSelect = document.getElementById('shijiIsize');
    if (shijiIsizeSelect) {
      shijiIsizeSelect.value = '1';
      shijiIsizeSelect.dispatchEvent(new Event('change'));
    }

    // ── キャッチコピー ──
    setInputById('netCatch', '★人気のデザイナーズ物件に空きが出ました★');
    setInputById('netFreeMemo', '★現地集合での内見可能★類似物件も一緒に内見可能★オンライン内見・オンライン契約可能★一人暮らしのお部屋探しなら当社にお任せください★まずはお気軽にお問い合わせください★');

    // ── フリーコメント ──
    const freeMemo = document.getElementById('freeMemo');
    if (freeMemo) {
      if (data.sourceType === 'reins') {
        freeMemo.value = 'REINS 物件番号: ' + (data.propertyNumber || '');
      } else if (data.sourceUrl) {
        freeMemo.value = data.sourceUrl;
      }
    }

    // ── 単身者: 可 ──
    const tanshinRadio = document.getElementById('tanshinKbnCd2');
    if (tanshinRadio) tanshinRadio.checked = true;

    // ── 契約条件（features + 個別フィールドから判定） ──
    fillContractConditions(data);

    // ── 定期借家 ──
    fillTeikiShakuya(data);

    // ── 保証会社 ──
    fillGuaranteeCompany(data);

    // ── 周辺環境ポップアップ→保存 ──
    // ※ 初期段階では自動保存をスキップ（手動確認のため）
    // await waitAndClickShuhenButton();

    console.log('[SUUMO自動入稿] フォーム入力完了（手動確認モード：保存は手動で行ってください）');
  }

  // ── 住所カスケード入力 ──
  async function fillAddress(data) {
    const prefSelect = document.getElementById('todofukenList');
    if (!prefSelect) return;

    // 都道府県コードを判定（デフォルト: 東京都=13）
    const prefCode = getPrefCode(data.pref || data.prefecture || '東京都');
    prefSelect.value = prefCode;
    prefSelect.dispatchEvent(new Event('change'));

    await waitFor(800);

    const citySelect = document.getElementById('shigunkuList');
    if (citySelect && data.addr1) {
      const cityOpt = findOptionByText(citySelect, data.addr1);
      if (cityOpt) {
        citySelect.value = cityOpt.value;
        citySelect.dispatchEvent(new Event('change'));

        await waitFor(800);

        const townSelect = document.getElementById('chosonList');
        if (townSelect && data.town) {
          const townOpt = findOptionByText(townSelect, data.town);
          if (townOpt) {
            townSelect.value = townOpt.value;
            townSelect.dispatchEvent(new Event('change'));

            await waitFor(800);

            const azaSelect = document.getElementById('azaList');
            if (azaSelect) {
              let azaOpt;
              if (!data.chome || data.chome.trim() === '') {
                azaOpt = Array.from(azaSelect.options).find(opt => opt.value === '000');
              } else {
                // まず完全一致で検索
                azaOpt = findOptionByText(azaSelect, data.chome);
                if (!azaOpt) {
                  // 「3丁目」→数字部分「3」を抽出し、全角変換して「３」でマッチ
                  const chomeNum = data.chome.replace(/[^\d]/g, '');
                  if (chomeNum) {
                    const zenNum = chomeNum.replace(/\d/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0xFEE0));
                    azaOpt = Array.from(azaSelect.options).find(opt => opt.text.trim() === zenNum || opt.text.trim() === chomeNum);
                  }
                }
              }
              if (azaOpt) {
                azaSelect.value = azaOpt.value;
                azaSelect.dispatchEvent(new Event('change'));

                await waitFor(1000);
                setInputById('banchiNm', data.addr3 || '');
              }
            }
          }
        }
      }
    }
  }

  // ── 交通情報 ──
  function fillTrafficInfo(data) {
    if (!data.access || data.access.length === 0) return;
    const maxTraffic = 3;
    for (let i = 0; i < Math.min(data.access.length, maxTraffic); i++) {
      const num = i === 0 ? '' : String(i + 1);
      const t = data.access[i];
      if (!t) continue;

      // station-data.js が読み込まれていれば路線・駅コードを補完
      let lineCode = t.lineCode || '';
      let stationCode = t.stationCode || '';
      if ((!lineCode || !stationCode) && window.stationData) {
        const match = findStationMatch(t.line || '', t.station || '');
        if (match) {
          if (!lineCode) lineCode = match.lineCode;
          if (!stationCode) stationCode = match.stationCode;
        }
      }

      setInputById('pkgEnsenNmDisp' + num, t.line || '');
      setInputById('pkgEnsenNm' + num, t.line || '');
      if (lineCode) {
        setInputByIdWithEvents('pkgEnsenCd' + num, lineCode);
      }

      setInputById('pkgEkiNmDisp' + num, t.station || '');
      setInputById('pkgEkiNm' + num, t.station || '');
      if (stationCode) {
        const code = stationCode.length > 5 ? stationCode.slice(-5) : stationCode;
        setInputByIdWithEvents('pkgEkiCd' + num, code);
      }

      const walkValue = (t.walk || '').replace(/[^\d]/g, '');
      setInputById('tohofun' + num, walkValue);

      const tohoRadio = document.getElementById('toho' + num) || document.getElementById('toho');
      if (tohoRadio) {
        tohoRadio.checked = true;
        tohoRadio.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // 表示制御: 「駅から」ブロックを表示、バス・車ブロックを非表示
      const ekimadeMap = { '': 'DEkimade', '2': 'DEkimade3', '3': 'DEkimade4' };
      const busteiMap = { '': 'DBustei', '2': 'DBustei3', '3': 'DBustei4' };
      const kurumaMap = { '': 'DKurumade', '2': 'DKurumade3', '3': 'DKurumade4' };

      const ekimadeDiv = document.getElementById(ekimadeMap[num]);
      if (ekimadeDiv) {
        ekimadeDiv.style.display = 'block';
        ekimadeDiv.style.visibility = 'visible';
        ekimadeDiv.classList.remove('defaultHidden');
      }
      const busDiv = document.getElementById(busteiMap[num]);
      const carDiv = document.getElementById(kurumaMap[num]);
      if (busDiv) busDiv.style.display = 'none';
      if (carDiv) carDiv.style.display = 'none';
    }
  }

  /**
   * station-data.js から路線名・駅名でコードを検索
   */
  function findStationMatch(lineName, stationName) {
    if (!window.stationData || !stationName) return null;

    // 路線名の正規化（全角→半角、ＪＲ削除など）
    const normLine = normalizeLine(lineName);
    const normStation = stationName.replace(/駅$/, '').trim();

    // 駅名で候補を絞り込み
    const candidates = window.stationData.filter(s =>
      s.stationName === normStation
    );

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // 路線名でさらに絞り込み
    if (normLine) {
      const lineMatch = candidates.find(s =>
        normalizeLine(s.lineName) === normLine ||
        s.lineName.includes(normLine) ||
        normLine.includes(s.lineName)
      );
      if (lineMatch) return lineMatch;
    }

    return candidates[0]; // 路線名マッチなしなら最初の候補
  }

  function normalizeLine(name) {
    return (name || '')
      .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/　/g, ' ')
      .replace(/^JR|^ＪＲ/, '')
      .replace(/線$/, '')
      .trim();
  }

  // ── 管理費 ──
  function fillManagementFee(data) {
    function parseYenToMan(str) {
      if (!str || str === 'なし') return null;
      const num = parseInt(str.replace(/[^\d]/g, ''), 10);
      if (isNaN(num)) return null;
      const man = num / 10000;
      const s = man.toString();
      const [intPart, decPart] = s.split('.');
      return { intPart, decPart: decPart || '0' };
    }

    function isNonZero(s) {
      if (!s) return false;
      const num = parseInt(s.replace(/[^\d]/g, ''), 10);
      return !isNaN(num) && num > 0;
    }

    const feeStr = isNonZero(data.commonServiceFee) ? data.commonServiceFee
                 : isNonZero(data.managementFee) ? data.managementFee : '';
    const parts = parseYenToMan(feeStr);
    const feeCheckbox = document.querySelector('input[name="${bukkenInputForm.kanrihiFlg}"]');

    if (parts) {
      if (feeCheckbox) {
        feeCheckbox.checked = true;
        feeCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      setInputByName('${bukkenInputForm.kanrihi1}', parts.intPart);
      setInputByName('${bukkenInputForm.kanrihi2}', parts.decPart);
    } else {
      if (feeCheckbox) {
        feeCheckbox.checked = false;
        feeCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  // ── 敷金・礼金 ──
  function fillDepositAndKey(data) {
    function parseVal(str) {
      if (!str || str === 'なし') return null;
      const num = parseFloat(str.replace(/[^\d.]/g, ''));
      if (isNaN(num)) return null;
      const unit = str.includes('万円') ? 'man' : str.includes('ヶ月') ? 'month' : null;
      if (!unit) return null;
      const [intPart, dec] = num.toFixed(1).split('.');
      return { intPart, decPart: (dec || '0').padEnd(1, '0'), unit };
    }

    // 礼金
    const reikin = parseVal(data.gratuity);
    const reikinFlg = document.getElementById('reikinFlg');
    const DReikin = document.getElementById('DReikin');
    if (reikin && reikinFlg) {
      reikinFlg.checked = true;
      if (DReikin) DReikin.style.visibility = 'visible';
      setInputByName('${bukkenInputForm.reikin1}', reikin.intPart);
      setInputByName('${bukkenInputForm.reikin2}', reikin.decPart);
      const kbnId = reikin.unit === 'month' ? 'reikinKbnCd1' : 'reikinKbnCd2';
      const radio = document.getElementById(kbnId);
      if (radio) radio.checked = true;
    } else if (reikinFlg) {
      reikinFlg.checked = false;
      if (DReikin) DReikin.style.visibility = 'hidden';
    }

    // 敷金
    const shikikin = parseVal(data.deposit);
    const shikikinFlg = document.getElementById('shikikinFlg');
    const DShikikin = document.getElementById('DShikikin');
    if (shikikin && shikikinFlg) {
      shikikinFlg.checked = true;
      if (DShikikin) DShikikin.style.visibility = 'visible';
      setInputByName('${bukkenInputForm.shikikin1}', shikikin.intPart);
      setInputByName('${bukkenInputForm.shikikin2}', shikikin.decPart);
      const kbnId = shikikin.unit === 'month' ? 'shikikinKbnCd1' : 'shikikinKbnCd2';
      const radio = document.getElementById(kbnId);
      if (radio) radio.checked = true;
    } else if (shikikinFlg) {
      shikikinFlg.checked = false;
      if (DShikikin) DShikikin.style.visibility = 'hidden';
    }
  }

  // ── 間取り ──
  function fillLayout(data) {
    const madoriType = toHalfWidth(data.madoriType || '').toUpperCase();
    const roomCount = (data.madoriRoomCount || '').match(/\d+/);
    const roomCountNum = roomCount ? roomCount[0] : '';

    const madoriSelect = document.querySelector('select[name="${bukkenInputForm.madoriTypeKbnCd}"]');
    const heyaCnt = document.getElementById('heyaCntInput');
    if (!madoriSelect || !heyaCnt) return;

    const typeMap = {
      'K': '02', 'DK': '03', 'SDK': '04', 'LDK': '05',
      'SLDK': '06', 'LK': '07', 'SK': '08', 'SLK': '09'
    };

    if (madoriType === 'ワンルーム' || madoriType === 'R') {
      heyaCnt.value = '';
      madoriSelect.value = '01';
    } else {
      heyaCnt.value = roomCountNum;
      madoriSelect.value = typeMap[madoriType] || '';
    }
  }

  // ── 画像アップロード ──
  async function uploadImages(images, genres) {
    // genres: { imageIndex: genreName }
    const genreToValue = {
      '外観': 'gaikan', 'リビング': '040101', 'その他部屋': '040102',
      'キッチン': '040103', 'バス': '040104', 'トイレ': '040105',
      '洗面': '040106', '収納': '040107', 'バルコニー': '040108',
      '庭': '040109', '玄関': '040110', 'セキュリティ': '040111',
      '設備': '040199', '眺望': '050101', 'エントランス': '030101',
      'ロビー': '030102', '駐車場': '030103', '共用部': '030199', 'その他': '999999'
    };

    // 間取り画像
    const madoriIdx = Object.keys(genres).find(k => genres[k] === '間取り');
    if (madoriIdx !== undefined && images[madoriIdx]) {
      await uploadToInput(images[madoriIdx], 'file_up_clientMadori');
    }

    // 外観画像
    const gaikanIdx = Object.keys(genres).find(k => genres[k] === '外観');
    if (gaikanIdx !== undefined && images[gaikanIdx]) {
      await uploadToInput(images[gaikanIdx], 'file_up_gaikan');
    }

    // リビング画像
    const livingIdx = Object.keys(genres).find(k => genres[k] === 'リビング');
    if (livingIdx !== undefined && images[livingIdx]) {
      await uploadToInputWithCategory(images[livingIdx], 'file_up_shitsunai', 'shitsunaiShashinCategory', '040101');
    }

    // その他の画像
    const otherTargets = [
      { fileId: 'file_up_shashin1', selectId: 'shashin1Category' },
      { fileId: 'file_up_shashin2', selectId: 'shashin2Category' },
      { fileId: 'file_up_shashin3', selectId: 'shashin3Category' },
      { fileId: 'file_up_tsuikaGazo1', selectId: 'tsuikaGazo1Category' },
      { fileId: 'file_up_tsuikaGazo2', selectId: 'tsuikaGazo2Category' },
      { fileId: 'file_up_tsuikaGazo3', selectId: 'tsuikaGazo3Category' },
      { fileId: 'file_up_tsuikaGazo4', selectId: 'tsuikaGazo4Category' },
      { fileId: 'file_up_tsuikaGazo5', selectId: 'tsuikaGazo5Category' },
      { fileId: 'file_up_tsuikaGazo6', selectId: 'tsuikaGazo6Category' },
      { fileId: 'file_up_tsuikaGazo7', selectId: 'tsuikaGazo7Category' },
      { fileId: 'file_up_tsuikaGazo8', selectId: 'tsuikaGazo8Category' },
    ];

    const otherIndexes = Object.keys(genres).filter(k =>
      !['間取り', '外観', 'リビング'].includes(genres[k])
    );

    for (let i = 0; i < otherIndexes.length && i < otherTargets.length; i++) {
      const idx = otherIndexes[i];
      const genre = genres[idx];
      const value = genreToValue[genre] || '999999';
      await uploadToInputWithCategory(images[idx], otherTargets[i].fileId, otherTargets[i].selectId, value);
    }
  }

  async function uploadToInput(imageUrl, inputId) {
    const input = document.getElementById(inputId);
    if (!input || !imageUrl) return;

    const file = await urlToFile(imageUrl, inputId + '.jpg');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function uploadToInputWithCategory(imageUrl, inputId, selectId, categoryValue) {
    await uploadToInput(imageUrl, inputId);
    const select = document.getElementById(selectId);
    if (select && categoryValue) {
      select.value = categoryValue;
      select.dispatchEvent(new Event('change'));
    }
  }

  async function urlToFile(url, filename) {
    if (url.startsWith('data:')) {
      return base64ToFile(url, filename);
    }
    // 画像URLは各ソースサイトのドメインにあるため、ForRentページから直接fetchすると
    // CORS/認証エラーになる。background service worker経由でfetchしてbase64で受け取る。
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'FETCH_IMAGE_AS_BASE64', url },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (response && response.ok) {
              resolve(response.dataUrl);
            } else {
              reject(new Error(response?.error || '画像取得失敗'));
            }
          }
        );
      });
      return base64ToFile(dataUrl, filename);
    } catch (bgErr) {
      console.warn('[SUUMO自動入稿] background経由画像取得失敗、直接fetchを試行:', bgErr.message);
      // フォールバック: 直接fetch（公開URLの場合は成功する可能性あり）
      const response = await fetch(url);
      const blob = await response.blob();
      return new File([blob], filename, { type: blob.type });
    }
  }

  function base64ToFile(base64, filename) {
    const arr = base64.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) u8arr[n] = bstr.charCodeAt(n);
    return new File([u8arr], filename, { type: mime });
  }

  // ── 設備チェックボックス ──
  function fillFeatures(featuresStr) {
    const featureList = featuresStr.split(',').map(f => f.trim());
    const featureMap = {
      // ■構造・工法・仕様
      'タワーマンション': '0231', 'タワー型マンション': '0231',
      'デザイナーズ': '0233', 'デザイナーズマンション': '0233', 'デザイナーズ物件': '0233',
      '分譲タイプ': '0256', '分譲賃貸': '0256',
      // ■階・フロア
      '最上階': '0305',
      // ■共用部
      'エレベータ': '0501', 'エレベーター': '0501', 'EV': '0501',
      'エレベーター2基': '0502', 'エレベータ2基': '0502',
      '宅配ボックス': '0517', '宅配BOX': '0517', '宅配ＢＯＸ': '0517',
      '24時間ゴミ出し可': '0527', '２４時間ゴミ出し可': '0527',
      '常時ゴミ出し可能': '0527', '敷地内ゴミ置き場': '0527', '敷地内ごみ置き場': '0527',
      'ゴミ出し24時間OK': '0527',
      // ■駐車・駐輪
      '平面駐車場': '0813',
      '自走式駐車場': '0814',
      '駐輪場': '0816', '駐輪場：有': '0816', '駐輪場あり': '0816',
      'バイク置き場': '0817', 'バイク置場': '0817', 'バイク置き場：有': '0817',
      // ■陽当たり・採光
      '南向き': '1001',
      '東南向き': '1002', '南東向き': '1002',
      '南西向き': '1003', '西南向き': '1003',
      '角住戸': '1007', '角部屋': '1007',
      '東南角住戸': '1008', '南東角住戸': '1008',
      '3方角住戸': '1009', '３方角住戸': '1009',
      '南西角住戸': '1010', '西南角住戸': '1010',
      '南面リビング': '1017',
      // ■庭
      '専用庭': '1108',
      // ■管理・防犯
      'オートロック': '1201', 'モニタ付オートロック': '1201',
      'モニター付きオートロック': '1201', 'オートロック付': '1201',
      '防犯カメラ': '1211',
      // ■間取り
      'ロフト': '1326', 'ロフト付き': '1326', 'ロフト付': '1326',
      'メゾネット': '1327',
      // ■キッチン
      'システムキッチン': '1401',
      '対面式キッチン': '1403', 'カウンターキッチン': '1403', '対面キッチン': '1403',
      'L字型キッチン': '1405', 'Ｌ字型キッチン': '1405',
      'アイランドキッチン': '1408',
      'ガスコンロ': '1412', 'ガスコンロ対応': '1412', 'ガスコンロ可': '1412',
      'ガスコンロ設置可': '1412',
      'ガスレンジ付': '1413', 'ガスレンジ付き': '1413',
      'ガスコンロ設置済み': '1413', 'ガスコンロ設置済': '1413',
      '2口コンロ': '1414', '２口コンロ': '1414', 'コンロ2口': '1414', 'コンロ２口': '1414',
      '3口以上コンロ': '1415', '３口以上コンロ': '1415', 'コンロ3口': '1415',
      'コンロ3口以上': '1415', 'コンロ３口以上': '1415',
      'IHクッキングヒーター': '1416', 'ＩＨクッキングヒーター': '1416', 'IHコンロ': '1416',
      '都市ガス': '1436', 'ガス：都市ガス': '1436',
      // ■浴室
      'バス・トイレ別': '1501', 'バストイレ別': '1501', 'Ｂ・Ｔ別': '1501',
      'BT別': '1501', 'ＢＴ別': '1501',
      '追焚機能': '1505', '追焚き機能': '1505', '追い焚き風呂': '1505',
      '追い焚き': '1505', '追焚': '1505', '追い焚き機能': '1505',
      '追焚機能浴室': '1505',
      '浴室乾燥機': '1507', '浴室乾燥': '1507',
      // ■トイレ
      '温水洗浄便座': '1603', 'ウォシュレット': '1603', 'シャワートイレ': '1603',
      // ■洗面所
      '洗面台': '1701', '洗面所独立': '1701', '独立洗面台': '1701',
      '洗面化粧台': '1701', '洗髪洗面化粧台': '1701', '独立洗面': '1701',
      // ■冷暖房・空調
      '床暖房': '1806',
      // ■バルコニー・テラス
      'バルコニー': '2001', 'ワイドバルコニー': '2001',
      'ルーフバルコニー': '2002',
      '南面バルコニー': '2005',
      '2面バルコニー': '2006', '２面バルコニー': '2006', 'バルコニー2面': '2006',
      'バルコニー２面': '2006',
      '両面バルコニー': '2008',
      // ■室内設備・仕様
      'フローリング': '2101',
      '室内洗濯機置場': '2129', '室内洗濯機置き場': '2129', '室内洗濯置場': '2129',
      '洗濯機置場（室内）': '2129',
      // ■収納
      'ウォークインクローゼット': '2204', 'ウォークインクロゼット': '2204', 'WIC': '2204',
      'ウォークインクローゼット2': '2205', 'ウォークインクロゼット2': '2205',
      'ウォークインクロゼット2ヶ所': '2205', 'ウォークインクローゼット2ヶ所': '2205',
      'ウォークスルークローゼット': '2206', 'ウォークスルークロゼット': '2206',
      'シューズボックス': '2207', '玄関収納': '2207', 'シューズBOX': '2207',
      'シューズインクローゼット': '2208', 'シューズWIC': '2208',
      '床下収納': '2221',
      'トランクルーム': '2223',
      // ■情報設備・回線
      'BS・CS': '2401', 'BS･CS': '2401', 'BS/CS': '2401', 'BS，CS': '2401', 'BSCS': '2401',
      'BS': '2402', 'BSアンテナ': '2402', 'BS端子': '2402',
      'CS': '2403', 'CSアンテナ': '2403',
      'CATV': '2404', 'ケーブルTV': '2404', 'ケーブルテレビ': '2404',
      'インターネット使用料無料': '2406', 'インターネット無料': '2406',
      'ネット使用料不要': '2406', 'ネット無料': '2406',
      '光ファイバー': '2410', '光回線': '2410', '光インターネット': '2410',
      'CATVインターネット': '2411',
      'モニター付きインターホン': '2414', 'モニタ付インターホン': '2414',
      'モニター付インターホン': '2414',
      'ＴＶインターホン': '2414', 'TVインターホン': '2414',
      'TVモニターホン': '2414', 'テレビモニタ付インターホン': '2414',
      // ■リフォーム
      'リノベーション': '2609', 'リノベーション物件': '2609',
      // ■費用・入居・条件
      'ペット相談': '2705', 'ペット可': '2705', 'ペット相談可': '2705',
      '事務所使用可': '2710', '事務所相談': '2710', '事務所使用相談': '2710',
      '事務所相談可': '2710',
      // ■家具・家電
      'エアコン': '2801', 'エアコン付き': '2801', 'エアコン付': '2801',
      'エアコン2台': '2802', 'エアコン２台': '2802',
    };

    // 必須項目は常にチェック
    ['3001', '0233', '2737', '2801'].forEach(id => {
      const cb = document.getElementById(id);
      if (cb) cb.checked = true;
    });

    featureList.forEach(name => {
      const id = featureMap[name];
      if (id) {
        const cb = document.getElementById(id);
        if (cb) cb.checked = true;
      }
    });
  }

  // ── 損保（火災保険） ──
  function fillSonpo(data) {
    const raw = data.fire_insurance || data.fireInsurance;
    if (!raw || raw === 'なし' || raw === '0' || raw === '0円') return;

    const rawStr = String(raw);

    // 「2年間 16,550円」→ 年数と金額を分離してパース
    let years = 2; // デフォルト2年
    let amountYen = 0;

    // 年数を抽出: 「2年間」「2年」
    const yearMatch = rawStr.match(/(\d+)\s*年/);
    if (yearMatch) years = parseInt(yearMatch[1]);

    // 金額を抽出: 「16,550円」「16550」— 年数部分を除いた後の数値
    // 「円」の前の数値、またはカンマ区切り数値を探す
    const amountMatch = rawStr.match(/([\d,]+)\s*円/);
    if (amountMatch) {
      amountYen = parseFloat(amountMatch[1].replace(/,/g, ''));
    } else {
      // 「円」がない場合：年数部分を除去してから数値を取得
      const withoutYears = rawStr.replace(/\d+\s*年\s*(間\s*)?/, '');
      amountYen = parseFloat(withoutYears.replace(/[^\d.]/g, ''));
    }

    if (isNaN(amountYen) || amountYen <= 0) return;

    // 万円に変換（正確な値をそのまま入力）
    const manYen = amountYen / 10000;
    const intPart = String(Math.floor(manYen));
    // 小数部をそのまま: 16550円→1.655万円→小数部"655"
    const remainder = amountYen % 10000;
    const decPart = remainder > 0 ? String(remainder) : '0';

    const sonpoFlg = document.getElementById('sonpoFlg');
    if (sonpoFlg) {
      sonpoFlg.checked = true;
      if (typeof sonpoFlg.onclick === 'function') sonpoFlg.onclick();
      // 表示切替
      const sonpoDiv = sonpoFlg.closest('tr')?.querySelector('[id*="Sonpo"], [id*="sonpo"]')
        || document.getElementById('DSonpo');
      if (sonpoDiv) { sonpoDiv.style.display = 'block'; sonpoDiv.style.visibility = 'visible'; }
    }

    // IDが無いのでname属性で取得
    const kingaku1 = document.querySelector('input[name="${bukkenInputForm.sonpoKingaku1}"]');
    const kingaku2 = document.querySelector('input[name="${bukkenInputForm.sonpoKingaku2}"]');
    if (kingaku1) kingaku1.value = intPart;
    if (kingaku2) kingaku2.value = decPart.replace(/0+$/, '') || '0';

    // 契約年数
    const keiyakuCnt = document.querySelector('input[name="${bukkenInputForm.sonpoKeiyakuCnt}"]');
    if (keiyakuCnt) keiyakuCnt.value = String(years);

    console.log('[SUUMO自動入稿] 損保:', amountYen, '円 →', intPart + '.' + decPart, '万円, 契約年数:', years, '年');
  }

  // ── その他初期費用 ──
  function fillOtherInitialCosts(data) {
    const items = [];
    const addItem = (name, val) => {
      if (!val || val === 'なし' || val === '0' || val === '0円') return;
      const num = parseFloat(String(val).replace(/[^\d.]/g, ''));
      if (isNaN(num) || num <= 0) return;
      items.push({ name, amount: num, text: String(val) });
    };

    addItem('鍵交換費用', data.key_exchange_fee || data.keyExchangeFee);
    addItem('クリーニング費', data.cleaning_fee || data.cleaningFee);
    // 火災保険は損保セクションで処理するためここでは除外
    if (data.other_onetime_fee || data.otherOneTimeFee) {
      addItem('その他', data.other_onetime_fee || data.otherOneTimeFee);
    }
    // REINS形式互換
    for (let i = 1; i <= 5; i++) {
      if (data['otherFeeName' + i]) addItem(data['otherFeeName' + i], data['otherFeeAmount' + i]);
    }

    if (items.length === 0) return;

    const totalAmount = items.reduce((sum, i) => sum + i.amount, 0);
    // ForRentは万円単位
    const manYen = totalAmount / 10000;
    const [intPart, decPart] = manYen.toFixed(2).split('.');
    const detailText = items.map(i => `${i.name} ${i.text}`).join('\n');

    const etcFlg = document.getElementById('etcHiyoFlg');
    const etcDiv = document.getElementById('DEtcHiyo');
    const etcDetail = document.getElementById('DEtcHiyoShosai');
    const inputs = document.querySelectorAll('#DEtcHiyo input.kingakuMInput, #DEtcHiyo input.kingakuLInput');
    const etcTotal1 = inputs[0] || null;
    const etcTotal2 = inputs[1] || null;
    const etcTextarea = document.getElementById('etcHiyoShosaiInput');

    if (etcFlg) {
      etcFlg.checked = true;
      if (etcDiv) { etcDiv.style.display = 'block'; etcDiv.style.visibility = 'visible'; }
      if (etcDetail) { etcDetail.style.display = 'block'; etcDetail.style.visibility = 'visible'; }
      if (typeof etcFlg.onclick === 'function') etcFlg.onclick();
    }
    if (etcTotal1) etcTotal1.value = intPart;
    if (etcTotal2) etcTotal2.value = decPart;
    if (etcTextarea) etcTextarea.value = detailText;
  }

  // ── その他月額費用 ──
  function fillOtherMonthlyCosts(data) {
    const items = [];
    if (data.parking_fee || data.parkingFee) {
      const v = data.parking_fee || data.parkingFee;
      if (v !== 'なし' && v !== '0' && v !== '0円') items.push('駐車場 ' + v);
    }
    if (data.other_monthly_fee || data.otherMonthlyAmount) {
      const name = data.otherMonthlyName || 'その他';
      const v = data.other_monthly_fee || data.otherMonthlyAmount;
      if (v && v !== 'なし') items.push(name + ' ' + v);
    }
    if (data.otherMonthlyName2 && data.otherMonthlyAmount2) {
      items.push(data.otherMonthlyName2 + ' ' + data.otherMonthlyAmount2);
    }

    if (items.length === 0) return;

    const flg = document.getElementById('etcShohiyoFlg');
    const div = document.getElementById('DEtcShohiyoFlg');
    const textarea = document.getElementById('etcShohiyoShosaiInput');

    if (flg) {
      flg.checked = true;
      if (div) { div.style.display = 'block'; div.style.visibility = 'visible'; }
      if (typeof flg.onclick === 'function') flg.onclick();
    }
    if (textarea) textarea.value = items.join('\n');
  }

  // ── 保証会社 ──
  function fillGuaranteeCompany(data) {
    const text = data.guaranteeCompany || '指定保証会社加入要　条件により異なるため、お問い合わせください';
    const cb = document.getElementById('hoshoninDaikoFlg');
    if (cb && !cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event('click'));
    }
    const requiredRadio = document.getElementById('hoshoninDaikoKbnCd2');
    if (requiredRadio) requiredRadio.checked = true;
    const select = document.getElementById('hoshoninDaikoKaishaKbnCd');
    if (select) {
      select.value = '2';
      select.dispatchEvent(new Event('change'));
    }
    const textarea = document.getElementById('hoshoninDaikoShosai');
    if (textarea) textarea.value = text;
  }

  // ── 契約条件（二人入居・子供・ペット・楽器・事務所・ルームシェア・フリーレント） ──
  function fillContractConditions(data) {
    // facilities, move_in_conditions, free_rent から条件を判定
    const facilities = String(data.facilities || '');
    const moveIn = String(data.move_in_conditions || '');
    const combined = facilities + ' ' + moveIn;

    // --- 二人入居 ---
    // 「二人入居可」「2人入居可」「２人入居可」「二人入居(可)」「２人入居相談」
    if (/[二2２]人入居[可相]/.test(combined)) {
      const el = document.getElementById('futariKbnCd2'); // 可
      if (el) el.checked = true;
    }

    // --- 子供 ---
    // 「子供可」「子供(可)」→ 可にする。不可はチェックしない
    if (/子供[可(（]/.test(combined) && !/子供[不(（]不/.test(combined)) {
      // 子供(可) の判定: ES-Square形式 "子供(可)" or 単純 "子供可"
      if (/子供\(可\)/.test(combined) || /子供可/.test(combined)) {
        const el = document.getElementById('kodomoKbnCd2'); // 可
        if (el) el.checked = true;
      }
    }

    // --- ペット ---
    // 「ペット相談」「ペット可」「ペット相談可」「ペット対応」「猫可」「猫相談」
    // ペット不可は除外
    const petPositive = /ペット(相談|可|対応)|猫(可|相談)/.test(combined);
    const petNegative = /ペット不可|ペット\(不可\)/.test(combined);
    if (petPositive && !petNegative) {
      const el = document.getElementById('petKbnCd2'); // 相談
      if (el) {
        el.checked = true;
        // onclick="tokuchoToggle(this, '2705')" を発火
        el.click();
      }
    }

    // --- 楽器 ---
    // 「楽器相談」「楽器相談可」「楽器使用(可)」
    // 楽器不可・楽器使用(不可) は除外
    const gakkiPositive = /楽器(相談|可)|楽器使用\(可\)/.test(combined);
    const gakkiNegative = /楽器不可|楽器使用\(不可\)/.test(combined);
    if (gakkiPositive && !gakkiNegative) {
      const el = document.getElementById('gakkiKbnCd2'); // 相談
      if (el) {
        el.checked = true;
        // onclick="tokuchoToggle(this, '2711')" を発火
        el.click();
      }
    }

    // --- 事務所利用 ---
    // 「事務所使用可」「事務所(可)」→ 相談にする。不可はチェックしない
    const jimushoPositive = /事務所(使用可|利用可|\(可\))/.test(combined);
    const jimushoNegative = /事務所(使用不可|不可|\(不可\))/.test(combined);
    if (jimushoPositive && !jimushoNegative) {
      const el = document.getElementById('jimushoRiyoKbnCd2'); // 相談
      if (el) {
        el.checked = true;
        el.click();
      }
    }

    // --- ルームシェア ---
    // 「ルームシェア相談」「ルームシェア(可)」→ 相談にする。不可はチェックしない
    const rsPositive = /ルームシェア(相談|可|\(可\))/.test(combined);
    const rsNegative = /ルームシェア(不可|\(不可\))/.test(combined);
    if (rsPositive && !rsNegative) {
      const el = document.getElementById('roomShareKbnCd2'); // 相談
      if (el) {
        el.checked = true;
        el.click();
      }
    }

    // --- フリーレント ---
    const freeRent = String(data.free_rent || '');
    // facilitiesに「フリーレント」がある or free_rentフィールドに値がある（「無」「なし」以外）
    const hasFreeRent = /フリーレント/.test(facilities) ||
      (freeRent && !/^(無|なし|ー|-|0|)$/.test(freeRent.trim()));

    if (hasFreeRent) {
      // チェックボックスをON
      const cb = document.getElementById('freeRentFlg');
      if (cb && !cb.checked) {
        cb.checked = true;
        cb.click(); // onclickハンドラ発火
      }

      // 月数を抽出: 「該当2ヶ月」「1ヶ月間」「2ヶ月」「フリーレント1ヶ月」等
      let months = '';
      const monthMatch = (freeRent + ' ' + facilities).match(/(\d+)\s*[ヶケか]?\s*月/);
      if (monthMatch) {
        months = monthMatch[1];
      }

      if (months) {
        const input = document.getElementById('freeRentInput');
        if (input) input.value = months;
        // 「○ヶ月」ラジオ
        const kbnRadio = document.getElementById('freeRentKbnCd1');
        if (kbnRadio) kbnRadio.checked = true;
      }
    }

    console.log('[SUUMO自動入稿] 契約条件設定完了');
  }

  // ── 定期借家判定・期間/期限入力 ──
  function fillTeikiShakuya(data) {
    const leaseType = String(data.lease_type || '');
    const contractPeriod = String(data.contract_period || '');

    // 定期借家判定: lease_typeに「定期」を含む
    const isTeiki = /定期/.test(leaseType);

    if (!isTeiki) {
      // 普通借家（デフォルト）
      const normalRadio = document.getElementById('teikiShakuyaFlg0');
      if (normalRadio) normalRadio.checked = true;
      console.log('[SUUMO自動入稿] 普通借家');
      return;
    }

    // 定期借家をチェック
    const teikiRadio = document.getElementById('teikiShakuyaFlg1');
    if (teikiRadio) {
      teikiRadio.checked = true;
      teikiRadio.click(); // onclick ハンドラ発火（期間入力欄の表示切替）
    }

    if (!contractPeriod) {
      console.log('[SUUMO自動入稿] 定期借家（期間情報なし）');
      return;
    }

    // --- 期限モード判定: 「YYYY年M月まで」「YYYY/MM/DDまで」「YYYY年M月D日まで」等 ---
    // パターン1: 「2027年3月まで」「2027年03月まで」「2027年3月31日まで」
    const deadlineMatch1 = contractPeriod.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    // パターン2: 「2027/03/31まで」「2027-03-31」
    const deadlineMatch2 = contractPeriod.match(/(\d{4})[\/\-](\d{1,2})/);

    // 「まで」を含む or 西暦4桁で始まる → 期限モード
    const hasDeadlineKeyword = /まで/.test(contractPeriod);
    const startsWithYear = /^\d{4}[年\/\-]/.test(contractPeriod);

    if ((hasDeadlineKeyword || startsWithYear) && (deadlineMatch1 || deadlineMatch2)) {
      // 期限モード（○年○月まで）
      const match = deadlineMatch1 || deadlineMatch2;
      const year = match[1];
      const month = match[2];

      // 「指定なし」→期間ラジオの切替は不要（期限は teikiShakuyaKbnCd0 = 指定なし のまま年月を入れる）
      // 実際には「期間」ラジオを選択して期限として入力
      const kbnRadio = document.getElementById('teikiShakuyaKbnCd1');
      if (kbnRadio) {
        kbnRadio.checked = true;
        kbnRadio.click();
      }

      setInputByName('${bukkenInputForm.teikiShakuyaNen}', year);
      setInputByName('${bukkenInputForm.teikiShakuyaGetsu}', String(parseInt(month, 10)));

      console.log(`[SUUMO自動入稿] 定期借家（期限: ${year}年${month}月まで）`);
      return;
    }

    // --- 期間モード: 「2年」「3年6ヶ月」「2年間」「24ヶ月」等 ---
    let periodYear = 0;
    let periodMonth = 0;

    // 「N年Mヶ月」「N年M月」パターン
    const ymMatch = contractPeriod.match(/(\d+)\s*年\s*(\d+)\s*[ヶケか]?\s*月/);
    if (ymMatch) {
      periodYear = parseInt(ymMatch[1], 10);
      periodMonth = parseInt(ymMatch[2], 10);
    } else {
      // 「N年」パターン
      const yMatch = contractPeriod.match(/(\d+)\s*年/);
      if (yMatch) {
        periodYear = parseInt(yMatch[1], 10);
      }
      // 「Nヶ月」パターン（年なし）
      const mMatch = contractPeriod.match(/(\d+)\s*[ヶケか]?\s*月/);
      if (mMatch && !yMatch) {
        periodMonth = parseInt(mMatch[1], 10);
      }
    }

    if (periodYear > 0 || periodMonth > 0) {
      // 「期間」ラジオを選択
      const kbnRadio = document.getElementById('teikiShakuyaKbnCd1');
      if (kbnRadio) {
        kbnRadio.checked = true;
        kbnRadio.click();
      }

      setInputByName('${bukkenInputForm.teikiShakuyaNen}', String(periodYear));
      setInputByName('${bukkenInputForm.teikiShakuyaGetsu}', String(periodMonth));

      console.log(`[SUUMO自動入稿] 定期借家（期間: ${periodYear}年${periodMonth}ヶ月）`);
    } else {
      console.log(`[SUUMO自動入稿] 定期借家（期間パース失敗: "${contractPeriod}"）`);
    }
  }

  // ── 周辺環境ポップアップ → 保存ボタン ──
  async function waitAndClickShuhenButton() {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const btn = document.querySelector('#rakurakuShuhenKankyo');
        if (btn && !btn.disabled) {
          clearInterval(checkInterval);
          btn.click();
          // ポップアップ処理後、保存を試みる
          setTimeout(() => {
            clickSaveButton();
            resolve();
          }, 3000);
        }
      }, 500);

      // 30秒タイムアウト
      setTimeout(() => {
        clearInterval(checkInterval);
        clickSaveButton();
        resolve();
      }, 30000);
    });
  }

  function clickSaveButton() {
    // ForRentの保存ボタンを検索してクリック
    const saveBtn = document.querySelector('input[type="submit"][value*="保存"]') ||
                    document.querySelector('button[type="submit"]') ||
                    document.querySelector('#submitBtn');
    if (saveBtn) {
      console.log('[SUUMO自動入稿] 保存ボタンをクリック');
      saveBtn.click();
    } else {
      console.warn('[SUUMO自動入稿] 保存ボタンが見つかりません');
    }
  }

  // ══════════════════════════════════════════════════════════
  //  ユーティリティ
  // ══════════════════════════════════════════════════════════

  function setInputById(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value || '';
  }

  function setInputByIdWithEvents(id, value) {
    const el = document.getElementById(id);
    if (el) {
      el.focus();
      el.value = value || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    }
  }

  function setInputByName(name, value) {
    const el = document.querySelector('input[name="' + name + '"]');
    if (el) {
      el.value = value || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function setSelectByName(name, value) {
    const el = document.querySelector('select[name="' + name + '"]');
    if (el && value) {
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function setInputWithEvents(el, value) {
    el.focus();
    el.value = value || '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  function findOptionByText(select, text) {
    return Array.from(select.options).find(opt => opt.text.trim() === text);
  }

  function toHalfWidth(str) {
    return (str || '').replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/　/g, ' ');
  }

  function waitFor(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** 都道府県名からコードを返す */
  function getPrefCode(pref) {
    const prefMap = {
      '北海道': '01', '青森県': '02', '岩手県': '03', '宮城県': '04', '秋田県': '05',
      '山形県': '06', '福島県': '07', '茨城県': '08', '栃木県': '09', '群馬県': '10',
      '埼玉県': '11', '千葉県': '12', '東京都': '13', '神奈川県': '14',
      '新潟県': '15', '富山県': '16', '石川県': '17', '福井県': '18', '山梨県': '19',
      '長野県': '20', '岐阜県': '21', '静岡県': '22', '愛知県': '23', '三重県': '24',
      '滋賀県': '25', '京都府': '26', '大阪府': '27', '兵庫県': '28', '奈良県': '29',
      '和歌山県': '30', '鳥取県': '31', '島根県': '32', '岡山県': '33', '広島県': '34',
      '山口県': '35', '徳島県': '36', '香川県': '37', '愛媛県': '38', '高知県': '39',
      '福岡県': '40', '佐賀県': '41', '長崎県': '42', '熊本県': '43', '大分県': '44',
      '宮崎県': '45', '鹿児島県': '46', '沖縄県': '47'
    };
    return prefMap[pref] || '13';
  }

  // ══════════════════════════════════════════════════════════
  //  mainフレーム: 入稿キュー監視
  // ══════════════════════════════════════════════════════════

  let _suumoFillBusy = false;

/**
 * mainフレーム内でのキュー監視を初期化
 * ForRentは<frameset>構造のため、mainフレーム内で全て処理する
 */
function initMainFrameMonitor() {
  if (_monitorStarted) {
    console.log('[SUUMO自動入稿] 監視は既に開始済み');
    return;
  }
  _monitorStarted = true;
  console.log('[SUUMO自動入稿] mainフレーム監視を初期化（入稿モード）');

  // background.jsからのメッセージ受信
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SUUMO_NAVIGATE_NEW_REGISTRATION') {
      console.log('[SUUMO自動入稿] 新規物件登録へ遷移指示');
      clickNewRegistrationTab();
      sendResponse({ ok: true });
    }
  });

  // 5秒ごとにキューをチェック
  setInterval(checkFillQueue, 5000);
  // 初回チェック
  setTimeout(checkFillQueue, 2000);
}

/**
 * 「新規物件登録」タブリンクをクリック（mainフレーム内のナビ）
 */
function clickNewRegistrationTab() {
  // mainフレーム内のリンクを検索（textContentまたはtitle属性）
  const links = document.querySelectorAll('a');
  for (const link of links) {
    if (link.textContent.includes('新規物件登録') || link.title === '新規物件登録') {
      console.log('[SUUMO自動入稿] 「新規物件登録」をクリック');
      link.click();
      return true;
    }
  }
  // ナビフレーム経由（parent.navi）— 画像ベースメニューのためtitle属性で検索
  try {
    const naviFrame = window.parent?.frames?.navi;
    if (naviFrame) {
      const naviLinks = naviFrame.document.querySelectorAll('a');
      for (const link of naviLinks) {
        if (link.textContent.includes('新規物件登録') || link.title === '新規物件登録') {
          console.log('[SUUMO自動入稿] naviフレームの「新規物件登録」をクリック');
          link.click();
          return true;
        }
      }
    }
  } catch (e) { /* cross-origin */ }

  console.warn('[SUUMO自動入稿] 「新規物件登録」リンクが見つかりません');
  return false;
}

/**
 * 現在のmainフレームが新規物件登録フォームかどうか判定
 */
function isNewRegistrationPage() {
  // 物件名入力フィールドの存在で判定
  if (document.getElementById('bukkenNm')) return true;
  // 画像アップロード要素の存在で判定
  if (document.getElementById('gazoUploadInfo')) return true;
  // ページテキストで判定
  const pageText = document.body?.textContent || '';
  if (pageText.includes('新規物件登録') && pageText.includes('物件名')) return true;
  return false;
}

async function checkFillQueue() {
  if (_suumoFillBusy) return;

  const data = await new Promise(resolve => {
    chrome.storage.local.get(['suumoFillQueue'], resolve);
  });

  const queue = data.suumoFillQueue || [];
  // デバッグ: キュー状態をDOMに書き出し
  if (document.body) {
    document.body.setAttribute('data-suumo-queue', JSON.stringify({ len: queue.length, first: queue[0]?.building || queue[0]?.propertyData?.building_name || 'none', ts: Date.now() }));
  }
  if (queue.length === 0) return;

  const item = queue[0];
  console.log('[SUUMO自動入稿] キューに物件あり:', item.building || item.propertyData?.building_name);

  // 新規物件登録ページかチェック
  if (!isNewRegistrationPage()) {
    console.log('[SUUMO自動入稿] 新規登録ページではない → 「新規物件登録」をクリック');
    clickNewRegistrationTab();
    return;
  }

  console.log('[SUUMO自動入稿] 新規登録フォーム検出 → 入力開始');

  _suumoFillBusy = true;

  try {
    // キューから先頭を取り出す
    const remaining = queue.slice(1);
    await new Promise(resolve => {
      chrome.storage.local.set({ suumoFillQueue: remaining }, resolve);
    });

    const rawData = item.propertyData || item;
    // デバッグ: 正規化前のデータをDOMに書き出し
    if (document.body) {
      const rawKeys = Object.keys(rawData);
      const rawSample = {};
      for (const k of rawKeys) {
        const v = rawData[k];
        rawSample[k] = typeof v === 'string' ? v.substring(0, 100) : (typeof v === 'object' && v !== null ? (Array.isArray(v) ? `[${v.length}]` : '{...}') : v);
      }
      document.body.setAttribute('data-suumo-raw', JSON.stringify(rawSample));
    }
    const normalized = normalizePropertyData(rawData);
    // デバッグ: 正規化後のデータもDOMに書き出し
    if (document.body) {
      document.body.setAttribute('data-suumo-normalized', JSON.stringify({
        building: normalized.building, room: normalized.room, rent: normalized.rent,
        pref: normalized.pref, addr1: normalized.addr1, town: normalized.town,
        floorsAbove: normalized.floorsAbove, floorLocation: normalized.floorLocation,
        madoriRoomCount: normalized.madoriRoomCount, madoriType: normalized.madoriType,
        usageArea: normalized.usageArea, builtYear: normalized.builtYear,
        propertyType: normalized.propertyType, deposit: normalized.deposit,
        gratuity: normalized.gratuity, managementFee: normalized.managementFee,
        access: normalized.access?.length, structure: normalized.structure,
        features: (normalized.features || '').substring(0, 200),
        facilities: (normalized.facilities || '').substring(0, 100)
      }));
    }
    console.log('[SUUMO自動入稿] フォーム入力開始:', normalized.building || item.building || item.buildingName);

    // mainフレーム内で直接フォーム入力を実行
    await fillForrentForm(normalized, item.imageGenres || {}, item.featureIds || []);

    console.log('[SUUMO自動入稿] 入力完了');

    // 完了報告をbackground.jsに送信
    chrome.runtime.sendMessage({
      type: 'SUUMO_FILL_COMPLETE',
      data: {
        propertyKey: item.propertyKey || '',
        building: item.building || item.buildingName || '',
        room: item.room || item.roomNumber || '',
        success: true
      }
    });

  } catch (err) {
    console.error('[SUUMO自動入稿] エラー:', err);
    // エラー時もキューを復元しない（無限ループ防止）
    chrome.runtime.sendMessage({
      type: 'SUUMO_FILL_COMPLETE',
      data: {
        propertyKey: item.propertyKey || '',
        building: item.building || item.buildingName || '',
        room: item.room || item.roomNumber || '',
        success: false,
        error: err.message
      }
    });
  } finally {
    // 次の物件は保存ボタンクリック→ページリロード後に処理
    // リロード後に再度 checkFillQueue が走る
    _suumoFillBusy = false;
  }
}

})();
