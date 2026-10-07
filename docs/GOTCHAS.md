# Gotchas

Every one of these cost real debugging time while building this. None are hypothetical.

## Shell-piped secrets carry a trailing newline

```powershell
'my-value' | wrangler secret put MY_SECRET     # stores "my-value\n"
```

PowerShell appends a newline when piping into a native command. That newline broke,
on three separate occasions: the webhook verify-token comparison, the HMAC signature
check, and the outbound send URL (`.../<phone-id>\n/messages`).

Use `printf '%s' 'value' | wrangler secret put NAME`, and defensively
`String(env.X || "").trim()` before comparing or interpolating a secret.

## Never swallow an error from an outbound call

`await fetch(...).catch(() => {})` hid the bug above completely: the bot simply never
replied, with no trace anywhere. Store the last failure somewhere readable
(`/api/wa-debug`) instead of discarding it.

## Cloudflare deploys propagate unevenly

For a minute or two after `wrangler deploy`, some requests still hit the previous
version — showing up as spurious 404s on brand-new routes, or old behaviour on a
freshly fixed one. Before concluding a fix failed, poll until several consecutive
requests all show the new behaviour.

## KV reads are cached at the edge (~60s)

Right after a write, `/api/data` can still serve the old value while a direct read of
the same key already shows the new one. Poll rather than panic. This is also why
marking mail as read needs a client-side guard (`handledMail` in localStorage) on top
of the server-side update.

## Gmail: act on the thread, not the message

Marking a single message read leaves a thread that has other unread messages in the
"to handle" list — it comes back under a different message id. Use `threadId`.

## OAuth scopes are frozen at consent time

No API upgrades an existing refresh token. Adding `calendar.events` to one minted with
`calendar.readonly` requires a fresh consent click by the account owner. Owning the
Cloud project does not help. (Domain-wide delegation is a Workspace-only escape hatch,
unavailable for personal accounts.)

## Meta hands out three different tokens

- *API Setup → Access token* → lasts **24 hours**.
- *Graph API Explorer* → also temporary, whatever you tick.
- *Business settings → System users → Generate new token* → **permanent**. This is the
  one you want. Assign the app **and** the WABA as assets *before* generating, or the
  permission list comes up empty and the button stays greyed out.

## Meta: a webhook needs a subscription, not just a URL

Saving the callback URL and verify token is only half the job. The app must also be
subscribed to that WABA's events (`POST /<WABA_ID>/subscribed_apps`). A test number
often shows only Meta's own *WA DevX Webhook Events 1P App* subscribed — and nothing
ever reaches you.

## WhatsApp Web automation (the Claude Code skill)

- **Only real clicks work.** Synthetic `.click()` and clicking by element reference do
  nothing; WhatsApp reacts to trusted pointer events at coordinates.
- **Screenshot pixels are not CSS pixels**, and the ratio depends on window size.
  Compute `screenshotWidth / window.innerWidth` every run — a hardcoded factor makes
  you click the wrong row and open the wrong chat.
- **The chat list reorders live.** Recompute coordinates immediately before each click
  and verify what is actually under them.
- **Opening a chat sends read receipts** and cannot be undone. Only open groups.
- **A background tab throttles timers** to ~1s and leaves `innerText` empty; use
  `textContent`, and run long sweeps detached instead of awaiting them.
- The **Gruppi filter is a toggle** — clicking twice turns it off and you end up
  sweeping every chat, 1:1s included.

## Command parsers must never fall through

`fatto prova` originally *created* a task called "fatto prova", because only
`fatto <number>` was recognised and everything else hit the default branch. If a
message starts with a command word, handle it inside that branch — error message
included — and never fall through to a destructive-ish default.

## Parser precedence and double-reading

`cal domani, 9 - 12, Sam` was read as **9 December**: the numeric `d-m` pattern ran
before the day words and ate `9 - 12`, which the time patterns then matched *again*.
Two rules fix a whole class of these bugs: match explicit day words first, and blank
out every fragment you consume so nothing can be read twice.

## A subscription is not an API key

`@anthropic-ai/sdk` runs fine on `workerd` — but a Worker calling `api.anthropic.com`
bills a pay-as-you-go API key. A Claude Pro/Max subscription covers **Claude Code**, not
the API, and there is no way to make a Worker draw on it. If you want scheduled LLM work
without a second bill, run it as a **scheduled Claude Code cloud routine** and let it talk
to your Worker over plain HTTP. The Worker stays dependency-free.

## A cloud routine inherits every connector you have

Creating a routine through the API silently attached every MCP connector on the account —
Gmail, Drive, Calendar, and a handful of travel sites. An agent whose whole job is reading
untrusted e-mail should not also be holding your mailbox credentials: a hostile mail only
has to talk it into a send. Clear them (`clear_mcp_connections: true`) and grant back only
what the task genuinely needs — here, nothing but `curl`.

## Two writers, one list, no marker

The mail agent and the WhatsApp agent both filled the same `suggested` array, so whichever
ran second erased the first. Splitting the KV key in two is only half the fix: the browser
posts the *merged* list back when you delete an item, and the server cannot tell that from
an old client posting only its own half. The rule that works: an explicit `bucket` replaces
one half, `merged: true` splits the list by each item's own tag, and a request with neither
may only touch the half that legacy clients used to own. Silent-by-default beats guessing.

## "Replied" is a property of the thread, not the message

A mail is handled when the **newest message in the thread** is yours — not when a message
you sent exists somewhere in it. Reduce over the thread by `internalDate` and check `SENT`
on the winner, and filter out `DRAFT` first or an unsent reply counts as an answer. The
cheap call is `threads.get?format=minimal`: label ids and timestamps, no payload.

## Prune advice only for accounts that answered

Dropping every suggestion whose thread left the pending set looks right until one account's
token expires: its threads vanish from the set and its perfectly good advice gets pruned.
Scope the prune to the accounts that actually returned data this run.

## Gmail's "important" is a guess, and a bad filter

Gating the to-handle list on `is:important OR is:starred` looks like a cheap relevance
filter. It is really a cheap *blindness*: Gmail's marker misses plenty, and a thread you
never starred can still be the one waiting on you. Two months of archive turned up a
funder's reply that unblocked a whole report, sitting unread because nothing had flagged it.

Widen the query and rank instead — but then the marker stops discriminating in the other
direction, because Gmail applies it generously: with the gate removed, nearly every result
came back `important`. Weight a star (something the user chose) above it, and give robot
replies a large penalty or the top of the list fills with "Out of Office".

## `-category:updates` is what actually removes the noise

Shipping notices, bank authorisations, password resets and social notifications all live in
Gmail's `updates` category. Excluding promotions/social/forums but not updates leaves the
loudest bucket in place — it just stays hidden while an importance filter is doing the work.

## Show the newest incoming message, not the search hit

`messages.list` returns whichever message matched. In a thread with several unread messages
that is often not the latest one, so the dashboard quotes stale text. Read the thread once
with `format=minimal`, take the newest non-draft message that isn't `SENT`, and fetch that
one in full — the same call also answers "have I already replied".

## Subrequests are a per-request budget, not a per-account one

A Worker may make 50 subrequests per request on the free plan. Two Gmail calls per opened
thread adds up fast, and a per-account cap multiplies by the number of accounts. Share one
budget across all accounts, or a second working account silently breaks the refresh.

## A long-open page is a stale writer

The browser posted the whole advice list back on every to-do change, so the server could
split it into buckets again. It works until the page has been open for a while: an agent
writes seventeen new items, the user ticks an unrelated to-do, and the page helpfully
posts its hours-old copy — deleting all seventeen. No error, no conflict, nothing in the
log except three buckets stamped at the same instant with `n: 0`.

The fix is not a version check, it is narrowing the verb. The page's only real intent is
"remove this one", so that is all it may send (`removeSuggested: [{id, text}]`). Writers
that own a bucket still replace it by name. The old write-back field is accepted and
ignored, so a cached page cannot destroy anything either.

Match removals on id **or** text: items written by an LLM agent don't reliably carry an id.

## Pinning has to survive the ranking, not ride on it

"Keep this at the top" is worthless if the item can fall out of the set entirely. With a
wide query and a per-refresh budget of opened threads, a pinned thread has to be forced
into the picks, added even when the query no longer returns it at all (read, or out of the
date window), and exempted from the already-answered filter. A pin is an instruction; every
heuristic in the pipeline has to yield to it.

## The whole page is one script tag

An unescaped apostrophe in a UI string (`'Togli dall'alto'`) is a parse error, and because
the dashboard ships as a single inline `<script>`, that one character stops *everything*:
no mail, no agenda, no to-dos, no error visible on the page. The API was fine the whole
time, which makes it look like the data broke rather than the markup.

Deploying is not verifying. Extract the inline script and run `node --check` on it before
`wrangler deploy`, and afterwards open the deployed page and assert on the rendered DOM —
`document.querySelectorAll('#mailRows li').length` is proof; a 200 on `/api/data` is not.

## A draft with real attachments needs its own door

Chat-side mail connectors take attachments as base64 pasted into the call, which stops being
practical at the first PDF. The Worker already holds a `gmail.modify` token, so it gets one
small endpoint: `POST /api/mail/draft` with the body a complete RFC 822 message, relayed to
Gmail's `upload/.../drafts?uploadType=media`. Build the MIME locally with a real mail library
(headers, UTF-8 subject, base64 wrapping are all easy to get subtly wrong by hand) and let
the Worker do nothing but authenticate and forward.

Keep it draft-only on purpose. A token-gated endpoint that can *send* mail is a different
risk class from one that can leave a draft for a human to read and send.

Then verify what Gmail actually stored: fetch the draft back raw and compare each
attachment's hash with the file you meant to attach. The connector's draft view does not
list attachments at all, so "created" tells you nothing about them.

## A parcel is not a shipment id

Grouping shipping mail by the id in the tracking link looks obviously right and is wrong.
When Amazon packs two orders in one box, the "out for delivery" mail links one order's
shipment and the "delivered" mail links the other's: same box, two ids, and the parcel shows
up twice — once delivered, once forever "on its way". Group on what is *inside* instead: two
mails are the same parcel if they share a shipment id **or** an item, a few days apart. The
plain-text part of the mail lists the items cleanly (`* name` / `Quantità: n`); the subject
only carries a truncated first one.

Keep every id seen as an alias of the parcel, and store the user's tick under all of them.
Otherwise a late mail that regroups the parcel under a different id brings a confirmed
parcel back from the dead.

## Marketplaces split one parcel across two senders

Vinted forwards the carrier's mail (it has the tracking number and the pickup PIN, not the
article) and, in the same minute, sends its own update (it has the article, not the
tracking). Nothing in the text ties the two together except the minute they were sent in —
so that is the join: same marketplace, timestamps within three minutes.

Read a stage only from mail the shop wrote about a parcel. Chat notifications between users
contain sentences like "è stato consegnato ieri?" and will be parsed as a delivery.

## "Returned to sender" outranks everything

A parcel left at a pickup point produces "ready", a reminder, and then — if nobody goes — a
mail whose subject is a mild "you did not collect it in time". If the parser has no stage for
that, the parcel stays "ready for pickup" for ever, which is the exact failure a parcel
tracker exists to prevent. Give it its own terminal stage, rank it above "delivered", and
sort it to the top.

## Cache what you read from a mail, including "this is not a parcel"

A mail never changes, so everything derived from one can be cached by message id for good:
the event read from the headers, the details read from the body, and the verdict that it is
not about a parcel at all. A scan is then one search plus fetches only for ids never seen —
a single Gmail request when nothing is new. Version the cache: any change to the parsers
must invalidate it, or old mail keeps its old reading.

A batch request is one HTTP call but each mail in it still counts against the per-second
quota. Cap the mails read per pass, report how many are `pending`, and let the page ask
again until it reaches zero.

## One record, many ticks: queue the writes

All the ticks live in one KV value, so two writes in flight together both start from the old
copy and the second silently undoes the first. From one page that is solved without touching
the server: send one request at a time (chain them on a promise), and queue the reads behind
them too, or a refresh that left before a tick can come back after it with the old state.

Corollary for whoever tests it: never click-test against the live list while its owner may be
using it. Exercise the endpoint with made-up keys; a test that unticks "the first row" will
untick whatever the owner ticked a second earlier.
