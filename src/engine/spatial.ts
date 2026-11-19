import proj4 from 'proj4';
import type { LineString, Polygon, Position } from 'geojson';
import type { AreaGeometry, ScenarioRoad } from './types';

export type XY = [number, number];
export const UTM_47N = '+proj=utm +zone=47 +datum=WGS84 +units=m +no_defs';
const convert = proj4('EPSG:4326', UTM_47N);
export const project = (coordinate: Position): XY => convert.forward([coordinate[0], coordinate[1]]);
export const unproject = (coordinate: XY): XY => convert.inverse(coordinate);

export function mapArea<T extends AreaGeometry>(geometry: T, transform: (p: Position) => Position): T {
  if (geometry.type === 'Polygon') {
    return { ...geometry, coordinates: geometry.coordinates.map((ring) => ring.map(transform)) };
  }
  return { ...geometry, coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(transform))) };
}

export function points(geometry: AreaGeometry): Position[] {
  return geometry.coordinates.flat(geometry.type === 'Polygon' ? 1 : 2) as Position[];
}

export function extent(p: Position[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of p) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

export function box(minX: number, minY: number, maxX: number, maxY: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]],
  };
}

export function line(coordinates: Position[]): LineString {
  return { type: 'LineString', coordinates };
}

export function normalizePlot(input: Polygon): Polygon | null {
  if (input?.type !== 'Polygon' || !input.coordinates.length) return null;
  let vertices = 0;
  const rings: Position[][] = [];
  for (const raw of input.coordinates) {
    const ring: Position[] = [];
    for (const position of raw) {
      if (!Array.isArray(position) || !Number.isFinite(position[0]) || !Number.isFinite(position[1])) return null;
      const last = ring.at(-1);
      if (!last || last[0] !== position[0] || last[1] !== position[1]) ring.push(position.slice(0, 2));
    }
    const first = ring[0];
    const last = ring.at(-1);
    if (!first || !last) return null;
    if (last[0] !== first[0] || last[1] !== first[1]) ring.push(first);
    vertices += ring.length;
    if (ring.length < 4 || vertices > 1500) return null;
    rings.push(ring);
  }
  return { type: 'Polygon', coordinates: rings };
}

export function roadFrame(plot: Polygon, road: ScenarioRoad) {
  const pointsOnRoad = road.centerline.coordinates.map(project);
  const origin = pointsOnRoad[0];
  const end = pointsOnRoad.at(-1);
  if (!origin || !end || pointsOnRoad.length < 2) throw new Error('Select a mapped road segment.');
  const dx = end[0] - origin[0];
  const dy = end[1] - origin[1];
  const length = Math.hypot(dx, dy);
  if (!(length > 2)) throw new Error('The selected road segment is too short.');
  const tangent: XY = [dx / length, dy / length];
  let normal: XY = [-tangent[1], tangent[0]];
  const signedDistance = (point: XY) => (point[0] - origin[0]) * normal[0]
    + (point[1] - origin[1]) * normal[1];
  const projectedPlot = plot.coordinates[0].slice(0, -1).map(project);
  const side = projectedPlot.reduce((sum, point) => sum + signedDistance(point), 0);
  if (side < 0) normal = [-normal[0], -normal[1]];
  if (pointsOnRoad.some((point) => Math.abs(signedDistance(point)) > 0.15)) {
    throw new Error('Select a straight road segment to evaluate the road plane.');
  }

  const toLocal = (p: Position): XY => {
    const [easting, northing] = project(p);
    return [
      (easting - origin[0]) * normal[0] + (northing - origin[1]) * normal[1],
      (easting - origin[0]) * tangent[0] + (northing - origin[1]) * tangent[1],
    ];
  };
  const toWorld = ([x, y]: Position): XY => unproject([
    origin[0] + x * normal[0] + y * tangent[0],
    origin[1] + x * normal[1] + y * tangent[1],
  ]);

  let nearX = road.widthM / 2;
  let farX = -nearX;
  const modeledY: XY = [0, length];
  if (road.surveyedEdges) {
    const near = road.surveyedEdges.near.coordinates.map(toLocal);
    const far = road.surveyedEdges.far.coordinates.map(toLocal);
    if (near.length < 2 || far.length < 2) throw new Error('Surveyed road edges require two points each.');
    nearX = near[0][0];
    farX = far[0][0];
    if (!(nearX > 0 && farX < 0) || near.some(([x]) => Math.abs(x - nearX) > 0.15)
        || far.some(([x]) => Math.abs(x - farX) > 0.15)) {
      throw new Error('Surveyed edges must bracket the centerline and be parallel to the selected segment.');
    }
    const nearBounds = extent(near);
    const farBounds = extent(far);
    modeledY[0] = Math.max(0, nearBounds.minY, farBounds.minY);
    modeledY[1] = Math.min(length, nearBounds.maxY, farBounds.maxY);
  }
  return {
    toLocal,
    toWorld,
    nearX,
    farX,
    modeledY,
    widthM: nearX - farX,
    baseNearX: road.surveyedEdges ? nearX : (road.baselineWidthM ?? road.widthM) / 2,
    nearEdge: road.surveyedEdges?.near ?? line([[nearX, 0], [nearX, length]].map(toWorld)),
    farEdge: road.surveyedEdges?.far ?? line([[farX, 0], [farX, length]].map(toWorld)),
  };
}
