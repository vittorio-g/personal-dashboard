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
4. `await window.groupNames()` — clicks the **"Gruppi"** filter and caches the authoritative list of group chats in `window.GROUPS`. **This is what decides what may be opened**; `contacts.json` only carries categories and notes.
5. JS-click the **"Da leggere"** tab (filter tabs respond to `.click()`; only chat ROWS need real clicks). List the unread names and split them with `window.isOpenable()`: groups → open, everything else → `leftUnread` (preview only).
   - **Already answered → already handled.** `window.rowPreviews()` returns `mine: true` when the row shows the sent/delivered/read ticks, i.e. the last message of that chat is the user's. Keep those out of `urgent` and `leftUnread`, and set `mine: true` on the entry if you send it anyway — the Worker drops them server-side too. Same for anything you list in the payload's `replied: ["chat name", ...]`.
6. For each unread group, one at a time:
   - JS `window.coordsFor(name)` → **check `sottoIlCursore === name`** (the list reorders live); if it says `fuori vista`, scroll `#pane-side` and retry.
   - `computer left_click` at `{x,y}` (a REAL click — synthetic clicks and `ref` clicks do nothing).
   - JS `window.after()` → verify `atteso` matches, then read `msgs`.
7. Press **Escape** when finished, so an open chat stops marking incoming messages as read. Classify each group; extract **action items**: direct questions to the user, meetings/Meet-Zoom links + times, deadlines, sensitive personal events. Build the payload (schema at top of `helpers.js`).
7. POST: `POST https://<WORKER>/api/whatsapp?t=<ACCESS_TOKEN>` with the JSON body (ACCESS_TOKEN = the dashboard secret).
   The response echoes `repliedDropped` — how many chats were dropped as already answered.
8. Update `contacts.json`: add newly-seen chats + category, set `lastRun`.
9. **Clean up.** Close every tab this run opened with `tabs_close_mcp`, using the tab ids from step 1 — leave any tab that was already open untouched. Chrome drops the tab group by itself once its last tab is gone, so there is nothing else to remove. Closing the tab does **not** unlink WhatsApp Web: the phone pairing survives and the next run just loads.

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
- Never send messages, react, or mark-as-unread unless the user explicitly asks.
