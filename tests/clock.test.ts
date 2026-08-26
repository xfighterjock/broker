import { describe, expect, it } from "vitest";
import {
  computeClock,
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
