import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  calendarIsStale,
  computeClock,
  etParts,
  flattenEtFor,
  flattenInstantUtc,
  formatCountdown,
  seedEvents,
  zonedTimeToUtc,
} from "../shared/clock";

const events = seedEvents();
const nfp = events[0];

function at(iso: string) {
  return computeClock(new Date(iso), events);
}

describe("clock / state machine around Sep 4 2026 12:30Z NFP", () => {
  it("is idle well before T-15", () => {
    const s = at("2026-09-04T12:14:00.000Z");
    expect(s.mode).toBe("idle");
    expect(s.nextEvent?.type).toBe("NFP");
  });

  it("enters PRE-ARM at T-15 (12:15Z / 08:15 ET)", () => {
    const s = at("2026-09-04T12:15:00.000Z");
    expect(s.mode).toBe("PRE-ARM");
    expect(s.inPreArm).toBe(true);
    expect(s.inBand).toBe(false);
    expect(s.activeEvent?.type).toBe("NFP");
  });

  it("stays PRE-ARM until T-2", () => {
    expect(at("2026-09-04T12:27:59.000Z").mode).toBe("PRE-ARM");
  });

  it("enters NO-STOP BAND at T-2 (12:28Z / 08:28 ET)", () => {
    const s = at("2026-09-04T12:28:00.000Z");
    expect(s.mode).toBe("NO-STOP BAND");
    expect(s.inBand).toBe(true);
  });

  it("is NO-STOP BAND at the print 12:30Z", () => {
    const s = at("2026-09-04T12:30:00.000Z");
    expect(s.mode).toBe("NO-STOP BAND");
    expect(s.countdownLabel).toBe("T−0:00");
  });

  it("stays NO-STOP BAND through T+2 (12:32Z)", () => {
    expect(at("2026-09-04T12:32:00.000Z").mode).toBe("NO-STOP BAND");
  });

  it("returns to idle after T+2 and before flatten", () => {
    const s = at("2026-09-04T12:32:01.000Z");
    expect(s.mode).toBe("idle");
  });

  it("SESSION FLATTEN is flatten clock 15:45 ET ±5 min (19:40Z–19:50Z)", () => {
    expect(flattenEtFor(nfp)).toBe("15:45");
    const flatten = flattenInstantUtc(nfp);
    expect(flatten.toISOString()).toBe("2026-09-04T19:45:00.000Z");

    expect(at("2026-09-04T19:39:59.000Z").mode).toBe("idle");
    expect(at("2026-09-04T19:40:00.000Z").mode).toBe("SESSION FLATTEN");
    expect(at("2026-09-04T19:45:00.000Z").mode).toBe("SESSION FLATTEN");
    expect(at("2026-09-04T19:50:00.000Z").mode).toBe("SESSION FLATTEN");
    expect(at("2026-09-04T19:50:01.000Z").mode).toBe("idle");
  });
});

describe("FOMC forces flatten 15:30 ET", () => {
  it("overrides flattenEt when type contains FOMC", () => {
    const stmt = events.find((e) => e.type === "FOMC_STATEMENT")!;
    expect(flattenEtFor(stmt)).toBe("15:30");
    expect(flattenInstantUtc(stmt).toISOString()).toBe("2026-09-16T19:30:00.000Z");
    expect(at("2026-09-16T19:25:00.000Z").mode).toBe("SESSION FLATTEN");
    expect(at("2026-09-16T19:35:00.000Z").mode).toBe("SESSION FLATTEN");
    expect(at("2026-09-16T19:35:01.000Z").mode).toBe("idle");
  });

  it("PRE-ARM / BAND around FOMC statement 18:00Z", () => {
    expect(at("2026-09-16T17:45:00.000Z").mode).toBe("PRE-ARM");
    expect(at("2026-09-16T17:58:00.000Z").mode).toBe("NO-STOP BAND");
    expect(at("2026-09-16T18:00:00.000Z").mode).toBe("NO-STOP BAND");
  });
});

describe("helpers", () => {
  it("formats countdown", () => {
    expect(formatCountdown(15 * 60 * 1000)).toBe("T−15:00");
    expect(formatCountdown(-2 * 60 * 1000)).toBe("T+2:00");
  });

  it("converts ET wall time to UTC in September DST", () => {
    const d = zonedTimeToUtc(2026, 9, 4, 8, 30, 0);
    expect(d.toISOString()).toBe("2026-09-04T12:30:00.000Z");
  });
});

describe("print calendar through 2027", () => {
  it("keeps the September 2026 instants and the verified later prints", () => {
    const byId = Object.fromEntries(seedEvents().map((e) => [e.id, e.timeUtc]));
    expect(byId["nfp-2026-09-04"]).toBe("2026-09-04T12:30:00Z");
    expect(byId["cpi-2026-10-14"]).toBe("2026-10-14T12:30:00Z");
    expect(byId["fomc-statement-2026-10-28"]).toBe("2026-10-28T18:00:00Z");
    expect(byId["nfp-2026-11-06"]).toBe("2026-11-06T13:30:00Z");
    expect(byId["fomc-statement-2027-03-17"]).toBe("2027-03-17T18:00:00Z");
    expect(byId["nfp-2027-11-05"]).toBe("2027-11-05T12:30:00Z");
    expect(byId["cpi-2027-11-10"]).toBe("2027-11-10T13:30:00Z");
    expect(byId["cpi-2027-12-10"]).toBe("2027-12-10T13:30:00Z");
  });

  it("puts every seed print on an ET weekday", () => {
    for (const ev of seedEvents()) {
      const w = etParts(new Date(ev.timeUtc)).weekday;
      expect(w === "Sat" || w === "Sun", ev.id).toBe(false);
    }
  });

  it("flags a September-only calendar stale on 2026-10-09 and the extended seed fresh", () => {
    const oct9 = new Date("2026-10-09T20:00:00.000Z");
    const september = seedEvents().filter((e) => e.timeUtc < "2026-10-01");
    expect(calendarIsStale(oct9, september)).toBe(true);
    expect(calendarIsStale(oct9, seedEvents())).toBe(false);
    const clock = computeClock(oct9, seedEvents());
    expect(clock.nextEvent?.id).toBe("cpi-2026-10-14");
    expect(clock.mode).toBe("idle");
    expect(calendarIsStale(new Date("2027-03-31T16:00:00.000Z"), seedEvents())).toBe(false);
    expect(calendarIsStale(new Date("2027-12-11T16:00:00.000Z"), seedEvents())).toBe(true);
  });

  it("migration 005 inserts every seed print that 001 does not", () => {
    const init = readFileSync(resolve("db/migrations/001_init.sql"), "utf8");
    const next = readFileSync(resolve("db/migrations/005_calendar_through_2027.sql"), "utf8");
    const hay = `${init}\n${next}`;
    for (const ev of seedEvents()) {
      const stamp = ev.timeUtc.replace(".000Z", "Z");
      expect(hay.includes(`'${stamp}', '${ev.type}'`), ev.id).toBe(true);
    }
  });
});
