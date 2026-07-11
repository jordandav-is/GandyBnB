"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  Camera,
  CreditCard,
  MessageCircle,
  Send,
  Shell,
  Shield,
  Trash,
  Users,
  X,
} from "@/components/Icons";
import {
  api,
  type AdminReservation,
  type Guest,
  type Listing,
  type Message,
  type MessageThread,
  type Photo,
} from "@/lib/api";
import { formatStayDate, nightsBetween, todayIso } from "@/lib/bookings";

type Notice = { tone: "success" | "error" | "info"; text: string } | null;
type AdminTab = "bookings" | "listing" | "photos" | "messages" | "payments";

const TABS: { id: AdminTab; label: string; icon: typeof Shield }[] = [
  { id: "bookings", label: "Bookings", icon: Users },
  { id: "listing", label: "Listing", icon: Shell },
  { id: "photos", label: "Photos", icon: Camera },
  { id: "messages", label: "Messages", icon: MessageCircle },
  { id: "payments", label: "Payments", icon: CreditCard },
];

export default function AdminPanel({ refreshKey }: { refreshKey: number }) {
  const [tab, setTab] = useState<AdminTab>("bookings");
  const [notice, setNotice] = useState<Notice>(null);

  return (
    <section className="admin-shell">
      <div className="admin-heading">
        <div>
          <span className="eyebrow"><Shield /> Superadmin</span>
          <h2>Run the house.</h2>
        </div>
        <nav className="admin-tabs" aria-label="Admin sections">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => { setTab(id); setNotice(null); }}>
              <Icon /> {label}
            </button>
          ))}
        </nav>
      </div>
      {notice && <div className={`notice ${notice.tone}`} role="status">{notice.text}</div>}
      {tab === "bookings" && <BookingsTab refreshKey={refreshKey} setNotice={setNotice} />}
      {tab === "listing" && <ListingTab setNotice={setNotice} />}
      {tab === "photos" && <PhotosTab refreshKey={refreshKey} setNotice={setNotice} />}
      {tab === "messages" && <MessagesTab refreshKey={refreshKey} setNotice={setNotice} />}
      {tab === "payments" && <PaymentsTab />}
    </section>
  );
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function BookingsTab({ refreshKey, setNotice }: { refreshKey: number; setNotice: (value: Notice) => void }) {
  const [reservations, setReservations] = useState<AdminReservation[]>([]);
  const [guests, setGuests] = useState<Guest[]>([]);
  const today = todayIso();

  const load = useCallback(async () => {
    try {
      const [allReservations, allGuests] = await Promise.all([api.admin.reservations(), api.admin.users()]);
      setReservations(allReservations);
      setGuests(allGuests);
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error, "The bookings could not be loaded.") });
    }
  }, [setNotice]);

  useEffect(() => { queueMicrotask(() => void load()); }, [load, refreshKey]);

  async function issueResetCode(userId: string) {
    try {
      const { code, email, expires_at } = await api.admin.issueResetCode(userId);
      setNotice({
        tone: "success",
        text: `One-time reset code for ${email}: ${code} — share it with them privately; it expires ${new Date(expires_at).toLocaleTimeString()} and replaces any earlier code.`,
      });
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error, "The reset code could not be created.") });
    }
  }

  async function cancelReservation(id: string) {
    try {
      await api.cancel(id);
      setNotice({ tone: "info", text: "Reservation cancelled. The guest's dates are open again." });
      await load();
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error, "The reservation could not be cancelled.") });
    }
  }

  return (
    <div className="admin-panel">
      <div className="admin-card">
        <h3>Every stay on the books</h3>
        {reservations.length === 0 ? <p className="admin-empty">No reservations yet.</p> : (
          <table className="admin-table">
            <thead>
              <tr><th>Guest</th><th>Dates</th><th>Nights</th><th>Status</th><th>Payment</th><th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {reservations.map((reservation) => (
                <tr key={reservation.id} className={reservation.status === "cancelled" ? "is-cancelled" : ""}>
                  <td data-label="Guest"><strong>{reservation.guest_name}</strong><span>{reservation.email}</span></td>
                  <td data-label="Dates">{formatStayDate(reservation.start_date)} → {formatStayDate(reservation.end_date)}</td>
                  <td data-label="Nights">{nightsBetween(reservation.start_date, reservation.end_date)}</td>
                  <td data-label="Status"><span className={`status-tag ${reservation.status}`}>{reservation.status === "confirmed" && reservation.end_date < today ? "past" : reservation.status}</span></td>
                  <td data-label="Payment"><span className="status-tag pending">{reservation.payment_status.replace(/_/g, " ")}</span></td>
                  <td className="row-actions">
                    {reservation.status === "confirmed" && (
                      <button className="cancel-button" onClick={() => void cancelReservation(reservation.id)}>Cancel</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="admin-card">
        <h3>Guests</h3>
        {guests.length === 0 ? <p className="admin-empty">Nobody has joined yet.</p> : (
          <table className="admin-table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Confirmed stays</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {guests.map((guest) => (
                <GuestRow
                  key={guest.id}
                  guest={guest}
                  onIssueResetCode={() => void issueResetCode(guest.id)}
                  onChanged={load}
                  setNotice={setNotice}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function GuestRow({ guest, onIssueResetCode, onChanged, setNotice }: {
  guest: Guest;
  onIssueResetCode: () => void;
  onChanged: () => Promise<void>;
  setNotice: (value: Notice) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [working, setWorking] = useState(false);
  const isSuperadmin = guest.role === "superadmin";

  async function saveGuest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setWorking(true);
    try {
      await api.admin.updateUser(guest.id, {
        display_name: String(values.get("display_name") ?? "").trim(),
        email: String(values.get("email") ?? "").trim(),
      });
      setEditing(false);
      setNotice({ tone: "success", text: `${guest.display_name}'s details are updated.` });
      await onChanged();
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error, "The guest could not be updated.") });
    } finally {
      setWorking(false);
    }
  }

  async function deleteGuest() {
    setWorking(true);
    try {
      await api.admin.deleteUser(guest.id);
      setNotice({ tone: "info", text: `${guest.display_name}'s account, stays, and messages are removed.` });
      await onChanged();
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error, "The guest could not be removed.") });
      setConfirmingDelete(false);
      setWorking(false);
    }
  }

  if (editing) {
    return (
      <tr className="guest-editing">
        <td colSpan={5}>
          <form className="guest-edit-form" onSubmit={saveGuest}>
            <label>Name<input name="display_name" defaultValue={guest.display_name} minLength={2} maxLength={60} required /></label>
            <label>Email<input name="email" type="email" defaultValue={guest.email} readOnly={isSuperadmin} required /></label>
            <div className="guest-edit-actions">
              <button className="primary-button" disabled={working} type="submit">{working ? "Saving…" : "Save"}</button>
              <button className="cancel-button" type="button" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td data-label="Name"><strong>{guest.display_name}</strong></td>
      <td data-label="Email">{guest.email}</td>
      <td data-label="Role"><span className={`status-tag ${isSuperadmin ? "confirmed" : "pending"}`}>{isSuperadmin ? "superadmin" : "guest"}</span></td>
      <td data-label="Stays">{guest.confirmed_stays}</td>
      <td className="guest-actions">
        {confirmingDelete ? (
          <>
            <span className="delete-warning">Remove {guest.display_name} and all their stays?</span>
            <button className="cancel-button danger" disabled={working} onClick={() => void deleteGuest()}>{working ? "Removing…" : "Yes, remove"}</button>
            <button className="cancel-button" disabled={working} onClick={() => setConfirmingDelete(false)}>Keep</button>
          </>
        ) : (
          <>
            <button className="cancel-button" onClick={() => setEditing(true)}>Edit</button>
            <button className="cancel-button" onClick={onIssueResetCode}>Password reset code</button>
            {!isSuperadmin && <button className="cancel-button danger" onClick={() => setConfirmingDelete(true)}>Delete</button>}
          </>
        )}
      </td>
    </tr>
  );
}

function ListingTab({ setNotice }: { setNotice: (value: Notice) => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.listing()
      .then(({ listing: current }) => setListing(current))
      .catch((error) => setNotice({ tone: "error", text: errorText(error, "The listing could not be loaded.") }));
  }, [setNotice]);

  async function saveListing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setSaving(true);
    setNotice(null);
    try {
      const { listing: saved } = await api.admin.updateListing({
        name: String(values.get("name") ?? "").trim(),
        tagline: String(values.get("tagline") ?? "").trim(),
        description: String(values.get("description") ?? "").trim(),
      });
      setListing(saved);
      setNotice({ tone: "success", text: "Listing updated. Everyone sees the new copy instantly." });
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error, "The listing could not be saved.") });
    } finally {
      setSaving(false);
    }
  }

  if (!listing) return <div className="admin-panel"><div className="admin-card"><p className="admin-empty">Loading the listing…</p></div></div>;

  return (
    <div className="admin-panel">
      <form className="admin-card admin-form" onSubmit={saveListing}>
        <h3>Listing details</h3>
        <label>House name<input name="name" defaultValue={listing.name} minLength={2} maxLength={80} required /></label>
        <label>Tagline<input name="tagline" defaultValue={listing.tagline} maxLength={160} /></label>
        <label>Description<textarea name="description" defaultValue={listing.description} maxLength={2000} rows={5} /></label>
        <button className="primary-button" disabled={saving} type="submit">{saving ? "Saving…" : "Save listing"}</button>
      </form>
    </div>
  );
}

function PhotosTab({ refreshKey, setNotice }: { refreshKey: number; setNotice: (value: Notice) => void }) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const { photos: current } = await api.listing();
      setPhotos(current);
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error, "The photos could not be loaded.") });
    }
  }, [setNotice]);

  useEffect(() => { queueMicrotask(() => void load()); }, [load, refreshKey]);

  async function addPhoto(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setAdding(true);
    setNotice(null);
    try {
      await api.admin.addPhoto(String(values.get("url") ?? "").trim(), String(values.get("caption") ?? "").trim());
      form.reset();
      setNotice({ tone: "success", text: "Photo added to the gallery." });
      await load();
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error, "The photo could not be added.") });
    } finally {
      setAdding(false);
    }
  }

  async function removePhoto(id: string) {
    try {
      await api.admin.deletePhoto(id);
      await load();
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error, "The photo could not be removed.") });
    }
  }

  return (
    <div className="admin-panel">
      <form className="admin-card admin-form" onSubmit={addPhoto}>
        <h3>Add a photo</h3>
        <label>Image URL<input name="url" type="url" placeholder="https://…" required /></label>
        <label>Caption<input name="caption" maxLength={200} placeholder="Sunset from the porch" /></label>
        <button className="primary-button" disabled={adding} type="submit">{adding ? "Adding…" : "Add to gallery"}</button>
        <p className="fine-print">Paste a public https image link — direct uploads can come later.</p>
      </form>
      <div className="admin-card">
        <h3>Gallery ({photos.length})</h3>
        {photos.length === 0 ? <p className="admin-empty">No photos yet. Add the first one.</p> : (
          <div className="photo-grid">
            {photos.map((photo) => (
              <figure key={photo.id}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo.url} alt={photo.caption || "House photo"} loading="lazy" />
                <figcaption>
                  <span>{photo.caption || "Untitled"}</span>
                  <button aria-label="Remove photo" onClick={() => void removePhoto(photo.id)}><Trash /></button>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MessagesTab({ refreshKey, setNotice }: { refreshKey: number; setNotice: (value: Notice) => void }) {
  const [threads, setThreads] = useState<MessageThread[]>([]);
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [guestName, setGuestName] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const loadThreads = useCallback(async () => {
    try {
      setThreads(await api.admin.threads());
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error, "The inbox could not be loaded.") });
    }
  }, [setNotice]);

  const loadThread = useCallback(async (userId: string) => {
    try {
      const { guest, messages: thread } = await api.admin.thread(userId);
      setGuestName(guest.display_name);
      setMessages(thread);
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error, "The conversation could not be loaded.") });
    }
  }, [setNotice]);

  useEffect(() => { queueMicrotask(() => void loadThreads()); }, [loadThreads, refreshKey]);
  useEffect(() => {
    if (activeUserId) queueMicrotask(() => void loadThread(activeUserId));
  }, [activeUserId, loadThread, refreshKey]);

  async function sendReply(event: FormEvent) {
    event.preventDefault();
    if (!activeUserId || !draft.trim()) return;
    setSending(true);
    try {
      await api.admin.reply(activeUserId, draft.trim());
      setDraft("");
      await Promise.all([loadThread(activeUserId), loadThreads()]);
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error, "The reply could not be sent.") });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="admin-panel messages-layout">
      <div className="admin-card thread-list">
        <h3>Guests</h3>
        {threads.length === 0 ? <p className="admin-empty">No guests to message yet.</p> : threads.map((thread) => (
          <button
            key={thread.user_id}
            className={`thread-row ${activeUserId === thread.user_id ? "active" : ""}`}
            onClick={() => setActiveUserId(thread.user_id)}
          >
            <strong>{thread.display_name}{thread.unread_count > 0 && <em className="unread-dot">{thread.unread_count}</em>}</strong>
            <span>{thread.last_message ?? "No messages yet — say hello."}</span>
          </button>
        ))}
      </div>
      <div className="admin-card thread-view">
        {!activeUserId ? <p className="admin-empty">Pick a guest to read and reply.</p> : (
          <>
            <h3>Chat with {guestName}</h3>
            <div className="chat-scroll">
              {messages.length === 0 ? <p className="admin-empty">No messages yet.</p> : messages.map((message) => (
                <p key={message.id} className={`chat-bubble ${message.sender_role === "superadmin" ? "mine" : ""}`}>
                  {message.body}
                  <time>{new Date(message.created_at).toLocaleString()}</time>
                </p>
              ))}
            </div>
            <form className="chat-compose" onSubmit={sendReply}>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={`Message ${guestName}…`}
                maxLength={2000}
                aria-label="Reply"
              />
              <button className="primary-button coral" disabled={sending || !draft.trim()} type="submit" aria-label="Send reply"><Send /></button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function PaymentsTab() {
  return (
    <div className="admin-panel">
      <div className="admin-card payments-stub">
        <CreditCard aria-hidden="true" />
        <h3>Payments aren&apos;t wired up yet.</h3>
        <p>
          Every reservation already carries a <code>payment_status</code> (currently <code>not_required</code>),
          and the API reserves <code>/admin/payments</code> for when a payment provider is added.
          Nothing to do here for now.
        </p>
        <span className="status-tag pending"><X /> Coming later</span>
      </div>
    </div>
  );
}
