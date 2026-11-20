# V4 verification checkpoint — 20 November 2026

## Geographic fixtures and independent audit

The three illustrative parcels are outside the original study rectangle, inside the sourced zone polygon and clear of the specific published overlay and water caution geometry. All widths are scenario inputs. The rows below are engine results for the exact authored fixtures and their actual mapped road alignments. The test independently revalidates each serialized design, including containment in its own applicable floor slices.

| Scenario road | Site m² | Width m | Wider floor count / GFA m² | Alternative floor count / GFA m² |
|---|---:|---:|---:|---:|
| Soi Pracha Songkhro 21 Yaek 6-1-6 | 552.00 | 8 | 2 / 703.42 | 2 / 559.28 |
| Soi Inthamara 28 | 544.50 | 7 | 2 / 690.96 | 2 / 542.01 |
| Soi Inthamara 47 | 611.00 | 8 | 3 / 916.37 | 6 / 724.64 |

The final release fixes the original east fixture's numerical selection instability. The unmodified V4 Node fixture produced 787.46 / 617.28 m²; the actual public browser received exact saved coordinates and returned 916.37 / 724.64 m². The corrected Node and Chromium paths agree at displayed precision. The nine-decimal perturbation changes the wider GFA by about 0.00180 m² and the alternative by 0.00166 m². [Numerical review](NUMERICAL-REVIEW.md#final-release-east-example-numerical-stability).

The headed-browser walkthrough loaded each scenario, selected another actual nearby road and returned to the intended road, entered the stated width, edited a far-side vertex through Terra Draw, switched concepts and opened the independent check and floor schedule. The observed edited scenarios were:

| Scenario | Displayed edited plot m² | Wider GFA m² | Alternative GFA m² |
|---|---:|---:|---:|
| Southwest | 570 | 726.68 | 573.25 |
| North | 562.5 | 715.14 | 562.50 |
| East | 617 | 920.53 | 975.02 |

The east stepped alternative has a smaller covered projection even though its extra storeys deliver a higher GFA. These are observed discrete-search results, not global optima. Legal public-road status, rights-of-way, title, existing-building clearance and other design/evidence items remain conditional. The browser screenshot gallery is in `public/evidence/v4`.

## Tests executed

- `npm test` — 34/34 Vitest tests in three files. In addition to the earlier numerical tests, they cover concave zone boundaries (including edges with inside endpoints), a zone hole, a separate zone component, unavailable context, a second or same-way frontage, restricted and curved roads, the three real-location fixtures, the narrow-house second alternative, full independent applicable-slice containment, the BMA §53 qualification and unimplemented alternative branch, road alignment/selection, exact versus nine-decimal east parcels, and rejection of deliberately invalid serialized geometry.
- `npm run build` — passed TypeScript and production Vite build. Vite reports its existing large-bundle advisory; there is no build error.
- `FEASIBILITY_HARDWARE_WEBGL=1 npm run test:browser` — 7/7 in 54.9 s on an Apple M1 MacBook Air (8 GB RAM), Chromium 159, headed with ANGLE Apple Metal renderer. The production app exercised plan drawing, vertex editing, camera zoom, the separate concept/capacity envelopes, real road changes at all three locations, outside-zone rejection, mapped-water screening, missing width, forced delayed worker responses during rapid site/road/profile changes, and a failed data asset. The new regression captures the actual original east worker request, asserts the saved coordinates match exactly and independently revalidates both the actual and rounded browser outputs in Node. The original 14.70 m stress scenario preserved 828 m² and reported 45.00 m² ROW overlap, then recovered when restored.
- `python scripts/verify_research_geometry.py` — passed independently on GEOS 3.14.1; verifies archived GIS geometry, site polygon extents/contact, asset hashes, and prior stress fixture.

## Measured production-build browser timings

Final local production preview, hardware WebGL, 30 warm worker requests with full geographic and overlay input, varying width and residential profile. Worker round-trip median 125.7 ms, p95 133.1 ms; engine p95 132.5 ms. First cold worker request 195.5 ms. Initial map and baseline calculation ready 1,292 ms after navigation. Edited southwest, north and east worker round trips were 44.0, 41.1 and 154.6 ms. Round-trip samples exclude the UI's 55 ms edit debounce and map-render completion. Subsequent network/hosting timings can vary.

The 828 m² original parcel still returns wider 963.26 m² and stepped 793.18 m² GFA; the selected envelope sums are 1,150.35 and 2,683.33 m². The 2 m stress case reduces the separate capacity bound to 2,665.44 m², while those actual designs remain unchanged. The independent opening checks remain conservative at 2.0020 and 3.0020 m with 0.00001 m verifier tolerance. The floor schedule explains independent rounding.
