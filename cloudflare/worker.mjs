import { DurableObject } from "cloudflare:workers";

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const SOCKET_TICKET_LIFETIME_MS = 60 * 1000;
const RESET_CODE_LIFETIME_MS = 60 * 60 * 1000;
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
  if ((endDate.getTime() - startDate.getTime()) / DAY_IN_MS > 21) return "Stays are limited to 21 nights.";
  return null;
}

function firstRow(cursor) {
  return [...cursor][0] ?? null;
}

function normalizeResetCode(value) {
  return String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

// Retained only because Cloudflare migration history requires every migrated class export.
export class BeachHouse extends DurableObject {}

export class BeachHouseProperty extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.allowedOrigins = String(env.ALLOWED_ORIGINS ?? "http://localhost:3000")
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean);
    this.superadminEmail = String(env.SUPERADMIN_EMAIL ?? "").trim().toLowerCase();
    // Optional break-glass secret (wrangler secret put RECOVERY_CODE) that can
    // reset the superadmin password even when no one can issue a code.
    this.recoveryCode = normalizeResetCode(env.RECOVERY_CODE ?? "");
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
      CREATE TABLE IF NOT EXISTS password_resets (
        code_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS listing (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
        tagline TEXT NOT NULL CHECK (length(tagline) <= 160),
        description TEXT NOT NULL CHECK (length(description) <= 2000),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL CHECK (length(url) <= 2048),
        caption TEXT NOT NULL DEFAULT '' CHECK (length(caption) <= 200),
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sender_role TEXT NOT NULL CHECK (sender_role IN ('guest', 'superadmin')),
        body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
        created_at TEXT NOT NULL,
        read_at TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_user_id, created_at);
      CREATE INDEX IF NOT EXISTS reservations_active_dates ON reservations(status, start_date, end_date);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS attempts_address_time ON login_attempts(address_hash, attempted_at);
    `);
    const userColumns = new Set([...this.sql.exec("SELECT name FROM pragma_table_info('users')")].map((row) => row.name));
    if (!userColumns.has("role")) {
      this.sql.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
    }
    const reservationColumns = new Set([...this.sql.exec("SELECT name FROM pragma_table_info('reservations')")].map((row) => row.name));
    if (!reservationColumns.has("payment_status")) {
      // Payments are intentionally unimplemented; this column is the seam a
      // payment provider will attach to later.
      this.sql.exec("ALTER TABLE reservations ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'not_required'");
    }
    if (this.superadminEmail) {
      this.sql.exec("UPDATE users SET role = CASE WHEN email = ? THEN 'superadmin' ELSE 'member' END", this.superadminEmail);
    }
    this.sql.exec(`
      INSERT INTO listing (id, name, tagline, description, updated_at)
      VALUES (1, 'Gandy House', 'Come for the tide. Stay for the porch.', 'A weathered little house where the coffee is strong, the rules are few, and every sunset earns an audience.', ?)
      ON CONFLICT (id) DO NOTHING
    `, new Date().toISOString());
  }

  corsHeaders(request) {
    const origin = String(request.headers.get("Origin") ?? "").replace(/\/$/, "");
    return this.allowedOrigins.includes(origin)
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {};
  }

  async json(request, status, value, extraHeaders = {}) {
    // Discard any unread request body; workerd raises "Can't read from request
    // stream after response has been sent" if a body is left unconsumed.
    if (request.body && !request.bodyUsed) await request.body.cancel().catch(() => {});
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
      SELECT users.id, users.email, users.display_name, users.role
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

  broadcast(type) {
    const message = JSON.stringify({ type, changed_at: new Date().toISOString() });
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
          "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
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
        const role = this.superadminEmail && email === this.superadminEmail ? "superadmin" : "member";
        const user = { id: crypto.randomUUID(), email, display_name: displayName, role };
        try {
          this.sql.exec(
            "INSERT INTO users (id, email, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            user.id,
            email,
            displayName,
            await hashPassword(password),
            role,
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
          "SELECT id, email, display_name, role, password_hash FROM users WHERE email = ?",
          email,
        ));
        if (!userRecord || !(await passwordMatches(password, userRecord.password_hash))) {
          return this.json(request, 401, { error: "Email or password is incorrect." });
        }
        const user = { id: userRecord.id, email: userRecord.email, display_name: userRecord.display_name, role: userRecord.role };
        return this.json(request, 200, { user, ...await this.issueSession(user.id) });
      }

      if (url.pathname === "/auth/reset" && request.method === "POST") {
        if (!(await this.rateLimitLogin(request))) return this.json(request, 429, { error: "Too many attempts. Try again in a minute." });
        const body = await this.readJson(request);
        const email = String(body.email ?? "").trim().toLowerCase();
        const code = normalizeResetCode(body.code ?? "");
        const password = String(body.password ?? "");
        if (password.length < 10 || password.length > 200) throw new Error("Password must be between 10 and 200 characters.");
        const userRecord = firstRow(this.sql.exec(
          "SELECT id, email, display_name, role FROM users WHERE email = ?",
          email,
        ));
        const rejection = () => this.json(request, 401, { error: "That reset code is not valid. Ask for a fresh one." });
        if (!userRecord || !code) return rejection();
        this.sql.exec("DELETE FROM password_resets WHERE expires_at <= ?", new Date().toISOString());
        const resetRow = firstRow(this.sql.exec(
          "SELECT user_id FROM password_resets WHERE code_hash = ? AND user_id = ?",
          await sha256(code),
          userRecord.id,
        ));
        const recoveryMatch = Boolean(this.recoveryCode)
          && userRecord.email === this.superadminEmail
          && code === this.recoveryCode;
        if (!resetRow && !recoveryMatch) return rejection();
        this.sql.exec("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(password), userRecord.id);
        this.sql.exec("DELETE FROM password_resets WHERE user_id = ?", userRecord.id);
        this.sql.exec("DELETE FROM sessions WHERE user_id = ?", userRecord.id);
        const user = { id: userRecord.id, email: userRecord.email, display_name: userRecord.display_name, role: userRecord.role };
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
      const isAdmin = user.role === "superadmin";
      if (url.pathname.startsWith("/admin/") && !isAdmin) {
        return this.json(request, 403, { error: "Only the superadmin account can do that." });
      }

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

      if (url.pathname === "/listing" && request.method === "GET") {
        const listing = firstRow(this.sql.exec("SELECT name, tagline, description, updated_at FROM listing WHERE id = 1"));
        const photos = [...this.sql.exec("SELECT id, url, caption, sort_order, created_at FROM photos ORDER BY sort_order, created_at")];
        return this.json(request, 200, { listing, photos });
      }

      if (url.pathname === "/admin/listing" && request.method === "PUT") {
        const body = await this.readJson(request);
        const name = String(body.name ?? "").trim();
        const tagline = String(body.tagline ?? "").trim();
        const description = String(body.description ?? "").trim();
        if (name.length < 2 || name.length > 80) return this.json(request, 400, { error: "Listing name must be between 2 and 80 characters." });
        if (tagline.length > 160) return this.json(request, 400, { error: "Tagline is limited to 160 characters." });
        if (description.length > 2000) return this.json(request, 400, { error: "Description is limited to 2000 characters." });
        this.sql.exec(
          "UPDATE listing SET name = ?, tagline = ?, description = ?, updated_at = ? WHERE id = 1",
          name, tagline, description, new Date().toISOString(),
        );
        this.broadcast("listing");
        return this.json(request, 200, { listing: firstRow(this.sql.exec("SELECT name, tagline, description, updated_at FROM listing WHERE id = 1")) });
      }

      if (url.pathname === "/admin/photos" && request.method === "POST") {
        const body = await this.readJson(request);
        const photoUrl = String(body.url ?? "").trim();
        const caption = String(body.caption ?? "").trim();
        if (!/^https:\/\/.+/.test(photoUrl) || photoUrl.length > 2048) {
          return this.json(request, 400, { error: "Photos need an https:// image URL (up to 2048 characters)." });
        }
        if (caption.length > 200) return this.json(request, 400, { error: "Captions are limited to 200 characters." });
        const nextOrder = (firstRow(this.sql.exec("SELECT max(sort_order) AS top FROM photos"))?.top ?? 0) + 1;
        const photo = { id: crypto.randomUUID(), url: photoUrl, caption, sort_order: nextOrder, created_at: new Date().toISOString() };
        this.sql.exec(
          "INSERT INTO photos (id, url, caption, sort_order, created_at) VALUES (?, ?, ?, ?, ?)",
          photo.id, photo.url, photo.caption, photo.sort_order, photo.created_at,
        );
        this.broadcast("listing");
        return this.json(request, 201, { photo });
      }

      const photoDeletion = url.pathname.match(/^\/admin\/photos\/([a-f0-9-]+)$/);
      if (photoDeletion && request.method === "DELETE") {
        const result = this.sql.exec("DELETE FROM photos WHERE id = ? RETURNING id", photoDeletion[1]);
        if (!firstRow(result)) return this.json(request, 404, { error: "That photo was not found." });
        this.broadcast("listing");
        return this.json(request, 200, { ok: true });
      }

      if (url.pathname === "/admin/reservations" && request.method === "GET") {
        const reservations = [...this.sql.exec(`
          SELECT reservations.id, reservations.user_id, reservations.guest_name, reservations.start_date,
                 reservations.end_date, reservations.status, reservations.payment_status,
                 reservations.created_at, users.email
          FROM reservations JOIN users ON users.id = reservations.user_id
          ORDER BY reservations.start_date DESC, reservations.created_at DESC
        `)];
        return this.json(request, 200, { reservations });
      }

      if (url.pathname === "/admin/users" && request.method === "GET") {
        const users = [...this.sql.exec(`
          SELECT users.id, users.email, users.display_name, users.role, users.created_at,
                 count(reservations.id) AS confirmed_stays
          FROM users LEFT JOIN reservations ON reservations.user_id = users.id AND reservations.status = 'confirmed'
          GROUP BY users.id ORDER BY users.created_at
        `)];
        return this.json(request, 200, { users });
      }

      const userAction = url.pathname.match(/^\/admin\/users\/([a-f0-9-]+)$/);
      if (userAction && request.method === "PATCH") {
        const target = firstRow(this.sql.exec("SELECT id, email, role FROM users WHERE id = ?", userAction[1]));
        if (!target) return this.json(request, 404, { error: "That guest was not found." });
        const body = await this.readJson(request);
        const displayName = String(body.display_name ?? "").trim();
        const email = String(body.email ?? target.email).trim().toLowerCase();
        if (displayName.length < 2 || displayName.length > 60) return this.json(request, 400, { error: "Name must be between 2 and 60 characters." });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return this.json(request, 400, { error: "Enter a valid email address." });
        // Roles are derived from SUPERADMIN_EMAIL at startup, so emails may not
        // cross that boundary in either direction.
        if (target.role === "superadmin" && email !== target.email) {
          return this.json(request, 400, { error: "The superadmin email cannot be changed here." });
        }
        if (target.role !== "superadmin" && email === this.superadminEmail) {
          return this.json(request, 400, { error: "That email is reserved for the superadmin account." });
        }
        try {
          this.ctx.storage.transactionSync(() => {
            this.sql.exec("UPDATE users SET display_name = ?, email = ? WHERE id = ?", displayName, email, target.id);
            this.sql.exec("UPDATE reservations SET guest_name = ? WHERE user_id = ?", displayName, target.id);
          });
        } catch (error) {
          if (String(error).includes("UNIQUE")) return this.json(request, 409, { error: "An account already exists for that email." });
          throw error;
        }
        this.broadcast("reservations");
        return this.json(request, 200, {
          user: firstRow(this.sql.exec("SELECT id, email, display_name, role, created_at FROM users WHERE id = ?", target.id)),
        });
      }

      if (userAction && request.method === "DELETE") {
        const target = firstRow(this.sql.exec("SELECT id, role FROM users WHERE id = ?", userAction[1]));
        if (!target) return this.json(request, 404, { error: "That guest was not found." });
        if (target.role === "superadmin") return this.json(request, 400, { error: "The superadmin account cannot be deleted." });
        this.ctx.storage.transactionSync(() => {
          this.sql.exec("DELETE FROM sessions WHERE user_id = ?", target.id);
          this.sql.exec("DELETE FROM socket_tickets WHERE user_id = ?", target.id);
          this.sql.exec("DELETE FROM password_resets WHERE user_id = ?", target.id);
          this.sql.exec("DELETE FROM messages WHERE thread_user_id = ?", target.id);
          this.sql.exec("DELETE FROM reservations WHERE user_id = ?", target.id);
          this.sql.exec("DELETE FROM users WHERE id = ?", target.id);
        });
        for (const socket of this.ctx.getWebSockets()) {
          try {
            if (socket.deserializeAttachment()?.user_id === target.id) socket.close(1000, "Account removed");
          } catch {}
        }
        this.broadcast("reservations");
        this.broadcast("messages");
        return this.json(request, 200, { ok: true });
      }

      const resetIssue = url.pathname.match(/^\/admin\/users\/([a-f0-9-]+)\/reset-code$/);
      if (resetIssue && request.method === "POST") {
        const target = firstRow(this.sql.exec("SELECT id, email FROM users WHERE id = ?", resetIssue[1]));
        if (!target) return this.json(request, 404, { error: "That guest was not found." });
        const code = randomToken(5);
        const expiresAt = new Date(Date.now() + RESET_CODE_LIFETIME_MS).toISOString();
        this.sql.exec("DELETE FROM password_resets WHERE user_id = ?", target.id);
        this.sql.exec(
          "INSERT INTO password_resets (code_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
          await sha256(code),
          target.id,
          expiresAt,
          new Date().toISOString(),
        );
        return this.json(request, 201, {
          code: `${code.slice(0, 5)}-${code.slice(5)}`.toUpperCase(),
          email: target.email,
          expires_at: expiresAt,
        });
      }

      if (url.pathname === "/admin/payments" && request.method === "GET") {
        // Deliberate stub: payments are out of scope for now. When a provider is
        // wired in, this route plus reservations.payment_status are the hooks.
        return this.json(request, 501, { error: "Payments are not set up yet." });
      }

      if (url.pathname === "/messages" && request.method === "GET") {
        this.sql.exec(
          "UPDATE messages SET read_at = ? WHERE thread_user_id = ? AND sender_role = 'superadmin' AND read_at IS NULL",
          new Date().toISOString(), user.id,
        );
        const messages = [...this.sql.exec(
          "SELECT id, sender_role, body, created_at, read_at FROM messages WHERE thread_user_id = ? ORDER BY created_at",
          user.id,
        )];
        return this.json(request, 200, { messages });
      }

      if (url.pathname === "/messages" && request.method === "POST") {
        if (isAdmin) return this.json(request, 400, { error: "Reply to guests from the admin inbox instead." });
        const body = await this.readJson(request);
        const text = String(body.body ?? "").trim();
        if (!text || text.length > 2000) return this.json(request, 400, { error: "Messages must be between 1 and 2000 characters." });
        const message = { id: crypto.randomUUID(), thread_user_id: user.id, sender_role: "guest", body: text, created_at: new Date().toISOString(), read_at: null };
        this.sql.exec(
          "INSERT INTO messages (id, thread_user_id, sender_role, body, created_at) VALUES (?, ?, 'guest', ?, ?)",
          message.id, message.thread_user_id, message.body, message.created_at,
        );
        this.broadcast("messages");
        return this.json(request, 201, { message });
      }

      if (url.pathname === "/admin/messages" && request.method === "GET") {
        const threads = [...this.sql.exec(`
          SELECT users.id AS user_id, users.display_name, users.email,
            (SELECT body FROM messages WHERE thread_user_id = users.id ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT created_at FROM messages WHERE thread_user_id = users.id ORDER BY created_at DESC LIMIT 1) AS last_message_at,
            (SELECT count(*) FROM messages WHERE thread_user_id = users.id AND sender_role = 'guest' AND read_at IS NULL) AS unread_count
          FROM users WHERE users.role != 'superadmin'
          ORDER BY last_message_at IS NULL, last_message_at DESC, users.created_at
        `)];
        return this.json(request, 200, { threads });
      }

      const adminThread = url.pathname.match(/^\/admin\/messages\/([a-f0-9-]+)$/);
      if (adminThread && request.method === "GET") {
        const guest = firstRow(this.sql.exec("SELECT id, display_name, email FROM users WHERE id = ?", adminThread[1]));
        if (!guest) return this.json(request, 404, { error: "That guest was not found." });
        this.sql.exec(
          "UPDATE messages SET read_at = ? WHERE thread_user_id = ? AND sender_role = 'guest' AND read_at IS NULL",
          new Date().toISOString(), guest.id,
        );
        const messages = [...this.sql.exec(
          "SELECT id, sender_role, body, created_at, read_at FROM messages WHERE thread_user_id = ? ORDER BY created_at",
          guest.id,
        )];
        return this.json(request, 200, { guest, messages });
      }

      if (adminThread && request.method === "POST") {
        const guest = firstRow(this.sql.exec("SELECT id FROM users WHERE id = ? AND role != 'superadmin'", adminThread[1]));
        if (!guest) return this.json(request, 404, { error: "That guest was not found." });
        const body = await this.readJson(request);
        const text = String(body.body ?? "").trim();
        if (!text || text.length > 2000) return this.json(request, 400, { error: "Messages must be between 1 and 2000 characters." });
        const message = { id: crypto.randomUUID(), thread_user_id: guest.id, sender_role: "superadmin", body: text, created_at: new Date().toISOString(), read_at: null };
        this.sql.exec(
          "INSERT INTO messages (id, thread_user_id, sender_role, body, created_at) VALUES (?, ?, 'superadmin', ?, ?)",
          message.id, message.thread_user_id, message.body, message.created_at,
        );
        this.broadcast("messages");
        return this.json(request, 201, { message });
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
        this.broadcast("reservations");
        return this.json(request, 201, { reservation });
      }

      const cancellation = url.pathname.match(/^\/reservations\/([a-f0-9-]+)\/cancel$/);
      if (cancellation && request.method === "PATCH") {
        const result = isAdmin
          ? this.sql.exec(
              "UPDATE reservations SET status = 'cancelled' WHERE id = ? AND status = 'confirmed' RETURNING id",
              cancellation[1],
            )
          : this.sql.exec(`
              UPDATE reservations SET status = 'cancelled'
              WHERE id = ? AND user_id = ? AND status = 'confirmed' AND start_date >= ?
              RETURNING id
            `, cancellation[1], user.id, todayIso());
        if (!firstRow(result)) return this.json(request, 404, { error: "That future reservation was not found." });
        this.broadcast("reservations");
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
