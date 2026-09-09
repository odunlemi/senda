# Senda Commit Specification

## Purpose

Senda commits should be easy to review, safe to deploy, and useful when tracing
payment behavior later. Each commit must describe one coherent outcome and
include the code, tests, migrations, contracts, and documentation needed for
that outcome.

This specification follows Conventional Commits and the repository's existing
history. `commitlint.config.js` extends `@commitlint/config-conventional` and is
the source of truth for machine-enforced syntax. This document adds the project
conventions that commitlint cannot enforce.

## Message Format

```text
<type>[optional scope][!]: <summary>

[body]

[optional footer(s)]
```

Examples:

```text
feat: add route-aware request limits
fix: enforce canonical merchant wallet ownership
docs: define the payment finality policy
feat!: require reauthentication for wallet changes
```

## Paste-Ready Formatting

Use the conventional 50/72 rule for every commit message:

- hard-limit the complete first line to 50 characters, including the type,
  optional scope, `!`, colon, and spaces;
- insert exactly one blank line between the first line and body;
- hard-wrap body and footer prose at 72 characters;
- wrap only at word boundaries and never split a word across lines;
- use real line breaks rather than relying on visual or soft wrapping;
- omit leading indentation, trailing whitespace, and extra blank lines.

When sharing a message for someone to paste, put the complete message in one
plain-text code block. The text inside the block must already contain the
intended hard line breaks. Do not copy visually wrapped text from a narrow
terminal pane, because display wrapping can become malformed pasted content.

For direct command-line use, a message file or quoted heredoc preserves the
line breaks exactly:

```sh
git commit -F - <<'EOF'
feat: add route-aware request limits

Apply separate request budgets to authentication, public reads, and Base
RPC-backed checkout operations.
EOF
```

## Header

The first line is required and must:

- use an allowed lowercase type;
- optionally use a stable lowercase scope;
- use `!` only for a breaking change;
- separate the prefix and summary with `: `;
- state the outcome in imperative, present-tense language;
- start the summary with a lowercase word such as `add`, `fix`, `enforce`,
  `preserve`, `remove`, or `document`;
- omit a trailing period;
- stay at or below 50 characters for the complete first line.

The Senda project limit is 50 characters, including the Conventional Commit
prefix, although commitlint currently permits up to 100. Use a body instead of
wrapping the first line or packing implementation details into it.

Good:

```text
feat: add paid reorg monitoring and audit
fix: preserve merchant wallet ownership
refactor: share payment receipt validation
```

Avoid:

```text
update stuff
feat: Added Rate Limiting.
fix: bug fixes and cleanup
feat: add limits, audits, recovery, alerts, and frontend pages
```

## Types

Use the narrowest type that describes why the commit exists.

| Type       | Use for                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `feat`     | A new product, API, persistence, operational, or protective capability. |
| `fix`      | Correcting wrong behavior, a regression, or a violated invariant.       |
| `refactor` | An internal restructuring with no intended behavior change.             |
| `perf`     | A measured performance improvement with unchanged behavior.             |
| `test`     | Test-only coverage or test infrastructure changes.                      |
| `docs`     | Documentation-only changes.                                             |
| `build`    | Build system, package, or dependency changes.                           |
| `ci`       | Continuous-integration or deployment-pipeline configuration.            |
| `chore`    | Repository maintenance not covered by a more specific type.             |
| `style`    | Formatting-only changes; use rarely because Prettier handles style.     |
| `revert`   | Reverting an earlier commit.                                            |

Security work does not need a custom type:

- use `fix` when closing an exploitable bug or restoring an existing security
  invariant;
- use `feat` when adding a new defense such as rate limiting or durable audit
  events.

A migration is not its own commit type. Choose `feat` or `fix` based on the
behavior the migration supports and keep the migration with that behavior.

## Scopes

Scopes are optional. Existing Senda commits omit them, so omission remains the
default while the repository has one API application.

Introduce a scope only when it makes a broad monorepo history materially easier
to understand. Use a stable lowercase name such as `api`, `web`, `checkout`, or
`infra`; do not invent file-level or one-off scopes.

```text
feat(web): add payment receipt view
fix(checkout): reject reused transaction hashes
```

Do not alternate arbitrarily between scoped and unscoped messages for similar
changes.

## Body

A body is required for any non-trivial behavior change. Leave one blank line
after the header and use short imperative paragraphs that explain:

1. what behavior changes;
2. why the change or invariant matters;
3. important API, state, security, or deployment decisions;
4. migrations and their data-preservation or rollback behavior;
5. the focused tests or verification added.

Describe behavior and intent rather than listing every edited file. Hard-wrap
normal body and footer prose at 72 characters, breaking only between words.
Commitlint's 100-character limit is a fallback guard, not the project target.

Use exact domain terms and identifiers where they improve traceability:
`payment intent`, `receiving wallet`, `Base`, `USDC`, `paidAt`, and endpoint
paths are preferable to vague terms such as `item`, `data`, or `logic`.

For payment and security changes, explicitly document consequential policy. For
example:

- whether `paid` remains terminal;
- whether a public identifier acts as a capability;
- whether a timeout is an operational policy rather than a chain requirement;
- whether an audit event records but does not compensate a reorg;
- whether a store or lock is safe only for a single process.

Do not claim verification that was not run. If a required check could not run,
resolve it before committing or state the exact limitation in the body and the
handoff.

## Footers and Breaking Changes

Use standard Git trailers after a blank line when needed:

```text
Refs: #123
Closes: #123
Co-authored-by: Name <email@example.com>
```

A breaking change must use `!` in the header, a `BREAKING CHANGE:` footer, or
both. The footer must identify the affected API, schema, environment variable,
or operational procedure and explain the required migration.

```text
feat!: require reauthentication for wallet changes

Require a fresh merchant credential before changing the receiving
address.

BREAKING CHANGE: PUT /api/merchant-wallet now requires a
reauthentication proof in the request body.
```

Do not mark additive forward database migrations as breaking unless they require
coordinated action from callers or make an existing deployment path invalid.

## Commit Boundaries

Each commit must be independently understandable and should leave the repository
buildable and testable.

Keep together:

- implementation and focused tests;
- an API handler and its request or response contract;
- application code and the forward migration it requires;
- a changed operational policy and its configuration or documentation.

Split apart:

- unrelated product behavior;
- opportunistic refactors not required by the change;
- broad formatting changes;
- dependency upgrades unrelated to the outcome;
- generated or local analysis files that are not part of the product change.

Do not rewrite a migration that may already have been applied. Add a forward
repair migration and explain its preservation strategy in the commit body.
Never commit secrets, local credentials, `.env` files containing real values,
or unrelated working-tree changes.

Use fixup commits only during local review. Squash them into the logical commit
before merge. A squash-merge title must also follow this specification.

## Verification Before Commit

For application changes, run:

```text
pnpm check
pnpm build
git diff --check
```

Also run the narrowest relevant test while iterating. For a documentation-only
commit, run Prettier on the changed documents and `git diff --check`.

Before creating the commit:

1. inspect `git status --short`;
2. inspect both `git diff` and `git diff --cached`;
3. stage only the files belonging to the stated outcome;
4. check the staged diff for secrets, generated files, and unrelated edits;
5. confirm that new migrations are included;
6. validate the proposed message with commitlint.

Example validation:

```text
printf '%s\n' 'feat: add durable security audit events' | pnpm exec commitlint
```

The repository currently has commitlint configuration but no tracked
`commit-msg` hook. Message validation is therefore a contributor responsibility
unless CI or a hook is added later.

## Full Examples

### Feature

```text
feat: add route-aware request limits

Apply separate IP budgets to merchant authentication, public reads, and
Base RPC-backed checkout operations. Add a merchant-keyed budget after
session validation for payment creation and wallet mutation.

Trust only the configured Railway proxy hop. Keep health checks and the
background reconciliation worker outside request limiters. Document that
the in-memory store supports only one API process.

Add tests for independent clients, JSON 429 responses, forwarding-header
handling, and prevent provider calls after the RPC budget is exhausted.
```

### Correctness or Security Fix

```text
fix: enforce canonical merchant wallet ownership

Normalize EVM receiving addresses before comparison and storage. Prevent
differently cased forms from bypassing one-wallet ownership.

Add a forward migration that detects collisions without deleting
merchant data and replaces byte-wise uniqueness with a case-insensitive
index. Cover safe normalization, collision failure, and idempotent
wallet updates.
```

### Focused Refactor

```text
refactor: share paid receipt validation

Use one receipt validation path for confirming and paid-payment
monitoring without changing payment states or API responses.

Keep existing reconciliation and reorg tests unchanged to verify
behavior.
```

### Documentation

```text
docs: define Senda commit conventions

Document Conventional Commit syntax, Senda type selection, atomic commit
boundaries, migration expectations, and required verification.
```

## Final Checklist

A commit is ready when:

- its header follows `<type>[optional scope][!]: <summary>`;
- its type reflects the reason for the change;
- its complete first line is imperative, specific, lowercase, and at most 50
  characters;
- its body explains behavior, rationale, risk, migrations, and tests where
  relevant, with prose hard-wrapped at 72 characters without split words;
- it contains one logical outcome and all files required by that outcome;
- breaking changes and issue references use standard footers;
- required verification passes;
- the staged diff contains no secrets or unrelated changes.
