import initGeos from 'geos-wasm';
import { geojsonToGeosGeom, geosGeomToGeojson } from 'geos-wasm/helpers';
import type { Geometry, Polygon } from 'geojson';
import type { AreaGeometry } from './types';

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

  valid(geometry: NativeGeometry) {
    return this.geos.GEOSisValid(geometry) === 1;
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

  buffer(geometry: NativeGeometry, distance: number) {
    return this.own(this.geos.GEOSBufferWithStyle(geometry, distance, 8, 1, 2, 4));
  }

  length(geometry: NativeGeometry) {
    if (!this.geos.GEOSLength(geometry, this.scalar)) throw new Error('GEOS could not compute length.');
    return this.geos.Module.getValue(this.scalar, 'double');
  }

  largestPolygon(geometry: NativeGeometry): Polygon | null {
    const output = this.write(geometry);
    if (!output) return null;
    if (output.type === 'Polygon') return output;
    let best: Polygon | null = null;
    let largest = 0;
    for (const coordinates of output.coordinates) {
      const polygon: Polygon = { type: 'Polygon', coordinates };
      const area = this.temporary(() => this.area(this.read(polygon)));
      if (area > largest) {
        best = polygon;
        largest = area;
      }
    }
    return best;
  }
}
