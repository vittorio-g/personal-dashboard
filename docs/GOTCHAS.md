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
