// placeholder: replaced by the pricing branch
import "server-only";
import type { PriceFill, StockFit } from "./relay-price-types";

/** The stock that fits what the email asks for. Placeholder until the pricing branch lands: nothing fits. */
export async function stockFits(_itemId: string, _ownerId: string): Promise<StockFit[]> {
  return [];
}

/** Fills a draft's price markers with Relay's prices. Placeholder until the pricing branch lands: fills nothing. */
export async function priceDraft(_draftId: string, _ownerId: string): Promise<PriceFill[]> {
  return [];
}
