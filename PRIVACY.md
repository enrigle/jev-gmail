# Privacy Policy — jev-gmail

jev-gmail is a personal script that sorts its owner's Gmail inbox into labels.
It is not a hosted service and has no other users.

## What it accesses

With the `gmail.modify` permission, the script:

- reads inbox messages (sender, subject, body text),
- adds labels (and optionally stars, marks important or archives) on those messages,
- creates labels it needs.

It never sends email, deletes email, or changes account settings.

## Where data goes

For each email, the sender, subject and the first 1,000 characters of the body are sent
to [OpenRouter](https://openrouter.ai/privacy), which forwards them to
[TypeSafe](https://typesafe.ai) (model Jev) to get a category and probabilities.
Their handling of that data is governed by their own privacy policies.
No data is sent anywhere else.

The sorter runs in Google Apps Script under the owner's Google account. Run logs in
Apps Script hold message ids and the chosen labels, not email content.

## What is stored

- `token.json` (owner's computer, for local runs): the Google login token,
- Apps Script execution logs (in the owner's Google account): message ids and labels,
- the OpenRouter key, in the Apps Script project's Script Properties.

No database, analytics or third-party storage.

## Revoking access

Remove the app at <https://myaccount.google.com/permissions> and delete `token.json`.

## Contact

<enrigle@gmail.com>
