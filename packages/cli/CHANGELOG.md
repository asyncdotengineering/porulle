# @porulle/cli

## 0.6.0

### Minor Changes

- [#32](https://github.com/asyncdotengineering/porulle/pull/32) [`dcc4fe9`](https://github.com/asyncdotengineering/porulle/commit/dcc4fe98a476ae91d12a13495db20fe2e7d5dd2e) Thanks [@octalpixel](https://github.com/octalpixel)! - `init` now pins scaffolded `@porulle/*` dependencies to the version of the CLI that created the project. The packages ship as a fixed-version group, so the running CLI's own version is the correct, coherent target; previously the starter template carried a static range (`^0.5.0`) that went stale on every release and — under 0.x caret semantics — left freshly scaffolded projects a full minor behind the CLI.
