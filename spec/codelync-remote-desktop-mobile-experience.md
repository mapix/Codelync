# Mobile remote desktop experience

Status: implementation contract, 2026-11-17.

## Job and boundaries

The remote desktop page lets a phone user view, point and type on their Mac.
The picture is the main surface. This page has no Sessions/Desktop/Settings
bottom navigation. An explicit exit disconnects Codelync's desktop stream and
returns to the previous page, where the ordinary portrait navigation resumes.
It does not close or restart any original Desktop app or submit model prompts.
Exit stops local input and detaches the local stream before navigation. Remote
leave cleanup runs in the background; a weak network must not hold the user on
the desktop page while waiting for that acknowledgment.

Keep the current authenticated desktop transport, permissions, operation
sequence and fresh-picture geometry guards. Remote desktop remains optional and
disabled by default. The original Desktop sessions retain their owners.

### Phone feature visibility

The local `remoteDesktopEnabled` preference defaults to false on first install
and upgrade. Previous visits, saved peer routes and Mac-side enablement never
provide consent to show it. Settings contains an explicit Remote Desktop switch;
its value uses the existing device-local settings persistence and is not synced.

Off removes the desktop tab and entry points. A direct route/deep link redirects
to Settings without mounting a desktop controller or requesting a stream. Turning
the switch off while that route is mounted removes its controller and returns to
Settings. On makes the phone entry available; it does not enable the Mac backend
or grant screen recording/Accessibility permissions. The immersive video page
continues to have no bottom navigation.

## Canvas and controls

- The connected picture fills the available landscape viewport. Do not place a
  permanent title row or a scrolling bank of text buttons above or below it.
- Mount one video canvas. Showing controls, keyboard, settings or immersive mode
  must not replace that canvas or cause a new stream/subscription.
- Use a compact translucent dark control dock over the picture. Primary actions
  are exit, keyboard and more controls, with stable connection indication.
- Put pointer modes, zoom, display/quality selection, Spaces and disconnect in
  secondary expandable panels. All touch targets are at least 44 points.
- Expanded panels stay inside safe areas, scroll when necessary, and do not
  intercept picture gestures outside their own bounds. On compact landscape
  viewports (`height < 460pt`), panel headers and content padding tighten while
  preserving at least `44pt` touch targets, single-line panel titles and menu
  labels truncate cleanly without hiding detail values or chevrons, and the
  disconnected empty state scrolls cleanly if needed so it never clips behind
  the bottom dock. Only one panel is open at a time. The fullscreen action hides
  controls rather than opening another native modal containing another video
  view; a visible `>= 44pt` restore control brings them back.
- Keyboard appearance reduces the usable picture area or moves the input
  controls above the keyboard. Preserve correct coordinate mapping after every
  layout change. Keyboard and popover controls cannot obscure each other.
  When the user has selected a point in the remote picture, opening the keyboard
  keeps that point visible and retains the previous picture scale where the
  zoom limit allows it. This adjustment is local; it sends no media/input
  requests. Closing the keyboard restores the previous view. Without a selected
  point, retain ordinary fit behavior.
- Connection errors change a fixed indicator and expandable details. They do
  not add/remove layout rows that move the picture. Permission, waiting and
  reconnecting states use distinct actionable copy.

## Visual direction

Use the desktop picture as the full-screen stage, with a small thumb-operated
dock as the signature. Native system type carries labels, while technical size
and frame-rate values use a compact utility face. No decorative headings.

Tokens: canvas `#020406`, glass `rgba(16,25,34,0.76)`, foreground `#E8EEF4`,
quiet text `#80929C`, action `#88C9E5`, warning `#F2B765`. Use restrained blur,
thin translucent borders and clear pressed/selected/disabled states. Respect
safe-area insets, VoiceOver labels and reduced motion; no continuous animations.

## Keyboard

Opening the keyboard focuses a real native input control. English and Chinese
IME text must be usable without unwanted duplicate insertion. Submit committed
text through the existing ordered input path; only a confirmed accepted result
clears the submitted draft. Rejected or unconfirmed input keeps the draft and
is never retried automatically. Concurrent edits after submission are retained.

Enter, Tab, Escape, Backspace, arrows and common Command shortcuts have explicit
accessible controls with localized screen-reader labels across English, Chinese
and Japanese. The keyboard hint/limit row collapses when empty so normal typing
preserves picture height. They follow the same permission, connection and
fresh-view guards as pointer input. Respect the current 2,048 UTF-16-unit text
limit; oversized input is not silently truncated or partially submitted. Local
editing and keyboard dismissal do not send input to a Desktop session composer.

Pointer moves and adjacent scrolls in the same direction may coalesce while a
request is in flight. Keep the scroll total inside the existing 1,200-pixel
packet bound, preserve direction changes and never merge text, keys, clicks or
pointer down/up. The bounded queue cannot replay an uncertain input. Queue
saturation reports an input backlog rather than a misleading media failure.

## Verification and delivery

Verify the changed keyboard protocol/state behavior with one focused regression
set. Review the changed landscape layout with an isolated native fixture, then
build/install the integrated update for the user's physical-phone verification.
Do not repeat unrelated App suites or interact with a running original Desktop
session for keyboard tests. Source review, screenshot review, input acceptance
and physical-phone confirmation are separate evidence. Retain pairing, drafts,
unknown operation IDs and private state through the update.
