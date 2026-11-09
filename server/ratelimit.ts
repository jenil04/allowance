/** In-memory sliding-window limiter for LLM calls: 60/hour/IP, 400/day global. */
export class LlmLimiter {
  private perIp = new Map<string, number[]>();
  private global: number[] = [];
  constructor(private ipPerHour = 60, private globalPerDay = 400, private now = () => Date.now()) {}
  /** Returns true and records the call if allowed. */
  take(ip: string): boolean {
    const t = this.now();
    this.global = this.global.filter((x) => t - x < 86_400_000);
    const ips = (this.perIp.get(ip) ?? []).filter((x) => t - x < 3_600_000);
    if (this.global.length >= this.globalPerDay || ips.length >= this.ipPerHour) { this.perIp.set(ip, ips); return false; }
    ips.push(t); this.global.push(t); this.perIp.set(ip, ips);
    return true;
  }
}
