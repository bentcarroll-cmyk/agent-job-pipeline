// What the radar may spend on X data. twitterapi.io bills per post returned,
// with a one-post minimum per request (provider pricing requires live acceptance verification).
export const PRICE_PER_POST_USD = 0.00015;
export const EXPAND_SHARE = 0.2;
export const PAGE_SIZE = 20;

export function requestCost(postsReturned: number): number {
  return Math.max(postsReturned, 1) * PRICE_PER_POST_USD;
}

export function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// This run's share of what's left this month, counting today, so underspend
// rolls forward and one heavy day can't starve the rest.
export function runAllowance(monthlyBudgetUsd: number, spentThisMonthUsd: number, now: Date): number {
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const daysLeft = daysInMonth - now.getUTCDate() + 1;
  return Math.max(0, (monthlyBudgetUsd - spentThisMonthUsd) / daysLeft);
}

export function splitAllowance(allowance: number): { collect: number; expand: number } {
  return { collect: allowance * (1 - EXPAND_SHARE), expand: allowance * EXPAND_SHARE };
}

// Running tally for one step. A request starts only while a full page still
// fits, so a step never overshoots its limit.
export class Meter {
  spent = 0;
  posts = 0;
  requests = 0;
  constructor(readonly limit: number) {}

  canAfford(): boolean {
    return this.spent + requestCost(PAGE_SIZE) <= this.limit + 1e-9;
  }

  record(postsReturned: number): void {
    this.spent += requestCost(postsReturned);
    this.posts += postsReturned;
    this.requests += 1;
  }
}
