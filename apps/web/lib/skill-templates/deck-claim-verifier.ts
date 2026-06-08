import { defineSkillTemplate, externalApps } from "./create-template";

export const deckClaimVerifier = defineSkillTemplate({
  id: "deck-claim-verifier",
  title: "Deck Claim Verifier",
  summary: "Extract claims from a deck and verify each one against explicit evidence.",
  category: "Research Anything",
  outcome: "Turns a pitch deck or narrative doc into a claim table with verification status, source support, caveats, and open questions.",
  userUseCase:
    "Use when an investor, founder, or strategy operator receives a deck or memo with quantitative, customer, funding, market, or competitive claims that need fast trust checks. The skill should extract each material claim, try to verify it from preferred sources, and clearly mark what could not be proven.",
  personas: ["Investor/BD", "Founder", "Knowledge Worker"],
  requiredApps: [externalApps.hubspot, externalApps.notion],
  triggerModes: ["manual"],
  autonomy: "Creates drafts",
  interviewQuestions: [
    {
      id: "deck-source",
      prompt: "Which deck, memo, or uploaded file should be verified?",
      required: true,
      freeformHint:
        "Provide a file, pasted text, URL, or workspace artifact containing the claims to review.",
    },
    {
      id: "claim-types",
      prompt: "Which claim types should be extracted and checked?",
      required: true,
      allowMultiple: true,
      options: [
        { id: "metrics", label: "Metrics and growth" },
        { id: "customers", label: "Customers or logos" },
        { id: "market-size", label: "Market size" },
        { id: "funding", label: "Funding or ownership" },
        { id: "competitors", label: "Competitors" },
        { id: "product", label: "Product capabilities" },
      ],
    },
    {
      id: "source-standard",
      prompt: "What source standard should the verifier use?",
      required: true,
      options: [
        { id: "primary-only", label: "Primary sources only" },
        { id: "trusted-plus-primary", label: "Trusted news plus primary" },
        { id: "broad-with-labels", label: "Broad scan with labels" },
        { id: "provided-docs-only", label: "Provided docs only" },
      ],
    },
    {
      id: "verification-threshold",
      prompt: "How strict should the status labels be?",
      required: true,
      options: [
        { id: "strict", label: "Strict: exact support required" },
        { id: "balanced", label: "Balanced: partial support allowed" },
        { id: "triage", label: "Triage: flag only risky claims" },
      ],
    },
    {
      id: "output-audience",
      prompt: "Who will use the verification output?",
      required: true,
      options: [
        { id: "investment-team", label: "Investment team" },
        { id: "founder", label: "Founder" },
        { id: "sales-bd", label: "Sales or BD" },
        { id: "internal-review", label: "Internal review" },
      ],
      freeformHint: "Include desired length, citation format, and whether to include private notes.",
    },
  ],
  skillInstructions: [
    "Extract every material factual claim before researching; keep the original wording and slide or section reference.",
    "Verify claims against uploaded decks/docs, HubSpot/Dench CRM evidence, Notion/files, native enrichment, and public primary or trusted sources depending on the selected source standard.",
    "Classify each claim as Verified, Partial, Unable to verify, Contradicted, or Out of scope with a short rationale.",
    "For Verified and Partial claims, include the exact supporting quote or data point and source URL or file reference.",
    "Do not fill gaps with plausible facts; if a claim cannot be supported, mark it Unable to verify and list the sources checked.",
    "Separate source quality from confidence so users can see when a claim is supported only by weak or promotional sources.",
    "End with the riskiest unsupported claims, recommended follow-up questions, and claims safe to repeat externally.",
  ],
  activityLogInstructions: [
    "Append verification entries to the claim table or research report, keyed by deck/file version and verification run timestamp.",
    "Log claims extracted, slide or section references, source standard used, sources checked, status changes, contradictions found, and out-of-scope claims.",
    "For each material claim, record original wording, verification label, supporting quote or missing-evidence note, source quality, confidence, and recommended follow-up question.",
    "On reruns, log only changed claim statuses, new evidence, newly contradicted claims, and claims removed because the source deck changed.",
  ],
});
