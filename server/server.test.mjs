import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

const origin = "http://localhost:3000";
const temporaryDirectory = mkdtempSync(join(tmpdir(), "gandybnb-test-"));
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
  assert.equal(result.response.status, 201);
  return result.body;
}

before(async () => {
  const port = await availablePort();
  apiUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", resolve("server/server.mjs")], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: join(temporaryDirectory, "test.sqlite"),
      ALLOWED_ORIGINS: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error("API did not start in time.")), 5_000);
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("API listening")) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    child.stderr.on("data", (chunk) => {
      if (String(chunk).includes("Error")) reject(new Error(String(chunk)));
    });
  });
});

after(async () => {
  if (child && !child.killed) {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("home-rolled booking API", () => {
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

  it("atomically allows only one of two simultaneous overlapping bookings", async () => {
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

  it("broadcasts a live event when availability changes", async () => {
    const session = await signup("listener@example.com", "Listener");
    const controller = new AbortController();
    const streamResponse = await fetch(`${apiUrl}/events`, {
      headers: { origin, authorization: `Bearer ${session.token}` },
      signal: controller.signal,
    });
    assert.equal(streamResponse.status, 200);
    const reader = streamResponse.body.getReader();
    const decoder = new TextDecoder();
    await reader.read();

    const booking = await api("/reservations", {
      method: "POST",
      body: JSON.stringify({ start_date: "2030-08-01", end_date: "2030-08-04" }),
    }, session.token);
    assert.equal(booking.response.status, 201);

    const event = decoder.decode((await reader.read()).value);
    assert.match(event, /event: reservations/);
    controller.abort();
  });
});
