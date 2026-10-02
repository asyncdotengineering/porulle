import { spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  await cp(src, dest, { recursive: true, force: true });
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

export function resolveFromCwd(path: string): string {
  return resolve(process.cwd(), path);
}

interface PackageJsonShape {
  version?: string;
  [key: string]: unknown;
}

export async function readCliVersion(): Promise<string | undefined> {
  const pkg = await readJson<PackageJsonShape>(resolve(cliPackageRoot, "package.json"));
  return pkg.version;
}

export function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

export function runProcess(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      ...options,
    });
    proc.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
      }
    });
    proc.on("error", rejectPromise);
  });
}

export function apiBaseUrl(raw: string | undefined): string {
  return (raw ?? "http://localhost:3000").replace(/\/$/, "");
}

export function bearerHeaders(token?: string): Record<string, string> {
  if (!token) return {};
  return { authorization: `Bearer ${token}` };
}

export async function requestJson<T>(
  baseUrl: string,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body: unknown,
  token?: string,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...bearerHeaders(token),
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string };
  };
  if (!response.ok) {
    const message = payload.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Request failed for ${method} ${path}: ${message}`);
  }

  if (payload.data === undefined) {
    throw new Error(`Expected data payload for ${method} ${path}.`);
  }

  return payload.data;
}
