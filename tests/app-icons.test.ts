import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
    expect(html).toContain('rel="icon" href="/favicon.ico"');
    expect(html).toContain('sizes="32x32" href="/favicon-32.png"');
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
    expect(html).toContain('sizes="192x192" href="/favicon-192.png"');
  });
});
