"""itandi BB ログイン・セッション管理"""

import urllib.parse

import requests
from bs4 import BeautifulSoup

from .config import (
    ITANDI_BASE_URL,
    ITANDI_LOGIN_PAGE_URL,
    ITANDI_LOGIN_POST_URL,
)


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
        # Step 1: ログインページを GET → フォーム CSRF トークン取得
        try:
            resp = self.session.get(ITANDI_LOGIN_PAGE_URL, timeout=30)
            resp.raise_for_status()
        except requests.RequestException as exc:
            raise ItandiAuthError(
                f"ログインページの取得に失敗: {exc}"
            ) from exc

        form_csrf = self._extract_form_csrf(resp.text)
        if not form_csrf:
            raise ItandiAuthError(
                "ログインページから CSRF トークンを取得できませんでした"
            )

        # Step 2: ログイン POST
        login_data = {
            "email": self.email,
            "password": self.password,
        }

        # CSRF トークンのフィールド名を試行（Rails / Laravel 等）
        for field_name in ("_token", "authenticity_token", "csrf_token"):
            login_data[field_name] = form_csrf

        try:
            resp = self.session.post(
                ITANDI_LOGIN_POST_URL,
                data=login_data,
                allow_redirects=True,
                timeout=30,
            )
        except requests.RequestException as exc:
            raise ItandiAuthError(f"ログイン POST に失敗: {exc}") from exc

        # ログイン失敗チェック（ログインページに戻された場合）
        if "login" in resp.url and resp.url != ITANDI_BASE_URL:
            # まだログインページにいる可能性
            if "パスワード" in resp.text and "ログイン" in resp.text:
                raise ItandiAuthError(
                    "ログインに失敗しました（メールアドレスまたはパスワードが正しくありません）"
                )

        # Step 3: itandibb.com にアクセスして CSRF-TOKEN Cookie を取得
        # （リダイレクトで自動的に設定されない場合のフォールバック）
        if not self._get_csrf_from_cookies():
            try:
                self.session.get(ITANDI_BASE_URL, timeout=30)
            except requests.RequestException:
                pass
            if not self._get_csrf_from_cookies():
                # 最終手段: /top にアクセス
                try:
                    resp = self.session.get(
                        f"{ITANDI_BASE_URL}/top", timeout=30
                    )
                    self._get_csrf_from_cookies()
                    # HTML 内の meta タグからも探す
                    if not self.csrf_token:
                        self.csrf_token = self._extract_meta_csrf(resp.text)
                except requests.RequestException:
                    pass

        if not self.csrf_token:
            raise ItandiAuthError(
                "ログイン後に CSRF トークンを取得できませんでした"
            )

        print(f"[INFO] itandi BB ログイン成功")
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

    def _extract_form_csrf(self, html: str) -> str | None:
        """HTML からフォーム用 CSRF トークンを抽出する。"""
        soup = BeautifulSoup(html, "html.parser")

        # <meta name="csrf-token" content="...">
        meta = soup.find("meta", {"name": "csrf-token"})
        if meta and meta.get("content"):
            return meta["content"]

        # <input type="hidden" name="_token" value="...">
        for name in ("_token", "authenticity_token", "csrf_token"):
            inp = soup.find("input", {"name": name})
            if inp and inp.get("value"):
                return inp["value"]

        return None

    def _extract_meta_csrf(self, html: str) -> str | None:
        """HTML の meta タグから CSRF トークンを抽出する。"""
        soup = BeautifulSoup(html, "html.parser")
        meta = soup.find("meta", {"name": "csrf-token"})
        if meta and meta.get("content"):
            return meta["content"]
        return None

    def _get_csrf_from_cookies(self) -> bool:
        """Cookie から CSRF-TOKEN を取得してセットする。"""
        for cookie in self.session.cookies:
            if cookie.name == "CSRF-TOKEN":
                self.csrf_token = urllib.parse.unquote(cookie.value)
                return True
        return False
