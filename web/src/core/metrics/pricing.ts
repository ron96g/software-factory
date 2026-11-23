import type { ModelPricing, TokenTotals } from "../ports/index.ts";

/**
 * ADR-0052: an **optional**, versioned price schedule for estimates (USD per 1,000,000 tokens). Nothing is assumed:
 * with no schedule configured, `estimate` matches nothing and the metrics omit cost rather than guess. Prices are
 * supplied by the operator (a definitions file or `FACTORY_MODEL_PRICES`), never invented here.
 */
export interface PriceEntry {
  /** Matched against the lower-cased model id by substring, e.g. a model family prefix. */
  prefix: string;
  /** USD per 1,000,000 prompt (input) tokens. */
  prompt: number;
  /** USD per 1,000,000 completion (output) tokens. */
  completion: number;
}

export interface PriceSchedule {
  version: string;
  source: string;
  prices: PriceEntry[];
}

export class DefaultModelPricing implements ModelPricing {
  readonly version?: string;
  readonly source?: string;
  private readonly prices: PriceEntry[];

  constructor(schedule?: PriceSchedule) {
    this.version = schedule?.version;
    this.source = schedule?.source;
    this.prices = schedule?.prices ?? [];
  }

  estimate(model: string, tokens: { prompt: number; completion: number }): { usd: number; matched: boolean } {
    const id = model.toLowerCase();
    const price = this.prices.find((p) => id.includes(p.prefix.toLowerCase()));
    if (!price) return { usd: 0, matched: false };
    const usd = (tokens.prompt / 1_000_000) * price.prompt + (tokens.completion / 1_000_000) * price.completion;
    return { usd, matched: true };
  }
}

export const zeroTokens = (): TokenTotals => ({ prompt: 0, completion: 0, total: 0 });
