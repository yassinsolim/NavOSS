export class RerouteGate {
  private lastAttemptAt?: number;
  private requestInFlight = false;

  public constructor(private readonly retryCooldownMs: number) {}

  public shouldRequest(isOffRoute: boolean, now: number = Date.now()): boolean {
    if (!isOffRoute || this.requestInFlight) {
      return false;
    }

    if (this.lastAttemptAt !== undefined && now - this.lastAttemptAt < this.retryCooldownMs) {
      return false;
    }

    this.lastAttemptAt = now;
    this.requestInFlight = true;
    return true;
  }

  public completeRequest(): void {
    this.requestInFlight = false;
  }

  public resetSession(): void {
    this.lastAttemptAt = undefined;
    this.requestInFlight = false;
  }
}
