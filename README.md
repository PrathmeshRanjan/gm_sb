# Bangkok Plot Feasibility

An early development feasibility screen for the full statutory ย.๙-๑๓ residential zone in Din Daeng, Bangkok (about 2.656 km²). The initial plot is an editable scenario beside Pracha Suk Road. Explore any part of the zone, draw a parcel, select a nearby mapped road, and enter its right-of-way width. Three illustrative sites outside the original study rectangle provide reproducible demonstrations. Parcel boundaries, inferred road edges, and site suitability remain scenario assumptions requiring verification.

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

To run the same browser checks against a deployed build, set `FEASIBILITY_URL` to the public application URL with a trailing slash. Keep the matching local `dist` because the tests identify the hashed worker asset from that build. Set `FEASIBILITY_HARDWARE_WEBGL=1` to open Chromium with the laptop's default WebGL renderer. Playwright writes verification screenshots under `artifacts/`. The relative Vite base supports either root or repository-subpath static hosting.

## Evidence and scope

- [Phase 1 research](PHASE-1-RESEARCH.md) records the statutory clauses and zoning evidence.
- [Implementation evidence](research/IMPLEMENTATION-EVIDENCE.md) records the source extracts, assumptions and reproduction commands. [The public data manifest](public/data/manifest.json) credits the shipped neighborhood data.
- [V4 geographic coverage and source audit](research/ZONE-COVERAGE.md) identifies the actual zone feature, its government open-data reuse basis, overlay restrictions, data acquisition and geographic examples. There are 9,826 Overture footprints and 1,565 complete mapped OSM road ways in a 200 m zone context buffer. Two source-reported heights have unknown measurement method; 484 are floor-count estimates and 9,340 are schematic extrusions. The 4.28 MB JSON bundle compresses to about 743 kB and loads once for local edits. It needs no source credentials.
- [Numerical review](research/NUMERICAL-REVIEW.md) documents the clearance construction, verifier tolerances, displayed floor arithmetic, and stress fixture.
- [Final V4 verification checkpoint](research/V4-VERIFICATION.md) reports the actual engine and browser results for the three new locations, tests and measured performance, including the final east numerical stability correction. [Screenshot gallery source](public/evidence/v4/index.html) distinguishes original and edited scenarios.
- The applicant’s raw transcript, BMA downloads and original research PDF are kept locally outside the published site and Git source.
- The product estimates building massing for small detached houses and standalone multifamily buildings. It reports zoning ceilings, geometric bounds, profile limits and generated designs as distinct quantities. Site-dependent rule results retain their evidence status.

## Modeling decisions

- The house profile explores up to two floors. The multifamily profile explores up to six 3.2 m floors, up to 1,000 m² of new GFA, and below the 23 m high-rise threshold. The stepped form triggers MR55 special-building review when it exceeds 15 m. Structural spans, egress, accessibility and parking remain design review items.
- MR55 §50 sees the candidate’s entire height before floor clipping. BMA §54 separately checks floor level. MR55 §41 and BMA §50 have distinct eligibility branches. BMA §55 clearance is modeled conservatively within the parcel. Each floor slice uses its top elevation against the road height plane, with a common level datum and straight selected road segment.
- Eligible site area is the FAR denominator. OSR uses the total modeled site GFA. The separate building-control tests use site area and largest-floor area. The planting check uses the qualifying uncovered open area. Uncovered area is based on the union of covered projections. Retained structures with missing or straddling GFA keep aggregate compliance conditional.
- A what-if width moves modeled road edges around the fixed mapped centerline. The parcel and its area stay fixed. Overlaps and unsupported frontage are surfaced. A plot without a verified title or surveyed edges remains a scenario. No floor-area bonuses, blind-wall exceptions, multi-road rules or high-rise provisions are used to increase capacity.
- The worker uses GEOS full-polygon containment for zone and context eligibility, including holes and separate components. It distinguishes out-of-zone parcels, unavailable context, and unsupported conditions. The browser supports drawing/editing single exterior-ring polygons (up to 1,500 vertices in the engine; holes are supported by the engine fixtures but the browser has no hole or multiparcel drawing control).
- Nearby-road selection uses actual mapped ways and uniquely connected same-name segments spanning the parcel. The 2–100 m accepted width is an application limit; a missing legal width requires a user-entered scenario. The model screens likely additional frontages (including bends of the same mapped way), conflicting rights-of-way, curved local alignments, and mapped nonvehicular/restricted/grade-separated access. Unknown additional road widths use proximity screens of 12 m for other roads and 25 m for arterial-class ways, based on edge alignment and overlap; these are screening distances, not ROW widths. Centerline proximity and mapped tags are incomplete evidence; legal public status, surveyed road geometry, and road/parcel levels remain unresolved.
- BMA overlays are checked for the full zone, including building-control and transport plans, and mapped water proximity is screened. Parcel intersections with the Ratchadaphisek restriction, planned transport, or water caution areas require separate assessment. No intersection clears every parcel-specific restriction.
- Each concept includes its own floor-by-floor envelope based on its independent measured GFA and actual height/category, with an independent containment test. The separate capacity view retains the largest supported slice sum. For taller forms, geometrically nonqualifying BMA §53 candidates are excluded from automatic selection; the §52(6) alternative is an unimplemented review branch and legal public-access evidence remains outstanding.
- A deterministic fallback considers compact unstaggered floor templates on narrow lots; a failed bounded search is reported independently of a proven empty modeled envelope. A second concept is returned only when it differs meaningfully and passes the modeled checks.
