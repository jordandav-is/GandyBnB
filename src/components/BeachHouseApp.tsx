"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  Camera,
  Check,
  LogOut,
  MessageCircle,
  Radio,
  Send,
  Shell,
  Shield,
  Sparkles,
  Umbrella,
  Users,
  Waves,
  X,
} from "@/components/Icons";
import AdminPanel from "@/components/AdminPanel";
import { api, type Listing, type Message, type Photo, type Session } from "@/lib/api";
import { datesOverlap, formatStayDate, nightsBetween, stayDay, todayIso, type Reservation, validateStay } from "@/lib/bookings";

type Notice = { tone: "success" | "error" | "info"; text: string } | null;

// Pisces Drive, Santa Rosa Beach FL — Open-Meteo is free and needs no API key.
const HOUSE_LATITUDE = 30.373;
const HOUSE_LONGITUDE = -86.258;
const WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${HOUSE_LATITUDE}&longitude=${HOUSE_LONGITUDE}`
  + "&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max&forecast_days=1"
  + "&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FChicago";

const WEATHER_LABELS: [codes: number[], label: string][] = [
  [[0], "Clear skies"],
  [[1], "Mostly sunny"],
  [[2], "Partly cloudy"],
  [[3], "Overcast"],
  [[45, 48], "Foggy"],
  [[51, 53, 55, 56, 57], "Drizzle"],
  [[61, 63, 66], "Rain"],
  [[65, 67], "Heavy rain"],
  [[71, 73, 75, 77, 85, 86], "Snow (!)"],
  [[80, 81], "Passing showers"],
  [[82], "Heavy showers"],
  [[95, 96, 99], "Thunderstorms"],
];

type Weather = { temperature: number; high: number; wind: number; label: string };

function useHouseWeather() {
  const [weather, setWeather] = useState<Weather | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(WEATHER_URL);
        if (!response.ok) return;
        const data = await response.json() as {
          current?: { temperature_2m?: number; weather_code?: number; wind_speed_10m?: number };
          daily?: { temperature_2m_max?: number[] };
        };
        const temperature = data.current?.temperature_2m;
        if (cancelled || typeof temperature !== "number") return;
        const code = data.current?.weather_code ?? -1;
        setWeather({
          temperature: Math.round(temperature),
          high: Math.round(data.daily?.temperature_2m_max?.[0] ?? temperature),
          wind: Math.round(data.current?.wind_speed_10m ?? 0),
          label: WEATHER_LABELS.find(([codes]) => codes.includes(code))?.[1] ?? "Beach weather",
        });
      } catch {
        // The hero card falls back to its house-mood copy without live weather.
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 30 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return weather;
}

export default function BeachHouseApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loadingCalendar, setLoadingCalendar] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [liveTick, setLiveTick] = useState(0);
  const [messagesTick, setMessagesTick] = useState(0);

  const loadReservations = useCallback(async () => {
    setLoadingCalendar(true);
    try {
      setReservations(await api.reservations());
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The calendar could not be loaded." });
    } finally {
      setLoadingCalendar(false);
    }
  }, []);

  const loadListing = useCallback(async () => {
    try {
      const { listing: current, photos: gallery } = await api.listing();
      setListing(current);
      setPhotos(gallery);
    } catch {
      // The hero copy falls back to defaults if the listing cannot load.
    }
  }, []);

  useEffect(() => {
    api.restoreSession().then((restored) => {
      setSession(restored);
      setAuthReady(true);
    });
  }, []);

  useEffect(() => {
    if (!session) return;
    queueMicrotask(() => {
      void loadReservations();
      void loadListing();
    });
    return api.subscribe((event) => {
      setLiveTick((tick) => tick + 1);
      if (event === "reservations") void loadReservations();
      if (event === "listing") void loadListing();
      if (event === "messages") setMessagesTick((tick) => tick + 1);
    });
  }, [session, loadReservations, loadListing]);

  if (!authReady) return <LoadingScreen />;
  if (!session) return <AuthScreen notice={notice} setNotice={setNotice} setSession={setSession} />;

  return (
    <BookingDashboard
      session={session}
      reservations={reservations}
      listing={listing}
      photos={photos}
      loadingCalendar={loadingCalendar}
      notice={notice}
      setNotice={setNotice}
      refresh={loadReservations}
      liveTick={liveTick}
      messagesTick={messagesTick}
      onLogout={async () => {
        await api.logout();
        setSession(null);
        setReservations([]);
      }}
    />
  );
}

function LoadingScreen() {
  return (
    <main className="loading-screen" aria-live="polite">
      <Waves aria-hidden="true" />
      <p>Checking the tide chart…</p>
    </main>
  );
}


function AuthScreen({ notice, setNotice, setSession }: { notice: Notice; setNotice: (value: Notice) => void; setSession: (value: Session) => void }) {
  const [mode, setMode] = useState<"login" | "signup" | "reset">("login");
  const [working, setWorking] = useState(false);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true);
    setNotice(null);
    const values = new FormData(event.currentTarget);
    const email = String(values.get("email") ?? "").trim();
    const password = String(values.get("password") ?? "");
    const displayName = String(values.get("displayName") ?? "").trim();
    const resetCode = String(values.get("resetCode") ?? "").trim();
    try {
      const nextSession = mode === "signup"
        ? await api.signup(email, password, displayName)
        : mode === "reset"
          ? await api.resetPassword(email, resetCode, password)
          : await api.login(email, password);
      setSession(nextSession);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Sign-in failed." });
    } finally {
      setWorking(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-story">
        <div className="brand-mark"><Shell aria-hidden="true" /><span>Gandy House</span></div>
        <div className="story-copy">
          <span className="eyebrow light">Hold your place by the water</span>
          <h1>Same porch.<br />New stories.</h1>
          <p>One beach house, one family calendar, and no crossed wires in the group chat.</p>
        </div>
        <div className="story-stamp"><Waves /><span>Est. in sandy feet</span></div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <span className="eyebrow">The family guestbook</span>
          <h2>{mode === "login" ? "Welcome back, beachcomber." : mode === "reset" ? "Lost the house key?" : "Pull up a porch chair."}</h2>
          <p>{mode === "login" ? "Sign in to see who has the keys next." : mode === "reset" ? "Enter the one-time reset code from Jordan and pick a new password." : "Create your account to reserve a stay."}</p>
          <div className="segmented" aria-label="Authentication mode">
            <button className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setNotice(null); }}>Sign in</button>
            <button className={mode === "signup" ? "active" : ""} onClick={() => { setMode("signup"); setNotice(null); }}>Join the family</button>
          </div>
          <form onSubmit={submitAuth}>
            {mode === "signup" && <label>Your name<input name="displayName" minLength={2} maxLength={60} required autoComplete="name" /></label>}
            <label>Email address<input name="email" type="email" required autoComplete="email" /></label>
            {mode === "reset" && <label>Reset code<input name="resetCode" required autoComplete="one-time-code" placeholder="XXXXX-XXXXX" /></label>}
            <label>{mode === "reset" ? "New password" : "Password"}<input name="password" type="password" minLength={10} required autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
            <button className="primary-button" disabled={working} type="submit">
              {working ? "Just a sec…" : mode === "login" ? "Open the calendar" : mode === "reset" ? "Set new password" : "Create my account"}<ArrowRight />
            </button>
          </form>
          {mode !== "signup" && (
            <button className="forgot-link" onClick={() => { setMode(mode === "reset" ? "login" : "reset"); setNotice(null); }}>
              {mode === "reset" ? "Back to sign in" : "Forgot your password?"}
            </button>
          )}
          <NoticeBanner notice={notice} />
          <p className="privacy-note">{mode === "reset" ? "No code yet? Message or call Jordan — reset codes are handed out personally and expire after an hour." : "Private to invited family & friends. Please don’t reuse an important password."}</p>
        </div>
      </section>
    </main>
  );
}

function BookingDashboard({
  session,
  reservations,
  listing,
  photos,
  loadingCalendar,
  notice,
  setNotice,
  refresh,
  liveTick,
  messagesTick,
  onLogout,
}: {
  session: Session;
  reservations: Reservation[];
  listing: Listing | null;
  photos: Photo[];
  loadingCalendar: boolean;
  notice: Notice;
  setNotice: (value: Notice) => void;
  refresh: () => Promise<void>;
  liveTick: number;
  messagesTick: number;
  onLogout: () => Promise<void>;
}) {
  const today = todayIso();
  const isAdmin = session.user.role === "superadmin";
  const [adminView, setAdminView] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [booking, setBooking] = useState(false);
  const name = session.user.display_name;
  const nights = nightsBetween(start, end);
  const localConflict = reservations.find((reservation) => start && end && datesOverlap(start, end, reservation));
  const upcoming = useMemo(
    () => reservations.filter((reservation) => reservation.end_date >= today),
    [reservations, today],
  );

  async function bookStay(event: FormEvent) {
    event.preventDefault();
    const validation = validateStay(start, end);
    if (validation) {
      setNotice({ tone: "error", text: validation });
      return;
    }
    if (localConflict) {
      setNotice({ tone: "error", text: "Those nights are already spoken for." });
      return;
    }
    setBooking(true);
    setNotice(null);
    try {
      await api.book(start, end);
      setNotice({ tone: "success", text: `${nights} ${nights === 1 ? "night" : "nights"} saved. Start packing the sunscreen.` });
      setStart("");
      setEnd("");
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "The reservation could not be saved.";
      setNotice({ tone: "error", text: message.toLowerCase().includes("booked") ? "Someone just booked those dates. The calendar has been refreshed." : message });
      await refresh();
    } finally {
      setBooking(false);
    }
  }

  async function cancelStay(id: string) {
    setNotice(null);
    try {
      await api.cancel(id);
      setNotice({ tone: "info", text: "Stay cancelled. Those dates are open again." });
      await refresh();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The stay could not be cancelled." });
    }
  }

  const weather = useHouseWeather();
  const houseName = listing?.name ?? "Gandy House";
  const [taglineLead, ...taglineRest] = (listing?.tagline ?? "Come for the tide. Stay for the porch.").split(/(?<=\.)\s+/);

  return (
    <main className="dashboard-shell">
      <header className="site-header">
        <a className="brand-mark dark" href="#top"><Shell /><span>{houseName}</span></a>
        <div className="live-pill"><Radio /> Live calendar</div>
        <div className="user-menu">
          <span>Ahoy, {name}</span>
          {isAdmin && (
            <button
              className={`admin-toggle ${adminView ? "active" : ""}`}
              aria-pressed={adminView}
              onClick={() => setAdminView((value) => !value)}
            >
              <Shield /> {adminView ? "Guest view" : "Admin"}
            </button>
          )}
          <button aria-label="Sign out" onClick={() => void onLogout()}><LogOut /></button>
        </div>
      </header>

      {isAdmin && adminView ? <AdminPanel refreshKey={liveTick} /> : (
      <>
      <section className="hero" id="top">
        <div className="hero-copy">
          <span className="eyebrow light">Your family’s place at the edge of the world</span>
          <h1>{taglineLead}{taglineRest.length > 0 && <><br /><em>{taglineRest.join(" ")}</em></>}</h1>
          <p>{listing?.description ?? "A weathered little house where the coffee is strong, the rules are few, and every sunset earns an audience."}</p>
          <a href="#book" className="text-link">Find your week <ArrowRight /></a>
        </div>
        <div className="hero-card">
          <span>{weather ? "Now in Santa Rosa Beach" : "Today at the house"}</span>
          <strong>{weather ? `${weather.temperature}°` : "· · ·"}</strong>
          <small>{weather ? `${weather.label} · Wind ${weather.wind} mph · High ${weather.high}°` : "Salt air · Porch breeze · Barefoot"}</small>
        </div>
        <div className="sun-disc" aria-hidden="true" />
      </section>

      <section className="booking-section" id="book">
        <div className="section-heading">
          <div><span className="eyebrow">Claim your patch of summer</span><h2>When are you coming down?</h2></div>
          <div className="realtime-note"><Radio /><span><strong>Live availability</strong>Changes appear for everyone instantly.</span></div>
        </div>
        <div className="booking-grid">
          <form className="booking-card" onSubmit={bookStay}>
            <div className="date-fields">
              <label><span>Check in</span><input aria-label="Check in" type="date" min={today} value={start} onChange={(event) => { setStart(event.target.value); if (end && event.target.value >= end) setEnd(""); }} required /></label>
              <ArrowRight aria-hidden="true" />
              <label><span>Check out</span><input aria-label="Check out" type="date" min={start || today} value={end} onChange={(event) => setEnd(event.target.value)} required /></label>
            </div>
            <div className="stay-summary">
              <span><CalendarDays /> {nights ? `${nights} ${nights === 1 ? "night" : "nights"}` : "Choose your dates"}</span>
              <span><Users /> Family & friends</span>
            </div>
            {localConflict && <p className="inline-conflict"><X /> Overlaps {localConflict.guest_name}’s stay.</p>}
            <button className="primary-button coral" disabled={booking || Boolean(localConflict)} type="submit">
              {booking ? "Checking the calendar…" : "Reserve these dates"}<ArrowRight />
            </button>
            <p className="fine-print"><Check /> The database checks again atomically before confirming—two people can’t claim the same night.</p>
            <NoticeBanner notice={notice} />
          </form>

          <div className="calendar-card">
            <div className="calendar-title"><div><span className="eyebrow">The porch ledger</span><h3>Upcoming stays</h3></div><span>{upcoming.length} booked</span></div>
            <AvailabilityCalendar reservations={reservations} />
            {loadingCalendar ? <p className="empty-state">Refreshing the tide chart…</p> : upcoming.length === 0 ? (
              <div className="empty-state"><Umbrella /><strong>Wide-open calendar.</strong><span>Be the first to put a week on the books.</span></div>
            ) : (
              <div className="reservation-list">
                {upcoming.map((reservation) => {
                  const own = reservation.user_id === session.user.id;
                  return (
                    <article className="reservation-row" key={reservation.id}>
                      <div className="date-badge"><strong>{stayDay(reservation.start_date)}</strong><span>{formatStayDate(reservation.start_date, false)}</span></div>
                      <div className="reservation-details"><strong>{reservation.guest_name}</strong><span>{formatStayDate(reservation.start_date)} → {formatStayDate(reservation.end_date)} · {nightsBetween(reservation.start_date, reservation.end_date)} nights</span></div>
                      {own ? <button className="cancel-button" onClick={() => void cancelStay(reservation.id)}>Cancel</button> : <span className="booked-tag">Booked</span>}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>

      {photos.length > 0 && (
        <section className="gallery-section">
          <div className="section-heading">
            <div><span className="eyebrow"><Camera /> Around the house</span><h2>Postcards from the porch</h2></div>
          </div>
          <div className="photo-grid guest">
            {photos.map((photo) => (
              <figure key={photo.id}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo.url} alt={photo.caption || "House photo"} loading="lazy" />
                {photo.caption && <figcaption><span>{photo.caption}</span></figcaption>}
              </figure>
            ))}
          </div>
        </section>
      )}

      {!isAdmin && <GuestMessages messagesTick={messagesTick} />}

      <section className="house-rules">
        <div><Sparkles /><span>House note № 1</span><strong>Leave some ice in the freezer.</strong></div>
        <div><Waves /><span>House note № 2</span><strong>Never miss a sunset on purpose.</strong></div>
        <div><Shell /><span>House note № 3</span><strong>Sand in the car is inevitable.</strong></div>
      </section>

      <footer><div className="brand-mark dark"><Shell /><span>{houseName}</span></div><p>Made for the people we’d share the last porch chair with.</p><span>One house · One calendar · Zero double-bookings</span></footer>
      </>
      )}
    </main>
  );
}

const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

function AvailabilityCalendar({ reservations }: { reservations: Reservation[] }) {
  const [monthOffset, setMonthOffset] = useState(0);
  const today = todayIso();
  const [todayYear, todayMonth] = today.split("-").map(Number);
  const month = new Date(Date.UTC(todayYear, todayMonth - 1 + monthOffset, 1));
  const monthLabel = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(month);
  const daysInMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();

  const days = Array.from({ length: daysInMonth }, (_, index) => {
    const iso = `${month.toISOString().slice(0, 8)}${String(index + 1).padStart(2, "0")}`;
    const stay = reservations.find((reservation) =>
      reservation.status === "confirmed" && reservation.start_date <= iso && iso < reservation.end_date);
    return { iso, day: index + 1, stay };
  });

  return (
    <div className="availability" aria-label="Availability calendar">
      <div className="availability-head">
        <strong>{monthLabel}</strong>
        <div className="availability-nav">
          <button aria-label="Previous month" disabled={monthOffset === 0} onClick={() => setMonthOffset((value) => value - 1)}>←</button>
          <button aria-label="Next month" onClick={() => setMonthOffset((value) => value + 1)}>→</button>
        </div>
      </div>
      <div className="cal-grid">
        {WEEKDAY_LETTERS.map((letter, index) => <span key={index} className="dow" aria-hidden="true">{letter}</span>)}
        {Array.from({ length: month.getUTCDay() }, (_, index) => <span key={`pad-${index}`} />)}
        {days.map(({ iso, day, stay }) => (
          <span
            key={iso}
            className={`cal-day ${stay ? "booked" : "open"} ${iso < today ? "past" : ""} ${iso === today ? "today" : ""}`}
            title={stay ? `Booked · ${stay.guest_name}` : iso < today ? undefined : "Available"}
          >
            {day}
          </span>
        ))}
      </div>
      <div className="cal-legend">
        <span><i className="open" /> Available</span>
        <span><i className="booked" /> Booked</span>
        <span><i className="today" /> Today</span>
      </div>
    </div>
  );
}

function GuestMessages({ messagesTick }: { messagesTick: number }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMessages(await api.myMessages());
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Messages could not be loaded.");
    }
  }, []);

  useEffect(() => { queueMicrotask(() => void load()); }, [load, messagesTick]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    setSending(true);
    try {
      await api.sendMessage(draft.trim());
      setDraft("");
      await load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The message could not be sent.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="guest-messages">
      <div className="section-heading">
        <div><span className="eyebrow"><MessageCircle /> House line</span><h2>Message the host</h2></div>
      </div>
      <div className="admin-card">
        <div className="chat-scroll">
          {messages.length === 0 ? (
            <p className="admin-empty">Questions about your stay? Drop a note and Jordan will get back to you.</p>
          ) : messages.map((message) => (
            <p key={message.id} className={`chat-bubble ${message.sender_role === "guest" ? "mine" : ""}`}>
              {message.body}
              <time>{new Date(message.created_at).toLocaleString()}</time>
            </p>
          ))}
        </div>
        <form className="chat-compose" onSubmit={send}>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask about the house, the keys, the tides…"
            maxLength={2000}
            aria-label="Message the host"
          />
          <button className="primary-button coral" disabled={sending || !draft.trim()} type="submit" aria-label="Send message"><Send /></button>
        </form>
        {failure && <div className="notice error" role="status"><X />{failure}</div>}
      </div>
    </section>
  );
}

function NoticeBanner({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return <div className={`notice ${notice.tone}`} role="status">{notice.tone === "success" ? <Check /> : notice.tone === "error" ? <X /> : <Waves />}{notice.text}</div>;
}
