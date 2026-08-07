import { describe, expect, it } from "vitest";
import {
  displayObjectName,
  displayObjectNameSingular,
  splitObjectTokens,
} from "./object-display-name";

describe("splitObjectTokens", () => {
  it("splits snake_case", () => {
    expect(splitObjectTokens("vc_lead")).toEqual(["vc", "lead"]);
    expect(splitObjectTokens("yc_outreach")).toEqual(["yc", "outreach"]);
  });

  it("splits kebab-case", () => {
    expect(splitObjectTokens("vc-lead")).toEqual(["vc", "lead"]);
    expect(splitObjectTokens("my-company-list")).toEqual(["my", "company", "list"]);
  });

  it("splits camelCase and PascalCase", () => {
    expect(splitObjectTokens("vcLead")).toEqual(["vc", "lead"]);
    expect(splitObjectTokens("MyCompany")).toEqual(["my", "company"]);
    expect(splitObjectTokens("personOfInterest")).toEqual(["person", "of", "interest"]);
  });

  it("normalizes mixed input casing", () => {
    expect(splitObjectTokens("Yc_founder")).toEqual(["yc", "founder"]);
    expect(splitObjectTokens("VC_Lead")).toEqual(["vc", "lead"]);
  });

  it("handles all-caps acronym runs in PascalCase", () => {
    expect(splitObjectTokens("URLPath")).toEqual(["url", "path"]);
    expect(splitObjectTokens("APIKey")).toEqual(["api", "key"]);
  });

  it("collapses repeated and surrounding separators", () => {
    expect(splitObjectTokens("  VC___Lead  ")).toEqual(["vc", "lead"]);
    expect(splitObjectTokens("--vc--lead--")).toEqual(["vc", "lead"]);
  });

  it("returns [] for empty / nullish", () => {
    expect(splitObjectTokens("")).toEqual([]);
    expect(splitObjectTokens("   ")).toEqual([]);
    expect(splitObjectTokens(null as unknown as string)).toEqual([]);
    expect(splitObjectTokens(undefined as unknown as string)).toEqual([]);
  });
});

describe("displayObjectName (plural)", () => {
  it("handles the headline cases from the spec", () => {
    expect(displayObjectName("vc_lead")).toBe("VC Leads");
    expect(displayObjectName("Yc_founder")).toBe("YC Founders");
    expect(displayObjectName("my_company")).toBe("My Companies");
  });

  it("uses concise labels for loop monitoring objects", () => {
    expect(displayObjectName("automation_loop")).toBe("Loops");
    expect(displayObjectName("automation_loop_run")).toBe("Loop Runs");
  });

  it("does not all-cap regular words like 'My'", () => {
    expect(displayObjectName("my_company")).toBe("My Companies");
    expect(displayObjectName("my_lead")).toBe("My Leads");
  });

  it("supports kebab-case and camelCase identifiers", () => {
    expect(displayObjectName("vc-lead")).toBe("VC Leads");
    expect(displayObjectName("vcLead")).toBe("VC Leads");
    expect(displayObjectName("MyCompany")).toBe("My Companies");
  });

  it("uses irregular plurals for the last token", () => {
    expect(displayObjectName("person")).toBe("People");
    expect(displayObjectName("contact_person")).toBe("Contact People");
    expect(displayObjectName("child")).toBe("Children");
    expect(displayObjectName("datum")).toBe("Data");
  });

  it("leaves already-plural inputs alone", () => {
    expect(displayObjectName("people")).toBe("People");
    expect(displayObjectName("companies")).toBe("Companies");
    expect(displayObjectName("vc_leads")).toBe("VC Leads");
    expect(displayObjectName("yc_companies")).toBe("YC Companies");
  });

  it("uppercases known acronyms regardless of position", () => {
    expect(displayObjectName("ai_agent")).toBe("AI Agents");
    expect(displayObjectName("api_key")).toBe("API Keys");
    expect(displayObjectName("crm_event")).toBe("CRM Events");
    expect(displayObjectName("ceo")).toBe("CEOs");
    expect(displayObjectName("ceos")).toBe("CEOs");
    expect(displayObjectName("api")).toBe("APIs");
    expect(displayObjectName("apis")).toBe("APIs");
    expect(displayObjectName("vc")).toBe("VCs");
  });

  it("handles single-token, multi-token, and consonant-y endings", () => {
    expect(displayObjectName("influencer")).toBe("Influencers");
    expect(displayObjectName("opportunity")).toBe("Opportunities");
    expect(displayObjectName("address")).toBe("Addresses");
    expect(displayObjectName("process")).toBe("Processes");
    expect(displayObjectName("box")).toBe("Boxes");
    expect(displayObjectName("dish")).toBe("Dishes");
    expect(displayObjectName("yc_outreach")).toBe("YC Outreaches");
  });

  it("returns input untouched if nothing splits out", () => {
    expect(displayObjectName("")).toBe("");
  });
});

describe("displayObjectNameSingular", () => {
  it("returns singular forms of headline cases", () => {
    expect(displayObjectNameSingular("vc_lead")).toBe("VC Lead");
    expect(displayObjectNameSingular("Yc_founder")).toBe("YC Founder");
    expect(displayObjectNameSingular("my_company")).toBe("My Company");
  });

  it("uses concise singular labels for loop monitoring objects", () => {
    expect(displayObjectNameSingular("automation_loop")).toBe("Loop");
    expect(displayObjectNameSingular("automation_loop_run")).toBe("Loop Run");
  });

  it("singularizes already-plural inputs", () => {
    expect(displayObjectNameSingular("people")).toBe("Person");
    expect(displayObjectNameSingular("companies")).toBe("Company");
    expect(displayObjectNameSingular("opportunities")).toBe("Opportunity");
    expect(displayObjectNameSingular("addresses")).toBe("Address");
    expect(displayObjectNameSingular("boxes")).toBe("Box");
    expect(displayObjectNameSingular("dishes")).toBe("Dish");
  });

  it("leaves already-singular inputs alone", () => {
    expect(displayObjectNameSingular("vc_lead")).toBe("VC Lead");
    expect(displayObjectNameSingular("influencer")).toBe("Influencer");
    expect(displayObjectNameSingular("address")).toBe("Address");
  });

  it("preserves acronyms in non-final tokens", () => {
    expect(displayObjectNameSingular("api_key")).toBe("API Key");
    expect(displayObjectNameSingular("crm_event")).toBe("CRM Event");
  });

  it("recovers acronym uppercase when last token is a plural acronym", () => {
    expect(displayObjectNameSingular("ceos")).toBe("CEO");
    expect(displayObjectNameSingular("apis")).toBe("API");
    expect(displayObjectNameSingular("vc_ceos")).toBe("VC CEO");
  });
});
