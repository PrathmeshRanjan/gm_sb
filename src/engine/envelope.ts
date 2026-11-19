import type { NativeGeometry } from './geos';
import { clipRoadSide } from './context';
import type { Prepared } from './context';
import { boundaryDistances, clearance, frontLimits, PROFILES } from './rules';
import type { RoadLimit } from './rules';

export interface NativeFloor {
  floor: number;
  baseM: number;
  topM: number;
  geometry: NativeGeometry;
}

export function fromRoadReference(ctx: Prepared, limit: RoadLimit) {
  if (!limit) return ctx.frame.nearX;
  return limit.distance + (limit.reference === 'near-edge' ? ctx.frame.nearX : 0);
}

export function floorEnvelopes(ctx: Prepared, floorCount: number, categoryGfa: number) {
  const { scope, plotHandle, privateHandle, retainedHandle, input, frame } = ctx;
  const profile = PROFILES[input.profile];
  const totalHeightM = floorCount * profile.floorHeight;
  const perimeter = clearance(input.profile, totalHeightM, categoryGfa);
  const front = frontLimits(frame.widthM, floorCount, totalHeightM, categoryGfa);
  const restrictions = {
    clearance: false, nationalFront: false, localFront: false,
    nationalBoundary: false, localBoundary: false, roadHeight: false, retained: false,
  };
  let base = plotHandle;

  function apply(previous: NativeGeometry, next: NativeGeometry, restriction: keyof typeof restrictions) {
    if (scope.area(previous) - scope.area(next) > 0.005) restrictions[restriction] = true;
    return next;
  }

  if (perimeter) base = apply(base, scope.buffer(base, -perimeter), 'clearance');
  if (retainedHandle) {
    base = apply(base, scope.difference(base, scope.buffer(retainedHandle, 6)), 'retained');
  }

  base = clipRoadSide(ctx, base, frame.nearX);
  const nationalFrontX = fromRoadReference(ctx, front.national);
  const localFrontX = fromRoadReference(ctx, front.local);
  const drivingFrontX = Math.max(nationalFrontX, localFrontX);
  if (drivingFrontX > frame.nearX) {
    const cut = clipRoadSide(ctx, base, drivingFrontX);
    const reduced = scope.area(base) - scope.area(cut) > 0.005;
    restrictions.nationalFront = reduced && nationalFrontX === drivingFrontX;
    restrictions.localFront = reduced && localFrontX === drivingFrontX;
    base = cut;
  }

  const privateBands = new Map<number, NativeGeometry>();
  const floors: NativeFloor[] = [];
  for (let floor = 1; floor <= floorCount; floor++) {
    const topM = floor * profile.floorHeight;
    const baseM = (floor - 1) * profile.floorHeight;
    const privateDistances = boundaryDistances(totalHeightM, floor, topM);
    const drivingDistance = Math.max(privateDistances.national, privateDistances.local);
    let privateBand = privateBands.get(drivingDistance);
    if (!privateBand) {
      privateBand = scope.buffer(privateHandle, drivingDistance);
      privateBands.set(drivingDistance, privateBand);
    }
    const afterBoundary = scope.difference(base, privateBand);
    const reduced = scope.area(base) - scope.area(afterBoundary) > 0.005;
    restrictions.nationalBoundary ||= reduced && privateDistances.national === drivingDistance;
    restrictions.localBoundary ||= reduced && privateDistances.local === drivingDistance;
    const geometry = apply(
      afterBoundary,
      clipRoadSide(ctx, afterBoundary, frame.farX + topM / 2),
      'roadHeight',
    );
    floors.push({ floor, baseM, topM, geometry });
  }
  return { floors, restrictions };
}
