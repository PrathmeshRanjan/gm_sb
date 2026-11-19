import { prepare, worldGeometry } from './context';
import { generateDesign } from './design';
import { floorEnvelopes } from './envelope';
import type { NativeFloor } from './envelope';
import { withGeos } from './geos';
import { BANGKOK, classify, FAR, NATIONAL, PLAN, PROFILES, rule } from './rules';
import type { RoadLimit } from './rules';
import { mapArea, normalizePlot } from './spatial';
import type { Concept, RuleResult, ScenarioInput, ScenarioResult } from './types';
import { checkConcept } from './validate';

const blank = (): ScenarioResult => ({
  validation: 'invalid', plotAreaM2: 0, coverageVerified: false, road: null,
  affectedBuildingIds: [], preservedBuildingParts: [], capacity: null, envelope: [], boundExplanation: null,
  search: null, concepts: [], conceptMessages: {}, rules: [], siteEvidence: [], elapsedMs: 0,
});

export async function calculateScenario(input: ScenarioInput): Promise<ScenarioResult> {
  return withGeos((scope) => {
    const started = performance.now();
    const result = blank();
    try {
      const plot = normalizePlot(input.plot);
      if (!plot) throw new Error('Draw a valid polygon with at least three distinct points.');
      const ctx = prepare(scope, input, plot);
      result.plotAreaM2 = ctx.plotArea;
      result.coverageVerified = ctx.coverage;
      result.road = ctx.road;
      result.affectedBuildingIds = ctx.affected.flatMap((building) => building.id ? [building.id] : []);
      result.preservedBuildingParts = ctx.preservedBuildingParts;
      if (!ctx.coverage) {
        result.validation = 'outside-coverage';
        result.message = 'Part of this plot is outside the verified ย.๙-๑๓ study area.';
        return result;
      }
      if (ctx.conflictsWithRoad) {
        result.validation = 'road-conflict';
        result.message = `The fixed plot overlaps the modeled right-of-way by ${ctx.road!.conflictM2.toFixed(2)} m². Change the width or edit the parcel.`;
        return result;
      }
      if (!ctx.alignmentVerified) {
        result.message = 'The selected road segment does not span this entire plot. Select the relevant frontage segment.';
        return result;
      }
      if (!ctx.frontageMatched) {
        result.message = 'No plot edge aligns with the baseline frontage. Choose a facing edge or draw a plot adjoining the selected road.';
        return result;
      }
      result.validation = 'valid';

      const profile = PROFILES[input.profile];
      let maxArea = -1;
      let chosenCount = 0;
      const categoryGfa = input.profile === 'house' ? 300 : profile.gfaLimit!;
      for (let count = 1; count <= profile.maxFloors; count++) {
        if (input.profile === 'multifamily' && count < 2) continue;
        const sum = scope.temporary(() => floorEnvelopes(ctx, count, categoryGfa).floors
          .reduce((total, floor) => total + scope.area(floor.geometry), 0));
        if (sum > maxArea) {
          maxArea = sum;
          chosenCount = count;
        }
      }
      const model = chosenCount ? floorEnvelopes(ctx, chosenCount, categoryGfa, true) : undefined;
      result.envelope = model ? model.floors.flatMap((floor) => {
        const shape = scope.write(floor.geometry);
        return shape ? [{
          floor: floor.floor, baseM: floor.baseM, topM: floor.topM,
          areaM2: scope.area(floor.geometry), geometry: worldGeometry(ctx, shape),
        }] : [];
      }) : [];
      result.capacity = {
        regulatoryFar: FAR,
        regulatoryGfaCeilingM2: ctx.plotArea * FAR,
        geometricGfaUpperBoundM2: Math.max(0, maxArea),
        profileGfaLimitM2: profile.gfaLimit,
        profileHeightLimitM: profile.heightLimit,
        profileMaxFloors: profile.maxFloors,
        retainedGfaM2: ctx.retainedGfa,
      };
      const restrictions = model?.restrictions;
      if (model) {
        const categories = classify(model.totalHeightM, categoryGfa);
        const classification = [input.profile === 'house' ? 'Detached residential' : 'Multifamily residential'];
        classification.push(categories.high ? 'High-rise by height' : 'Below the 23 m high-rise threshold');
        if (categories.specialByHeight) classification.push('Special building by height. Structural and safety review required');
        classification.push(categories.large ? 'Large building by modeled area' : 'Large building category excluded');
        result.boundExplanation = {
          heightM: model.totalHeightM,
          classification,
          floorCount: chosenCount,
          floors: model.floors.map(({ floor, baseM, topM, geometry }) => ({
            floor, baseM, topM, areaM2: scope.area(geometry),
          })),
          sumM2: Math.max(0, maxArea),
          included: [
            'Scenario parcel, modeled right-of-way, national and Bangkok opening and front setbacks, all-around clearance, and the road height plane',
            '3.2 m floor-to-floor and the selected supported height/category band',
            ...(ctx.retainedHandle ? ['Conservative 6 m buffer around retained mapped coverage'] : []),
          ],
          excluded: [
            'FAR, cumulative new/retained GFA and application GFA cap are assessed separately from the slice sum',
            'Open space and planting budgets, floor continuity and practical dimensions, access, parking and floor plans',
          ],
          reason: 'This is the largest slice sum among supported building heights. It assumes every slice can be filled completely, including disconnected pieces. A shorter concept can have wider individual floors because its whole-building setbacks differ. Each design still has to connect its plates, fit the separate budgets, and pass its own checks.',
        };
      }
      const effect = (active?: boolean) => active ? 'Reduces at least one slice.' : 'Does not reduce the displayed slices after other limits.';
      const describeFront = (limit: RoadLimit) =>
        limit ? `${limit.distance.toFixed(2)} m from the ${limit.reference === 'centerline' ? 'centerline' : 'near right-of-way edge'}.`
          : 'This setback branch is not triggered for the bound height and road width.';
      result.siteEvidence = [
        rule('plot-basis', 'Drawn plot boundary', 'แนวเขตที่ดิน', 'Site evidence', '',
          'review', 'scenario', 'Editable scenario polygon in verified ย.๙-๑๓ coverage. Its edges, title, and easements require survey or title evidence.'),
        rule('road-basis', 'Road width and alignment', 'เขตทาง', 'BMA §5(4)', input.road.sourceUrl ?? BANGKOK,
          'review', 'scenario',
          `${ctx.road!.widthM.toFixed(2)} m total modeled width. ${ctx.road!.frontageM.toFixed(2)} m modeled parcel contact. ${ctx.road!.inferred ? 'Road edges inferred from the mapped centerline.' : 'Edge lines supplied.'} Confirm legal frontage, public access and road/plot elevations.`),
      ];
      result.rules = [
        rule('national-front', 'National front building line', 'การร่นแนวอาคาร', 'MR55 §41', NATIONAL,
          model?.front.national ? 'pass' : 'not-applicable', 'scenario',
          `${describeFront(model?.front.national ?? null)} ${model?.front.national ? effect(restrictions?.nationalFront) : ''}`,
          restrictions?.nationalFront),
        rule('local-front', 'Bangkok front building line', 'การร่นแนวอาคาร', 'BMA §50', BANGKOK,
          model?.front.local ? 'pass' : 'not-applicable', 'scenario',
          `${describeFront(model?.front.local ?? null)} ${model?.front.local ? effect(restrictions?.localFront) : ''}`,
          restrictions?.localFront),
        rule('national-private', 'National private-boundary clearance', 'แนวเขตที่ดิน', 'MR55 §50', NATIONAL,
          'pass', 'scenario', `Uses ${model && model.totalHeightM > 9 ? 3 : 2} m from private boundaries on each opening-bearing floor at the bound building's total height. ${effect(restrictions?.nationalBoundary)}`,
          restrictions?.nationalBoundary),
        rule('local-private', 'Bangkok private-boundary clearance', 'ช่องเปิดและริมระเบียง', 'BMA §54', BANGKOK,
          'pass', 'scenario', `Applies the opening setback by storey/elevation and combines it with the national setback. ${effect(restrictions?.localBoundary)}`,
          restrictions?.localBoundary),
        rule('perimeter-clearance', 'All-around clearance', 'ที่ว่างโดยรอบอาคาร', 'BMA §55', BANGKOK,
          model?.perimeter ? 'pass' : 'not-applicable', 'scenario', model?.perimeter
            ? `${model.perimeter} m reserved inside the drawn plot around all sides. ${effect(restrictions?.clearance)}`
            : 'The small detached housing band exempts the displayed upper-bound model from this requirement.',
          restrictions?.clearance),
        rule('height-plane', 'Road-derived height plane', 'แนวเขตด้านตรงข้าม', 'MR55 §44 · BMA §49', NATIONAL,
          'pass', 'scenario', `Clips each slab top at twice the perpendicular distance to the far right-of-way edge. ${effect(restrictions?.roadHeight)}`,
          restrictions?.roadHeight),
      ];
      if (result.envelope.length === 0) {
        result.message = 'The combined clearances leave an empty buildable envelope.';
        result.conceptMessages = {
          wide: 'No floor plate remains inside the modeled clearances.',
          stepped: 'No connected lower plate remains to support upper floors.',
        };
        return result;
      }

      const wide = scope.temporary(() => generateDesign(ctx, 'wide'));
      const stepped = scope.temporary(() => generateDesign(ctx, 'stepped', wide.concept ?? undefined));
      const checkedGfa = [wide.bestValidatedGfaM2, stepped.bestValidatedGfaM2].filter((area): area is number => area !== null);
      result.search = {
        evaluated: wide.evaluated + stepped.evaluated,
        independentlyChecked: wide.independentlyChecked + stepped.independentlyChecked,
        validated: wide.validated + stepped.validated,
        bestValidatedGfaM2: checkedGfa.length ? Math.max(...checkedGfa) : null,
        minimumPlateM2: profile.minArea,
        minimumCoreWidthM: profile.minDepth,
      };
      if (wide.concept) result.concepts.push(wide.concept);
      else result.conceptMessages.wide = 'No connected lower form fit the clearance, minimum dimensions, and area budgets.';
      if (stepped.concept) result.concepts.push(stepped.concept);
      else result.conceptMessages.stepped = 'No meaningfully smaller footprint fit the upper slices, support depth, and area budgets.';
      return result;
    } catch (error) {
      result.message = error instanceof Error ? error.message : 'Could not calculate this scenario.';
      result.validation = 'invalid';
      result.capacity = null;
      result.envelope = [];
      result.boundExplanation = null;
      result.search = null;
      result.concepts = [];
      return result;
    } finally {
      result.elapsedMs = performance.now() - started;
    }
  });
}

/** Audit a serialized proposal without using generator decisions or cached geometries. */
export async function validateGeneratedConcept(input: ScenarioInput, proposal: Concept): Promise<RuleResult[]> {
  return withGeos((scope) => {
    const plot = normalizePlot(input.plot);
    if (!plot || !proposal.floors.length) {
      return [rule('plot', 'Plot containment and support', 'แนวเขตที่ดิน', 'Geometry check', PLAN,
        'fail', 'scenario', 'The test requires a valid plot and at least one floor.')];
    }
    const ctx = prepare(scope, input, plot);
    const floors: NativeFloor[] = proposal.floors.map((floor) => ({
      ...floor, geometry: scope.read(mapArea(floor.geometry, ctx.frame.toLocal)),
    }));
    const planting = proposal.planting && scope.read(mapArea(proposal.planting, ctx.frame.toLocal));
    const audit = checkConcept(ctx, floors, planting, proposal.floors.map((floor) => floor.areaM2));
    return [...audit.checks, ...audit.siteEvidence];
  });
}
