import type { Reservation } from "./bookings";

export type User = { id: string; email: string; display_name: string };
export type Session = { user: User; token: string; expires_at: string };

const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const sessionStorageKey = "gandy-house-session";

function storedSession() {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(sessionStorageKey);
  if (!value) return null;
  try {
    return JSON.parse(value) as Session;
  } catch {
    window.localStorage.removeItem(sessionStorageKey);
    return null;
  }
}

function saveSession(session: Session | null) {
  if (typeof window === "undefined") return;
  if (session) window.localStorage.setItem(sessionStorageKey, JSON.stringify(session));
  else window.localStorage.removeItem(sessionStorageKey);
}

async function request<T>(path: string, options: RequestInit = {}, requireSession = false) {
  const session = storedSession();
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(requireSession && session ? { authorization: `Bearer ${session.token}` } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) {
    if (response.status === 401) saveSession(null);
    throw new Error(body.error ?? `Request failed with status ${response.status}.`);
  }
  return body;
}

export const api = {
  async restoreSession() {
    const session = storedSession();
    if (!session || session.expires_at <= new Date().toISOString()) {
      saveSession(null);
      return null;
    }
    try {
      const { user } = await request<{ user: User }>("/session", {}, true);
      const restored = { ...session, user };
      saveSession(restored);
      return restored;
    } catch {
      saveSession(null);
      return null;
    }
  },

  async signup(email: string, password: string, displayName: string) {
    const session = await request<Session>("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password, display_name: displayName }),
    });
    saveSession(session);
    return session;
  },

  async login(email: string, password: string) {
    const session = await request<Session>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    saveSession(session);
    return session;
  },

  async logout() {
    try {
      await request("/auth/logout", { method: "POST" }, true);
    } finally {
      saveSession(null);
    }
  },

  async reservations() {
    const body = await request<{ reservations: Reservation[] }>("/reservations", {}, true);
    return body.reservations;
  },

  async book(startDate: string, endDate: string) {
    return request<{ reservation: Reservation }>("/reservations", {
      method: "POST",
      body: JSON.stringify({ start_date: startDate, end_date: endDate }),
    }, true);
  },

  async cancel(reservationId: string) {
    await request(`/reservations/${reservationId}/cancel`, { method: "PATCH" }, true);
  },

  subscribe(onReservationChange: () => void) {
    let stopped = false;
    let retryTimer: number | undefined;
    let socket: WebSocket | undefined;

    async function connect() {
      if (stopped || !storedSession()) return;
      try {
        const { ticket } = await request<{ ticket: string }>("/socket-ticket", { method: "POST" }, true);
        if (stopped) return;
        const socketUrl = `${apiUrl.replace(/^http/, "ws")}/events?ticket=${encodeURIComponent(ticket)}`;
        socket = new WebSocket(socketUrl);
        socket.addEventListener("message", (event) => {
          try {
            const message = JSON.parse(String(event.data)) as { type?: string };
            if (message.type === "reservations") onReservationChange();
          } catch {
            // Ignore malformed messages and keep the live connection open.
          }
        });
        socket.addEventListener("close", () => {
          if (!stopped) retryTimer = window.setTimeout(() => void connect(), 2_000);
        });
        socket.addEventListener("error", () => socket?.close());
      } catch {
        if (!stopped) retryTimer = window.setTimeout(() => void connect(), 2_000);
      }
    }

    void connect();
    return () => {
      stopped = true;
      socket?.close(1000, "Calendar closed");
      clearTimeout(retryTimer);
    };
  },
};
