---
"@porulle/cli": minor
---

`init` now pins scaffolded `@porulle/*` dependencies to the version of the CLI that created the project. The packages ship as a fixed-version group, so the running CLI's own version is the correct, coherent target; previously the starter template carried a static range (`^0.5.0`) that went stale on every release and — under 0.x caret semantics — left freshly scaffolded projects a full minor behind the CLI.
