"""
Sort Gmail inbox with Jev (TypeSafe).

Setup:
  uv sync
  Fill TYPESAFE_API_KEY in .env
  Put credentials.json (OAuth "Desktop app" client, Gmail API enabled) next to this script.

Run:
  uv run --env-file .env gmail_jev_sorter.py            # dry run: prints decisions only
  uv run --env-file .env gmail_jev_sorter.py --apply    # applies labels
"""

import sys
from dataclasses import dataclass

from typesafe_sdk import (
    Choice,
    ChoiceAnswer,
    JSONContent,
    Noul,
    NoulAnswer,
    Score,
    ScoreAnswer,
    TypeSafeClient,
)

from gmail_client import Gmail, to_state

LABEL_PREFIX = "Jev"  # labels become Jev/Work, Jev/Finance, ...
PROCESSED = "Jev-processed"
# ponytail: thresholds tuned on one 50-email dry run; re-tune from printed raw numbers
FOLDER_MIN = 0.7  # min Choice confidence to file, else Jev/Review
REPLY_MIN = 0.6  # min Noul probability to star
URGENT = 1.5  # Score 0..2: closer to "Today" than "This week"
ARCHIVE = False  # True = also remove from Inbox
MAX_EMAILS = 50
QUERY = f"in:inbox -label:{PROCESSED}"

# Keys become Gmail labels (Jev/<key>); no "/" in keys or Gmail nests them.
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
        "what": "Bank, invoices, receipts, taxes, payments",
        "examples": ["Fintonic", "BBVA account statement", "Receipt from a service"],
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
        "examples": ["School evaluation results", "Homework", "School holidays"],
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
    """Turn Jev's raw judgments into actions. Pure: no I/O."""
    return Decision(
        folder=folder if confidence >= FOLDER_MIN else "Review",
        needs_reply=reply_p >= REPLY_MIN,
        urgent=priority >= URGENT,
    )


def main(apply: bool) -> None:
    """Sort unprocessed inbox emails. Dry run prints only; `apply` writes labels."""
    gmail = Gmail()
    ids = gmail.list_ids(QUERY, MAX_EMAILS)
    print(f"{len(ids)} emails to sort ({'APPLY' if apply else 'DRY RUN'})\n")

    with TypeSafeClient() as jev:
        for msg_id in ids:
            state = to_state(gmail.get(msg_id))
            a = jev.system_one(state=state, questions=QUESTIONS).answers
            folder, reply, prio = a["folder"], a["needs_reply"], a["priority"]
            assert isinstance(folder, ChoiceAnswer)
            assert isinstance(reply, NoulAnswer)
            assert isinstance(prio, ScoreAnswer)
            d = decide(folder.choice, folder.confidence, reply.noul, prio.score)
            print(
                f"[{d.folder:<11}] conf={folder.confidence:.2f} "
                f"reply={d.needs_reply!s:<5}({reply.noul:.2f}) "
                f"urgent={d.urgent!s:<5}({prio.score:.2f}) | {state['subject'][:60]}"
            )

            if not apply:
                continue
            add = [gmail.label_id(f"{LABEL_PREFIX}/{d.folder}"), gmail.label_id(PROCESSED)]
            add += ["STARRED"] * d.needs_reply + ["IMPORTANT"] * d.urgent
            remove = ["INBOX"] if ARCHIVE and d.folder != "Review" else []
            gmail.modify(msg_id, add, remove)


if __name__ == "__main__":
    main(apply="--apply" in sys.argv)
