import { describe, expect, it } from "vitest";
import { hashCrmBootstrapUsers, readCrmBootstrapUsers } from "./crm-bootstrap";

const validEnv = {
  CRM_BOOTSTRAP_PASSWORD_ARI: "ari-password-1234",
  CRM_BOOTSTRAP_PASSWORD_ALEX: "alex-password-5678",
};

describe("CRM bootstrap credentials", () => {
  it("requires separate runtime secrets for Ari and Alex", () => {
    expect(() =>
      readCrmBootstrapUsers({
        CRM_BOOTSTRAP_PASSWORD_ARI: validEnv.CRM_BOOTSTRAP_PASSWORD_ARI,
      }),
    ).toThrow("CRM_BOOTSTRAP_PASSWORD_ALEX");
    expect(() =>
      readCrmBootstrapUsers({
        CRM_BOOTSTRAP_PASSWORD_ALEX: validEnv.CRM_BOOTSTRAP_PASSWORD_ALEX,
      }),
    ).toThrow("CRM_BOOTSTRAP_PASSWORD_ARI");
  });

  it("pairs each password with only its allowlisted user", () => {
    const users = readCrmBootstrapUsers(validEnv);
    expect(users).toEqual([
      expect.objectContaining({
        email: "ari@rebattery.io",
        password: validEnv.CRM_BOOTSTRAP_PASSWORD_ARI,
      }),
      expect.objectContaining({
        email: "alex@rebattery.io",
        password: validEnv.CRM_BOOTSTRAP_PASSWORD_ALEX,
      }),
    ]);
  });

  it("hashes each user's password independently", async () => {
    const seen: string[] = [];
    const users = await hashCrmBootstrapUsers(async (password) => {
      seen.push(password);
      return `hash:${password}`;
    }, validEnv);

    expect(seen).toEqual([
      validEnv.CRM_BOOTSTRAP_PASSWORD_ARI,
      validEnv.CRM_BOOTSTRAP_PASSWORD_ALEX,
    ]);
    expect(users.map((user) => user.passwordHash)).toEqual([
      `hash:${validEnv.CRM_BOOTSTRAP_PASSWORD_ARI}`,
      `hash:${validEnv.CRM_BOOTSTRAP_PASSWORD_ALEX}`,
    ]);
  });

  it("rejects a shared password", () => {
    expect(() =>
      readCrmBootstrapUsers({
        CRM_BOOTSTRAP_PASSWORD_ARI: "shared-password-1234",
        CRM_BOOTSTRAP_PASSWORD_ALEX: "shared-password-1234",
      }),
    ).toThrow("must be distinct");
  });

  it("validates each password independently", () => {
    expect(() =>
      readCrmBootstrapUsers({
        ...validEnv,
        CRM_BOOTSTRAP_PASSWORD_ALEX: "too-short",
      }),
    ).toThrow(
      "CRM_BOOTSTRAP_PASSWORD_ALEX must be between 12 and 1024 characters",
    );
  });
});
