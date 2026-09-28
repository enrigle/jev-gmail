# jev-gmail

Sorts your Gmail inbox into labels using [Jev](https://docs.typesafe.ai) (TypeSafe), via OpenRouter.
For each email, Jev answers three questions; plain code decides what to do with the answers.

| Question                                                    | Type   | Used for                                            |
| ----------------------------------------------------------- | ------ | --------------------------------------------------- |
| Which folder? (see `FOLDERS`)                               | Choice | `<folder>` label, or `Review` if unsure             |
| Does the sender expect a reply?                             | Noul   | Star the email                                      |
| How urgent? (Can wait, This week, Today)                    | Score  | Mark as Important                                   |

## Architecture

```
gmail_client.py      Gmail I/O: OAuth login, list/get messages, labels, email -> state
gmail_jev_sorter.py  Questions, decide() rules, main loop, CLI
test_sorter.py       Tests for decide(), to_state() and ask_jev() retries
```

Flow per email:

```
Gmail inbox -> to_state() -> Jev (3 questions) -> decide() -> labels
```

- Only inbox emails without any folder label (`Work`, `Jobs`, …, `Review`) are fetched, so re-running is safe.
  `Personal` reuses your existing Gmail label, so emails you tagged Personal by hand are skipped too.
- `decide()` is a pure function: all thresholds live there, no network calls.

## Setup

Requires [uv](https://docs.astral.sh/uv/) and Python 3.12+.

1. **Install dependencies**

   ```sh
   uv sync
   ```
2. **OpenRouter API key**: Jev is called through OpenRouter's Decisions API
   (`typesafe/jev-1.13`, about $0.00002 per email). Create a key at
   [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) and put it in `.env`:

   ```sh
   OPENROUTER_API_KEY=sk-or-v1-...
   ```

3. **Gmail credentials**: in [Google Cloud Console](https://console.cloud.google.com/):

   - Enable the **Gmail API**.
   - Configure the OAuth consent screen and add your Gmail address as a test user.
   - Create an **OAuth client ID** of type **Desktop app**, download it as `credentials.json`
     into this folder.

   On the first run a browser opens to log in; the token is saved to `token.json`.

`.env`, `credentials.json` and `token.json` are secrets and are git-ignored.

## Run

```sh
# Dry run: prints what would happen, changes nothing
uv run --env-file .env gmail_jev_sorter.py

# Apply labels
uv run --env-file .env gmail_jev_sorter.py --apply
```

Always dry-run first and check the decisions look right.

## Background job (macOS)

`com.enrigle.jev-gmail.plist` runs `--apply` Sunday, Tuesday and Thursday at 21:30 via launchd
(missed runs happen on next wake). Log: `~/Library/Logs/jev-gmail.log`.

```sh
# install / reload after editing the plist
cp com.enrigle.jev-gmail.plist ~/Library/LaunchAgents/
launchctl bootout gui/$(id -u)/com.enrigle.jev-gmail 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.enrigle.jev-gmail.plist

launchctl kickstart gui/$(id -u)/com.enrigle.jev-gmail   # run now
tail -f ~/Library/Logs/jev-gmail.log                     # watch
launchctl bootout gui/$(id -u)/com.enrigle.jev-gmail     # uninstall
```

The job can't open a browser: if the Gmail login expired it exits with
"Gmail login expired" in the log. Run the script once in a terminal to log in again.
Publish the Google app to **In production** so the login stops expiring every 7 days.

## Configuration

Constants at the top of `gmail_jev_sorter.py`:

| Setting        | Default   | Meaning                                                               |
| -------------- | --------- | --------------------------------------------------------------------- |
| `FOLDER_MIN`   | `0.7`     | Min folder confidence to file it (else `Review`)                      |
| `REPLY_MIN`    | `0.6`     | Min "needs reply" probability to star it                              |
| `URGENT`       | `1.5`     | Priority score (0–2) at or above which it is marked Important         |
| `ARCHIVE`      | `False`   | `True` also removes sorted emails from the Inbox (never for Review)   |
| `MAX_EMAILS`   | `100`     | Emails per run (max 500)                                              |
| `FOLDERS`      | 13        | Folders Jev chooses from (below)                                      |

Folders: Work, Jobs, Finance, Tax, House, Shopping, Accounts, Kids, Courses, Language, Newsletters,
Personal, Other.

Thresholds are starting guesses. The dry run prints raw numbers next to each decision,
e.g. `reply=False(0.42) urgent=False(0.80)`: tune from those.

`FOLDERS` entries can be a string or `{"what": ..., "not_for": ..., "examples": [...]}`.
Keys become Gmail labels; don't use `/` in them (Gmail nests labels on `/`).

## Troubleshooting

- **`Error 403: access_denied` / "app not verified"**: the Google app is in Testing mode.
  Add your Gmail as a test user in Google Cloud Console → Google Auth Platform → Audience.
  On the "Google hasn't verified this app" screen, click Continue.
- **`invalid_grant` after a week**: Testing-mode tokens expire after 7 days.
  Delete `token.json` and run again to log in. To stop this (needed for the weekly job),
  Google Auth Platform → Audience → **Publish app**. For a personal app you can skip
  verification; you keep seeing the "unverified app" screen at login.

## Development

```sh
uv run ruff format . && uv run ruff check . --fix   # lint
uv run mypy . --strict --exclude .venv              # types
uv run pytest -x                                    # tests
```

## Undo

Remove the folder labels (`Work`, `Jobs`, …, `Review`) from an email in Gmail to have it re-sorted.
