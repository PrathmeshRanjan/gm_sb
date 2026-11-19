import { describe, expect, it } from 'vitest';
import type { LineString, Polygon } from 'geojson';
import site from '../../public/data/site.json';
import { calculateScenario, validateGeneratedConcept } from './index';
import { withGeos } from './geos';
import { boundaryDistances, classify, clearance, DESIGN_CLEARANCE_RESERVE_M, DISTANCE_TOLERANCE, frontLimits } from './rules';
import { box, mapArea, project, roadFrame, unproject } from './spatial';
import type { Concept, ScenarioInput } from './types';

const preset: ScenarioInput = {
  plot: site.parcel as Polygon,
  profile: 'multifamily',
  road: {
    name: site.road.name, widthM: 11.7, baselineWidthM: 11.7, widthSource: 'district-inventory',
    centerline: site.road.centerline as LineString, publicStatus: 'documented',
  },
  redevelopment: 'clear',
};
const frame = roadFrame(preset.plot, preset.road);

function world(geometry: Polygon) {
  return mapArea(geometry, ([x, y]) => frame.toWorld([x + frame.nearX, y + 24]));
}

function fixture(geometry: Polygon, profile: ScenarioInput['profile'] = 'house'): ScenarioInput {
  return { ...preset, profile, plot: world(geometry) };
}

function slabConcept(plate: Polygon, floors: number, areaM2: number): Concept {
  return {
    id: 'wide', name: 'Independent test mass',
    floors: Array.from({ length: floors }, (_, i) => ({
      floor: i + 1, baseM: i * 3.2, topM: (i + 1) * 3.2, areaM2, geometry: world(plate),
    })),
    gfaM2: areaM2 * floors, heightM: floors * 3.2, coveredM2: areaM2, openM2: 0, perviousM2: 0,
    planting: null, checks: [], siteEvidence: [], rationale: '', tradeOff: '', limitingFactors: [],
  };
}

describe('native geometry and projection', () => {
  it('round-trips WGS84/EPSG:32647 and clips a rectangle in meters', async () => {
    const position = [100.5669, 13.7849];
    const projected = project(position);
    expect(projected[0]).toBeGreaterThan(650_000);
    expect(unproject(projected)[0]).toBeCloseTo(position[0], 9);
    expect(unproject(projected)[1]).toBeCloseTo(position[1], 9);
    const input = fixture(box(0, 0, 20, 30));
    const result = await calculateScenario(input);
    expect(result.validation).toBe('valid');
    expect(result.plotAreaM2).toBeCloseTo(600, 5);
    const compensatedRadius = (2 + DESIGN_CLEARANCE_RESERVE_M) / Math.cos(Math.PI / 64);
    expect(result.envelope[0].areaM2).toBeCloseTo((20 - compensatedRadius) * (30 - compensatedRadius * 2), 4);
    expect(result.concepts.length).toBeGreaterThan(0);
  });

  it('returns disjoint polygons for a concave neck and keeps a hole', async () => {
    const twoRooms: Polygon = {
      type: 'Polygon', coordinates: [[
        [0, 0], [12, 0], [12, 5], [19, 5], [19, 0], [31, 0], [31, 14],
        [19, 14], [19, 9], [12, 9], [12, 14], [0, 14], [0, 0],
      ]],
    };
    const holed = box(0, 0, 29, 32);
    holed.coordinates.push([[8, 7], [8, 13], [13, 13], [13, 7], [8, 7]]);
    const split = await calculateScenario(fixture(twoRooms, 'multifamily'));
    const hole = await calculateScenario(fixture(holed, 'multifamily'));
    expect(split.envelope[0].geometry.type).toBe('MultiPolygon');
    expect(hole.plotAreaM2).toBeCloseTo(898, 5);
    const shape = hole.envelope[0].geometry;
    expect(shape.type).toBe('Polygon');
    expect(shape.coordinates).toHaveLength(2);
  });

  it('rejects self-intersection and reports an empty narrow envelope', async () => {
    const crossing: Polygon = { type: 'Polygon', coordinates: [[[0, 0], [12, 15], [0, 15], [12, 0], [0, 0]]] };
    const invalid = await calculateScenario(fixture(crossing));
    const narrow = await calculateScenario(fixture(box(0, 0, 1.5, 32)));
    expect(invalid.validation).toBe('invalid');
    expect(invalid.envelope).toHaveLength(0);
    expect(narrow.validation).toBe('valid');
    expect(narrow.envelope).toHaveLength(0);
    expect(narrow.concepts).toHaveLength(0);
  });

  it('checks a rotated triangle by area without substituting a rectangle', async () => {
    const triangle: Polygon = { type: 'Polygon', coordinates: [[[0, 0], [18, 2], [2, 20], [0, 0]]] };
    const result = await calculateScenario(fixture(triangle));
    expect(result.plotAreaM2).toBeCloseTo(178, 5);
    expect(result.envelope[0].areaM2).toBeLessThan(178);
  });

  it('performs repeated native conversions and releases allocated handles', async () => {
    await withGeos((scope) => {
      for (let iteration = 0; iteration < 100; iteration++) {
        const sum = scope.temporary(() => {
          const a = scope.read(box(0, 0, 20, 20));
          const b = scope.read(box(15, 0, 30, 20));
          return scope.area(scope.union(a, b));
        });
        expect(sum).toBe(600);
      }
    });
  });
});

describe('legal applicability and independent checks', () => {
  it('uses building height nationally and per-storey local applicability', () => {
    expect(boundaryDistances(9, 2, 6)).toEqual({ national: 2, local: 2 });
    expect(boundaryDistances(9, 3, 9)).toEqual({ national: 2, local: 3 });
    expect(boundaryDistances(9.01, 1, 3)).toEqual({ national: 3, local: 2 });
    expect(boundaryDistances(16, 4, 12)).toEqual({ national: 3, local: 3 });
    expect(clearance('house', 8, 300)).toBe(0);
    expect(clearance('house', 8, 300.01)).toBe(1);
    expect(clearance('multifamily', 15, 900)).toBe(1);
    expect(clearance('multifamily', 15.01, 900)).toBe(2);
    expect(classify(15.01, 990)).toMatchObject({ specialByHeight: true, large: false });
    expect(classify(15, 1_001)).toMatchObject({ specialByHeight: false, large: true });
    expect(classify(10, 400, 10.01).specialByKnownSpan).toBe(true);
  });

  it('uses the distinct references at the exact statutory road thresholds', () => {
    expect(frontLimits(5.99, 2, 6.4, 100).national).toEqual({ reference: 'centerline', distance: 3 });
    expect(frontLimits(6, 2, 6.4, 100).national).toBeNull();
    expect(frontLimits(9.99, 3, 9.6, 999)).toMatchObject({
      national: { reference: 'centerline', distance: 6 }, local: null, localExemption: true,
    });
    expect(frontLimits(10, 4, 12.8, 900).national).toEqual({ reference: 'near-edge', distance: 1 });
    expect(frontLimits(20, 4, 12.8, 900).local).toEqual({ reference: 'near-edge', distance: 2 });
    expect(frontLimits(20.01, 4, 12.8, 900).local).toEqual({ reference: 'near-edge', distance: 2 });
  });

  it('keeps site area invariant through width changes and applies a binding height-plane fixture', async () => {
    const original = await calculateScenario(preset);
    const narrow = { ...preset, road: { ...preset.road, widthM: 2, widthSource: 'user-override' as const } };
    const narrowed = await calculateScenario(narrow);
    const widened = await calculateScenario({ ...preset, road: { ...preset.road, widthM: 14.7 } });
    expect(original.plotAreaM2).toBeCloseTo(828, 4);
    expect(narrowed.plotAreaM2).toBeCloseTo(original.plotAreaM2, 8);
    expect(narrowed.rules.find((check) => check.id === 'height-plane')?.controls).toBe(true);
    expect(original.rules.find((check) => check.id === 'height-plane')?.controls).toBe(false);
    expect(narrowed.capacity!.geometricGfaUpperBoundM2).toBeLessThan(original.capacity!.geometricGfaUpperBoundM2);
    expect(narrowed.boundExplanation?.sumM2).toBeCloseTo(narrowed.capacity!.geometricGfaUpperBoundM2);
    const baselineSlices = original.boundExplanation!.floors;
    const stressSlices = narrowed.boundExplanation!.floors;
    expect(stressSlices.slice(0, -1)).toEqual(baselineSlices.slice(0, -1));
    expect(stressSlices.at(-1)!.areaM2).toBeLessThan(baselineSlices.at(-1)!.areaM2);
    for (const [i, tested] of narrowed.concepts.entries()) {
      expect(tested.gfaM2).toBeCloseTo(original.concepts[i].gfaM2, 8);
    }
    expect(widened.plotAreaM2).toBeCloseTo(original.plotAreaM2, 8);
    expect(widened.validation).toBe('road-conflict');
    expect(widened.road!.conflictM2).toBeCloseTo(45, 4);
    expect(widened.concepts).toHaveLength(0);
  });

  it('returns real alternatives, sums the floors, and changes profile independently of area', async () => {
    const result = await calculateScenario(preset);
    expect(result.concepts.map(({ id }) => id)).toEqual(['wide', 'stepped']);
    const [wide, stepped] = result.concepts;
    expect(stepped.floors.length).toBeGreaterThan(wide.floors.length);
    expect(stepped.coveredM2).toBeLessThan(wide.coveredM2);
    expect(stepped.siteEvidence.find(({ id }) => id === 'special')?.detail).toContain('exceeds 15 m');
    expect(result.capacity).toMatchObject({ profileGfaLimitM2: 1_000, regulatoryFar: 7 });
    expect(wide.gfaM2).toBeGreaterThan(900);
    expect(stepped.gfaM2).toBeGreaterThan(wide.gfaM2 * 0.78);
    expect(result.search!.bestValidatedGfaM2).toBeGreaterThanOrEqual(wide.gfaM2);
    expect(result.search!.evaluated).toBeGreaterThan(result.search!.independentlyChecked);
    expect(result.search!.independentlyChecked).toBeGreaterThanOrEqual(result.search!.validated);
    expect(result.boundExplanation!.floors.reduce((total, row) => total + row.areaM2, 0)).toBeCloseTo(result.boundExplanation!.sumM2, 10);
    expect(result.boundExplanation!.classification).toContain('Special building by height. Structural and safety review required');
    const house = await calculateScenario({ ...preset, profile: 'house' });
    expect(house.plotAreaM2).toBeCloseTo(result.plotAreaM2);
    expect(house.capacity).toMatchObject({ profileGfaLimitM2: null, profileMaxFloors: 2 });
    for (const concept of result.concepts) {
      expect(concept.floors.reduce((total, { areaM2 }) => total + areaM2, 0)).toBeCloseTo(concept.gfaM2);
      expect(concept.openM2 + concept.coveredM2).toBeCloseTo(result.plotAreaM2);
      expect(concept.perviousM2).toBeGreaterThan(concept.openM2 / 2);
      expect(concept.checks.some(({ status }) => status === 'fail')).toBe(false);
    }
  });

  it('keeps exterior building remainders and handles verified eligible retained GFA', async () => {
    const parcel = fixture(box(0, 0, 32, 30), 'multifamily');
    const footprint = mapArea(box(28, 45, 41, 50), ([x, y]) => frame.toWorld([x, y]));
    const existing = { id: 'crossing-building', footprint, grossFloorAreaM2: 150 };
    const cleared = await calculateScenario({ ...parcel, retainedBuildings: [existing] });
    expect(cleared.affectedBuildingIds).toEqual(['crossing-building']);
    expect(cleared.preservedBuildingParts).toMatchObject([{ id: 'crossing-building' }]);
    expect(cleared.capacity?.retainedGfaM2).toBe(0);
    const unknown = await calculateScenario({ ...parcel, redevelopment: 'retain', retainedBuildings: [existing] });
    expect(unknown.capacity?.retainedGfaM2).toBeNull();
    const retained = await calculateScenario({
      ...parcel, redevelopment: 'retain', retainedBuildings: [{ ...existing, eligibleGrossFloorAreaM2: 78 }],
    });
    expect(retained.capacity?.retainedGfaM2).toBe(78);
    expect(retained.concepts[0].checks.find(({ id }) => id === 'far')?.detail).toContain('site GFA');
    expect(retained.preservedBuildingParts).toHaveLength(0);
  });

  it('rejects coverage crossings and unrelated road segments', async () => {
    const outside = { ...preset, plot: mapArea(preset.plot, ([lon, lat]) => [lon + 0.005, lat]) };
    expect((await calculateScenario(outside)).validation).toBe('outside-coverage');
    const unrelated = { ...preset, road: { ...preset.road, centerline: {
      type: 'LineString' as const,
      coordinates: preset.road.centerline.coordinates.map(([lon, lat]) => [lon + 0.0005, lat]),
    } } };
    const result = await calculateScenario(unrelated);
    expect(result.validation).toBe('invalid');
    expect(result.concepts).toHaveLength(0);
  });

  it('keeps the actual generated setbacks conservative and explains independent area rounding', async () => {
    const developed = await calculateScenario(preset);
    for (const concept of developed.concepts) {
      const results = await validateGeneratedConcept(preset, concept);
      for (const id of ['private-national', 'private-local']) {
        const check = results.find((row) => row.id === id)!;
        expect(check.status).toBe('pass');
        expect(check.measurement!.actualM - check.measurement!.requiredM).toBeGreaterThanOrEqual(0.0019);
        expect(check.measurement!.toleranceM).toBe(DISTANCE_TOLERANCE);
      }
      expect(results.find(({ id }) => id === 'floors')?.detail).toContain('The floor schedule rounds each row');
      expect(results.find(({ id }) => id === 'floors')?.detail).not.toContain(' + ');
    }
    const v2Floor = 339.50500883445574;
    expect(v2Floor.toFixed(2)).toBe('339.51');
    expect((v2Floor * 2).toFixed(2)).toBe('679.01');
  });

  it('rejects the old chord-sized clearance deficit that previously passed', async () => {
    const input = fixture(box(0, 0, 20, 30));
    const right = 20 - 2 * Math.cos(Math.PI / 32);
    const slab = slabConcept(box(3, 5, right, 20), 1, (right - 3) * 15);
    const audited = await validateGeneratedConcept(input, slab);
    const measured = audited.find((rule) => rule.id === 'private-national')!;
    expect(measured.measurement!.actualM).toBeCloseTo(1.990369452744, 6);
    expect(measured.status).toBe('fail');
    expect(audited.find(({ id }) => id === 'plot')?.status).toBe('pass');
  });

  it('rejects a plate crossing a concavity or hole with every corner inside the parcel', async () => {
    const neck: Polygon = { type: 'Polygon', coordinates: [[
      [0, 0], [12, 0], [12, 5], [19, 5], [19, 0], [31, 0], [31, 14],
      [19, 14], [19, 9], [12, 9], [12, 14], [0, 14], [0, 0],
    ]] };
    const holed = box(0, 0, 29, 32);
    holed.coordinates.push([[8, 7], [8, 13], [13, 13], [13, 7], [8, 7]]);
    const [acrossNeck, acrossHole] = await Promise.all([
      validateGeneratedConcept(fixture(neck), slabConcept(box(3, 2, 28, 11), 1, 225)),
      validateGeneratedConcept(fixture(holed), slabConcept(box(3, 4, 22, 20), 1, 304)),
    ]);
    expect(acrossNeck.find(({ id }) => id === 'plot')?.status).toBe('fail');
    expect(acrossHole.find(({ id }) => id === 'plot')?.status).toBe('fail');
  });

  it('changes the setback of the same ground plate when building-wide height crosses 9 m', async () => {
    const input = fixture(box(0, 0, 20, 32), 'multifamily');
    const geometry = box(5, 2.4, 17.6, 27);
    const area = 12.6 * 24.6;
    const lower = await validateGeneratedConcept(input, slabConcept(geometry, 2, area));
    const higher = await validateGeneratedConcept(input, slabConcept(geometry, 3, area));
    const oldCheck = lower.find(({ id }) => id === 'private-national')!;
    const newCheck = higher.find(({ id }) => id === 'private-national')!;
    expect(oldCheck.measurement?.requiredM).toBe(2);
    expect(oldCheck.status).toBe('pass');
    expect(newCheck.measurement?.requiredM).toBe(3);
    expect(newCheck.status).toBe('fail');
    expect(oldCheck.measurement?.actualM).toBeCloseTo(newCheck.measurement!.actualM, 8);
  });

  it('independently rejects moved and raised plates, falsified areas, and area budget exceedance', async () => {
    const original = (await calculateScenario(preset)).concepts[0];
    expect(original).toBeDefined();
    const moved = { ...original, floors: original.floors.map((floor, i) => i === 0 ? {
      ...floor, geometry: mapArea(floor.geometry, ([lon, lat]) => [lon + 0.0003, lat]),
    } : floor) };
    const raised = { ...original, floors: original.floors.map((floor, i) => i === original.floors.length - 1
      ? { ...floor, topM: 200 } : floor) };
    const wrongArea = { ...original, floors: original.floors.map((floor) => ({ ...floor, areaM2: floor.areaM2 + 10 })) };
    const oversized = slabConcept(box(5, 5, 23, 26), 3, 378);
    const roomy = fixture(box(0, 0, 34, 36), 'multifamily');
    const [movedAudit, raisedAudit, wrongAreaAudit, overCapAudit] = await Promise.all([
      validateGeneratedConcept(preset, moved),
      validateGeneratedConcept(preset, raised),
      validateGeneratedConcept(preset, wrongArea),
      validateGeneratedConcept(roomy, oversized),
    ]);
    expect(movedAudit.find(({ id }) => id === 'plot')?.status).toBe('fail');
    expect(raisedAudit.find(({ id }) => id === 'road-height')?.status).toBe('fail');
    expect(wrongAreaAudit.find(({ id }) => id === 'floors')?.status).toBe('fail');
    expect(overCapAudit.find(({ id }) => id === 'profile')?.status).toBe('fail');
    expect(overCapAudit.find(({ id }) => id === 'far')?.status).toBe('pass');

    const farBudgetInput: ScenarioInput = {
      ...roomy, redevelopment: 'retain', retainedBuildings: [{
        footprint: world(box(25, 25, 26, 26)), grossFloorAreaM2: 8_000,
      }],
    };
    expect((await validateGeneratedConcept(farBudgetInput, oversized)).find(({ id  }) => id === 'far')?.status).toBe('fail');
  });
});
