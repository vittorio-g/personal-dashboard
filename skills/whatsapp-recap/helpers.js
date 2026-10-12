// WhatsApp Web recap helpers — paste into the page via claude-in-chrome javascript_tool.
// Requires a loaded, logged-in web.whatsapp.com tab.
//
// RULE: only ever OPEN group chats. Opening a chat marks it read and sends read
// receipts, so 1:1 conversations are never opened — they are reported from the
// list preview only. Which chats are groups comes from WhatsApp itself (see
// groupNames()), never from a hand-maintained list. Some groups are reserved and
// never opened either: see NEVER / NEVER_WITH below.
//
// Payload to POST to the dashboard (/api/whatsapp):
// {
//   snapshot: "29 lug, 17:30",           // human label (Europe/Rome)
//   processed: 7, unreadTotal: 12,        // groups opened / chats still unread
//   urgent:   [ {chat, cat, tag, text} ], // actionable: questions, meetings, deadlines
//   leftUnread:[ {chat, age, text} ],     // unread 1:1s -> preview alerts only
//   groups:   [ {chat, cat, summary} ],   // per-group recap; stays until marked read
//   byCategory:{ lavoro:5, amici:2, famiglia:0 }
// }

window.sleep = ms => new Promise(r => setTimeout(r, ms));
window.__sig = () => [...document.querySelectorAll('#main .copyable-text[data-pre-plain-text]')]
  .map(n => n.getAttribute('data-pre-plain-text')).join('|');
window.__ex  = () => [...document.querySelectorAll('#main .copyable-text[data-pre-plain-text]')]
  .map(n => { const m = n.getAttribute('data-pre-plain-text') || '';
              const s = n.querySelector('span.selectable-text');
              return (m + (s ? s.innerText : '')).replace(/\s+/g, ' ').trim().slice(0, 220); });

window.rows    = () => { const p = document.querySelector('#pane-side');
  let r = [...p.querySelectorAll('[role="listitem"]')]; if (!r.length) r = [...p.querySelectorAll('[role="row"]')]; return r; };
window.rowName = row => { const ts = [...row.querySelectorAll('span[title]')]; return ts.length ? ts[0].getAttribute('title') : ''; };
// Preview of every visible row. Use textContent, NOT innerText: when the Chrome
// tab is in the background (document.hidden) innerText comes back empty.
// True when the LAST message of the chat is one of yours: WhatsApp draws the sent/
// delivered/read ticks in the row. If you have already answered, the chat has nothing
// left to hand over to the dashboard.
window.rowMine = row => {
  const icons = [...row.querySelectorAll('span[data-icon]')]
    .map(s => s.getAttribute('data-icon') || '');
  if (icons.some(i => /^(status|msg)-(check|dblcheck|time)/.test(i))) return true;
  const tc = (row.textContent || '').replace(/\s+/g, ' ').trim();
  return /(^|\s)(Tu|You)\s*:/.test(tc.slice(0, 60));
};

window.rowPreviews = () => window.rows().map(r => ({
  n: window.rowName(r),
  tc: (r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 260),
  unread: !!r.querySelector('[aria-label*="non let"]'),
  group: window.isGroup(window.rowName(r)),
  mine: window.rowMine(r),
  // a reserved group: do not report its preview anywhere
  never: window.isGroup(window.rowName(r)) ? window.neverReason(window.rowName(r)) : '',
}));

// Screenshot pixels != CSS pixels, and the ratio changes with the window size.
// Always derive it from the width of a screenshot you just took.
window.setScale = shotWidth => { window.SCALE = shotWidth / window.innerWidth; return window.SCALE; };

window.clickTab = async re => {   // filter tabs DO respond to synthetic clicks
  const t = [...document.querySelectorAll('[role="tab"],button,div[role="button"]')]
    .find(x => re.test((x.innerText || '').trim()));
  if (t) t.click();
  await window.sleep(900);
  return !!t;
};
window.collect = async () => {    // scroll the whole pane, gather every visible chat name
  const p = document.querySelector('#pane-side'); p.scrollTop = 0; await window.sleep(300);
  const s = new Set();
  for (let i = 0; i < 25; i++) {
    window.rows().forEach(r => { const n = window.rowName(r); if (n) s.add(n); });
    p.scrollBy(0, 520); await window.sleep(160);
  }
  p.scrollTop = 0; return [...s];
};
/**
 * Authoritative set of group chats. Read from WhatsApp's in-page store when possible
 * (window.GROUPS_SRC === 'store'); only if that fails, from the "Gruppi" filter of the
 * chat list ('filtro'), which is fragile: sometimes a tab, sometimes a button that ignores
 * synthetic clicks, and always a TOGGLE — clicking it twice turns it off and collect() would then
 * sweep the FULL list, 1:1s included. So click once and bail out unless the pane
 * actually changed; if the tab is in the background, timers are throttled to ~1s
 * and collect() takes ~30s — run it detached and poll instead of awaiting it here.
 */
window.groupNames = async () => {
  // First choice: WhatsApp's own in-page store. A group is a chat whose id ends in @g.us —
  // that is the ground truth, with no filter to click and nothing to scroll. A group that
  // shares its name with a 1:1 chat is left out: when in doubt, it is not openable.
  try {
    const all = window.require('WAWebChatCollection').ChatCollection.getModelsArray();
    const isG = c => !!(c.id && c.id.server === 'g.us');
    const title = c => String(c.formattedTitle || c.name || '');
    const others = new Set(all.filter(c => !isG(c)).map(c => window.__norm(title(c))));
    const gs = all.filter(isG).map(title).filter(t => t && !others.has(window.__norm(t)));
    if (gs.length) { window.GROUPS = gs; window.GROUPS_SRC = 'store'; window.__gset = null; return gs; }
  } catch (e) { /* fall through to the filter */ }
  window.GROUPS_SRC = 'filtro';
  window.__gset = null;
  const before = window.rows().map(window.rowName).join('|');
  await window.clickTab(/^Gruppi/);
  if (window.rows().map(window.rowName).join('|') === before)
    return { error: 'il filtro Gruppi non è cambiato — forse era già attivo e il click lo ha spento. Controlla la lista prima di fidarti.' };
  window.GROUPS = await window.collect();
  return window.GROUPS;
};

window.DONE = new Set();

// ---------------------------------------------------------------------------
// GROUPS THAT ARE NEVER OPENED. The user reads these personally: opening one sends
// "read by" to everybody in it and cannot be undone. They are not summarised, not
// put in `urgent`, not put in `leftUnread`: they simply stay unread in WhatsApp.
// The lists live here, next to the code, so that pasting helpers.js is enough —
// there is no second step that a run could forget.
//   NEVER      : by name (case/accents ignored, substring match)
//   NEVER_WITH : by who is in the group. Each entry is a set of saved-contact names;
//                a group is skipped when ALL the names of an entry are among its members.
// ---------------------------------------------------------------------------
window.NEVER = [
  // 'name of a group you read yourself',
];
window.NEVER_WITH = [
  // ['Alice', 'Bob'],   // every group that has BOTH of these saved contacts in it
];

window.__norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
// Letters and digits only: the name shown in the chat list and the one in the store can
// differ by an emoji or a stray space.
window.__key = s => window.__norm(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Saved-contact names of the members of a group, read from WhatsApp Web's own in-page
 * store. Nothing is opened, clicked or sent. Returns null when it cannot tell (group not
 * found, members not loaded yet, WhatsApp changed its internals).
 */
window.membersOf = name => {
  try {
    const { ChatCollection } = window.require('WAWebChatCollection');
    const { ContactCollection } = window.require('WAWebContactCollection');
    const all = ChatCollection.getModelsArray().filter(c => c.id && c.id.server === 'g.us');
    const want = window.__norm(name), wantKey = window.__key(name);
    let gs = all.filter(c => window.__norm(c.formattedTitle || c.name) === want);
    if (!gs.length && wantKey) gs = all.filter(c => window.__key(c.formattedTitle || c.name) === wantKey);
    if (!gs.length) return null;
    const out = [];
    for (const g of gs) {            // two groups can share a name: take them all, to stay on the safe side
      const m = g.groupMetadata;
      const ps = m && m.participants ? (m.participants.getModelsArray ? m.participants.getModelsArray() : (m.participants._models || [])) : [];
      if (!ps.length) return null;
      for (const p of ps) {
        let c = null; try { c = p.contact || ContactCollection.get(p.id); } catch (e) { /* unknown number */ }
        if (c && c.name) out.push(String(c.name));
      }
    }
    return out;
  } catch (e) { return null; }
};

/**
 * Why a group must NOT be opened, or '' when it may be.
 * Not being able to check the members counts as a reason: a group left unread costs
 * nothing, one read by mistake cannot be taken back. Report those in the final summary.
 */
window.neverReason = name => {
  const low = window.__norm(name);
  if (window.NEVER.some(s => low.includes(window.__norm(s)))) return 'per nome';
  if (!window.NEVER_WITH.length) return '';
  const mem = window.membersOf(name);
  if (!mem) return 'partecipanti non verificabili';
  const set = new Set(mem.map(window.__norm));
  const hit = window.NEVER_WITH.find(grp => grp.every(n => set.has(window.__norm(n))));
  return hit ? 'partecipanti ' + hit.join(' e ') : '';
};

window.isGroup = name => {
  if (!window.__gset || window.__gsetOf !== window.GROUPS) {
    window.__gset = new Set((window.GROUPS || []).map(window.__norm));
    window.__gsetOf = window.GROUPS;
  }
  return !!name && window.__gset.has(window.__norm(name));
};
window.isOpenable = name => !!name && !window.DONE.has(name) && window.isGroup(name) && !window.neverReason(name);

/**
 * Make sure the member lists of these groups are loaded. WhatsApp fills them in by itself
 * during the first minute or so after the page opens; until then membersOf() answers null
 * and the group counts as "non verificabile". This asks WhatsApp for the missing ones — the
 * same request it makes on its own. Nothing is opened, nothing is marked as read.
 */
window.ensureMembers = async (names, msEach = 6000, msTotal = 30000) => {
  let coll = null, all = [];
  try {
    const m = window.require('WAWebGroupMetadataCollection');
    coll = m && typeof m.find === 'function' ? m : (m && m.default && typeof m.default.find === 'function' ? m.default : null);
    all = window.require('WAWebChatCollection').ChatCollection.getModelsArray().filter(c => c.id && c.id.server === 'g.us');
  } catch (e) { return { error: 'store non raggiungibile' }; }
  const out = { giaNoti: 0, caricati: 0, falliti: [] };
  const t0 = Date.now();
  for (const n of names) {
    if (window.membersOf(n)) { out.giaNoti++; continue; }
    if (coll && Date.now() - t0 < msTotal) {
      const want = window.__norm(n), key = window.__key(n);
      const gs = all.filter(c => window.__norm(c.formattedTitle || c.name) === want || window.__key(c.formattedTitle || c.name) === key);
      for (const g of gs) {
        try { await Promise.race([coll.find(g.id), new Promise(r => setTimeout(r, msEach))]); } catch (e) { /* stays unknown */ }
      }
    }
    if (window.membersOf(n)) out.caricati++; else out.falliti.push(n);
  }
  return out;
};

/**
 * One call that splits the unread rows: what to open, what to leave alone and why.
 * ASYNC — `await window.triage()` — because it first loads the member lists it needs.
 */
window.triage = async () => {
  const unread = window.rows().filter(r => r.querySelector('[aria-label*="non let"]')).map(window.rowName).filter(Boolean);
  await window.ensureMembers(unread.filter(n => window.isGroup(n)));
  const open = [], skipped = [], oneToOne = [];
  for (const n of unread) {
    if (!window.isGroup(n)) { oneToOne.push(n); continue; }
    const why = window.neverReason(n);
    if (why) skipped.push({ chat: n, why }); else if (!window.DONE.has(n)) open.push(n);
  }
  return { open, skipped, oneToOne };
};

/**
 * Coordinates for a chat row, already scaled to screenshot pixels.
 * The list reorders live, so ALWAYS call this immediately before the click and
 * check `sottoIlCursore` — never reuse coordinates from an earlier turn.
 */
window.coordsFor = function (q) {
  const row = window.rows().find(r => { const n = window.rowName(r); return n && n.toLowerCase().includes(q.toLowerCase()); });
  if (!row) return { error: 'not found: ' + q };
  // Last line of defence: no coordinates, no click. A 1:1 chat or a reserved group
  // cannot be opened through this helper even if the caller forgot to check.
  const rn = window.rowName(row);
  if (!window.isGroup(rn)) return { error: 'NON APRIRE: "' + rn + '" non risulta un gruppo (hai chiamato groupNames()?)' };
  const why = window.neverReason(rn);
  if (why === 'partecipanti non verificabili') return { error: 'NON APRIRE (per ora): non so chi c\'è in "' + rn + '". Fai `await window.ensureMembers(["' + rn + '"])` e riprova; se resta così, lascialo stare e segnalalo.' };
  if (why) return { error: 'NON APRIRE: "' + rn + '" è un gruppo riservato (' + why + ')' };
  const r = row.getBoundingClientRect();
  if (r.top < 150 || r.bottom > 780) return { error: 'fuori vista — scrolla #pane-side', top: Math.round(r.top) };
  window.__sigBefore = window.__sig();
  window.__expect = window.rowName(row);
  const x = Math.round((r.left + r.width / 2) * window.SCALE), y = Math.round((r.top + r.height / 2) * window.SCALE);
  const under = document.elementFromPoint(x / window.SCALE, y / window.SCALE);
  const urow = under && (under.closest('[role="listitem"]') || under.closest('[role="row"]'));
  return { name: window.__expect, x, y, sottoIlCursore: urow ? window.rowName(urow) : null };
};
/** Call after a REAL click (computer left_click). Synthetic clicks and `ref` clicks do NOT work. */
window.after = function () {
  const h = document.querySelector('#main header span[title]');
  return { atteso: window.__expect, aperta: h ? h.getAttribute('title') : null,
           n: window.__ex().length, msgs: window.__ex().slice(-14) };
};
// Press Escape to close a chat when done — an open chat keeps marking new
// incoming messages as read.
