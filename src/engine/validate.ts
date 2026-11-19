import type { Position } from 'geojson';
import type { Prepared } from './context';
import { fromRoadReference } from './envelope';
import type { NativeFloor } from './envelope';
import type { NativeGeometry } from './geos';
import {
  ACCESSIBILITY, AREA_TOLERANCE, BANGKOK, boundaryDistances, BUILDING_ACT, classify, clearance,
  DISTANCE_TOLERANCE, ENVIRONMENT, FAR, frontLimits, NATIONAL, OSR, PLAN, PLANTING, PROFILES, rule,
} from './rules';
import type { RoadLimit } from './rules';
import { extent, points } from './spatial';
import type { RuleResult } from './types';

const square = (area: number) => `${area.toFixed(2)} m²`;
const meters = (distance: number) => `${distance.toFixed(2)} m`;
const percent = (ratio: number) => `${(100 * ratio).toFixed(2)}%`;
const status = (pass: boolean) => pass ? 'pass' as const : 'fail' as const;

function facingFacade(ring: Position[], nearX: number) {
  const signedArea = ring.slice(0, -1).reduce((sum, point, i) =>
    sum + point[0] * ring[i + 1][1] - ring[i + 1][0] * point[1], 0);
  const winding = Math.sign(signedArea);
  const runs = ring.slice(0, -1).map(([x, y], index) => {
    const [nx, ny] = ring[index + 1];
    const length = Math.hypot(nx - x, ny - y);
    const outwardFacesRoad = (ny - y) * winding < 0;
    const nearlyAligned = Math.abs(ny - y) >= 0.9 * length;
    return outwardFacesRoad && nearlyAligned && Math.max(nx, x) - nearX <= 20 ? length : 0;
  });
  const firstBreak = runs.indexOf(0);
  const linear = firstBreak < 0 ? runs : [...runs.slice(firstBreak), ...runs.slice(0, firstBreak)];
  let run = 0;
  let longest = 0;
  for (const length of linear) {
    run = length ? run + length : 0;
    longest = Math.max(longest, run);
  }
  return { longest, perimeter: ring.slice(0, -1).reduce((sum, [x, y], index) =>
    sum + Math.hypot(ring[index + 1][0] - x, ring[index + 1][1] - y), 0) };
}

export function checkConcept(
  ctx: Prepared,
  floors: NativeFloor[],
  planting: NativeGeometry | null,
  reportedAreas?: number[],
) {
  const { scope, input, frame, road, privateHandle, boundaryHandle, plotHandle } = ctx;
  const areas = floors.map(({ geometry }) => scope.area(geometry));
  const gfa = areas.reduce((sum, area) => sum + area, 0);
  const height = Math.max(...floors.map(({ topM }) => topM));
  const categories = classify(height, gfa);
  const perimeterDistance = clearance(input.profile, height, gfa);
  const fronts = frontLimits(frame.widthM, floors.length, height, gfa);
  const profile = PROFILES[input.profile];
  const coverage = floors.slice(1).reduce((combined, floor) => scope.union(combined, floor.geometry), floors[0].geometry);
  const allCovered = ctx.retainedHandle ? scope.union(coverage, ctx.retainedHandle) : coverage;
  const coveredSite = scope.intersection(allCovered, plotHandle);
  const openGeometry = scope.difference(plotHandle, coveredSite);
  const coveredArea = scope.area(coveredSite);
  const openArea = scope.area(openGeometry);
  const planted = planting ? scope.area(planting) : 0;
  const plantOutsideOpen = planting ? scope.area(scope.difference(planting, openGeometry)) : 0;
  const largestFloor = Math.max(...areas);
  const siteGfa = ctx.retainedGfa === null ? null : gfa + ctx.retainedGfa;
  const far = siteGfa === null ? null : siteGfa / ctx.plotArea;
  const osr = siteGfa === null ? null : openArea / siteGfa;
  const roadEvidence = input.road.widthSource === 'unverified' || input.road.publicStatus === 'unknown'
    ? 'unknown' as const : 'scenario' as const;

  let maxExcess = 0;
  let minPlotClearance = Infinity;
  let minNationalBoundaryMargin = Infinity;
  let minLocalBoundaryMargin = Infinity;
  let minNearOffset = Infinity;
  let minCenterOffset = Infinity;
  let roadHeightMargin = Infinity;
  let supportError = 0;
  let retainedCollision = 0;
  let retainedClearance = Infinity;
  let allValid = true;
  let floorOverlap = false;
  const seenFloors = new Set<number>();

  for (const [index, floor] of floors.entries()) {
    const { geometry, topM } = floor;
    const shape = scope.write(geometry);
    allValid &&= !!shape && scope.valid(geometry);
    if (!shape) continue;
    const minX = extent(points(shape)).minX;
    const localPrivateDistance = scope.distance(geometry, privateHandle);
    const offsets = boundaryDistances(height, floor.floor, floor.topM);
    maxExcess = Math.max(maxExcess, scope.area(scope.difference(geometry, plotHandle)));
    minPlotClearance = Math.min(minPlotClearance, scope.distance(geometry, boundaryHandle));
    minNationalBoundaryMargin = Math.min(minNationalBoundaryMargin, localPrivateDistance - offsets.national);
    minLocalBoundaryMargin = Math.min(minLocalBoundaryMargin, localPrivateDistance - offsets.local);
    minNearOffset = Math.min(minNearOffset, minX - frame.nearX);
    minCenterOffset = Math.min(minCenterOffset, minX);
    roadHeightMargin = Math.min(roadHeightMargin, 2 * (minX - frame.farX) - topM);
    if (index > 0) supportError = Math.max(
      supportError,
      scope.area(scope.difference(geometry, floors[index - 1].geometry)),
    );
    if (ctx.retainedHandle) {
      retainedCollision = Math.max(retainedCollision, scope.area(scope.intersection(geometry, ctx.retainedHandle)));
      retainedClearance = Math.min(retainedClearance, scope.distance(geometry, ctx.retainedHandle));
    }
    const precedingTop = index === 0 ? 0 : floors[index - 1].topM;
    floorOverlap ||= seenFloors.has(floor.floor) || shape.type === 'MultiPolygon'
      || floor.floor !== index + 1 || !Number.isFinite(topM) || topM <= floor.baseM
      || Math.abs(floor.baseM - precedingTop) > 1e-6;
    seenFloors.add(floor.floor);
  }

  const footprint = scope.write(floors[0].geometry);
  const frontage = footprint?.type === 'Polygon' ? facingFacade(footprint.coordinates[0], frame.nearX) : null;
  const qualifiesRoadFacing = !!frontage && frontage.longest > frontage.perimeter / 8;
  const localFrontageTrigger = floors.length > 3;
  const frontCheck = (key: 'national' | 'local', limit: RoadLimit): RuleResult => {
    const actual = limit?.reference === 'near-edge' ? minNearOffset : minCenterOffset;
    return rule(
      `${key}-road-setback`, key === 'national' ? 'National road setback' : 'Bangkok road setback',
      'แนวอาคารและระยะร่น', key === 'national' ? 'MR55 §41' : 'BMA §50',
      key === 'national' ? NATIONAL : BANGKOK, limit ? status(actual + DISTANCE_TOLERANCE >= limit.distance) : 'not-applicable',
      'scenario', limit
        ? `${meters(actual)} from the ${limit.reference === 'near-edge' ? 'near right-of-way edge' : 'centerline'}. Requires ${meters(limit.distance)}.`
        : key === 'local' && fronts.localExemption
          ? 'The local enhanced setback exemption applies to this small residential building. The national rule remains separate.'
          : 'This building and road width do not trigger this setback branch.',
      !!limit && Math.abs(minCenterOffset - fromRoadReference(ctx, limit)) < 0.15,
    );
  };

  const checks: RuleResult[] = [
    rule('plot', 'Plot containment and support', 'แนวเขตที่ดิน', 'Geometry check', PLAN,
      status(allValid && maxExcess <= AREA_TOLERANCE && supportError <= AREA_TOLERANCE),
      'scenario', `${square(maxExcess)} outside the plot. ${square(supportError)} unsupported above another plate.`),
    frontCheck('national', fronts.national),
    frontCheck('local', fronts.local),
    rule('street-overlap', 'Building outside model right-of-way', 'ที่สาธารณะ', 'MR55 §40', NATIONAL,
      status(minNearOffset >= -DISTANCE_TOLERANCE), roadEvidence, `${meters(minNearOffset)} at the closest point to the near edge.`),
    rule('road-height', 'Road height plane', 'แนวเขตด้านตรงข้าม', 'MR55 §44', NATIONAL,
      status(roadHeightMargin >= -DISTANCE_TOLERANCE * 2), roadEvidence,
      `${meters(roadHeightMargin)} minimum headroom at slab top. Datum assumes level road and plot. Each slab top is checked against twice the perpendicular distance to the far edge.`,
      Math.abs(roadHeightMargin) < 0.2),
    rule('road-height-local', 'Bangkok road height plane', 'ความสูงของอาคาร', 'BMA §49', BANGKOK,
      status(roadHeightMargin >= -DISTANCE_TOLERANCE * 2), roadEvidence,
      `${meters(roadHeightMargin)} minimum headroom using the selected single public road and an assumed level road datum. Special wide-road access cases require separate analysis.`,
      Math.abs(roadHeightMargin) < 0.2),
    rule('private-national', 'National opening clearance', 'แนวเขตที่ดิน', 'MR55 §50', NATIONAL,
      status(minNationalBoundaryMargin >= -DISTANCE_TOLERANCE), 'scenario',
      `The ${meters(height)} total building height sets ${height > 9 ? '3' : '2'} m on every opening-bearing plate. ${meters(minNationalBoundaryMargin)} minimum margin.`,
      Math.abs(minNationalBoundaryMargin) < 0.15),
    rule('private-local', 'Bangkok opening clearance', 'ช่องเปิดและริมระเบียง', 'BMA §54', BANGKOK,
      status(minLocalBoundaryMargin >= -DISTANCE_TOLERANCE), 'scenario',
      `2 m on floors 1–2 and 3 m where floor 3+ or wall elevation exceeds 9 m. ${meters(minLocalBoundaryMargin)} minimum margin.`,
      Math.abs(minLocalBoundaryMargin) < 0.15),
    rule('all-around', 'All-around building clearance', 'ที่ว่างโดยรอบอาคาร', 'BMA §55', BANGKOK,
      perimeterDistance ? status(minPlotClearance + DISTANCE_TOLERANCE >= perimeterDistance) : 'not-applicable',
      perimeterDistance ? 'scenario' : 'documented',
      perimeterDistance
        ? `${meters(minPlotClearance)} minimum around all sides, against ${meters(perimeterDistance)} required. The screen reserves it inside the plot.`
        : 'Detached residence at or below 300 m² is exempt from the 1 m all-around requirement.',
      perimeterDistance > 0 && Math.abs(minPlotClearance - perimeterDistance) < 0.15),
    rule('far', 'Floor area ratio', 'อัตราส่วนพื้นที่อาคารรวมต่อพื้นที่ดิน', '2013 plan §4, §16(1)', PLAN,
      far === null ? 'review' : status(siteGfa! <= FAR * ctx.plotArea + AREA_TOLERANCE),
      far === null ? 'unknown' : 'scenario',
      far === null ? `${square(gfa)} new GFA. Retained GFA is unknown.`
        : `${square(siteGfa!)} site GFA ÷ ${square(ctx.plotArea)} eligible land = ${far.toFixed(2)}:1. Ceiling 7:1.`,
      siteGfa !== null && Math.abs(FAR * ctx.plotArea - siteGfa) <= 0.1),
    rule('osr', 'Open space ratio', 'อัตราส่วนของที่ว่างต่อพื้นที่อาคารรวม', '2013 plan §4, §16(2)', PLAN,
      osr === null ? 'review' : status(openArea + AREA_TOLERANCE >= OSR * siteGfa!),
      osr === null ? 'unknown' : 'scenario',
      osr === null ? `${square(openArea)} uncovered. Total GFA is needed for the OSR denominator.`
        : `${square(openArea)} uncovered ÷ ${square(siteGfa!)} site GFA = ${percent(osr)}. Requires 4.5% of GFA.`,
      siteGfa !== null && Math.abs(openArea - OSR * siteGfa) <= 0.1),
    rule('site-open', 'Site open space', 'ที่ว่างต่อพื้นที่ที่ดิน', 'BMA §52(1)', BANGKOK,
      status(openArea + AREA_TOLERANCE >= 0.3 * ctx.plotArea), 'scenario',
      `${square(openArea)} uncovered ÷ ${square(ctx.plotArea)} plot = ${percent(openArea / ctx.plotArea)}. Applies the 30% residential standard conservatively to multifamily.`,
      Math.abs(openArea - 0.3 * ctx.plotArea) <= 0.1),
    rule('largest-floor-open', 'Largest floor open space', 'ที่ว่างภายนอกอาคาร', 'MR55 §33(1)', NATIONAL,
      status(openArea + AREA_TOLERANCE >= 0.3 * largestFloor), 'scenario',
      `${square(openArea)} uncovered ÷ ${square(largestFloor)} largest new floor. Requires 30% of the largest floor.`,
      Math.abs(openArea - 0.3 * largestFloor) <= 0.1),
    rule('planting', 'Pervious planting', 'พื้นที่น้ำซึมผ่านได้เพื่อปลูกต้นไม้', '2013 plan §16(2)', PLAN,
      status(plantOutsideOpen <= AREA_TOLERANCE && planted + AREA_TOLERANCE >= PLANTING * openArea), 'scenario',
      `${square(planted)} proposed pervious planting ÷ ${square(openArea)} qualifying uncovered site = ${percent(openArea ? planted / openArea : 0)}. Requires 50%. Surface and soil performance require verification.`,
      Math.abs(planted - PLANTING * openArea) <= 0.1),
    rule('floors', 'Floor areas and nonoverlap', 'พื้นที่อาคารรวม', '2013 plan §4', PLAN,
      status(!floorOverlap && (!reportedAreas || (reportedAreas.length === areas.length
        && areas.every((area, i) => Math.abs(area - reportedAreas[i]) <= AREA_TOLERANCE)))),
      'scenario', `${areas.map(square).join(' + ')} = ${square(gfa)} of new GFA.`),
    rule('category', 'High-rise and large-building bands', 'อาคารสูง / อาคารขนาดใหญ่', 'Building Control Act §4 · MR55 §1',
      BUILDING_ACT, status(!categories.high && !categories.large && !categories.extraLarge),
      'scenario', `${meters(height)} height and ${square(gfa)} GFA. High-rise starts at 23 m. Large and extra-large building profiles need separate evaluation.`),
    rule('special', 'Special-building review', 'อาคารพิเศษ', 'MR55 §1(c)', NATIONAL,
      'review', categories.specialByHeight ? 'scenario' : 'unknown',
      categories.specialByHeight
        ? 'Height exceeds 15 m. The proposal meets the special-building height trigger and needs structural and safety review.'
        : 'Height does not trigger special-building classification. Structural and roof spans greater than 10 m and other triggers require design information.'),
    rule('profile', 'Application profile limits', 'ขอบเขตการประเมิน', 'Model scope', '',
      status(floors.length <= profile.maxFloors
        && (input.profile === 'house' ? height <= profile.heightLimit : height < profile.heightLimit)
        && (profile.gfaLimit === null || gfa <= profile.gfaLimit + AREA_TOLERANCE)),
      'documented',
      `${floors.length}/${profile.maxFloors} model storeys. ${profile.gfaLimit === null ? 'No product GFA cap for this house profile.' : `${square(gfa)} of ${square(profile.gfaLimit)} product cap.`}`,
      profile.gfaLimit !== null && Math.abs(profile.gfaLimit - gfa) <= 0.1),
    rule('frontage', 'Public-road-facing façade', 'แนวอาคารด้านที่ประชิดติดริมทางสาธารณะ', 'BMA §§52(6), 53', BANGKOK,
      !localFrontageTrigger ? 'not-applicable' : qualifiesRoadFacing && road!.frontageM > 0 ? 'pass' : 'review',
      road!.frontageM > 0 ? 'scenario' : 'unknown',
      !localFrontageTrigger ? 'The supported low residential form does not trigger this frontage branch.'
        : `${meters(frontage?.longest ?? 0)} qualifying façade within 20 m, against more than ${meters((frontage?.perimeter ?? 0) / 8)}. ${meters(road!.frontageM)} modeled plot contact. Confirm the public access, or assess the alternative frontage and internal access provisions.`),
    rule('retained', 'Existing buildings and clearance', 'ระยะห่างระหว่างอาคาร', 'MR55 §48 · 2013 plan §4', NATIONAL,
      input.redevelopment === 'retain' && (retainedCollision > AREA_TOLERANCE
        || retainedClearance + DISTANCE_TOLERANCE < 6) ? 'fail' : 'review',
      'scenario', input.redevelopment === 'clear'
        ? `${ctx.affected.length} intersecting mapped footprints. This concept assumes clearance inside the drawn boundary. Outside portions remain visible as context, and permissions for a straddling structure require review.`
        : `Existing coverage has been unioned with new coverage. ${ctx.retainedGfa === null ? 'Retained GFA is unknown.' : `${square(ctx.retainedGfa)} retained GFA included.`} The screen reserves 6 m around known retained coverage. Retained largest-floor and building-to-building requirements need verified existing-building facts.`),
    rule('egress', 'Escape stairs', 'บันไดหนีไฟ', 'MR55 §27', NATIONAL,
      'review', 'unknown',
      floors.length >= 4
        ? 'Four or more storeys trigger the MR55 escape-stair provisions at this height. Verify internal layout and roof access.'
        : 'Verify the detailed egress design, including any accessible roof area above a third storey.'),
    rule('accessibility', 'Accessible building design', 'สิ่งอำนวยความสะดวก', 'Accessibility regulation §3(5)', ACCESSIBILITY,
      'review', 'unknown',
      'Detailed layout and parking require verification. The regulation names large multifamily or condominium buildings among its covered types.'),
    rule('eia', 'Environmental screening', 'รายงานการประเมินผลกระทบสิ่งแวดล้อม',
      'ONEP schedule, items 30–31', ENVIRONMENT,
      input.profile === 'multifamily' ? 'review' : 'not-applicable', 'unknown',
      'Determine actual unit count and usable area. The published multifamily thresholds include 80 units or 4,000 m² usable area.'),
  ];

  return { checks, gfa, height, coveredArea, openArea, planted, areas };
}
