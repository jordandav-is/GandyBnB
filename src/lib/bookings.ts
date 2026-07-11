export type Reservation = {
  id: string;
  user_id: string;
  guest_name: string;
  start_date: string;
  end_date: string;
  status: "confirmed" | "cancelled";
  created_at: string;
};
const DAY_IN_MS = 86_400_000;

function dateToIso(date: Date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function dateFromIso(value: string) {
  return new Date(`${value}T00:00:00Z`);
}

export function datesOverlap(
  start: string,
  end: string,
  reservation: Pick<Reservation, "start_date" | "end_date" | "status">,
) {
  return (
    reservation.status === "confirmed" &&
    start < reservation.end_date &&
    end > reservation.start_date
  );
}

export function validateStay(start: string, end: string, today = new Date()) {
  if (!start || !end) return "Choose both check-in and check-out dates.";
  const startDate = dateFromIso(start);
  const endDate = dateFromIso(end);
  const earliest = dateToIso(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())));
  if (start < earliest) return "Check-in cannot be in the past.";
  if (end <= start) return "Check-out must be after check-in.";
  if ((endDate.getTime() - startDate.getTime()) / DAY_IN_MS > 21) {
    return "Stays are limited to 21 nights.";
  }
  return null;
}

export function nightsBetween(start: string, end: string) {
  if (!start || !end || end <= start) return 0;
  return (dateFromIso(end).getTime() - dateFromIso(start).getTime()) / DAY_IN_MS;
}

export function eachNight(start: string, end: string) {
  const nights: string[] = [];
  let cursor = dateFromIso(start);
  const final = dateFromIso(end);
  while (cursor < final) {
    nights.push(dateToIso(cursor));
    cursor = new Date(cursor.getTime() + DAY_IN_MS);
  }
  return nights;
}

export function todayIso(now = new Date()) {
  return dateToIso(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

export function formatStayDate(value: string, includeDay = true) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: includeDay ? "numeric" : undefined,
  }).format(dateFromIso(value));
}

export function stayDay(value: string) {
  return String(dateFromIso(value).getUTCDate());
}
