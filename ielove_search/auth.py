"""いえらぶBB ログイン・セッション管理 (Selenium 版)

いえらぶBB は bb.ielove.jp でホストされ、
Cookie ベースのセッション認証を使用する。
Selenium で headless Chrome ログインし、ページソースを取得する。
"""

import time

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException

from .config import IELOVE_BASE_URL


def _create_driver() -> webdriver.Chrome:
    """Headless Chrome ドライバーを生成する。"""
    options = Options()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--window-size=1280,1024")
    return webdriver.Chrome(options=options)


class IeloveAuthError(Exception):
    """いえらぶBB 認証エラー"""


class IeloveSession:
    """いえらぶBB のセッションを管理する。

    Selenium で実ブラウザログインし、そのドライバーを保持したまま
    SSR ページの HTML を取得する。
    """

    def __init__(self, email: str, password: str) -> None:
        self.email = email
        self.password = password
        self.driver: webdriver.Chrome | None = None

    def login(self) -> bool:
        """Selenium でブラウザログインし、ドライバーを保持する。"""
        print("[INFO] いえらぶBB: Selenium ログインを開始...")

        self.driver = _create_driver()
        try:
            self._do_login(self.driver)
        except Exception:
            self.driver.quit()
            self.driver = None
            raise

        print("[INFO] いえらぶBB ログイン成功")
        return True

    def close(self) -> None:
        """ブラウザセッションを閉じる。"""
        if self.driver:
            self.driver.quit()
            self.driver = None

    def get_page(self, url: str) -> str:
        """URL に遷移してページの HTML を返す。

        セッション切れの場合は再ログインしてリトライする。
        ページロード完了を WebDriverWait で待機し、
        詳細ページではコンテンツ検証 + リトライを行う。
        """
        if not self.driver:
            raise IeloveAuthError("ブラウザセッションが初期化されていません")

        for attempt in range(2):
            self.driver.get("about:blank")
            time.sleep(0.3)

            self.driver.get(url)

            # ページロード完了を待機（table要素の出現を待つ）
            try:
                WebDriverWait(self.driver, 10).until(
                    lambda d: d.find_elements(By.CSS_SELECTOR, "table")
                )
            except TimeoutException:
                pass  # タイムアウトでも page_source は取れるので続行

            time.sleep(0.5)  # レンダリング安定待ち

            # ログインページにリダイレクトされた場合は再ログイン
            current_url = self.driver.current_url
            if "/login" in current_url:
                print("[INFO] セッション切れ検出、再ログイン中...")
                self._do_login(self.driver)
                continue

            html = self.driver.page_source

            # 詳細ページの場合、コンテンツを検証
            if "/rent/detail/" in url:
                if "di_table" in html or "detail-info" in html:
                    return html
                # コンテンツ不足 → リトライ
                if attempt == 0:
                    print(
                        f"[WARN] 詳細ページのコンテンツ不足、"
                        f"リトライ中... ({url})"
                    )
                    time.sleep(2)
                    continue

            return html

        return self.driver.page_source

    def _do_login(self, driver: webdriver.Chrome) -> None:
        """Selenium でいえらぶBB にログインする。"""
        # Step 1: ログインページにアクセス
        login_url = f"{IELOVE_BASE_URL}/ielovebb/login/"
        print(f"[DEBUG] Step 1: {login_url} にアクセス...")
        driver.get(login_url)
        time.sleep(3)

        current_url = driver.current_url
        print(f"[DEBUG] 現在のURL: {current_url}")

        # 既にログイン済みの場合（トップページにいる）
        if "/ielovebb/top/" in current_url:
            print("[DEBUG] 既にログイン済み")
            return

        # Step 2: ログインフォームに入力
        print("[DEBUG] Step 2: ログインフォームに入力...")
        try:
            WebDriverWait(driver, 15).until(
                lambda d: (
                    d.find_elements(By.NAME, "email")
                    or d.find_elements(By.NAME, "login_id")
                    or d.find_elements(By.ID, "email")
                    or d.find_elements(By.CSS_SELECTOR, 'input[type="email"]')
                    or d.find_elements(By.CSS_SELECTOR, 'input[type="text"]')
                )
            )

            # メール/ID フィールドを探す
            user_input = None
            for selector in [
                (By.NAME, "email"),
                (By.NAME, "login_id"),
                (By.ID, "email"),
                (By.CSS_SELECTOR, 'input[type="email"]'),
            ]:
                fields = driver.find_elements(*selector)
                if fields:
                    user_input = fields[0]
                    print(f"[DEBUG] フィールド: {selector}")
                    break

            if not user_input:
                # text フィールドの最初のものを使う
                text_fields = driver.find_elements(
                    By.CSS_SELECTOR, 'input[type="text"]'
                )
                if text_fields:
                    user_input = text_fields[0]
                    print("[DEBUG] フィールド: input[type=text] (フォールバック)")

            if not user_input:
                raise IeloveAuthError("ログインフォームが見つかりませんでした")

            user_input.clear()
            user_input.send_keys(self.email)

            # パスワードフィールド
            password_fields = driver.find_elements(
                By.CSS_SELECTOR, 'input[type="password"]'
            )
            if not password_fields:
                raise IeloveAuthError("パスワードフィールドが見つかりませんでした")

            password_fields[0].clear()
            password_fields[0].send_keys(self.password)

        except TimeoutException:
            current_url = driver.current_url
            print(f"[DEBUG] フォーム待ちタイムアウト URL: {current_url}")
            raise IeloveAuthError(
                f"ログインフォームが見つかりませんでした (URL: {current_url})"
            )

        # Step 3: 送信ボタンをクリック
        print("[DEBUG] Step 3: 送信ボタンをクリック...")
        try:
            submit_btn = driver.find_element(
                By.CSS_SELECTOR, 'button[type="submit"], input[type="submit"]'
            )
            submit_btn.click()
        except Exception as exc:
            raise IeloveAuthError(
                f"送信ボタンが見つかりませんでした: {exc}"
            ) from exc

        # Step 4: ログイン後のリダイレクトを待つ
        print("[DEBUG] Step 4: ログイン後のリダイレクト待ち...")
        try:
            WebDriverWait(driver, 20).until(
                lambda d: "/ielovebb/top/" in d.current_url
                or "/ielovebb/rent/" in d.current_url
            )
        except TimeoutException:
            current_url = driver.current_url
            print(f"[DEBUG] タイムアウト後のURL: {current_url}")
            if "/login" in current_url:
                raise IeloveAuthError(
                    f"ログインに失敗しました (URL: {current_url})"
                )
            raise IeloveAuthError(
                f"ログイン後に予期しないページ: {current_url}"
            )

        print(f"[DEBUG] ログイン成功: {driver.current_url}")
