import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { datesOverlap, eachNight, nightsBetween, validateStay, type Reservation } from "./bookings.ts";

const confirmed: Reservation = {
  id: "reservation-1",
  user_id: "user-1",
  guest_name: "Jordan",
  start_date: "2026-08-10",
  end_date: "2026-08-15",
  status: "confirmed",
  created_at: "2026-07-11T00:00:00Z",
};

describe("booking boundaries", () => {
  it("treats checkout as exclusive so back-to-back stays remain available", () => {
    assert.equal(datesOverlap("2026-08-05", "2026-08-10", confirmed), false);
    assert.equal(datesOverlap("2026-08-15", "2026-08-19", confirmed), false);
  });

  it("detects every partial and contained overlap", () => {
    assert.equal(datesOverlap("2026-08-09", "2026-08-11", confirmed), true);
    assert.equal(datesOverlap("2026-08-14", "2026-08-16", confirmed), true);
    assert.equal(datesOverlap("2026-08-11", "2026-08-14", confirmed), true);
    assert.equal(datesOverlap("2026-08-01", "2026-08-20", confirmed), true);
  });

  it("releases cancelled stays", () => {
    assert.equal(datesOverlap("2026-08-11", "2026-08-12", { ...confirmed, status: "cancelled" }), false);
  });
});

describe("stay validation", () => {
  const now = new Date("2026-07-11T12:00:00Z");

  it("requires an ordered, present, non-past range", () => {
    assert.match(validateStay("", "", now), /both/i);
    assert.match(validateStay("2026-07-10", "2026-07-12", now), /past/i);
    assert.match(validateStay("2026-07-12", "2026-07-12", now), /after/i);
  });

  it("allows 21 nights and rejects 22", () => {
    assert.equal(validateStay("2026-08-01", "2026-08-22", now), null);
    assert.match(validateStay("2026-08-01", "2026-08-23", now), /21 nights/i);
  });

  it("counts and enumerates each occupied night", () => {
    assert.equal(nightsBetween("2026-08-10", "2026-08-13"), 3);
    assert.deepEqual(eachNight("2026-08-10", "2026-08-13"), [
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
    ]);
  });
});
