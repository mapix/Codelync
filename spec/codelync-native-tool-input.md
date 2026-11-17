# Native tool inputs in recent windows and corrections

2026-11-13. Codex and Antigravity native tool parameters share the existing
source-bound sealed message transport.

Ordinary visible tool parameters use a separate `input` JSON object in native
row upserts. `arguments` remains reserved for the existing strict image/file
attachment marker schema. Ordinary input never becomes a native image lookup,
attachment ref, file-browsing capability or a phone-to-Mac mutation parameter.

The shared input guard accepts plain JSON objects only, with at most 64 KiB
encoded JSON, depth 12 and 2048 values. Accessors, prototype keys, non-JSON
values and oversized input are rejected. A producer may omit invalid/oversized
input and set `inputUnavailable:true`; the visible tool, output and native
identity remain available and one input cannot fail the whole recent page.

Recent windows convert the original owner's ordinary `arguments` to this
bounded `input`. Strict file markers retain `arguments`. Native correction
events carry the same `input`, and the phone reducer replaces the existing
tool input under its original call/source identity without creating a new tool
or changing completed status. Partial inputs may be revised while a tool runs.

Acceptance includes real isolated `read_file` and `write_file` parameter shapes
through native projection, recent window, raw row-upsert parsing and reducer;
ordinary input corrections; oversized input; and unchanged image marker
validation. Private native prompts, metadata, signatures and paths are not
copied into committed QA fixtures.
