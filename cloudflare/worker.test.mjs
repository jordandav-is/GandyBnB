import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

const origin = "http://localhost:3000";
const temporaryDirectory = mkdtempSync(join(tmpdir(), "gandy-worker-test-"));
let apiUrl;
let child;

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const socket = createServer();
    socket.on("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      const port = typeof address === "object" && address ? address.port : 0;
      socket.close(() => resolvePort(port));
    });
  });
}

async function api(path, options = {}, token = "") {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      origin,
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = await response.json();
  return { response, body };
}

async function signup(email, displayName) {
  const result = await api("/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, display_name: displayName, password: "family-pass-123" }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body;
}

before(async () => {
  const port = await availablePort();
  apiUrl = `http://127.0.0.1:${port}`;
  const executable = resolve("node_modules/wrangler/bin/wrangler.js");
  child = spawn(process.execPath, [executable, "dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", temporaryDirectory], {
    cwd: resolve("."),
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error("Worker did not start in time.")), 20_000);
    const inspectOutput = (chunk) => {
      const text = String(chunk);
      if (text.includes("Ready on") || text.includes("Listening on")) {
        clearTimeout(timeout);
        resolveReady();
      }
    };
    child.once("error", reject);
    child.stdout.on("data", inspectOutput);
    child.stderr.on("data", inspectOutput);
    child.once("exit", (code) => reject(new Error(`Worker exited before startup with code ${code}.`)));
  });
});

after(async () => {
  if (child && child.exitCode === null && process.platform === "win32") {
    const terminator = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    await new Promise((resolveExit) => terminator.once("exit", resolveExit));
  } else if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("Cloudflare Durable Object booking API", () => {
  it("creates accounts, restores sessions, and rejects bad passwords", async () => {
    const session = await signup("alex@example.com", "Alex");
    assert.equal(session.user.display_name, "Alex");
    assert.ok(session.token.length > 30);

    const restored = await api("/session", {}, session.token);
    assert.equal(restored.response.status, 200);
    assert.equal(restored.body.user.email, "alex@example.com");

    const rejected = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "alex@example.com", password: "not-the-password" }),
    });
    assert.equal(rejected.response.status, 401);
  });

  it("atomically accepts one of two simultaneous overlapping bookings", async () => {
    const first = await signup("first@example.com", "First Guest");
    const second = await signup("second@example.com", "Second Guest");
    const stay = JSON.stringify({ start_date: "2030-07-10", end_date: "2030-07-15" });

    const results = await Promise.all([
      api("/reservations", { method: "POST", body: stay }, first.token),
      api("/reservations", { method: "POST", body: stay }, second.token),
    ]);
    assert.deepEqual(results.map(({ response }) => response.status).sort(), [201, 409]);

    const calendar = await api("/reservations", {}, first.token);
    assert.equal(calendar.body.reservations.length, 1);
    assert.equal(calendar.body.reservations[0].start_date, "2030-07-10");
  });

  it("broadcasts a WebSocket event when availability changes", async () => {
    const session = await signup("listener@example.com", "Listener");
    const ticketResult = await api("/socket-ticket", { method: "POST" }, session.token);
    assert.equal(ticketResult.response.status, 201);
    const socketUrl = `${apiUrl.replace(/^http/, "ws")}/events?ticket=${ticketResult.body.ticket}`;
    const socket = new WebSocket(socketUrl, { headers: { origin } });
    await new Promise((resolveOpen, reject) => {
      socket.addEventListener("open", resolveOpen, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    const changed = new Promise((resolveChanged, reject) => {
      const timeout = setTimeout(() => reject(new Error("Live reservation event timed out.")), 5_000);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "reservations") {
          clearTimeout(timeout);
          resolveChanged(message);
        }
      });
    });
    const booking = await api("/reservations", {
      method: "POST",
      body: JSON.stringify({ start_date: "2030-08-01", end_date: "2030-08-04" }),
    }, session.token);
    assert.equal(booking.response.status, 201);
    await changed;
    socket.close();
  });
});

describe("Superadmin account controls", () => {
  let admin;
  let guest;

  before(async () => {
    admin = await signup("jordan@jordandav.is", "Jordan");
    guest = await signup("gale@example.com", "Gale");
  });

  it("grants the superadmin role only to the configured email", () => {
    assert.equal(admin.user.role, "superadmin");
    assert.equal(guest.user.role, "member");
  });

  it("locks admin endpoints to the superadmin account", async () => {
    const forbidden = await api("/admin/reservations", {}, guest.token);
    assert.equal(forbidden.response.status, 403);
    const allowed = await api("/admin/reservations", {}, admin.token);
    assert.equal(allowed.response.status, 200);
  });

  it("lets the superadmin see and cancel any guest booking", async () => {
    const booking = await api("/reservations", {
      method: "POST",
      body: JSON.stringify({ start_date: "2031-06-01", end_date: "2031-06-05" }),
    }, guest.token);
    assert.equal(booking.response.status, 201);

    const overview = await api("/admin/reservations", {}, admin.token);
    const row = overview.body.reservations.find((entry) => entry.id === booking.body.reservation.id);
    assert.ok(row, "admin overview should include the guest booking");
    assert.equal(row.email, "gale@example.com");
    assert.equal(row.payment_status, "not_required");

    const cancelled = await api(`/reservations/${booking.body.reservation.id}/cancel`, { method: "PATCH" }, admin.token);
    assert.equal(cancelled.response.status, 200);
    const calendar = await api("/reservations", {}, guest.token);
    assert.ok(!calendar.body.reservations.some((entry) => entry.id === booking.body.reservation.id));
  });

  it("lets the superadmin update the listing and manage photos", async () => {
    const rejected = await api("/admin/listing", {
      method: "PUT",
      body: JSON.stringify({ name: "Gandy House II", tagline: "Updated tagline.", description: "Fresh paint, same porch." }),
    }, guest.token);
    assert.equal(rejected.response.status, 403);

    const updated = await api("/admin/listing", {
      method: "PUT",
      body: JSON.stringify({ name: "Gandy House II", tagline: "Updated tagline.", description: "Fresh paint, same porch." }),
    }, admin.token);
    assert.equal(updated.response.status, 200, JSON.stringify(updated.body));

    const photo = await api("/admin/photos", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com/porch.jpg", caption: "The porch" }),
    }, admin.token);
    assert.equal(photo.response.status, 201);

    const seen = await api("/listing", {}, guest.token);
    assert.equal(seen.body.listing.name, "Gandy House II");
    assert.equal(seen.body.photos.length, 1);

    const removed = await api(`/admin/photos/${photo.body.photo.id}`, { method: "DELETE" }, admin.token);
    assert.equal(removed.response.status, 200);
  });

  it("carries messages between a guest and the superadmin inbox", async () => {
    const sent = await api("/messages", {
      method: "POST",
      body: JSON.stringify({ body: "Is the outdoor shower working?" }),
    }, guest.token);
    assert.equal(sent.response.status, 201);

    const inbox = await api("/admin/messages", {}, admin.token);
    const thread = inbox.body.threads.find((entry) => entry.user_id === guest.user.id);
    assert.ok(thread, "admin inbox should list the guest thread");
    assert.equal(thread.unread_count, 1);

    const reply = await api(`/admin/messages/${guest.user.id}`, {
      method: "POST",
      body: JSON.stringify({ body: "Yep — fixed it last weekend." }),
    }, admin.token);
    assert.equal(reply.response.status, 201);

    const conversation = await api("/messages", {}, guest.token);
    assert.deepEqual(conversation.body.messages.map((message) => message.sender_role), ["guest", "superadmin"]);
  });

  it("keeps payments unimplemented behind a stub", async () => {
    const stub = await api("/admin/payments", {}, admin.token);
    assert.equal(stub.response.status, 501);
  });

  it("resets a password with an admin-issued one-time code", async () => {
    const denied = await api(`/admin/users/${guest.user.id}/reset-code`, { method: "POST" }, guest.token);
    assert.equal(denied.response.status, 403);

    const issued = await api(`/admin/users/${guest.user.id}/reset-code`, { method: "POST" }, admin.token);
    assert.equal(issued.response.status, 201, JSON.stringify(issued.body));
    assert.match(issued.body.code, /^[A-F0-9]{5}-[A-F0-9]{5}$/);

    const wrongCode = await api("/auth/reset", {
      method: "POST",
      body: JSON.stringify({ email: "gale@example.com", code: "AAAAA-AAAAA", password: "brand-new-pass-456" }),
    });
    assert.equal(wrongCode.response.status, 401);

    const reset = await api("/auth/reset", {
      method: "POST",
      body: JSON.stringify({ email: "gale@example.com", code: issued.body.code, password: "brand-new-pass-456" }),
    });
    assert.equal(reset.response.status, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.user.role, "member");

    const oldSession = await api("/session", {}, guest.token);
    assert.equal(oldSession.response.status, 401, "previous sessions should be revoked");
    const newSession = await api("/session", {}, reset.body.token);
    assert.equal(newSession.response.status, 200);

    const reuse = await api("/auth/reset", {
      method: "POST",
      body: JSON.stringify({ email: "gale@example.com", code: issued.body.code, password: "yet-another-pass-789" }),
    });
    assert.equal(reuse.response.status, 401, "codes should be single-use");
    guest = { ...guest, token: reset.body.token };
  });

  it("lets the superadmin edit a guest and keeps reservations in sync", async () => {
    const denied = await api(`/admin/users/${guest.user.id}`, {
      method: "PATCH",
      body: JSON.stringify({ display_name: "Gale Gandy", email: "gale@example.com" }),
    }, guest.token);
    assert.equal(denied.response.status, 403);

    const booking = await api("/reservations", {
      method: "POST",
      body: JSON.stringify({ start_date: "2032-05-01", end_date: "2032-05-04" }),
    }, guest.token);
    assert.equal(booking.response.status, 201);

    const reserved = await api(`/admin/users/${guest.user.id}`, {
      method: "PATCH",
      body: JSON.stringify({ display_name: "Gale Gandy", email: "jordan@jordandav.is" }),
    }, admin.token);
    assert.equal(reserved.response.status, 400, "guests cannot take the superadmin email");

    const updated = await api(`/admin/users/${guest.user.id}`, {
      method: "PATCH",
      body: JSON.stringify({ display_name: "Gale Gandy", email: "gale.gandy@example.com" }),
    }, admin.token);
    assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.user.display_name, "Gale Gandy");
    assert.equal(updated.body.user.email, "gale.gandy@example.com");

    const calendar = await api("/reservations", {}, guest.token);
    const row = calendar.body.reservations.find((entry) => entry.id === booking.body.reservation.id);
    assert.equal(row.guest_name, "Gale Gandy", "reservations should carry the new name");

    const adminRename = await api(`/admin/users/${admin.user.id}`, {
      method: "PATCH",
      body: JSON.stringify({ display_name: "Jordan Davis", email: "someone-else@example.com" }),
    }, admin.token);
    assert.equal(adminRename.response.status, 400, "the superadmin email is locked");
  });

  it("lets the superadmin delete a guest but never the superadmin account", async () => {
    const protectedAccount = await api(`/admin/users/${admin.user.id}`, { method: "DELETE" }, admin.token);
    assert.equal(protectedAccount.response.status, 400);

    const removed = await api(`/admin/users/${guest.user.id}`, { method: "DELETE" }, admin.token);
    assert.equal(removed.response.status, 200, JSON.stringify(removed.body));

    const goneSession = await api("/session", {}, guest.token);
    assert.equal(goneSession.response.status, 401, "deleted accounts lose their sessions");

    const overview = await api("/admin/reservations", {}, admin.token);
    assert.ok(!overview.body.reservations.some((entry) => entry.user_id === guest.user.id), "their reservations should be gone");

    const again = await api(`/admin/users/${guest.user.id}`, { method: "DELETE" }, admin.token);
    assert.equal(again.response.status, 404);
  });
});
