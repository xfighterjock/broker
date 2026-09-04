import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CACHE_BUST = "v=20260904";

function pngSize(buf: Buffer): { w: number; h: number } {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

describe("Event Gate web icons", () => {
  it("publishes favicon assets and head links", () => {
    const html = readFileSync(resolve("client/index.html"), "utf8");
    const files = [
      "client/public/favicon.ico",
      "client/public/favicon-32.png",
      "client/public/apple-touch-icon.png",
      "client/public/favicon-192.png",
    ];
    for (const rel of files) {
      const full = resolve(rel);
      expect(existsSync(full), rel).toBe(true);
      expect(statSync(full).size, rel).toBeGreaterThan(200);
    }
    const png32 = readFileSync(resolve("client/public/favicon-32.png"));
    const png192 = readFileSync(resolve("client/public/favicon-192.png"));
    const apple = readFileSync(resolve("client/public/apple-touch-icon.png"));
    expect(pngSize(png32)).toEqual({ w: 32, h: 32 });
    expect(pngSize(png192)).toEqual({ w: 192, h: 192 });
    expect(pngSize(apple)).toEqual({ w: 180, h: 180 });

    const ico = readFileSync(resolve("client/public/favicon.ico"));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    const frameSizes = [0, 1].map((i) => {
      const entry = 6 + i * 16;
      const offset = ico.readUInt32LE(entry + 12);
      expect(ico.subarray(offset, offset + 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
        true,
      );
      return { w: ico[entry], h: ico[entry + 1] };
    });
    expect(frameSizes).toEqual([
      { w: 16, h: 16 },
      { w: 32, h: 32 },
    ]);

    expect(html).toContain("<title>Event Gate</title>");
    expect(html).toContain(`rel="icon" href="/favicon.ico?${CACHE_BUST}"`);
    expect(html).toContain(`rel="shortcut icon" href="/favicon.ico?${CACHE_BUST}"`);
    expect(html).toContain(`sizes="32x32" href="/favicon-32.png?${CACHE_BUST}"`);
    expect(html).toContain(`rel="apple-touch-icon" href="/apple-touch-icon.png?${CACHE_BUST}"`);
    expect(html).toContain(`sizes="192x192" href="/favicon-192.png?${CACHE_BUST}"`);
  });
});
