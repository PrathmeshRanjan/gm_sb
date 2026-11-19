"""Reproduce the Phase 1 geometry checks and verify the shipped scenario preset."""

from __future__ import annotations

import argparse
from math import isclose
from pathlib import Path

from pyproj import Transformer
from shapely import geos_version_string, transform
from shapely.geometry import LineString, Point, Polygon, box, shape
from shapely.ops import unary_union

from prepare_context import read_json


def check_early_experiments() -> None:
    plot = Polygon([(0, 0), (0, 30), (33, 30), (33, 21), (19, 21), (19, 12), (30, 12), (30, 0)])
    assert isclose(plot.area, 828)
    inset = plot.buffer(-3, join_style="mitre")

    print("Straight-road height and setback experiment. Near road edge fixed at x=0.")
    for width, expected in [(11.7, 420), (6, 396), (5, 372)]:
        front = 6 - width / 2 if width < 10 else width * 0.1
        roof_plane = 20 / 2 - width
        envelope = inset.intersection(box(max(front, roof_plane), -50, 100, 100))
        assert plot.covers(envelope) and isclose(envelope.area, expected)
        print(f"  20 m roof, {width:g} m ROW → {envelope.area:.0f} m²")

    bridge = Polygon([
        (0, 0), (10, 0), (10, 4), (20, 4), (20, 0), (30, 0),
        (30, 10), (20, 10), (20, 6), (10, 6), (10, 10), (0, 10),
    ])
    assert bridge.buffer(-1.1).geom_type == "MultiPolygon"
    assert box(0, 0, 5, 20).buffer(-3).is_empty

    wide = box(3, 3, 16, 27).difference(box(12, 11, 16, 19))
    lower = box(6, 5, 13, 26)
    upper = box(9, 5, 13, 26)
    assert lower.covers(upper)
    for name, floors, expected_gross, expected_open in [
        ("wide", [wide] * 3, 840, 548),
        ("stepped", [lower] * 4 + [upper] * 2, 756, 681),
    ]:
        assert all(inset.covers(plate) for plate in floors)
        gross = sum(plate.area for plate in floors)
        open_area = plot.difference(unary_union(floors)).area
        assert isclose(gross, expected_gross) and isclose(open_area, expected_open)
        print(f"  {name}: {gross:.0f} m² GFA, {open_area:.0f} m² geometrically uncovered")


def check_saved_site(evidence: Path, public: Path) -> None:
    site = read_json(public / "site.json")
    projection = Transformer.from_crs("EPSG:4326", "EPSG:32647", always_xy=True)

    def project(geometry):
        return transform(geometry, projection.transform, interleaved=False)

    zone = shape(read_json(evidence / "bma-zone-357.geojson")["features"][0]["geometry"])
    coverage = shape(site["coverage"])
    parcel = project(shape(site["parcel"]))
    centerline = project(shape(site["road"]["centerline"]))
    assert zone.is_valid and zone.covers(coverage)
    assert project(coverage).covers(parcel)
    assert parcel.is_valid and isclose(parcel.area, 828, abs_tol=1e-5)
    assert len(parcel.exterior.coords) == 9
    assert not parcel.equals(parcel.convex_hull)

    layer_1 = read_json(evidence / "bma-layer-1.json")["features"]
    layer_2 = read_json(evidence / "bma-layer-2.json")["features"]
    assert len(layer_1) == 1 and layer_1[0]["attributes"]["OBJECTID"] == 357
    assert layer_1[0]["attributes"]["LUP_SUBZON"] == "ย.๙-๑๓"
    assert len(layer_2) == 1 and layer_2[0]["attributes"]["OBJECTID"] == 104
    for layer in (4, 5, 7, 8):
        assert not read_json(evidence / f"bma-layer-{layer}.json")["features"]

    baseline_width = site["road"]["width"]
    assert baseline_width == 11.70
    assert isclose(centerline.distance(parcel), baseline_width / 2, abs_tol=1e-5)
    frontage = LineString(parcel.exterior.coords[:2])
    assert isclose(frontage.length, 30, abs_tol=1e-5)
    for endpoint in frontage.coords:
        assert isclose(
            centerline.distance(Point(endpoint)),
            baseline_width / 2, abs_tol=1e-5,
        )

    narrow_right_of_way = centerline.buffer(5 / 2, cap_style="flat")
    wide_right_of_way = centerline.buffer(14.7 / 2, cap_style="flat")
    assert isclose(narrow_right_of_way.distance(parcel), 3.35, abs_tol=1e-5)
    overlap = wide_right_of_way.intersection(parcel).area
    assert isclose(overlap, 45, abs_tol=1e-5)
    print(f"Verified default parcel: {parcel.area:.2f} m², {frontage.length:.2f} m modeled frontage")
    print(f"Verified study box is {project(zone).boundary.distance(project(coverage)):.2f} m from zone edge")
    print(f"At 14.7 m what-if ROW the original parcel stays fixed and ROW overlaps {overlap:.2f} m²")


def main() -> None:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--evidence", type=Path, default=Path("research/evidence"))
    cli.add_argument("--public", type=Path, default=Path("public/data"))
    args = cli.parse_args()
    print(f"GEOS {geos_version_string}")
    check_early_experiments()
    check_saved_site(args.evidence, args.public)


if __name__ == "__main__":
    main()
