import type { Reservation } from "./bookings";

export type User = { id: string; email: string; display_name: string; role: "member" | "superadmin" };
export type Session = { user: User; token: string; expires_at: string };
export type Listing = { name: string; tagline: string; description: string; updated_at: string };
export type Photo = { id: string; url: string; caption: string; sort_order: number; created_at: string };
export type Message = { id: string; sender_role: "guest" | "superadmin"; body: string; created_at: string; read_at: string | null };
export type MessageThread = {
  user_id: string;
  display_name: string;
  email: string;
  last_message: string | null;
  last_message_at: string | null;
  unread_count: number;
};
export type AdminReservation = Reservation & { email: string; payment_status: string };
export type Guest = { id: string; email: string; display_name: string; role: string; created_at: string; confirmed_stays: number };
export type LiveEvent = "reservations" | "listing" | "messages";

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

  async resetPassword(email: string, code: string, password: string) {
    const session = await request<Session>("/auth/reset", {
      method: "POST",
      body: JSON.stringify({ email, code, password }),
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

  async listing() {
    return request<{ listing: Listing; photos: Photo[] }>("/listing", {}, true);
  },

  async myMessages() {
    const body = await request<{ messages: Message[] }>("/messages", {}, true);
    return body.messages;
  },

  async sendMessage(text: string) {
    return request<{ message: Message }>("/messages", { method: "POST", body: JSON.stringify({ body: text }) }, true);
  },

  admin: {
    async reservations() {
      const body = await request<{ reservations: AdminReservation[] }>("/admin/reservations", {}, true);
      return body.reservations;
    },

    async users() {
      const body = await request<{ users: Guest[] }>("/admin/users", {}, true);
      return body.users;
    },

    async updateUser(userId: string, changes: { display_name: string; email: string }) {
      return request<{ user: Guest }>(`/admin/users/${userId}`, { method: "PATCH", body: JSON.stringify(changes) }, true);
    },

    async deleteUser(userId: string) {
      await request(`/admin/users/${userId}`, { method: "DELETE" }, true);
    },

    async updateListing(listing: Pick<Listing, "name" | "tagline" | "description">) {
      return request<{ listing: Listing }>("/admin/listing", { method: "PUT", body: JSON.stringify(listing) }, true);
    },

    async addPhoto(url: string, caption: string) {
      return request<{ photo: Photo }>("/admin/photos", { method: "POST", body: JSON.stringify({ url, caption }) }, true);
    },

    async deletePhoto(photoId: string) {
      await request(`/admin/photos/${photoId}`, { method: "DELETE" }, true);
    },

    async issueResetCode(userId: string) {
      return request<{ code: string; email: string; expires_at: string }>(`/admin/users/${userId}/reset-code`, { method: "POST" }, true);
    },

    async threads() {
      const body = await request<{ threads: MessageThread[] }>("/admin/messages", {}, true);
      return body.threads;
    },

    async thread(userId: string) {
      return request<{ guest: { id: string; display_name: string; email: string }; messages: Message[] }>(`/admin/messages/${userId}`, {}, true);
    },

    async reply(userId: string, text: string) {
      return request<{ message: Message }>(`/admin/messages/${userId}`, { method: "POST", body: JSON.stringify({ body: text }) }, true);
    },
  },

  subscribe(onLiveEvent: (event: LiveEvent) => void) {
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
            if (message.type === "reservations" || message.type === "listing" || message.type === "messages") {
              onLiveEvent(message.type);
            }
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
