// Parcel tracker: reads shipping mail and reconstructs which parcels are still on their way.
// Deterministic, no LLM. Everything read from a mail is cached by message id (a mail never
// changes), so a scan costs one search plus, only for mails not seen before, one batch for
// the headers and one for the bodies. With nothing new it is a single Gmail request.

const GMAIL_API = "https://gmail.googleapis.com";
const ME = "/gmail/v1/users/me";

const WINDOW_DAYS = 30;
const MAX_MSGS = 120;
// Per pass. A batch is one HTTP request but every mail in it still counts against the
// per-second Gmail quota, so a first run is spread over a few passes (see `pending`).
const MAX_NEW_META = 40;
const MAX_NEW_BODIES = 20;
const CACHE_VERSION = 4; // bump whenever classify() or parseDetails() change what they return

// Known shops and carriers, plus anything whose subject talks about a shipment. Bulk mail
// that only sounds like one (mailing lists, promos, account notices) is excluded by sender.
const QUERY = [
  "newer_than:" + WINDOW_DAYS + "d",
  "{from:conferma-ordine@amazon.it from:conferma-spedizione@amazon.it from:shipment-tracking@amazon.it from:order-update@amazon.it",
  "from:inpost from:poste.it from:posteitaliane.it from:vinted from:brt.it from:gls-italy.com from:dhl.com from:ups.com",
  "from:sda.it from:fedex.com from:tnt.it from:bizay.com from:pressup.it from:aliexpress.com from:temu.com from:ebay.it",
  "from:etsy.com from:zalando from:mondialrelay",
  "subject:spedito subject:spedita subject:spedizione subject:consegnato subject:consegnata subject:\"in consegna\"",
  "subject:pacco subject:tracking subject:tracciamento subject:ritiro}",
  "-from:no-reply@amazon.it -from:promotion-it@amazon.it", // add your own noisy senders here
  "-from:account-update@amazon.it -from:payments-update@amazon.it -from:communicationsIT@express.dhl.com",
  "-in:sent -in:draft -in:chats",
].join(" ");

const VENDORS = [
  [/inpost/, "InPost"], [/poste(italiane)?\./, "Poste Italiane"], [/vinted/, "Vinted"], [/bizay/, "Bizay"],
  [/pressup/, "PressUP"], [/brt\./, "BRT"], [/gls/, "GLS"], [/dhl/, "DHL"], [/ups\./, "UPS"], [/sda\./, "SDA"],
  [/fedex/, "FedEx"], [/tnt\./, "TNT"], [/aliexpress/, "AliExpress"], [/temu/, "Temu"], [/ebay/, "eBay"],
  [/etsy/, "Etsy"], [/zalando/, "Zalando"], [/mondialrelay/, "Mondial Relay"],
];

// "returned" = went back to the sender (not collected, undeliverable): it closes the story
// whatever came before, and it is the one outcome that must not go unnoticed.
const STAGE_RANK = { ordered: 1, shipped: 2, out: 3, pickup: 4, delivered: 5, returned: 6 };

// ---------- small helpers ----------

async function getJSON(token, path) {
  const r = await fetch(GMAIL_API + path, { headers: { authorization: "Bearer " + token } });
  if (!r.ok) throw new Error("gapi_" + r.status + ":" + (await r.text().catch(() => "")).slice(0, 200));
  return r.json();
}

/** Several Gmail GETs in one HTTP round trip. Returns the parsed bodies in request order (null = failed). */
async function batchGet(token, paths) {
  const out = new Array(paths.length).fill(null);
  if (!paths.length) return out;
  const boundary = "batch" + Math.random().toString(36).slice(2);
  let body = "";
  paths.forEach((p, i) => {
    body += "--" + boundary + "\r\nContent-Type: application/http\r\nContent-ID: <q" + i + ">\r\n\r\nGET " + p + "\r\n\r\n";
  });
  body += "--" + boundary + "--";
  const r = await fetch(GMAIL_API + "/batch/gmail/v1", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "multipart/mixed; boundary=" + boundary },
    body,
  });
  if (!r.ok) throw new Error("batch_" + r.status + ":" + (await r.text().catch(() => "")).slice(0, 200));
  const bm = (r.headers.get("content-type") || "").match(/boundary=("?)([^";]+)\1/);
  if (!bm) return out;
  const text = await r.text();
  for (const part of text.split("--" + bm[2])) {
    const idm = part.match(/Content-ID:\s*<response-q(\d+)>/i);
    const st = part.match(/HTTP\/[\d.]+\s+(\d{3})/);
    if (!idm || !st || st[1] !== "200") continue;
    const a = part.indexOf("{"), b = part.lastIndexOf("}");
    if (a < 0 || b < a) continue;
    try { out[+idm[1]] = JSON.parse(part.slice(a, b + 1)); } catch (_) { /* leave null */ }
  }
  return out;
}

function hdr(msg, name) {
  const hs = (msg.payload && msg.payload.headers) || [];
  const h = hs.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

function splitFrom(raw) {
  raw = String(raw || "");
  const m = raw.match(/<([^>]+)>/);
  const addr = (m ? m[1] : raw).trim().toLowerCase();
  const name = (m ? raw.slice(0, m.index) : "").replace(/["']/g, "").trim();
  return { addr, name, domain: addr.split("@")[1] || "" };
}

function entities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&#?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function b64text(data) {
  try {
    const bin = atob(String(data || "").replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch (_) { return ""; }
}

/** Body as text. Prefers the plain part (small); the HTML one is decoded only as a fallback. */
function bodyText(payload) {
  let plain = null, html = null;
  const stack = [payload];
  while (stack.length) {
    const p = stack.shift();
    if (!p) continue;
    if (p.mimeType === "text/plain" && p.body && p.body.data && !plain) plain = p.body.data;
    if (p.mimeType === "text/html" && p.body && p.body.data && !html) html = p.body.data;
    if (p.parts) stack.push(...p.parts);
  }
  if (plain) return b64text(plain);
  if (!html) return "";
  const raw = b64text(html);
  // Keep link targets: the shipment and order ids live in the URLs, not in the visible text.
  return entities(raw
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>/gi, " $1 ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|td|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " "));
}

const cleanSpaces = (s) => String(s || "").replace(/[͏​-‏﻿]/g, "").replace(/\s+/g, " ").trim();

function slug(s) {
  return cleanSpaces(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 6).join("-");
}

// ---------- reading a stage out of words ----------

const HARD_PROBLEM = /(tentativo di consegna|consegna non riuscita|mancata consegna|impossibile consegnare|non siamo riusciti a consegnare|indirizzo (errato|incompleto|insufficiente)|in giacenza|attesa (di un )?nuovo file|file non corretto|failed delivery|delivery attempt)/;

function progressStage(t) {
  // Accented letters are matched with a dot: the text is lowercased but not unaccented.
  if (/(non hai ritirato in tempo|torner. al mittente|tornato al mittente|sar. restituito a|restituito al mittente|reso al mittente|non . riuscit[ao] a consegnare il tuo ordine|returned to sender)/.test(t)) return "returned";
  // "ti aspetta" alone is promo language ("uno sconto ti aspetta"): it needs a parcel as subject.
  if (/(pronto per il ritiro|pronto al ritiro|disponibile (per il|al) ritiro|puoi ritirar|da ritirare|(pacco|ordine|acquisto) ti (aspetta|sta aspettando)|ecco il tuo pin|ready for (pickup|collection))/.test(t)) return "pickup";
  if (/(consegnat[oaie]\b|stat[oa] recapitat|delivered)/.test(t) && !/non (e stat[oa] |è stat[oa] )?consegnat/.test(t)) return "delivered";
  if (/(in consegna|out for delivery|arriva oggi|in arrivo oggi)/.test(t)) return "out";
  if (/(spedit[oaie]\b|in transito|pres[oa] in carico|partit[oa]\b|in viaggio|shipped|affidat[oa] al corriere|in carico al corriere|in spedizione|in arrivo)/.test(t)) return "shipped";
  if (/(ordinat[oi]\b|conferma (dell.)?ordine|ordine (ricevuto|confermato|registrato)|ordine di acquisto|grazie per l.ordine|order confirm)/.test(t)) return "ordered";
  return "";
}

/** { stage, problem } from free text. A delay only counts as a problem when nothing else is said. */
function readStage(text) {
  const t = cleanSpaces(text).toLowerCase();
  if (!t) return { stage: "", problem: false };
  const stage = progressStage(t);
  if (HARD_PROBLEM.test(t)) return { stage, problem: true };
  if (!stage && /\b(ritardo|in ritardo|delay)\b/.test(t)) return { stage: "", problem: true };
  return { stage, problem: false };
}

// ---------- dates ----------

const WD = { domenica: 0, lunedi: 1, martedi: 2, mercoledi: 3, giovedi: 4, venerdi: 5, sabato: 6 };
const MONTHS = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const EN_WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function romeDay(ms) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(new Date(ms));
  const get = (k) => p.find((x) => x.type === k).value;
  return { iso: get("year") + "-" + get("month") + "-" + get("day"), wd: EN_WD[get("weekday")] };
}

function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const pad = (n) => String(n).padStart(2, "0");

/** Expected delivery day as YYYY-MM-DD, read relative to when the mail was sent. */
function etaFrom(text, sentMs) {
  const sent = romeDay(sentMs);
  const t = cleanSpaces(text);
  let m = t.match(/data di consegna stimata[^0-9]{0,12}(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/i);
  if (m) return m[3] + "-" + pad(m[2]) + "-" + pad(m[1]);
  m = t.match(/\b(?:in arrivo|arriver[àa]|arriva|consegna (?:prevista|stimata)(?: per)?)\s+(?:il\s+|l['’]\s*)?(oggi|domani|dopodomani|luned[ìi]|marted[ìi]|mercoled[ìi]|gioved[ìi]|venerd[ìi]|sabato|domenica|\d{1,2}\s+[a-zà]+)/i);
  if (!m) return "";
  const w = m[1].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (w === "oggi") return sent.iso;
  if (w === "domani") return addDays(sent.iso, 1);
  if (w === "dopodomani") return addDays(sent.iso, 2);
  if (w in WD) return addDays(sent.iso, ((WD[w] - sent.wd + 7) % 7) || 7);
  const dm = w.match(/^(\d{1,2})\s+([a-z]+)$/);
  if (dm) {
    const mi = MONTHS.indexOf(dm[2]);
    if (mi < 0) return "";
    const y = Number(sent.iso.slice(0, 4));
    let iso = y + "-" + pad(mi + 1) + "-" + pad(dm[1]);
    if (iso < addDays(sent.iso, -60)) iso = (y + 1) + iso.slice(4); // "8 gennaio" written in December
    return iso;
  }
  return "";
}

// ---------- one mail -> one event ----------

function vendorName(domain, fallback) {
  for (const [re, name] of VENDORS) if (re.test(domain)) return name;
  return fallback || domain;
}

/** First pass, from headers and snippet only. Returns null for mail that is not about a parcel. */
function classify(meta) {
  const subject = cleanSpaces(hdr(meta, "Subject"));
  const from = splitFrom(hdr(meta, "From"));
  const snippet = cleanSpaces(entities(meta.snippet));
  const ev = {
    id: meta.id, threadId: meta.threadId, when: Number(meta.internalDate || 0),
    subject, snippet, domain: from.domain, count: 1, problem: false, stage: "", title: "",
  };

  if (/(^|\.)amazon\.[a-z.]+$/.test(from.domain)) {
    if (!/^(conferma-ordine|conferma-spedizione|shipment-tracking|order-update)@/.test(from.addr)) return null;
    const m = subject.match(/^\s*([^:]{3,40}):\s*(.+)$/);
    if (!m) return null;
    const head = m[1].toLowerCase();
    let rest = m[2];
    const more = rest.match(/\be\s+(\d+)\s+altr[oi]\s+articol[oi]\s*$/i);
    if (more) { ev.count = 1 + Number(more[1]); rest = rest.slice(0, more.index); }
    ev.title = rest.replace(/["“”«»]/g, "").replace(/(\.\.\.|…)\s*$/, "").trim();
    if (/^ordinat/.test(head)) ev.stage = "ordered";
    else if (/^spedit/.test(head)) ev.stage = "shipped";
    else if (/^in consegna|arriva oggi/.test(head)) ev.stage = "out";
    else if (/^consegnat/.test(head)) ev.stage = "delivered";
    else if (/ritard|tentat|non riuscit|problema/.test(head)) ev.problem = true;
    else Object.assign(ev, readStage(head));
    if (!ev.stage && !ev.problem) return null;
    ev.kind = "amazon"; ev.merchant = "Amazon";
    return ev;
  }

  const known = VENDORS.some(([re]) => re.test(from.domain));
  // Mail from a shop that is not about a parcel: chat between users, reviews, support
  // tickets, account notices. Their text is written by other people or talks about past
  // orders, so it must never be read as a parcel status.
  if (/vinted/.test(from.domain) && /^(re:\s*)?(hai un nuovo messaggio|lascia una recensione|contattaci|nuova offerta|il tuo articolo)/i.test(subject)) return null;
  if (/poste/.test(from.domain) && /(posteid|identity provider|\bpec\b|autenticazione)/i.test(subject)) return null;
  // Vinted names the article only in the subject of its own updates.
  const item = subject.match(/^aggiornamento ordine per\s+(.{2,80})$/i) || subject.match(/^(.{2,80}?)\s+-\s+.{1,3}\s*tutto a posto\??$/i);
  if (item && /vinted/.test(from.domain)) ev.item = item[1].trim();
  let r = readStage(subject);
  if (!r.stage && !r.problem && known) r = readStage(snippet);
  // An unknown sender has to say it in the subject, or every promo about "spedizione" gets in.
  if (!known && !r.stage) return null;
  ev.stage = r.stage; ev.problem = r.problem;
  ev.kind = known ? "vendor" : "generic";
  ev.merchant = vendorName(from.domain, from.name);
  ev.known = known;
  return ev;
}

/** Second pass, from the body: ids, expected date, where the parcel was left, tracking. */
function parseDetails(full, ev) {
  const text = bodyText(full.payload);
  const flat = cleanSpaces(text);
  const d = {};
  let m;
  if (ev.kind === "amazon") {
    if ((m = text.match(/\b(\d{3}-\d{7}-\d{7})\b/))) d.orderNo = m[1];
    // The tracking link carries its own order number, which is not always the one printed
    // above it: one box can hold items from two orders.
    const tr = text.match(/orderId=(\d{3}-\d{7}-\d{7})\S*?packageIndex=(\d+)\S*?shipmentId=([A-Za-z0-9_-]{5,})/);
    if (tr) { d.shipmentId = tr[3]; d.track = [tr[1], Number(tr[2]), tr[3]]; }
    else if ((m = text.match(/shipmentId=([A-Za-z0-9_-]{5,})/))) d.shipmentId = m[1];
    // What is inside: "* name" followed by "Quantità: n". Each item keeps the delivery
    // estimate of the block it is listed under (an order can arrive in several rounds).
    d.items = [];
    let blockEta = "";
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const e = etaFrom(line, ev.when);
      if (e) blockEta = e;
      const it = line.match(/^\*\s+(.{3,})$/);
      if (it && /^\s*Quantit/i.test(lines[i + 1] || "")) {
        const q = ((lines[i + 1] || "").match(/(\d+)/) || [0, 1])[1];
        d.items.push({ n: cleanSpaces(it[1]).slice(0, 160), q: Number(q), eta: blockEta });
      }
    }
    // Where it was left. The sentence does not always end with a full stop: cut it where
    // the next block of the mail starts, and drop the address-form leftovers.
    if ((m = flat.match(/Il (?:tuo )?pacco è stato ((?:depositato|lasciato|ritirato|affidato|consegnato (?:a|al|alla|in|presso|nella|nel))\b[^.!]{3,200})/i))) {
      const note = m[1].split(/\s+(?:Ordine\s*#|Traccia il pacco|https?:\/\/)/i)[0]
        .replace(/,?\s*Seleziona regione.*$/i, "").replace(/\s+[A-ZÀ-Ý][\wà-ÿ]+\s+-\s+[A-ZÀ-Ý][\wà-ÿ' ]+$/, "").trim();
      if (note.length > 8) d.note = (note.charAt(0).toUpperCase() + note.slice(1)).slice(0, 140);
    }
  } else {
    // A reference always has a digit in it: without that rule "ordine spedito" yields "spedito".
    if ((m = flat.match(/(?:numero )?lavoro\s*(?:n\.?|:)?\s*(\d{6,})/i))) d.ref = m[1];
    else if ((m = (ev.subject + " " + flat).match(/\b(?:ordine|order)\s*(?:n\.?|nr\.?|#|:)?\s*((?=[A-Z-]*\d)[A-Z0-9][A-Z0-9-]{4,})/i))) d.ref = m[1];
    if ((m = flat.match(/(?:numero di (?:tracciamento|spedizione)|tracking(?: number)?|codice (?:di )?(?:tracciamento|spedizione)|lettera di vettura)\s*[:#]?\s*([A-Z0-9]{8,30})\b/i))) d.tracking = m[1];
    // In HTML-only mail the number is a link, so the link target sits between label and number.
    else if ((m = text.match(/[?&](?:number|tracking(?:number|id)?|trackingcode)=([A-Z0-9]{8,30})\b/i))) d.tracking = m[1];
    if ((m = flat.match(/\b(GLS|BRT|Bartolini|DHL|UPS|SDA|Poste Italiane|InPost|FedEx|TNT)\b/))) d.carrier = m[1];
    if (/\bda Vinted\b|Vinted ha inoltrato/i.test(flat)) d.via = "Vinted";
    // Collection point: the code to show, where, and until when.
    if ((m = flat.match(/\bPIN(?: monouso)?\s*:?\s*(\d{4,8})\b/i)) || (m = ev.subject.match(/\bPIN\s*(\d{4,8})\b/i))) d.pin = m[1];
    if ((m = flat.match(/Point presso\s+(.{5,90}?)\s+(?:IT[A-Z0-9]{6,}\b|Orari di apertura)/))) d.place = m[1].trim();
    if ((m = flat.match(/Fino a quando puoi ritirare[^?]{0,40}\?\s*[A-Za-zìí]*\s*(\d{1,2})\.(\d{1,2})\s*ore\s*(\d{1,2}:\d{2})/i))) {
      const sent = romeDay(ev.when).iso;
      let iso = sent.slice(0, 4) + "-" + pad(m[2]) + "-" + pad(m[1]);
      if (iso < addDays(sent, -60)) iso = (Number(sent.slice(0, 4)) + 1) + iso.slice(4);
      d.deadline = iso; d.deadlineTime = m[3];
    }
    if (/rimbors/i.test(flat)) d.refund = true;
    if (!ev.stage && !ev.problem) {
      const r = readStage(flat.slice(0, 1500));
      d.stage = r.stage; d.problem = r.problem;
    }
  }
  const eta = etaFrom(text, ev.when);
  if (eta) d.eta = eta;
  return d;
}

/** A carrier mail forwarded by a marketplace belongs to the marketplace's parcel. */
const familyOf = (ev, d) => (ev.merchant === "Vinted" || d.via === "Vinted" ? "vinted" : slug(ev.merchant || ev.domain) || "x");

/**
 * Everything a non-Amazon mail can be recognised by. Two mails naming the same thing are
 * about the same parcel. The order reference comes first: it is on every mail about the
 * order, while the tracking number only appears once the parcel has left.
 */
function handlesOf(ev, d) {
  const fam = familyOf(ev, d);
  const hs = [];
  if (d.ref) hs.push(fam + ":" + d.ref);
  if (d.tracking) hs.push(fam + ":" + d.tracking);
  if (ev.item) hs.push(fam + ":i:" + slug(ev.item));
  if (!hs.length) hs.push(fam + ":t-" + ev.threadId);
  return hs;
}

function titleOf(fam, list) {
  const pick = (f) => { for (const x of list) if (f(x)) return f(x); return ""; };
  const ref = pick((x) => x.d.ref);
  if (fam === "pressup") return "Stampa PressUP" + (ref ? ", lavoro " + ref : "");
  if (fam === "bizay") return "Ordine Bizay" + (ref ? " " + ref : "");
  if (fam === "vinted") { const item = pick((x) => x.ev.item); return item ? "Vinted: " + item : "Pacco Vinted"; }
  if (fam === "inpost") return "Pacco InPost";
  return list[list.length - 1].ev.subject.replace(/^(re|r|fwd|i):\s*/i, "").slice(0, 90);
}

function trackUrl(p) {
  if (p.kind === "amazon" && p.track) {
    return "https://www.amazon.it/progress-tracker/package?_encoding=UTF8&orderId=" + p.track[0] +
      "&packageIndex=" + p.track[1] + "&shipmentId=" + p.track[2];
  }
  if (p.kind === "amazon" && p.orderNo) return "https://www.amazon.it/your-orders/order-details?orderID=" + p.orderNo;
  if (p.tracking && (p.merchant === "InPost" || p.carrier === "InPost")) return "https://inpost.it/trova-il-tuo-pacco?number=" + p.tracking;
  return "";
}

// ---------- events -> parcels ----------

const DAY = 86400000;

/** Same product? Full names match exactly; a subject-line title is only a prefix of one. */
const sameItem = (a, b) => a === b || (Math.min(a.length, b.length) >= 12 && (a.startsWith(b) || b.startsWith(a)));

/** Items of a mail; when the body gave none, the title from the subject stands in. */
const itemsOf = (x) => (x.d.items && x.d.items.length ? x.d.items : [{ n: x.ev.title, q: 1, eta: x.d.eta || "" }]);

function shortName(n) {
  n = cleanSpaces(n);
  if (n.length <= 62) return n;
  const cut = n.slice(0, 62);
  const sp = cut.lastIndexOf(" ");
  return cut.slice(0, sp > 30 ? sp : 62).replace(/[,;:.\-–(]+$/, "").trim();
}

const topStage = (list) => {
  let stage = "";
  for (const x of list) if ((STAGE_RANK[x.ev.stage] || 0) > (STAGE_RANK[stage] || 0)) stage = x.ev.stage;
  return stage;
};

/**
 * Amazon: a parcel is a set of mails that share a shipment id OR an item, a few days apart.
 * The shipment id alone is not enough: when Amazon packs two orders in one box, the "out for
 * delivery" and the "delivered" mail each link a different shipment of that same box.
 */
function amazonParcels(list) {
  const ship = list.filter((x) => x.ev.stage !== "ordered").sort((a, b) => a.ev.when - b.ev.when);
  const orders = list.filter((x) => x.ev.stage === "ordered");

  const parent = ship.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < ship.length; i++) {
    for (let j = i + 1; j < ship.length; j++) {
      const a = ship[i], b = ship[j];
      const sameShipment = !!a.d.shipmentId && a.d.shipmentId === b.d.shipmentId;
      const near = Math.abs(a.ev.when - b.ev.when) <= 6 * DAY;
      if (sameShipment || (near && itemsOf(a).some((x) => itemsOf(b).some((y) => sameItem(x.n, y.n))))) {
        parent[find(j)] = find(i);
      }
    }
  }
  const comps = new Map();
  ship.forEach((x, i) => {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(x);
  });

  const out = [];
  for (const evs of comps.values()) {
    const newest = evs[evs.length - 1];
    const names = [];
    for (const x of evs.slice().reverse()) {
      for (const it of itemsOf(x)) if (!names.some((n) => sameItem(n, it.n))) names.push(it.n);
    }
    // Every shipment id seen is a valid name for this parcel: the user's tick is stored
    // under all of them, so a late mail that adds one can never bring a confirmed parcel back.
    const ids = [];
    for (const x of evs) if (x.d.shipmentId && !ids.includes(x.d.shipmentId)) ids.push(x.d.shipmentId);
    const keys = ids.length ? ids.map((s) => "amz:s:" + s) : ["amz:t:" + slug(names[0])];
    const p = {
      key: keys[0], keys, kind: "amazon", merchant: "Amazon", stage: topStage(evs) || "shipped",
      title: shortName(names[0]), items: names.slice(0, 8).map(shortName),
      // The subject can announce more items than the body lists by name.
      count: Math.max(names.length, ...evs.map((x) => (x.d.items && x.d.items.length) || x.ev.count || 1)),
      updated: new Date(newest.ev.when).toISOString(), threadId: newest.ev.threadId,
    };
    if (newest.ev.problem && p.stage !== "delivered") { p.problem = true; p.problemNote = newest.ev.subject.slice(0, 110); }
    for (const x of evs) {
      if (x.d.note) p.note = x.d.note;
      if (x.d.track) p.track = x.d.track;
      if (x.d.eta && x.ev.stage !== "delivered") p.eta = x.d.eta;
    }
    out.push(p);
  }

  // An order stays listed only for the items that have not left yet.
  const seen = new Set();
  for (const o of orders.sort((a, b) => b.ev.when - a.ev.when)) {
    const all = itemsOf(o);
    const left = all.filter((it) => !ship.some((s) => s.ev.when >= o.ev.when - 3600000 && itemsOf(s).some((y) => sameItem(y.n, it.n))));
    if (!left.length) continue;
    const key = o.d.orderNo ? "amz:o:" + o.d.orderNo : "amz:t:" + slug(left[0].n);
    if (seen.has(key)) continue;
    seen.add(key);
    const etas = left.map((it) => it.eta).filter(Boolean).sort();
    const p = {
      key, keys: [key], kind: "amazon", merchant: "Amazon", stage: "ordered",
      title: shortName(left[0].n), count: left.length, items: left.slice(0, 8).map((it) => shortName(it.n)),
      updated: new Date(o.ev.when).toISOString(), threadId: o.ev.threadId, orderNo: o.d.orderNo,
    };
    if (all.length > left.length) p.total = all.length;
    if (etas[0] || o.d.eta) p.eta = etas[0] || o.d.eta;
    out.push(p);
  }
  return out;
}

/** Shops and carriers: mails are tied together by what they name (order, tracking, article). */
function vendorParcels(list, todayISO) {
  list = list.slice().sort((a, b) => a.ev.when - b.ev.when);
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const fams = list.map((x) => familyOf(x.ev, x.d));
  const hands = list.map((x) => handlesOf(x.ev, x.d));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (fams[i] !== fams[j]) continue;
      // Vinted sends its own update the moment it forwards the carrier's mail: the two share
      // nothing but the minute they were sent in (one has the tracking, the other the article).
      const sameMinute = fams[i] === "vinted" && Math.abs(list[i].ev.when - list[j].ev.when) <= 3 * 60000;
      if (sameMinute || hands[i].some((h) => hands[j].includes(h))) parent[find(j)] = find(i);
    }
  }
  const comps = new Map();
  list.forEach((x, i) => {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, { fam: fams[i], evs: [], keys: [] });
    const c = comps.get(r);
    c.evs.push(x);
    for (const h of hands[i]) if (!c.keys.includes(h)) c.keys.push(h);
  });

  const out = [];
  for (const { fam, evs, keys } of comps.values()) {
    const newest = evs[evs.length - 1];
    const p = {
      key: keys[0], keys, kind: newest.ev.kind, stage: topStage(evs) || "ordered",
      merchant: fam === "vinted" ? "Vinted" : newest.ev.merchant,
      title: titleOf(fam, evs), count: 1,
      updated: new Date(newest.ev.when).toISOString(), threadId: newest.ev.threadId,
    };
    const closed = p.stage === "delivered" || p.stage === "returned";
    // A problem matters only while it is the latest word on the parcel.
    if (newest.ev.problem && !closed) {
      p.problem = true;
      p.problemNote = newest.ev.subject.replace(/^PressUP\s*-\s*/i, "").slice(0, 110);
    }
    const got = {};
    for (const x of evs) {
      for (const f of ["tracking", "carrier", "ref", "pin", "place", "deadline", "deadlineTime", "refund"]) if (x.d[f] != null) got[f] = x.d[f];
      if (x.d.eta && x.ev.stage !== "delivered") p.eta = x.d.eta;
    }
    for (const f of ["tracking", "carrier", "ref"]) if (got[f] != null) p[f] = got[f];
    if (p.stage === "pickup") {
      // Waiting at a collection point: what matters is where, until when, and the code.
      if (got.deadline) { p.deadline = got.deadline; if (got.deadlineTime) p.deadlineTime = got.deadlineTime; }
      const bits = [];
      if (got.place) bits.push("Presso " + got.place);
      if (got.pin) bits.push("PIN " + got.pin);
      if (bits.length) p.note = bits.join(" · ");
      if (p.deadline && p.deadline < todayISO) p.late = true;
      delete p.eta;
    }
    if (p.stage === "returned") {
      p.note = "Non ritirato o non consegnato: torna al mittente." + (got.refund ? " Il rimborso parte quando il venditore lo riceve." : "");
    }
    out.push(p);
  }
  return out;
}

function build(events, details, todayISO) {
  const amazon = [], others = [];
  for (const ev of events) {
    const d = details[ev.id] || {};
    if (!ev.stage && d.stage) ev.stage = d.stage;
    if (!ev.problem && d.problem) ev.problem = true;
    if (!ev.stage && !ev.problem) continue;
    (ev.kind === "amazon" ? amazon : others).push({ ev, d });
  }

  const out = amazonParcels(amazon).concat(vendorParcels(others, todayISO));
  for (const p of out) {
    if (p.stage === "delivered" || p.stage === "returned") delete p.eta;
    if (p.eta && p.eta < todayISO) p.late = true;
    const url = trackUrl(p);
    if (url) p.trackUrl = url;
    delete p.track;
  }

  // What needs a look first: sent back, then delivered (to confirm), then waiting at a point.
  const order = (p) => (p.stage === "returned" ? -1 : p.stage === "delivered" ? 0 : p.stage === "pickup" ? 1 : p.problem ? 2 : p.stage === "out" ? 3 : p.stage === "shipped" ? 4 : 5);
  out.sort((a, b) => order(a) - order(b) || (a.eta || "9999").localeCompare(b.eta || "9999") || b.updated.localeCompare(a.updated));
  return out;
}

// Exposed for the offline tests only.
export const _internals = { classify, parseDetails, build, etaFrom, readStage };

/**
 * Scan the mailbox for parcels.
 * `cache` is what the previous scan returned: { v, m: { messageId: 0 | { e, d } } }, where 0
 * marks a mail that is not about a parcel, `e` is the event read from the headers and `d` the
 * details read from the body (null until downloaded).
 * `pending` in the result counts mails still to read: call again to finish.
 */
export async function parcelsScan(token, cache) {
  const seen = cache && cache.v === CACHE_VERSION && cache.m ? cache.m : {};
  const list = await getJSON(token, ME + "/messages?maxResults=" + MAX_MSGS + "&q=" + encodeURIComponent(QUERY));
  const ids = (list.messages || []).map((m) => m.id);

  const unread = ids.filter((id) => !(id in seen)).slice(0, MAX_NEW_META);
  if (unread.length) {
    const metas = await batchGet(token, unread.map((id) => ME + "/messages/" + id + "?format=metadata&metadataHeaders=Subject&metadataHeaders=From"));
    unread.forEach((id, i) => {
      if (!metas[i]) return; // failed inside the batch: stays unread, the next pass retries it
      const ev = classify(metas[i]);
      if (ev) delete ev.snippet;
      seen[id] = ev ? { e: ev, d: null } : 0;
    });
  }

  const bodiless = ids.filter((id) => seen[id] && !seen[id].d).slice(0, MAX_NEW_BODIES);
  if (bodiless.length) {
    const fields = encodeURIComponent("id,payload(mimeType,body/data,parts(mimeType,body/data,parts(mimeType,body/data,parts(mimeType,body/data))))");
    const fulls = await batchGet(token, bodiless.map((id) => ME + "/messages/" + id + "?format=full&fields=" + fields));
    bodiless.forEach((id, i) => { if (fulls[i]) seen[id].d = parseDetails(fulls[i], seen[id].e); });
  }

  // Only what the search still returns is kept, so the cache empties itself as mail ages out.
  const keep = {}, events = [], details = {};
  let matched = 0, pending = 0;
  for (const id of ids) {
    if (!(id in seen)) { pending++; continue; }
    keep[id] = seen[id];
    if (!seen[id]) continue;
    matched++;
    if (!seen[id].d) { pending++; continue; }
    events.push(Object.assign({}, seen[id].e)); // build() fills in stages: work on a copy
    details[id] = seen[id].d;
  }
  return {
    parcels: build(events, details, romeDay(Date.now()).iso),
    cache: { v: CACHE_VERSION, m: keep },
    scanned: ids.length,
    matched,
    pending,
  };
}
