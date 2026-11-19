import { prepare, worldGeometry } from './context';
import { generateDesign } from './design';
import { floorEnvelopes } from './envelope';
import type { NativeFloor } from './envelope';
import { withGeos } from './geos';
import { BANGKOK, FAR, NATIONAL, PLAN, PROFILES, rule } from './rules';
import { mapArea, normalizePlot } from './spatial';
import type { Concept, RuleResult, ScenarioInput, ScenarioResult } from './types';
import { checkConcept } from './validate';

const blank = (): ScenarioResult => ({
  validation: 'invalid', plotAreaM2: 0, coverageVerified: false, road: null,
  affectedBuildingIds: [], preservedBuildingParts: [], capacity: null, envelope: [], concepts: [], conceptMessages: {}, rules: [], elapsedMs: 0,
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
      const envelopeEvidence = 'scenario';
      const modelBool = (active?: boolean) => active ? 'Controls part of the displayed envelope.' : 'Does not reduce the displayed envelope.';
      result.rules = [
        rule('zone', '2013 residential zoning', 'ที่ดินประเภทที่อยู่อาศัยหนาแน่นมาก', '2013 plan §16 · ย.๙-๑๓', PLAN,
          'pass', 'documented', 'Scenario is inside the officially checked study area. This screens residential use under the active plan.'),
        rule('plot-basis', 'Drawn plot boundary', 'แนวเขตที่ดิน', 'Site evidence', PLAN,
          'review', 'scenario', 'Editable scenario polygon. Its edges, title, and easements require survey or title evidence.'),
        rule('road-basis', 'Road width and alignment', 'เขตทาง', 'BMA §5(4)', BANGKOK,
          ctx.road!.frontageM > 0 ? 'pass' : 'review', envelopeEvidence,
          `${ctx.road!.widthM.toFixed(2)} m total modeled width. ${ctx.road!.frontageM.toFixed(2)} m modeled plot contact. ${ctx.road!.inferred ? 'Road edges inferred from the mapped centerline.' : 'Edge lines supplied.'} Confirm public access and elevations.`),
        rule('national-front', 'National front building line', 'การร่นแนวอาคาร', 'MR55 §41', NATIONAL,
          'pass', envelopeEvidence, modelBool(restrictions?.nationalFront), restrictions?.nationalFront),
        rule('local-front', 'Bangkok front building line', 'การร่นแนวอาคาร', 'BMA §50', BANGKOK,
          'pass', envelopeEvidence, modelBool(restrictions?.localFront), restrictions?.localFront),
        rule('national-private', 'National private-boundary clearance', 'แนวเขตที่ดิน', 'MR55 §50', NATIONAL,
          'pass', envelopeEvidence, modelBool(restrictions?.nationalBoundary), restrictions?.nationalBoundary),
        rule('local-private', 'Bangkok private-boundary clearance', 'ช่องเปิดและริมระเบียง', 'BMA §54', BANGKOK,
          'pass', envelopeEvidence, modelBool(restrictions?.localBoundary), restrictions?.localBoundary),
        rule('perimeter-clearance', 'All-around clearance', 'ที่ว่างโดยรอบอาคาร', 'BMA §55', BANGKOK,
          'pass', envelopeEvidence, modelBool(restrictions?.clearance), restrictions?.clearance),
        rule('height-plane', 'Road-derived height plane', 'แนวเขตด้านตรงข้าม', 'MR55 §44 · BMA §49', NATIONAL,
          'pass', envelopeEvidence, modelBool(restrictions?.roadHeight), restrictions?.roadHeight),
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
      const stepped = scope.temporary(() => generateDesign(ctx, 'stepped', wide ?? undefined));
      if (wide) result.concepts.push(wide);
      else result.conceptMessages.wide = 'No connected lower form fits the clearance, minimum dimensions, and area budgets.';
      if (stepped) result.concepts.push(stepped);
      else result.conceptMessages.stepped = 'No distinct stepped form fits the upper slices, support depth, and area budgets.';
      return result;
    } catch (error) {
      result.message = error instanceof Error ? error.message : 'Could not calculate this scenario.';
      result.validation = 'invalid';
      result.capacity = null;
      result.envelope = [];
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
    return checkConcept(ctx, floors, planting, proposal.floors.map((floor) => floor.areaM2)).checks;
  });
}
