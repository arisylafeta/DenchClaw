import { DismantlerError } from "./crm-postgres/dismantlers";
import { badRequest, linkedWrite } from "./bulk-trades-route";

export { guardBulkTrades as guardDismantlers, notFound, readJson, badRequest } from "./bulk-trades-route";

/** Runs a write; a rule the data layer refuses, or a missing linked record, becomes a 400. */
export function dismantlerWrite(write: () => Promise<Response>): Promise<Response> {
  return linkedWrite(async () => {
    try {
      return await write();
    } catch (err) {
      if (err instanceof DismantlerError) return badRequest(err.message);
      throw err;
    }
  });
}
