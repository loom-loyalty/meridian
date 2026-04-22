---
---

M7: Adopter docs closer for v0.1 GA.

Docs-only changes. No package version bumps. Establishes
`docs/` as the adopter-facing documentation tree alongside
`specs/` (which stays protocol-specification-only).

**New tree**

```
docs/
├── README.md                                   # index
├── errors/                                     # MRD-CF-* catalog
│   ├── README.md                               # index + envelope shape
│   ├── lifecycle.md                            # LC-001..005
│   ├── state.md                                # ST-001..003
│   ├── scheduling.md                           # SC-001..004
│   ├── transport.md                            # TR-001..003
│   ├── resources.md                            # RS-001..004
│   ├── experimental.md                         # EX-001..005
│   └── auth.md                                 # AU-001..003
└── guides/
    ├── define-agent-quickstart.md              # 10-line agent walked line by line
    ├── doctor-troubleshooting.md               # 7 checks + remediation
    ├── agent-card-security-schemes.md          # discovery + auth advertisement
    └── tenancy-invariants.md                   # 7 server-enforced guarantees
```

**Root README gets a Getting Started section** — 5-minute CLI
quickstart, links to each guide, one-click Deploy to Cloudflare
button pointing at `cf-hyperdrive-postgres`.

**`packages/runtime-cloudflare/README.md`** gets a Deploy-to-CF
button at the top + light copy polish on the Status section.

**`examples/cf-hyperdrive-postgres/DEPLOY.md`** updated: the "pull
state via /admin/state" placeholder is replaced with the real
`meridian inspect` command against `GET /admin/agents/:id`.

**What's NOT here**

- meridianprotocol.dev hosting for the error pages. URLs referenced
  throughout the runtime's `docUrl` fields (`https://meridianprotocol.dev/errors/...`)
  remain as the canonical target when the site ships. The markdown
  in `docs/errors/` is the source content.
- Hosted playground. Deferred to v0.2 per the DX review.
- Demo walkthrough video. Deferred — README prose + `meridian demo`
  CLI cover the same ground for now.
