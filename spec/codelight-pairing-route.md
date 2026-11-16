# Returning from a verified native pairing

The v2 pairing controller saves verified peer credentials, clears its pending
invitation and reloads the app. A native deep-link route can survive that reload.
Re-entering `/pair` must not keep exchanging the old invitation after pairing
has completed or leave a connected device on an expired-invitation screen.

The phone may finish that route without a new exchange only when:

- The route is a structurally valid v2 CodeLight invitation, including its exact
  known Mac key and an origin already in the saved trusted peer channels.
- The saved peer identity is the current authenticated socket authority and that
  sealed real-time connection is connected.
- The selected saved origin is also one of that peer's trusted channels.

An invitation may be expired for this passive route recognition; expiry still
prevents every new pairing exchange. Route recognition neither changes channels
nor writes credentials, and cannot authorize a different Mac or a revoked or
disconnected device. All other cases retain the existing pairing controller.

Tests cover a paired route surviving reload, an expired consumed invitation,
different key/peer/origin, invalid invitation structure and disconnected state.
