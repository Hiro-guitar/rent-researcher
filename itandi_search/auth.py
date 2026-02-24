"""itandi BB ログイン・セッション管理 (Selenium 版)

itandi BB は OAuth2 Authorization Code フローを使用する。
itandibb.com は SPA のため、実ブラウザ (Selenium) でログインし、
ブラウザセッションをそのまま保持して API 呼び出しにも使用する。

1. Selenium で itandibb.com の物件ページにアクセス
   → 未ログインなら itandi-accounts.com にリダイレクト
2. ログインフォームにメール / パスワードを入力
3. ログインボタンをクリック → OAuth2 コールバックでセッション確立
4. ログイン後のブラウザセッションを保持
5. API 呼び出しは driver.execute_script() で fetch を実行
"""

import json
import urllib.parse

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException

from .config import ITANDI_BASE_URL


def _is_itandibb_host(url: str) -> bool:
    """URL のホスト部分が itandibb.com かどうか判定する。

    クエリパラメータ内の redirect_uri に含まれる itandibb.com に
    惑わされないよう、netloc のみをチェックする。
    """
    return "itandibb.com" in urllib.parse.urlparse(url).netloc


def _create_driver() -> webdriver.Chrome:
    """Headless Chrome ドライバーを生成する。"""
    options = Options()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--window-size=1280,1024")
    return webdriver.Chrome(options=options)


class ItandiAuthError(Exception):
    """itandi BB 認証エラー"""


class ItandiSession:
    """itandi BB のセッションを管理する。

    Selenium で実ブラウザログインし、そのドライバーを保持したまま
    execute_script() で API 呼び出しを行う。
    これにより、Cookie・セッション・CORS の問題を回避する。
    """

    def __init__(self, email: str, password: str) -> None:
        self.email = email
        self.password = password
        self.driver: webdriver.Chrome | None = None

    # ─── public ────────────────────────────────────────

    def login(self) -> bool:
        """Selenium でブラウザログインし、ドライバーを保持する。

        Returns:
            True: ログイン成功
        Raises:
            ItandiAuthError: ログイン失敗時
        """
        print("[INFO] Selenium でブラウザログインを開始...")

        self.driver = _create_driver()
        try:
            self._do_login(self.driver)
        except Exception:
            self.driver.quit()
            self.driver = None
            raise

        print("[INFO] itandi BB ログイン成功（ブラウザセッション保持）")
        return True

    def close(self) -> None:
        """ブラウザセッションを閉じる。"""
        if self.driver:
            self.driver.quit()
            self.driver = None

    def api_post(self, url: str, payload: dict) -> dict:
        """ブラウザの fetch() を使って API に POST リクエストを送信する。

        ブラウザのセッション（Cookie、CSRF トークン等）がそのまま使われるので、
        Python requests ライブラリとの互換性問題を回避できる。

        Args:
            url: API エンドポイント URL
            payload: JSON リクエストボディ

        Returns:
            API レスポンスの JSON dict

        Raises:
            ItandiAuthError: 認証エラー (401)
        """
        if not self.driver:
            raise ItandiAuthError("ブラウザセッションが初期化されていません")

        # itandibb.com にいることを確認（CORS 対策）
        current_url = self.driver.current_url
        if not _is_itandibb_host(current_url):
            print(f"[DEBUG] itandibb.com に遷移中... (現在: {current_url})")
            self.driver.get(f"{ITANDI_BASE_URL}/rent_rooms/list")
            import time
            time.sleep(2)

        # CSRF-TOKEN を Cookie から取得
        csrf_script = """
        var cookies = document.cookie.split(';');
        for (var i = 0; i < cookies.length; i++) {
            var c = cookies[i].trim();
            if (c.startsWith('CSRF-TOKEN=')) {
                return decodeURIComponent(c.substring('CSRF-TOKEN='.length));
            }
        }
        return '';
        """
        csrf_token = self.driver.execute_script(csrf_script)
        print(f"[DEBUG] CSRF-TOKEN (ブラウザから): 長さ={len(csrf_token)}")

        # JavaScript の fetch() で API を呼び出す
        # execute_async_script を使って Promise の完了を待つ
        payload_json = json.dumps(payload, ensure_ascii=False)
        async_script = """
        var callback = arguments[arguments.length - 1];
        var url = arguments[0];
        var body = arguments[1];
        var csrfToken = arguments[2];

        fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*',
                'X-CSRF-TOKEN': csrfToken,
                'Pragma': 'no-cache'
            },
            body: body
        })
        .then(function(response) {
            return response.text().then(function(text) {
                callback(JSON.stringify({
                    status: response.status,
                    statusText: response.statusText,
                    body: text
                }));
            });
        })
        .catch(function(error) {
            callback(JSON.stringify({
                status: 0,
                statusText: error.message,
                body: ''
            }));
        });
        """

        self.driver.set_script_timeout(30)
        result_str = self.driver.execute_async_script(
            async_script, url, payload_json, csrf_token
        )

        result = json.loads(result_str)
        status = result["status"]
        body_text = result["body"]

        print(f"[DEBUG] API レスポンス: status={status}")

        if status == 0:
            raise ItandiAuthError(
                f"API 通信エラー: {result['statusText']}"
            )

        if status == 401:
            raise ItandiAuthError("セッションが無効または期限切れです")

        if status != 200:
            print(f"[DEBUG] レスポンスボディ: {body_text[:500]}")

        return {
            "status": status,
            "body": json.loads(body_text) if body_text else {},
            "raw": body_text,
        }

    # ─── private ───────────────────────────────────────

    def _do_login(self, driver: webdriver.Chrome) -> None:
        """Selenium で itandi BB にログインする。

        参考コードと同じパターン: itandibb.com の物件ページに
        直接アクセス → 未ログインなら itandi-accounts.com にリダイレクト
        → ログインフォーム入力 → ログインボタンクリック
        """

        # Step 1: itandibb.com にアクセスしてログインページへリダイレクトさせる
        # ※ 参考コードのパターン: 物件URLに直接アクセスする
        entry_url = f"{ITANDI_BASE_URL}/rent_rooms/list"
        print(f"[DEBUG] Step 1: {entry_url} にアクセス...")
        driver.get(entry_url)

        current_url = driver.current_url
        print(f"[DEBUG] 現在のURL: {current_url}")

        # 既にログイン済みの場合
        if _is_itandibb_host(current_url):
            print("[DEBUG] 既にログイン済み")
            return

        # itandi-accounts.com のログインページにリダイレクトされたことを確認
        if "itandi-accounts.com" not in current_url:
            raise ItandiAuthError(
                f"予期しないページに遷移: {current_url}"
            )

        # Step 2: ログインフォームに入力
        # 参考コードと同じ: By.ID で email, password を取得、send_keys で入力
        print("[DEBUG] Step 2: ログインフォームに入力...")
        try:
            WebDriverWait(driver, 10).until(
                EC.presence_of_element_located((By.ID, "email"))
            )
            WebDriverWait(driver, 10).until(
                EC.presence_of_element_located((By.ID, "password"))
            )

            email_input = driver.find_element(By.ID, "email")
            password_input = driver.find_element(By.ID, "password")

            email_input.clear()
            email_input.send_keys(self.email)

            password_input.clear()
            password_input.send_keys(self.password)
        except TimeoutException as exc:
            raise ItandiAuthError(
                "ログインフォームの入力フィールドが見つかりませんでした"
            ) from exc

        # Step 3: ログインボタンをクリック
        # 参考コードと同じ: CSS_SELECTOR で submit ボタンを取得
        print("[DEBUG] Step 3: ログインボタンをクリック...")
        login_btn = driver.find_element(
            By.CSS_SELECTOR, 'input.filled-button[type="submit"]'
        )
        login_btn.click()

        # Step 4: ログイン後のリダイレクトを待つ
        # 参考コードと同じ: 「ログアウト」or「物件」テキストの出現を待つ
        print("[DEBUG] Step 4: ログイン後のリダイレクト待ち...")
        try:
            WebDriverWait(driver, 20).until(
                EC.presence_of_element_located(
                    (
                        By.XPATH,
                        "//*[contains(text(), 'ログアウト') or contains(text(), '物件')]",
                    )
                )
            )
        except TimeoutException:
            # タイムアウトした場合、現在の状態を確認
            current_url = driver.current_url
            print(f"[DEBUG] タイムアウト後のURL: {current_url}")
            print(f"[DEBUG] ページタイトル: {driver.title}")

            # エラーページの場合
            if "エラー" in driver.title:
                body_text = driver.find_element(By.TAG_NAME, "body").text
                print(f"[DEBUG] エラーページ本文: {body_text[:300]}")
                raise ItandiAuthError(
                    f"ログイン中にエラーが発生しました "
                    f"(URL: {current_url}, タイトル: {driver.title})"
                )

            # まだログインページにいる場合
            if (
                "itandi-accounts.com" in current_url
                and "login" in current_url
            ):
                body_text = driver.find_element(By.TAG_NAME, "body").text
                print(f"[DEBUG] ページ本文先頭500文字: {body_text[:500]}")
                raise ItandiAuthError(
                    f"ログインに失敗しました "
                    f"(URL: {current_url})"
                )

            raise ItandiAuthError(
                f"ログイン後に予期しないページ: {current_url}"
            )

        current_url = driver.current_url
        print(f"[DEBUG] ログイン成功後のURL: {current_url}")
        print(f"[DEBUG] ページタイトル: {driver.title}")
