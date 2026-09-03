import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(".");

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

describe("iOS Event Gate scaffold", () => {
  it("ships a maintainable Xcode project without a real Firebase plist", () => {
    expect(existsSync(resolve("ios/EventGate.xcodeproj/project.pbxproj"))).toBe(true);
    expect(existsSync(resolve("ios/project.yml"))).toBe(true);
    expect(existsSync(resolve("ios/README.md"))).toBe(true);
    expect(existsSync(resolve("ios/GoogleService-Info.plist.example"))).toBe(true);
    expect(existsSync(resolve("ios/EventGate/EventGateApp.swift"))).toBe(true);
    expect(existsSync(resolve("ios/EventGate/EventGate.entitlements"))).toBe(true);
    expect(existsSync(resolve("ios/EventGate/GoogleService-Info.plist"))).toBe(false);
  });

  it("example plist fills non-secret keys and leaves API_KEY as REPLACE_ME", () => {
    const example = readFileSync(resolve("ios/GoogleService-Info.plist.example"), "utf8");
    expect(example).toContain("<string>REPLACE_ME</string>");
    expect(example).toContain("com.logikmancer.mybroker");
    expect(example).toContain("mybroker-37298");
    expect(example).toContain("137374048122");
    expect(example).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
    expect(example).not.toMatch(/BEGIN PRIVATE KEY/);
  });

  it("bundle id, push entitlement, and remote-notification background mode are wired", () => {
    const pbx = readFileSync(resolve("ios/EventGate.xcodeproj/project.pbxproj"), "utf8");
    const yml = readFileSync(resolve("ios/project.yml"), "utf8");
    const entitlements = readFileSync(resolve("ios/EventGate/EventGate.entitlements"), "utf8");
    const info = readFileSync(resolve("ios/EventGate/Info.plist"), "utf8");
    expect(pbx).toContain("PRODUCT_BUNDLE_IDENTIFIER = com.logikmancer.mybroker");
    expect(pbx).toContain("FirebaseCore");
    expect(pbx).toContain("FirebaseMessaging");
    expect(yml).toContain("com.logikmancer.mybroker");
    expect(yml).toContain("FirebaseCore");
    expect(yml).toContain("FirebaseMessaging");
    expect(entitlements).toContain("aps-environment");
    expect(info).toContain("remote-notification");
    expect(info).toContain("Event Gate");
  });

  it("gitignore blocks the real plist and Xcode userdata", () => {
    const gi = readFileSync(resolve(".gitignore"), "utf8");
    expect(gi).toMatch(/ios\/\*\*\/GoogleService-Info\.plist/);
    expect(gi).toMatch(/xcuserdata/);
  });

  it("iOS sources do not embed secrets or service-account JSON", () => {
    const files = walkFiles(resolve("ios")).filter((p) => !p.endsWith(".png"));
    const dumped = files
      .map((p) => `/* ${relative(root, p)} */\n${readFileSync(p, "utf8")}`)
      .join("\n");
    expect(dumped).not.toMatch(/BEGIN PRIVATE KEY/);
    expect(dumped).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
    expect(dumped).not.toMatch(/"type": "service_account"/);
    expect(dumped).not.toMatch(/ETRADE_PROD_(KEY|SECRET|ACCESS_TOKEN)/);
  });
});
