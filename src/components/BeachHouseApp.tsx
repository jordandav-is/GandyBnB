"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  Check,
  LogOut,
  Radio,
  Shell,
  Sparkles,
  Umbrella,
  Users,
  Waves,
  X,
} from "@/components/Icons";
import { api, type Session } from "@/lib/api";
import { datesOverlap, formatStayDate, nightsBetween, stayDay, todayIso, type Reservation, validateStay } from "@/lib/bookings";

type Notice = { tone: "success" | "error" | "info"; text: string } | null;

export default function BeachHouseApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loadingCalendar, setLoadingCalendar] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

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

  useEffect(() => {
    api.restoreSession().then((restored) => {
      setSession(restored);
      setAuthReady(true);
    });
  }, []);

  useEffect(() => {
    if (!session) return;
    queueMicrotask(() => void loadReservations());
    return api.subscribe(() => void loadReservations());
  }, [session, loadReservations]);

  if (!authReady) return <LoadingScreen />;
  if (!session) return <AuthScreen notice={notice} setNotice={setNotice} setSession={setSession} />;

  return (
    <BookingDashboard
      session={session}
      reservations={reservations}
      loadingCalendar={loadingCalendar}
      notice={notice}
      setNotice={setNotice}
      refresh={loadReservations}
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
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [working, setWorking] = useState(false);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true);
    setNotice(null);
    const values = new FormData(event.currentTarget);
    const email = String(values.get("email") ?? "").trim();
    const password = String(values.get("password") ?? "");
    const displayName = String(values.get("displayName") ?? "").trim();
    try {
      const nextSession = mode === "signup"
        ? await api.signup(email, password, displayName)
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
          <h2>{mode === "login" ? "Welcome back, beachcomber." : "Pull up a porch chair."}</h2>
          <p>{mode === "login" ? "Sign in to see who has the keys next." : "Create your account to reserve a stay."}</p>
          <div className="segmented" aria-label="Authentication mode">
            <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Sign in</button>
            <button className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>Join the family</button>
          </div>
          <form onSubmit={submitAuth}>
            {mode === "signup" && <label>Your name<input name="displayName" minLength={2} maxLength={60} required autoComplete="name" /></label>}
            <label>Email address<input name="email" type="email" required autoComplete="email" /></label>
            <label>Password<input name="password" type="password" minLength={10} required autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
            <button className="primary-button" disabled={working} type="submit">
              {working ? "Just a sec…" : mode === "login" ? "Open the calendar" : "Create my account"}<ArrowRight />
            </button>
          </form>
          <NoticeBanner notice={notice} />
          <p className="privacy-note">Private to invited family members. Please don’t reuse an important password.</p>
        </div>
      </section>
    </main>
  );
}

function BookingDashboard({
  session,
  reservations,
  loadingCalendar,
  notice,
  setNotice,
  refresh,
  onLogout,
}: {
  session: Session;
  reservations: Reservation[];
  loadingCalendar: boolean;
  notice: Notice;
  setNotice: (value: Notice) => void;
  refresh: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const today = todayIso();
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

  return (
    <main className="dashboard-shell">
      <header className="site-header">
        <a className="brand-mark dark" href="#top"><Shell /><span>Gandy House</span></a>
        <div className="live-pill"><Radio /> Live calendar</div>
        <div className="user-menu"><span>Ahoy, {name}</span><button aria-label="Sign out" onClick={() => void onLogout()}><LogOut /></button></div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <span className="eyebrow light">Your family’s place at the edge of the world</span>
          <h1>Come for the tide.<br /><em>Stay for the porch.</em></h1>
          <p>A weathered little house where the coffee is strong, the rules are few, and every sunset earns an audience.</p>
          <a href="#book" className="text-link">Find your week <ArrowRight /></a>
        </div>
        <div className="hero-card"><span>Today at the house</span><strong>72°</strong><small>Salt air · Porch breeze · Barefoot</small></div>
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

      <section className="house-rules">
        <div><Sparkles /><span>House note № 1</span><strong>Leave some ice in the freezer.</strong></div>
        <div><Waves /><span>House note № 2</span><strong>Never miss a sunset on purpose.</strong></div>
        <div><Shell /><span>House note № 3</span><strong>Sand in the car is inevitable.</strong></div>
      </section>

      <footer><div className="brand-mark dark"><Shell /><span>Gandy House</span></div><p>Made for the people we’d share the last porch chair with.</p><span>One house · One calendar · Zero double-bookings</span></footer>
    </main>
  );
}

function NoticeBanner({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return <div className={`notice ${notice.tone}`} role="status">{notice.tone === "success" ? <Check /> : notice.tone === "error" ? <X /> : <Waves />}{notice.text}</div>;
}
