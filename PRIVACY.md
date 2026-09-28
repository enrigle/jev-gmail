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

## What is stored

Only on the owner's computer:

- `token.json`: the Google login token,
- `~/Library/Logs/jev-gmail.log`: a run log with email subjects and the chosen labels.

No database, analytics or third-party storage.

## Revoking access

Remove the app at <https://myaccount.google.com/permissions> and delete `token.json`.

## Contact

<enrigle@gmail.com>
