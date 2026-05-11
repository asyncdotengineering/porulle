/**
 * Shared helpers for all demo scripts.
 * These scripts communicate with the running server via HTTP.
 */

const BASE = process.env.API_URL ?? "http://localhost:4000";

// Use STORE_API_KEY env var in production, or dev-staff-key for local development
const API_KEY = process.env.STORE_API_KEY ?? "";

// Store session cookies for reuse
let sessionCookie: string | null = null;

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${BASE}${path}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": API_KEY,
    "origin": BASE,
  };

  // Add session cookie if we have one
  if (sessionCookie) {
    headers["cookie"] = sessionCookie;
  }

  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  // Capture session cookie for reuse (always update — supports switching users)
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    const sessionMatch = setCookie.match(/better-auth\.session_token=([^;]+)/);
    if (sessionMatch) {
      sessionCookie = `better-auth.session_token=${sessionMatch[1]}`;
    }
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// Sign in and get session
export async function signIn(
  email: string,
  password: string,
): Promise<{ userId: string; email: string }> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": BASE },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sign in failed: ${res.status} - ${text}`);
  }

  // Capture session cookie
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    const sessionMatch = setCookie.match(/better-auth\.session_token=([^;]+)/);
    if (sessionMatch) {
      sessionCookie = `better-auth.session_token=${sessionMatch[1]}`;
    }
  }

  const data = await res.json();
  return data as { userId: string; email: string };
}

/** Clear the current session — call before signing in as a different user. */
export function resetSession() {
  sessionCookie = null;
}

/** Register a new user via email/password and capture the session. */
export async function signUp(
  name: string,
  email: string,
  password: string,
): Promise<{ user: { id: string } }> {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": BASE },
    body: JSON.stringify({ email, password, name }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sign up failed: ${res.status} - ${text}`);
  }

  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    const sessionMatch = setCookie.match(/better-auth\.session_token=([^;]+)/);
    if (sessionMatch) {
      sessionCookie = `better-auth.session_token=${sessionMatch[1]}`;
    }
  }

  return res.json() as Promise<{ user: { id: string } }>;
}

export function log(label: string, data: unknown) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"─".repeat(60)}`);
  console.log(JSON.stringify(data, null, 2));
}

export function heading(title: string) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(60)}`);
}
