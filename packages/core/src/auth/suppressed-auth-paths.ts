/**
 * Better Auth endpoints this repository refuses to serve, because their only
 * currency is a raw session bearer token.
 *
 * THE DEFAULT IS TO SERVE. A Better Auth endpoint absent from this list is
 * mounted, because suppressing one is a removal from a published surface and
 * the list is the place where that removal is argued rather than assumed.
 *
 * These are handed to Better Auth's own `disabledPaths` option rather than
 * refused by a middleware in front of the handler. The difference is what a
 * future mount can reach around. `runtime/server.ts` funnels `/api/auth/*` into
 * `auth.handler`, and `disabledPaths` is read inside that handler's router, in
 * `onRequest`, BEFORE rate limiting and before any plugin hook — so there is no
 * ordering, no second mount point and no consumer configuration that reaches
 * the endpoint without passing it. A Hono middleware would have to be
 * remembered at every mount point instead, and this is an auth surface.
 *
 * MATCHING IS EXACT, on the path Better Auth normalizes a request to: the
 * pathname with the auth base path stripped, so `/api/auth/list-sessions`
 * arrives here as `/list-sessions`. A consumer cannot move that out from under
 * the list without breaking every auth route at once — `runtime/server.ts`
 * mounts the handler at a literal `/api/auth/*`, and Better Auth derives the
 * router's base path from `auth.baseURL`, so a `baseURL` carrying some other
 * path makes EVERY endpoint unreachable rather than just these. The failure is
 * loud, which is the property that matters: a guard that silently stops
 * covering its route is worse than no guard.
 *
 * Suppression is unconditional and not configurable. A config flag here would
 * be a documented way to switch the leak back on, and there is no caller that
 * wants one: nothing in this repository calls either path.
 */
export type SuppressedAuthPath = {
  /** The path as Better Auth normalizes it — no `/api/auth` prefix. */
  path: string;
  justification: string;
};

export const SUPPRESSED_AUTH_PATHS: readonly SuppressedAuthPath[] = [
  {
    path: "/list-sessions",
    justification:
      "Returns every one of the caller's live sessions through parseSessionOutput, " +
      "which filters by the session output schema — and `token` carries no " +
      "`returned: false`, so each row arrives with its raw bearer token. One " +
      "compromised session therefore yields durable capture of all of them, and " +
      "the capture survives the victim revoking the session they know about. " +
      "Its guard is freshSessionMiddleware, whose freshAge defaults to a day, so " +
      "a session phished minutes ago is fresh enough to ask.",
  },
  {
    path: "/revoke-session",
    justification:
      "Takes `{ token }` as its only handle, so it is the consumer of what " +
      "/list-sessions leaks and has no legitimate caller once that path is gone: " +
      "the only token a client can still hold is its own, which sign-out ends. " +
      "Revoking by an opaque id belongs to the consumer route that owns the " +
      "shaped list. /revoke-sessions and /revoke-other-sessions take no token " +
      "and stay — they are the supported way to end a session whose token the " +
      "caller cannot obtain.",
  },
];

/** The paths alone, in the shape Better Auth's `disabledPaths` option takes. */
export const SUPPRESSED_AUTH_PATH_LIST: readonly string[] = SUPPRESSED_AUTH_PATHS.map(
  (entry) => entry.path,
);
