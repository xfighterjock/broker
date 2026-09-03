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
  it("ships a maintainable Xcode project with example plist (real plist is local/gitignored)", () => {
    expect(existsSync(resolve("ios/EventGate.xcodeproj/project.pbxproj"))).toBe(true);
    expect(existsSync(resolve("ios/project.yml"))).toBe(true);
    expect(existsSync(resolve("ios/README.md"))).toBe(true);
    expect(existsSync(resolve("ios/GoogleService-Info.plist.example"))).toBe(true);
    expect(existsSync(resolve("ios/EventGate/EventGateApp.swift"))).toBe(true);
    expect(existsSync(resolve("ios/EventGate/EventGate.entitlements"))).toBe(true);
    // Real GoogleService-Info.plist may exist locally for device builds; it must stay gitignored.
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
    expect(info).toContain("NSFaceIDUsageDescription");
  });

  it("home screen is essentials and Settings is secondary; no WKWebView shell", () => {
    const essentials = readFileSync(resolve("ios/EventGate/EssentialsView.swift"), "utf8");
    const content = readFileSync(resolve("ios/EventGate/ContentView.swift"), "utf8");
    const settings = readFileSync(resolve("ios/EventGate/SettingsView.swift"), "utf8");
    const login = readFileSync(resolve("ios/EventGate/LoginView.swift"), "utf8");
    const api = readFileSync(resolve("ios/EventGate/BrokerAPI.swift"), "utf8");
    const format = readFileSync(resolve("ios/EventGate/EssentialsFormat.swift"), "utf8");
    const webConfirm = readFileSync(resolve("client/src/essentials.ts"), "utf8");
    const dumped = [
      essentials, content, settings, login, api, format,
      readFileSync(resolve("ios/EventGate/AuthController.swift"), "utf8"),
      readFileSync(resolve("ios/EventGate/StatusController.swift"), "utf8"),
    ].join("\n");

    expect(content).toContain("EssentialsView()");
    expect(content).toContain("SettingsView()");
    expect(content).toContain("LoginView()");
    expect(settings).toContain("Register");
    expect(settings).toContain("Revoke");
    expect(login).toContain("Sign in");
    expect(api).toContain("/api/auth/login");
    expect(api).toContain("/api/status");
    expect(api).toContain("/api/gate/enable");
    expect(api).toContain("/api/paper/auto");
    expect(api).toContain("/api/flatten");
    expect(api).toContain("Authorization");
    expect(api).toContain("Bearer");
    expect(api).not.toContain("basicAuthHeader");
    expect(dumped).not.toContain("WKWebView");
    const flatten =
      'Flatten gated paper positions? This is the print-day / emergency veto (MockBroker, not live).';
    expect(format).toContain(flatten);
    expect(webConfirm).toContain(flatten);
    expect(essentials).toContain("AUTO PAPER");
    expect(essentials).toContain("SleeveChip");
    expect(essentials).toContain("confirmFlatten");
  });

  it("gitignore blocks the real plist and Xcode userdata", () => {
    const gi = readFileSync(resolve(".gitignore"), "utf8");
    expect(gi).toMatch(/ios\/\*\*\/GoogleService-Info\.plist/);
    expect(gi).toMatch(/xcuserdata/);
  });

  it("AppIcon set references the 1024 PNG", () => {
    const icon = resolve("ios/EventGate/Assets.xcassets/AppIcon.appiconset/AppIcon.png");
    const contents = readFileSync(
      resolve("ios/EventGate/Assets.xcassets/AppIcon.appiconset/Contents.json"),
      "utf8",
    );
    expect(existsSync(icon)).toBe(true);
    expect(statSync(icon).size).toBeGreaterThan(10_000);
    expect(contents).toContain('"filename" : "AppIcon.png"');
    expect(contents).toContain('"size" : "1024x1024"');
    expect(contents).not.toMatch(/"idiom"\s*:\s*"(iphone|ipad|ios-marketing)"/);
  });

  it("iOS sources do not embed secrets or service-account JSON", () => {
    const files = walkFiles(resolve("ios")).filter(
      (p) =>
        !p.endsWith(".png") &&
        !p.endsWith("GoogleService-Info.plist") && // local device build copy; gitignored
        !p.includes(`${"xcuserdata"}`),
    );
    const dumped = files
      .map((p) => `/* ${relative(root, p)} */\n${readFileSync(p, "utf8")}`)
      .join("\n");
    expect(dumped).not.toMatch(/BEGIN PRIVATE KEY/);
    expect(dumped).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
    expect(dumped).not.toMatch(/"type": "service_account"/);
    expect(dumped).not.toMatch(/ETRADE_PROD_(KEY|SECRET|ACCESS_TOKEN)/);
  });
});
