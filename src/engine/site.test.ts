import { describe, expect, it } from 'vitest';
import type { LineString, MultiPolygon, Polygon } from 'geojson';
import site from '../../public/data/site.json';
import { nearbyBuildings, roadsForPlot, type ContextData } from '../context';
import { readFileSync } from 'node:fs';
import { calculateScenario, validateGeneratedConcept } from './index';
import { assessSite } from './context';
import { withGeos } from './geos';
import { box, line, mapArea, roadFrame } from './spatial';
import type { ScenarioInput } from './types';

const preset: ScenarioInput = {
  plot: site.parcel as Polygon,
  profile: 'house', redevelopment: 'clear',
  road: { id: 'selected', name: site.road.name, widthM: 11.7, baselineWidthM: 11.7,
    widthSource: 'district-inventory', centerline: site.road.centerline as LineString },
};
const frame = roadFrame(preset.plot, preset.road);
const world = (geometry: Polygon) => mapArea(geometry, ([x, y]) => frame.toWorld([x + frame.nearX, y + 24]));
const plot = world(box(0, 0, 16, 26));

describe('zone and site eligibility', () => {
  it('rejects an edge crossing a zone concavity even though all vertices lie inside', async () => {
    const zone = world({ type: 'Polygon', coordinates: [[
      [-3, -3], [19, -3], [19, 8], [10, 8], [10, 18], [19, 18], [19, 29], [-3, 29], [-3, -3],
    ]] });
    const result = await calculateScenario({ ...preset, plot, zoneBoundary: zone, roadSelectionAvailable: false });
    expect(result.zoneEligibility).toBe('outside');
    expect(result.validation).toBe('outside-zone');
    expect(result.plotAreaM2).toBeCloseTo(416, 5);
    expect(result.concepts).toEqual([]);
  });

  it('rejects enclosure of a zone hole and accepts a separate component of a multipolygon', async () => {
    const outer = box(-5, -5, 25, 35);
    outer.coordinates.push([[4, 5], [4, 10], [10, 10], [10, 5], [4, 5]]);
    const zone: MultiPolygon = { type: 'MultiPolygon', coordinates: [world(outer).coordinates, world(box(45, 0, 75, 35)).coordinates] };
    await withGeos((scope) => {
      const hole = assessSite(scope, { ...preset, zoneBoundary: zone }, plot);
      expect(hole.status).toBe('outside-zone');
      const other = world(box(50, 6, 65, 26));
      const inside = assessSite(scope, { ...preset, zoneBoundary: zone }, other);
      expect(inside.status).toBe('eligible');
      expect(inside.zoneEligibility).toBe('inside');
    });
  });

  it('distinguishes zone eligibility, context coverage and missing road selection', async () => {
    const zone = world(box(-10, -10, 45, 45));
    const noRoad = await calculateScenario({ ...preset, plot, zoneBoundary: zone, roadSelectionAvailable: false });
    expect(noRoad.validation).toBe('unsupported-site');
    expect(noRoad.zoneEligibility).toBe('inside');
    const noContext = await calculateScenario({ ...preset, plot, zoneBoundary: zone, contextCoverage: world(box(-5, -5, 8, 35)) });
    expect(noContext.validation).toBe('data-unavailable');
    expect(noContext.zoneEligibility).toBe('inside');
    const noScreening = await calculateScenario({ ...preset, plot, zoneBoundary: zone,
      screeningCoverage: world(box(100, 100, 120, 120)) });
    expect(noScreening.validation).toBe('valid');
    expect(noScreening.coverageVerified).toBe(false);
  });

  it('blocks a mapped regulatory screening intersection without implying zoning ineligibility', async () => {
    const zone = world(box(-10, -10, 45, 45));
    const result = await calculateScenario({ ...preset, plot, zoneBoundary: zone, screeningCoverage: zone,
      screeningAreas: [{ id: 'corridor', label: 'transport screening area', sourceUrl: 'https://example.invalid', geometry: world(box(15, 10, 30, 16)) }] });
    expect(result.validation).toBe('unsupported-site');
    expect(result.zoneEligibility).toBe('inside');
    expect(result.message).toContain('transport screening area');
    expect(result.concepts).toHaveLength(0);
  });

  it('conservatively blocks a second plausible frontage and keeps adjacent continuation eligible', async () => {
    const second = line([[frame.nearX + 20, 24], [frame.nearX + 20, 50]].map(frame.toWorld));
    const continuation = line([[0, 0], [0, 24]].map(frame.toWorld));
    const base = { ...preset, plot, zoneBoundary: world(box(-10, -10, 45, 45)) };
    const corner = await calculateScenario({ ...base, nearbyRoads: [{ id: 'another', name: 'Second mapped road', centerline: second }] });
    expect(corner.validation).toBe('unsupported-site');
    expect(corner.message).toContain('Multiple-frontage');
    expect(corner.concepts).toEqual([]);
    const sameWayCorner = await calculateScenario({ ...base, nearbyRoads: [{ id: 'selected', name: 'Same road around plot', centerline: second }] });
    expect(sameWayCorner.validation).toBe('unsupported-site');
    const ordinary = await calculateScenario({ ...base, nearbyRoads: [{ id: 'continue', name: 'Continuation', centerline: continuation }] });
    expect(ordinary.validation).toBe('valid');
    expect(ordinary.road?.frontageM).toBeCloseTo(26, 4);
  });

  it('rejects mapped private access or a curved selected road as unsupported conditions', async () => {
    const base = { ...preset, plot, zoneBoundary: world(box(-10, -10, 45, 45)), nearbyRoads: [] };
    const privateRoad = await calculateScenario({ ...base, road: { ...preset.road, access: 'private' } });
    expect(privateRoad.validation).toBe('unsupported-site');
    expect(privateRoad.message).toContain('Mapped access');
    const curved = await calculateScenario({ ...base, road: { ...preset.road, centerline: line([[0, 0], [1.2, 30], [0, 90]].map(frame.toWorld)) } });
    expect(curved.validation).toBe('unsupported-site');
    expect(curved.message).toContain('straight road segment');
  });
});

describe('published geographic scenarios', () => {
  const context: ContextData = {
    site: site as unknown as ContextData['site'],
    buildings: JSON.parse(readFileSync(new URL('../../public/data/buildings.geojson', import.meta.url), 'utf8')),
    roads: JSON.parse(readFileSync(new URL('../../public/data/roads.geojson', import.meta.url), 'utf8')),
  };

  function exampleInput(example: NonNullable<ContextData['site']['examples']>[number], plot = example.parcel): ScenarioInput {
    const roads = roadsForPlot(plot, context);
    const selected = roads.find((road) => String(road.wayId) === String(example.roadId))!;
    expect(selected).toBeDefined();
    return {
      plot, profile: example.profile, redevelopment: 'clear',
      zoneBoundary: context.site.zoneBoundary, contextCoverage: context.site.coverage,
      screeningCoverage: context.site.screeningCoverage, screeningAreas: context.site.screeningAreas,
      roadSelectionAvailable: true,
      nearbyRoads: roads.map((road) => ({ id: String(road.wayId), name: road.name, centerline: road.mappedCenterline, widthM: road.width ?? undefined, roadClass: road.roadClass })),
      retainedBuildings: nearbyBuildings(plot, context.buildings),
      road: { id: String(selected.wayId), sameRoadIds: selected.sameRoadIds, name: selected.name,
        roadClass: selected.roadClass, sourceUrl: selected.sourceUrl, centerline: selected.centerline,
        widthM: example.widthM, widthSource: 'user-override', publicStatus: 'unknown' },
    };
  }

  for (const example of context.site.examples ?? []) {
    it(`uses actual nearby roads and independently fitting alternatives for ${example.id}`, async () => {
      const input = exampleInput(example);
      const result = await calculateScenario(input);
      console.log(`Geographic scenario ${example.id}: ${JSON.stringify({ state: result.validation, reason: result.message, area: result.plotAreaM2, frontage: result.road?.frontageM, concepts: result.concepts.map((concept) => ({ id: concept.id, gfa: concept.gfaM2, floors: concept.floors.length })) })}`);
      expect(result.zoneEligibility).toBe('inside');
      expect(result.validation, result.message).toBe('valid');
      expect(result.concepts).toHaveLength(2);
      for (const concept of result.concepts) {
        const checks = await validateGeneratedConcept(input, concept);
        expect(checks.every((check) => check.status !== 'fail')).toBe(true);
        expect(checks.find(({ id }) => id === 'applicable-envelope')?.status).toBe('pass');
        expect(concept.envelope?.length).toBe(concept.floors.length);
      }
    });
  }

  it('stabilizes the original east example across microscopic input changes and rejects invalid serialized output', async () => {
    const east = context.site.examples!.find(({ id }) => id === 'east')!;
    const rounded = mapArea(east.parcel, (point) => point.map((value) => Number(value.toFixed(9))));
    const inputs = [exampleInput(east), exampleInput(east, rounded)];
    const results = await Promise.all(inputs.map(calculateScenario));
    expect(results.map(({ validation }) => validation)).toEqual(['valid', 'valid']);
    expect(Math.abs(results[0].plotAreaM2 - results[1].plotAreaM2)).toBeLessThan(0.002);
    for (const [index, result] of results.entries()) {
      expect(result.concepts.map(({ id }) => id)).toEqual(['wide', 'stepped']);
      expect(result.concepts[1].coveredM2).toBeLessThan(result.concepts[0].coveredM2 * 0.9);
      for (const concept of result.concepts) {
        const serialized = JSON.parse(JSON.stringify(concept)) as typeof concept;
        const audit = await validateGeneratedConcept(inputs[index], serialized);
        expect(audit.some(({ status }) => status === 'fail')).toBe(false);
        expect(audit.find(({ id }) => id === 'applicable-envelope')?.status).toBe('pass');
        const frame = roadFrame(inputs[index].plot, inputs[index].road);
        await withGeos((scope) => {
          for (const floor of serialized.floors) {
            expect(scope.valid(scope.read(floor.geometry))).toBe(true);
            const native = scope.read(mapArea(floor.geometry, frame.toLocal));
            expect(scope.valid(native)).toBe(true);
            expect(scope.area(native)).toBeCloseTo(floor.areaM2, 6);
          }
          for (const floor of serialized.envelope ?? []) {
            expect(scope.valid(scope.read(floor.geometry))).toBe(true);
            expect(scope.valid(scope.read(mapArea(floor.geometry, frame.toLocal)))).toBe(true);
          }
        });
      }
    }
    for (const index of [0, 1]) {
      expect(Math.abs(results[0].concepts[index].gfaM2 - results[1].concepts[index].gfaM2)).toBeLessThan(0.01);
    }
    const [a, b, c, d] = east.parcel.coordinates[0];
    const invalid = { ...results[0].concepts[0], floors: results[0].concepts[0].floors.map((floor, i) => i === 0
      ? { ...floor, geometry: { type: 'Polygon' as const, coordinates: [[a, c, b, d, a]] } } : floor) };
    const audit = await validateGeneratedConcept(inputs[0], invalid);
    expect(audit.find(({ id }) => id === 'plot')?.status).toBe('fail');
    expect(audit.find(({ id }) => id === 'applicable-envelope')?.status).toBe('fail');
    console.log('East stability', JSON.stringify(results.map(result => ({ area: result.plotAreaM2, concepts: result.concepts.map(c => ({ id: c.id, gfa: c.gfaM2, floors: c.floors.length, covered: c.coveredM2 })) }))));
  });
});
