# Migrating from @porulle/core 0.15.0 to 0.16.0

One change, and for most deployments it changes nothing you can observe.

Budget five minutes. If your auth stack is healthy, the only difference is that
a class of bug now announces itself instead of hiding.

---

## 1. An auth check that fails is no longer reported as a bad credential

`authMiddleware` decides whether a caller is authenticated by calling two
better-auth entry points: `getSession` for cookie and bearer sessions, and
`verifyApiKey` for API keys. Both were wrapped in a bare `catch` that fell
through to anonymous.

That is correct for the case those catches were written for — a credential
better-auth evaluated and rejected. It was also applied to every other
exception: a database that could not answer, a schema that drifted from what
better-auth expects, a bug inside the auth plugin, two copies of better-auth
resolved into one module graph. All of them came back as
`401 UNAUTHORIZED / "Authentication required."`, and none of them were logged.

A caller told "Authentication required." goes and checks their credential. When
the credential was never evaluated, that answer sends them somewhere the fault
is not, with nothing in the log to correct them.

### What changes

porulle now separates the two:

| what happened | before | after |
| --- | --- | --- |
| better-auth rejected the credential | 401, anonymous | **unchanged** — 401, anonymous |
| the check itself failed | 401, silent | logged at `error`, then 500 |

A rejection is recognised structurally: better-call's `APIError` carries
`name === "APIError"` and a numeric `statusCode`. Anything else is a fault.

The log line names the stage, so you can tell a session fault from an API-key
fault:

```json
{
  "level": "error",
  "stage": "api_key",
  "path": "/api/catalog/entities",
  "method": "GET",
  "err": { "type": "TypeError", "message": "handler is not a function" },
  "msg": "auth check failed — the credential was never evaluated, so this is not an authentication failure"
}
```

### What you need to do

Nothing, if your auth stack is healthy — a rejected credential still 401s and
an anonymous request is still anonymous.

**If a route starts returning 500 after upgrading, it was already broken.** The
500 is the bug that was there before, finally visible. Read the `err` in the log
line; it names the real fault. Do not treat the 500 as a regression to work
around.

Two faults worth knowing, because both have bitten adopters:

- **Two better-auth copies in one tree.** In a workspace using
  `node-linker=hoisted` or `shamefully-hoist=true`, porulle's `better-auth@1.7.x`
  can end up resolving `better-call` from a root copy pinned by another app's
  `better-auth@1.6.x`. `verifyApiKey` then throws
  `TypeError: handler is not a function`. Align the workspace on one better-auth
  major, or pin `better-call` to the version porulle's better-auth requires.
- **Schema drift.** `BetterAuthError: The field "X" does not exist in the "Y"
  Drizzle schema` means the auth tables and better-auth's model disagree. Run
  your schema push again.

### If you must keep the old behaviour

There is no flag, and one is not planned. Swallowing a fault and calling it an
invalid credential is not a behaviour worth preserving behind a switch. If a
fault is genuinely tolerable on some route, handle it in your own middleware
ahead of porulle's, where the decision is visible in your code.

---

## 2. Everything else

No schema changes. No configuration changes. No API surface changes.
