# Event Gate iOS (essentials + FCM)

Native phone client for Event Gate. Home screen mirrors web `/m` (MobileEssentials): clock/mode, GATE, RISK ON/OFF, AUTO PAPER master + D/M/O/Ow/R chips, Flatten (same confirm copy), sleeve P/L, optional E*TRADE PIN. Settings holds credentials/session tools and FCM register/revoke/test.

Web `/m` remains for browsers. This app talks to the same JSON APIs with a users-table session (Bearer in Keychain). It does not wrap the SPA in WKWebView.

This folder was authored on Linux (no Xcode). Open and build it on a Mac. The Simulator will not receive real APNs / FCM device pushes.

## Firebase app (already created)

| Key | Value |
| --- | --- |
| Project | `mybroker-37298` |
| Bundle ID | `com.logikmancer.mybroker` (must not change) |
| GCM sender | `137374048122` |
| Google app id | `1:137374048122:ios:9120eb5e79ab31400fc0c3` |

`API_KEY` lives only in the real `GoogleService-Info.plist`. Never commit that file.

## 1. Copy the Firebase plist

Firebase Console → Project settings → Your apps → iOS `com.logikmancer.mybroker` → download `GoogleService-Info.plist`.

```bash
cp ~/Downloads/GoogleService-Info.plist ios/EventGate/GoogleService-Info.plist
```

`ios/GoogleService-Info.plist.example` has the non-secret keys filled and `API_KEY=REPLACE_ME`. Do not rename the example over the real file and ship it — `FirebaseApp.configure()` needs the Console plist.

The Xcode target already references `EventGate/GoogleService-Info.plist` (red until you copy). `ios/**/GoogleService-Info.plist` is gitignored.

## 2. Open the project

```bash
open ios/EventGate.xcodeproj
```

Optional regenerate from XcodeGen (only if you change `project.yml`):

```bash
brew install xcodegen
cd ios && xcodegen generate && open EventGate.xcodeproj
```

SPM pulls **FirebaseCore** and **FirebaseMessaging** from `https://github.com/firebase/firebase-ios-sdk` (11.8.0, up to next major). First open resolves packages; needs network.

## 3. Signing

Signing & Capabilities → Team → pick Richard’s Apple Team. Leave bundle id `com.logikmancer.mybroker`. Automatic signing.

The target already has:

- Push Notifications (`aps-environment` = `development` in `EventGate.entitlements`)
- Background Modes → Remote notifications (`UIBackgroundModes`)
- Face ID usage string (`NSFaceIDUsageDescription`)

Xcode may rewrite `aps-environment` to `production` for a Release / App Store profile. That is expected.

## 4. Run on a physical iPhone

1. Plug in the phone, trust the computer, select the device (not a Simulator).
2. Build and run Event Gate.
3. Allow notifications when prompted.
4. Sign in with the users-table username/password (not nginx htpasswd, not `GATE_PASSWORD`). Session token stays in the Keychain.
5. Base URL defaults to `https://broker.logikmancer.com`.
6. Home screen is essentials. Settings (gear) has Face ID / Touch ID unlock, FCM Register / Revoke / Test, and Sign out.
7. When an FCM token appears (redacted `abcd…wxyz`), tap **Register** if auto-register did not already fire after login.
8. Tap **Refresh status** — expect `enabled` / `configured` and at least one active token.
9. Tap **Send test**. A banner should arrive on the phone. Backend test payload is title `Event Gate test notification`, `deepLinkRoute` `/status` (opens essentials).
10. Token refresh re-registers with `replaceToken`. **Revoke** opts this device out.

Simulator notes: `registerForRemoteNotifications` fails; you will not get a real APNs token or a deliverable FCM push. Use a device.

## 5. Backend contract

Production `AUTH_MODE=users`. nginx terminates TLS and does **not** require htpasswd on `/api` or the SPA. Login is `POST /api/auth/login` `{ username, password }`. Token principal for FCM is still `x-remote-user: event-gate` so existing tokens stay on that principal.

| Method | Path | Body |
| --- | --- | --- |
| POST | `/api/auth/login` | `{ username, password }` → `{ token }` |
| POST | `/api/auth/logout` | (revokes bearer) |
| GET | `/api/auth/status` | — |
| GET | `/api/status` | essentials snapshot |
| POST | `/api/gate/enable` | `{ enabled }` |
| POST | `/api/paper/auto` | `{ enabled }` or `{ sleeveId, enabled }` |
| POST | `/api/flatten` | `{}` |
| POST | `/api/etrade/oauth/start` | `{}` |
| POST | `/api/etrade/oauth/pin` | `{ pin }` |
| POST | `/api/notifications/tokens/register` | `{ platform: "ios", token, deviceLabel?, replaceToken? }` |
| POST | `/api/notifications/tokens/revoke` | `{ platform: "ios", token }` |
| POST | `/api/notifications/test` | (empty) |
| GET | `/api/notifications/status` | — |

VPS must keep `PUSH_FCM_ENABLED=1` plus Firebase Admin credentials. This app never sees the service-account JSON.

## 6. Manual Firebase / Apple blockers

Uploading an **APNs Authentication Key** (`.p8`) in Firebase Console is still a human step. This repo does not invent or commit that key.

Firebase Console → Project settings → Cloud Messaging → Apple app configuration → APNs Authentication Key → upload the `.p8` from Apple Developer (Keys) for team + bundle `com.logikmancer.mybroker`. Also enable the Push Notifications capability on the App ID if Xcode did not do it.

Without that `.p8`, FCM cannot hand the notification to APNs. Register may succeed and **Send test** may report delivered while the phone stays silent.

## Out of scope

Desktop blotter, charts, directional order entry, Android, wrapping the SPA in WKWebView, committing secrets (plist API key, service-account JSON, user passwords, nginx password, E\*TRADE material, raw FCM tokens).
