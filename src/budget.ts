/**
 * A subrequest budget for one Worker invocation.
 *
 * Cloudflare allows 50 outbound requests per invocation. Exceeding it does not
 * fail the invocation — it fails whatever happens to be running at the moment
 * the cap is hit, which has already cost us two recordings and, silently, a
 * notification publish. Both times the work looked fine in isolation and only
 * broke in combination.
 *
 * So the poll now decides up front what it can afford instead of finding out.
 * Anything it cannot afford is left for the next pass ten minutes later, which
 * is the whole point of having a poller: deferring work is free, losing it is
 * not.
 *
 * The counts are deliberate over-estimates. Being wrong in the direction of
 * doing less means a slower backlog; being wrong the other way means silent
 * data loss.
 */
export class Budget {
  private spent = 0

  constructor(private readonly ceiling: number) {}

  get remaining(): number {
    return Math.max(0, this.ceiling - this.spent)
  }

  /** Reserve up front, so a unit of work is never started half-funded. */
  tryClaim(cost: number): boolean {
    if (this.spent + cost > this.ceiling) return false
    this.spent += cost
    return true
  }

  toJSON() {
    return { spent: this.spent, remaining: this.remaining }
  }
}

/**
 * Cost estimates per unit of work, counted generously.
 *
 * A capture is the expensive one: fetch, dedupe, claim, candidates, the
 * planner call, the writes, and the final status update.
 */
export const COST = {
  /** listRecordings, the silence check, and the context reads. */
  pollSetup: 6,
  capture: 12,
  /** On top of capture, for a recording transcribed here: the audio link, the download, Whisper. */
  transcribe: 3,
  redo: 12,
} as const

/** Leaves room for the health check and any retry the client makes internally. */
export const POLL_CEILING = 42
