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
