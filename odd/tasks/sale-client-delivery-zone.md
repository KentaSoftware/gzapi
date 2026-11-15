# Sale client delivery zone

## Objective and constraints
Show each customer's delivery zone in the sales client selector while preserving name, address, ID, pagination, sale-only permissions and sale behavior. Extend the existing sale-options response additively with the resolved zone name, including a safe missing-zone state. Do not expose unrelated fields or change authorization. Preserve `.env.local`. Frontend work is in the original `gestion-web-gz` repository on `feat/operational-ux-improvements`.

## Tasks
- [x] SCZ-1 Backend: provide a zone name in sale-options and test missing zones, pagination and sale-only access. Route: delegated direct; service and tests. 15 focused tests passed; independent review passed, real MongoDB unverified; targeted lint passed, full lint fails on unrelated files.
- [x] SCZ-2 Frontend: display zone alongside existing identity details and test present and missing values. Route: delegated direct; component, types and tests. 19 focused tests passed, typecheck and lint passed with existing warnings, independently reviewed. Frontend changes remain uncommitted among ongoing UX work.
- [ ] SCZ-3 Verify cross-repository response and UI without altering sales. Route: delegated direct.

## Checks and delivery
Cross-repository browser and live database verification remain pending. A test invocation without the repository's transpile-only settings failed to typecheck test files; the documented runner settings passed all 15 tests.
Use backend `npm test`, `npm run lint` and focused tests where possible; frontend targeted Vitest, TypeScript and lint. Test-first for deterministic behavior. Estimated under 400 authored lines; ask-on-risk if scope exceeds forecast. Engram mirror pending until synchronized. No push or PR without explicit authorization.
