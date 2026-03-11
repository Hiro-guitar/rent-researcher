"""いい生活Square ログイン・セッション管理 (Selenium 版)

いい生活Square は rent.es-square.net でホストされ、
認証は app.es-account.com に委譲される。
Selenium で headless Chrome ログインし、SSR ページを取得する。
"""

import time

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException

from .config import ESSQUARE_BASE_URL, ESSQUARE_LOGIN_URL


def _create_driver() -> webdriver.Chrome:
    """Headless Chrome ドライバーを生成する。"""
    options = Options()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--window-size=1280,1024")
    return webdriver.Chrome(options=options)


class EsSquareAuthError(Exception):
    """いい生活Square 認証エラー"""


class EsSquareSession:
    """いい生活Square のセッションを管理する。

    Selenium で実ブラウザログインし、そのドライバーを保持したまま
    SSR ページの HTML を取得する。
    """

    def __init__(self, email: str, password: str) -> None:
        self.email = email
        self.password = password
        self.driver: webdriver.Chrome | None = None

    def login(self) -> bool:
        """Selenium でブラウザログインし、ドライバーを保持する。"""
        print("[INFO] いい生活Square: Selenium ログインを開始...")

        self.driver = _create_driver()
        try:
            self._do_login(self.driver)
        except Exception:
            self.driver.quit()
            self.driver = None
            raise

        print("[INFO] いい生活Square ログイン成功")
        return True

    def close(self) -> None:
        """ブラウザセッションを閉じる。"""
        if self.driver:
            self.driver.quit()
            self.driver = None

    def get_page(self, url: str) -> str:
        """URL に遷移してページの HTML を返す。

        セッション切れの場合は再ログインしてリトライする。
        """
        if not self.driver:
            raise EsSquareAuthError("ブラウザセッションが初期化されていません")

        self.driver.get(url)
        time.sleep(3)  # SSR ページ読み込み待ち

        # ログインページにリダイレクトされた場合は再ログイン
        current_url = self.driver.current_url
        if "es-account.com" in current_url or "/login" in current_url:
            print("[INFO] セッション切れ検出、再ログイン中...")
            self._do_login(self.driver)
            self.driver.get(url)
            time.sleep(3)

        return self.driver.page_source

    def _do_login(self, driver: webdriver.Chrome) -> None:
        """Selenium でいい生活Square にログインする。"""
        # Step 1: ログインページにアクセス
        print(f"[DEBUG] Step 1: {ESSQUARE_LOGIN_URL} にアクセス...")
        driver.get(ESSQUARE_LOGIN_URL)
        time.sleep(3)

        current_url = driver.current_url
        print(f"[DEBUG] 現在のURL: {current_url}")

        # 既にログイン済みの場合
        if (ESSQUARE_BASE_URL in current_url
                and "/login" not in current_url):
            print("[DEBUG] 既にログイン済み")
            return

        # ログインページが表示された場合、「いい生活アカウントでログイン」
        # ボタンをクリックして es-account.com にリダイレクトする
        if "/login" in current_url and "es-account.com" not in current_url:
            print("[DEBUG] Step 1.5: ログインボタンをクリック...")
            try:
                login_redirect_btn = WebDriverWait(driver, 10).until(
                    EC.element_to_be_clickable((
                        By.XPATH,
                        '//button[contains(text(), "ログイン")]'
                    ))
                )
                login_redirect_btn.click()
                time.sleep(3)
            except TimeoutException:
                print("[WARN] ログインボタンが見つかりません")

        # es-account.com にリダイレクトされるのを待つ
        current_url = driver.current_url
        print(f"[DEBUG] ボタンクリック後のURL: {current_url}")
        if "es-account.com" not in current_url:
            for _ in range(10):
                time.sleep(1)
                current_url = driver.current_url
                if "es-account.com" in current_url:
                    break
                if (ESSQUARE_BASE_URL in current_url
                        and "/login" not in current_url):
                    print("[DEBUG] 既にログイン済み（リダイレクト後）")
                    return
            print(f"[DEBUG] リダイレクト後のURL: {current_url}")

        if "es-account.com" not in current_url:
            raise EsSquareAuthError(
                f"認証ページへのリダイレクトに失敗: {current_url}"
            )

        # Step 2: ログインフォームに入力
        print("[DEBUG] Step 2: ログインフォームに入力...")
        try:
            WebDriverWait(driver, 10).until(
                EC.presence_of_element_located((By.ID, "email"))
            )

            email_input = driver.find_element(By.ID, "email")
            email_input.clear()
            email_input.send_keys(self.email)

            password_input = driver.find_element(By.ID, "password")
            password_input.clear()
            password_input.send_keys(self.password)
        except TimeoutException as exc:
            raise EsSquareAuthError(
                "ログインフォームが見つかりませんでした"
            ) from exc

        # Step 3: ログインボタンをクリック
        print("[DEBUG] Step 3: ログインボタンをクリック...")
        try:
            login_btn = driver.find_element(
                By.CSS_SELECTOR,
                'button[type="submit"], input[type="submit"]'
            )
            login_btn.click()
        except Exception as exc:
            raise EsSquareAuthError(
                f"ログインボタンが見つかりませんでした: {exc}"
            ) from exc

        # Step 4: ログイン後のリダイレクトを待つ
        print("[DEBUG] Step 4: ログイン後のリダイレクト待ち...")
        try:
            WebDriverWait(driver, 20).until(
                lambda d: ESSQUARE_BASE_URL in d.current_url
                and "/login" not in d.current_url
            )
        except TimeoutException:
            current_url = driver.current_url
            print(f"[DEBUG] タイムアウト後のURL: {current_url}")

            if "es-account.com" in current_url:
                raise EsSquareAuthError(
                    f"ログインに失敗しました (URL: {current_url})"
                )
            raise EsSquareAuthError(
                f"ログイン後に予期しないページ: {current_url}"
            )

        print(f"[DEBUG] ログイン成功: {driver.current_url}")

    # ─── CDP / JavaScript ヘルパー ────────────────────────

    def setup_graphql_interceptor(self) -> None:
        """GraphQL レスポンスをキャプチャする fetch インターセプターを注入する。

        Page.addScriptToEvaluateOnNewDocument により、以降の全ページ遷移で
        自動的にインターセプターが挿入される。
        """
        if not self.driver:
            raise EsSquareAuthError("ブラウザセッションが初期化されていません")

        interceptor_script = """
        window.__esq_graphql = [];
        const _origFetch = window.fetch;
        window.fetch = function(...args) {
            return _origFetch.apply(this, args).then(async r => {
                try {
                    const url = typeof args[0] === 'string'
                        ? args[0]
                        : (args[0]?.url || '');
                    if (url.includes('graphql') || url.includes('appsync')) {
                        const clone = r.clone();
                        const data = await clone.json();
                        window.__esq_graphql.push({url: url, data: data});
                    }
                } catch(e) {}
                return r;
            });
        };
        """
        self.driver.execute_cdp_cmd(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": interceptor_script},
        )
        print("[DEBUG] ES-Square: GraphQL インターセプター設定完了")

    def execute_script(self, script: str) -> object:
        """JavaScript を実行して結果を返す。"""
        if not self.driver:
            raise EsSquareAuthError("ブラウザセッションが初期化されていません")
        return self.driver.execute_script(script)
