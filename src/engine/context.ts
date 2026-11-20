import type { MultiLineString, Polygon, Position } from 'geojson';
import type { GeometryScope, NativeGeometry } from './geos';
import { AREA_TOLERANCE, GEOMETRY_AREA_TOLERANCE, ROAD_ALIGNMENT_TOLERANCE } from './rules';
import { box, extent, line, mapArea, points, project, roadFrame } from './spatial';
import type { AreaGeometry, ScenarioInput, ScenarioResult } from './types';
import { STUDY_BBOX } from './types';

export type Prepared = ReturnType<typeof prepare>;

/** Entire polygon coverage in one metric CRS, including every edge, hole and component. */
export function assessSite(scope: GeometryScope, input: ScenarioInput, plot: Polygon) {
  return scope.temporary(() => {
    const projectedPlot = scope.read(mapArea(plot, project));
    if (!scope.valid(projectedPlot) || scope.area(projectedPlot) < 0.1) {
      throw new Error('Draw a valid plot without crossing edges or overlapping holes.');
    }
    const plotArea = scope.area(projectedPlot);
    const original = box(...STUDY_BBOX);
    const covers = (geometry: AreaGeometry): boolean | null => {
      try {
        const projected = scope.read(mapArea(geometry, project));
        if (!scope.valid(projected)) return null;
        return scope.covers(projected, projectedPlot);
      } catch {
        return null;
      }
    };
    const screeningVerified = covers(input.screeningCoverage ?? original) === true;
    const zoneCoverage = input.zoneBoundary ? covers(input.zoneBoundary) : null;
    const zoneEligibility: NonNullable<ScenarioResult['zoneEligibility']> = input.zoneBoundary
      ? zoneCoverage === null ? 'unavailable' : zoneCoverage ? 'inside' : 'outside'
      : screeningVerified ? 'study-area-only' : 'unavailable';
    const base = { plotArea, screeningVerified, zoneEligibility };
    const status = (value: 'eligible' | 'outside-zone' | 'outside-coverage' | 'data-unavailable' | 'unsupported-site', message?: string) => ({ ...base, status: value, message });
    if (zoneEligibility === 'outside') return status('outside-zone', 'Part of the drawn parcel lies outside ย.๙-๑๓. The entire polygon must be inside the selected zone.');
    if (input.zoneBoundary && zoneCoverage === null) return status('data-unavailable', 'The full zone boundary could not be validated.');
    if (!input.zoneBoundary && !screeningVerified) return input.zoneBoundary === undefined && !input.contextCoverage
      ? status('outside-coverage', 'Part of this plot is outside the verified study area.')
      : status('data-unavailable', 'The full zone boundary is unavailable here, so eligibility cannot be determined.');
    if (input.contextCoverage && !covers(input.contextCoverage)) return status('data-unavailable', 'The plot is inside the zone but its current neighborhood data are unavailable.');
    for (const overlay of input.screeningAreas ?? []) {
      const projected = scope.read(mapArea(overlay.geometry, project));
      if (!scope.valid(projected)) return status('data-unavailable', `The ${overlay.label} screening geometry is unavailable or invalid.`);
      if (scope.intersects(projectedPlot, projected)) return status('unsupported-site', `The plot intersects ${overlay.label}. The applicable additional restrictions require separate assessment before generating designs.`);
    }
    if (input.roadSelectionAvailable === false) return status('unsupported-site', 'Choose an actual facing road and supply a right-of-way width between 2 m and 100 m to evaluate this site.');
    const road = input.road;
    if (['footway', 'path', 'cycleway', 'steps', 'pedestrian', 'bridleway', 'corridor', 'construction', 'proposed', 'motorway', 'motorway_link'].includes(road.roadClass ?? '')
      || [road.access, road.vehicle, road.motorVehicle].some((value) => value === 'no' || value === 'private')
      || [road.bridge, road.tunnel].some((value) => value && value !== 'no')
      || (road.layer && Number(road.layer) !== 0)) {
      return status('unsupported-site', 'Mapped access or grade-separation attributes on the selected road require separate public-access assessment. Choose an appropriate adjoining road or verify the site conditions.');
    }
    return status('eligible');
  });
}

/** Conservative screening for a second mapped alignment plausibly serving a parcel edge.
 * Unmeasured widths remain conditional; nearby centerlines alone do not establish legal frontage.
 */
function additionalFrontage(scope: GeometryScope, input: ScenarioInput, outer: Position[], frame: ReturnType<typeof roadFrame>, plot: NativeGeometry) {
  const bounds = extent(outer);
  for (const road of input.nearbyRoads ?? []) {
    const alignment = road.centerline.coordinates.map(frame.toLocal);
    if (alignment.length < 2) continue;
    for (let index = 1; index < alignment.length; index++) {
      const [ax, ay] = alignment[index - 1];
      const [bx, by] = alignment[index];
      const length = Math.hypot(bx - ax, by - ay);
      if (length < 2) continue;
      // Suppress only collinear continuations, rather than entire way IDs. A
      // single mapped way may wrap around the parcel and create a second frontage.
      if (Math.max(Math.abs(ax), Math.abs(bx)) < 0.15) continue;
      const crossesBounds = Math.max(ax, bx) >= bounds.minX && Math.min(ax, bx) <= bounds.maxX
        && Math.max(ay, by) >= bounds.minY && Math.min(ay, by) <= bounds.maxY;
      const crossing = crossesBounds && scope.temporary(() => scope.length(scope.intersection(plot, scope.read(line([[ax, ay], [bx, by]])))) > 1);
      if (crossing) return `Another mapped alignment (${road.name || road.id}) crosses the scenario parcel. Road reservation and access require separate assessment.`;
      const tx = (bx - ax) / length;
      const ty = (by - ay) / length;
      for (let edge = 1; edge < outer.length; edge++) {
        const a = outer[edge - 1];
        const b = outer[edge];
        const edgeLength = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (edgeLength < 2) continue;
        const across = ([x, y]: Position) => (x - ax) * -ty + (y - ay) * tx;
        const along = ([x, y]: Position) => (x - ax) * tx + (y - ay) * ty;
        const da = across(a);
        const db = across(b);
        if (Math.abs(da - db) > Math.max(0.4, 0.12 * edgeLength)) continue;
        const ends = [along(a), along(b)].sort((x, y) => x - y);
        const overlap = Math.min(length, ends[1]) - Math.max(0, ends[0]);
        if (overlap < Math.max(2, edgeLength * 0.35)) continue;
        const distance = Math.max(Math.abs(da), Math.abs(db));
        // Unknown widths use conservative class-specific screening distances,
        // not legal ROW dimensions. Actual legal adjacency still needs evidence.
        const arterial = /^(motorway|trunk|primary|secondary)(?:_link)?$/.test(road.roadClass ?? '');
        const proximity = road.widthM !== undefined ? road.widthM / 2 + 0.4 : arterial ? 25 : 12;
        if (distance <= proximity) return `Another mapped road (${road.name || road.id}) plausibly faces this parcel. Multiple-frontage/access geometry requires separate assessment; this single-road model cannot evaluate it.`;
      }
    }
  }
  return undefined;
}

export function prepare(scope: GeometryScope, input: ScenarioInput, plot: Polygon, eligibility = assessSite(scope, input, plot)) {
  if (!Number.isFinite(input.road.widthM) || input.road.widthM < 2 || input.road.widthM > 100) {
    throw new Error('Enter a right-of-way width between 2 m and 100 m.');
  }

  const frame = roadFrame(plot, input.road);
  const localPlot = mapArea(plot, frame.toLocal);
  const plotHandle = scope.read(localPlot);
  if (!scope.valid(plotHandle) || scope.area(plotHandle) < 0.1) {
    throw new Error('Draw a valid plot without crossing edges or overlapping holes.');
  }

  const plotArea = scope.area(plotHandle);
  const localBounds = extent(points(localPlot));
  const coverage = eligibility.status === 'eligible';
  const outer = localPlot.coordinates[0];
  const edges = outer.slice(0, -1).map((start, index) => [start, outer[index + 1]]);
  const contactTolerance = 0.15;
  const aligned = (edge: Position[]) =>
    Math.abs(edge[1][0] - edge[0][0]) <= Math.max(0.25, 0.08 * Math.abs(edge[1][1] - edge[0][1]));
  const isBaselineFront = (edge: Position[]) =>
    aligned(edge) && edge.every(([x]) => Math.abs(x - frame.baseNearX) < 0.4);
  const facingEdges = edges.filter((edge, index) => isBaselineFront(edge)
    && (input.frontageEdgeIndex === undefined || index === input.frontageEdgeIndex));
  const frontageSegments: Position[][] = [];
  const frontageM = facingEdges.reduce((total, edge) => {
    if (edge.some(([x]) => Math.abs(x - frame.nearX) > contactTolerance)) return total;
    const [start, end] = edge.map(([, y]) => y).sort((a, b) => a - b);
    const from = Math.max(start, frame.modeledY[0]);
    const to = Math.min(end, frame.modeledY[1]);
    if (to > from) frontageSegments.push([[frame.nearX, from], [frame.nearX, to]].map(frame.toWorld));
    return total + Math.max(0, to - from);
  }, 0);
  const privateLines: MultiLineString = {
    type: 'MultiLineString',
    coordinates: [...edges.filter((edge) => !facingEdges.includes(edge)), ...localPlot.coordinates.slice(1)],
  };
  const privateHandle = scope.read(privateLines);
  const boundary: MultiLineString = { type: 'MultiLineString', coordinates: localPlot.coordinates };
  const boundaryHandle = scope.read(boundary);
  const region = {
    maxX: localBounds.maxX + 100,
    minX: Math.min(localBounds.minX, frame.farX) - 100,
    minY: localBounds.minY - 100,
    maxY: localBounds.maxY + 100,
  };

  const [roadStart, roadEnd] = frame.modeledY;
  if (roadEnd <= roadStart) throw new Error('The surveyed road edges do not overlap the selected road segment.');
  const overlapAt = (nearEdge: number) => scope.temporary(() => scope.area(scope.intersection(
    plotHandle,
    scope.read(box(frame.farX, roadStart, nearEdge, roadEnd)),
  )));
  const widthConflict = overlapAt(frame.nearX);
  const conflictsWithRoad = overlapAt(frame.nearX - ROAD_ALIGNMENT_TOLERANCE) > AREA_TOLERANCE;
  const alignmentVerified = localBounds.minY >= roadStart - ROAD_ALIGNMENT_TOLERANCE
    && localBounds.maxY <= roadEnd + ROAD_ALIGNMENT_TOLERANCE;
  const frontageMatched = input.nearbyRoads === undefined
    ? localBounds.minX < frame.baseNearX + 3
    : facingEdges.length > 0;
  const affected: NonNullable<ScenarioInput['retainedBuildings']> = [];
  const preservedBuildingParts: ScenarioResult['preservedBuildingParts'] = [];
  let retainedHandle: NativeGeometry | null = null;
  let retainedGfa: number | null = 0;

  for (const building of input.retainedBuildings ?? []) {
    const local = mapArea(building.footprint, frame.toLocal);
    const overlaps = scope.temporary(() => {
      const footprint = scope.read(local);
      return scope.valid(footprint)
        && scope.area(scope.intersection(plotHandle, footprint)) > AREA_TOLERANCE;
    });
    if (!overlaps) continue;
    affected.push(building);
    const handle = scope.read(local);
    const outside = scope.difference(handle, plotHandle);
    const straddles = scope.area(outside) > AREA_TOLERANCE;
    if (input.redevelopment === 'retain') {
      const clipped = scope.intersection(plotHandle, handle);
      retainedHandle = retainedHandle ? scope.union(retainedHandle, clipped) : clipped;
      const gfa = building.eligibleGrossFloorAreaM2 ?? (straddles ? undefined : building.grossFloorAreaM2);
      retainedGfa = retainedGfa !== null && gfa !== undefined && Number.isFinite(gfa) && gfa >= 0
        ? retainedGfa + gfa : null;
    } else if (building.id && straddles) {
      const remaining = scope.write(outside);
      if (remaining) preservedBuildingParts.push({ id: building.id, geometry: mapArea(remaining, frame.toWorld) });
    }
  }
  const road: ScenarioResult['road'] = {
    centerline: line(input.road.centerline.coordinates),
    nearEdge: frame.nearEdge,
    farEdge: frame.farEdge,
    widthM: frame.widthM,
    inferred: !input.road.surveyedEdges,
    frontageM,
    frontage: { type: 'MultiLineString', coordinates: frontageSegments },
    conflictM2: widthConflict,
  };
  return {
    scope, frame, input, localPlot, coverage, plotArea, plotHandle, localBounds, region, road,
    coverageStatus: eligibility.status, screeningVerified: eligibility.screeningVerified, zoneEligibility: eligibility.zoneEligibility,
    unsupportedReason: additionalFrontage(scope, input, outer, frame, plotHandle),
    conflictsWithRoad, alignmentVerified, frontageMatched, privateHandle, boundaryHandle, affected, preservedBuildingParts, retainedHandle,
    retainedGfa: input.redevelopment === 'retain' && !input.retainedBuildings ? null : retainedGfa,
  };
}

export function clipRoadSide(ctx: Prepared, envelope: NativeGeometry, atX: number) {
  const { maxX, minY, maxY } = ctx.region;
  if (atX >= maxX) return ctx.scope.read({ type: 'Polygon', coordinates: [] });
  return ctx.scope.intersection(envelope, ctx.scope.read(box(atX, minY, maxX, maxY)));
}

export function worldGeometry(ctx: Prepared, geometry: AreaGeometry) {
  return mapArea(geometry, ctx.frame.toWorld);
}

/** Serialize generated polygonal geometry without changing any user input. */
export function serializeAreaForAudit(ctx: Prepared, geometry: NativeGeometry): { world: AreaGeometry; local: NativeGeometry } | null {
  const { scope } = ctx;
  if (!scope.valid(geometry)) return null;
  // Only consecutive points within 10 nanometres are removed. There is no
  // arbitrary topology repair, snapping of the parcel, or clearance change.
  const cleaned = scope.removeRepeatedPoints(geometry, 1e-8);
  if (!scope.valid(cleaned)) return null;
  const shape = scope.write(cleaned);
  if (!shape) return null;
  const world = worldGeometry(ctx, shape);
  if (!scope.valid(scope.read(world))) return null;
  const local = scope.read(mapArea(world, ctx.frame.toLocal));
  if (!scope.valid(local) || Math.abs(scope.area(local) - scope.area(geometry)) > GEOMETRY_AREA_TOLERANCE) return null;
  return { world, local };
}
