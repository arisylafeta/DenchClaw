import { DismantlerError } from "./crm-postgres/dismantlers";
import { badRequest, guardBulkTrades, linkedWrite } from "./bulk-trades-route";

export { notFound, readJson, badRequest } from "./bulk-trades-route";

export const guardDismantlers = () => guardBulkTrades("Dismantlers");

/**
 * Runs a write. A rule the data layer refuses, a missing linked record, or a company that became
 * a dismantler in the same moment (the unique company_id) becomes a 400 with a readable message.
 */
export function dismantlerWrite(write: () => Promise<Response>): Promise<Response> {
  return linkedWrite(async () => {
    try {
      return await write();
    } catch (err) {
      if (err instanceof DismantlerError) return badRequest(err.message);
      if ((err as { code?: string; constraint?: string }).code === "23505"
        && (err as { constraint?: string }).constraint === "crm_dismantlers_company_id_key") {
        return badRequest("This company is already a dismantler.");
      }
      throw err;
    }
  });
}
