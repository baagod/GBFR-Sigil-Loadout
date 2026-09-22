# OpenWiki brief — GBFR-Sigil-Loadout

Control metadata for this repository's OpenWiki run. Not generated documentation; it
is user-authored and must not be rewritten by routine init/update/chat runs.

## Why this wiki exists

Its reader is a **future agent** (and secondarily a human maintainer) that must
understand this repository's **design and intent** without re-reading the codebase.

The repo already has a code graph (`.codegraph/`, queried through `codegraph_explore`)
that answers *structural* questions exactly: who calls what, what a change affects,
verbatim source. **Do not duplicate that in prose.** The wiki's job is the layer the
graph cannot provide:

- **why** each piece is designed the way it is,
- what **invariants** must stay true,
- where the **boundaries** are between components,
- which parts are **deliberate and fragile**, so a future change does not silently break them.

## Scope and priority

This run is a **deliberate first slice**, not exhaustive coverage. The source is verbose
and carries long inline "why" commentary; the value here is **distilling intent**, not
restating code.

Priority order — write these well; stop when they are well covered:

1. **System overview and how the three surfaces divide responsibility.**
   The C# mod (`GBFR.SigilLoadout/`, the in-game feature), the Go service
   (`SigilLoadout/`, asset serving plus editors), and the React frontend
   (`SigilLoadout/frontend/`) — what each owns, and how a change crosses between them.

2. **The sigil hot-apply flow end to end.**
   From the user editing in the frontend, through the config file, to the C# code
   patching the game's native table through `IDataManager` at runtime. This is the
   load-bearing design of the project and deserves the deepest treatment.

3. **The data contract and invariants between the surfaces.**
   The file formats and JSON shapes they exchange, and who validates what. Independent
   validation in more than one layer is intentional — document it as such.

## What to capture, explicitly

- **Design rationale that is not derivable from structure alone.** Recurring themes worth
  hunting down and explaining: timing and concurrency hazards (for example ordering around
  a file-modification-time claim, or a re-entrancy guard), deliberate pre-flight refusals
  (for example only touching layouts the code can prove it understands, so a future table
  format changes nothing instead of writing wrong rows), and value-domain guards (for
  example rejecting non-finite numbers rather than letting the game do arithmetic on them).
- **Failure semantics.** What each layer does when something is missing or malformed, and
  what that means for the user.
- **Untrusted and boundary inputs.** Which file (or field) is treated as untrusted, and where
  the validation that trusts it lives.

## What to leave out

- Per-type API reference, generated-file listings, or directory tours.
- Restating a code comment in prose without adding intent. If a source comment already
  explains *why* in place, the wiki should state the **design rule**, not repeat the comment.
- Anything that is already one `codegraph_explore` call away (callers, impact, symbol source).
- `GBFR.SigilLoadout.Native/` internals unless they are required to explain surface 2.

## Style

- Dense and non-redundant. Prefer a precise design statement plus a `path:line` anchor over
  a paragraph of narrative.
- Every non-obvious claim must carry its evidence (`path:line`, test name, or manifest).
- Note **where behavior is surprising on purpose**; that is the single most valuable thing
  this wiki can tell a future editor.
