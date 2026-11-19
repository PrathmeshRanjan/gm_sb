import type { MultiLineString, Polygon, Position } from 'geojson';
import type { GeometryScope, NativeGeometry } from './geos';
import { AREA_TOLERANCE, DISTANCE_TOLERANCE } from './rules';
import { box, extent, line, mapArea, points, roadFrame } from './spatial';
import type { AreaGeometry, ScenarioInput, ScenarioResult } from './types';
import { STUDY_BBOX } from './types';

export type Prepared = ReturnType<typeof prepare>;

export function prepare(scope: GeometryScope, input: ScenarioInput, plot: Polygon) {
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
  const coverage = points(plot).every(([lon, lat]) =>
    lon >= STUDY_BBOX[0] - 1e-9 && lon <= STUDY_BBOX[2] + 1e-9
    && lat >= STUDY_BBOX[1] - 1e-9 && lat <= STUDY_BBOX[3] + 1e-9);
  const outer = localPlot.coordinates[0];
  const edges = outer.slice(0, -1).map((start, index) => [start, outer[index + 1]]);
  const contactTolerance = 0.15;
  const aligned = (edge: Position[]) => Math.abs(edge[1][0] - edge[0][0]) < 0.25;
  const isBaselineFront = (edge: Position[]) =>
    aligned(edge) && edge.every(([x]) => Math.abs(x - frame.baseNearX) < 0.4);
  const facingEdges = edges.filter((edge, index) => input.frontageEdgeIndex === undefined
    ? isBaselineFront(edge)
    : index === input.frontageEdgeIndex && aligned(edge));
  const frontageM = facingEdges.reduce((total, edge) => {
    if (edge.some(([x]) => Math.abs(x - frame.nearX) > contactTolerance)) return total;
    const [start, end] = edge.map(([, y]) => y).sort((a, b) => a - b);
    return total + Math.max(0, Math.min(end, frame.modeledY[1]) - Math.max(start, frame.modeledY[0]));
  }, 0);
  const privateLines: MultiLineString = {
    type: 'MultiLineString',
    coordinates: [...edges.filter((edge) => !facingEdges.includes(edge)), ...localPlot.coordinates.slice(1)],
  };
  const privateHandle = scope.read(privateLines);
  const boundary: MultiLineString = { type: 'MultiLineString', coordinates: localPlot.coordinates };
  const boundaryHandle = scope.read(boundary);
  const possibleCenterlineOverlap = localBounds.minX < 0;
  const region = {
    maxX: localBounds.maxX + 100,
    minX: Math.min(localBounds.minX, frame.farX) - 100,
    minY: localBounds.minY - 100,
    maxY: localBounds.maxY + 100,
  };

  const widthConflict = scope.temporary(() => scope.area(scope.intersection(
    plotHandle,
    scope.read(box(region.minX, region.minY, frame.nearX - DISTANCE_TOLERANCE, region.maxY)),
  )));
  const alignmentVerified = localBounds.minY >= frame.modeledY[0] - DISTANCE_TOLERANCE
    && localBounds.maxY <= frame.modeledY[1] + DISTANCE_TOLERANCE;
  const affected: NonNullable<ScenarioInput['retainedBuildings']> = [];
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
    if (input.redevelopment === 'retain') {
      const clipped = scope.intersection(plotHandle, scope.read(local));
      retainedHandle = retainedHandle ? scope.union(retainedHandle, clipped) : clipped;
      retainedGfa = retainedGfa !== null && Number.isFinite(building.grossFloorAreaM2)
        ? retainedGfa + building.grossFloorAreaM2!
        : null;
    }
  }
  const road: ScenarioResult['road'] = {
    centerline: line(input.road.centerline.coordinates),
    nearEdge: frame.nearEdge,
    farEdge: frame.farEdge,
    widthM: frame.widthM,
    inferred: !input.road.surveyedEdges,
    frontageM,
    conflictM2: widthConflict,
  };
  return {
    scope, frame, input, localPlot, coverage, plotArea, plotHandle, localBounds, region, road,
    possibleCenterlineOverlap, alignmentVerified, privateHandle, boundaryHandle, affected, retainedHandle,
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
