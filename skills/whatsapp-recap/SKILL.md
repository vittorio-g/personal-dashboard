---
name: whatsapp-recap
description: Sweep the user's WhatsApp Web unread chats (via the claude-in-chrome browser), recap the groups, flag urgent/neglected items, leave important 1:1s unread, and push the result to the personal dashboard. Use when the user asks for a WhatsApp recap, "cosa mi sono perso su WhatsApp", or to refresh the dashboard WhatsApp panel.
---

# WhatsApp recap pipeline

Reads the user's **already-linked WhatsApp Web** session in the claude-in-chrome browser, recaps the unread **groups** + seem-closed 1:1s, **leaves important 1:1s unread** (preview-alert only), classifies work/friends/family, and POSTs the recap to the dashboard Worker.

⚠️ Opening a chat **marks it read and sends read receipts** (blue ticks / group "read by"). That's why important 1:1s are never opened.

## Why it works this way (verified)
- WhatsApp Web message text is **encrypted at rest** in IndexedDB (`model-storage`, blob + IV) → no bulk read. You must OPEN each chat (the app decrypts into the DOM) and extract from the DOM.
- WhatsApp only reacts to **trusted clicks** → JS `.click()`/dispatched events do NOT navigate. Open a chat with a REAL `computer` left_click at coordinates computed by JS; extract with JS.
- Use the **"Da leggere"** filter and always open the **top openable row**: once read it leaves the filter, the list shrinks, and there's no virtualization. (The full "Gruppi" list is 130+ groups and virtualized — avoid it.)

## Procedure
1. claude-in-chrome: **first call `tabs_context` and note which tabs were already open** — the cleanup at the end must close only what this run created, never a tab the user was using. Then open a tab on `https://web.whatsapp.com`. If it shows a QR, ask the user to scan once (already linked normally → it just loads).
2. Paste `helpers.js` via `javascript_tool` (defines the helpers on `window`).
3. Take one screenshot and call `window.setScale(<screenshot width>)` — the screenshot/CSS pixel ratio changes with the window size, so never hardcode it.
4. `await window.groupNames()` — caches the authoritative list of group chats in `window.GROUPS`. It reads WhatsApp's in-page store (a group is a chat whose id ends in `@g.us`), so nothing is clicked; check that `window.GROUPS_SRC === 'store'` and that the list has hundreds of names. Only if the store is unreachable does it fall back to the **"Gruppi"** filter of the chat list (`GROUPS_SRC === 'filtro'`), which is a toggle and sometimes ignores synthetic clicks — verify the list really changed. **`window.GROUPS` is what decides what may be opened**; `contacts.json` only carries categories and notes.
5. JS-click the **"Da leggere"** tab (filter tabs respond to `.click()`; only chat ROWS need real clicks). Call `window.triage()`: it returns `open` (groups you may open), `skipped` (**reserved groups — never open them**, see below) and `oneToOne` (preview only → `leftUnread`).
   - **Reserved groups.** `helpers.js` carries two lists set by the user: `window.NEVER` (by name) and `window.NEVER_WITH` (by members — a group is reserved when all the listed contacts are in it; membership is read from WhatsApp's in-page store by `window.membersOf()`, without opening anything). A reserved group is **not opened, not summarised, not put in `urgent`, `groups` or `leftUnread`**: it stays unread for the user. `coordsFor()` refuses to give coordinates for one, so there is nothing to click. If the reason is `partecipanti non verificabili`, the group is skipped too — say so in the final report, with the names. Never edit the two lists yourself.
   - **Already answered → already handled.** `window.rowPreviews()` returns `mine: true` when the row shows the sent/delivered/read ticks, i.e. the last message of that chat is the user's. Keep those out of `urgent` and `leftUnread`, and set `mine: true` on the entry if you send it anyway — the Worker drops them server-side too. Same for anything you list in the payload's `replied: ["chat name", ...]`.
6. For each unread group, one at a time:
   - JS `window.coordsFor(name)` → **check `sottoIlCursore === name`** (the list reorders live); if it says `fuori vista`, scroll `#pane-side` and retry.
   - `computer left_click` at `{x,y}` (a REAL click — synthetic clicks and `ref` clicks do nothing).
   - JS `window.after()` → verify `atteso` matches, then read `msgs`.
7. Press **Escape** when finished, so an open chat stops marking incoming messages as read. Classify each group; extract **action items**: direct questions to the user, meetings/Meet-Zoom links + times, deadlines, sensitive personal events. Build the payload (schema at top of `helpers.js`).
7. POST the JSON body to `https://<WORKER>/api/whatsapp?t=<ACCESS_TOKEN>` (ACCESS_TOKEN = the dashboard secret). Scheduled runs are in *don't ask* mode, where only pre-approved calls go through, so do it exactly like this:
   - write the body with the **Write** tool to `<project>/.wa-payload.json` (and the advice to `.suggested-payload.json` next to it). These two files are the only ones a scheduled run may write — each has its own allow rule in the project's `.claude/settings.local.json`. They already exist, so Read first, then Write. **The skill folder itself is read-only for a scheduled run**: `~/.claude` is protected and no allow rule opens it (tested 12/10/2026), so `contacts.json` and `helpers.js` can only be changed from an interactive session.
   - send it with **one single-line** Bash command that starts with `curl`: `curl -s -X POST "<url>" -H "content-type: application/json" --data-binary "@<project>/.wa-payload.json"`. No `cd`, no `&&`, no heredoc, no PowerShell: anything but a plain one-line `curl …` is refused (a heredoc after `curl` is refused too).
   - if either step is refused anyway, fall back to the browser: navigate your own tab to `<Worker>/robots.txt` and `fetch('/api/whatsapp?t=…', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload)})` from `javascript_tool`.
   The response echoes `repliedDropped` — how many chats were dropped as already answered. **Check for `{"ok":true}`; if the recap did not reach the dashboard, say so in the first line of the final report.**
8. Update `contacts.json` (newly-seen chats + category, `lastRun`) **only in an interactive session**. A scheduled run cannot write it: list the new chats in the final report instead.
9. **Clean up — always, even if the run broke halfway.** Call `tabs_context_mcp` (without `createIfEmpty`) and close **every** tab it lists with `tabs_close_mcp`: the group is yours, nothing of the user's is in it. Then call `tabs_context_mcp` once more: it must answer that no tab group exists. That answer is the proof the tab group is gone (Chrome deletes it when its last tab closes; a group whose tabs are left open stays in the user's bookmarks bar as a "Whatsapp recap mattina" chip, one per run). If a close is refused or the group is still there, write **"gruppo di schede NON eliminato"** in the final report — never claim a cleanup you could not verify.
   - Create **one** tab group per run: call `tabs_context_mcp` with `createIfEmpty: true` only once, at the start. If a tool later says your tab is not in your group (the browser reconnected), close what you can, then create a new group and note the old tab id in the report as left behind.
   - Closing the tab does **not** unlink WhatsApp Web: the phone pairing survives and the next run just loads.

## Consigli: only your half of the list
The *Consigli* column has two independent halves. The mail half is generated in the cloud by the
Worker's cron — **never touch it**. When this skill contributes WhatsApp advice it must post

```json
{ "bucket": "wa", "suggested": [ … ] }
```

to `/api/todos?t=<ACCESS_TOKEN>`. Posting without `bucket` still only replaces the WhatsApp half,
but be explicit. Never send the `user` field: that column belongs to the user.

## Incremental (cheap) runs
After the first pass, skip chats whose list timestamp hasn't changed since `lastRun`; only deep-read new activity. First full run ≈ a few hundred K tokens; incremental ≈ tens of K.

## Never
- **Never open a 1:1 chat — only groups.** Opening marks it read *and* sends read receipts, which the user cannot undo. 1:1s are reported from the list preview only. (This rule exists because a 1:1 once got opened from a stale allow-list; don't reintroduce one.)
- **Never open a reserved group** (`window.NEVER`, `window.NEVER_WITH` in `helpers.js`). The user reads those personally; opening one shows everybody in the group that the messages were read. Rule set by the user on 12/10/2026.
- Never send messages, react, or mark-as-unread unless the user explicitly asks.
