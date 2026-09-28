"""Gmail I/O: auth, labels, fetching messages."""

import base64
import sys
from pathlib import Path
from typing import Any

from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
HERE = Path(__file__).parent
CREDENTIALS = HERE / "credentials.json"
TOKEN = HERE / "token.json"

Message = dict[str, Any]


class Gmail:
    """Thin wrapper over the Gmail API for the signed-in user ("me")."""

    def __init__(self) -> None:
        """Authenticate and build the Gmail service; label cache loads lazily."""
        self.svc = build("gmail", "v1", credentials=_credentials())
        self._labels: dict[str, str] | None = None

    def list_ids(self, query: str, limit: int) -> list[str]:
        """Return up to `limit` message IDs matching a Gmail search `query`."""
        if limit <= 0:
            return []
        # ponytail: single page (Gmail caps at 500), paginate if limit > 500
        res = self.svc.users().messages().list(userId="me", q=query, maxResults=limit).execute()
        return [m["id"] for m in res.get("messages", [])]

    def get(self, msg_id: str) -> Message:
        """Fetch one full message (headers, MIME parts, snippet)."""
        msg: Message = self.svc.users().messages().get(userId="me", id=msg_id).execute()
        return msg

    def label_id(self, name: str) -> str:
        """Return the ID of label `name`, creating it if missing. Cached after first call."""
        if self._labels is None:
            labels = self.svc.users().labels().list(userId="me").execute().get("labels", [])
            self._labels = {lbl["name"]: lbl["id"] for lbl in labels}
        if name not in self._labels:
            body = {
                "name": name,
                "labelListVisibility": "labelShow",
                "messageListVisibility": "show",
            }
            self._labels[name] = (
                self.svc.users().labels().create(userId="me", body=body).execute()["id"]
            )
        return self._labels[name]

    def modify(self, msg_id: str, add: list[str], remove: list[str]) -> None:
        """Add and remove label IDs on one message."""
        body = {"addLabelIds": add, "removeLabelIds": remove}
        self.svc.users().messages().modify(userId="me", id=msg_id, body=body).execute()


def _credentials() -> Credentials:
    """Load cached OAuth token, refresh it, or run browser login; saves token.json.

    Raises SystemExit if a login is needed but impossible: credentials.json missing,
    or no terminal (background job) to complete the browser login.
    """
    creds = Credentials.from_authorized_user_file(str(TOKEN), SCOPES) if TOKEN.exists() else None
    if creds and creds.valid:
        return creds
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
        except RefreshError:  # e.g. Testing-mode token older than 7 days
            creds = None
    if not creds or not creds.valid:
        if not sys.stdin.isatty():
            raise SystemExit("Gmail login expired: run the script once in a terminal to log in")
        if not CREDENTIALS.exists():
            raise SystemExit(f"Missing {CREDENTIALS} (OAuth Desktop client, Gmail API enabled)")
        creds = InstalledAppFlow.from_client_secrets_file(
            str(CREDENTIALS), SCOPES
        ).run_local_server(port=0)
    TOKEN.touch(mode=0o600, exist_ok=True)
    TOKEN.chmod(0o600)  # refresh token = mailbox access
    TOKEN.write_text(creds.to_json())
    return creds


def _plain_text(payload: dict[str, Any]) -> str:
    """First text/plain part, depth-first; empty string if none."""
    data = payload.get("body", {}).get("data")
    if payload.get("mimeType") == "text/plain" and data:
        return base64.urlsafe_b64decode(data).decode(errors="ignore")
    return next((t for p in payload.get("parts") or [] if (t := _plain_text(p))), "")


def to_state(msg: Message, max_body: int = 1000) -> dict[str, str]:
    """Convert a Gmail message into the state Jev sees: from, subject, truncated body."""
    headers = {h["name"].lower(): h["value"] for h in msg["payload"].get("headers", [])}
    body = _plain_text(msg["payload"]) or msg.get("snippet", "")
    return {
        "from": headers.get("from", ""),
        "subject": headers.get("subject", ""),
        "body": body[: max(max_body, 0)],
    }
