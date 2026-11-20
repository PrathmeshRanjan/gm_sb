"""Compile V4's statutory zone and licensed neighborhood context from archived extracts.

Run after collecting the public sources documented in research/ZONE-COVERAGE.md.
The Phase 1 evidence and original context compiler remain unchanged.
"""

from __future__ import annotations

import argparse
from collections import Counter
import gzip
import hashlib
import json
import math
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import LineString, Polygon, box, mapping, shape
from shapely.ops import polygonize, transform, unary_union

from prepare_context import (
    BMA_ANNEX, BMA_ROAD_INVENTORY, FALLBACK_HEIGHT_METRES, FLOOR_HEIGHT_METRES,
    MAP_SERVER, ODBL, OBSERVED_DATE, OSM_COPYRIGHT, OVERTURE_CREDITS, RELEASE,
    STUDY_BOUNDS, build_buildings, feature, feature_collection, make_parcel,
    osm_ways, read_json, road_option, write_json,
)


V4_DATE = "2026-11-20"
CONTEXT_BOUNDS = (100.551, 13.768, 100.576, 13.792)
CONTEXT_BUFFER_M = 200
WATER_SCREEN_M = 20
ZONE_ID = 357
ZONE_NAME = "ย.๙-๑๓"
DGA_LICENSE = (
    "https://data.go.th/uploads/page_images/2021-06-11-053225.908526"
    "Terms-and-Conditions-for-DGA-Open-Government-LicenseEN04062021.pdf"
)
DGA_ZONE = "https://data.go.th/dataset/lup_polygon"
DGA_ORDINANCES = "https://data.go.th/dataset/bdctl_polygon"
DGA_TRANSPORT = "https://data.go.th/th/dataset/transp_polygon"
DGA_TRANSPORT_LINE = "https://data.go.th/en/dataset/transp_line"
DGA_OPEN_SPACE = "https://data.go.th/dataset/osp_polygon"
DGA_OPEN_SPACE_LINE = "https://data.go.th/dataset/osp_line"
DGA_UTILITIES = "https://data.go.th/th/dataset/pup_polygon"
THAI_COPYRIGHT = "https://www.ipthailand.go.th/images/26669/2566/laws/COPYRIGHT%20ACT%20B.E.%202537%20%281994%29.pdf"
PROJECT = Transformer.from_crs("EPSG:4326", "EPSG:32647", always_xy=True).transform
UNPROJECT = Transformer.from_crs("EPSG:32647", "EPSG:4326", always_xy=True).transform


def collect_osm(evidence: Path) -> dict:
    """Merge all nine bbox responses, preferring the latest version of a shared ID."""
    elements = {}
    for i in range(3):
        for j in range(3):
            raw = read_json(evidence / f"osm-{i}-{j}.json")
            for element in raw["elements"]:
                key = (element["type"], element["id"])
                previous = elements.get(key)
                if previous is None or element.get("version", 0) >= previous.get("version", 0):
                    elements[key] = element
    return {"elements": [elements[key] for key in sorted(elements)]}


def compile_roads(ways: dict, coverage) -> dict:
    roads = []
    for way_id, (tags, coords) in ways.items():
        alignment = LineString(coords)
        if not alignment.intersects(coverage):
            continue
        access = tags.get("access")
        evidence = f"OSM access={access}; legal public access unverified" if access else "Mapped alignment; legal public access unverified"
        if tags.get("name:en") in {"Soi Inthamara 28", "Soi Inthamara 47"}:
            evidence = "Din Daeng road maintenance inventory; legal public access unverified"
        properties = {
            "name": tags.get("name:en", tags.get("name", "")),
            "nameTh": tags.get("name:th", tags.get("name", "")),
            "class": tags["highway"],
            "accessEvidence": evidence,
        }
        if tags.get("width"):
            properties["mappedWidth"] = tags["width"]
        for key in ("access", "vehicle", "motor_vehicle", "service", "oneway", "bridge", "tunnel", "layer"):
            if tags.get(key):
                properties[key] = tags[key]
        # Keep complete mapped ways to avoid creating artificial segment endpoints at the coverage edge.
        roads.append(feature(way_id, mapping(alignment), properties))
    return feature_collection(roads, "© OpenStreetMap contributors.", OSM_COPYRIGHT)


def water_context(osm: dict, coverage, zone):
    """Flag mapped water proximity for review, with no claim about legal banks or status."""
    nodes = {item["id"]: (item["lon"], item["lat"]) for item in osm["elements"] if item["type"] == "node"}
    lines = {}
    water = []
    relations = []
    for item in osm["elements"]:
        tags = item.get("tags", {})
        if item["type"] == "way":
            coords = [nodes.get(node) for node in item["nodes"]]
            if any(point is None for point in coords) or len(set(coords)) < 2:
                continue
            line = LineString(coords)
            lines[item["id"]] = line
            if tags.get("natural") == "water" or tags.get("waterway") == "riverbank":
                if line.is_ring:
                    area = Polygon(line)
                    if area.is_valid and area.intersects(coverage):
                        water.append(area)
            elif tags.get("waterway") in {"canal", "river", "stream", "drain", "ditch"}:
                if tags.get("tunnel") != "culvert" and tags.get("covered") != "yes" and line.intersects(coverage):
                    water.append(line)
        elif item["type"] == "relation" and (tags.get("natural") == "water" or tags.get("waterway") == "riverbank"):
            relations.append(item)
    unresolved = 0
    for relation in relations:
        members = [member for member in relation.get("members", []) if member.get("type") == "way"]
        if any(member["ref"] not in lines for member in members):
            unresolved += 1
            continue
        shells = [lines[member["ref"]] for member in members if member.get("role") in {"outer", ""}]
        holes = [lines[member["ref"]] for member in members if member.get("role") == "inner"]
        if not shells:
            unresolved += 1
            continue
        outer = unary_union(list(polygonize(shells)))
        inner = unary_union(list(polygonize(holes)))
        area = outer.difference(inner)
        if area.is_empty or not area.is_valid:
            unresolved += 1
        elif area.intersects(coverage):
            water.append(area)
    buffered = [transform(PROJECT, item).buffer(WATER_SCREEN_M, quad_segs=8) for item in water]
    return unary_union(buffered).intersection(zone), len(water), unresolved


def geometry_from_layer(evidence: Path, layer: int, feature_id: int):
    data = read_json(evidence / f"bma-layer-{layer}.geojson")
    match = [item for item in data["features"] if item["properties"]["OBJECTID"] == feature_id]
    assert len(match) == 1, (layer, feature_id, len(match))
    geom = transform(PROJECT, shape(match[0]["geometry"]))
    assert geom.is_valid
    return geom


def screen_entry(id: str, label: str, source: str, geom) -> dict:
    assert geom.geom_type in {"Polygon", "MultiPolygon"} and geom.is_valid and not geom.is_empty, id
    return {"id": id, "label": label, "sourceUrl": source, "geometry": mapping(transform(UNPROJECT, geom))}


def example_parcel(ways: dict, way_id: int, segment: int, width: float, fraction: float, side: int, coords: list[tuple], label: str, id: str, profile: str) -> dict:
    tags, way = ways[way_id]
    a, b = [PROJECT(*point) for point in way[segment:segment + 2]]
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy)
    tangent = (dx / length, dy / length)
    normal = (-side * tangent[1], side * tangent[0])
    frontage = max(y for _, y in coords)
    start = (length - frontage) * fraction
    assert start > 2 and start + frontage < length - 2
    metric = Polygon([
        (a[0] + (y + start) * tangent[0] + (x + width / 2) * normal[0],
         a[1] + (y + start) * tangent[1] + (x + width / 2) * normal[1])
        for x, y in coords
    ])
    assert metric.is_valid and metric.area > 0
    return {
        "id": id, "label": label, "profile": profile, "widthM": width, "roadId": way_id,
        "roadName": tags["name:en"], "widthSource": "scenario-input", "areaM2": round(metric.area, 6),
        "parcel": mapping(transform(UNPROJECT, metric)),
        "camera": {"center": UNPROJECT(metric.centroid.x, metric.centroid.y), "zoom": 17.7, "bearing": 26, "pitch": 53},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=Path("research/evidence"))
    parser.add_argument("--public", type=Path, default=Path("public/data"))
    args = parser.parse_args()
    evidence = args.evidence / "v4"
    zone_source = read_json(evidence / "bma-zone-all.geojson")
    metadata = read_json(evidence / "bma-layer-1-metadata.json")
    # Publisher catalogue's full native-coordinate dataset identity, independent of the selected-feature bounds.
    assert metadata["extent"]["spatialReference"]["wkid"] == 32647
    assert tuple(metadata["extent"][key] for key in ("xmin", "ymin", "xmax", "ymax")) == (643529.4994, 1491241.3322, 709557.5863, 1543360.7234)
    assert len(zone_source["features"]) == 1
    zone_item = zone_source["features"][0]
    assert zone_item["properties"] == {"OBJECTID": ZONE_ID, "LUP_ZONE": "ย.๙", "LUP_SUBZON": ZONE_NAME, "LUP_FAR": 7, "LUP_OSR": 4.5}
    zone_geometry = shape(zone_item["geometry"])
    assert zone_geometry.is_valid
    archived_geometry = shape(read_json(args.evidence / "bma-zone-357.geojson")["features"][0]["geometry"])
    assert archived_geometry.equals_exact(zone_geometry, 0)
    zone_metric = transform(PROJECT, zone_geometry)
    coverage = transform(UNPROJECT, zone_metric.buffer(CONTEXT_BUFFER_M, quad_segs=8))
    assert box(*CONTEXT_BOUNDS).covers(coverage)

    osm = collect_osm(evidence)
    ways = osm_ways(osm)
    overture = read_json(evidence / "overture-buildings.geojson")
    roads = compile_roads(ways, coverage)
    buildings = build_buildings(overture, coverage)

    # The original baseline is recreated from its preserved OSM source, retaining its exact 828 m² plot.
    old_ways = osm_ways(read_json(args.evidence / "osm-din-daeng.json"))
    baseline = road_option(old_ways, 25933839, (12, 11), 11.7)
    parcel = make_parcel(baseline)
    assert zone_geometry.covers(parcel)
    road_options = [baseline, road_option(old_ways, 368336402, (1, 0), None), road_option(old_ways, 41565591, (-2, -1), None)]
    # Pracha Suk is listed as one 11.70 m right-of-way from Sutthisan Winitchai to Pracha Songkhro.
    for item in roads["features"]:
        way_id = item["id"]
        tags, coords = ways[way_id]
        if way_id != baseline["wayId"] and tags.get("name:th", tags.get("name")) == "ถนนประชาสุข" and tags.get("highway") == "tertiary":
            road_options.append(road_option(ways, way_id, (0, -1), 11.7))
    assert len(road_options) >= 3
    overlaps = [item["id"] for item in buildings["features"] if shape(item["geometry"]).intersection(parcel).area > 0]

    # BMA published layer intersections are facts of the statutory map. Restriction branches are not implemented here.
    roadside = geometry_from_layer(evidence, 2, 95).intersection(zone_metric)
    transport = geometry_from_layer(evidence, 5, 81).intersection(zone_metric)
    # The source transport line and polygon describe one 30 m planned road (ง๑๓). The line buffer is for screening only.
    transport_line = geometry_from_layer(evidence, 4, 5).buffer(15, quad_segs=8).intersection(zone_metric)
    transport = unary_union([transport, transport_line])
    water, water_count, incomplete_relations = water_context(osm, coverage, zone_metric)
    screening_areas = [
        screen_entry("bma-roadside-95", "Ratchadaphisek roadside construction/use ordinance (BMA B.E. 2528); specialist review required", f"{MAP_SERVER}/2", roadside),
        screen_entry("bma-planned-road-13", "BMA planned transport corridor ง๑๓ (area and 15 m line screen); survey and branch review required", f"{MAP_SERVER}/5", transport),
    ]
    if not water.is_empty:
        screening_areas.append(screen_entry("osm-water-proximity", "Within 20 m of mapped water geometry; public water boundary and applicable setback require review", OSM_COPYRIGHT, water))

    screening_notes = [
        "BMA layers 2, 4, 5, 7, 8, 10, 11 and 12 checked against the full sourced zone on 2026-11-20. This is screening of the listed published layers only.",
        "Layer 2: retail/wholesale ordinance (object 104) covers the zone; sign ordinance (129) intersects part of it. The scoped residential concepts exclude retail/wholesale and sign structures. Roadside construction/use ordinance (95) is flagged for review.",
        "Transport line object 5 and area object 81 represent planned road ง๑๓; their union is flagged, including a 15 m screen around the source centerline (30 m plan width, not surveyed edges).",
        "No zone intersection found in BMA open-space layers 7/8 or public utility project layers 10/11/12. Those results do not clear other restrictions.",
        "OSM canals and mapped water surfaces are proximity-screened within 20 m. Mapped lines are not verified water banks and the screen is not a statutory setback. Surveyed title, public access, current easements, environmental/aviation restrictions, and detailed review remain unresolved.",
    ]
    if incomplete_relations:
        screening_notes.append(f"{incomplete_relations} OSM water relations lacked a complete assembled surface; the OSM water screening may be incomplete.")

    examples = [
        example_parcel(ways, 867200225, 3, 8, .35, 1, [(0, 0), (0, 24), (23, 24), (23, 0)], "Southwest · Soi Pracha Songkhro 21 Yaek 6-1-6", "southwest", "house"),
        example_parcel(ways, 471405424, 0, 7, .65, -1, [(0, 0), (0, 24), (21, 24), (25, 15), (20, 0)], "North · Soi Inthamara 28", "north", "house"),
        example_parcel(ways, 25902874, 13, 8, .5, -1, [(0, 0), (0, 27), (26, 27), (26, 19), (17, 19), (17, 10), (25, 10), (25, 0)], "East · Soi Inthamara 47", "east", "multifamily"),
    ]
    for item in examples:
        polygon = shape(item["parcel"])
        assert zone_geometry.covers(polygon) and coverage.covers(polygon) and not polygon.intersects(box(*STUDY_BOUNDS)), item["id"]
        assert not any(polygon.intersects(shape(area["geometry"])) for area in screening_areas), item["id"]

    site = {
        "coverage": mapping(coverage), "zoneBoundary": zone_item["geometry"], "screeningCoverage": zone_item["geometry"],
        "screeningAreas": screening_areas, "screeningNotes": screening_notes, "parcel": mapping(parcel),
        "road": baseline, "roadOptions": road_options, "examples": examples,
        "camera": {"center": [100.56695, 13.78486], "zoom": 17.7, "bearing": 26, "pitch": 53},
        "zone": {
            "name": ZONE_NAME, "sourceUrl": f"{MAP_SERVER}/1", "boundaryDescriptionUrl": BMA_ANNEX,
            "catalogUrl": DGA_ZONE, "licenseUrl": DGA_LICENSE, "featureId": ZONE_ID, "retrievalDate": V4_DATE,
        },
        "baselineBuildingOverlapIds": overlaps,
        "heightPolicy": {"estimateStoreyHeight": FLOOR_HEIGHT_METRES, "schematicHeight": FALLBACK_HEIGHT_METRES},
    }
    write_json(args.public / "site.json", site)
    write_json(args.public / "roads.geojson", roads)
    write_json(args.public / "buildings.geojson", buildings)

    payloads = {}
    for filename in ("site.json", "roads.geojson", "buildings.geojson"):
        payload = (args.public / filename).read_bytes()
        payloads[filename] = {"bytes": len(payload), "gzipBytes": len(gzip.compress(payload, mtime=0)), "sha256": hashlib.sha256(payload).hexdigest()}
    raw_counts = {"osmElements": len(osm["elements"]), "osmHighwayWays": len(ways), "overtureBuildings": len(overture["features"]), "osmWidthTags": sum("width" in tags for tags, _ in ways.values())}
    overlay_intersections = {}
    for layer in (2, 4, 5, 7, 8, 10, 11, 12):
        items = read_json(evidence / f"bma-layer-{layer}.geojson")["features"]
        overlay_intersections[str(layer)] = {"bboxFeatureCount": len(items), "zoneIntersectionIds": [item["properties"]["OBJECTID"] for item in items if transform(PROJECT, shape(item["geometry"])).intersects(zone_metric)]}
    manifest = {
        "observationDate": V4_DATE, "phase1ObservationDate": OBSERVED_DATE, "bbox": CONTEXT_BOUNDS,
        "zone": {"name": ZONE_NAME, "featureId": ZONE_ID, "areaM2": zone_metric.area, "geometryType": zone_geometry.geom_type, "ringVertices": len(zone_geometry.exterior.coords), "interiorRings": len(zone_geometry.interiors), "bounds": zone_geometry.bounds, "catalogUrl": DGA_ZONE, "sourceUrl": f"{MAP_SERVER}/1", "licenseUrl": DGA_LICENSE, "boundaryDescriptionUrl": BMA_ANNEX, "datasetDate": "2013-05-16", "retrievalDate": V4_DATE, "sourceSha256": hashlib.sha256((evidence / "bma-zone-357.geojson").read_bytes()).hexdigest()},
        "coverageBufferM": CONTEXT_BUFFER_M, "coverageAreaM2": transform(PROJECT, coverage).area,
        "rawCounts": raw_counts,
        "publishedCounts": {"buildingPolygons": len(buildings["features"]), "roadWays": len(roads["features"]), "heightKinds": dict(Counter(item["properties"]["heightKind"] for item in buildings["features"])), "presetFootprintsIntersectingScenario": len(overlaps)},
        "overtureRelease": RELEASE, "bundledFiles": payloads,
        "overlayScreening": {"layers": overlay_intersections, "screenedDate": V4_DATE, "notes": screening_notes, "sourceUrl": MAP_SERVER, "catalogUrls": [DGA_ORDINANCES, DGA_TRANSPORT, DGA_TRANSPORT_LINE, DGA_OPEN_SPACE, DGA_OPEN_SPACE_LINE, DGA_UTILITIES], "waterScreenM": WATER_SCREEN_M, "mappedWaterFeatureCount": water_count, "incompleteWaterRelations": incomplete_relations},
        "attribution": {"openStreetMap": OSM_COPYRIGHT, "overture": OVERTURE_CREDITS, "license": ODBL, "zoneAndScreening": "Bangkok Metropolitan Administration, City Planning and Development Department. DGA Open Government License v1.0, 10 June 2021.", "governmentLicense": DGA_LICENSE},
        "dataLicenses": {"buildings": "ODbL-1.0. Overture Maps Foundation and source contributors.", "roads": "ODbL-1.0. © OpenStreetMap contributors.", "waterScreen": "ODbL-1.0. © OpenStreetMap contributors; derived proximity screen.", "legislativeGeometry": "DGA Open Government License v1.0 applies to the BMA public statutory datasets on data.go.th. Thai Copyright Act §7(1)–(3),(5) also treats facts, legislation and official regulatory compilations outside copyright. Attribution and transformation documented; no representation of cadastral accuracy.", "thaiCopyrightAct": THAI_COPYRIGHT, "coverage": "Authored 200 m neighborhood context buffer surrounding the sourced zoning boundary (not a zoning boundary)."},
        "rawEvidenceFiles": {path.name: {"bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in sorted(evidence.iterdir()) if path.is_file()},
    }
    write_json(args.public / "manifest.json", manifest)
    print(json.dumps({key: manifest[key] for key in ("zone", "rawCounts", "publishedCounts", "bundledFiles", "overlayScreening")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
