# Bangkok Plot Feasibility

An early development feasibility screen for the verified ย.๙-๑๓ sample area in Din Daeng, Bangkok. The initial plot is an editable scenario beside Pracha Suk Road. The map shows the study coverage and labels the scenario and inferred right-of-way edges.

## Run and verify

Use Node 20.19+ or 22.12+ and a WebGL2-capable browser.

```sh
npm ci
npm run dev
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

To run the same browser checks against the deployed build, set `FEASIBILITY_URL` to the public origin. Keep the matching local `dist` because the tests identify the hashed worker asset from that build. Playwright writes verification screenshots under `artifacts/`.

## Evidence and scope

- [Phase 1 research](PHASE-1-RESEARCH.md) records the statutory clauses and zoning evidence.
- [Implementation evidence](research/IMPLEMENTATION-EVIDENCE.md) records the source extracts, assumptions and reproduction commands. [The public data manifest](public/data/manifest.json) credits the shipped neighborhood data.
- The applicant’s raw transcript, BMA downloads and original research PDF are kept locally outside the published site and Git source.
- The product estimates building massing for small detached houses and standalone multifamily buildings. It reports zoning ceilings, geometric bounds, profile limits and generated designs as distinct quantities. Site-dependent rule results retain their evidence status.

## Modeling decisions

- The house profile explores up to two floors. The multifamily profile explores up to six 3.2 m floors, up to 1,000 m² of new GFA, and below the 23 m high-rise threshold. The stepped form triggers MR55 special-building review when it exceeds 15 m. Structural spans, egress, accessibility and parking remain design review items.
- MR55 §50 sees the candidate’s entire height before floor clipping. BMA §54 separately checks floor level. MR55 §41 and BMA §50 have distinct eligibility branches. BMA §55 clearance is modeled conservatively within the parcel. Each floor slice uses its top elevation against the road height plane, with a common level datum and straight selected road segment.
- Eligible site area is the FAR denominator. OSR uses the total modeled site GFA. The separate building-control tests use site area and largest-floor area. The planting check uses the qualifying uncovered open area. Uncovered area is based on the union of covered projections. Retained structures with missing or straddling GFA keep aggregate compliance conditional.
- A what-if width moves modeled road edges around the fixed mapped centerline. The parcel and its area stay fixed. Overlaps and unsupported frontage are surfaced. A plot without a verified title or surveyed edges remains a scenario. No floor-area bonuses, blind-wall exceptions, multi-road rules or high-rise provisions are used to increase capacity.
