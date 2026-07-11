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
