type Bucket = {
  count: number;
  resetAt: number;
};

export class InMemoryRateLimiter {
  private readonly buckets = new Map<number, Bucket>();
  private checks = 0;

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  allow(userId: number, now = Date.now()): boolean {
    this.checks += 1;
    if (this.checks % 100 === 0) {
      this.removeExpired(now);
    }

    const bucket = this.buckets.get(userId);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(userId, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (bucket.count >= this.maxRequests) {
      return false;
    }

    bucket.count += 1;
    return true;
  }

  private removeExpired(now: number): void {
    for (const [userId, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(userId);
      }
    }
  }
}
