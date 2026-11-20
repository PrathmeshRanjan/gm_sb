import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LineString, Polygon } from 'geojson';
import { feature, roadsForPlot, type ContextData, type RoadProperties } from './context';
import { project, unproject } from './engine/spatial';

const read = <T,>(name: string) => JSON.parse(readFileSync(new URL(`../public/data/${name}`, import.meta.url), 'utf8')) as T;
const actual: ContextData = {
  site: read<ContextData['site']>('site.json'),
  roads: read<ContextData['roads']>('roads.geojson'),
  buildings: { type: 'FeatureCollection', features: [] },
};

describe('nearby mapped-road selection', () => {
  it('keeps the exact inventoried baseline road segment and width at the original parcel', () => {
    const road = roadsForPlot(actual.site.parcel, actual).find((item) => item.wayId === actual.site.road.wayId);
    expect(road?.centerline).toEqual(actual.site.road.centerline);
    expect(road?.width).toBe(11.7);
  });

  it('finds the mapped facing ways for the three expanded-zone scenario parcels', () => {
    expect(actual.site.examples).toHaveLength(3);
    for (const example of actual.site.examples ?? []) {
      const selected = roadsForPlot(example.parcel, actual).find((road) => String(road.wayId) === String(example.roadId));
      expect(selected?.geometrySourceUrl).toBe(`https://www.openstreetmap.org/way/${example.roadId}`);
      expect(selected?.distanceM).toBeCloseTo(example.widthM / 2, 1);
      expect(selected?.width).toBeNull(); // The scenario width is not legal width evidence.
    }
  });

  it('joins adjacent named ways across a mapped junction without fabricating straight extensions', () => {
    const origin = project([100.565, 13.784]);
    const point = (x: number, y: number) => unproject([origin[0] + x, origin[1] + y]);
    const parcel: Polygon = { type: 'Polygon', coordinates: [[[4, -12], [18, -12], [18, 12], [4, 12], [4, -12]].map(([x, y]) => point(x, y))] };
    const segments = [
      feature<LineString, RoadProperties>({ type: 'LineString', coordinates: [point(0, -20), point(0, 0)] }, { id: 1, name: 'Mapped street' }),
      feature<LineString, RoadProperties>({ type: 'LineString', coordinates: [point(0, 0), point(3, 20)] }, { id: 2, name: 'Mapped street' }),
    ];
    const options = roadsForPlot(parcel, { ...actual, roads: { type: 'FeatureCollection', features: segments } });
    expect(options).toHaveLength(2);
    const road = options.find((item) => item.wayId === 1)!;
    expect(new Set(road.sameRoadIds)).toEqual(new Set(['1', '2']));
    // The bend is retained for the engine's alignment/unsupported-condition check.
    expect(road.centerline.coordinates).toEqual([point(0, -20), point(0, 0), point(3, 20)]);
  });

  it('does not pick an arbitrary distant road when the parcel moves away from context', () => {
    const away: Polygon = { type: 'Polygon', coordinates: [[[100.5, 13.7], [100.5002, 13.7], [100.5002, 13.7002], [100.5, 13.7002], [100.5, 13.7]]] };
    expect(roadsForPlot(away, actual)).toEqual([]);
  });
});
