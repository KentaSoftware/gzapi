# Browse Active Clients in New Sales

## Objective
Show all active clients in the new-sale selector without requiring a search, while retaining bounded requests and search.

## Scope and constraints
- Only clients with `isActive: true` are selectable; inactive and undefined states remain excluded.
- Preserve explicit client ID selection, existing authorization, sale creation behavior, and legacy lookup callers.
- Use the original `gzapi` and `gestion-web-gz` repositories; do not create worktrees, mutate databases, or publish without separate authorization.
- Delivery strategy: `single-pr` per repository, with the user-approved size exception. API and Web must be deployed together.

## Tasks
- [x] SCB-1: Add backward-compatible bounded cursor pagination for browsing and searching active clients in the sale-options API. Route: delegated direct; trigger: controller, service and security-sensitive tests. Mocked focused suite: 14 passing; TypeScript and targeted lint passed. Missing-name active clients display `Sin nombre` but existing sale creation rejects them; no stored names were fabricated.
- [x] SCB-2: Show the first active-client page when the existing dropdown opens and allow reaching every page and searching, retaining selection and error states. Route: delegated direct; trigger: multi-file UI and service integration. Mocked focused suite: 24 passing; TypeScript passed; lint passed with three existing image warnings. Browser/live integration and full suites were not run.

## Progress and next step
Original API `master` starts at `dd07975`; original Web `main` starts at `69867f1`. Feature branches `feat/sale-client-browse` created in both original repos. `.env.local` and the pre-existing Web tracker are unrelated and must be preserved. No database or provider calls authorized. Full API suite may be unsafe because integration tests can drop databases.

The user chose one branch per repository with a size exception. Independent review identified and the writer fixed continuation-page retry and debounce behavior. Existing sale creation still refuses a client with no stored name; the selector displays such active clients without fabricating data. Pagination is not a snapshot under concurrent record changes. No remote push or PR is authorized yet.

Work-unit commits: API `55e2c86`; Web `543e76b`. Receipt-driven development is disabled in both clones; delivery is unmanaged. Next: validate the integrated flow when authorized and decide how to handle active clients without stored names.
