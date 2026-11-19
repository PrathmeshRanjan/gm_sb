import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon } from 'geojson';

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
}

export interface Site {
  coverage: Polygon;
  parcel: Polygon;
  road: RoadOption;
  roadOptions?: RoadOption[];
  camera: { center: [number, number]; zoom: number; bearing: number; pitch: number };
}

export interface ContextData {
  site: Site;
  buildings: FeatureCollection<Polygon | MultiPolygon, BuildingProperties>;
  roads: FeatureCollection<LineString | GeoJSON.MultiLineString, RoadProperties>;
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
