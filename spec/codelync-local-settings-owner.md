# Local settings while paused

The Mac window remains reopenable after its last window closes. Closing a
window keeps Codelync available; Quit waits for its owned service or settings
writer to exit. The original Desktop applications remain runtime owners.

`--settings-only=1` starts one profile-local configuration writer under the
same `service.source` lease as the normal service. It does not start the embedded
database, source discovery, native observers, network tunnels, media capture,
notifications or model runners. A transition to Start first drains and closes
this writer, then starts the normal service. No two profile writers overlap.

SIGTERM, pipe EOF and output failure share one cleanup flight. Repeated close
signals await the same lease release instead of exiting early while the first
cleanup is still running. A pending lease acquisition is drained, and startup
does not open a new database child after cancellation.

The writer publishes the existing source, connection and media configuration
frames followed by `settings-ready`. It accepts the existing request IDs and
source/access/desktop result frames. Acknowledged settings are durable before
success is reported. Permission actions are unavailable while paused.

Connection kinds remain independent saved choices. An inactive Relay address
uses the same URL/key validation and a bounded read-only service-info check;
its full forwarding proof occurs when Start activates it. Saving settings does
not represent a connected channel. Stored peer/account keys, pairing devices,
command journals and existing conversation data are never replaced.

Media settings retain their current validation and secret-reuse rules but are
saved without starting a host or media relay. Source choices are profile-local
preferences; the settings writer never calls a native Desktop application.

Configuration revision counters belong to the producing process. A new writer's
first verified local-pipe frame supersedes the previous process's counter while
retaining the saved selections. Late output from a retired process cannot
overwrite the new process's settings or status.

Acceptance uses an isolated profile with absent runtime binaries, sends actual
settings-pipe commands, verifies persisted configuration and lease release, and
asserts that no database, native process, tunnel or identity file is created.
