// WhatsApp Web recap helpers — paste into the page via claude-in-chrome javascript_tool.
// Requires a loaded, logged-in web.whatsapp.com tab.
//
// RULE: only ever OPEN group chats. Opening a chat marks it read and sends read
// receipts, so 1:1 conversations are never opened — they are reported from the
// list preview only. Group membership is derived from WhatsApp's own "Gruppi"
// filter (see groupNames()), never from a hand-maintained list.
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
window.rowPreviews = () => window.rows().map(r => ({
  n: window.rowName(r),
  tc: (r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 260),
  unread: !!r.querySelector('[aria-label*="non let"]'),
  group: window.isGroup(window.rowName(r)),
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
 * Authoritative set of group chats, straight from WhatsApp's "Gruppi" filter.
 * The filter is a TOGGLE: clicking it twice turns it off and collect() would then
 * sweep the FULL list, 1:1s included. So click once and bail out unless the pane
 * actually changed; if the tab is in the background, timers are throttled to ~1s
 * and collect() takes ~30s — run it detached and poll instead of awaiting it here.
 */
window.groupNames = async () => {
  const before = window.rows().map(window.rowName).join('|');
  await window.clickTab(/^Gruppi/);
  if (window.rows().map(window.rowName).join('|') === before)
    return { error: 'il filtro Gruppi non è cambiato — forse era già attivo e il click lo ha spento. Controlla la lista prima di fidarti.' };
  window.GROUPS = await window.collect();
  return window.GROUPS;
};

window.DONE = new Set();
window.NEVER = window.NEVER || [];   // groups to skip anyway (usually empty)
window.isGroup = name => (window.GROUPS || []).includes(name);
window.isOpenable = name => {
  if (!name || window.DONE.has(name) || !window.isGroup(name)) return false;
  const low = name.toLowerCase();
  return !window.NEVER.some(s => low.includes(s));
};

/**
 * Coordinates for a chat row, already scaled to screenshot pixels.
 * The list reorders live, so ALWAYS call this immediately before the click and
 * check `sottoIlCursore` — never reuse coordinates from an earlier turn.
 */
window.coordsFor = function (q) {
  const row = window.rows().find(r => { const n = window.rowName(r); return n && n.toLowerCase().includes(q.toLowerCase()); });
  if (!row) return { error: 'not found: ' + q };
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
