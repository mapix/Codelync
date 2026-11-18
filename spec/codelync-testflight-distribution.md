# TestFlight signing and production push

The iOS application identifier is `com.learnings.codelync`; the Mac application
uses `com.learnings.codelync.mac`. The native iOS workspace, scheme and product
are `apps/mobile/ios/Codelync.xcworkspace`, `Codelync` and `Codelync.app`.
Distribution uses the new Codelync Bundle ID and its Push capability/profile.
Signing verification accepts only the current application identifier and
`Codelync` display name (`CFBundleDisplayName`), and fails closed with explicit
error codes when `EXConstants.bundle/app.config` is missing or malformed.

TestFlight and App Store Connect artifacts are full Release device archives,
exported with the `app-store-connect` method, an Apple Distribution private
identity and its matching `IOS_APP_STORE` provisioning profile. Development and
release-testing profiles remain private installation assets and are not uploaded
as beta releases. Existing certificates and profiles are preserved.

The signed `aps-environment`, provisioning profile entitlement and embedded
`codelyncPushEnvironment` must all be `production`. App identifier, team,
profile expiration and matching distribution identity remain required gates.
App Store profiles omit `ProvisionedDevices`; a generic archive/export validation
without a device accepts that absence. A private development or ad hoc validation
that specifies a device still requires an actual array containing that exact
device. Optional device-list extraction must not hide malformed present values
or errors reading the other required signing facts.

Archive and export use explicit workspace, scheme, Release configuration,
production entitlement file and manual profile selection. Production bundling
uses normal project configuration with `CODELYNC_APNS_ENVIRONMENT=production`;
final exported bytes receive signing, embedded-config, fresh Hermes, source and
privacy checks before upload. Private keys, profiles, IPA signing evidence and
credentials stay outside the repository and public artifacts.

The first App Store version omits `whatsNew` from canonical version
localizations because Apple does not allow that field to be edited before an
initial release. Beta test instructions belong to the target build's TestFlight
test notes.

The APNs token and sender topic are `com.learnings.codelync`. A P8 file contains
key material rather than an authorization scope; retaining a readable key does
not establish that a topic-restricted key permits the current Bundle ID. Confirm
the existing key's topic/environment permissions in the authorized Developer
Portal session before configuring the publisher. Key changes and live sender
configuration application are separate from code and signing-profile creation.

The Mac publisher must support the enrolled device's push environment before a
production beta can receive notifications. Production push uses Apple's
production endpoint; existing development devices retain sandbox delivery. A
signing/artifact mock check does not claim a live APNs delivery or user acceptance.

## Direct registered-device installation

An explicitly requested local iPhone install may re-export the verified full
Release archive as `release-testing`, using an additive `IOS_APP_ADHOC` profile
for that registered device and the existing Apple Distribution identity. Keep
production APNs entitlements and configuration, verify the device list and
matching code/Hermes bytes, then install over USB without uninstalling or
resetting the device. These private packages are not published on the website
or GitHub and do not change the submitted TestFlight build.
