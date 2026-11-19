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

export function floorEnvelopes(
  ctx: Prepared, floorCount: number, categoryGfa: number, measureControls = false,
) {
  const { scope, plotHandle, boundaryHandle, privateHandle, retainedHandle, input, frame } = ctx;
  const profile = PROFILES[input.profile];
  const totalHeightM = floorCount * profile.floorHeight;
  const perimeter = clearance(input.profile, totalHeightM, categoryGfa);
  const front = frontLimits(frame.widthM, floorCount, totalHeightM, categoryGfa);
  const restrictions = {
    clearance: false, nationalFront: false, localFront: false,
    nationalBoundary: false, localBoundary: false, roadHeight: false,
  };
  const retainedBuffer = retainedHandle ? scope.clearanceBand(retainedHandle, 6) : null;
  const site = retainedBuffer ? scope.difference(plotHandle, retainedBuffer) : plotHandle;
  const allAround = perimeter ? scope.clearanceBand(boundaryHandle, perimeter) : null;
  const base = allAround ? scope.difference(site, allAround) : site;
  const nationalFrontX = fromRoadReference(ctx, front.national);
  const localFrontX = fromRoadReference(ctx, front.local);
  const drivingFrontX = Math.max(nationalFrontX, localFrontX, frame.nearX);
  const privateBands = new Map<number, { band: NativeGeometry; after: NativeGeometry }>();
  const sliceByCut = new Map<string, NativeGeometry>();
  const floors: NativeFloor[] = [];

  for (let floor = 1; floor <= floorCount; floor++) {
    const topM = floor * profile.floorHeight;
    const baseM = (floor - 1) * profile.floorHeight;
    const privateDistances = boundaryDistances(totalHeightM, floor, topM);
    const drivingDistance = Math.max(privateDistances.national, privateDistances.local);
    let privateCut = privateBands.get(drivingDistance);
    if (!privateCut) {
      const band = scope.clearanceBand(privateHandle, drivingDistance);
      privateCut = { band, after: scope.difference(base, band) };
      privateBands.set(drivingDistance, privateCut);
    }
    const { band: privateBand, after: afterBoundary } = privateCut;
    const roadHeightX = frame.farX + topM / 2;
    const roadX = Math.max(drivingFrontX, roadHeightX);
    const cutKey = `${drivingDistance}:${roadX}`;
    let geometry = sliceByCut.get(cutKey);
    if (!geometry) {
      geometry = clipRoadSide(ctx, afterBoundary, roadX);
      sliceByCut.set(cutKey, geometry);
    }
    floors.push({ floor, baseM, topM, geometry });

    if (measureControls) {
      scope.temporary(() => {
        const finalArea = scope.area(geometry);
        const matters = (alternative: NativeGeometry) => scope.area(alternative) > finalArea + 0.005;
        if (matters(clipRoadSide(ctx, base, roadX))) {
          restrictions.nationalBoundary ||= privateDistances.national === drivingDistance;
          restrictions.localBoundary ||= privateDistances.local === drivingDistance;
        }
        if (allAround) restrictions.clearance ||= matters(clipRoadSide(ctx, scope.difference(site, privateBand), roadX));
        if (roadHeightX >= drivingFrontX) {
          restrictions.roadHeight ||= matters(clipRoadSide(ctx, afterBoundary, drivingFrontX));
        }
        if (drivingFrontX >= roadHeightX && drivingFrontX > frame.nearX
            && matters(clipRoadSide(ctx, afterBoundary, Math.max(roadHeightX, frame.nearX)))) {
          restrictions.nationalFront ||= nationalFrontX === drivingFrontX;
          restrictions.localFront ||= localFrontX === drivingFrontX;
        }
      });
    }
  }
  return { floors, restrictions, front, perimeter, totalHeightM };
}
