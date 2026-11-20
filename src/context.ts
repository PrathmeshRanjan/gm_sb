import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon, Position } from 'geojson';
import { project, type XY } from './engine/spatial';

export interface RoadOption {
  name: string;
  nameTh: string;
  width: number | null;
  wayId: string | number;
  sourceUrl: string;
  geometrySourceUrl?: string;
  centerline: LineString;
}

export interface BuildingProperties {
  id: string | number;
  height: number;
  heightKind: 'sourced' | 'estimate' | 'schematic';
  floors?: number;
  grossFloorAreaM2?: number;
}

export interface RoadProperties {
  id: string | number;
  name?: string;
  nameTh?: string;
  class?: string;
  mappedWidth?: string | number;
  accessEvidence?: string;
  access?: string;
  vehicle?: string;
  motor_vehicle?: string;
  bridge?: string;
  tunnel?: string;
  layer?: string;
}

export interface Site {
  coverage: Polygon | MultiPolygon;
  zoneBoundary?: Polygon | MultiPolygon;
  screeningCoverage?: Polygon | MultiPolygon;
  screeningAreas?: { id: string; label: string; sourceUrl: string; geometry: Polygon | MultiPolygon }[];
  screeningNotes?: string[];
  zone?: { name: string; sourceUrl: string; boundaryDescriptionUrl?: string; featureId?: number; catalogUrl?: string; licenseUrl?: string; retrievalDate?: string };
  parcel: Polygon;
  road: RoadOption;
  roadOptions?: RoadOption[];
  examples?: { id: string; label: string; parcel: Polygon; roadId: number | string; widthM: number; profile: 'house' | 'multifamily'; camera: Site['camera'] }[];
  camera: { center: [number, number]; zoom: number; bearing: number; pitch: number };
}

export interface ContextData {
  site: Site;
  buildings: FeatureCollection<Polygon | MultiPolygon, BuildingProperties>;
  roads: FeatureCollection<LineString | GeoJSON.MultiLineString, RoadProperties>;
}

export interface NearbyRoad extends RoadOption {
  key: string;
  distanceM: number;
  sameRoadIds: string[];
  mappedCenterline: LineString;
  mappedWidth?: string | number;
  accessEvidence?: string;
  roadClass?: string;
  access?: string;
  vehicle?: string;
  motorVehicle?: string;
  bridge?: string;
  tunnel?: string;
  layer?: string;
}

interface MappedRoad {
  key: string;
  properties: RoadProperties;
  geometry: LineString;
}

export async function loadContext(signal: AbortSignal): Promise<ContextData> {
  async function read<T>(file: string): Promise<T> {
    const response = await fetch(`${import.meta.env.BASE_URL}data/${file}`, { signal });
    if (!response.ok) throw new Error(`Neighborhood data unavailable (${response.status}).`);
    return response.json() as Promise<T>;
  }

  const [site, buildings, roads] = await Promise.all([
    read<ContextData['site']>('site.json'),
    read<ContextData['buildings']>('buildings.geojson'),
    read<ContextData['roads']>('roads.geojson'),
  ]);
  return { site, buildings, roads };
}

function mappedRoads(roads: ContextData['roads']): MappedRoad[] {
  return roads.features.flatMap(({ geometry, properties }) => {
    const parts = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
    return parts.flatMap((coordinates, part) => coordinates.length < 2 ? [] : [{
      key: parts.length === 1 ? String(properties.id) : `${properties.id}:${part}`,
      properties,
      geometry: { type: 'LineString' as const, coordinates },
    }]);
  });
}

export function roadLabel(properties: RoadProperties) {
  return properties.name || properties.nameTh || `Unnamed ${properties.class ?? 'road'} · ${properties.id}`;
}

export function namedRoadLocations(roads: ContextData['roads']) {
  return mappedRoads(roads).flatMap(({ key, properties, geometry }) => {
    if (!properties.name && !properties.nameTh) return [];
    const middle = geometry.coordinates[Math.floor((geometry.coordinates.length - 1) / 2)];
    const next = geometry.coordinates[Math.ceil((geometry.coordinates.length - 1) / 2)];
    const center: [number, number] = [(middle[0] + next[0]) / 2, (middle[1] + next[1]) / 2];
    return [{ key, name: `${roadLabel(properties)} · ${properties.id}`, center }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

const dot = (a: XY, b: XY) => a[0] * b[0] + a[1] * b[1];
const subtract = (a: XY, b: XY): XY => [a[0] - b[0], a[1] - b[1]];

function pointSegmentDistance(p: XY, a: XY, b: XY) {
  const direction = subtract(b, a);
  const denominator = dot(direction, direction);
  const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, dot(subtract(p, a), direction) / denominator));
  return Math.hypot(p[0] - a[0] - t * direction[0], p[1] - a[1] - t * direction[1]);
}

function segmentDistance(a: XY, b: XY, c: XY, d: XY) {
  const side = (p: XY, q: XY, r: XY) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

function nearestSegment(coordinates: XY[], ring: XY[]) {
  let distanceM = Infinity;
  let index = 0;
  for (let i = 0; i + 1 < coordinates.length; i++) {
    for (let j = 0; j + 1 < ring.length; j++) {
      const distance = segmentDistance(coordinates[i], coordinates[i + 1], ring[j], ring[j + 1]);
      if (distance < distanceM) { distanceM = distance; index = i; }
    }
  }
  return { distanceM, index };
}

function sharesName(a: RoadProperties, b: RoadProperties) {
  return Boolean((a.name && a.name === b.name) || (a.nameTh && a.nameTh === b.nameTh));
}

function samePoint(a: Position, b: Position) {
  return Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
}

/** Join uniquely identifiable endpoint continuations of the same named road; never bridge an unmapped gap. */
function connectedRoad(seed: MappedRoad, candidates: MappedRoad[]) {
  const used = new Set([seed.key]);
  let coordinates = [...seed.geometry.coordinates];
  let segmentIds = coordinates.slice(1).map(() => String(seed.properties.id));
  for (const atStart of [true, false]) {
    while (true) {
      const endpoint = atStart ? coordinates[0] : coordinates[coordinates.length - 1];
      const continuations = candidates.filter((candidate) => !used.has(candidate.key) && sharesName(seed.properties, candidate.properties)
        && (samePoint(endpoint, candidate.geometry.coordinates[0]) || samePoint(endpoint, candidate.geometry.coordinates[candidate.geometry.coordinates.length - 1])));
      if (continuations.length !== 1) break;
      const next = continuations[0];
      let extension = next.geometry.coordinates;
      if (atStart ? samePoint(endpoint, extension[0]) : samePoint(endpoint, extension[extension.length - 1])) extension = [...extension].reverse();
      coordinates = atStart ? [...extension.slice(0, -1), ...coordinates] : [...coordinates, ...extension.slice(1)];
      const newIds = extension.slice(1).map(() => String(next.properties.id));
      segmentIds = atStart ? [...newIds, ...segmentIds] : [...segmentIds, ...newIds];
      used.add(next.key);
    }
  }
  return { coordinates, segmentIds };
}

/** Retain actual bends whenever they occur across the parcel's projected frontage span. */
function parcelAlignment(coordinates: Position[], ring: XY[], segmentIds: string[], reference?: LineString) {
  const metric = coordinates.map(project);
  const nearest = nearestSegment(metric, ring);
  let start = nearest.index;
  let end = start + 1;
  const origin = metric[start];
  const tangent = subtract(metric[end], origin);
  const length = Math.hypot(...tangent);
  if (length > 0) {
    const scalar = (p: XY) => dot(subtract(p, origin), tangent) / length;
    const projection = ring.map(scalar);
    const min = Math.min(...projection), max = Math.max(...projection);
    while (start > 0 && scalar(metric[start]) > min + 0.15) start--;
    while (end < metric.length - 1 && scalar(metric[end]) < max - 0.15) end++;
  }
  let alignment = coordinates.slice(start, end + 1);
  if (reference && dot(subtract(project(reference.coordinates.at(-1)!), project(reference.coordinates[0])), tangent) < 0) {
    alignment = alignment.reverse();
  }
  return { centerline: { type: 'LineString' as const, coordinates: alignment }, ids: [...new Set(segmentIds.slice(start, end))] };
}

/** Nearby options are derived from mapped road segments, rather than a fixed preset list. */
export function roadsForPlot(plot: Polygon, context: ContextData) {
  const [west, south, east, north] = bounds(plot);
  const ring = plot.coordinates[0].map(project);
  const candidates = mappedRoads(context.roads).filter(({ geometry }) => {
    // A cheap broad-phase query in degrees; exact proximity is checked in UTM below.
    const pad = 0.0013;
    for (let i = 0; i + 1 < geometry.coordinates.length; i++) {
      const [a, b] = [geometry.coordinates[i], geometry.coordinates[i + 1]];
      if (Math.max(a[0], b[0]) >= west - pad && Math.min(a[0], b[0]) <= east + pad
        && Math.max(a[1], b[1]) >= south - pad && Math.min(a[1], b[1]) <= north + pad) return true;
    }
    return false;
  });
  const inventory = new Map((context.site.roadOptions ?? [context.site.road]).map((option) => [String(option.wayId), option]));
  const nearby = candidates.flatMap((seed) => {
    const { properties, geometry } = seed;
    const { distanceM } = nearestSegment(geometry.coordinates.map(project), ring);
    if (distanceM > 100) return [];
    const matched = inventory.get(String(properties.id));
    const sourceUrl = `https://www.openstreetmap.org/way/${properties.id}`;
    const connected = connectedRoad(seed, candidates);
    const alignment = parcelAlignment(connected.coordinates, ring, connected.segmentIds, matched?.centerline);
    const option: NearbyRoad = {
      key: seed.key,
      wayId: properties.id,
      name: matched?.name ?? roadLabel(properties),
      nameTh: properties.nameTh ?? '',
      width: matched?.width ?? null,
      sourceUrl: matched?.sourceUrl ?? sourceUrl,
      geometrySourceUrl: sourceUrl,
      distanceM,
      centerline: alignment.centerline,
      mappedCenterline: geometry,
      sameRoadIds: alignment.ids,
      mappedWidth: properties.mappedWidth,
      accessEvidence: properties.accessEvidence,
      roadClass: properties.class,
      access: properties.access,
      vehicle: properties.vehicle,
      motorVehicle: properties.motor_vehicle,
      bridge: properties.bridge,
      tunnel: properties.tunnel,
      layer: properties.layer,
    };
    return [option];
  });
  return nearby.sort((a, b) => a.distanceM - b.distanceM || a.key.localeCompare(b.key));
}

function bounds(geometry: Polygon | MultiPolygon) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const polygon of polygons) {
    for (const [x, y] of polygon[0] ?? []) {
      west = Math.min(west, x);
      south = Math.min(south, y);
      east = Math.max(east, x);
      north = Math.max(north, y);
    }
  }
  return [west, south, east, north];
}

export function nearbyBuildings(plot: Polygon, buildings: ContextData['buildings']) {
  const [west, south, east, north] = bounds(plot);
  return buildings.features.filter(({ geometry }) => {
    const [left, bottom, right, top] = bounds(geometry);
    return left <= east && right >= west && bottom <= north && top >= south;
  }).map(({ geometry, properties }) => ({
    id: String(properties.id),
    footprint: geometry,
    grossFloorAreaM2: properties.grossFloorAreaM2,
  }));
}

export function feature<G extends GeoJSON.Geometry, P extends GeoJSON.GeoJsonProperties>(
  geometry: G,
  properties: P,
): Feature<G, P> {
  return { type: 'Feature', geometry, properties };
}
