// Google API helpers: OAuth refresh-token flow + Gmail + Calendar (read-only).
// No external deps — runs on the Workers runtime with global fetch.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary";

/** Exchange a long-lived refresh token for a short-lived access token. */
export async function getAccessToken(clientId, clientSecret, refreshToken) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error("token_error:" + (j.error || r.status));
  }
  return j.access_token;
}

async function gapi(url, accessToken) {
  const r = await fetch(url, { headers: { authorization: "Bearer " + accessToken } });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("gapi_" + r.status + ":" + t.slice(0, 200));
  }
  return r.json();
}

function header(msg, name) {
  const hs = (msg.payload && msg.payload.headers) || [];
  const h = hs.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

/** Clean a "From" header into a display name or bare email. */
function fromName(raw) {
  if (!raw) return "";
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m && m[1].trim()) return m[1].trim();
  if (m) return m[2].trim();
  return raw.replace(/[<>]/g, "").trim();
}

/** Decode the HTML entities Gmail puts in message snippets, so the stored text is plain. */
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&#?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

/** Decode a Gmail base64url body part into UTF-8 text. */
function b64urlToText(data) {
  const b64 = String(data || "").replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch (_) { return ""; }
}

/** Walk a Gmail payload tree and return the message body as plain text. */
function extractBody(payload) {
  if (!payload) return "";
  const stack = [payload];
  let html = "";
  while (stack.length) {
    const p = stack.shift();
    if (p.mimeType === "text/plain" && p.body && p.body.data) return b64urlToText(p.body.data);
    if (p.mimeType === "text/html" && p.body && p.body.data && !html) html = b64urlToText(p.body.data);
    if (p.parts) stack.push(...p.parts);
  }
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

const LINK_NOISE = /unsubscribe|opt.?out|list-manage|watermark|\.gif|\.png|\.jpg|tracking|pixel|utm_|preferences|privacy|facebook\.com|twitter\.com|linkedin\.com\/legal/i;

/** Pull the first few meaningful http(s) links out of a message body. */
function extractLinks(text, max = 5) {
  const out = [];
  const re = /https?:\/\/[^\s"'<>)\]]+/g;
  let m;
  while ((m = re.exec(text)) && out.length < max) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (LINK_NOISE.test(url)) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

// Mail written by a machine in reply to you: never an action, but occasionally carries a
// date worth keeping ("back on the 2nd"), so it is buried rather than dropped.
const AUTO_RE = /^\s*(risposta automatica|automatic reply|out of office|auto[- ]?reply|undeliverable|delivery status notification|mail delivery)/i;

function classify(subject, from) {
  const t = ((subject || "") + " " + (from || "")).toLowerCase();
  if (AUTO_RE.test(String(subject || ""))) return { status: "info", badge: "Automatica", auto: true };
  let status = "info";
  if (/sollecit|urgent|scadut|last reminder|final notice|overdue|entro oggi|entro domani/.test(t)) status = "critical";
  else if (/scad|deadline|entro il|rinnov|expir|renew|in scadenza|termina il|pagament|payment|fattur|invoice|conferma entro/.test(t)) status = "warning";

  let badge;
  if (/sollecit/.test(t)) badge = "Sollecito";
  else if (/rinnov|renew|membership|abbonament/.test(t)) badge = "Rinnovo";
  else if (/scad|expir|termina|in scadenza|deadline/.test(t)) badge = "In scadenza";
  else if (/fattur|pagament|payment|invoice|addebito/.test(t)) badge = "Pagamento";
  else if (/rispond|reply|richiesta|request|conferma|compila|form/.test(t)) badge = "Da rispondere";
  else if (status === "critical") badge = "Urgente";
  else badge = "Da gestire";

  return { status, badge };
}

/**
 * One cheap metadata call per thread that answers both questions at once:
 * have I already replied (newest non-draft message is mine), and if not, which message
 * should the dashboard actually show — the newest one FROM someone else, not whichever
 * message the search happened to return first.
 */
async function threadState(accessToken, threadId) {
  const th = await gapi(GMAIL_BASE + "/threads/" + encodeURIComponent(threadId) + "?format=minimal", accessToken);
  const msgs = (th.messages || []).filter((m) => !(m.labelIds || []).includes("DRAFT"));
  if (!msgs.length) return { answered: false, showId: null };
  const newest = (a, b) => (Number(b.internalDate || 0) >= Number(a.internalDate || 0) ? b : a);
  const last = msgs.reduce(newest);
  if ((last.labelIds || []).includes("SENT")) return { answered: true, showId: null };
  const incoming = msgs.filter((m) => !(m.labelIds || []).includes("SENT"));
  return { answered: false, showId: (incoming.length ? incoming.reduce(newest) : last).id };
}

/**
 * Gmail snapshot for one account.
 * Returns { unread, unread24h, daGestire (count), items: [...] }.
 */
export async function gmailSnapshot(accessToken, accId, maxItems = 12, pinned = []) {
  // Total unread from the UNREAD system label.
  let unread = 0;
  try {
    const lbl = await gapi(GMAIL_BASE + "/labels/UNREAD", accessToken);
    unread = lbl.messagesTotal || lbl.messagesUnread || 0;
  } catch (_) { /* keep 0 */ }

  // Unread in the last 24h — primary-ish (drop promo/social newsletter noise).
  // Count real message stubs (resultSizeEstimate is unreliable); cap the display.
  let unread24h = 0, unread24hCapped = false;
  try {
    const q24 = await gapi(GMAIL_BASE + "/messages?maxResults=60&q=" + encodeURIComponent("is:unread newer_than:1d -category:promotions -category:social"), accessToken);
    unread24h = (q24.messages || []).length;
    unread24hCapped = !!q24.nextPageToken;
  } catch (_) {}

  // "Da gestire" = every unread that isn't bulk, over two months. Importance and stars are
  // deliberately NOT a filter here: Gmail's importance marker misses plenty, and a thread
  // you never starred can still be the one waiting on you. They come back below as a
  // ranking boost instead, so widening the net doesn't cost us the signal.
  const BASE = "-category:promotions -category:social -category:forums -category:updates newer_than:60d";
  const list = await gapi(GMAIL_BASE + "/messages?maxResults=100&q=" + encodeURIComponent("is:unread " + BASE), accessToken);
  const stubs = list.messages || [];

  // A second, narrow pass. With hundreds of unread threads the wide net alone would fill
  // every slot with whatever arrived most recently, so important/starred threads keep
  // guaranteed places at the front of the queue.
  const prio = new Set();
  try {
    const p = await gapi(GMAIL_BASE + "/messages?maxResults=50&q=" +
      encodeURIComponent("is:unread (is:important OR is:starred) " + BASE), accessToken);
    for (const st of p.messages || []) prio.add(st.threadId);
  } catch (_) { /* ranking nicety, not worth failing the snapshot over */ }

  // Dedupe by thread so reply chains ("Re:", "R:") count once, priority threads first
  // (Gmail's own recency order is preserved inside each group).
  const seen = new Set();
  const order = [];
  for (const st of stubs) {
    if (seen.has(st.threadId)) continue;
    seen.add(st.threadId);
    order.push(st.threadId);
  }
  // A pinned thread must be opened even when it would never survive the ranking, or on a
  // busy day the one thing you asked to keep in sight is the one that drops off.
  const pin = new Set(pinned || []);
  order.sort((a, b) => {
    const p = (pin.has(b) ? 2 : 0) - (pin.has(a) ? 2 : 0);
    if (p) return p;
    return (prio.has(b) ? 1 : 0) - (prio.has(a) ? 1 : 0);
  });
  // Pinned threads that the query didn't return at all (read, or older than the window)
  // are added by hand: pinning means "keep showing me this", full stop.
  for (const t of pin) if (!seen.has(t)) { seen.add(t); order.unshift(t); }
  const picks = order.slice(0, maxItems).map((t) => ({ threadId: t }));
  const daGestireCapped = !!list.nextPageToken;

  const items = [];
  const replied = [];
  for (const p of picks) {
    // Already answered? If the newest message of the thread is one of ours, the ball is in
    // their court: drop it instead of nagging about something you have already handled.
    let id;
    try {
      const st = await threadState(accessToken, p.threadId);
      if (st.answered && !pin.has(p.threadId)) { replied.push(p.threadId); continue; }
      id = st.showId;
    } catch (_) { /* when in doubt, keep the thread */ }
    if (!id) continue;
    try {
      // format=full so we can surface the actual body (deadlines, asks, links),
      // not just Gmail's 200-char snippet.
      const msg = await gapi(GMAIL_BASE + "/messages/" + id + "?format=full", accessToken);
      const subject = header(msg, "Subject") || "(senza oggetto)";
      const from = fromName(header(msg, "From"));
      const dateHdr = header(msg, "Date");
      const when = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : (dateHdr ? new Date(dateHdr).toISOString() : null);
      const important = (msg.labelIds || []).includes("IMPORTANT");
      const starred = (msg.labelIds || []).includes("STARRED");
      const c = classify(subject, from);
      if (starred && c.status === "info" && !c.auto) c.status = "warning";
      const snippet = decodeEntities(msg.snippet).slice(0, 200);
      const raw = extractBody(msg.payload);
      const body = decodeEntities(raw).slice(0, 1500);
      const links = extractLinks(raw);
      items.push({ id, threadId: p.threadId, subj: subject, from, acc: accId, when, status: c.status, badge: c.badge, auto: !!c.auto, pinned: pin.has(p.threadId), important, starred, snippet, body, links });
    } catch (_) { /* skip this message */ }
  }
  // Threads still waiting for you. Used to prune advice about mail you have since handled.
  const pending = [...seen].filter((t) => !replied.includes(t));
  const daGestire = pending.length;
  return { unread, unread24h, unread24hCapped, daGestire, daGestireCapped, replied: replied.length, pending, items, picked: picks.length };
}

function offsetStr(date, timeZone) {
  // Current UTC offset (minutes) for the given IANA zone, formatted as +HH:MM.
  const s = date.toLocaleString("en-US", { timeZone, hour12: false });
  const u = date.toLocaleString("en-US", { timeZone: "UTC", hour12: false });
  const mins = Math.round((Date.parse(s) - Date.parse(u)) / 60000);
  const sign = mins >= 0 ? "+" : "-";
  const a = Math.abs(mins);
  return sign + String(Math.floor(a / 60)).padStart(2, "0") + ":" + String(a % 60).padStart(2, "0");
}

function romeDateParts(date) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (t) => p.find((x) => x.type === t).value;
  return { y: get("year"), m: get("month"), d: get("day") };
}

const MONTHS_IT = ["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];

function hhmmRome(iso) {
  return new Date(iso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" });
}

/**
 * Calendar snapshot for one account (primary calendar), for "today" in Europe/Rome.
 * Returns { timed: [...], allday: [...] }.
 */
export async function calendarSnapshot(accessToken, accId, now = new Date()) {
  const { y, m, d } = romeDateParts(now);
  const off = offsetStr(now, "Europe/Rome");
  const timeMin = `${y}-${m}-${d}T00:00:00${off}`;
  const timeMax = `${y}-${m}-${d}T23:59:59${off}`;
  const url = CAL_BASE + "/events?" + new URLSearchParams({
    timeMin, timeMax, singleEvents: "true", orderBy: "startTime",
    timeZone: "Europe/Rome", maxResults: "50",
  });
  const data = await gapi(url, accessToken);
  const timed = [];
  const allday = [];
  for (const ev of data.items || []) {
    if (ev.status === "cancelled") continue;
    const summary = ev.summary || "(senza titolo)";
    if (ev.start && ev.start.date) {
      // All-day (possibly multi-day). end.date is exclusive.
      let range = "";
      try {
        const sd = ev.start.date.split("-");
        const ed = ev.end && ev.end.date ? ev.end.date.split("-") : null;
        const startTxt = `${+sd[2]}` + (ed && (ed[1] !== sd[1]) ? " " + MONTHS_IT[+sd[1] - 1] : "");
        if (ed) {
          const endDate = new Date(Date.UTC(+ed[0], +ed[1] - 1, +ed[2] - 1)); // inclusive last day
          const em = endDate.getUTCMonth(), edd = endDate.getUTCDate();
          if (`${+sd[0]}-${+sd[1]}-${+sd[2]}` !== `${endDate.getUTCFullYear()}-${em + 1}-${edd}`) {
            range = `${+sd[2]}–${edd} ${MONTHS_IT[em]}`;
          }
        }
      } catch (_) {}
      allday.push({ name: summary, range, acc: accId });
    } else if (ev.start && ev.start.dateTime) {
      timed.push({
        s: hhmmRome(ev.start.dateTime),
        e: ev.end && ev.end.dateTime ? hhmmRome(ev.end.dateTime) : "",
        name: summary,
        where: ev.location || "",
        acc: accId,
      });
    }
  }
  return { timed, allday };
}

/** Create an event on the primary calendar. Requires a calendar write scope. */
export async function createEvent(accessToken, event) {
  const r = await fetch(CAL_BASE + "/events", {
    method: "POST",
    headers: { authorization: "Bearer " + accessToken, "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("gapi_" + r.status + ":" + t.slice(0, 300));
  }
  return r.json();
}

/** Add/remove Gmail labels on a message. Requires the gmail.modify scope. */
export async function modifyMessage(accessToken, id, { add = [], remove = [] } = {}) {
  const r = await fetch(GMAIL_BASE + "/messages/" + encodeURIComponent(id) + "/modify", {
    method: "POST",
    headers: { authorization: "Bearer " + accessToken, "content-type": "application/json" },
    body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("gapi_" + r.status + ":" + t.slice(0, 200));
  }
  return r.json();
}

/** Add/remove labels on a whole THREAD (all its messages). Requires the gmail.modify scope. */
export async function modifyThread(accessToken, threadId, { add = [], remove = [] } = {}) {
  const r = await fetch(GMAIL_BASE + "/threads/" + encodeURIComponent(threadId) + "/modify", {
    method: "POST",
    headers: { authorization: "Bearer " + accessToken, "content-type": "application/json" },
    body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("gapi_" + r.status + ":" + t.slice(0, 200));
  }
  return r.json();
}

/**
 * Create a Gmail DRAFT from a complete RFC 822 message. The caller builds the MIME (so any
 * attachment works); this only stores it under Drafts and can never send it.
 * Requires the gmail.modify scope.
 */
export async function createDraftRaw(accessToken, rfc822) {
  const r = await fetch("https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media", {
    method: "POST",
    headers: { authorization: "Bearer " + accessToken, "content-type": "message/rfc822" },
    body: rfc822,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("gapi_" + r.status + ":" + t.slice(0, 300));
  }
  return r.json();
}

/** Move a message to Trash. Requires the gmail.modify scope. */
export async function trashMessage(accessToken, id) {
  const r = await fetch(GMAIL_BASE + "/messages/" + encodeURIComponent(id) + "/trash", {
    method: "POST",
    headers: { authorization: "Bearer " + accessToken },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("gapi_" + r.status + ":" + t.slice(0, 200));
  }
  return r.json();
}
