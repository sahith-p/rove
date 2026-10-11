// Shared XRPL client per endpoint, with reconnect. Every engine instance in a process reuses one websocket.
// xrpl.js reconnects on its own after a dropped socket; `run()` adds: connect on demand (deduplicated),
// and retry of a call that failed because the socket was down or timed out.

import { Client, ConnectionError, RippledError } from "xrpl";

export const DEFAULT_WSS = "wss://s.altnet.rippletest.net:51233";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RunOptions {
  /** Extra attempts after a connection-level failure. Default 2. */
  retries?: number;
}

export class XrplConnection {
  readonly client: Client;
  private connecting: Promise<void> | null = null;
  private closed = false;

  constructor(readonly url: string) {
    this.client = new Client(url, { timeout: 20_000, connectionTimeout: 15_000 });
    // Without a listener, a socket error event would be thrown as an uncaught exception.
    this.client.on("error", () => undefined);
  }

  async connect(): Promise<Client> {
    if (this.closed) throw new Error(`XRPL connection to ${this.url} was closed`);
    if (this.client.isConnected()) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        let lastErr: unknown;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            if (!this.client.isConnected()) await this.client.connect();
            return;
          } catch (err) {
            lastErr = err;
            await sleep(500 * 2 ** attempt);
          }
        }
        throw new Error(`could not connect to XRPL at ${this.url}: ${errorMessage(lastErr)}`);
      })().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
    return this.client;
  }

  /** Run `fn` against a connected client; reconnect and retry if the socket was the problem. */
  async run<T>(fn: (client: Client) => Promise<T>, opts: RunOptions = {}): Promise<T> {
    const retries = opts.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const client = await this.connect();
      try {
        return await fn(client);
      } catch (err) {
        if (attempt >= retries || !isConnectionError(err)) throw err;
        await sleep(400 * 2 ** attempt);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.client.isConnected()) await this.client.disconnect();
  }
}

const connections = new Map<string, XrplConnection>();

/** The process-wide connection for `url` (created on first use). */
export function getConnection(url: string = DEFAULT_WSS): XrplConnection {
  let conn = connections.get(url);
  if (!conn) {
    conn = new XrplConnection(url);
    connections.set(url, conn);
  }
  return conn;
}

/** Close and forget the shared connection(s), e.g. at the end of a script. */
export async function closeConnections(url?: string): Promise<void> {
  const targets = url ? [url] : [...connections.keys()];
  for (const u of targets) {
    const c = connections.get(u);
    connections.delete(u);
    if (c) await c.close();
  }
}

export function isConnectionError(err: unknown): boolean {
  if (err instanceof ConnectionError) return true; // NotConnected, Disconnected, Timeout, …
  const msg = errorMessage(err);
  return /websocket|socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|not connected|disconnected/i.test(msg);
}

/** rippled error code of a failed request (e.g. "actNotFound", "entryNotFound"), if any. */
export function rippledErrorCode(err: unknown): string | undefined {
  if (err instanceof RippledError) {
    const data = err.data as { error?: string } | undefined;
    return data?.error;
  }
  const data = (err as { data?: { error?: string } } | null)?.data;
  return typeof data?.error === "string" ? data.error : undefined;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
