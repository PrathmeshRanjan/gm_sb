# Din Daeng implementation evidence (V1–V3 baseline)

The V4 geographic expansion supersedes the original rectangular context below. See [zone coverage and source audit](ZONE-COVERAGE.md) for the complete statutory boundary, reuse basis, new road/building extracts, and overlay screening.

The private evidence directory contains byte-for-byte Phase 1 response copies and a manifest with source paths, SHA-256 digests, and counts. Its originals include the BMA service metadata, bounding queries for layers 1, 2, 4, 5, 7 and 8, the full response for zoning feature 357, the Overture catalog and release collection, the Overture neighborhood GeoJSON and extraction state, and both OSM extracts used in site selection. The official 2026 draft PDF remains in the source directory. See the Phase 1 notes for clause and dataset URLs.

The BMA dataset catalogue lists no redistribution license. The public coverage polygon is the authored study rectangle from the verified bounding query. The application bundles the licensed building and road data, the authored rectangle, and links to the statutory annex and BMA layer.

## Checking the local data

From the project root, use Python with Shapely 2.2.0 and pyproj 3.8.0.

```sh
python scripts/prepare_context.py --public .local-evidence/v3-context
python scripts/verify_research_geometry.py --public .local-evidence/v3-context
```

The first command checks the archived bytes against the existing manifest, checks the original counts, and rebuilds the map bundle deterministically. The second tests the original concave, split, collapse and massing fixtures, plus the shipped 828 m² geometry with all of its projected vertices, 30 m modeled frontage and width conflict checks. Run the app's browser tests separately.

Raw Overture and OSM files are separate from the web bundle. The compiler preserves whole intersecting Overture footprints and clips mapped road lines to the coverage box. The result contains 982 building footprints and 50 highway ways. The road and building datasets add up to approximately 363 kB before compression. The data manifest describes the source, license, and filtering policy for each asset.

## Preset assumptions

- The scenario has an 828 m² concave boundary drawn around a model 11.70 m right-of-way. Its nearest edge lies 5.85 m west of the mapped Pracha Suk centerline between Soi Inthamara 36 and 38. Neither the road edges nor the plot have been surveyed. Width overrides leave the plot fixed.
- The six Overture footprints intersecting the scenario are contextual evidence of existing development. The baseline scenario assumes redevelopment and removal within the plot. Retained structures require independently supplied gross area and coverage geometry. The downloaded building heights cannot supply those totals.
- The Overture extract had no reported height and seven floor-count records. Floor-count estimates use 3.1 m per reported floor. The remaining 975 building extrusions use a schematic 6 m height.
- The two side-street selections use genuine mapped centerline segments. Their widths require scenario inputs.
