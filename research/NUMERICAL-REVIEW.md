# Numerical review of the Pracha Suk preset

## Opening clearance

Version 2's returned wider/lower polygons had a 1.9903694527441531 m minimum to the private boundary against a 2 m requirement. The −0.0096305472558469 m margin displayed as −0.01 m and passed the former 0.015 m verifier tolerance. At that point, GEOS represented a rounded offset with eight chords per quadrant. The midpoint of an inscribed chord sits at approximately `2 × cos(π/32)` from its center. The distance matches that construction approximation. Parcel drawing precision and display rounding did not cause the shortfall.

Candidate construction now uses a conservatively expanded radius at 16 segments per quadrant, with a 0.002 m design reserve. The radius accounts for the chord inset so the polygonal offset remains on the conservative side. The independent verifier measures the actual plate against the original reference geometry in projected meters and uses a `0.00001 m` floating-point tolerance. Distances remain full-precision numbers until rendering. The displayed measurement gives the actual distance, requirement, signed margin, and tolerance. User drawings and road edges still have scenario-level evidentiary precision.

The revised wider design returned 2.0019999991829986 m after projection to display coordinates and back. The stepped design returned 3.001999999252609 m against its 3 m requirement. Regression fixtures include a relocated plate that fails the opening check and two containment failures where testing vertices alone would give the wrong answer.

## Floor arithmetic

Version 2 returned 339.50500883445574 m² for each wider plate and 679.0100176689115 m² for their exact sum. Each plate rounded to 339.51 m² while the exact sum rounded to 679.01 m². The app now presents a floor schedule and a separately labeled full-precision aggregate. Where independently rounded rows sum to a different printed number, the schedule reports the size and direction of the difference. The geometry and verifier continue to use unrounded areas.

## Search results and height-plane stress case

The former ranking strongly rewarded the stepped form's storey count. The revised search evaluates a bounded set of floor count, orientation, footprint, and upper-step templates. It independently checks a shortlist and selects the highest checked GFA for the wider/lower strategy. For the open-space alternative it prefers a markedly smaller footprint, with a target of retaining at least 78% of the wider GFA where the available checked designs allow. The 48 m² plate and 5 m usable-core thresholds are multifamily design heuristics.

The preset evaluates 204 candidates and independently checks 20 finalists. The highest checked GFA is 963.26 m². The 793.18 m² stepped selection trades 170.08 m² of GFA for 316.42 m² more uncovered ground. Opening setbacks are the closest modeled constraints. The 1,000 m² profile cap bounds the search. Reported results cover the checked candidates.

At the sourced 11.70 m road width, the six-slice geometric sum is 2,683.33 m². Under the 2 m hypothetical width it is 2,665.44 m². The sixth slice falls from 447.22 to 429.34 m² as the road-height plane cuts it. Both chosen designs already fit inside their respective slices, so their GFA is unchanged. Support, aggregate area and open-space budgets, design geometry, and unresolved site evidence are separate from the slice sum.

## V4 narrow-lot search and concept-specific envelopes

The regression harness uses the original road-local `box(0, 0, 6.6, 14)` detached-house fixture (92.40 m²). V3's wider output was 91.83056480 m² over two floors, with no second design. The existing bounded template seeds lost too much usable depth for the compact form. V4 retains the original search and adds a second pass if the first shortlist has no validated result. It clips the actual envelope while preserving its shorter dimension, varies four relative target areas and three positions, and allows a compact unstepped form. For this fixture the wider result stays at 91.83056480 m², while the compact form supplies 76.49486048 m² in two 38.24743024 m² plates with 54.15256977 m² uncovered. Independent checks and the 27 m² plate / 4 m usable-core heuristics pass for both. A nonempty envelope with an exhausted bounded search remains an unresolved search outcome.

In the multifamily baseline the capacity view still uses six storeys and totals 2,683.33 m² in slices with 3 m national opening setbacks. The selected wider design has two storeys and measured GFA 963.26 m²; its 6.4 m overall height uses 2 m national opening setbacks, yielding two applicable 575.17 m² slices. The selected stepped design, measured GFA 793.18 m² and height 19.2 m, keeps the six 447.22 m² slices. Every occupied floor is independently differenced against its matching applicable slice, including nonconvex edges and holes, with a 0.00001 m² area tolerance. The displayed concept envelope follows the selected classification. The maximum slice sum remains separately labeled as a geometric bound, subject to aggregate area budgets and other conditions.

## V4 frontage qualification

The [BMA B.E. 2544 building control ordinance](https://webportal.bangkok.go.th/public/user_files_editor/76/law/y07.pdf), printed pages 15–16, §52(6) (`ที่ว่างด้านหน้า`) requires alternative front open space and access arrangements for the covered types not adjoining a public road. In the supported residential profiles, the trigger is more than three storeys. For those buildings the alternative requires 12 m front open space, a continuous length of at least one-sixth of exterior perimeter (eligible adjoining side space can count), and an internal road at least 6 m wide connecting to a public road. If the access road crosses beneath the building, a minimum 5 m clear height applies. §53 allows the roadside branch where the relevant façade length is strictly greater than one-eighth of the exterior perimeter and no more than 20 m from the public way. The geometry implementation checks the longest continuous nearly road-parallel outward-facing ground façade within that distance; the parallelism threshold is a modeling assumption. A failed geometric qualification now fails that automatic screen; the alternative branch remains separately flagged for review. A legal public-access review remains even with a qualifying façade. The six-floor preset measures 23.99 m against more than 12.48 m, with 30.00 m modeled contact. A separate four-storey fixture with a façade 24 m behind the road fails the frontage screen alone and explicitly needs the unimplemented alternative route. A geometrically qualifying four-storey fixture passes the supported check even with unknown legal road status, retaining unknown-evidence Review. Width scenarios preserve parcel position and its baseline road association; when a narrower hypothetical road no longer touches the parcel, modeled contact and public-access uncertainty remain explicit.

## Final release east-example numerical stability

The unedited 611 m² east scenario (Soi Inthamara 47, OSM way 25902874, 8 m hypothetical width, multifamily, automatic frontage, clear redevelopment) was reproduced on V4 commit `eee470c789a005e140431514be4e4f91bcaa77a9` before editing. A Playwright worker intercept captured the actual load-example request. Its parcel was exactly equal to the saved coordinates, with 13 nearby road inputs and four intersecting-footprint inputs. The same captured input ran in Node v24.18.0 and Chromium 159.0.8154.6. A same-source projection probe measured a maximum UTM difference of 2.33e-10 m and local-frame difference of 3.54e-10 m. No nine-decimal rounding took place in the load action. The separate nine-decimal diagnostic changes the parcel area by about 0.00112042 m²; vertex displacements are under 0.000064 m.

| Runtime and original V4 input | Wider GFA m² | Alternative GFA m² |
|---|---:|---:|
| Node, exact captured input | 787.4621375171 | 617.2791428312 |
| Node, nine-decimal captured input in our reproduction | 787.4636064281 | 617.2806816350 |
| Published Chromium worker, exact | 916.3684671847 | 724.6354133506 |
| Published Chromium worker, nine-decimal | 916.3702688151 | 724.6370716487 |

The independent review also observed the larger rounded result in its Node run. Our Node reproduction rejected the full-envelope candidate for both representations. The observed sensitivity is at the floating-point comparison, so the runtime-specific rounded result can differ. In Node, the three-floor ground envelope had area 305.4561557290915 m², and the full-envelope clipped candidate measured 305.4561557290916 m². The candidate exceeded the nominal envelope by approximately 1.14e-13 m² and was incorrectly rejected. In Chromium the same calculation instead measured 305.4561557282169 versus 305.45615572821686 m², placing the candidate on the accepted side. The smaller wider form in turn restricted the open-space alternative's search target.

The full-envelope Node candidate was valid locally, but a 6.64e-12 m edge produced invalid geometry after geographic serialization and reprojection. Admitting the candidate alone would have been insufficient. The correction compares the available envelope and clipped footprint using the existing 0.00001 m² geometric equality tolerance. The 70% site and 85% alternative footprint search targets are kept separate, with strict search screening and only geometric round-trip slack after serialization. Planning-budget screening remains strict and the independent budget tolerance stays 0.000001 m². The 0.00001 m distance tolerance and 2 mm clearance reserve are unchanged.

Generated area geometries remove only consecutive vertices within 1e-8 m (10 nanometres). Each must remain valid in local coordinates, geographic coordinates and reprojected local coordinates, with measured area drift no greater than 0.00001 m². There is no general invalid-polygon repair or user-parcel rounding. Every finalist's reported floor areas, footprint union, planting and checks are recomputed on this round-trip geometry. The same serialization validation applies to rendered envelope slices; their analytical bound remains computed from the original native geometry. Invalid serialized external proposals fail the independent validator explicitly. Candidates that still fail are discarded.

| Corrected result | Plot m² | Wider GFA m² | Alternative GFA m² |
|---|---:|---:|---:|
| Node exact | 611.000000004 | 916.3684672255 | 724.6354133690 |
| Node nine decimals | 611.001120425 | 916.3702688083 | 724.6370715877 |
| Local Chromium exact loaded example | 611.000000004 | 916.3684672248 | 724.6354133976 |
| Local Chromium nine decimals | 611.001120428 | 916.3702687463 | 724.6370715868 |

Each returns a three-floor wider and six-floor alternative with independently valid serialized geometries. The original wider covers 305.4562 m² and the alternative 127.8611 m². Their GFA changes by under 0.002 m² after the microscopic perturbation. The 617 m² post-edit browser scenario remains a different scenario. See the original and post-edit images in the screenshot gallery.
