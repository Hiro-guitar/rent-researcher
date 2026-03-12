"""いい生活Square ログイン・セッション管理 (Selenium 版)

いい生活Square は rent.es-square.net でホストされ、
認証ページへのリダイレクトを利用してログインする。
Selenium で headless Chrome ログインし、ページソースを取得する。
"""

import time

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException

from .config import ESSQUARE_BASE_URL


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
        React SPA のハイドレーション問題を防ぐため、
        毎回 about:blank 経由でクリーンなページロードを行う。
        """
        if not self.driver:
            raise EsSquareAuthError("ブラウザセッションが初期化されていません")

        # SPA のメモリリーク・ハイドレーション失敗を防ぐため
        # about:blank で前ページのコンテキストを完全に破棄する
        self.driver.get("about:blank")
        time.sleep(0.5)

        self.driver.get(url)
        time.sleep(3)  # SPA 初期読み込み待ち

        # ログインページにリダイレクトされた場合は再ログイン
        current_url = self.driver.current_url
        if "es-account.com" in current_url or "/login" in current_url:
            print("[INFO] セッション切れ検出、再ログイン中...")
            self._do_login(self.driver)
            self.driver.get("about:blank")
            time.sleep(0.5)
            self.driver.get(url)
            time.sleep(3)

        return self.driver.page_source

    def _do_login(self, driver: webdriver.Chrome) -> None:
        """Selenium でいい生活Square にログインする。

        認証済みページに直接アクセスし、認証ページへのリダイレクトを利用する。
        /login ランディングページ経由ではなく、直接リダイレクト方式を使用。
        """
        # Step 1: 認証が必要なページにアクセス → 認証ページにリダイレクト
        target_url = f"{ESSQUARE_BASE_URL}/bukken/chintai/search"
        print(f"[DEBUG] Step 1: {target_url} にアクセス...")
        driver.get(target_url)
        time.sleep(5)  # React SPA + リダイレクト待ち

        current_url = driver.current_url
        print(f"[DEBUG] 現在のURL: {current_url}")

        # 既にログイン済みの場合
        if (ESSQUARE_BASE_URL in current_url
                and "/login" not in current_url):
            print("[DEBUG] 既にログイン済み")
            return

        # Step 2: ログインフォームに入力
        # フィールドIDは "username" (参考実装に基づく)
        # フォールバックとして "email" も試行する
        print("[DEBUG] Step 2: ログインフォームに入力...")
        try:
            # username または email フィールドが表示されるのを待つ
            WebDriverWait(driver, 15).until(
                lambda d: (d.find_elements(By.ID, "username")
                           or d.find_elements(By.ID, "email"))
            )

            # username フィールドを優先、なければ email
            username_fields = driver.find_elements(By.ID, "username")
            email_fields = driver.find_elements(By.ID, "email")

            if username_fields:
                user_input = username_fields[0]
                print("[DEBUG] フィールド: username")
            elif email_fields:
                user_input = email_fields[0]
                print("[DEBUG] フィールド: email")
            else:
                raise EsSquareAuthError(
                    "ログインフォームが見つかりませんでした"
                )

            user_input.clear()
            user_input.send_keys(self.email)

            password_input = driver.find_element(By.ID, "password")
            password_input.clear()
            password_input.send_keys(self.password)
        except TimeoutException:
            current_url = driver.current_url
            print(f"[DEBUG] フォーム待ちタイムアウト URL: {current_url}")
            raise EsSquareAuthError(
                f"ログインフォームが見つかりませんでした (URL: {current_url})"
            )

        # Step 3: 送信ボタンをクリック（「続ける」or submit ボタン）
        print("[DEBUG] Step 3: 送信ボタンをクリック...")
        try:
            submit_btn = driver.find_element(
                By.XPATH, '//button[@type="submit"]'
            )
            submit_btn.click()
        except Exception as exc:
            raise EsSquareAuthError(
                f"送信ボタンが見つかりませんでした: {exc}"
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
        """後方互換: setup_api_interceptor のエイリアス。"""
        self.setup_api_interceptor()

    def setup_api_interceptor(self) -> None:
        """全 fetch API レスポンスをキャプチャするインターセプターを注入する。

        Page.addScriptToEvaluateOnNewDocument により、以降の全ページ遷移で
        自動的にインターセプターが挿入される。

        キャプチャ対象:
        - JSON レスポンスを返す全ての fetch リクエスト
        - GraphQL / AppSync を含む全 API 呼び出し

        キャプチャ除外:
        - 画像・CSS・JS 等の静的リソース
        """
        if not self.driver:
            raise EsSquareAuthError("ブラウザセッションが初期化されていません")

        interceptor_script = """
        window.__esq_api = [];
        window.__esq_graphql = [];  // 後方互換
        window.__esq_img_fetches = [];  // 画像 fetch URL トラッキング

        (function() {
            var _origFetch = window.fetch;
            var SKIP_IMG = /logo|icon|favicon|avatar|badge|chatbot|miibo|okbiz/i;

            window.fetch = function() {
                var args = arguments;
                var url = typeof args[0] === 'string'
                    ? args[0]
                    : (args[0] && args[0].url ? args[0].url : '');

                return _origFetch.apply(this, args).then(function(r) {
                    try {
                        var ct = r.headers.get('content-type') || '';

                        // 画像 fetch をトラッキング (blob URL の元の HTTP URL)
                        if (ct.indexOf('image/') === 0
                            && !SKIP_IMG.test(url)
                            && url.indexOf('data:') !== 0) {
                            window.__esq_img_fetches.push(url);
                        }

                        // JSON API レスポンスをキャプチャ
                        var skip = /\\.(js|css|png|jpg|jpeg|gif|svg|woff|ico)/i;
                        if (!skip.test(url) && ct.indexOf('json') !== -1) {
                            var clone = r.clone();
                            clone.json().then(function(data) {
                                window.__esq_api.push({url: url, data: data});
                                if (url.indexOf('graphql') !== -1
                                    || url.indexOf('appsync') !== -1) {
                                    window.__esq_graphql.push(
                                        {url: url, data: data}
                                    );
                                }
                            }).catch(function() {});
                        }
                    } catch(e) {}
                    return r;
                });
            };
        })();
        """
        self.driver.execute_cdp_cmd(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": interceptor_script},
        )
        print("[DEBUG] ES-Square: API インターセプター設定完了")

    def execute_script(self, script: str) -> object:
        """JavaScript を実行して結果を返す。"""
        if not self.driver:
            raise EsSquareAuthError("ブラウザセッションが初期化されていません")
        return self.driver.execute_script(script)
