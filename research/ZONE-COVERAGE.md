# V4 geographic coverage and source audit

## Actual zone

The supported statutory zone is all of **ย.๙-๑๓**, high-density residential under the Bangkok B.E. 2556 (2013) comprehensive plan. We did not use the 2026 draft as the applicable map. A public, unauthenticated BMA MapServer layer 1 query retrieved on 20 November 2026 selected every feature with `LUP_SUBZON='ย.๙-๑๓'`. It returned precisely one feature, OBJECTID 357, FAR 7 and OSR 4.5%. Its valid WGS84 polygon has 242 exterior coordinates including closure, no interior rings and no separate components. Its projected area in UTM 47N is 2,656,407.51 m². Bounds in longitude/latitude are `[100.5534818252, 13.7699867140, 100.5740372712, 13.7898864395]`. The repeat anonymous request by OBJECTID was byte-for-byte equal to the preserved 19 November response (SHA-256 `3401feaffe0edee69a898a68d0f85edb518144b565a780b618fc9f781d3427d1`). The compiler also checks the complete zone-code response against the preserved geometry with zero coordinate tolerance. [BMA layer 1](https://cpudgiapp.bangkok.go.th/arcgis/rest/services/GI_Platform/BMAGI_Planing/MapServer/1)

The independently published statutory annex, printed page 48, describes the southern edge of Sutthisan Winitchai Road as the northern boundary, the western edge of Ratchadaphisek Road as the eastern boundary, the northern/eastern edges of Pracha Rat Bamphen and Pracha Songkhro roads, named planned road ง 13 and municipal facilities as the southern boundary, and the eastern edge of Vibhavadi Rangsit Road as the western boundary. Those landmarks agree with feature 357. For a geographic plausibility check, its extreme north/east/south/west vertices lie respectively 2.63, 3.25, 1.12 and 23.56 m from the nearest mapped OSM alignment of Sutthisan Winitchai, Ratchadaphisek, Pracha Songkhro and Vibhavadi Rangsit. These checks establish geographic identity and do not survey legal road edges. [Official annex, p. 48](https://webportal.bangkok.go.th/public/user_files_editor/354/aboutcpud/2556/2556%20detial/002_cpd56.pdf#page=48)

### Reuse basis and evidence limits

- The BMA's public [LUP_POLYGON data.go.th catalogue](https://data.go.th/dataset/lup_polygon), dataset key `87e06de6-fbe7-4c3b-9080-0ec2929f4720`, resource key `6ede14be-87a2-49fb-b52b-f16ffe730642`, describes the statutory B.E.2556 land-use map and lists the dataset date 16 May 2013 and public catalogue publication 31 August 2022. The catalogue's individual license field reads “License not specified”. This does not itself grant reuse. Its exact description and government producer agree with the [anonymous ArcGIS layer metadata](https://cpudgiapp.bangkok.go.th/arcgis/rest/services/GI_Platform/BMAGI_Planing/MapServer/1?f=pjson); all four native EPSG:32647 dataset-wide bounds agree to the published decimal precision: `643529.4994,1491241.3322,709557.5863,1543360.7234`. This identifies the same dataset even though the catalogue page does not expose an additional source URL for this record.
- The [DGA Open Government License v1.0, 10 June 2021](https://data.go.th/uploads/page_images/2021-06-11-053225.908526Terms-and-Conditions-for-DGA-Open-Government-LicenseEN04062021.pdf) covers government data published or delivered through the national platform. Its terms grant non-exclusive copying, publication, distribution and processing, including for research and innovation, with attribution and preservation of substantive meaning (pp. 2–3). Exceptions include protected data and intellectual-property rights for which DGA cannot authorize reuse (p. 4). The official producer is BMA City Planning and Development Department, and the published content here is the geometry of its own statutory plan. We rely on that platform license for the identified BMA statutory datasets, including the two ordinance and transport screening sources with explicit catalogue-to-service links below. The [Thai Copyright Act B.E. 2537, §7(1)–(3),(5)](https://www.ipthailand.go.th/images/26669/2566/laws/COPYRIGHT%20ACT%20B.E.%202537%20%281994%29.pdf) independently excludes facts, legislation, government regulations and governmental compilations of those works. This supports re-expression of the legislative boundary as factual coordinates. It is not a blanket license for unrelated BMA GIS layers, website presentation, third-party basemaps, or login-protected material.
- The compiled `site.json` contains feature 357's unchanged WGS84 geometry only, sourced metadata, clipped review-screen geometries, and authored scenario/coverage shapes. No raw BMA payloads, account credentials, or unrelated source content are shipped. Raw public query responses are archived privately in `research/evidence/v4`. `manifest.json` records their hashes, sources, attribution and published asset hashes. The boundary is accurate for this public planning feature and has no cadastral or surveyed positional-accuracy guarantee.

## Parcel screening across the zone

On 20 November 2026, anonymous bbox queries fetched the complete intersecting features from the BMA planning service for `[100.551,13.768,100.576,13.792]`. Exact GEOS intersection with feature 357 identified the following. A zero result means absence of an intersection in the particular published layers on that retrieval date, not absence of every land or building restriction.

| BMA layer | Bbox count | Zone intersection object IDs | V4 handling |
|---|---:|---|---|
| 2 Building use/control ordinances | 7 | 95, 104, 129 | 104 is the 2005 retail/wholesale use ordinance and covers the whole zone. 129 is the 2006 sign-structure ordinance, approximately 136,094 m² in-zone. Neither is part of the residential-only scope. 95 is 1985 Ratchadaphisek roadside construction/use restriction, 18,841.55 m² in-zone; intersecting parcels require separate branch review. |
| 4 Planned transport lines | 2 | 5 | Object 5 is planned road ง๑๓, published 30 m width. The app screens its 15 m centerline buffer together with the area feature. The buffer is a review screen, not a surveyed ROW or statutory setback. |
| 5 Planned transport areas | 2 | 81 | Object 81 is the same ง๑๓ project, 8,748.09 m² intersecting the zone. Screened parcels require specialist review. |
| 7/8 Statutory public open-space area/line | 4 / 2 | none / none | Checked in published layers. |
| 10/11/12 Public utility project, drainage/flood prevention, wastewater service area | 0 / 0 / 0 | none | Checked in published layers. |

Source catalogue records explicitly link the BMA service for [building-control ordinances, layer 2](https://data.go.th/dataset/bdctl_polygon), [transport lines, layer 4](https://data.go.th/en/dataset/transp_line), [transport polygons, layer 5](https://data.go.th/th/dataset/transp_polygon), [open-space polygons, layer 7](https://data.go.th/dataset/osp_polygon), and [open-space lines](https://data.go.th/dataset/osp_line). The utility project [catalogue](https://data.go.th/th/dataset/pup_polygon) describes the statutory utility plan. We distribute only the clipped in-zone restriction and transport caution geometries; the other intersection results are factual summaries. Source ordinance object 95 and the planned road branch have not been implemented as numeric legal rules.

The licensed OSM extract additionally contains mapped open canal lines and water surfaces. The compiler combines 75 intersecting source water features and screens a 20 m area around them, then intersects it with the zone. One water relation could not be assembled from available way members. The resulting 123,031 m² screen identifies sites needing water-boundary/public-status review. It is a product screening tolerance rather than an inferred legal setback. No OSM water intersection cannot clear actual public waterways.

Parcel-specific legal title, surveyed right-of-way and water-bank positions, road public status and network access, current easements, environmentally or aviation-related restrictions, and unqueried or outdated restrictions remain separate review items. The site screening coverage field means these listed published layers were checked across the zone.

## Roads and actual neighborhood buildings

The context buffer is the authored 200 m buffer around the statutory zone in UTM 47N, total extent area 4,327,610 m². All source downloads cover this buffer. It is used for neighborhood context only. Building and road geography is independent of the authored example plots.

| Dataset | Published result | Provenance |
|---|---|---|
| Road ways | 1,565 complete OSM highway ways intersecting the context area, deduplicated from 70,634 OSM elements across nine bbox queries | [OpenStreetMap](https://www.openstreetmap.org/copyright), ODbL 1.0, 20 Nov 2026. Full mapped ways retained so artificial coverage cuts do not truncate local frontages. No OSM width tags in the downloaded highway ways. Access tags, where present, are mapped evidence. Neither an OSM road nor its displayed line thickness establishes public ownership or legal width. |
| Building footprints | 9,826 valid intersecting above-ground building polygons from 16,034 Overture source buildings | [Overture Maps release 2026-11-18.0](https://stac.overturemaps.org/2026-11-18.0/buildings/building/collection.json), [attribution](https://docs.overturemaps.org/attribution/), ODbL 1.0. Whole intersecting footprints retained. |
| Extrusion height | 2 source-reported OSM height attributes (7 and 15 m); 484 floor-count estimates × 3.1 m; 9,340 schematic 6 m heights | Measurement method for the source height attributes is unreported. None is proven surveyed. The footprint-only control omits the height representations. |

The Din Daeng [district public road inventory](https://webportal.bangkok.go.th/dindaeng/page/sub/624/%E0%B8%96%E0%B8%99%E0%B8%99-%E0%B8%95%E0%B8%A3%E0%B8%AD%E0%B8%81-%E0%B9%81%E0%B8%A5%E0%B8%B0%E0%B8%8B%E0%B8%AD%E0%B8%A2) explicitly records 11.70 m width of Pracha Suk Road between Sutthisan Winitchai and Pracha Songkhro. The matching Pracha Suk named centerline ways retain this source width; a model reconstructs parallel edges and neither the edges nor the parcel are surveyed. The inventory's separate drainage-maintenance list names the example Soi Inthamara 28 and 47 but provides lengths rather than widths. Legal public access remains subject to verification. The three example widths are scenario values.

The context JSON totals about 4.28 MB uncompressed (743 kB gzipped using standard gzip compression). A single immutable same-origin load avoids viewport-specific partial context, context-fetch races, and external API calls during editing. Browser performance is measured separately against the integrated production build; the size itself does not establish latency.

### Geographic demonstration scenarios

The compiler places geometrically authored plots on actual mapped local road segments using the stated scenario widths and a UTM 47N transform. They are geographically separated, fully contained within feature 357, outside the original rectangle, and disjoint from the compiled review-screen geometries. Their legal titles and widths are hypothetical; the neighboring road and building context is from the published dataset.

| Example | Road and OSM ID | Plot shape and area | Scenario width | Profile |
|---|---|---|---:|---|
| Southwest | [Soi Pracha Songkhro 21 Yaek 6-1-6](https://www.openstreetmap.org/way/867200225) | 24 × 23 m rectangle; 552 m² | 8 m | House |
| North | [Soi Inthamara 28](https://www.openstreetmap.org/way/471405424) | five-sided trapezoidal scenario; 544.5 m² | 7 m | House |
| East | [Soi Inthamara 47](https://www.openstreetmap.org/way/25902874) | eight-vertex concave scenario; 611 m² | 8 m | Multifamily |

The preexisting 828 m² Pracha Suk parcel is independently regenerated from the archived Phase 1 road line and retains all six intersecting Overture footprints.

## Reproducible acquisition and compilation

The published data bundle contains all browser-required data. No internet retrieval occurs when the app opens a plot. To regenerate from archived responses, use Python with Shapely 2.2 and pyproj 3.8, then:

```sh
python scripts/prepare_zone_context.py
python scripts/verify_research_geometry.py
```

The `research/evidence/v4` archives remain private. The public acquisition paths are as follows (no API key, credentials or authentication required):

- Anonymous BMA MapServer root `https://cpudgiapp.bangkok.go.th/arcgis/rest/services/GI_Platform/BMAGI_Planing/MapServer`. Save `/1?f=pjson` as `bma-layer-1-metadata.json`. Save `/1/query` using `where=OBJECTID=357`, `outFields=LUP_ZONE,LUP_SUBZON,LUP_FAR,LUP_OSR`, `outSR=4326`, `returnGeometry=true`, `f=geojson` as `bma-zone-357.geojson`. Save the query for `where=LUP_SUBZON='ย.๙-๑๓'` with `OBJECTID` also in `outFields` as `bma-zone-all.geojson`.
- For layers 2, 4, 5, 7, 8, 10, 11, 12, save the individual `/query` response as `bma-layer-<id>.geojson`, with `f=geojson`, `geometry=100.551,13.768,100.576,13.792`, `geometryType=esriGeometryEnvelope`, `inSR=4326`, `spatialRel=esriSpatialRelIntersects`, `outSR=4326`, `outFields=OBJECTID`, `returnGeometry=true`. The original ordinance and transport object metadata were checked with `objectIds=104,129,95` (2) and `5` (4) and `81` (5). Attribute values, source IDs, and data hashes are recorded for provenance. The original V3 archive is retained independently.
- Query `https://www.openstreetmap.org/api/0.6/map.json?bbox=west,south,east,north` for each rectangle in the grid with longitude edges `[100.551,100.5594,100.5677,100.576]` and latitude edges `[13.768,13.776,13.784,13.792]`. Save as `osm-<x index>-<y index>.json`. All nine bounded queries returned successfully. For a large-scale refresh use a regional OSM extract rather than repeatedly querying the editing API.
- `overturemaps download --bbox 100.551,13.768,100.576,13.792 -f geojson -o research/evidence/v4/overture-buildings.geojson -t building -r 2026-11-18.0`. The release CLI returned 16,034 buildings and saved extraction state. Python's local certificate-store issue was resolved using `SSL_CERT_FILE=/etc/ssl/cert.pem AWS_CA_BUNDLE=/etc/ssl/cert.pem`; verification was retained.

The Phase 1 script `prepare_context.py` is preserved for the historical rectangle. To reproduce those files separately, supply a different `--public` output directory so they do not replace the V4 bundle.
