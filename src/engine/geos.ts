import initGeos from 'geos-wasm';
import { geojsonToGeosGeom, geosGeomToGeojson } from 'geos-wasm/helpers';
import type { Geometry, Polygon } from 'geojson';
import type { AreaGeometry } from './types';
import { DESIGN_CLEARANCE_RESERVE_M } from './rules';

type Geos = Awaited<ReturnType<typeof initGeos>>;
export type NativeGeometry = number;

let initialization: Promise<Geos> | undefined;

export async function withGeos<T>(callback: (scope: GeometryScope) => T): Promise<T> {
  initialization ??= initGeos({ noticeHandler: () => undefined });
  const geos = await initialization;
  const scope = new GeometryScope(geos);
  try {
    return callback(scope);
  } finally {
    scope.close();
  }
}

export class GeometryScope {
  private owned: NativeGeometry[] = [];
  private readonly scalar: number;

  constructor(private readonly geos: Geos) {
    this.scalar = geos.Module._malloc(8);
  }

  close() {
    for (const pointer of this.owned) this.geos.GEOSGeom_destroy(pointer);
    this.owned.length = 0;
    this.geos.Module._free(this.scalar);
  }

  temporary<T>(callback: () => T): T {
    const start = this.owned.length;
    try {
      return callback();
    } finally {
      for (const pointer of this.owned.splice(start)) this.geos.GEOSGeom_destroy(pointer);
    }
  }

  private own(pointer: number): number {
    if (!pointer) throw new Error('GEOS could not process this geometry.');
    this.owned.push(pointer);
    return pointer;
  }

  read(geometry: Geometry) {
    return this.own(geojsonToGeosGeom(geometry, this.geos));
  }

  write(geometry: NativeGeometry): AreaGeometry | null {
    if (this.geos.GEOSisEmpty(geometry) === 1) return null;
    const output = geosGeomToGeojson(geometry, this.geos) as Geometry;
    if (output.type === 'Polygon' || output.type === 'MultiPolygon') return output;
    if (output.type !== 'GeometryCollection') return null;
    const coordinates = output.geometries.flatMap((item) => {
      if (item.type === 'Polygon') return [item.coordinates];
      if (item.type === 'MultiPolygon') return item.coordinates;
      return [];
    });
    return coordinates.length ? { type: 'MultiPolygon', coordinates } : null;
  }

  area(geometry: NativeGeometry) {
    if (!this.geos.GEOSArea(geometry, this.scalar)) throw new Error('GEOS could not compute area.');
    return this.geos.Module.getValue(this.scalar, 'double');
  }

  distance(a: NativeGeometry, b: NativeGeometry) {
    if (!this.geos.GEOSDistance(a, b, this.scalar)) throw new Error('GEOS could not compute distance.');
    return this.geos.Module.getValue(this.scalar, 'double');
  }

  isPolygon(geometry: NativeGeometry) {
    return this.geos.GEOSGeomTypeId(geometry) === 3 && this.geos.GEOSisEmpty(geometry) !== 1;
  }

  minX(geometry: NativeGeometry) {
    if (!this.geos.GEOSGeom_getXMin(geometry, this.scalar)) throw new Error('No minimum x for this geometry.');
    return this.geos.Module.getValue(this.scalar, 'double');
  }

  maxX(geometry: NativeGeometry) {
    if (!this.geos.GEOSGeom_getXMax(geometry, this.scalar)) throw new Error('No maximum x for this geometry.');
    return this.geos.Module.getValue(this.scalar, 'double');
  }

  valid(geometry: NativeGeometry) {
    return this.geos.GEOSisValid(geometry) === 1;
  }

  covers(container: NativeGeometry, candidate: NativeGeometry) {
    const result = this.geos.GEOSCovers(container, candidate);
    if (result === 2) throw new Error('GEOS could not evaluate containment.');
    return result === 1;
  }

  intersects(first: NativeGeometry, second: NativeGeometry) {
    const result = this.geos.GEOSIntersects(first, second);
    if (result === 2) throw new Error('GEOS could not evaluate intersection.');
    return result === 1;
  }

  intersection(a: NativeGeometry, b: NativeGeometry) {
    return this.own(this.geos.GEOSIntersection(a, b));
  }

  difference(a: NativeGeometry, b: NativeGeometry) {
    return this.own(this.geos.GEOSDifference(a, b));
  }

  union(a: NativeGeometry, b: NativeGeometry) {
    return this.own(this.geos.GEOSUnion(a, b));
  }

  buffer(geometry: NativeGeometry, distance: number, quadrantSegments = 8) {
    return this.own(this.geos.GEOSBufferWithStyle(geometry, distance, quadrantSegments, 1, 2, 4));
  }

  removeRepeatedPoints(geometry: NativeGeometry, tolerance: number) {
    return this.own(this.geos.GEOSRemoveRepeatedPoints(geometry, tolerance));
  }

  clearanceBand(geometry: NativeGeometry, required: number) {
    const quadrantSegments = 16;
    // GEOS round caps are inscribed chords. Inflate their apothem to the required
    // distance plus a small reserve, so a slab cut at a chord still clears the line.
    const conservativeRadius = (required + DESIGN_CLEARANCE_RESERVE_M)
      / Math.cos(Math.PI / (4 * quadrantSegments));
    return this.buffer(geometry, conservativeRadius, quadrantSegments);
  }

  length(geometry: NativeGeometry) {
    if (!this.geos.GEOSLength(geometry, this.scalar)) throw new Error('GEOS could not compute length.');
    return this.geos.Module.getValue(this.scalar, 'double');
  }

  largestComponent(geometry: NativeGeometry): NativeGeometry | null {
    const type = this.geos.GEOSGeomTypeId(geometry);
    if (type === 3) return this.geos.GEOSisEmpty(geometry) === 1 ? null : geometry;
    if (type !== 6 && type !== 7) return null;
    let largest: NativeGeometry | null = null;
    let maximumArea = 0;
    const count = this.geos.GEOSGetNumGeometries(geometry);
    for (let index = 0; index < count; index++) {
      // GEOSGetGeometryN returns a borrowed pointer kept alive by the parent geometry.
      const candidate = this.largestComponent(this.geos.GEOSGetGeometryN(geometry, index));
      if (!candidate) continue;
      const candidateArea = this.area(candidate);
      if (candidateArea > maximumArea) {
        largest = candidate;
        maximumArea = candidateArea;
      }
    }
    return largest;
  }

  largestPolygon(geometry: NativeGeometry): Polygon | null {
    const largest = this.largestComponent(geometry);
    return largest ? this.write(largest) as Polygon : null;
  }
}
