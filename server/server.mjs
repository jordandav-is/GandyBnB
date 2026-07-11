import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const scrypt = promisify(scryptCallback);
const port = Number(process.env.PORT ?? 8787);
const databasePath = resolve(process.env.DATA_FILE ?? "data/gandybnb.sqlite");
const configuredOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const subscribers = new Set();
const loginAttempts = new Map();

mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 2 AND 60),
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guest_name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
    created_at TEXT NOT NULL,
    CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    CHECK (end_date > start_date)
  );

  CREATE INDEX IF NOT EXISTS reservations_active_dates
  ON reservations(status, start_date, end_date);
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
`);

const statements = {
  createUser: database.prepare("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)"),
  userByEmail: database.prepare("SELECT id, email, display_name, password_hash FROM users WHERE email = ?"),
  userBySession: database.prepare(`
    SELECT users.id, users.email, users.display_name
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `),
  createSession: database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"),
  deleteSession: database.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  deleteExpiredSessions: database.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
  activeReservations: database.prepare(`
    SELECT id, user_id, guest_name, start_date, end_date, status, created_at
    FROM reservations WHERE status = 'confirmed' ORDER BY start_date, created_at
  `),
  conflictingReservation: database.prepare(`
    SELECT id FROM reservations
    WHERE status = 'confirmed' AND start_date < ? AND end_date > ? LIMIT 1
  `),
  createReservation: database.prepare(`
    INSERT INTO reservations (id, user_id, guest_name, start_date, end_date, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'confirmed', ?)
  `),
  reservationById: database.prepare(`
    SELECT id, user_id, guest_name, start_date, end_date, status, created_at
    FROM reservations WHERE id = ?
  `),
  cancelReservation: database.prepare(`
    UPDATE reservations SET status = 'cancelled'
    WHERE id = ? AND user_id = ? AND status = 'confirmed' AND start_date >= ?
  `),
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `${salt.toString("hex")}:${Buffer.from(derived).toString("hex")}`;
}

async function passwordMatches(password, stored) {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, "hex"), expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function dateFromIso(value) {
  if (!datePattern.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : parsed;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function validateStay(start, end) {
  const startDate = dateFromIso(start);
  const endDate = dateFromIso(end);
  if (!startDate || !endDate) return "Choose valid check-in and check-out dates.";
  if (start < todayIso()) return "Check-in cannot be in the past.";
  if (end <= start) return "Check-out must be after check-in.";
  if ((endDate.getTime() - startDate.getTime()) / 86_400_000 > 21) return "Family stays are limited to 21 nights.";
  return null;
}

function requestOrigin(request) {
  return String(request.headers.origin ?? "").replace(/\/$/, "");
}

function corsHeaders(request) {
  const origin = requestOrigin(request);
  return configuredOrigins.includes(origin)
    ? { "access-control-allow-origin": origin, vary: "Origin" }
    : {};
}

function sendJson(response, request, status, value, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders(request),
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error("Request body is too large.");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function bearerToken(request) {
  const authorization = String(request.headers.authorization ?? "");
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

function authenticatedUser(request) {
  const token = bearerToken(request);
  if (!token) return null;
  return statements.userBySession.get(sha256(token), new Date().toISOString()) ?? null;
}

function issueSession(userId) {
  const token = randomBytes(32).toString("base64url");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + sessionLifetimeMs);
  statements.createSession.run(sha256(token), userId, expiresAt.toISOString(), createdAt.toISOString());
  return { token, expires_at: expiresAt.toISOString() };
}

function broadcastReservationsChanged() {
  const payload = `event: reservations\ndata: ${JSON.stringify({ changed_at: new Date().toISOString() })}\n\n`;
  for (const response of subscribers) response.write(payload);
}

function enforceLoginRateLimit(request) {
  const key = request.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const recent = (loginAttempts.get(key) ?? []).filter((time) => now - time < 60_000);
  if (recent.length >= 10) return false;
  recent.push(now);
  loginAttempts.set(key, recent);
  return true;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      ...corsHeaders(request),
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
      "access-control-max-age": "86400",
    });
    response.end();
    return;
  }

  if (url.pathname === "/health" && request.method === "GET") {
    sendJson(response, request, 200, { status: "ok" });
    return;
  }

  try {
    if (url.pathname === "/auth/signup" && request.method === "POST") {
      if (!enforceLoginRateLimit(request)) {
        sendJson(response, request, 429, { error: "Too many attempts. Try again in a minute." });
        return;
      }
      const body = await readJson(request);
      const email = String(body.email ?? "").trim().toLowerCase();
      const displayName = String(body.display_name ?? "").trim();
      const password = String(body.password ?? "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
      if (displayName.length < 2 || displayName.length > 60) throw new Error("Name must be between 2 and 60 characters.");
      if (password.length < 10 || password.length > 200) throw new Error("Password must be between 10 and 200 characters.");
      const user = { id: randomBytes(16).toString("hex"), email, display_name: displayName };
      const now = new Date().toISOString();
      try {
        statements.createUser.run(user.id, email, displayName, await hashPassword(password), now);
      } catch (error) {
        if (String(error).includes("UNIQUE")) {
          sendJson(response, request, 409, { error: "An account already exists for that email." });
          return;
        }
        throw error;
      }
      sendJson(response, request, 201, { user, ...issueSession(user.id) });
      return;
    }

    if (url.pathname === "/auth/login" && request.method === "POST") {
      if (!enforceLoginRateLimit(request)) {
        sendJson(response, request, 429, { error: "Too many attempts. Try again in a minute." });
        return;
      }
      const body = await readJson(request);
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      const userRecord = statements.userByEmail.get(email);
      if (!userRecord || !(await passwordMatches(password, userRecord.password_hash))) {
        sendJson(response, request, 401, { error: "Email or password is incorrect." });
        return;
      }
      const user = { id: userRecord.id, email: userRecord.email, display_name: userRecord.display_name };
      sendJson(response, request, 200, { user, ...issueSession(user.id) });
      return;
    }

    if (url.pathname === "/auth/logout" && request.method === "POST") {
      const token = bearerToken(request);
      if (token) statements.deleteSession.run(sha256(token));
      sendJson(response, request, 200, { ok: true });
      return;
    }

    const user = authenticatedUser(request);
    if (!user) {
      sendJson(response, request, 401, { error: "Your session has expired. Sign in again." });
      return;
    }

    if (url.pathname === "/session" && request.method === "GET") {
      sendJson(response, request, 200, { user });
      return;
    }

    if (url.pathname === "/reservations" && request.method === "GET") {
      sendJson(response, request, 200, { reservations: statements.activeReservations.all() });
      return;
    }

    if (url.pathname === "/reservations" && request.method === "POST") {
      const body = await readJson(request);
      const start = String(body.start_date ?? "");
      const end = String(body.end_date ?? "");
      const validation = validateStay(start, end);
      if (validation) {
        sendJson(response, request, 400, { error: validation });
        return;
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        if (statements.conflictingReservation.get(end, start)) {
          database.exec("ROLLBACK");
          sendJson(response, request, 409, { error: "Those dates were just booked by someone else." });
          return;
        }
        const reservationId = randomBytes(16).toString("hex");
        statements.createReservation.run(reservationId, user.id, user.display_name, start, end, new Date().toISOString());
        database.exec("COMMIT");
        const reservation = statements.reservationById.get(reservationId);
        sendJson(response, request, 201, { reservation });
        broadcastReservationsChanged();
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch {}
        throw error;
      }
      return;
    }

    const cancellation = url.pathname.match(/^\/reservations\/([a-f0-9]+)\/cancel$/);
    if (cancellation && request.method === "PATCH") {
      const result = statements.cancelReservation.run(cancellation[1], user.id, todayIso());
      if (result.changes === 0) {
        sendJson(response, request, 404, { error: "That future reservation was not found." });
        return;
      }
      sendJson(response, request, 200, { ok: true });
      broadcastReservationsChanged();
      return;
    }

    if (url.pathname === "/events" && request.method === "GET") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        ...corsHeaders(request),
      });
      response.write(`event: connected\ndata: ${JSON.stringify({ connected_at: new Date().toISOString() })}\n\n`);
      subscribers.add(response);
      const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 20_000);
      request.on("close", () => {
        clearInterval(keepAlive);
        subscribers.delete(response);
      });
      return;
    }

    sendJson(response, request, 404, { error: "Not found." });
  } catch (error) {
    console.error(error);
    sendJson(response, request, 500, { error: error instanceof Error ? error.message : "Unexpected server error." });
  }
});

statements.deleteExpiredSessions.run(new Date().toISOString());
const sessionCleanup = setInterval(() => statements.deleteExpiredSessions.run(new Date().toISOString()), 60 * 60 * 1000);
sessionCleanup.unref();

server.listen(port, "0.0.0.0", () => {
  console.log(`Gandy House API listening on http://localhost:${port}`);
});

function shutdown() {
  for (const response of subscribers) response.end();
  server.close(() => {
    database.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
