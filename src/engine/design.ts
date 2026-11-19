import type { Polygon } from 'geojson';
import { clipRoadSide, worldGeometry } from './context';
import type { Prepared } from './context';
import { floorEnvelopes } from './envelope';
import type { NativeFloor } from './envelope';
import type { NativeGeometry } from './geos';
import { FAR, OSR, PROFILES } from './rules';
import { box, extent, mapArea, points } from './spatial';
import type { XY } from './spatial';
import type { Concept, Strategy } from './types';
import { checkConcept } from './validate';

type RatedDesign = {
  floors: NativeFloor[];
  family: string;
  gfaM2: number;
  footprintM2: number;
};
type StepPattern = { label: string; fromFloor: number; every: number; fraction: number } | null;

const CONFIG = {
  wide: { name: 'Courtyard wing', maxFloors: 3, depthRatio: 1.1 },
  stepped: { name: 'Stepped garden bar', maxFloors: 6, depthRatio: 1.55 },
} as const;

const STEPS: StepPattern[] = [
  { label: 'upper two floors stepped', fromFloor: 5, every: 2, fraction: 0.15 },
  { label: 'paired upper plates step progressively', fromFloor: 3, every: 2, fraction: 0.14 },
];

const number = (value: number) => value.toFixed(1);
const sqm = (value: number) => `${number(value)} m²`;

function designMask(base: Polygon, target: number, strategy: Strategy, angle: number, shift: number) {
  const bounds = extent(points(base));
  const rotation = angle * Math.PI / 180;
  const [cos, sin] = [Math.cos(rotation), Math.sin(rotation)];
  const center: XY = [(bounds.maxX + bounds.minX) / 2 + shift, (bounds.maxY + bounds.minY) / 2];
  const initialArea = strategy === 'wide' ? target / 0.77 : target;
  const depth = Math.sqrt(initialArea * CONFIG[strategy].depthRatio);
  const width = initialArea / depth;
  const rotate = ([x, y]: number[]) => [center[0] + x * cos - y * sin, center[1] + x * sin + y * cos];
  const rectangle = mapArea(box(-depth / 2, -width / 2, depth / 2, width / 2), rotate);
  const notch = strategy === 'wide'
    ? mapArea(box(depth * 0.02, -width * 0.05, depth * 0.6, width * 0.6), rotate)
    : null;
  return { rectangle, notch };
}

function floorSequence(ctx: Prepared, envelopes: NativeFloor[], seed: NativeGeometry, steps: StepPattern) {
  const { scope, input } = ctx;
  const settings = PROFILES[input.profile];
  let previous = seed;
  let previousEnvelope: NativeGeometry | undefined;
  const result: NativeFloor[] = [];
  for (const slice of envelopes) {
    let next = previousEnvelope === slice.geometry ? previous : scope.intersection(previous, slice.geometry);
    if (steps && slice.floor >= steps.fromFloor && (slice.floor - steps.fromFloor) % steps.every === 0) {
      const minX = scope.minX(previous);
      const depth = scope.maxX(previous) - minX;
      next = clipRoadSide(ctx, next, minX + Math.max(0.9, depth * steps.fraction));
    }
    const component = scope.largestComponent(next);
    if (!component) return null;
    previous = component;
    previousEnvelope = slice.geometry;
    result.push({ ...slice, geometry: previous });
  }
  // Every plate is a subset of the plate below. If the smallest plate has
  // room for the practical core, the same core fits the larger lower plates.
  if (scope.area(previous) < settings.minArea) return null;
  const practicalCore = scope.temporary(() => scope.area(scope.buffer(previous, -settings.minDepth / 2)));
  return practicalCore >= 0.15 ? result : null;
}

function planningBudget(ctx: Prepared, gfa: number, coveredM2: number, categoryCap: number) {
  const { retainedHandle, retainedGfa, scope, plotArea } = ctx;
  const retainedCover = retainedHandle ? scope.area(retainedHandle) : 0;
  const totalGfa = gfa + (retainedGfa ?? 0);
  const open = plotArea - coveredM2 - retainedCover;
  if (gfa > categoryCap || totalGfa > FAR * plotArea) return false;
  return open >= Math.max(plotArea * 0.3, coveredM2 * 0.3, OSR * totalGfa);
}

function plantingGeometry(ctx: Prepared, ground: NativeFloor) {
  const { scope, retainedHandle, plotHandle, region } = ctx;
  const coverage = retainedHandle ? scope.union(retainedHandle, ground.geometry) : ground.geometry;
  const open = scope.difference(plotHandle, coverage);
  const target = scope.area(open) * 0.55;
  if (target <= 0) return null;
  let low = ctx.localBounds.minY;
  let high = ctx.localBounds.maxY;
  for (let iteration = 0; iteration < 10; iteration++) {
    const middle = (low + high) / 2;
    const part = scope.intersection(open, scope.read(box(region.minX, middle, region.maxX, region.maxY)));
    const area = scope.area(part);
    if (Math.abs(area - target) < target * 0.025) return part;
    if (area > target) low = middle;
    else high = middle;
  }
  return scope.intersection(open, scope.read(box(region.minX, low, region.maxX, region.maxY)));
}

function proposal(ctx: Prepared, strategy: Strategy, candidate: RatedDesign, other?: Concept): Concept | null {
  const { scope, input } = ctx;
  const planting = plantingGeometry(ctx, candidate.floors[0]);
  const audit = checkConcept(ctx, candidate.floors, planting);
  if (audit.checks.some((check) => check.status === 'fail')) return null;
  const geometryForPlanting = planting ? scope.write(planting) : null;
  const tightChecks = audit.checks.filter(({ controls }) => controls).map(({ label }) => label);
  const limitingFactors = tightChecks.length
    ? [`Closest modeled constraints: ${tightChecks.join(', ')}.`]
    : ['The selected plates have slack against the modeled geometric checks.'];
  const profile = PROFILES[input.profile];
  if (profile.gfaLimit !== null) {
    const gap = profile.gfaLimit - audit.gfa;
    limitingFactors.push(`${sqm(gap)} below the ${sqm(profile.gfaLimit)} application cap. The cap bounds the search.`);
  }
  limitingFactors.push(`Smallest plate ${sqm(Math.min(...audit.areas))}. Search uses a ${profile.minArea} m² plate and ${profile.minDepth} m usable-core heuristic.`);

  return {
    id: strategy,
    name: CONFIG[strategy].name,
    floors: candidate.floors.map(({ floor, baseM, topM, geometry }, i) => ({
      floor, baseM, topM, areaM2: audit.areas[i], geometry: worldGeometry(ctx, scope.write(geometry)!),
    })),
    heightM: audit.height,
    gfaM2: audit.gfa,
    coveredM2: audit.coveredArea,
    openM2: audit.openArea,
    perviousM2: audit.planted,
    planting: geometryForPlanting && worldGeometry(ctx, geometryForPlanting),
    checks: audit.checks,
    siteEvidence: audit.siteEvidence,
    rationale: strategy === 'wide'
      ? `Highest independently checked GFA in the wider/lower shortlist. This ${candidate.family} spreads ${candidate.floors.length} storeys over a larger footprint.`
      : `Open-space alternative with a materially smaller footprint. This ${candidate.family} uses ${candidate.floors.length} storeys to retain useful floor area.`,
    tradeOff: other
      ? `${sqm(Math.abs(other.gfaM2 - audit.gfa))} ${audit.gfa <= other.gfaM2 ? 'less' : 'more'} GFA and ${sqm(audit.openArea - other.openM2)} more open space than the wider/lower concept.`
      : `${sqm(audit.coveredArea)} covered projection leaves ${sqm(audit.openArea)} uncovered. Compare with the smaller footprint when both forms fit.`,
    limitingFactors,
  };
}

const descendingGfa = (a: RatedDesign, b: RatedDesign) => b.gfaM2 - a.gfaM2 || a.footprintM2 - b.footprintM2;
const byFootprint = (a: RatedDesign, b: RatedDesign) => a.footprintM2 - b.footprintM2 || descendingGfa(a, b);

export function generateDesign(ctx: Prepared, strategy: Strategy, other?: Concept) {
  const { scope, input } = ctx;
  const profile = PROFILES[input.profile];
  const floorMax = Math.min(CONFIG[strategy].maxFloors, profile.maxFloors);
  const counts = Array.from({ length: floorMax }, (_, i) => floorMax - i).filter((n) =>
    n >= (input.profile === 'multifamily' || strategy === 'stepped' ? 2 : 1));
  const screened: RatedDesign[] = [];
  const maximumWithoutRetained = Math.max(0, FAR * ctx.plotArea - (ctx.retainedGfa ?? 0));
  const categoryCap = Math.min(profile.gfaLimit ?? Infinity, maximumWithoutRetained);
  let evaluated = 0;

  for (const count of counts) {
    // The §55 small-house exemption is tested only in its eligible area band.
    const bandCaps = input.profile === 'house' ? [300, Math.min(2000, categoryCap)] : [categoryCap];
    for (const bandCap of new Set(bandCaps.map((value) => Math.min(value, categoryCap)))) {
      const { floors: envelopes } = floorEnvelopes(ctx, count, bandCap);
      const ground = scope.largestPolygon(envelopes[0].geometry);
      if (!ground || scope.area(envelopes.at(-1)!.geometry) < profile.minArea) continue;
      const groundArea = scope.area(envelopes[0].geometry);
      const perFloorTarget = bandCap / (count * (strategy === 'stepped' ? 0.87 : 1));
      const maxFootprint = Math.min(groundArea, ctx.plotArea * 0.7, other ? other.floors[0].areaM2 * 0.85 : Infinity);
      const target = Math.min(perFloorTarget, maxFootprint);
      if (target < profile.minArea) continue;
      const patterns: StepPattern[] = strategy === 'stepped'
        ? [count < 5 ? { label: 'upper plate stepped', fromFloor: count, every: 2, fraction: 0.15 } : STEPS[0], STEPS[1]]
        : [null];
      const seeds: { geometry: NativeGeometry; label: string }[] = [];
      const fractions = [0.79, 0.96, 1.04, 1.14];
      const angles = [-18, 0, 18];
      for (const fraction of fractions) {
        for (const angle of angles) {
          const { rectangle, notch } = designMask(ground, target * fraction, strategy, angle, angle === 0 ? 0 : 1.5);
          const body = scope.read(rectangle);
          seeds.push({ geometry: notch ? scope.difference(body, scope.read(notch)) : body,
            label: `${angle}° ${notch ? 'courtyard wing' : 'bar'}` });
        }
      }
      const bounds = extent(points(ground));
      // Directly clip the envelope as a fallback where the useful silhouette is irregular.
      for (const strip of [0, 0.12, 0.22, 0.32, 0.42]) {
        seeds.push({
          geometry: clipRoadSide(ctx, envelopes[0].geometry, bounds.minX + strip * (bounds.maxX - bounds.minX)),
          label: 'parcel-derived wing',
        });
      }
      for (const seed of seeds) for (const steps of patterns) {
        evaluated++;
        const floors = floorSequence(ctx, envelopes, seed.geometry, steps);
        if (!floors) continue;
        const gfaM2 = floors.reduce((sum, floor) => sum + scope.area(floor.geometry), 0);
        const footprintM2 = scope.area(floors[0].geometry);
        if (!planningBudget(ctx, gfaM2, footprintM2, bandCap) || footprintM2 > maxFootprint) continue;
        screened.push({ floors, gfaM2, footprintM2,
          family: steps ? `${seed.label} with ${steps.label}` : seed.label });
      }
    }
  }

  const highestArea = [...screened].sort(descendingGfa);
  const nearTarget = other ? highestArea.filter(({ gfaM2 }) => gfaM2 >= other.gfaM2 * 0.78) : highestArea;
  const preferred = strategy === 'stepped' && nearTarget.length ? [...nearTarget].sort(byFootprint) : highestArea;
  // Check both the objective leaders and the highest-area alternatives. This bounded
  // shortlist makes the reported best a measured result within the checked search.
  const finalists = new Set([...preferred.slice(0, 12), ...highestArea.slice(0, 8)]);
  let validated = 0;
  let bestValidatedGfaM2: number | null = null;
  let concept: Concept | null = null;
  for (const candidate of finalists) {
    const checked = scope.temporary(() => proposal(ctx, strategy, candidate, other));
    if (!checked) continue;
    validated++;
    bestValidatedGfaM2 = Math.max(bestValidatedGfaM2 ?? 0, checked.gfaM2);
    concept ??= checked;
  }
  return { concept, evaluated, independentlyChecked: finalists.size, validated, bestValidatedGfaM2 };
}
