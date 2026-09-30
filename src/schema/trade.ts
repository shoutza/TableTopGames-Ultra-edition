/**
 * Trade terms as a contestant writes them, from its own side: `give` is what it hands over, `get`
 * what it receives. The engine turns them into canonical terms (proposer's side, item instances).
 */
export interface TradeOfferInput {
  /** The partner (proposals only; a counteroffer always goes back to the proposer). */
  with?: string | undefined;
  give?: GoodsInput | undefined;
  get?: GoodsInput | undefined;
  promises?: PromiseInput[] | undefined;
  message?: string | null | undefined;
}

export interface GoodsInput {
  resources?: Record<string, number> | undefined;
  /** Item definition ids (one entry per item; repeat an id to trade two of the same). */
  items?: string[] | undefined;
}

export type PromiseInput = { by: 'me' | 'them'; kind: 'noAttack'; rounds: number } | { by: 'me' | 'them'; kind: 'pay'; resource: string; amount: number; rounds: number };
