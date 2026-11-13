# Confirm Manual Coordinates for Routes

## Objective
Allow authorized confirmation of manually verified coordinates without requiring a real street address, and accurately display route candidate location and zone information.

## Scope and constraints
- Preserve manual provenance, authorization, and confirmation audit; never fabricate Google results or place IDs.
- User verified the coordinates for Almacén Rincón del Alba and Kiosco Ronda del Sol and authorized updating these two clients in local MongoDB test. Preserve sales and all other records.
- Use original repositories and local feature branches; no worktrees, remote publication, external routing provider, real sales, or route creation without further authorization.
- Preserve existing unrelated untracked files. Delivery strategy: one branch per repository with user-approved size exception.

## Tasks
- [x] MRC-1: Implement secure explicit manual coordinate confirmation and route eligibility without a real address; include candidate zone and precise missing-location information. Route: delegated direct; multi-file security-sensitive API and tests. Independent mocked verification: 80 passing; typecheck and targeted lint passed. Legacy tokenless writes retain last-write-wins behavior; revision safety requires all writers to participate.
- [x] MRC-2: Integrate manual confirmation and accurate zone/location states in the route UI with focused tests. Route: delegated direct; multi-file UI and tests. Focused mocked suite: 55 passing; typecheck and lint passed with three existing image warnings.
- [ ] MRC-3: Confirm exact local database identity and update only the two authorized clients with verified coordinates and honest manual provenance; verify read-only afterwards. Route: delegated direct; sensitive data update.

## Progress and next step
Branches `feat/manual-route-coordinates` start at API `a4de3a4` and Web `43bd6e9`. Live provider routing is not authorized or verified.

Independent verification led to fixes for compatibility, stale snapshots, authorization fixtures and seed revision handling. MongoDB server semantics and real cross-repository interaction remain unverified. Previously verified compatibility retains legacy last-write-wins semantics; old deployments or unversioned direct writers bypass revision protections. Deploy API before Web after draining older API instances.

Both clients still need confirmation by the authenticated actor after verifying the updated running API target and UI. No client records or sales were modified. Receipt-driven development is disabled; risk assessments were unavailable and treated as high; independent verification and focused checks were run. No external routing, push or PR was performed.
