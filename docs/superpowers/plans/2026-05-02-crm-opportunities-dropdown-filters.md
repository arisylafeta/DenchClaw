# CRM Opportunities Dropdown Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Opportunities filter chips with inline multi-select dropdown filters and let the opportunities table span the full profile width.

**Architecture:** Keep filtering client-side inside `CompanyProfile`. Represent each filter group as a set of selected values, render compact dropdown controls above the table, and apply AND-across-groups / OR-within-group filtering. Scope width changes to the Opportunities tab so other profile tabs keep their current readable layout.

**Tech Stack:** React, TypeScript, Vitest, Testing Library, existing CRM UI components.

---

### Task 1: Cover Dropdown Filter Behavior

**Files:**
- Modify: `apps/web/app/components/crm/company-profile.test.tsx`

- [ ] **Step 1: Write the failing test**

Update the existing opportunities filter test to expect inline dropdown controls instead of chip buttons. Assert that multi-select works, the clear button restores rows, and the full-width table wrapper is present.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/web test app/components/crm/company-profile.test.tsx`
Expected: FAIL because dropdown buttons and multi-select behavior do not exist yet.

### Task 2: Implement Dropdown Filters And Width

**Files:**
- Modify: `apps/web/app/components/crm/company-profile.tsx`

- [ ] **Step 1: Store each filter group as selected values**

Change opportunity filters from a single optional string per group to arrays of selected strings.

- [ ] **Step 2: Render inline dropdown filter controls**

Replace chip rows with compact dropdown buttons containing checkbox menu items.

- [ ] **Step 3: Apply multi-select filtering**

For each active group, keep rows whose value is included in that group selection. Keep search filtering unchanged.

- [ ] **Step 4: Scope full-width layout to Opportunities**

Use the existing `tab` value to remove the `max-w-4xl` constraint only for the Opportunities tab.

- [ ] **Step 5: Run focused tests**

Run: `pnpm --dir apps/web test app/components/crm/company-profile.test.tsx`
Expected: PASS.

### Task 3: Verify Regression Scope

**Files:**
- Test: `apps/web/app/api/crm/companies/[id]/route.test.ts`
- Test: `apps/web/app/components/crm/company-profile.test.tsx`
- Test: `apps/web/lib/workspace-tabs.test.ts`

- [ ] **Step 1: Run focused CRM regression tests**

Run: `pnpm --dir apps/web test app/api/crm/companies/[id]/route.test.ts app/components/crm/company-profile.test.tsx lib/workspace-tabs.test.ts`
Expected: PASS.

- [ ] **Step 2: Run lint on changed files**

Run: `pnpm exec oxlint apps/web/app/components/crm/company-profile.tsx apps/web/app/components/crm/company-profile.test.tsx`
Expected: 0 warnings and 0 errors.
