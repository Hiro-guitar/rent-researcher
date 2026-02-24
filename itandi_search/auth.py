"""itandi BB ログイン・セッション管理 (Selenium 版)

itandi BB は OAuth2 Authorization Code フローを使用する。
itandibb.com は SPA のため、実ブラウザ (Selenium) でログインし、
Cookie + CSRF トークンを取得する。

1. Selenium で itandibb.com の物件ページにアクセス
   → 未ログインなら itandi-accounts.com にリダイレクト
2. ログインフォームにメール / パスワードを入力
3. ログインボタンをクリック → OAuth2 コールバックでセッション確立
4. CSRF-TOKEN Cookie を取得 → API ヘッダーに使用
5. Cookie を requests.Session にコピーして API 呼び出しに使用
"""

import urllib.parse

import requests
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

    Selenium で実ブラウザログインし、取得した Cookie を
    requests.Session にコピーして API 呼び出しに使用する。
    """

    def __init__(self, email: str, password: str) -> None:
        self.email = email
        self.password = password
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/131.0.0.0 Safari/537.36"
                ),
            }
        )
        self.csrf_token: str | None = None

    # ─── public ────────────────────────────────────────

    def login(self) -> bool:
        """Selenium でブラウザログインし、API 用セッションを構築する。

        Returns:
            True: ログイン成功
        Raises:
            ItandiAuthError: ログイン失敗時
        """
        print("[INFO] Selenium でブラウザログインを開始...")

        driver = _create_driver()
        try:
            self._do_login(driver)
            self._extract_session(driver)
        finally:
            driver.quit()

        print("[INFO] itandi BB ログイン成功")
        return True

    def get_api_headers(self) -> dict[str, str]:
        """API リクエスト用ヘッダーを返す。"""
        return {
            "X-CSRF-TOKEN": self.csrf_token or "",
            "Content-Type": "application/json",
            "Accept": "application/json, text/plain, */*",
            "Origin": ITANDI_BASE_URL,
            "Referer": f"{ITANDI_BASE_URL}/",
            "Pragma": "no-cache",
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

    def _extract_session(self, driver: webdriver.Chrome) -> None:
        """Selenium ドライバーから Cookie を取得し requests.Session にコピー。"""

        # itandibb.com のページにいることを確認
        current_url = driver.current_url
        if not _is_itandibb_host(current_url):
            # itandibb.com にアクセスして Cookie を取得
            print("[DEBUG] itandibb.com に遷移してCookie取得...")
            driver.get(f"{ITANDI_BASE_URL}/rent_rooms/list")
            import time
            time.sleep(3)

        cookies = driver.get_cookies()
        print(f"[DEBUG] 取得した Cookie 数: {len(cookies)}")

        cookie_names = [c["name"] for c in cookies]
        print(f"[DEBUG] Cookie 名一覧: {cookie_names}")
        cookie_domains = list({c.get("domain", "") for c in cookies})
        print(f"[DEBUG] Cookie ドメイン一覧: {cookie_domains}")

        csrf_found = False
        for cookie in cookies:
            # requests.Session に Cookie をコピー
            # ドメインを .itandibb.com に統一して api.itandibb.com にも送信されるようにする
            raw_domain = cookie.get("domain", "")
            if "itandibb.com" in raw_domain and not raw_domain.startswith("."):
                cookie_domain = f".{raw_domain}"
            else:
                cookie_domain = raw_domain

            self.session.cookies.set(
                cookie["name"],
                cookie["value"],
                domain=cookie_domain,
                path=cookie.get("path", "/"),
            )

            # CSRF-TOKEN を取得
            if cookie["name"] == "CSRF-TOKEN":
                self.csrf_token = urllib.parse.unquote(cookie["value"])
                csrf_found = True
                print(
                    f"[DEBUG] CSRF-TOKEN 取得成功 "
                    f"(長さ: {len(self.csrf_token)})"
                )

        if not csrf_found:
            # CSRF-TOKEN が Cookie にない場合、requests で再取得を試みる
            print("[DEBUG] CSRF-TOKEN Cookie なし、requests で再取得...")
            try:
                resp = self.session.get(
                    f"{ITANDI_BASE_URL}/rent_rooms/list",
                    timeout=30,
                    allow_redirects=True,
                )
                for c in self.session.cookies:
                    if c.name == "CSRF-TOKEN":
                        self.csrf_token = urllib.parse.unquote(c.value)
                        csrf_found = True
                        print(
                            f"[DEBUG] CSRF-TOKEN 再取得成功 "
                            f"(長さ: {len(self.csrf_token)})"
                        )
                        break
            except requests.RequestException as exc:
                print(f"[DEBUG] CSRF-TOKEN 再取得失敗: {exc}")

        if not csrf_found:
            raise ItandiAuthError(
                "ログイン後に CSRF トークンを取得できませんでした"
            )
