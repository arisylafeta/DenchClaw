# CRM Opportunities Search Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add client-side search and chip filters to the CRM company Opportunities tab, with a flatter full-table presentation.

**Architecture:** Keep filtering local to the already-loaded company profile payload. Add small reusable CRM list-control helpers inside `company-profile.tsx` for this focused change, then use them in `OpportunitiesTab`.

**Tech Stack:** React 19, Vitest, Testing Library, existing CRM component styles.

---

### Task 1: Opportunities Search And Chips

**Files:**
- Modify: `apps/web/app/components/crm/company-profile.test.tsx`
- Modify: `apps/web/app/components/crm/company-profile.tsx`

- [ ] **Step 1: Write failing test**
Add an interaction test that opens Opportunities, searches for `tesla`, filters urgency to `high`, and clears filters.

- [ ] **Step 2: Verify red**
Run: `pnpm --dir apps/web test app/components/crm/company-profile.test.tsx`
Expected: FAIL because the search input and filter chips do not exist.

- [ ] **Step 3: Implement minimal UI**
Add search state, filter chip state, local filtering, result count, clear filters button, and flatter table layout.

- [ ] **Step 4: Verify green**
Run: `pnpm --dir apps/web test app/components/crm/company-profile.test.tsx`
Expected: PASS.

- [ ] **Step 5: Focused regression check**
Run: `pnpm --dir apps/web test app/api/crm/companies/[id]/route.test.ts app/components/crm/company-profile.test.tsx lib/workspace-tabs.test.ts`
Expected: PASS.

## Self-Review

- Spec coverage: Covers search, chips, clear, count, and flatter table style.
- Placeholder scan: No placeholders remain.
- Type consistency: Uses existing `CommercialOpportunity` fields already rendered by the Opportunities tab.
