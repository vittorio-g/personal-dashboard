# Morning routine

Prompt for a Claude Code scheduled task (or any agent with browser control and access
to this repo's endpoints). It sweeps unread WhatsApp **groups**, reads the mail that
needs action, and refills the *Consigli* column.

It drives a real browser session, so it is **not** a headless cron: the machine has to
be on, with WhatsApp Web linked.

Replace `<WORKER>` and `<ACCESS_TOKEN>` before use.

```text
Morning WhatsApp recap: refresh the dashboard's WhatsApp panel AND generate the
"Consigli" (concrete actions) by actually reading mail + WhatsApp.

HARD RULE: only ever open GROUP chats. Never open a 1:1 - opening marks it read and
sends read receipts the user cannot undo. Report 1:1s from the list preview instead,
in leftUnread.

TEMP FILES: always write payloads to these fixed paths, never a per-session temp
folder (its path changes every run and re-triggers permission prompts):
  ./.wa-payload.json          (for /api/whatsapp)
  ./.suggested-payload.json   (for /api/todos)

=== PART 1 - WhatsApp recap ===
Use the whatsapp-recap skill (skills/whatsapp-recap/):
1. Open web.whatsapp.com. If a login QR appears, STOP and report it.
2. Inject helpers.js.
3. Take one screenshot and call window.setScale(<screenshot width>) - the
   screenshot/CSS pixel ratio changes with the window size; never hardcode it.
4. await window.groupNames() - clicks the "Gruppi" filter and caches the
   authoritative list of groups. THIS is what decides which chats may be opened.
5. Click the "Da leggere" tab, list the unread chats and split them with
   window.isOpenable(): groups -> open, everything else -> leftUnread.
6. For each unread group, one at a time: window.coordsFor(name) -> CHECK that
   sottoIlCursore is the expected name (the list reorders live) -> a REAL click at
   {x,y} -> window.after(), and verify `atteso` before reading the messages.
7. Press Escape when finished (an open chat keeps marking new messages as read).
8. Write the payload to .wa-payload.json and POST it to
   https://<WORKER>/api/whatsapp?t=<ACCESS_TOKEN>
   Fields: snapshot, processed, unreadTotal, urgent[{chat,cat,tag,text}],
   leftUnread[{chat,age,text}], groups[{chat,cat,summary}], byCategory.
   groups[] = a 2-3 line recap of EVERY group opened; these stay on the dashboard
   until the user marks them read, so write them to stand on their own.
9. Update contacts.json (new chats + category, lastRun). Never reintroduce a list of
   1:1 chats to open.

=== PART 2 - Consigli: read the mail BODIES ===
1. GET https://<WORKER>/api/data?t=<ACCESS_TOKEN>. Each `mail` entry has subj, from,
   acc, when, badge, **body** (up to 1500 chars) and **links**. Use body, not the
   snippet.
2. Discard: newsletters and promotions, receipts, automated notifications, threads
   already closed by their last message, past or test booking confirmations.
3. For the rest extract: the ACTION (short, imperative); the DEADLINE if real or
   inferable ("away until 16 August" -> follow up on the 17th); the LINK to act on
   (from links - the questionnaire, document or payment, never tracking or
   unsubscribe); and one sentence of CONTEXT.
4. Build `suggested` (max ~10, most urgent first) from mail + whatsapp.urgent:
   {"text":"...","due":"2026-08-17","url":"https://...","src":"mail|whatsapp|scadenza","why":"..."}
   due only as YYYY-MM-DD; omit it rather than invent one. url must be http(s).
5. Write {"suggested":[...]} to .suggested-payload.json and POST it to
   https://<WORKER>/api/todos?t=<ACCESS_TOKEN>. This REPLACES the day's advice.
   Never send the "user" field - that column belongs to the user.

Constraints: send no WhatsApp messages or e-mails, mark nothing as read through the
API, never open a 1:1 chat. Finish with a short summary of the urgent items and the
advice generated.
```

## Why a browser and not a cron

The WhatsApp Cloud API only exposes messages sent to your **business** number. Your
personal chats are end-to-end encrypted and have no API at all — the only way to read
them is the logged-in WhatsApp Web session, driven by a browser. That is a deliberate
trade-off, and the reason this half of the stack cannot be fully automated.

Everything else (mail, calendar, tasks, the WhatsApp bot) runs server-side on the
Worker's cron and needs no machine of yours to be awake.
