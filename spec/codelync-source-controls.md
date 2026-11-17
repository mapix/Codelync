# Source models, commands and compatibility

2026-11-13. This extends the dual native source contract.

Codex keeps its existing original-owner model/effort CAS. Antigravity 2.31.2
standalone does not expose a verified conversation-model update RPC;
`GetUserSettings` is unavailable and conversation annotations have no model field.
Its picker therefore selects **the next explicit message's model**, not a global
desktop preference. Codelync stores that selection in the encrypted source
checkpoint, checks the original owner's catalogue and process/instance identity,
and freezes the native model identity into that message's native CascadeConfig.
Only original input admission and its model-config readback confirm actual use.
Changing the picker alone sends no prompt and is labelled as staged. A changed
owner invalidates a staged choice until the user selects it again.

The source controls include App version plus native protocol/capability evidence.
The inspected Antigravity control contract is 2.31.2 / Connect protocol 1.
Unknown App contracts retain visible unavailable controls; version alone does not
enable mutations. Model IDs, labels and command names come from the source owner.

Antigravity slash commands use `GetSlashCommands` for the selected conversation
and workspace. Text-backed system commands and skills are submitted as native
`ContextScopeItem.slashCommand` items using the owner's exact definition, plus
the user's argument text. Definitions and local paths remain on the Mac.
Commands with no verified remote submission contract (for example UI-only
commands without model-facing text) do not appear as executable suggestions.
Hand-typed known unsupported commands are rejected before either native or model
dispatch, with their draft preserved. A model-picker command directs the user to
the existing source model menu and never becomes ordinary prompt text. Unknown
slash commands, including names missing from a partial/unavailable catalogue,
also stay in the draft with an explicit unsupported notice; no capability is
guessed. Ordinary path text such as `/etc/hosts` remains ordinary input.
Unknown slash text is not advertised as a known command. Codex never inherits
Antigravity commands or the historical Happy/CLI fallback catalogue.

Codex's inspected catalogue is explicitly partial. Its `/compact` draft submits
the original version-1 follower compact action through `source-command`, with a
stable operation ID and idle/owner validation. It does not create a model input
or a fictitious user-message admission. The existing model picker serves `/model`;
desktop-only `/goal` and an unavailable complete skills catalogue are not offered
as executable slash suggestions. Selecting a suggestion only stages a draft;
the user's explicit Send dispatches an operation. Unknown results preserve the
original operation ID and cannot be automatically retried.

Verification covers catalogue isolation, disabled/unknown models, original
version, encrypted staging/restart/owner change, frozen per-message config,
native slash scope construction, and no mutation when choosing a suggestion.

## Claude Desktop Gateway controls

Claude retains native per-session settings. Its existing send API has no
per-message model or effort override. Codelync reads the existing held Query's
model/command catalogue and original Gateway model policy; it never invokes a
catalogue facade that may create a temporary Query. Native IDs, route aliases,
labels and effort capabilities remain distinct and retain original provenance.

The compatible `codex-controls-read` / `codex-controls-update` RPC names may carry
Claude controls. Claude snapshots include an exact `scope`: app, appMode,
nativeCollection, nativeConversationId, hostId, ownerGeneration,
runtimeGeneration, queryToken, cliSessionId and settingsToken. The settingsToken
is a bridge snapshot digest over original settings/confirmation state; it is
not advertised as a native sequence. A cache is valid only while the same
original source/query and snapshot authority remain current.

A settings-read RPC sends an empty parameter object; the existing journal adds
only its stable `commandId`. The selected connector validates its current
source, Query and owner epoch. `expectedScope` is a mutation compare condition
and original receipt-recovery identity, not a settings-read payload field. The
native read contract remains `commandId` only.

Catalog readability is independent of mutation permission. Readonly original
owners may show their native catalogue/current values while updates remain
disabled. Each model supplies the original allowed efforts and an explicit
`canUnsetReasoningEffort`; LAM's string-only setter must not receive a synthetic
null Default selection. Missing or partial native policy cannot manufacture
options, a current setting or a default.

Updates freeze the displayed expectedScope/model/effort in the durable command
plan. The original manager entry rechecks owner/query/CLI/settings before native
invocation. Completion requires captured-query model/effort acknowledgments and
owner confirmation of effective alias-resolved/clamped values, without a
superseding change. Header record updates or an active setter's early void
result cannot confirm applied settings. Effective values and exact native
evidence are retained for receipt recovery; equality with a later header alone
cannot resolve unknown delivery. Possible effects take priority over safe error
names, and unknown operation IDs are never automatically replayed.

Begin with verified idle held Code operations. Active/deferred setters and
typed LAM setters require their own native gates. Slash catalogue presence does
not prove execution: an original UUID/command invocation must have its native
admission and lifecycle/result, including locally handled commands with no
ordinary user row. Readonly owners deny slash dispatch before invocation.

## Readonly child model display and read failures — 2026-11-16

An explicit native subagent or retained saved-history page does not initiate a
settings-controller RPC from the model display hook, including manual refresh.
The connector does not advertise settings read/update capabilities or refresh a
settings controller for an explicit native child. Direct stale-client settings
requests are rejected before adapter invocation; existing command receipts remain
recoverable without dispatching the setting again.
A child model display accepts only a validated readonly `nativeObservedModel`
from its snapshot metadata. It ignores retained controller current values,
catalogues and next-message staging; those are not observations of the child's
current native model. A model request in Antigravity's loaded message suffix does
not establish its current owner setting. An Antigravity child with no confirmed
current setting shows unknown; it never inherits its parent's selected model or
creates a settings controller. Do not load older messages to guess settings.

Ordinary owners with a confirmed settings-read capability may still read their
catalogue while writes are disabled. A settings read failure uses read-specific
copy; it cannot claim a model update failed when no update was submitted.
Asynchronous reads belong to the selected session and must not put an error on
a different session after navigation. A genuine pending/unknown model mutation
retains its captured source scope and original receipt identity. Refresh may
query that original receipt without replaying the setting change, even if the
page has since become readonly or lost its settings-read capability. Read errors
never clear or downgrade an unknown mutation result.
