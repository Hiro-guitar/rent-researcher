"""itandi BB ログイン・セッション管理 (Playwright 版)

itandi BB は OAuth2 Authorization Code フローを使用する。
itandibb.com は SPA のため、実ブラウザ (Playwright) でログインし、
Cookie + CSRF トークンを取得する。

1. Playwright で itandibb.com にアクセス → SPA がログインページへリダイレクト
2. itandi-accounts.com のログインフォームにメール / パスワードを入力
3. ログインボタンをクリック → OAuth2 コールバックでセッション確立
4. CSRF-TOKEN Cookie を取得 → API ヘッダーに使用
5. Cookie を requests.Session にコピーして API 呼び出しに使用
"""

import urllib.parse

import requests
from playwright.sync_api import sync_playwright, TimeoutError as PwTimeout

from .config import ITANDI_BASE_URL


class ItandiAuthError(Exception):
    """itandi BB 認証エラー"""


class ItandiSession:
    """itandi BB のセッションを管理する。

    Playwright で実ブラウザログインし、取得した Cookie を
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
        """Playwright でブラウザログインし、API 用セッションを構築する。

        Returns:
            True: ログイン成功
        Raises:
            ItandiAuthError: ログイン失敗時
        """
        print("[INFO] Playwright でブラウザログインを開始...")

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/131.0.0.0 Safari/537.36"
                ),
            )
            page = context.new_page()

            try:
                self._do_login(page)
                self._extract_session(context)
            finally:
                browser.close()

        print("[INFO] itandi BB ログイン成功")
        return True

    def get_api_headers(self) -> dict[str, str]:
        """API リクエスト用ヘッダーを返す。"""
        return {
            "X-CSRF-TOKEN": self.csrf_token or "",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Origin": ITANDI_BASE_URL,
            "Referer": f"{ITANDI_BASE_URL}/",
        }

    # ─── private ───────────────────────────────────────

    def _do_login(self, page) -> None:  # noqa: ANN001
        """Playwright page でログインフローを実行する。"""

        # Step 1: OAuth2 ログインページに直接アクセス
        oauth_login_url = (
            "https://itandi-accounts.com/login"
            "?client_id=itandi_bb"
            "&redirect_uri=https%3A%2F%2Fitandibb.com%2Fitandi_accounts_callback"
            "&response_type=code"
        )
        print("[DEBUG] Step 1: OAuth2 ログインページにアクセス...")
        try:
            page.goto(oauth_login_url, wait_until="networkidle", timeout=30000)
        except PwTimeout:
            # networkidle がタイムアウトしても、ページは読み込まれている可能性がある
            pass

        current_url = page.url
        print(f"[DEBUG] 現在のURL: {current_url}")

        # 既にログイン済みで itandibb.com にリダイレクトされた場合
        if "itandibb.com" in current_url:
            print("[DEBUG] 既にログイン済み")
            return

        # ログインページにいることを確認
        if "itandi-accounts.com" not in current_url:
            raise ItandiAuthError(
                f"予期しないページに遷移: {current_url}"
            )

        # Step 2: ログインフォームに入力
        print("[DEBUG] Step 2: ログインフォームに入力...")
        try:
            # メールアドレス入力
            email_input = page.locator('input[name="email"]')
            email_input.wait_for(state="visible", timeout=10000)
            email_input.fill(self.email)

            # パスワード入力
            password_input = page.locator('input[name="password"]')
            password_input.fill(self.password)
        except PwTimeout as exc:
            raise ItandiAuthError(
                "ログインフォームの入力フィールドが見つかりませんでした"
            ) from exc

        # Step 3: ログインボタンをクリック
        print("[DEBUG] Step 3: ログインボタンをクリック...")
        try:
            submit_btn = page.locator('input[name="commit"]')
            submit_btn.click()

            # itandibb.com へのリダイレクトを待つ
            page.wait_for_url(
                "**/itandibb.com/**",
                timeout=30000,
            )
        except PwTimeout:
            current_url = page.url
            print(f"[DEBUG] ログイン後のURL: {current_url}")

            # まだ itandi-accounts.com にいる → ログイン失敗
            if "itandi-accounts.com" in current_url:
                # エラーメッセージを確認
                error_el = page.locator(".alert, .error, .flash-message")
                error_text = ""
                if error_el.count() > 0:
                    error_text = error_el.first.text_content() or ""
                raise ItandiAuthError(
                    f"ログインに失敗しました: {error_text or 'メールアドレスまたはパスワードが正しくありません'}"
                )

            # エラーページの場合
            if page.title() and "エラー" in page.title():
                raise ItandiAuthError(
                    f"ログイン中にエラーが発生しました (URL: {current_url})"
                )

            # itandibb.com に遷移した可能性もある
            if "itandibb.com" in current_url:
                print("[DEBUG] itandibb.com に遷移成功")
                return

            raise ItandiAuthError(
                f"ログイン後に予期しないページ: {current_url}"
            )

        print(f"[DEBUG] ログイン後のURL: {page.url}")

    def _extract_session(self, context) -> None:  # noqa: ANN001
        """Playwright BrowserContext から Cookie を取得し requests.Session にコピー。"""
        cookies = context.cookies()
        print(f"[DEBUG] 取得した Cookie 数: {len(cookies)}")

        cookie_names = [c["name"] for c in cookies]
        print(f"[DEBUG] Cookie 名一覧: {cookie_names}")

        csrf_found = False
        for cookie in cookies:
            # requests.Session に Cookie をコピー
            self.session.cookies.set(
                cookie["name"],
                cookie["value"],
                domain=cookie.get("domain", ""),
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
            # CSRF-TOKEN が Cookie にない場合、itandibb.com にアクセスして再取得
            print("[DEBUG] CSRF-TOKEN Cookie なし、itandibb.com にアクセスして再取得...")
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
