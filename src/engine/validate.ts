import type { Position } from 'geojson';
import type { Prepared } from './context';
import { floorEnvelopes, fromRoadReference } from './envelope';
import type { NativeFloor } from './envelope';
import type { NativeGeometry } from './geos';
import {
  ACCESSIBILITY, BANGKOK, boundaryDistances, BUDGET_TOLERANCE, BUILDING_ACT, classify, clearance,
  DISTANCE_TOLERANCE, ENVIRONMENT, FAR, frontLimits, GEOMETRY_AREA_TOLERANCE, NATIONAL, OSR, PLAN, PLANTING, PROFILES, rule,
} from './rules';
import type { RoadLimit } from './rules';
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
  const uniquePlates = [...new Set(floors.map(({ geometry }) => geometry))];
  const coverage = uniquePlates.slice(1).reduce((combined, geometry) => scope.union(combined, geometry), uniquePlates[0]);
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
  let minLocalBoundaryFloor = 0;
  let governingLocalDistance = 0;
  let minNearOffset = Infinity;
  let minCenterOffset = Infinity;
  let roadHeightMargin = Infinity;
  let supportError = 0;
  let retainedCollision = 0;
  let retainedClearance = Infinity;
  let allValid = true;
  let floorOverlap = false;
  const seenFloors = new Set<number>();
  const measured = new Map<NativeGeometry, { minX: number; boundary: number; privateBoundary: number }>();

  for (const [index, floor] of floors.entries()) {
    const { geometry, topM } = floor;
    if (!scope.isPolygon(geometry)) {
      floorOverlap = true;
      allValid = false;
      continue;
    }

    let position = measured.get(geometry);
    if (!position) {
      allValid &&= scope.valid(geometry);
      position = {
        minX: scope.minX(geometry),
        privateBoundary: scope.distance(geometry, privateHandle),
        boundary: scope.distance(geometry, boundaryHandle),
      };
      measured.set(geometry, position);
      maxExcess = Math.max(maxExcess, scope.area(scope.difference(geometry, plotHandle)));
      if (ctx.retainedHandle) {
        retainedCollision = Math.max(retainedCollision, scope.area(scope.intersection(geometry, ctx.retainedHandle)));
        retainedClearance = Math.min(retainedClearance, scope.distance(geometry, ctx.retainedHandle));
      }
    }
    const { minX, privateBoundary: localPrivateDistance, boundary } = position;
    const offsets = boundaryDistances(height, floor.floor, floor.topM);
    minPlotClearance = Math.min(minPlotClearance, boundary);
    minNationalBoundaryMargin = Math.min(minNationalBoundaryMargin, localPrivateDistance - offsets.national);
    const localMargin = localPrivateDistance - offsets.local;
    if (localMargin < minLocalBoundaryMargin) {
      minLocalBoundaryMargin = localMargin;
      minLocalBoundaryFloor = floor.floor;
      governingLocalDistance = offsets.local;
    }
    minNearOffset = Math.min(minNearOffset, minX - frame.nearX);
    minCenterOffset = Math.min(minCenterOffset, minX);
    roadHeightMargin = Math.min(roadHeightMargin, 2 * (minX - frame.farX) - topM);
    if (index > 0 && geometry !== floors[index - 1].geometry) supportError = Math.max(
      supportError,
      scope.area(scope.difference(geometry, floors[index - 1].geometry)),
    );
    const precedingTop = index === 0 ? 0 : floors[index - 1].topM;
    floorOverlap ||= seenFloors.has(floor.floor)
      || floor.floor !== index + 1 || !Number.isFinite(topM) || topM <= floor.baseM
      || Math.abs(floor.baseM - precedingTop) > 1e-6;
    seenFloors.add(floor.floor);
  }

  const footprint = scope.write(floors[0].geometry);
  const frontage = footprint?.type === 'Polygon' ? facingFacade(footprint.coordinates[0], frame.nearX) : null;
  const qualifiesRoadFacing = !!frontage && frontage.longest > frontage.perimeter / 8;
  // BMA §52(6) exempts residential buildings of at most three storeys. For
  // taller supported residential buildings, only §53's roadside branch is
  // implemented. Nonqualification requires a different access design.
  const localFrontageTrigger = floors.length > 3;
  let maxEnvelopeExcess = Infinity;
  if (!floorOverlap && allValid && floors.every(({ baseM, topM }) => Number.isFinite(baseM) && Number.isFinite(topM))) {
    maxEnvelopeExcess = scope.temporary(() => {
      const model = floorEnvelopes(ctx, floors.length, gfa, false, floors);
      return Math.max(...floors.map(({ geometry }, i) => scope.area(scope.difference(geometry, model.floors[i].geometry))));
    });
  }
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

  const checkedClearance = (national: boolean) => {
    const requirement = national ? boundaryDistances(height, 1, floors[0].topM).national : governingLocalDistance;
    const margin = national ? minNationalBoundaryMargin : minLocalBoundaryMargin;
    const actualM = requirement + margin;
    const qualifier = national
      ? `Uses the ${meters(height)} whole-building height for every opening-bearing floor.`
      : `Floor ${minLocalBoundaryFloor} governs. Requires 2 m on floors 1–2, or 3 m for floor 3+ or wall elevation over 9 m.`;
    return {
      ...rule(national ? 'private-national' : 'private-local',
        national ? 'National opening clearance' : 'Bangkok opening clearance',
        national ? 'แนวเขตที่ดิน' : 'ช่องเปิดและริมระเบียง',
        national ? 'MR55 §50' : 'BMA §54', national ? NATIONAL : BANGKOK,
        status(margin >= -DISTANCE_TOLERANCE), 'scenario',
        `${actualM.toFixed(4)} m minimum · ${requirement.toFixed(2)} m required · ${margin.toFixed(4)} m margin. ${qualifier} Verification tolerance: 0.00001 m.`,
        Math.abs(margin) < 0.15),
      measurement: { actualM, requiredM: requirement, toleranceM: DISTANCE_TOLERANCE },
    } satisfies RuleResult;
  };
  const results: RuleResult[] = [
    rule('plot', 'Plot containment and support', 'แนวเขตที่ดิน', 'Geometry check', PLAN,
      status(allValid && maxExcess <= GEOMETRY_AREA_TOLERANCE && supportError <= GEOMETRY_AREA_TOLERANCE),
      'scenario', `${square(maxExcess)} outside the plot. ${square(supportError)} unsupported above another plate.`),
    rule('applicable-envelope', 'Containment in the applicable floor slices', 'ขอบเขตที่อนุญาต', 'Independent geometry check', '',
      status(maxEnvelopeExcess <= GEOMETRY_AREA_TOLERANCE), 'scenario', Number.isFinite(maxEnvelopeExcess)
        ? `Maximum ${maxEnvelopeExcess.toFixed(6)} m² outside a matching slice, using full polygon differences, actual floor elevations and measured GFA. Modeled area tolerance: ${GEOMETRY_AREA_TOLERANCE} m².`
        : 'At least one floor is invalid or has inconsistent elevations; containment could not be evaluated.'),
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
    checkedClearance(true),
    checkedClearance(false),
    rule('all-around', 'All-around building clearance', 'ที่ว่างโดยรอบอาคาร', 'BMA §55', BANGKOK,
      perimeterDistance ? status(minPlotClearance + DISTANCE_TOLERANCE >= perimeterDistance) : 'not-applicable',
      perimeterDistance ? 'scenario' : 'documented',
      perimeterDistance
        ? `${meters(minPlotClearance)} minimum around all sides, against ${meters(perimeterDistance)} required. The screen reserves it inside the plot.`
        : 'Detached residence at or below 300 m² is exempt from the 1 m all-around requirement.',
      perimeterDistance > 0 && Math.abs(minPlotClearance - perimeterDistance) < 0.15),
    rule('far', 'Floor area ratio', 'อัตราส่วนพื้นที่อาคารรวมต่อพื้นที่ดิน', '2013 plan §4, §16(1)', PLAN,
      far === null ? 'review' : status(siteGfa! <= FAR * ctx.plotArea + BUDGET_TOLERANCE),
      far === null ? 'unknown' : 'scenario',
      far === null ? `${square(gfa)} new GFA. Retained GFA is unknown.`
        : `${square(siteGfa!)} site GFA ÷ ${square(ctx.plotArea)} eligible land = ${far.toFixed(2)}:1. Ceiling 7:1.`,
      siteGfa !== null && Math.abs(FAR * ctx.plotArea - siteGfa) <= 0.1),
    rule('osr', 'Open space ratio', 'อัตราส่วนของที่ว่างต่อพื้นที่อาคารรวม', '2013 plan §4, §16(2)', PLAN,
      osr === null ? 'review' : status(openArea + BUDGET_TOLERANCE >= OSR * siteGfa!),
      osr === null ? 'unknown' : 'scenario',
      osr === null ? `${square(openArea)} uncovered. Total GFA is needed for the OSR denominator.`
        : `${square(openArea)} uncovered ÷ ${square(siteGfa!)} site GFA = ${percent(osr)}. Requires 4.5% of GFA.`,
      siteGfa !== null && Math.abs(openArea - OSR * siteGfa) <= 0.1),
    rule('site-open', 'Site open space', 'ที่ว่างต่อพื้นที่ที่ดิน', 'BMA §52(1)', BANGKOK,
      status(openArea + BUDGET_TOLERANCE >= 0.3 * ctx.plotArea), 'scenario',
      `${square(openArea)} uncovered ÷ ${square(ctx.plotArea)} plot = ${percent(openArea / ctx.plotArea)}. Applies the 30% residential standard conservatively to multifamily.`,
      Math.abs(openArea - 0.3 * ctx.plotArea) <= 0.1),
    rule('largest-floor-open', 'Largest floor open space', 'ที่ว่างภายนอกอาคาร', 'MR55 §33(1)', NATIONAL,
      status(openArea + BUDGET_TOLERANCE >= 0.3 * largestFloor), 'scenario',
      `${square(openArea)} uncovered ÷ ${square(largestFloor)} largest new floor. Requires 30% of the largest floor.`,
      Math.abs(openArea - 0.3 * largestFloor) <= 0.1),
    rule('planting', 'Pervious planting', 'พื้นที่น้ำซึมผ่านได้เพื่อปลูกต้นไม้', '2013 plan §16(2)', PLAN,
      status(plantOutsideOpen <= GEOMETRY_AREA_TOLERANCE && planted + BUDGET_TOLERANCE >= PLANTING * openArea), 'scenario',
      `${square(planted)} proposed pervious planting ÷ ${square(openArea)} qualifying uncovered site = ${percent(openArea ? planted / openArea : 0)}. Requires 50%. Surface and soil performance require verification.`,
      Math.abs(planted - PLANTING * openArea) <= 0.1),
    rule('floors', 'Floor areas and nonoverlap', 'พื้นที่อาคารรวม', '2013 plan §4', PLAN,
      status(!floorOverlap && (!reportedAreas || (reportedAreas.length === areas.length
        && areas.every((area, i) => Math.abs(area - reportedAreas[i]) <= BUDGET_TOLERANCE)))),
      'scenario', `${floors.length} independently measured floor plates total ${square(gfa)} of new GFA. The total sums full-precision areas. The floor schedule rounds each row for display.`),
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
        && (profile.gfaLimit === null || gfa <= profile.gfaLimit + BUDGET_TOLERANCE)),
      'documented',
      `${floors.length}/${profile.maxFloors} model storeys. ${profile.gfaLimit === null ? 'No product GFA cap for this house profile.' : `${square(gfa)} of ${square(profile.gfaLimit)} product cap.`}`,
      profile.gfaLimit !== null && Math.abs(profile.gfaLimit - gfa) <= 0.1),
    rule('frontage', 'Public-road-facing façade', 'แนวอาคารด้านที่ประชิดติดริมทางสาธารณะ', 'BMA §§52(6), 53', BANGKOK,
      !localFrontageTrigger ? 'not-applicable' : status(qualifiesRoadFacing), 'scenario',
      !localFrontageTrigger ? 'The supported low residential form does not trigger this frontage branch.'
        : `${meters(frontage?.longest ?? 0)} qualifying façade within 20 m, against more than ${meters((frontage?.perimeter ?? 0) / 8)}. ${meters(road!.frontageM)} modeled plot contact. ${qualifiesRoadFacing ? 'Qualifies geometrically for the supported roadside branch, conditional on public access.' : 'Does not qualify for the modeled §53 roadside exemption. An alternative may be lawful, but is outside the automatic model.'}`),
    rule('frontage-public-access', 'Legal public road and access evidence', 'ทางสาธารณะ', 'BMA §§52(6), 53', BANGKOK,
      'review', input.road.publicStatus === 'documented' && road!.frontageM > 0 ? 'scenario' : 'unknown',
      `${meters(road!.frontageM)} modeled plot contact. A geometric result assumes legal adjacency and public access; verify the road boundary, road status and access rights independently.`),
    ...(localFrontageTrigger && !qualifiesRoadFacing ? [rule('frontage-alternative', 'Alternative frontage and internal access', 'ที่ว่างด้านหน้าและถนนภายใน', 'BMA §52(6)', BANGKOK,
      'review', 'unknown', 'A taller residential building failing the supported §53 roadside qualification requires separate analysis of the 12 m front open space, a continuous length of at least one-sixth of exterior perimeter, and a 6 m internal road connecting to the public road. This branch is not implemented and the candidate is not accepted by the automatic search.')] : []),
    rule('retained', 'Existing buildings and clearance', 'ระยะห่างระหว่างอาคาร', 'MR55 §48 · 2013 plan §4', NATIONAL,
      input.redevelopment === 'retain' && (retainedCollision > GEOMETRY_AREA_TOLERANCE
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

  return {
    checks: results.filter(({ status: result }) => result !== 'review'),
    siteEvidence: results.filter(({ status: result }) => result === 'review'),
    gfa, height, coveredArea, openArea, planted, areas,
  };
}
