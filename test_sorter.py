import base64
import io
import urllib.error
from email.message import Message
from typing import Any

import pytest

from gmail_client import to_state
from gmail_jev_sorter import FOLDER_MIN, REPLY_MIN, URGENT, Decision, decide


def test_decide() -> None:
    """Thresholds route to folder/Review, star, and mark urgent at the boundaries."""
    assert decide("Work", 0.99, 0.99, 2.0) == Decision("Work", True, True)
    assert decide("Work", 0.0, 0.0, 0.0) == Decision("Review", False, False)
    at = decide("Jobs", FOLDER_MIN, REPLY_MIN, URGENT)
    assert at == Decision("Jobs", True, True)  # boundaries are inclusive
    below = decide("Jobs", FOLDER_MIN - 0.01, REPLY_MIN - 0.01, URGENT - 0.01)
    assert below == Decision("Review", False, False)


def test_decide_rejects_unknown_folder_and_nan() -> None:
    """Folder not in FOLDERS (e.g. a system label) or NaN confidence -> Review, no flags."""
    assert decide("SPAM", 1.0, 0.0, 0.0).folder == "Review"
    assert decide("", 1.0, 0.0, 0.0).folder == "Review"
    nan = float("nan")
    assert decide("Work", nan, nan, nan) == Decision("Review", False, False)


def test_to_state_nested_and_empty() -> None:
    """Finds nested text/plain, skips HTML, falls back to snippet."""
    b64 = base64.urlsafe_b64encode(b"hello").decode()
    msg = {
        "payload": {
            "headers": [{"name": "Subject", "value": "Hi"}],
            "parts": [
                {"mimeType": "text/html", "body": {"data": b64}},
                {
                    "mimeType": "multipart/alternative",
                    "parts": [{"mimeType": "text/plain", "body": {"data": b64}}],
                },
            ],
        }
    }
    assert to_state(msg) == {"from": "", "subject": "Hi", "body": "hello"}
    assert to_state({"payload": {}, "snippet": "snip"})["body"] == "snip"
    assert to_state(msg, max_body=0)["body"] == ""
    assert to_state(msg, max_body=-5)["body"] == ""


def test_ask_jev_retries_5xx_not_4xx(monkeypatch: pytest.MonkeyPatch) -> None:
    """520 then OK -> retried and answered; 401 -> exits at once without retry."""
    import gmail_jev_sorter as s

    def err(code: int) -> urllib.error.HTTPError:
        return urllib.error.HTTPError(s.JEV_URL, code, "x", Message(), io.BytesIO(b"boom"))

    calls: list[int] = []
    replies: list[Any] = [err(520), io.BytesIO(b'{"answers": {"ok": 1}}')]

    def fake_urlopen(req: Any, timeout: float) -> Any:
        calls.append(1)
        r = replies.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    monkeypatch.setattr("time.sleep", lambda _: None)
    assert s.ask_jev("k", {}) == {"ok": 1}
    assert len(calls) == 2

    calls.clear()
    replies[:] = [err(401)]
    with pytest.raises(SystemExit, match="401"):
        s.ask_jev("k", {})
    assert len(calls) == 1
