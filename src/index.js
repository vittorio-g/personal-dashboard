// Personal dashboard Worker — serves the page + a live /api/data backed by
// Gmail + Google Calendar (read-only OAuth), cached in KV and refreshed on cron.
import DASHBOARD_HTML from "../public/dashboard.html";
import { getAccessToken, gmailSnapshot, calendarSnapshot, modifyMessage, modifyThread, trashMessage, createEvent } from "./google.js";

const KV_KEY = "snapshot";
const WA_KEY = "whatsapp";
const TODO_USER_KEY = "todos_user";
// Consigli live in two separate buckets, so the cloud half and the browser half never
// overwrite each other: "mail" is written by a scheduled cloud Claude Code routine,
// "wa" by the local WhatsApp recap task. Neither can clobber the other.
const TODO_SUG_KEY = "todos_suggested";        // bucket "wa"
const TODO_SUG_MAIL_KEY = "todos_suggested_mail"; // bucket "mail"
const TODO_SUG_SWEEP_KEY = "todos_suggested_sweep"; // bucket "sweep" - manual deep passes
const CONSIGLI_STATUS_KEY = "consigli_status";
const WA_DISMISS_KEY = "wa_dismissed";
const WA_GROUPS_READ_KEY = "wa_groups_read";
const WA_INBOX_KEY = "wa_inbox";
const WA_SEEN_KEY = "wa_seen_ids";

const GRAPH = "https://graph.facebook.com/v21.0";

/** Constant-time-ish compare of the X-Hub-Signature-256 header against the raw body. */
async function validSignature(env, raw, header) {
  const secret = String(env.WHATSAPP_APP_SECRET || "").trim();
  if (!secret || !header) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const got = String(header).replace(/^sha256=/, "");
  if (got.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

/** Reply on WhatsApp. Free-form text is allowed inside the 24h window opened by the user's message. */
async function waReply(env, to, body) {
  // .trim(): secrets piped in from a shell can carry a trailing newline, which
  // would corrupt both the URL and the Authorization header.
  const token = String(env.WHATSAPP_TOKEN || "").trim();
  const phone = String(env.WHATSAPP_PHONE_ID || "").trim();
  if (!token || !phone) return { ok: false, error: "token o phone id mancanti" };
  try {
    const r = await fetch(GRAPH + "/" + phone + "/messages", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: String(body).slice(0, 1000) } }),
    });
    const txt = await r.text();
    // Keep the last failure around: a silent catch here is what hid this bug.
    if (!r.ok) await env.DASH_KV.put("wa_last_send_error", JSON.stringify({ at: Date.now(), status: r.status, body: txt.slice(0, 500) }));
    return { ok: r.ok, status: r.status, body: txt.slice(0, 300) };
  } catch (e) {
    const err = String((e && e.message) || e);
    await env.DASH_KV.put("wa_last_send_error", JSON.stringify({ at: Date.now(), error: err })).catch(() => {});
    return { ok: false, error: err };
  }
}

const newId = () => "i" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

// ---------- flexible Italian date/time parsing for the "cal" command ----------
const MESI = { gen: 1, genn: 1, gennaio: 1, feb: 2, febbraio: 2, mar: 3, marzo: 3, apr: 4, aprile: 4,
  mag: 5, maggio: 5, giu: 6, giugno: 6, lug: 7, luglio: 7, ago: 8, agosto: 8, set: 9, sett: 9, settembre: 9,
  ott: 10, ottobre: 10, nov: 11, novembre: 11, dic: 12, dicembre: 12 };
const GIORNI = { domenica: 0, lunedi: 1, martedi: 2, mercoledi: 3, giovedi: 4, venerdi: 5, sabato: 6 };
const MESI_IT = ["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];

/** Accent-stripping that keeps string length, so match indices stay valid on the original. */
function norm(s) {
  return s.toLowerCase()
    .replace(/[àáâä]/g, "a").replace(/[èéêë]/g, "e").replace(/[ìíîï]/g, "i")
    .replace(/[òóôö]/g, "o").replace(/[ùúûü]/g, "u");
}
function romeToday() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const g = (t) => +p.find((x) => x.type === t).value;
  return { y: g("year"), m: g("month"), d: g("day") };
}
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const addDays = (isoStr, n) => {
  const [y, m, d] = isoStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};
const fmtIt = (isoStr) => {
  const [y, m, d] = isoStr.split("-").map(Number);
  return `${d} ${MESI_IT[m - 1]}`;
};
const hhmm = (h, mi) => `${String(h).padStart(2, "0")}:${String(mi || 0).padStart(2, "0")}`;

/**
 * Pull a date, a time (or time range) and a title out of free text.
 * Understands: 12/9, 12-9-2026, 5 settembre, oggi/domani/dopodomani, lunedì…,
 * "alle 15", "ore 9.30", "15:30", "dalle 15 alle 17", "9-11", or a bare hour.
 */
function parseEventText(raw) {
  const n = norm(raw);
  const cuts = [];
  // `work` masks whatever has already been consumed, so a later pattern can never
  // re-read the same characters (that made "9 - 12" count as date AND time).
  let work = n;
  const cut = (s, e) => {
    cuts.push([s, e]);
    work = work.slice(0, s) + " ".repeat(e - s) + work.slice(e);
  };
  const take = (m, from, len) => {
    if (!m) return;
    const s = from == null ? m.index : from;
    cut(s, s + (len == null ? m[0].length : len));
  };
  const today = romeToday();
  const base = iso(today.y, today.m, today.d);
  let dateISO = null, endDateISO = null, start = null, end = null;
  let m;

  // --- date ------------------------------------------------------------
  const MESI_RE = Object.keys(MESI).join("|");
  const GG_RE = Object.keys(GIORNI).join("|");
  const weekdayISO = (name) => {
    const [by, bm, bd] = base.split("-").map(Number);
    const cur = new Date(Date.UTC(by, bm - 1, bd)).getUTCDay();
    let delta = (GIORNI[name] - cur + 7) % 7;
    if (delta === 0) delta = 7;                       // "lunedì" said on a Monday = the next one
    return addDays(base, delta);
  };
  /** First date-ish token at/after `from`; month/year stay null when unstated. */
  const scanDate = (txt, from) => {
    const sub = txt.slice(from);
    const at = (r) => from + r.index;
    let r;
    // "venerdì 13 agosto" / "venerdì 13" / "venerdì" — a number right after a
    // weekday is the DAY OF MONTH, never an hour.
    if ((r = sub.match(new RegExp("\\b(" + GG_RE + ")(?:\\s+(\\d{1,2}))?(?:\\s+(" + MESI_RE + "))?\\b")))) {
      if (r[2]) return { s: at(r), e: at(r) + r[0].length, day: +r[2], month: r[3] ? MESI[r[3]] : null, year: null };
      return { s: at(r), e: at(r) + r[0].length, fixed: weekdayISO(r[1]) };
    }
    if ((r = sub.match(new RegExp("\\b(\\d{1,2})\\s+(" + MESI_RE + ")\\b"))))
      return { s: at(r), e: at(r) + r[0].length, day: +r[1], month: MESI[r[2]], year: null };
    // "13/8", "13.8.2026", "13-8-2026" — NO spaces around separators, so a span
    // like "13 - 16" is left to the range logic instead of becoming one date.
    r = sub.match(/\b(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b/) ||
        sub.match(/\b(\d{1,2})-(\d{1,2})-(\d{2,4})\b/);
    if (r) {
      const d = +r[1], mo = +r[2];
      if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12)
        return { s: at(r), e: at(r) + r[0].length, day: d, month: mo,
                 year: r[3] ? (r[3].length === 2 ? 2000 + +r[3] : +r[3]) : null };
    }
    if ((r = sub.match(/\b(oggi|domani|dopodomani)\b/)))
      return { s: at(r), e: at(r) + r[0].length, fixed: addDays(base, { oggi: 0, domani: 1, dopodomani: 2 }[r[1]]) };
    return null;
  };
  const resolveDate = (t, monthFallback) => {
    if (t.fixed) return t.fixed;
    const mo = t.month || monthFallback || today.m;
    const y = t.year || today.y;
    let s = iso(y, mo, t.day);
    if (!t.year && s < base) s = iso(y + 1, mo, t.day);   // already past -> next year
    return s;
  };

  const d1 = scanDate(work, 0);
  if (d1) {
    const conn = work.slice(d1.e).match(/^\s*(?:-|–|al|alla|a|fino al)\s+/);
    const d2 = conn ? scanDate(work, d1.e + conn[0].length) : null;
    if (d2 && d2.s === d1.e + conn[0].length) {
      // "venerdì 13 - lunedì 16 agosto" is a span; the first date borrows the
      // month from the second when it doesn't state one.
      dateISO = resolveDate(d1, d2.month);
      endDateISO = resolveDate(d2, d2.month);
      if (endDateISO < dateISO) endDateISO = dateISO;
      cut(d1.s, d2.e);
    } else {
      dateISO = resolveDate(d1, null);
      cut(d1.s, d1.e);
    }
  }

  // --- time: keyword range, HH:MM range, single with keyword, HH:MM, bare range, bare hour ---
  if ((m = work.match(/\b(?:dalle|dalla|da)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(?:alle|alla|a|-|–)\s*(\d{1,2})(?:[:.](\d{2}))?\b/))) {
    start = hhmm(+m[1], +m[2] || 0); end = hhmm(+m[3], +m[4] || 0); take(m);
  } else if ((m = work.match(/\b(\d{1,2})[:.](\d{2})\s*(?:-|–|alle|a)\s*(\d{1,2})[:.](\d{2})\b/))) {
    start = hhmm(+m[1], +m[2]); end = hhmm(+m[3], +m[4]); take(m);
  } else if ((m = work.match(/\b(?:alle|ore|h)\s*(\d{1,2})(?:[:.](\d{2}))?\b/))) {
    start = hhmm(+m[1], +m[2] || 0); take(m);
  } else if ((m = work.match(/\b(\d{1,2})[:.](\d{2})\b/))) {
    start = hhmm(+m[1], +m[2]); take(m);
  } else if ((m = work.match(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/)) && +m[1] <= 23 && +m[2] <= 23) {
    start = hhmm(+m[1], 0); end = hhmm(+m[2], 0); take(m);        // "9 - 12", "20-22"
  } else if ((m = work.match(/(?:^|\s)(\d{1,2})(?=\s|$)/)) && +m[1] <= 23) {
    take(m, m.index + m[0].indexOf(m[1]), String(m[1]).length);
    start = hhmm(+m[1], 0);
  }
  if (start && !end) {                                 // default: un'ora
    const [h, mi] = start.split(":").map(Number);
    end = hhmm((h + 1) % 24, mi);
  }

  // --- title = what's left ---
  let title = "";
  let last = 0;
  cuts.sort((a, b) => a[0] - b[0]).forEach(([s, e]) => { title += raw.slice(last, s) + " "; last = Math.max(last, e); });
  title += raw.slice(last);
  // strip filler words only at the EDGES — removing them everywhere would mangle
  // legitimate titles ("cena di capodanno" -> "cena capodanno")
  title = title.replace(/\s+/g, " ").replace(/(?:\s*[,;]\s*){2,}/g, ", ").trim();
  for (let i = 0; i < 3; i++) {
    title = title
      .replace(/^(?:alle|alla|ore|dalle|dalla|del|di|il|lo|la|per|a|da)\b\s*/i, "")
      .replace(/\s*\b(?:alle|alla|ore|dalle|dalla|del|di|il|lo|la|per|a|da)$/i, "")
      .replace(/^[\s,.:;–-]+|[\s,.:;–-]+$/g, "")
      .trim();
  }

  if (!dateISO) dateISO = iso(today.y, today.m, today.d);
  if (endDateISO && endDateISO !== dateISO) { start = null; end = null; }  // a span is all-day
  return { title, dateISO, endDateISO, start, end };
}

/** Turn one inbound WhatsApp text into an action. Returns the reply to send back. */
async function handleWaCommand(env, text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  const readTodos = async () => {
    const u = await env.DASH_KV.get(TODO_USER_KEY);
    return u ? JSON.parse(u) : [];
  };
  const writeTodos = (list) => env.DASH_KV.put(TODO_USER_KEY, JSON.stringify(list.slice(0, 200)));

  // "aiuto" -> the command dictionary
  if (/^(aiuto|help|comandi|\?\?)$/.test(lower)) {
    return "Cosa so fare:\n" +
      "• <testo> → nuovo task (capisce «entro il 5/9»)\n" +
      "• cal <giorno> <ora> <evento> → evento sul calendario\n" +
      "• nota: <testo> → salva senza creare task\n" +
      "• lista → i task aperti, numerati\n" +
      "• fatto 2  oppure  fatto pagamenti → archivia (numero o pezzo del nome)\n" +
      "• aiuto → questo elenco";
  }

  // "cal ..." -> create a Google Calendar event
  if (/^(cal|calendario|evento|appuntamento|agenda)\b/.test(lower)) {
    const rest = raw.replace(/^(cal|calendario|evento|appuntamento|agenda)\b[:\s]*/i, "");
    const p = parseEventText(rest);
    if (!p.title) return "Non ho capito il nome dell'evento.\nEs: «cal domani 15 riunione con Marco»";
    try {
      const token = await tokenForAccount(env, "personale");
      const ev = { summary: p.title };
      const lastDay = p.endDateISO || p.dateISO;
      if (p.start) {
        ev.start = { dateTime: `${p.dateISO}T${p.start}:00`, timeZone: "Europe/Rome" };
        ev.end = { dateTime: `${p.dateISO}T${p.end}:00`, timeZone: "Europe/Rome" };
      } else {
        // all-day: Google wants an EXCLUSIVE end date, hence +1 on the last day
        ev.start = { date: p.dateISO };
        ev.end = { date: addDays(lastDay, 1) };
      }
      await createEvent(token, ev);
      // Show the year whenever it is not the current one, so a wrong roll-over is visible.
      const yr = (d) => (d.slice(0, 4) === String(romeToday().y) ? "" : " " + d.slice(0, 4));
      const when = lastDay !== p.dateISO
        ? `${fmtIt(p.dateISO)} → ${fmtIt(lastDay)}${yr(lastDay)} · tutto il giorno`
        : `${fmtIt(p.dateISO)}${yr(p.dateISO)}` + (p.start ? ` · ${p.start}-${p.end}` : " · tutto il giorno");
      return `📅 Evento creato: ${p.title}\n${when}`;
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/gapi_40[13]|insufficient|ACCESS_TOKEN_SCOPE|insufficientPermissions/i.test(msg)) {
        return "⚠️ Non ho il permesso di scrivere sul calendario: serve rigenerare il token Google con lo scope calendar.events.";
      }
      return "Non sono riuscito a creare l'evento. " + msg.slice(0, 120);
    }
  }

  // "lista" / "task" -> show what's still open
  if (/^(lista|task|todo\?|\?)$/.test(lower)) {
    const active = (await readTodos()).filter((t) => !t.done);
    if (!active.length) return "Non hai task attivi. ✨";
    return "I tuoi task:\n" + active.map((t, i) => `${i + 1}. ${t.text}`).join("\n");
  }

  // "fatto 2" or "fatto <parte del nome>" -> archive a task.
  // Anything starting with "fatto" is ALWAYS handled here: falling through would
  // silently create a task named "fatto ..." instead of closing one.
  const done = lower.match(/^(?:fatt[oa]|done|completat[oa])\b\s*(.*)$/);
  if (done) {
    const arg = done[1].replace(/[<>«»"']/g, "").trim();
    const list = await readTodos();
    const active = list.filter((t) => !t.done);
    const numbered = () => active.map((t, i) => `${i + 1}. ${t.text}`).join("\n");
    if (!active.length) return "Non hai task attivi da archiviare. ✨";
    if (!arg) return "Quale task? Scrivi «fatto 2» oppure «fatto pagamenti».\n\n" + numbered();

    let target = null;
    if (/^\d+$/.test(arg)) {
      target = active[Number(arg) - 1];
      if (!target) return `Non esiste il numero ${arg}.\n\n` + numbered();
    } else {
      const hits = active.filter((t) => t.text.toLowerCase().includes(arg.toLowerCase()));
      if (!hits.length) return `Non trovo nessun task che contenga «${arg}».\n\n` + numbered();
      if (hits.length > 1) {
        return `Ci sono ${hits.length} task che contengono «${arg}». Usa il numero:\n\n` +
          hits.map((t) => `${active.indexOf(t) + 1}. ${t.text}`).join("\n");
      }
      target = hits[0];
    }
    target.done = true;
    await writeTodos(list);
    return `✅ Archiviato: ${target.text}`;
  }

  // "nota ..." -> just keep it in the inbox, no task
  if (/^nota[:\s]/i.test(raw)) {
    return "📝 Nota salvata.";
  }

  // anything else -> new task (optional "todo " prefix, optional "entro il 5/9" due date)
  let body = raw.replace(/^(todo|task)[:\s]+/i, "").trim();
  let due;
  const when = body.match(/\bentro\s+(?:il\s+)?(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/i);
  if (when) {
    const d = +when[1], m = +when[2];
    let y = when[3] ? Number(when[3].length === 2 ? "20" + when[3] : when[3]) : new Date().getFullYear();
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (!isNaN(new Date(iso))) { due = iso; body = body.replace(when[0], "").trim(); }
  }
  if (!body) return "Non ho capito cosa segnare. Scrivimi il task, oppure «lista» / «fatto 2».";
  const list = await readTodos();
  const t = { id: newId(), text: body.slice(0, 300), done: false, src: "whatsapp" };
  if (due) t.due = due;
  list.unshift(t);
  await writeTodos(list);
  return `✅ Aggiunto ai task: ${t.text}` + (due ? ` (entro ${due})` : "");
}

const DEFAULT_ACCOUNTS = [
  { id: "personale", name: "Personale" },
  { id: "lavoro", name: "Lavoro" },
  { id: "studio", name: "Studio" },
  { id: "progetti", name: "Progetti" },
];

function getAccounts(env) {
  if (env.ACCOUNTS) {
    try {
      const a = JSON.parse(env.ACCOUNTS);
      if (Array.isArray(a) && a.length) return a;
    } catch (_) {}
  }
  return DEFAULT_ACCOUNTS;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });

function isAuthed(request, env) {
  const token = env.ACCESS_TOKEN;
  if (!token) return false; // locked until a token is configured
  const url = new URL(request.url);
  if (url.searchParams.get("t") === token) return true;
  if (request.headers.get("x-access") === token) return true;
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)dash=([^;]+)/);
  return !!(m && m[1] === token);
}

function sessionCookie(token) {
  return `dash=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`;
}

function toMin(t) { const p = String(t).split(":"); return (+p[0]) * 60 + (+p[1]); }

async function tokenForAccount(env, accId) {
  const rt = env["GOOGLE_RT_" + String(accId).toUpperCase()];
  if (!rt) throw new Error("no-token");
  return getAccessToken(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, rt);
}

async function computeSnapshot(env) {
  const accounts = getAccounts(env);
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const now = new Date();

  let unread = 0, unread24h = 0, daGestire = 0, cap24 = false, capDG = false;
  let mail = [], timed = [], allday = [], pending = [], repliedN = 0;
  const gmailAccs = [], calAccs = [], errors = [];

  if (!clientId || !clientSecret) {
    return notConfiguredSnapshot(now, "Credenziali Google non configurate.");
  }

  for (const acc of accounts) {
    const rt = env["GOOGLE_RT_" + acc.id.toUpperCase()];
    if (!rt) { errors.push(acc.id + ":no-token"); continue; }

    let token;
    try {
      token = await getAccessToken(clientId, clientSecret, rt);
    } catch (e) { errors.push(acc.id + ":auth"); continue; }

    try {
      const g = await gmailSnapshot(token, acc.id);
      unread += g.unread; unread24h += g.unread24h; daGestire += g.daGestire;
      cap24 = cap24 || g.unread24hCapped; capDG = capDG || g.daGestireCapped;
      pending = pending.concat(g.pending || []);
      repliedN += g.replied || 0;
      mail = mail.concat(g.items);
      gmailAccs.push(acc.id);
    } catch (e) { errors.push(acc.id + ":gmail"); }

    if (acc.calendar !== false) {
      try {
        const c = await calendarSnapshot(token, acc.id, now);
        timed = timed.concat(c.timed);
        allday = allday.concat(c.allday);
        calAccs.push(acc.id);
      } catch (e) { errors.push(acc.id + ":cal"); }
    }
  }

  const rank = { critical: 0, warning: 1, info: 2 };
  mail.sort((a, b) => {
    const r = (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
    if (r) return r;
    return new Date(b.when || 0) - new Date(a.when || 0);
  });
  mail = mail.slice(0, 6);
  timed.sort((a, b) => toMin(a.s) - toMin(b.s));

  const snap = {
    snapshot: now.toISOString(),
    generatedAt: now.getTime(),
    auto: "ogni giorno 08:00 e 13:00 (Europe/Rome)",
    kpis: {
      unread: unread >= 999 ? "999+" : unread,
      unread24h: cap24 ? unread24h + "+" : unread24h,
      daGestire: capDG ? daGestire + "+" : daGestire,
      impegni: timed.length,
    },
    mail,
    // Threads still waiting for an answer from you (all of them, not just the top 6):
    // lets the Consigli drop advice about mail you have since replied to.
    pending,
    replied: repliedN,
    agenda: timed,
    allday,
    sources: {
      gmail: { ok: gmailAccs.length > 0, accounts: gmailAccs },
      calendar: { ok: calAccs.length > 0, accounts: calAccs },
    },
  };
  if (errors.length) {
    snap.errors = errors;
    if (!gmailAccs.length && !calAccs.length) {
      snap.warning = "Nessuna fonte raggiungibile: controlla i token Google.";
    }
  }
  return snap;
}

function notConfiguredSnapshot(now, warning) {
  return {
    snapshot: now.toISOString(),
    generatedAt: now.getTime(),
    auto: "ogni giorno 08:00 e 13:00 (Europe/Rome)",
    kpis: { unread: "—", unread24h: "—", daGestire: "—", impegni: "—" },
    mail: [], agenda: [], allday: [],
    sources: { gmail: { ok: false, accounts: [] }, calendar: { ok: false, accounts: [] } },
    warning,
  };
}

// ---------- Consigli: two buckets ("mail" from the cloud, "wa" from the local recap) ----------

// "sweep" is written by hand during a deep pass over the archive; no scheduled agent
// owns it, so a one-off review is not wiped by the next cron.
const SUG_KEYS = { mail: TODO_SUG_MAIL_KEY, wa: TODO_SUG_KEY, sweep: TODO_SUG_SWEEP_KEY };
const BUCKETS = ["mail", "sweep", "wa"];
const bucketOf = (x) => (x && BUCKETS.includes(x.bucket) ? x.bucket : "wa");

async function readBucket(env, b) {
  let arr = [];
  try {
    const raw = await env.DASH_KV.get(SUG_KEYS[b]);
    arr = raw ? JSON.parse(raw) : [];
  } catch (_) {}
  return (Array.isArray(arr) ? arr : []).map((x) => Object.assign({}, x, { bucket: b }));
}

async function writeBucket(env, b, arr, stamp = true) {
  const list = (arr || []).slice(0, 100);
  await env.DASH_KV.put(SUG_KEYS[b], JSON.stringify(list));
  if (stamp) await stampWrite(env, { [b]: list.length });
}

/**
 * Record who wrote which bucket, and when. Takes every bucket of one write at once:
 * stamping them separately means three read-modify-writes racing on the same key, and
 * the last one to land silently drops the others' timestamps.
 */
async function stampWrite(env, counts) {
  try {
    const raw = await env.DASH_KV.get(CONSIGLI_STATUS_KEY);
    const st = raw ? JSON.parse(raw) : {};
    const at = new Date().toISOString();
    for (const b of Object.keys(counts)) st[b] = { at, n: counts[b] };
    await env.DASH_KV.put(CONSIGLI_STATUS_KEY, JSON.stringify(st));
  } catch (_) {}
}

/** Every bucket as one list — mail first, it carries the deadlines. */
async function readSuggested(env) {
  const parts = await Promise.all(BUCKETS.map((b) => readBucket(env, b)));
  return [].concat(...parts);
}

/** Split a merged list back into its buckets (this is what the browser posts back). */
async function writeSuggested(env, list) {
  const by = {};
  for (const b of BUCKETS) by[b] = [];
  for (const it of list || []) by[bucketOf(it)].push(it);
  await Promise.all(BUCKETS.map((b) => writeBucket(env, b, by[b], false)));
  const counts = {};
  for (const b of BUCKETS) counts[b] = by[b].length;
  await stampWrite(env, counts);
}

/**
 * Advice about mail you have already answered is noise: drop every mail-bucket item whose
 * thread is no longer waiting for you. Only for accounts that actually answered this run,
 * so a token failure never wipes good advice.
 */
async function pruneMailConsigli(env, snap) {
  const pending = snap && snap.pending;
  const accs = (((snap || {}).sources || {}).gmail || {}).accounts || [];
  if (!Array.isArray(pending) || !accs.length) return 0;
  const mail = await readBucket(env, "mail");
  const keep = mail.filter((c) => !c.threadId || !c.acc || !accs.includes(c.acc) || pending.includes(c.threadId));
  if (keep.length !== mail.length) await writeBucket(env, "mail", keep, false);
  return mail.length - keep.length;
}

async function refreshAndStore(env) {
  const snap = await computeSnapshot(env);
  await env.DASH_KV.put(KV_KEY, JSON.stringify(snap));
  await pruneMailConsigli(env, snap).catch(() => {});
  return snap;
}

const UNAUTH_PAGE = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Accesso richiesto</title>
<style>body{font-family:system-ui,sans-serif;background:#0d0d0d;color:#eee;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:24px}
.c{max-width:420px}h1{font-size:1.2rem}code{background:#232322;padding:2px 6px;border-radius:6px}</style></head>
<body><div class="c"><h1>🔒 Dashboard personale</h1>
<p>Apri la dashboard con il tuo link d'accesso, che include il token:<br><code>?t=IL_TUO_TOKEN</code></p></div></body></html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/favicon.ico") return new Response(null, { status: 204 });

    if (path === "/") {
      if (!isAuthed(request, env)) {
        return new Response(UNAUTH_PAGE, { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      // If a token arrived in the URL, set a cookie and drop it from the address bar.
      if (url.searchParams.get("t")) {
        return new Response(null, { status: 302, headers: { location: "/", "set-cookie": sessionCookie(env.ACCESS_TOKEN) } });
      }
      return new Response(DASHBOARD_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (path === "/api/data") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const fresh = request.method === "POST" || url.searchParams.get("fresh");
      try {
        let snap;
        if (!fresh) {
          const cached = await env.DASH_KV.get(KV_KEY);
          if (cached) snap = JSON.parse(cached);
        }
        if (!snap) snap = await refreshAndStore(env);
        try {
          const wa = await env.DASH_KV.get(WA_KEY);
          if (wa) {
            snap.whatsapp = JSON.parse(wa);
            const d = await env.DASH_KV.get(WA_DISMISS_KEY);
            snap.whatsapp.dismissed = d ? JSON.parse(d) : [];
            const gr = await env.DASH_KV.get(WA_GROUPS_READ_KEY);
            snap.whatsapp.groupsRead = gr ? JSON.parse(gr) : [];
          }
        } catch (_) {}
        try {
          const [u, sug] = await Promise.all([env.DASH_KV.get(TODO_USER_KEY), readSuggested(env)]);
          snap.todos = { user: u ? JSON.parse(u) : [], suggested: sug };
        } catch (_) {}
        return json(snap);
      } catch (e) {
        return json({ error: "compute_failed", detail: String(e && e.message || e) }, 500);
      }
    }

    if (path === "/api/mail/action" && request.method === "POST") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
      const id = body && body.id, acc = body && body.acc, action = body && body.action, threadId = body && body.threadId;
      if (!id || !acc || !action) return json({ error: "bad_request" }, 400);
      const LABELS = { read: { remove: ["UNREAD"] }, archive: { remove: ["INBOX", "UNREAD"] } };
      try {
        const token = await tokenForAccount(env, acc);
        if (action === "trash") {
          await trashMessage(token, id);
        } else if (LABELS[action]) {
          // Mark the whole THREAD (all its messages), so a thread with sibling unread
          // messages doesn't resurface via a different message id.
          if (threadId) await modifyThread(token, threadId, LABELS[action]);
          else await modifyMessage(token, id, LABELS[action]);
        } else {
          return json({ error: "bad_action" }, 400);
        }
        // Keep the cached snapshot in sync so a reload doesn't resurrect the handled mail.
        try {
          const cached = await env.DASH_KV.get(KV_KEY);
          if (cached) {
            const snap = JSON.parse(cached);
            const gone = (m) => m.id === id || (threadId && m.threadId === threadId);
            if (Array.isArray(snap.mail) && snap.mail.some(gone)) {
              snap.mail = snap.mail.filter((m) => !gone(m));
              if (snap.kpis) {
                const dec = (v) => (typeof v === "number" ? Math.max(0, v - 1) : v);
                snap.kpis.daGestire = dec(snap.kpis.daGestire);
                snap.kpis.unread = dec(snap.kpis.unread);
                snap.kpis.unread24h = dec(snap.kpis.unread24h);
              }
              await env.DASH_KV.put(KV_KEY, JSON.stringify(snap));
            }
          }
        } catch (_) {}
        return json({ ok: true });
      } catch (e) {
        const msg = String((e && e.message) || e);
        const scope = /gapi_403|insufficient|scope|ACCESS_TOKEN_SCOPE/i.test(msg);
        return json({ error: "action_failed", detail: msg, needScope: scope }, scope ? 403 : 500);
      }
    }

    if (path === "/api/whatsapp") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      if (request.method === "POST") {
        let body;
        try { body = await request.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
        const rec = Object.assign({}, body, { storedAt: Date.now() });
        // Already answered? Then there is nothing left to handle. The recap flags a chat
        // with mine:true when its last message is yours (the list preview shows the sent
        // ticks), and can also send an explicit replied:["chat name", ...].
        const repliedTo = new Set((Array.isArray(body.replied) ? body.replied : [])
          .map((x) => String(x || "").trim().toLowerCase()));
        const answered = (x) => !!(x && (x.mine === true || x.lastFromMe === true ||
          repliedTo.has(String(x.chat || "").trim().toLowerCase())));
        let dropped = 0;
        for (const k of ["urgent", "leftUnread"]) {
          if (!Array.isArray(rec[k])) continue;
          const keep = rec[k].filter((x) => !answered(x));
          dropped += rec[k].length - keep.length;
          rec[k] = keep;
        }
        rec.repliedDropped = dropped;
        await env.DASH_KV.put(WA_KEY, JSON.stringify(rec));
        await env.DASH_KV.put(WA_DISMISS_KEY, "[]"); // a fresh recap starts with nothing dismissed
        return json({ ok: true });
      }
      const wa = await env.DASH_KV.get(WA_KEY);
      return wa ? new Response(wa, { headers: JSON_HEADERS }) : json({});
    }

    if (path === "/api/todos") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      if (request.method === "POST") {
        let body;
        try { body = await request.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
        if (Array.isArray(body.user)) await env.DASH_KV.put(TODO_USER_KEY, JSON.stringify(body.user.slice(0, 200)));
        if (Array.isArray(body.suggested)) {
          // Three writers, one list. `bucket` replaces one half only (the WhatsApp recap
          // posts bucket:"wa"); `merged:true` is the browser sending the whole list back
          // after a delete or a promote; anything else is a legacy client and may only
          // ever touch the "wa" half, never the cloud-generated one.
          if (BUCKETS.includes(body.bucket)) await writeBucket(env, body.bucket, body.suggested);
          else if (body.merged) await writeSuggested(env, body.suggested);
          else await writeBucket(env, "wa", body.suggested);
        }
        return json({ ok: true });
      }
      const [u, sug] = await Promise.all([env.DASH_KV.get(TODO_USER_KEY), readSuggested(env)]);
      return json({ user: u ? JSON.parse(u) : [], suggested: sug });
    }

    // Health check on the two Consigli buckets: who wrote last, and when. A "mail" entry
    // that stops moving means the cloud routine is not running.
    if (path === "/api/consigli") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const [st, ...lists] = await Promise.all([
        env.DASH_KV.get(CONSIGLI_STATUS_KEY), ...BUCKETS.map((b) => readBucket(env, b)),
      ]);
      const counts = {};
      BUCKETS.forEach((b, i) => { counts[b] = lists[i].length; });
      return json({ lastWrite: st ? JSON.parse(st) : {}, counts });
    }

    if (path === "/api/wa-dismiss" && request.method === "POST") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
      if (Array.isArray(body.dismissed)) await env.DASH_KV.put(WA_DISMISS_KEY, JSON.stringify(body.dismissed.slice(0, 300)));
      return json({ ok: true });
    }

    if (path === "/api/wa-groups-read" && request.method === "POST") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
      if (Array.isArray(body.read)) await env.DASH_KV.put(WA_GROUPS_READ_KEY, JSON.stringify(body.read.slice(0, 200)));
      return json({ ok: true });
    }

    // --- WhatsApp inbound webhook (called by Meta, not by the browser) ---
    if (path === "/api/wa-webhook") {
      // 1) Meta's one-off verification handshake
      if (request.method === "GET") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        // secrets piped in from a shell can carry a trailing newline — compare trimmed
        const want = String(env.WA_VERIFY_TOKEN || "").trim();
        if (mode === "subscribe" && want && String(token || "").trim() === want) {
          return new Response(challenge || "", { headers: { "content-type": "text/plain" } });
        }
        return new Response("forbidden", { status: 403 });
      }
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

      // 2) Real deliveries — must be signed with the app secret
      const raw = await request.text();
      if (!(await validSignature(env, raw, request.headers.get("x-hub-signature-256")))) {
        return new Response("bad signature", { status: 401 });
      }
      let payload;
      try { payload = JSON.parse(raw); } catch (_) { return json({ ok: true }); }

      const processOne = async (msg, contactName) => {
        if (!msg || msg.type !== "text") return;
        // Meta retries deliveries: ignore ids we already handled.
        const seenRaw = await env.DASH_KV.get(WA_SEEN_KEY);
        const seen = seenRaw ? JSON.parse(seenRaw) : [];
        if (seen.includes(msg.id)) return;
        seen.push(msg.id);
        await env.DASH_KV.put(WA_SEEN_KEY, JSON.stringify(seen.slice(-100)));

        const text = msg.text && msg.text.body;
        const inboxRaw = await env.DASH_KV.get(WA_INBOX_KEY);
        const inbox = inboxRaw ? JSON.parse(inboxRaw) : [];
        inbox.unshift({ id: msg.id, from: msg.from, name: contactName || "", text, at: Date.now() });
        await env.DASH_KV.put(WA_INBOX_KEY, JSON.stringify(inbox.slice(0, 100)));

        const reply = await handleWaCommand(env, text);
        if (reply) await waReply(env, msg.from, reply);
      };

      try {
        for (const entry of payload.entry || []) {
          for (const ch of entry.changes || []) {
            const v = ch.value || {};
            const name = ((v.contacts || [])[0] || {}).profile?.name;
            for (const m of v.messages || []) await processOne(m, name);
          }
        }
      } catch (_) { /* never fail the webhook: Meta would retry forever */ }
      return json({ ok: true });
    }

    // Run a WhatsApp command over HTTP and return the reply — same code path as the bot.
    if (path === "/api/cmd") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const q = url.searchParams.get("q") || "";
      try {
        return json({ q, reply: await handleWaCommand(env, q) });
      } catch (e) {
        return json({ q, error: String((e && e.stack) || e).slice(0, 600) }, 500);
      }
    }

    // Dry-run of the "cal" parser — check how a phrase is read without touching the calendar.
    if (path === "/api/parse") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const q = url.searchParams.get("q") || "";
      const rest = q.replace(/^(cal|calendario|evento|appuntamento|agenda)\b[:\s]*/i, "");
      return json({ input: q, parsed: parseEventText(rest) });
    }

    // Last outbound-send failure, so a broken reply is never silent again.
    if (path === "/api/wa-debug") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const v = await env.DASH_KV.get("wa_last_send_error");
      return json({
        lastSendError: v ? JSON.parse(v) : null,
        phoneIdLen: String(env.WHATSAPP_PHONE_ID || "").length,
        phoneIdTrimmedLen: String(env.WHATSAPP_PHONE_ID || "").trim().length,
        tokenLen: String(env.WHATSAPP_TOKEN || "").length,
        tokenTrimmedLen: String(env.WHATSAPP_TOKEN || "").trim().length,
      });
    }

    if (path === "/api/wa-inbox") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const v = await env.DASH_KV.get(WA_INBOX_KEY);
      return v ? new Response(v, { headers: JSON_HEADERS }) : json([]);
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    // Mail + calendar only. The Consigli are written from outside: the mail half by a cloud
    // Claude Code routine, the WhatsApp half by the local browser task. refreshAndStore
    // still prunes advice about threads you have since answered.
    ctx.waitUntil(refreshAndStore(env).catch(() => {}));
  },
};
