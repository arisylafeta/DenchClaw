export const MAX_SUBSCRIPTIONS = 64;
export const MAX_SUBSCRIPTION_KEY_LENGTH = 2048;
export const MAX_SUBSCRIPTION_ID_LENGTH = 256;
export function validSubscriptionKeys(keys: unknown): keys is string[] {
  return Array.isArray(keys) && keys.length <= MAX_SUBSCRIPTIONS && keys.every(key => typeof key === "string" && key.length <= MAX_SUBSCRIPTION_KEY_LENGTH);
}
export function validSubscriptionIds(ids: unknown): ids is Record<string, string> {
  return Boolean(ids) && typeof ids === "object" && !Array.isArray(ids)
    && Object.entries(ids!).length <= MAX_SUBSCRIPTIONS
    && Object.entries(ids!).every(([key, id]) => key.length <= MAX_SUBSCRIPTION_KEY_LENGTH && typeof id === "string" && id.length <= MAX_SUBSCRIPTION_ID_LENGTH);
}
