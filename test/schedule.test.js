import test from "node:test";
import assert from "node:assert/strict";
import { cleanHours, overrideFor, storeStatus } from "../src/schedule.js";

const at = text => Date.parse(text);
const friday = [null, null, null, null, null, { start: "21:00", end: "02:00" }, null];
const base = { timeZone: "Asia/Tokyo", hours: friday, override: null };

test("validates weekly hours", () => {
  assert.deepEqual(cleanHours(friday), friday);
  assert.equal(cleanHours([null]), null);
  assert.equal(cleanHours([...friday.slice(0, 6), { start: "10:00", end: "10:00" }]), null);
  assert.equal(cleanHours([...friday.slice(0, 6), { start: "25:00", end: "10:00" }]), null);
});

test("opens across midnight on schedule", () => {
  assert.equal(storeStatus(base, at("2026-10-02T20:59:00+09:00")).open, false);
  assert.equal(storeStatus(base, at("2026-10-02T20:59:00+09:00")).nextOpenAt, at("2026-10-02T21:00:00+09:00"));
  assert.equal(storeStatus(base, at("2026-10-02T23:00:00+09:00")).open, true);
  assert.equal(storeStatus(base, at("2026-10-03T01:59:00+09:00")).open, true);
  assert.equal(storeStatus(base, at("2026-10-03T01:59:00+09:00")).closesAt, at("2026-10-03T02:00:00+09:00"));
  assert.equal(storeStatus(base, at("2026-10-03T01:59:00+09:00")).nextOpenAt, at("2026-10-09T21:00:00+09:00"));
  assert.equal(storeStatus(base, at("2026-10-03T02:00:00+09:00")).open, false);
  assert.equal(storeStatus(base, at("2026-10-03T02:00:00+09:00")).nextOpenAt, at("2026-10-09T21:00:00+09:00"));
});

test("manual override wins and returns to schedule", () => {
  const during = at("2026-10-02T23:00:00+09:00");
  const closed = { ...base, override: overrideFor("close", base, during) };
  assert.equal(storeStatus(closed, during).open, false);
  assert.equal(storeStatus(closed, during).nextOpenAt, at("2026-10-09T21:00:00+09:00"));
  assert.equal(storeStatus(closed, at("2026-10-09T21:00:00+09:00")).open, true);

  const noon = at("2026-10-02T12:00:00+09:00");
  const skipped = { ...base, override: overrideFor("skip-next", base, noon) };
  assert.equal(storeStatus(skipped, at("2026-10-02T22:00:00+09:00")).open, false);
  assert.equal(storeStatus(skipped, noon).nextOpenAt, at("2026-10-09T21:00:00+09:00"));

  const tuesday = at("2026-09-29T12:00:00+09:00");
  const skippedEarly = { ...base, override: overrideFor("skip-next", base, tuesday) };
  assert.equal(storeStatus(skippedEarly, tuesday).nextOpenAt, at("2026-10-09T21:00:00+09:00"));

  const thursday = at("2026-10-01T15:00:00+09:00");
  const opened = { ...base, override: overrideFor("open", base, thursday) };
  assert.equal(storeStatus(opened, thursday).open, true);
  assert.equal(storeStatus(opened, thursday).closesAt, at("2026-10-03T02:00:00+09:00"));
  assert.equal(storeStatus(opened, at("2026-10-03T03:00:00+09:00")).open, false);
  assert.equal(overrideFor("skip-next", base, during), undefined);
});

test("without a schedule the store is open unless closed by hand", () => {
  const manual = { timeZone: "Asia/Tokyo", hours: Array(7).fill(null), override: null };
  assert.equal(storeStatus(manual).open, true);
  const closed = { ...manual, override: overrideFor("close", manual) };
  assert.deepEqual(closed.override, { open: false, until: null });
  assert.equal(storeStatus(closed).open, false);
  assert.equal(storeStatus(closed).nextOpenAt, null);
});

test("handles daylight saving time zones", () => {
  const sunday = [{ start: "01:30", end: "03:30" }, null, null, null, null, null, null];
  const status = storeStatus({ timeZone: "America/New_York", hours: sunday }, at("2026-11-01T00:00:00-04:00"));
  assert.equal(status.nextOpenAt, at("2026-11-01T01:30:00-04:00"));
});
