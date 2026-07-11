import { DurableObject } from "cloudflare:workers";

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const SOCKET_TICKET_LIFETIME_MS = 60 * 1000;
const PASSWORD_ITERATIONS = 100_000;
const DAY_IN_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function sha256(value) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function derivePassword(password, salt, iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return bytesToHex(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  ));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${PASSWORD_ITERATIONS}:${bytesToHex(salt)}:${await derivePassword(password, salt)}`;
}

async function passwordMatches(password, stored) {
  const [iterationText, saltHex, expected] = stored.split(":");
  const iterations = Number(iterationText);
  if (!iterations || !saltHex || !expected) return false;
  const actual = await derivePassword(password, hexToBytes(saltHex), iterations);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function dateFromIso(value) {
  if (!DATE_PATTERN.test(value)) return null;
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
  if ((endDate.getTime() - startDate.getTime()) / DAY_IN_MS > 21) return "Family stays are limited to 21 nights.";
  return null;
}

function firstRow(cursor) {
  return [...cursor][0] ?? null;
}

export class BeachHouse extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.allowedOrigins = String(env.ALLOWED_ORIGINS ?? "http://localhost:3000")
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
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
      CREATE TABLE IF NOT EXISTS socket_tickets (
        ticket_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_attempts (
        address_hash TEXT NOT NULL,
        attempted_at INTEGER NOT NULL
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
      CREATE INDEX IF NOT EXISTS reservations_active_dates ON reservations(status, start_date, end_date);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS attempts_address_time ON login_attempts(address_hash, attempted_at);
    `);
  }

  corsHeaders(request) {
    const origin = String(request.headers.get("Origin") ?? "").replace(/\/$/, "");
    return this.allowedOrigins.includes(origin)
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {};
  }

  json(request, status, value, extraHeaders = {}) {
    return Response.json(value, {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...this.corsHeaders(request),
        ...extraHeaders,
      },
    });
  }

  async readJson(request) {
    const length = Number(request.headers.get("Content-Length") ?? 0);
    if (length > 16_384) throw new Error("Request body is too large.");
    try {
      return await request.json();
    } catch {
      throw new Error("Request body must be valid JSON.");
    }
  }

  async userForRequest(request) {
    const authorization = request.headers.get("Authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) return null;
    return firstRow(this.sql.exec(`
      SELECT users.id, users.email, users.display_name
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `, await sha256(token), new Date().toISOString()));
  }

  issueSession(userId) {
    const token = randomToken();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + SESSION_LIFETIME_MS);
    return sha256(token).then((tokenHash) => {
      this.sql.exec(
        "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
        tokenHash,
        userId,
        expiresAt.toISOString(),
        createdAt.toISOString(),
      );
      return { token, expires_at: expiresAt.toISOString() };
    });
  }

  async rateLimitLogin(request) {
    const addressHash = await sha256(request.headers.get("CF-Connecting-IP") ?? "local");
    const cutoff = Date.now() - 60_000;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM login_attempts WHERE attempted_at < ?", cutoff);
    });
    const count = firstRow(this.sql.exec(
      "SELECT count(*) AS count FROM login_attempts WHERE address_hash = ?",
      addressHash,
    ))?.count ?? 0;
    if (count >= 10) return false;
    this.sql.exec("INSERT INTO login_attempts (address_hash, attempted_at) VALUES (?, ?)", addressHash, Date.now());
    return true;
  }

  broadcastAvailability() {
    const message = JSON.stringify({ type: "reservations", changed_at: new Date().toISOString() });
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(message); } catch {}
    }
  }

  async openSocket(request, url) {
    const ticket = url.searchParams.get("ticket") ?? "";
    if (!ticket) return new Response("Missing socket ticket.", { status: 401 });
    const ticketHash = await sha256(ticket);
    const ticketRow = firstRow(this.sql.exec(`
      SELECT socket_tickets.user_id, users.display_name
      FROM socket_tickets JOIN users ON users.id = socket_tickets.user_id
      WHERE ticket_hash = ? AND expires_at > ?
    `, ticketHash, new Date().toISOString()));
    if (!ticketRow) return new Response("Socket ticket expired.", { status: 401 });
    this.sql.exec("DELETE FROM socket_tickets WHERE ticket_hash = ?", ticketHash);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ user_id: ticketRow.user_id, display_name: ticketRow.display_name });
    server.send(JSON.stringify({ type: "connected", connected_at: new Date().toISOString() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...this.corsHeaders(request),
          "Access-Control-Allow-Headers": "authorization, content-type",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    if (url.pathname === "/events" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.openSocket(request, url);
    }

    try {
      if (url.pathname === "/auth/signup" && request.method === "POST") {
        if (!(await this.rateLimitLogin(request))) return this.json(request, 429, { error: "Too many attempts. Try again in a minute." });
        const body = await this.readJson(request);
        const email = String(body.email ?? "").trim().toLowerCase();
        const displayName = String(body.display_name ?? "").trim();
        const password = String(body.password ?? "");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
        if (displayName.length < 2 || displayName.length > 60) throw new Error("Name must be between 2 and 60 characters.");
        if (password.length < 10 || password.length > 200) throw new Error("Password must be between 10 and 200 characters.");
        const user = { id: crypto.randomUUID(), email, display_name: displayName };
        try {
          this.sql.exec(
            "INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
            user.id,
            email,
            displayName,
            await hashPassword(password),
            new Date().toISOString(),
          );
        } catch (error) {
          if (String(error).includes("UNIQUE")) return this.json(request, 409, { error: "An account already exists for that email." });
          throw error;
        }
        return this.json(request, 201, { user, ...await this.issueSession(user.id) });
      }

      if (url.pathname === "/auth/login" && request.method === "POST") {
        if (!(await this.rateLimitLogin(request))) return this.json(request, 429, { error: "Too many attempts. Try again in a minute." });
        const body = await this.readJson(request);
        const email = String(body.email ?? "").trim().toLowerCase();
        const password = String(body.password ?? "");
        const userRecord = firstRow(this.sql.exec(
          "SELECT id, email, display_name, password_hash FROM users WHERE email = ?",
          email,
        ));
        if (!userRecord || !(await passwordMatches(password, userRecord.password_hash))) {
          return this.json(request, 401, { error: "Email or password is incorrect." });
        }
        const user = { id: userRecord.id, email: userRecord.email, display_name: userRecord.display_name };
        return this.json(request, 200, { user, ...await this.issueSession(user.id) });
      }

      if (url.pathname === "/auth/logout" && request.method === "POST") {
        const authorization = request.headers.get("Authorization") ?? "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        if (token) this.sql.exec("DELETE FROM sessions WHERE token_hash = ?", await sha256(token));
        return this.json(request, 200, { ok: true });
      }

      const user = await this.userForRequest(request);
      if (!user) return this.json(request, 401, { error: "Your session has expired. Sign in again." });

      if (url.pathname === "/session" && request.method === "GET") {
        return this.json(request, 200, { user });
      }

      if (url.pathname === "/socket-ticket" && request.method === "POST") {
        const ticket = randomToken();
        this.sql.exec(
          "INSERT INTO socket_tickets (ticket_hash, user_id, expires_at) VALUES (?, ?, ?)",
          await sha256(ticket),
          user.id,
          new Date(Date.now() + SOCKET_TICKET_LIFETIME_MS).toISOString(),
        );
        this.sql.exec("DELETE FROM socket_tickets WHERE expires_at <= ?", new Date().toISOString());
        return this.json(request, 201, { ticket });
      }

      if (url.pathname === "/reservations" && request.method === "GET") {
        const reservations = [...this.sql.exec(`
          SELECT id, user_id, guest_name, start_date, end_date, status, created_at
          FROM reservations WHERE status = 'confirmed' ORDER BY start_date, created_at
        `)];
        return this.json(request, 200, { reservations });
      }

      if (url.pathname === "/reservations" && request.method === "POST") {
        const body = await this.readJson(request);
        const start = String(body.start_date ?? "");
        const end = String(body.end_date ?? "");
        const validation = validateStay(start, end);
        if (validation) return this.json(request, 400, { error: validation });
        let reservation;
        try {
          this.ctx.storage.transactionSync(() => {
            const conflict = firstRow(this.sql.exec(`
              SELECT id FROM reservations
              WHERE status = 'confirmed' AND start_date < ? AND end_date > ? LIMIT 1
            `, end, start));
            if (conflict) throw new Error("BOOKING_CONFLICT");
            reservation = {
              id: crypto.randomUUID(),
              user_id: user.id,
              guest_name: user.display_name,
              start_date: start,
              end_date: end,
              status: "confirmed",
              created_at: new Date().toISOString(),
            };
            this.sql.exec(`
              INSERT INTO reservations (id, user_id, guest_name, start_date, end_date, status, created_at)
              VALUES (?, ?, ?, ?, ?, 'confirmed', ?)
            `, reservation.id, reservation.user_id, reservation.guest_name, start, end, reservation.created_at);
          });
        } catch (error) {
          if (error instanceof Error && error.message === "BOOKING_CONFLICT") {
            return this.json(request, 409, { error: "Those dates were just booked by someone else." });
          }
          throw error;
        }
        this.broadcastAvailability();
        return this.json(request, 201, { reservation });
      }

      const cancellation = url.pathname.match(/^\/reservations\/([a-f0-9-]+)\/cancel$/);
      if (cancellation && request.method === "PATCH") {
        const result = this.sql.exec(`
          UPDATE reservations SET status = 'cancelled'
          WHERE id = ? AND user_id = ? AND status = 'confirmed' AND start_date >= ?
          RETURNING id
        `, cancellation[1], user.id, todayIso());
        if (!firstRow(result)) return this.json(request, 404, { error: "That future reservation was not found." });
        this.broadcastAvailability();
        return this.json(request, 200, { ok: true });
      }

      return this.json(request, 404, { error: "Not found." });
    } catch (error) {
      console.error(error);
      return this.json(request, 500, { error: error instanceof Error ? error.message : "Unexpected server error." });
    }
  }

  webSocketMessage(socket, message) {
    if (String(message) === "ping") socket.send(JSON.stringify({ type: "pong" }));
  }
}

const worker = {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ status: "ok", backend: "durable-object" });
    return env.BEACH_HOUSE.getByName("gandy-house").fetch(request);
  },
};

export default worker;
