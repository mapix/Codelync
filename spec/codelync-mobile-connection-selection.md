# Mobile connection selection and recovery

Status: implementation contract, 2026-11-17.

## Selection means intent

The phone saves an explicit Automatic, Local, Cloudflare or Relay choice before
testing whether its route is reachable. An offline or refused route cannot change
that choice back to Automatic. Store this preference in the existing local
credential record, scoped to the same pinned Mac and phone device. Preserve the
account token, secret, Mac key, device keys, cached sessions and operation journals.

The preference contains the mode and, for a manual choice, the channel ID and
kind. Existing `peer.automatic` and `peer.selectedChannel` values provide the
migration default. A new pairing cannot inherit another Mac's preference.

Desired selection and actual connection are separate. `selectedId` identifies
the desired manual route (or the chosen route in Automatic mode); `activeId`
identifies the currently admitted endpoint. A failed Local choice may leave a
previous authenticated Cloudflare route readable. Show that difference rather
than marking Automatic or claiming the Local route is connected.

## One current selection owner

Every explicit choice immediately retires earlier probes and recovery callbacks.
Credential writes are ordered, so an already running old write is followed by
the newest intent. A late old proof, failure, save or socket callback cannot
change the current selection, restore Automatic, or roll back a newer endpoint.
The route changes only after the candidate responds with the pinned Mac proof.
Route-commit failure retains the new preference and the previously verified route.
An unavailable credential store is reported separately from a failed route.
During the SecureStore/server-config transition, the staged same-owner record
retains only its previous actual URL alongside the new authenticated manifest.
This prevents an intermediate read from treating the same pairing as missing.
The old URL is removed after the new runtime route is committed; neither this
staging record nor a late write grants another account authority.

Repeated requests for the same selection coalesce. A different explicit choice
can replace an in-flight choice. A screen completion from an old peer cannot
close or change the current picker.

## Bounded same-Mac recovery

Retry, cold startup, foreground return and transport loss use the saved intent.
Recovery does not promote itself to an explicit Automatic selection. It is
coalesced and limited to one current probe plus a bounded backoff burst; healthy
authenticated reads suppress unnecessary route replacement.

A surviving paired route may supply a fresh sealed `/api/peer/channels` manifest.
This is discovery data, not permission to change the desired kind. Manual mode
first prefers its original ID, then a reachable route of the same kind. LAN IDs
change when the host IP changes, so the stored kind preserves Local intent.
Manual Local never silently commits Cloudflare or Relay. Any newly selected URL
must independently pass the original pinned-Mac response check.

The existing same-Mac USB/startup locator may refresh candidates while retaining
the current preference and verified route until replacement succeeds. If all
known routes are unreachable, show an actionable same-Mac location scan/USB
recovery. Do not clear the account or require a replacement model runner.

Recovery only establishes network routes and revalidates reads. Unknown native
commands retain their IDs and existing receipt-only recovery; they are never
resubmitted because a route or network changed.

## Fast probing and write admission

All known candidates start the sealed `GET /network-probe` concurrently. The
response is only `{version:1}` inside the existing pinned-Mac response envelope.
Use a 1.5-second LAN budget and a 3-second public-route budget. A 404/405 from an
older Mac permits one sealed channels request within that same deadline. Other
errors do not relax authentication. Fetch the complete channels manifest only
after a fast proof; it has its own bounded budget. Cancelling or superseding the
selection retires all loser probes and their late results.
Tiny response bodies are limited to 4 KiB and manifests to 16 KiB. Oversized
streamed replies are cancelled. If a proved route's manifest fails, continue to
the next already proved eligible candidate instead of requesting every manifest.
Plain proxy 401/403 responses remain route failures. Only a sealed, authenticated
Mac revocation may report ended access. After the bounded retry burst, expose
Retry and same-Mac location recovery; foreground/socket recovery can start a new
burst without high-frequency permanent polling.

While a manual choice is not proved, the old route may serve read-only content,
discovery and original-operation receipt checks. It cannot carry a new business
mutation. The write fence is scoped to the pinned Mac/device keys and is checked
again immediately before dispatch after asynchronous encryption. A refusal before
dispatch has `effectMayHaveOccurred=false`. UI send/control admission uses the
same writable state. Successful desired proof, owner replacement and reset retire
the fence; already dispatched effects retain their receipt/unknown semantics.
Cold socket initialization binds the saved manual intent before its first send.
Scanning the same v2 Mac key uses its channels only as location hints and validates
the original peer/account/device through recovery. It does not exchange another
invitation, generate keys or fall back to re-pairing on a verification failure.

## Verification

Use focused fixtures for offline intent persistence, desired/active presentation,
old-auto/new-manual ordering, restart/manual same-kind discovery and unchanged
credential/operation identity. Native installation and real network acceptance
remain separate from these source and state checks.
