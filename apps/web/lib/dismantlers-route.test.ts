import { describe, expect, it } from "vitest";
import { DismantlerError } from "./crm-postgres/dismantlers";
import { dismantlerWrite } from "./dismantlers-route";

const failWith = (err: unknown) => dismantlerWrite(async () => { throw err; });

describe("dismantlerWrite", () => {
  it("turns refused rules and a company added twice at once into readable 400s", async () => {
    const refused = await failWith(new DismantlerError("Pick a company or type a name."));
    expect([refused.status, await refused.json()]).toEqual([400, { error: "Pick a company or type a name." }]);
    const twice = await failWith(Object.assign(new Error("duplicate key"), { code: "23505", constraint: "crm_dismantlers_company_id_key" }));
    expect([twice.status, await twice.json()]).toEqual([400, { error: "This company is already a dismantler." }]);
  });

  it("lets other database errors through", async () => {
    await expect(failWith(Object.assign(new Error("other"), { code: "23505", constraint: "something_else" }))).rejects.toThrow("other");
  });
});
