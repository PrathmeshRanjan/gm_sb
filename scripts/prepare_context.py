"""Preserve the Phase 1 evidence and compile a bounded, licensed map context."""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
from shutil import copyfile

from pyproj import Transformer
from shapely.geometry import LineString, Polygon, box, mapping, shape


STUDY_BOUNDS = (100.5620, 13.7825, 100.5690, 13.7870)
OBSERVED_DATE = "2026-11-19"
RELEASE = "2026-11-18.0"
MAP_SERVER = "https://cpudgiapp.bangkok.go.th/arcgis/rest/services/GI_Platform/BMAGI_Planing/MapServer"
BMA_ROAD_INVENTORY = (
    "https://webportal.bangkok.go.th/dindaeng/page/sub/624/"
    "%E0%B8%96%E0%B8%99%E0%B8%99-%E0%B8%95%E0%B8%A3%E0%B8%AD%E0%B8%81-"
    "%E0%B9%81%E0%B8%A5%E0%B8%B0%E0%B8%8B%E0%B8%AD%E0%B8%A2"
)
BMA_ANNEX = (
    "https://webportal.bangkok.go.th/public/user_files_editor/354/aboutcpud/2556/"
    "2556%20detial/002_cpd56.pdf"
)
OSM_QUERY = "https://www.openstreetmap.org/api/0.6/map.json?bbox=100.5620,13.7825,100.5690,13.7870"
OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright"
ODBL = "https://opendatacommons.org/licenses/odbl/1-0/"
OVERTURE_CREDITS = "https://docs.overturemaps.org/attribution/"
FALLBACK_HEIGHT_METRES = 6
FLOOR_HEIGHT_METRES = 3.1


def read_json(path: Path) -> dict:
    return json.loads(path.read_bytes())


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def evidence_sources() -> dict[str, tuple[str, str]]:
    sources = {
        "bma-mapserver.json": ("gm-bma-mapserver.json", f"{MAP_SERVER}?f=pjson"),
        "bma-zone-357.geojson": (
            "gm-y913-polygon.json",
            f"{MAP_SERVER}/1/query?f=geojson&where=OBJECTID%3D357&outSR=4326"
            "&outFields=LUP_ZONE,LUP_SUBZON,LUP_FAR,LUP_OSR&returnGeometry=true",
        ),
        "osm-din-daeng.json": ("gm-osm-y913.json", OSM_QUERY),
        "osm-west-exploration.json": (
            "gm-din-daeng-osm.json",
            "https://www.openstreetmap.org/api/0.6/map.json?bbox=100.555,13.782,100.560,13.787",
        ),
        "overture-catalog.json": (
            "gm-overture-stac.json",
            "https://stac.overturemaps.org/catalog.json",
        ),
        "overture-building-collection.json": (
            "gm-overture-building-collection.json",
            f"https://stac.overturemaps.org/{RELEASE}/buildings/building/collection.json",
        ),
        "overture-din-daeng.geojson": (
            "gm-overture-y913.geojson",
            f"Overture CLI, release {RELEASE}, building type, study bbox",
        ),
        "overture-extraction.state": (
            "gm-overture-y913.geojson.state",
            "State from the original Overture CLI download",
        ),
    }
    for layer in (1, 2, 4, 5, 7, 8):
        sources[f"bma-layer-{layer}.json"] = (
            f"gm-y913-layer-{layer}.json",
            f"{MAP_SERVER}/{layer}/query?f=json&geometry="
            "100.5620,13.7825,100.5690,13.7870&geometryType=esriGeometryEnvelope"
            "&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false",
        )
    return sources


def preserve_evidence(evidence: Path, phase1: Path | None) -> list[dict]:
    evidence.mkdir(parents=True, exist_ok=True)
    records = []
    for name, (original, source) in evidence_sources().items():
        path = evidence / name
        if phase1 is not None:
            source_path = phase1 / original
            if path.exists():
                if path.read_bytes() != source_path.read_bytes():
                    raise ValueError(f"Existing original evidence differs: {path}")
            else:
                copyfile(source_path, path)
        payload = path.read_bytes()
        records.append({
            "path": name,
            "source": source,
            "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        })

    manifest = evidence / "manifest.json"
    if manifest.exists():
        saved = read_json(manifest)
        if saved["files"] != records:
            raise ValueError("Local evidence differs from the preserved manifest")
    return records


def feature_collection(features: list[dict], attribution: str, credits_url: str) -> dict:
    return {
        "type": "FeatureCollection",
        "attribution": attribution,
        "attributionUrl": credits_url,
        "license": ODBL,
        "features": features,
    }


def feature(feature_id: str | int, geometry: dict, properties: dict) -> dict:
    return {
        "type": "Feature",
        "id": feature_id,
        "geometry": geometry,
        "properties": {"id": feature_id, **properties},
    }


def positive_number(value: object) -> float | None:
    if (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
        and value > 0
    ):
        return float(value)
    return None


def build_buildings(raw: dict, coverage: Polygon) -> dict:
    buildings = []
    for original in raw["features"]:
        original_geometry = shape(original["geometry"])
        if not original_geometry.is_valid or not original_geometry.intersects(coverage):
            continue
        properties = original["properties"]
        if properties.get("is_underground"):
            continue
        height = positive_number(properties.get("height"))
        floors = positive_number(properties.get("num_floors"))
        if height is not None:
            kind = "sourced"
        elif floors is not None:
            height = round(floors * FLOOR_HEIGHT_METRES, 2)
            kind = "estimate"
        else:
            height = FALLBACK_HEIGHT_METRES
            kind = "schematic"
        providers = sorted({
            record.get("provider") or record.get("dataset") or "unknown"
            for record in properties.get("sources", [])
        })
        building = {
            "height": height,
            "heightKind": kind,
            "providers": providers,
        }
        if floors is not None:
            building["floors"] = floors
        buildings.append(feature(original["id"], original["geometry"], building))
    return feature_collection(
        buildings,
        "Overture Maps Foundation, © OpenStreetMap contributors, Google Open Buildings, "
        "and Microsoft Global ML Building Footprints.",
        OVERTURE_CREDITS,
    )


def osm_ways(raw: dict) -> dict[int, tuple[dict, list[tuple[float, float]]]]:
    nodes = {
        element["id"]: (element["lon"], element["lat"])
        for element in raw["elements"]
        if element["type"] == "node"
    }
    ways = {}
    for element in raw["elements"]:
        tags = element.get("tags", {})
        if element["type"] != "way" or "highway" not in tags:
            continue
        try:
            coordinates = [nodes[node] for node in element["nodes"]]
        except KeyError:
            continue
        if len(set(coordinates)) >= 2:
            ways[element["id"]] = (tags, coordinates)
    return ways


def build_roads(ways: dict, coverage: Polygon) -> dict:
    roads = []
    for way_id, (tags, coords) in ways.items():
        clipped = LineString(coords).intersection(coverage)
        if clipped.is_empty or clipped.geom_type not in {"LineString", "MultiLineString"}:
            continue
        properties = {
            "name": tags.get("name:en", tags.get("name", "")),
            "nameTh": tags.get("name:th", tags.get("name", "")),
            "class": tags["highway"],
        }
        roads.append(feature(way_id, mapping(clipped), properties))
    return feature_collection(roads, "© OpenStreetMap contributors.", OSM_COPYRIGHT)


def road_option(ways: dict, way_id: int, endpoints: tuple[int, int], width: float | None) -> dict:
    tags, coords = ways[way_id]
    osm_url = f"https://www.openstreetmap.org/way/{way_id}"
    return {
        "name": tags["name:en"],
        "nameTh": tags["name:th"],
        "width": width,
        "wayId": way_id,
        "sourceUrl": BMA_ROAD_INVENTORY if width is not None else osm_url,
        "geometrySourceUrl": osm_url,
        "centerline": mapping(LineString([coords[index] for index in endpoints])),
    }


def make_parcel(road: dict) -> Polygon:
    """Place the 828 m² scenario west of the mapped Soi 38–36 segment."""
    project = Transformer.from_crs("EPSG:4326", "EPSG:32647", always_xy=True)
    unproject = Transformer.from_crs("EPSG:32647", "EPSG:4326", always_xy=True)
    south, north = [project.transform(*point) for point in road["centerline"]["coordinates"]]
    dx, dy = north[0] - south[0], north[1] - south[1]
    magnitude = math.hypot(dx, dy)
    tangent = (dx / magnitude, dy / magnitude)
    west = (-tangent[1], tangent[0])
    fixture = [(0, 0), (0, 30), (33, 30), (33, 21), (19, 21), (19, 12), (30, 12), (30, 0)]
    metric = Polygon([
        (
            south[0] + (y + 26) * tangent[0] + (x + road["width"] / 2) * west[0],
            south[1] + (y + 26) * tangent[1] + (x + road["width"] / 2) * west[1],
        )
        for x, y in fixture
    ])
    if not metric.is_valid or not math.isclose(metric.area, 828, abs_tol=1e-6):
        raise ValueError("Scenario fixture must retain its verified 828 m² area")
    return Polygon([unproject.transform(x, y) for x, y in metric.exterior.coords])


def main() -> None:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--evidence", type=Path, default=Path("research/evidence"))
    cli.add_argument("--public", type=Path, default=Path("public/data"))
    cli.add_argument("--import-phase1", type=Path)
    args = cli.parse_args()
    files = preserve_evidence(args.evidence, args.import_phase1)
    bma = read_json(args.evidence / "bma-zone-357.geojson")
    osm = read_json(args.evidence / "osm-din-daeng.json")
    overture = read_json(args.evidence / "overture-din-daeng.geojson")
    coverage = box(*STUDY_BOUNDS)
    zone = bma["features"][0]
    if len(bma["features"]) != 1 or not shape(zone["geometry"]).covers(coverage):
        raise ValueError("Saved zoning geometry does not cover the declared study area")

    osm_buildings = [
        element["tags"] for element in osm["elements"] if "building" in element.get("tags", {})
    ]
    ways = osm_ways(osm)
    source_counts = {
        "osmElements": len(osm["elements"]),
        "osmBuildingTags": len(osm_buildings),
        "osmHeightTags": sum("height" in tags for tags in osm_buildings),
        "osmLevelTags": sum("building:levels" in tags for tags in osm_buildings),
        "osmHighwayWays": sum(
            element["type"] == "way" and "highway" in element.get("tags", {})
            for element in osm["elements"]
        ),
        "osmWidthTags": sum("width" in tags for tags, _ in ways.values()),
        "overtureBuildings": len(overture["features"]),
        "overtureHeightRecords": sum(
            item["properties"].get("height") is not None for item in overture["features"]
        ),
        "overtureFloorRecords": sum(
            item["properties"].get("num_floors") is not None for item in overture["features"]
        ),
        "overtureRoofHeightRecords": sum(
            item["properties"].get("roof_height") is not None for item in overture["features"]
        ),
    }
    assert source_counts == {
        "osmElements": 3918, "osmBuildingTags": 593, "osmHeightTags": 0, "osmLevelTags": 6,
        "osmHighwayWays": 50, "osmWidthTags": 0, "overtureBuildings": 982,
        "overtureHeightRecords": 0, "overtureFloorRecords": 7, "overtureRoofHeightRecords": 0,
    }, source_counts
    write_json(args.evidence / "manifest.json", {
        "observationDate": OBSERVED_DATE,
        "bbox": STUDY_BOUNDS,
        "counts": source_counts,
        "files": files,
    })

    roads = build_roads(ways, coverage)
    buildings = build_buildings(overture, coverage)
    road = road_option(ways, 25933839, (12, 11), 11.7)
    parcel = make_parcel(road)
    if not coverage.covers(parcel):
        raise ValueError("Scenario parcel falls outside the verified coverage box")
    overlaps = [
        item["id"] for item in buildings["features"]
        if shape(item["geometry"]).intersection(parcel).area > 0
    ]
    site = {
        "coverage": mapping(coverage),
        "parcel": mapping(parcel),
        "road": road,
        "roadOptions": [
            road,
            road_option(ways, 368336402, (1, 0), None),
            road_option(ways, 41565591, (-2, -1), None),
        ],
        "camera": {"center": [100.56695, 13.78486], "zoom": 17.7, "bearing": 26, "pitch": 53},
        "zone": {
            "name": zone["properties"]["LUP_SUBZON"],
            "sourceUrl": f"{MAP_SERVER}/1",
            "boundaryDescriptionUrl": BMA_ANNEX,
            "featureId": 357,
        },
        "baselineBuildingOverlapIds": overlaps,
        "heightPolicy": {
            "estimateStoreyHeight": FLOOR_HEIGHT_METRES,
            "schematicHeight": FALLBACK_HEIGHT_METRES,
        },
    }
    write_json(args.public / "site.json", site)
    write_json(args.public / "roads.geojson", roads)
    write_json(args.public / "buildings.geojson", buildings)
    payloads = {}
    for filename in ("site.json", "roads.geojson", "buildings.geojson"):
        payload = (args.public / filename).read_bytes()
        payloads[filename] = {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
    summary = {
        "observationDate": OBSERVED_DATE,
        "bbox": STUDY_BOUNDS,
        "rawCounts": source_counts,
        "publishedCounts": {
            "buildingPolygons": len(buildings["features"]),
            "roadWays": len(roads["features"]),
            "heightKinds": dict(Counter(
                item["properties"]["heightKind"] for item in buildings["features"]
            )),
            "presetFootprintsIntersectingScenario": len(overlaps),
        },
        "overtureRelease": RELEASE,
        "bundledFiles": payloads,
        "attribution": {
            "openStreetMap": OSM_COPYRIGHT,
            "overture": OVERTURE_CREDITS,
            "license": ODBL,
        },
        "dataLicenses": {
            "buildings": "ODbL-1.0. Overture Maps Foundation and source contributors.",
            "roads": "ODbL-1.0. © OpenStreetMap contributors.",
            "coverage": "Authored rectangular limit for verified study area. See the BMA zone citation.",
        },
    }
    write_json(args.public / "manifest.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
