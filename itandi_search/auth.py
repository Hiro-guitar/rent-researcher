"""itandi BB ログイン・セッション管理

itandi BB は OAuth2 Authorization Code フローを使用する。
1. itandibb.com/rent_rooms/list にアクセス → 未認証なら itandi-accounts.com/login にリダイレクト
2. ログインフォームから authenticity_token を取得
3. email + password + authenticity_token で POST ログイン
4. リダイレクトを追跡 → itandibb.com/itandi_accounts_callback でセッション確立
5. CSRF-TOKEN Cookie を取得 → API ヘッダーに使用
"""

import urllib.parse

import requests
from bs4 import BeautifulSoup

from .config import ITANDI_BASE_URL


class ItandiAuthError(Exception):
    """itandi BB 認証エラー"""


class ItandiSession:
    """itandi BB のセッションを管理する。

    ログイン後の requests.Session を保持し、
    API 呼び出しに必要な Cookie + CSRF トークンを提供する。
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
        """itandi BB にログインし、API 用 CSRF トークンを取得する。

        Returns:
            True: ログイン成功
        Raises:
            ItandiAuthError: ログイン失敗時
        """
        # Step 1: itandibb.com/rent_rooms/list にアクセス
        # 未認証なら itandi-accounts.com/login?client_id=itandi_bb&... にリダイレクト
        print("[DEBUG] Step 1: itandibb.com/rent_rooms/list にアクセス...")
        try:
            resp = self.session.get(
                f"{ITANDI_BASE_URL}/rent_rooms/list",
                timeout=30,
                allow_redirects=True,
            )
            resp.raise_for_status()
        except requests.RequestException as exc:
            raise ItandiAuthError(
                f"itandibb.com へのアクセスに失敗: {exc}"
            ) from exc

        final_url = resp.url
        print(f"[DEBUG] リダイレクト先: {final_url}")

        # リダイレクトされずに itandibb.com に留まった場合
        # → CSRF-TOKEN Cookie があるか確認
        if "itandibb.com" in final_url and "login" not in final_url:
            if self._get_csrf_from_cookies():
                print("[INFO] itandi BB ログイン成功（既存セッション）")
                return True
            # CSRF-TOKEN がない場合、明示的にログインフローを開始
            print("[DEBUG] CSRF-TOKEN Cookie がないため、ログインフローを開始...")
            resp = self._start_login_flow()
            final_url = resp.url

        # ログインページにリダイレクトされた場合
        if "itandi-accounts.com" in final_url:
            print(f"[DEBUG] ログインページに到達")
        else:
            # どちらでもない不明な状態
            print(f"[DEBUG] 不明なリダイレクト先: {final_url}")

        # Step 2: ログインページから authenticity_token を取得
        print("[DEBUG] Step 2: ログインページから authenticity_token を取得...")
        form_csrf = self._extract_form_csrf(resp.text)

        if not form_csrf:
            # HTML の一部をデバッグ出力
            print(f"[DEBUG] レスポンスURL: {resp.url}")
            print(f"[DEBUG] レスポンスHTML先頭500文字: {resp.text[:500]}")
            raise ItandiAuthError(
                "ログインページから authenticity_token を取得できませんでした"
            )

        print(f"[DEBUG] authenticity_token 取得成功 (長さ: {len(form_csrf)})")

        # Step 3: ログイン POST
        login_post_url = self._get_login_post_url(resp.url)
        print(f"[DEBUG] Step 3: ログイン POST...")

        login_data = {
            "authenticity_token": form_csrf,
            "email": self.email,
            "password": self.password,
            "commit": "ログイン",
        }

        try:
            resp = self.session.post(
                login_post_url,
                data=login_data,
                allow_redirects=True,
                timeout=30,
            )
        except requests.RequestException as exc:
            raise ItandiAuthError(f"ログイン POST に失敗: {exc}") from exc

        print(f"[DEBUG] ログイン POST 後の URL: {resp.url}")
        print(f"[DEBUG] ステータスコード: {resp.status_code}")

        # ログイン失敗チェック
        if "itandi-accounts.com" in resp.url and "login" in resp.url:
            raise ItandiAuthError(
                "ログインに失敗しました（メールアドレスまたはパスワードが正しくありません）"
            )

        # Step 4: CSRF-TOKEN Cookie を取得
        print("[DEBUG] Step 4: CSRF-TOKEN Cookie を取得...")
        if not self._get_csrf_from_cookies():
            # ページに明示的にアクセス
            print("[DEBUG] Cookie にCSRF-TOKENなし、rent_rooms/list に再アクセス...")
            try:
                resp = self.session.get(
                    f"{ITANDI_BASE_URL}/rent_rooms/list",
                    timeout=30,
                    allow_redirects=True,
                )
                self._get_csrf_from_cookies()
            except requests.RequestException:
                pass

        if not self.csrf_token:
            cookie_names = [c.name for c in self.session.cookies]
            print(f"[DEBUG] 全Cookie名: {cookie_names}")
            raise ItandiAuthError(
                "ログイン後に CSRF トークンを取得できませんでした"
            )

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

    def _start_login_flow(self) -> requests.Response:
        """itandi BB の OAuth2 ログインフローを明示的に開始する。

        itandibb.com/logout にアクセスして、ログインページにリダイレクトさせる。
        """
        # まず /logout でセッションクリア → ログインページにリダイレクト
        try:
            resp = self.session.get(
                f"{ITANDI_BASE_URL}/logout",
                timeout=30,
                allow_redirects=True,
            )
            print(f"[DEBUG] /logout 後のURL: {resp.url}")
            return resp
        except requests.RequestException:
            pass

        # フォールバック: 直接 OAuth2 URL を構築
        oauth_url = (
            "https://itandi-accounts.com/login"
            "?client_id=itandi_bb"
            "&redirect_uri=https%3A%2F%2Fitandibb.com%2Fitandi_accounts_callback"
            "&response_type=code"
        )
        try:
            resp = self.session.get(
                oauth_url, timeout=30, allow_redirects=True
            )
            print(f"[DEBUG] 直接OAuth URL後のURL: {resp.url}")
            return resp
        except requests.RequestException as exc:
            raise ItandiAuthError(
                f"ログインフロー開始に失敗: {exc}"
            ) from exc

    def _get_login_post_url(self, login_page_url: str) -> str:
        """ログインページ URL からフォームの POST 先 URL を構築する。"""
        parsed = urllib.parse.urlparse(login_page_url)
        return urllib.parse.urlunparse(
            (parsed.scheme, parsed.netloc, "/login", "", parsed.query, "")
        )

    def _extract_form_csrf(self, html: str) -> str | None:
        """HTML からフォーム用 CSRF トークンを抽出する。"""
        soup = BeautifulSoup(html, "html.parser")

        # <input type="hidden" name="authenticity_token" value="...">
        inp = soup.find("input", {"name": "authenticity_token"})
        if inp and inp.get("value"):
            return inp["value"]

        # フォールバック: <meta name="csrf-token" content="...">
        meta = soup.find("meta", {"name": "csrf-token"})
        if meta and meta.get("content"):
            return meta["content"]

        return None

    def _get_csrf_from_cookies(self) -> bool:
        """Cookie から CSRF-TOKEN を取得してセットする。"""
        for cookie in self.session.cookies:
            if cookie.name == "CSRF-TOKEN":
                self.csrf_token = urllib.parse.unquote(cookie.value)
                print(
                    f"[DEBUG] CSRF-TOKEN Cookie 取得成功 "
                    f"(長さ: {len(self.csrf_token)})"
                )
                return True
        return False
