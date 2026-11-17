# Native project identity across Git worktrees

2026-11-13. This presentation identity is independent of native conversation,
application, host and runtime ownership. Original working directories are never
rewritten or used as mutation targets.

- All saved desktop local-project roots and workspace aliases are resolved
  through their actual read-only Git metadata before thread assignments are used.
- Antigravity's native workspace folders use the same common-directory resolver.
  Explicit native workspace subprojects retain their relative path; linked
  worktrees of the same workspace project share the primary checkout identity.
  Application/host ownership stays separate from this presentation key.
- A linked worktree's `.git` file and `commondir` identify the common repository.
  Project identity includes that canonical common directory and the explicit
  project-root path relative to the checkout root. A separately saved linked
  worktree is therefore an alias of the same project, not a top-level project.
- Explicit monorepo subproject roots retain their relative path. Two distinct
  saved subprojects do not collapse merely because they share a repository.
- Unassigned conversation working directories resolve through the same Git
  identity, choosing the deepest known project root for their canonical path;
  otherwise they belong to the repository root. Nested cwd values do not create
  a new project. Conversation cwd and parent identifiers remain unchanged.
- Non-Git roots retain canonical-path identity. Same-name independent repositories
  never merge. Removed managed worktrees may use only the existing unique saved
  project alias; ambiguity remains a separate unknown project.
- Read-only path and Git-location caches are per directory projection. Lookup
  results are reused for repeated paths and ancestor directories; no original
  repository metadata, desktop configuration or worktree is modified.

Acceptance covers separately assigned main and linked-worktree project roots,
multi-root saved projects, nested worktree cwd values, explicit monorepo
subprojects, symlinked metadata, independent same-name repositories and removed
worktree alias ambiguity. Runtime deployment must verify the updated project key
in the original-source directory; fixture grouping alone is not phone acceptance.
# Display identity while the owner is unavailable (2026-11-15)

Native project grouping uses a verified source identity and the native
`projectKey`/`projectPath` presentation metadata. A missing current control owner
does not turn a known Git worktree into an independent project. This grouping
does not enable input, models, approvals or other live operations. Invalid or
foreign native identities do not gain trust from a project path alone.

Directory projections retain an already persisted canonical native project
descriptor when a cold source has not yet supplied fresh project metadata.
Refreshed native project metadata remains authoritative. Worktree repository
mapping comes from `.git`/`commondir` or explicit original workspace mapping;
directory names alone do not merge unrelated repositories.

A retained `.git` pointer into a pruned standard `.git/worktrees/<entry>` may
trace back to that common repository only when its common HEAD/config still
exist. For deleted Antigravity managed worktrees, the native
`~/.gemini/antigravity/worktrees/<repository>/<worktree>` layout may use the
repository component to resolve a unique already verified Git project among
the native workspace roots. Ambiguous same-name repositories remain separate.
An unverified saved worktree path must not override this stronger association.

