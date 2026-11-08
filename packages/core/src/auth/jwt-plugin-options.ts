import { jwt } from "better-auth/plugins";

/** Options forwarded into Better Auth's `jwt()` plugin. */
export type JwtPluginOptions = NonNullable<Parameters<typeof jwt>[0]>;
