import base64

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
