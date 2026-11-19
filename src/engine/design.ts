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

type RatedDesign = { floors: NativeFloor[]; score: number; preferred: boolean };

const CONFIG = {
  wide: { name: 'Courtyard wing', maxFloors: 3, fractions: [0.94, 0.74, 0.53], angles: [0, 20], preferredDepth: 1.2 },
  stepped: { name: 'Stepped garden bar', maxFloors: 6, fractions: [0.91, 0.72, 0.50], angles: [0, -20], preferredDepth: 1.65 },
} as const;

function designMask(base: Polygon, target: number, strategy: Strategy, angle: number, shift: number) {
  const bounds = extent(points(base));
  const rotation = angle * Math.PI / 180;
  const [cos, sin] = [Math.cos(rotation), Math.sin(rotation)];
  const center: XY = [(bounds.maxX + bounds.minX) / 2 + shift, (bounds.maxY + bounds.minY) / 2];
  const depthRatio = CONFIG[strategy].preferredDepth;
  const initialArea = strategy === 'wide' ? target / 0.84 : target;
  const depth = Math.sqrt(initialArea * depthRatio);
  const width = initialArea / depth;
  const rotate = ([x, y]: number[]) => [center[0] + x * cos - y * sin, center[1] + x * sin + y * cos];
  const rectangle = mapArea(box(-depth / 2, -width / 2, depth / 2, width / 2), rotate);
  const notch = strategy === 'wide'
    ? mapArea(box(depth * 0.05, -width * 0.16, depth * 0.6, width * 0.6), rotate)
    : null;
  return { rectangle, notch };
}

function floorSequence(ctx: Prepared, envelopes: NativeFloor[], firstPlate: NativeGeometry, strategy: Strategy) {
  const { scope, input } = ctx;
  const settings = PROFILES[input.profile];
  let previous = firstPlate;
  const result: NativeFloor[] = [];
  for (const [index, slice] of envelopes.entries()) {
    let next = scope.intersection(previous, slice.geometry);
    if (strategy === 'stepped' && index >= 1 && index % 2 === (envelopes.length >= 4 ? 0 : 1)) {
      const previousShape = scope.write(previous);
      if (!previousShape) return null;
      const { minX, maxX } = extent(points(previousShape));
      next = clipRoadSide(ctx, next, minX + Math.max(1.2, (maxX - minX) * 0.17));
    }
    const component = scope.largestPolygon(next);
    if (!component) return null;
    previous = scope.read(component);
    const area = scope.area(previous);
    const practicalCore = scope.area(scope.buffer(previous, -settings.minDepth / 2));
    if (area < settings.minArea || practicalCore < 0.15) return null;
    result.push({ ...slice, geometry: previous });
  }
  return result;
}

function planningBudget(ctx: Prepared, gfa: number, coveredM2: number, categoryCap: number) {
  const { retainedHandle, retainedGfa, scope, plotArea } = ctx;
  const retainedCover = retainedHandle ? scope.area(retainedHandle) : 0;
  const totalGfa = gfa + (retainedGfa ?? 0);
  const open = plotArea - coveredM2 - retainedCover;
  const largestFloor = coveredM2;
  if (gfa > categoryCap || totalGfa > FAR * plotArea) return false;
  return open >= Math.max(plotArea * 0.3, largestFloor * 0.3, OSR * totalGfa);
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
    const area = scope.temporary(() => scope.area(scope.intersection(
      open, scope.read(box(region.minX, middle, region.maxX, region.maxY)),
    )));
    if (area > target) low = middle;
    else high = middle;
  }
  return scope.intersection(open, scope.read(box(region.minX, low, region.maxX, region.maxY)));
}

function proposal(ctx: Prepared, strategy: Strategy, candidate: NativeFloor[]): Concept | null {
  const { scope } = ctx;
  const planting = plantingGeometry(ctx, candidate[0]);
  const verification = checkConcept(ctx, candidate, planting);
  if (verification.checks.some((check) => check.status === 'fail')) return null;
  const geometryForPlanting = planting ? scope.write(planting) : null;
  return {
    id: strategy,
    name: CONFIG[strategy].name,
    floors: candidate.map(({ floor, baseM, topM, geometry }, i) => ({
      floor, baseM, topM, areaM2: verification.areas[i], geometry: worldGeometry(ctx, scope.write(geometry)!),
    })),
    heightM: verification.height,
    gfaM2: verification.gfa,
    coveredM2: verification.coveredArea,
    openM2: verification.openArea,
    perviousM2: verification.planted,
    planting: geometryForPlanting && worldGeometry(ctx, geometryForPlanting),
    checks: verification.checks,
  };
}

function candidateScore(ctx: Prepared, strategy: Strategy, floors: NativeFloor[], gfa: number, footprint: number) {
  const storeyBias = floors.length * (strategy === 'stepped' ? 100 : 6);
  const openBias = strategy === 'stepped' ? (ctx.plotArea - footprint) * 0.12 : footprint * 0.23;
  return gfa + storeyBias + openBias;
}

export function generateDesign(ctx: Prepared, strategy: Strategy, other?: Concept) {
  const { scope, input } = ctx;
  const config = CONFIG[strategy];
  const profile = PROFILES[input.profile];
  const floorMax = Math.min(config.maxFloors, profile.maxFloors);
  const counts = Array.from({ length: floorMax }, (_, i) => floorMax - i).filter((n) =>
    n >= (input.profile === 'multifamily' ? 2 : 1)
    && (strategy !== 'stepped' || n >= 2));
  const tested: RatedDesign[] = [];
  const maximumWithoutRetained = Math.max(0, FAR * ctx.plotArea - (ctx.retainedGfa ?? 0));
  const categoryCap = Math.min(profile.gfaLimit ?? Infinity, maximumWithoutRetained);

  function rate(floors: NativeFloor[] | null, preferred: boolean) {
    if (!floors) return null;
    const gfa = floors.reduce((area, floor) => area + scope.area(floor.geometry), 0);
    const groundArea = scope.area(floors[0].geometry);
    if (!planningBudget(ctx, gfa, groundArea, categoryCap)) return null;
    if (other && groundArea > 0.85 * other.floors[0].areaM2) return null;
    return { floors, score: candidateScore(ctx, strategy, floors, gfa, groundArea), preferred };
  }

  for (const count of counts) {
    // A detached house can use the §55 small-residence exemption only in the ≤300 m² search band.
    const bandCaps = input.profile === 'house' ? [300, Math.min(2000, categoryCap)] : [categoryCap];
    for (const bandCap of bandCaps) {
      const limit = Math.min(bandCap, categoryCap);
      const { floors: envelopes } = floorEnvelopes(ctx, count, limit);
      const ground = scope.largestPolygon(envelopes[0].geometry);
      if (!ground || scope.area(envelopes.at(-1)!.geometry) < profile.minArea) continue;
      const groundArea = scope.area(envelopes[0].geometry);
      const ceilingPerFloor = limit / Math.max(1, count - (strategy === 'stepped' ? 0.9 : 0));
      const target = Math.min(groundArea, ceilingPerFloor, ctx.plotArea * 0.7);
      if (target < profile.minArea) continue;
      const buffers = [0, 1.5, 3];
      const designs: { geometry: NativeGeometry; preferred: boolean }[] = [];
      for (const fraction of config.fractions) {
        for (const angle of config.angles) {
          const { rectangle, notch } = designMask(ground, target * fraction, strategy, angle, 1.5);
          const body = scope.read(rectangle);
          designs.push({ geometry: notch ? scope.difference(body, scope.read(notch)) : body, preferred: true });
        }
      }
      for (const distance of buffers) {
        const geometry = distance ? scope.buffer(envelopes[0].geometry, -distance) : envelopes[0].geometry;
        designs.push({ geometry, preferred: false });
      }
      for (const { geometry, preferred } of designs) {
        const result = rate(floorSequence(ctx, envelopes, geometry, strategy), preferred);
        if (result && result.floors.reduce((sum, floor) => sum + scope.area(floor.geometry), 0) <= limit) {
          tested.push(result);
        }
      }
    }
  }
  tested.sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.score - a.score);
  for (const design of tested.slice(0, 10)) {
    const concept = scope.temporary(() => proposal(ctx, strategy, design.floors));
    if (concept) return concept;
  }
  return null;
}
