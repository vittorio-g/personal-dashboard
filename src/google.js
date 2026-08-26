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

function classify(subject, from) {
  const t = ((subject || "") + " " + (from || "")).toLowerCase();
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
 * True when the newest message of a thread was sent by us (drafts don't count).
 * format=minimal keeps this to one cheap call per thread.
 */
async function answeredByMe(accessToken, threadId) {
  if (!threadId) return false;
  const th = await gapi(GMAIL_BASE + "/threads/" + encodeURIComponent(threadId) + "?format=minimal", accessToken);
  const msgs = (th.messages || []).filter((m) => !(m.labelIds || []).includes("DRAFT"));
  if (!msgs.length) return false;
  const last = msgs.reduce((a, b) => (Number(b.internalDate || 0) >= Number(a.internalDate || 0) ? b : a));
  return (last.labelIds || []).includes("SENT");
}

/**
 * Gmail snapshot for one account.
 * Returns { unread, unread24h, daGestire (count), items: [...] }.
 */
export async function gmailSnapshot(accessToken, accId, maxItems = 12) {
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

  // "Da gestire" = unread that Gmail marks important, or that you starred — recent, primary-ish.
  const q = "is:unread (is:important OR is:starred) -category:promotions -category:social -category:forums newer_than:30d";
  const list = await gapi(GMAIL_BASE + "/messages?maxResults=40&q=" + encodeURIComponent(q), accessToken);
  const stubs = list.messages || [];
  // Dedupe by thread so reply chains ("Re:", "R:") count once.
  const seen = new Set();
  const picks = [];
  for (const s of stubs) {
    if (seen.has(s.threadId)) continue;
    seen.add(s.threadId);
    if (picks.length < maxItems) picks.push({ id: s.id, threadId: s.threadId });
  }
  const daGestireCapped = !!list.nextPageToken;

  const items = [];
  const replied = [];
  for (const p of picks) {
    const id = p.id;
    // Already answered? If the newest message of the thread is one of ours, the ball is in
    // their court: drop it instead of nagging about something you have already handled.
    try {
      if (await answeredByMe(accessToken, p.threadId)) { replied.push(p.threadId); continue; }
    } catch (_) { /* when in doubt, keep the thread */ }
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
      if (starred && c.status === "info") c.status = "warning";
      const snippet = decodeEntities(msg.snippet).slice(0, 200);
      const raw = extractBody(msg.payload);
      const body = decodeEntities(raw).slice(0, 1500);
      const links = extractLinks(raw);
      items.push({ id, threadId: p.threadId, subj: subject, from, acc: accId, when, status: c.status, badge: c.badge, important, starred, snippet, body, links });
    } catch (_) { /* skip this message */ }
  }
  // Threads still waiting for you. Used to prune advice about mail you have since handled.
  const pending = [...seen].filter((t) => !replied.includes(t));
  const daGestire = pending.length;
  return { unread, unread24h, unread24hCapped, daGestire, daGestireCapped, replied: replied.length, pending, items };
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
