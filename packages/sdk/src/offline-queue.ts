/**
 * Offline-first operation queue (issue #54).
 *
 * POS clients must keep selling through network drops. This queue persists
 * write operations (pluggable storage), stamps each with an idempotency key
 * (core replays `POST /api/orders` / `POST /api/checkout` with the same key
 * and returns the original order), and drains on reconnect with backoff.
 * Queue state — pending/failed plus server error bodies — is observable, and
 * failed operations support manual retry/drop.
 */

export interface QueuedOperation {
  /** Unique id; also stamped into the body as `idempotencyKey`. */
  id: string;
  path: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  body: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  status: "pending" | "failed";
  lastError?: { status?: number | undefined; body?: unknown; message: string } | undefined;
}

export interface QueueStorage {
  load(): Promise<QueuedOperation[]> | QueuedOperation[];
  save(operations: QueuedOperation[]): Promise<void> | void;
}

/** Volatile storage — tests and environments without persistence. */
export function memoryStorage(): QueueStorage {
  let operations: QueuedOperation[] = [];
  return {
    load: () => operations,
    save: (next) => {
      operations = next;
    },
  };
}

/** Storage backed by any localStorage-compatible object (web, RN shims). */
export function webStorage(
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void },
  key = "porulle.offline-queue",
): QueueStorage {
  return {
    load: () => {
      try {
        const raw = storage.getItem(key);
        return raw ? (JSON.parse(raw) as QueuedOperation[]) : [];
      } catch {
        return [];
      }
    },
    save: (operations) => {
      storage.setItem(key, JSON.stringify(operations));
    },
  };
}

export interface OfflineQueueOptions {
  /** Base URL of the commerce server (e.g. "https://api.example.com"). */
  baseUrl: string;
  /** Headers sent with every replayed request (e.g. Authorization). */
  headers?: Record<string, string> | undefined;
  /** Where operations persist. Default: in-memory. */
  storage?: QueueStorage | undefined;
  /** Custom fetch (testing, RN). Default: globalThis.fetch. */
  fetch?: typeof globalThis.fetch | undefined;
  /** Attempts before a retryable failure is marked `failed`. Default: 5. */
  maxAttempts?: number | undefined;
  /** Base backoff delay in ms (doubles per attempt, capped at 60s). Default: 1000. */
  backoffMs?: number | undefined;
  /** Listen for the window `online` event and auto-flush. Default: true when available. */
  autoFlush?: boolean | undefined;
  /** Field name stamped into the body. Default: "idempotencyKey". */
  idempotencyField?: string | undefined;
}

export interface QueueState {
  pending: number;
  failed: number;
  operations: QueuedOperation[];
}

type Listener = (state: QueueState) => void;

function generateId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// 408 (timeout) and 429 (rate limit) are worth retrying; other 4xx are the
// server telling us the operation itself is wrong.
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

export class OfflineQueue {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string> | undefined;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly idempotencyField: string;
  private readonly storage: QueueStorage;
  private operations: QueuedOperation[] = [];
  private listeners = new Set<Listener>();
  private loaded: Promise<void>;
  private flushing = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onlineHandler = () => {
    void this.flush();
  };

  constructor(options: OfflineQueueOptions) {
    this.baseUrl = options.baseUrl;
    this.headers = options.headers;
    this.fetchImpl = options.fetch;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.backoffMs = options.backoffMs ?? 1000;
    this.idempotencyField = options.idempotencyField ?? "idempotencyKey";
    this.storage = options.storage ?? memoryStorage();
    this.loaded = Promise.resolve(this.storage.load()).then((ops) => {
      this.operations = ops;
    });

    const target = (globalThis as { addEventListener?: (t: string, h: () => void) => void });
    if ((options.autoFlush ?? true) && typeof target.addEventListener === "function") {
      target.addEventListener("online", this.onlineHandler);
    }
  }

  /** Stops timers and the online listener. */
  dispose(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    const target = (globalThis as { removeEventListener?: (t: string, h: () => void) => void });
    if (typeof target.removeEventListener === "function") {
      target.removeEventListener("online", this.onlineHandler);
    }
  }

  /**
   * Enqueues an operation with an idempotency key stamped into the body.
   * Resolves once the operation is durably queued — call `flush()` (or rely
   * on the `online` listener / backoff timer) to deliver it.
   */
  async enqueue(
    path: string,
    body: Record<string, unknown>,
    opts?: { method?: QueuedOperation["method"] | undefined; idempotencyKey?: string | undefined },
  ): Promise<QueuedOperation> {
    await this.loaded;
    const id = opts?.idempotencyKey ?? generateId();
    const operation: QueuedOperation = {
      id,
      path,
      method: opts?.method ?? "POST",
      body: { ...body, [this.idempotencyField]: id },
      createdAt: new Date().toISOString(),
      attempts: 0,
      status: "pending",
    };
    this.operations.push(operation);
    await this.persist();
    return operation;
  }

  /** Current queue state (pending/failed counts + operations with errors). */
  async state(): Promise<QueueState> {
    await this.loaded;
    return {
      pending: this.operations.filter((op) => op.status === "pending").length,
      failed: this.operations.filter((op) => op.status === "failed").length,
      operations: [...this.operations],
    };
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-queues a failed operation for the next flush. */
  async retry(id: string): Promise<void> {
    await this.loaded;
    const operation = this.operations.find((op) => op.id === id);
    if (operation && operation.status === "failed") {
      operation.status = "pending";
      operation.attempts = 0;
      operation.lastError = undefined;
      await this.persist();
      void this.flush();
    }
  }

  /** Drops an operation from the queue entirely. */
  async drop(id: string): Promise<void> {
    await this.loaded;
    this.operations = this.operations.filter((op) => op.id !== id);
    await this.persist();
  }

  /**
   * Drains pending operations FIFO. Network-level failures stop the drain
   * (we're offline) and schedule a backoff retry; HTTP failures mark the
   * operation failed (non-retryable) or retry it (5xx/408/429).
   */
  async flush(): Promise<QueueState> {
    await this.loaded;
    if (this.flushing) return this.state();
    this.flushing = true;
    try {
      const fetchImpl = this.fetchImpl ?? globalThis.fetch;
      for (const operation of [...this.operations]) {
        if (operation.status !== "pending") continue;

        let response: Response;
        try {
          response = await fetchImpl(`${this.baseUrl}${operation.path}`, {
            method: operation.method,
            headers: { "content-type": "application/json", ...this.headers },
            body: JSON.stringify(operation.body),
          });
        } catch (error) {
          // Network down — keep everything pending and back off.
          operation.attempts += 1;
          operation.lastError = { message: error instanceof Error ? error.message : String(error) };
          await this.persist();
          this.scheduleRetry(operation.attempts);
          return this.state();
        }

        if (response.ok) {
          this.operations = this.operations.filter((op) => op.id !== operation.id);
          await this.persist();
          continue;
        }

        operation.attempts += 1;
        let errorBody: unknown;
        try {
          errorBody = await response.clone().json();
        } catch {
          errorBody = undefined;
        }
        operation.lastError = {
          status: response.status,
          body: errorBody,
          message: `HTTP ${response.status}`,
        };
        if (!isRetryableStatus(response.status) || operation.attempts >= this.maxAttempts) {
          operation.status = "failed";
        } else {
          this.scheduleRetry(operation.attempts);
        }
        await this.persist();
      }
      return this.state();
    } finally {
      this.flushing = false;
    }
  }

  private scheduleRetry(attempts: number): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    const delay = Math.min(this.backoffMs * 2 ** (attempts - 1), 60_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flush();
    }, delay);
    // Never keep a Node.js process alive just for a queue retry.
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  private async persist(): Promise<void> {
    await this.storage.save([...this.operations]);
    const state: QueueState = {
      pending: this.operations.filter((op) => op.status === "pending").length,
      failed: this.operations.filter((op) => op.status === "failed").length,
      operations: [...this.operations],
    };
    for (const listener of this.listeners) listener(state);
  }
}
