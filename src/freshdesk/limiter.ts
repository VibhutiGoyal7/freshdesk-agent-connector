/**
 * Rate limiting and concurrency control.
 *
 * Two separate concerns, deliberately kept apart:
 *
 *  1. A token bucket sized to the merchant's plan limit, so we stay *under* the
 *     ceiling instead of discovering it by getting 429s. Being throttled is not
 *     a neutral event for an agent: the model has already spent tokens deciding
 *     to make the call.
 *  2. A concurrency gate, because a single agent turn can fan out into a dozen
 *     parallel tool calls and a helpdesk is not a load target.
 *
 * On an actual 429 we still honour Retry-After and drain the bucket, because the
 * server's view of the limit is authoritative and ours is an estimate.
 */

export class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private lastRefill: number;

  constructor(perMinute: number, private readonly now: () => number = Date.now) {
    this.capacity = perMinute;
    this.tokens = perMinute;
    this.refillPerMs = perMinute / 60_000;
    this.lastRefill = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = t;
  }

  /** Milliseconds until a token is available. 0 means "go now". */
  delayMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }

  take(): void {
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  /**
   * Reserve a token now and return how long to wait before using it. Unlike
   * delayMs()+take(), parallel callers each get their own slot: an empty bucket
   * hands the first caller 0 ms, the second one refill interval, and so on,
   * rather than waking all of them together.
   */
  reserve(): number {
    this.refill();
    this.tokens -= 1;
    return this.tokens >= 0 ? 0 : Math.ceil(-this.tokens / this.refillPerMs);
  }

  /** Freshdesk's X-RateLimit-Remaining is authoritative; never believe we have more than it says. */
  syncTo(remaining: number): void {
    this.refill();
    this.tokens = Math.min(this.tokens, remaining);
  }

  /** Called after a real 429: assume our estimate was wrong and stop entirely. */
  drain(): void {
    this.refill();
    this.tokens = Math.min(0, this.tokens);
  }

  get available(): number {
    this.refill();
    return Math.max(0, Math.floor(this.tokens));
  }
}

export class ConcurrencyGate {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    return () => this.release();
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** Full jitter backoff: attempt 0 -> [0, base), attempt 1 -> [0, 2*base), capped. */
export function backoffMs(attempt: number, baseMs = 500, capMs = 20_000, rand = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(rand() * ceiling);
}

export const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
