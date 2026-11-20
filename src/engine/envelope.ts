import type { NativeGeometry } from './geos';
import { clipRoadSide, serializeAreaForAudit } from './context';
import type { AreaGeometry } from './types';
import type { Prepared } from './context';
import { BANGKOK, boundaryDistances, classify, clearance, frontLimits, NATIONAL, PROFILES, rule } from './rules';
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
  actualFloors?: Pick<NativeFloor, 'floor' | 'baseM' | 'topM'>[],
) {
  const { scope, plotHandle, boundaryHandle, privateHandle, retainedHandle, input, frame } = ctx;
  const profile = PROFILES[input.profile];
  const totalHeightM = actualFloors ? Math.max(...actualFloors.map(({ topM }) => topM)) : floorCount * profile.floorHeight;
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

  for (let index = 0; index < floorCount; index++) {
    const floor = actualFloors?.[index].floor ?? index + 1;
    const topM = actualFloors?.[index].topM ?? floor * profile.floorHeight;
    const baseM = actualFloors?.[index].baseM ?? (floor - 1) * profile.floorHeight;
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

/** Serialize and explain the exact model used to construct these slices. */
export function describeEnvelope(ctx: Prepared, model: ReturnType<typeof floorEnvelopes>, categoryGfa: number, kind: 'capacity' | 'concept') {
  const { scope, input } = ctx;
  const { floors, restrictions, front, perimeter, totalHeightM } = model;
  const categories = classify(totalHeightM, categoryGfa);
  const classification = [input.profile === 'house' ? 'Detached residential' : 'Multifamily residential'];
  classification.push(categories.high ? 'High-rise by height' : 'Below the 23 m high-rise threshold');
  if (categories.specialByHeight) classification.push('Special building by height. Structural and safety review required');
  classification.push(categories.large ? 'Large building by modeled area' : 'Large building category excluded');
  classification.push(`${kind === 'concept' ? 'Independently measured design GFA' : 'Capacity classification assumption'}: ${categoryGfa.toFixed(2)} m²`);
  const schedule = floors.map(({ floor, baseM, topM, geometry }) => ({ floor, baseM, topM, areaM2: scope.area(geometry) }));
  const serializedSlices = new Map<NativeGeometry, AreaGeometry>();
  const effect = (active: boolean) => active ? 'Reduces at least one slice.' : 'Does not reduce these slices after other limits.';
  const describeFront = (limit: RoadLimit) => limit
    ? `${limit.distance.toFixed(2)} m from the ${limit.reference === 'centerline' ? 'centerline' : 'near right-of-way edge'}.`
    : 'This setback branch is not triggered at this height and road width.';
  return {
    envelope: floors.flatMap((floor, i) => {
      if (schedule[i].areaM2 === 0) return [];
      const geometry = serializedSlices.get(floor.geometry) ?? scope.temporary(() => serializeAreaForAudit(ctx, floor.geometry)?.world);
      if (!geometry) throw new Error('Could not serialize a valid applicable envelope.');
      serializedSlices.set(floor.geometry, geometry);
      return [{ ...schedule[i], geometry }];
    }),
    explanation: {
      heightM: totalHeightM, classification, floorCount: floors.length, floors: schedule,
      sumM2: schedule.reduce((total, floor) => total + floor.areaM2, 0),
      included: [
        'Scenario parcel, modeled right-of-way, national and Bangkok opening and front setbacks, all-around clearance, and the road height plane',
        kind === 'concept' ? 'Actual occupied floor elevations and whole-building classification' : '3.2 m floor-to-floor and the selected supported height/category band',
        ...(ctx.retainedHandle ? ['Conservative 6 m buffer around retained mapped coverage'] : []),
      ],
      excluded: [
        'FAR, cumulative new/retained GFA and application GFA cap are assessed separately from the slice sum',
        'Open space and planting budgets, floor continuity and practical dimensions, access, parking and floor plans',
      ],
      reason: kind === 'concept'
        ? 'These slices correspond to the actual selected design’s measured height and GFA. Each occupied plate is checked against its own slice. The slice sum is a geometric bound for this classification, subject to separate budgets and design constraints.'
        : 'This is the largest slice sum among supported building heights. It assumes every slice can be filled completely, including disconnected pieces. A shorter concept can have wider individual floors because its whole-building setbacks differ. Each design still has to connect its plates, fit the separate budgets, and pass its own checks.',
    },
    rules: [
      rule('national-front', 'National front building line', 'การร่นแนวอาคาร', 'MR55 §41', NATIONAL,
        front.national ? 'pass' : 'not-applicable', 'scenario',
        `${describeFront(front.national)} ${front.national ? effect(restrictions.nationalFront) : ''}`, restrictions.nationalFront),
      rule('local-front', 'Bangkok front building line', 'การร่นแนวอาคาร', 'BMA §50', BANGKOK,
        front.local ? 'pass' : 'not-applicable', 'scenario',
        `${describeFront(front.local)} ${front.local ? effect(restrictions.localFront) : ''}`, restrictions.localFront),
      rule('national-private', 'National private-boundary clearance', 'แนวเขตที่ดิน', 'MR55 §50', NATIONAL,
        'pass', 'scenario', `Uses ${totalHeightM > 9 ? 3 : 2} m from private boundaries on each opening-bearing floor at this building's total height. ${effect(restrictions.nationalBoundary)}`, restrictions.nationalBoundary),
      rule('local-private', 'Bangkok private-boundary clearance', 'ช่องเปิดและริมระเบียง', 'BMA §54', BANGKOK,
        'pass', 'scenario', `Applies the opening setback by storey/elevation and combines it with the national setback. ${effect(restrictions.localBoundary)}`, restrictions.localBoundary),
      rule('perimeter-clearance', 'All-around clearance', 'ที่ว่างโดยรอบอาคาร', 'BMA §55', BANGKOK,
        perimeter ? 'pass' : 'not-applicable', 'scenario', perimeter
          ? `${perimeter} m reserved inside the drawn plot around all sides. ${effect(restrictions.clearance)}`
          : 'The small detached housing band exempts this model from this requirement.', restrictions.clearance),
      rule('height-plane', 'Road-derived height plane', 'แนวเขตด้านตรงข้าม', 'MR55 §44 · BMA §49', NATIONAL,
        'pass', 'scenario', `Clips each slab top at twice the perpendicular distance to the far right-of-way edge. ${effect(restrictions.roadHeight)}`, restrictions.roadHeight),
    ],
  };
}
