# iPhone notifications

Codelync sends Apple APNs alerts for original-owner turn completion, failure,
and newly required input or approval. The Mac and original Desktop owner must
remain running and online. Only sessions already attached to a native observer
are covered. The phone may be in the background; its data socket is not kept alive.

## Set up this Mac

1. In Apple Developer, enable Push Notifications for `com.learnings.codelync`.
2. Create an operator-owned APNs key. Download the P8 once and retain a private
   backup. Codelync does not use the upstream Happy Expo publishing account.
3. In Codelync's paired devices section, choose **Configure notifications…**.
   Enter the Apple team ID and key ID, choose the default environment, and select the P8.
   Codelync imports an independent copy into private local state with mode 0600.
4. Install a matching push-enabled phone build and allow notifications on iOS.
5. Open Codelync once to register the phone. **Test notification** becomes
   available for a registered device. Apple acceptance is shown separately from
   actual display on the phone.

## Build a push-enabled phone package

Use Node 24.15.0 and pnpm 10.11.0. Install the explicit development provisioning
profile containing this app, Push Notifications, the signing certificate and
registered phone. Keep profiles, P8 files and credentials outside Git.

```sh
pnpm build:mobile --device YOUR_DEVICE_ID --team YOUR_TEAM_ID --generic \
  --push-environment development --profile-name YOUR_PROFILE_UUID
```

Automatic signing is also supported with `--allow-provisioning-updates` when
Xcode has the intended Apple account. A registered-device production trial uses
`--push-environment production`, an Apple Distribution identity and its matching
ad hoc profile. TestFlight uses an App Store profile without a device registry,
a production push entitlement and an App Store Connect archive/export. Simulator builds do not accept a push
mode. Omitting the push flag preserves the existing local trial signing.

A push build verifies its signed entitlement, provisioning profile, registered
phone and embedded Expo configuration. A successful build alone does not prove
that APNs delivery or a notification tap works.

## Verify actual delivery

Open a session on the phone, then return to the Home Screen. Send a test from
its paired-device row on Mac. Confirm the banner or notification-center alert,
then tap it and confirm that the same session opens and reconciles its log.
Also verify a genuinely new completion/failure and input/approval event from the
original Desktop owner. Do not send model prompts merely to test transport.

Unchanged state and historical backfill are quiet. Recent foreground viewing
suppresses automatic alerts for that session. Revoked devices are excluded;
invalid APNs tokens are disabled. Foreground return and native token rotation
refresh registration. Alerts contain generic text and session/Mac identity,
without private message text. A changed gateway address retains same-Mac tap
routing; a different Mac's alert cannot open under the current pairing.

Focus modes, notification settings, network availability and iOS policy can
change when or whether an alert is displayed. This does not rely on background
refresh scheduling.

## Development and TestFlight together

Development installs register sandbox tokens; TestFlight and App Store installs
register production tokens. The Mac sends each alert to the environment in the
approved device's registration, using its existing operator-owned APNs key.
Installing a beta does not require overwriting the Mac's saved development
setting or dropping alerts for other development devices. The key must permit
the intended Apple delivery environment. Provider failures remain explicit.

The initial development native-display/tap acceptance is retained. Production
artifact signing and environment routing checks are recorded separately from
actual production notification delivery.
