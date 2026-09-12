export interface Actor {
  type: "user" | "api_key";
  userId: string | null;
  email: string | null;
  name: string;
  vendorId: string | null;
  organizationId: string | null;
  role: string;
  permissions: string[];
  /**
   * When this actor last proved who it is — the `createdAt` of the Better Auth
   * session behind it, as an ISO string. Absent for an actor with no session at
   * all (a job, an API key, a store resolver, a hand-built test actor), which a
   * step-up guard must treat as "cannot establish" and refuse, never as "recent".
   */
  sessionCreatedAt?: string | null;
}
