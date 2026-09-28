"""
Sort Gmail inbox with Jev (TypeSafe), called through OpenRouter's Decisions API.

Setup:
  uv sync
  Fill OPENROUTER_API_KEY in .env
  Put credentials.json (OAuth "Desktop app" client, Gmail API enabled) next to this script.

Run:
  uv run --env-file .env gmail_jev_sorter.py            # dry run: prints decisions only
  uv run --env-file .env gmail_jev_sorter.py --apply    # applies labels
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from typesafe_sdk import Choice, JSONContent, Noul, Score

from gmail_client import Gmail, to_state

JEV_URL = "https://openrouter.ai/api/alpha/decisions"
JEV_MODEL = "typesafe/jev-1.13"
RETRIES = 4  # on 429/5xx/network errors, backoff 1,2,4,8s
# ponytail: thresholds tuned on one 50-email dry run; re-tune from printed raw numbers
FOLDER_MIN = 0.7  # min Choice confidence to file, else Review
REPLY_MIN = 0.6  # min Noul probability to star
URGENT = 1.5  # Score 0..2: closer to "Today" than "This week"
ARCHIVE = False  # True = also remove from Inbox
MAX_EMAILS = 100

# Keys are Gmail label names; no "/" in keys or Gmail nests them. "Personal" reuses yours.
FOLDERS: dict[str, JSONContent] = {
    "Work": {
        "what": "My current job: projects, colleagues, meetings, work tools",
        "not_for": "Recruiting, job offers or applications (use Jobs)",
    },
    "Jobs": {
        "what": "Recruiters, job alerts, job applications, interviews",
        "examples": [
            "Interview invitation",
            "X busca personal para el puesto de...",
            "LinkedIn profile views",
            "Company viewed your application",
        ],
    },
    "Finance": {
        "what": "Bank, invoices, receipts, payments",
        "not_for": "Tax agency or traffic authority (use Tax)",
        "examples": ["Fintonic", "Santander Informa", "unicaja", "Factura", "Recibo"],
    },
    "Tax": {
        "what": "Tax and government notices: tax returns, fines, official notifications",
        "examples": [
            "AEAT / Agencia Tributaria",
            "DGT / Dirección General de Tráfico",
            "Renta declaracion",
            "Multa de tráfico",
        ],
    },
    "House": {
        "what": "Finding, buying, selling or renting a home",
        "examples": ["Idealista alerts and messages", "Property listings", "Rental offers"],
    },
    "Shopping": {
        "what": "Orders, shipping, buying and selling on marketplaces",
        "examples": ["Vinted", "Wallapop", "Amazon order", "Shipping label"],
    },
    "Accounts": {
        "what": "Account and security notices",
        "examples": [
            "Login or one-time code",
            "You shared Google account data with an app",
            "Security incident notice",
            "Terms or legal changes",
        ],
    },
    "Kids": {
        "what": "My children's school and activities",
        "examples": ["ceip", "extraescolares"],
    },
    "Courses": {
        "what": "Online courses and learning platforms",
        "examples": ["Coursera", "MITx", "edX", "Udemy", "DeepLearning.AI"],
    },
    "Language": {
        "what": "Language lessons and tutors",
        "examples": ["Preply"],
    },
    "Newsletters": {
        "what": "Subscriptions, digests, articles, marketing, promotions",
        "examples": ["Medium", "TLDR", "New York Times", "Real Python"],
    },
    "Personal": "Family, friends, personal appointments",
    "Other": "None of the above clearly fits",
}
PRIORITY_LEVELS = ["Can wait", "This week", "Today"]
# Skip emails that already carry any folder label: re-runs only sort new mail.
QUERY = "in:inbox " + " ".join(f"-label:{name}" for name in [*FOLDERS, "Review"])

QUESTIONS: dict[str, Choice | Noul | Score] = {
    "folder": Choice(instructions="Which folder does this email belong in?", criteria=FOLDERS),
    "needs_reply": Noul(instructions="Does the sender expect a personal reply from me?"),
    "priority": Score(
        instructions="How soon must I personally act on this email? "
        "Ignore marketing, sales or fundraising urgency.",
        criteria=PRIORITY_LEVELS,
    ),
}


@dataclass(frozen=True)
class Decision:
    """What to do with one email."""

    folder: str  # FOLDERS key, or "Review" when unsure
    needs_reply: bool
    urgent: bool


def decide(folder: str, confidence: float, reply_p: float, priority: float) -> Decision:
    """Turn Jev's raw judgments into actions. Pure: no I/O.

    Unknown folders go to Review: the answer becomes a Gmail label name, and names like
    "SPAM" would hit system labels. NaN compares False, so it lands on the safe side.
    """
    return Decision(
        folder=folder if folder in FOLDERS and confidence >= FOLDER_MIN else "Review",
        needs_reply=reply_p >= REPLY_MIN,
        urgent=priority >= URGENT,
    )


def ask_jev(key: str, state: dict[str, str]) -> dict[str, Any]:
    """POST the questions to Jev via OpenRouter; return the raw `answers` dict.

    Raw JSON, not the SDK's response model: OpenRouter's string score keys fail its validation.
    """
    body = {
        "model": JEV_MODEL,
        "state": state,
        "questions": {k: q.model_dump(exclude_none=True) for k, q in QUESTIONS.items()},
    }
    req = urllib.request.Request(
        JEV_URL,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    for attempt in range(RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                answers: dict[str, Any] = json.load(resp)["answers"]
                return answers
        except urllib.error.HTTPError as e:
            msg = f"OpenRouter {e.code}: {e.read(200).decode(errors='ignore')}"
            if (e.code != 429 and e.code < 500) or attempt == RETRIES:
                raise SystemExit(msg) from e  # 4xx (bad key, no credit) won't fix itself
        except (urllib.error.URLError, TimeoutError) as e:
            msg = f"Network error: {e}"
            if attempt == RETRIES:
                raise SystemExit(msg) from e
        wait = 2**attempt
        print(f"  {msg.strip()[:80]} -> retry in {wait}s")
        time.sleep(wait)
    raise AssertionError("unreachable")


def main(apply: bool) -> None:
    """Sort unprocessed inbox emails. Dry run prints only; `apply` writes labels."""
    key = os.getenv("OPENROUTER_API_KEY")
    if not key:
        raise SystemExit("Set OPENROUTER_API_KEY in .env (openrouter.ai/settings/keys)")
    gmail = Gmail()
    ids = gmail.list_ids(QUERY, MAX_EMAILS)
    print(f"{len(ids)} emails to sort ({'APPLY' if apply else 'DRY RUN'})\n")

    for msg_id in ids:
        state = to_state(gmail.get(msg_id))
        a = ask_jev(key, state)
        try:
            folder, conf = a["folder"]["choice"], a["folder"]["confidence"]
            reply_p, prio = a["needs_reply"]["noul"], a["priority"]["score"]
        except (KeyError, TypeError):
            print(f"skip {msg_id}: incomplete answer from Jev (retried next run)")
            continue
        d = decide(folder, conf, reply_p, prio)
        # 4: subjects only in dry run; --apply output goes to the weekly log
        what = state["subject"][:60] if not apply else msg_id
        print(
            f"[{d.folder:<11}] conf={conf:.2f} reply={d.needs_reply!s:<5}({reply_p:.2f}) "
            f"urgent={d.urgent!s:<5}({prio:.2f}) | {what}"
        )

        if not apply:
            continue
        add = [gmail.label_id(d.folder)]
        add += ["STARRED"] * d.needs_reply + ["IMPORTANT"] * d.urgent
        remove = ["INBOX"] if ARCHIVE and d.folder != "Review" else []
        gmail.modify(msg_id, add, remove)


if __name__ == "__main__":
    main(apply="--apply" in sys.argv)
