import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, "data");
const BOOKINGS = path.join(DATA, "bookings.json");
const PORT = Number(process.env.PORT || 4173);
const TUNIS = "Africa/Tunis";
const SLOT_POOL = [[14, 0], [14, 30], [15, 0], [15, 30], [16, 0], [16, 30], [17, 0], [17, 30]];
const hits = new Map();

async function loadEnvFile() {
  try {
    const raw = await readFile(path.join(ROOT, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    /* optional */
  }
}

function envMail() {
  const host = process.env.SMTP_HOST || "";
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";
  const from = process.env.MAIL_FROM || user;
  const to = process.env.NOTIFY_EMAIL || "";
  const port = Number(process.env.SMTP_PORT || 587);
  if (!host || !user || !pass || !from || !to) return null;
  return {
    from,
    to,
    transport: nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    }),
  };
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".mp4")) return "video/mp4";
  if (file.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

function safePublicPath(urlPath) {
  const clean = decodeURIComponent((urlPath || "/").split("?")[0]);
  if (clean.includes("\0")) return null;
  const rel = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  if (rel !== "index.html" && !rel.startsWith("assets/")) return null;
  if (rel.split("/").some((part) => !part || part.startsWith("."))) return null;
  const abs = path.resolve(ROOT, rel);
  if (abs !== path.join(ROOT, "index.html") && !abs.startsWith(path.join(ROOT, "assets") + path.sep)) return null;
  return abs;
}

function partsInZone(date, timeZone) {
  const map = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return map;
}

function mix(n) {
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return (n ^ (n >>> 16)) >>> 0;
}

function openingsOn(y, m, d) {
  const seed = mix(y * 10000 + m * 100 + d);
  const roll = seed % 11;
  if (roll < 3) return [];
  const i = (seed >>> 5) % SLOT_POOL.length;
  if (roll < 8) return [[SLOT_POOL[i][0], SLOT_POOL[i][1]]];
  let j = (seed >>> 11) % SLOT_POOL.length;
  if (Math.abs(j - i) < 3) j = (i + 3 + ((seed >>> 17) % 3)) % SLOT_POOL.length;
  return [[SLOT_POOL[i][0], SLOT_POOL[i][1]], [SLOT_POOL[j][0], SLOT_POOL[j][1]]]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function sameClock(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function shiftClock(clock) {
  const i = SLOT_POOL.findIndex((item) => sameClock(item, clock));
  return [SLOT_POOL[(i + 3) % SLOT_POOL.length][0], SLOT_POOL[(i + 3) % SLOT_POOL.length][1]];
}

function offeredDays(now = new Date()) {
  const today = partsInZone(now, TUNIS);
  const start = new Date(Date.UTC(+today.year, +today.month - 1, +today.day));
  const days = [];
  let previous = null;
  for (let n = 1; n <= 28 && days.length < 5; n++) {
    const dt = new Date(start.getTime());
    dt.setUTCDate(start.getUTCDate() + n);
    const wd = dt.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    let slots = openingsOn(y, m, d);
    if (slots.length === 1 && previous && sameClock(slots[0], previous)) slots = [shiftClock(slots[0])];
    if (slots.length === 2 && previous && sameClock(slots[0], previous)) {
      const moved = shiftClock(slots[0]);
      if (!sameClock(moved, slots[1])) slots[0] = moved;
      slots.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    }
    if (!slots.length) continue;
    previous = slots[0];
    days.push({ y, m, d, slots });
  }
  return days;
}

function isAllowedSlot(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  const p = partsInZone(date, TUNIS);
  const hour = Number(p.hour);
  const minute = Number(p.minute);
  return offeredDays().some((day) => (
    day.y === Number(p.year) && day.m === Number(p.month) && day.d === Number(p.day)
    && day.slots.some((slot) => slot[0] === hour && slot[1] === minute)
  ));
}

function formatWhen(date, timeZone, lang) {
  const locale = lang === "en" ? "en-GB" : "fr-FR";
  const day = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  const zone = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "long" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value || timeZone;
  return { day, time, zone };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clean(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 160;
}

async function readBookings() {
  try {
    const data = JSON.parse(await readFile(BOOKINGS, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writeBookings(list) {
  await mkdir(DATA, { recursive: true });
  await writeFile(BOOKINGS, JSON.stringify(list, null, 2));
}

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 8) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20_000) throw new Error("too-large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleBook(req, res) {
  const ip = req.socket.remoteAddress || "unknown";
  if (limited(ip)) return json(res, 429, { ok: false, error: "rate" });

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { ok: false, error: "invalid" });
  }

  const name = clean(payload.name, 80);
  const email = clean(payload.email, 160).toLowerCase();
  const phone = clean(payload.phone, 40);
  const company = clean(payload.company, 120);
  const lang = payload.lang === "en" ? "en" : "fr";
  const visitorTimeZone = clean(payload.visitorTimeZone, 80) || "UTC";
  const slot = new Date(payload.slotUtc);

  if (name.length < 2 || !validEmail(email) || phone.length < 6 || company.length < 2) {
    return json(res, 400, { ok: false, error: "fields" });
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: visitorTimeZone }).format(new Date());
  } catch {
    return json(res, 400, { ok: false, error: "timezone" });
  }
  if (!isAllowedSlot(slot)) return json(res, 400, { ok: false, error: "slot" });

  const mail = envMail();
  if (!mail) return json(res, 503, { ok: false, error: "mail" });

  const slotKey = slot.toISOString();
  const bookings = await readBookings();
  if (bookings.some((item) => item.slotUtc === slotKey)) return json(res, 409, { ok: false, error: "taken" });

  const local = formatWhen(slot, visitorTimeZone, lang);
  const tunis = formatWhen(slot, TUNIS, "fr");
  const end = new Date(slot.getTime() + 30 * 60 * 1000);
  const localEnd = formatWhen(end, visitorTimeZone, lang);
  const tunisEnd = formatWhen(end, TUNIS, "fr");

  const visitorSubject = lang === "en" ? "Your call with Delak is confirmed" : "Votre appel avec Delak est confirmé";
  const visitorHtml = lang === "en"
    ? `<p>Hello ${escapeHtml(name)},</p>
       <p>Your 30-minute call with Delak is confirmed.</p>
       <p><strong>${escapeHtml(local.day)}</strong><br>${escapeHtml(local.time)} – ${escapeHtml(localEnd.time)} (${escapeHtml(local.zone)})</p>
       <p>That is ${escapeHtml(tunis.time)} – ${escapeHtml(tunisEnd.time)}, Tunis time.</p>
       <p>See you then,<br>Delak</p>`
    : `<p>Bonjour ${escapeHtml(name)},</p>
       <p>Votre appel de 30 minutes avec Delak est confirmé.</p>
       <p><strong>${escapeHtml(local.day)}</strong><br>${escapeHtml(local.time)} – ${escapeHtml(localEnd.time)} (${escapeHtml(local.zone)})</p>
       <p>Soit ${escapeHtml(tunis.time)} – ${escapeHtml(tunisEnd.time)}, heure de Tunis.</p>
       <p>À très vite,<br>Delak</p>`;

  const notifyHtml = `<p>Nouvel appel réservé.</p>
    <ul>
      <li>Nom : ${escapeHtml(name)}</li>
      <li>Email : ${escapeHtml(email)}</li>
      <li>Téléphone : ${escapeHtml(phone)}</li>
      <li>Entreprise : ${escapeHtml(company)}</li>
      <li>Créneau visiteur : ${escapeHtml(local.day)}, ${escapeHtml(local.time)}–${escapeHtml(localEnd.time)} (${escapeHtml(local.zone)})</li>
      <li>Créneau Tunis : ${escapeHtml(tunis.day)}, ${escapeHtml(tunis.time)}–${escapeHtml(tunisEnd.time)}</li>
    </ul>`;

  try {
    await mail.transport.sendMail({
      from: mail.from,
      to: email,
      subject: visitorSubject,
      html: visitorHtml,
    });
    await mail.transport.sendMail({
      from: mail.from,
      to: mail.to,
      replyTo: email,
      subject: `Nouvel appel — ${company}`,
      html: notifyHtml,
    });
  } catch (err) {
    console.error("booking mail failed", err && err.code ? err.code : "send-error");
    return json(res, 502, { ok: false, error: "send" });
  }

  bookings.push({
    slotUtc: slotKey,
    name,
    email,
    phone,
    company,
    visitorTimeZone,
    createdAt: new Date().toISOString(),
  });
  await writeBookings(bookings);
  return json(res, 200, { ok: true });
}

async function serveStatic(req, res) {
  const file = safePublicPath(req.url || "/");
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  let info;
  try {
    info = await stat(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const type = contentType(file);
  const range = req.headers.range;
  if (range && file.endsWith(".mp4")) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Number(match[2]) : info.size - 1;
    if (!match || start >= info.size || end >= info.size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${info.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Cache-Control": "public, max-age=86400",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": info.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": file.endsWith(".html") ? "no-cache" : "public, max-age=3600",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

await loadEnvFile();

createServer(async (req, res) => {
  try {
    if (req.method === "POST" && (req.url || "").startsWith("/api/book")) return handleBook(req, res);
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
    res.writeHead(405);
    res.end("Method not allowed");
  } catch (err) {
    console.error(err && err.message ? err.message : "server-error");
    if (!res.headersSent) json(res, 500, { ok: false, error: "server" });
  }
}).listen(PORT, "0.0.0.0", () => {
  const ready = Boolean(envMail());
  console.log(`Delak site http://localhost:${PORT} mail=${ready ? "ready" : "missing-smtp"}`);
});
