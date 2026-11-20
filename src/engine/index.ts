import { assessSite, prepare } from './context';
import { generateDesign } from './design';
import { describeEnvelope, floorEnvelopes } from './envelope';
import type { NativeFloor } from './envelope';
import { withGeos } from './geos';
import { BANGKOK, FAR, PLAN, PROFILES, rule } from './rules';
import { mapArea, normalizePlot } from './spatial';
import type { Concept, RuleResult, ScenarioInput, ScenarioResult } from './types';
import { checkConcept } from './validate';

const blank = (): ScenarioResult => ({
  validation: 'invalid', plotAreaM2: 0, coverageVerified: false, road: null,
  zoneEligibility: 'unavailable',
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
      const eligibility = assessSite(scope, input, plot);
      result.plotAreaM2 = eligibility.plotArea;
      result.coverageVerified = eligibility.screeningVerified;
      result.zoneEligibility = eligibility.zoneEligibility;
      if (eligibility.status !== 'eligible') {
        result.validation = eligibility.status;
        result.message = eligibility.message;
        return result;
      }
      const ctx = prepare(scope, input, plot, eligibility);
      result.plotAreaM2 = ctx.plotArea;
      result.road = ctx.road;
      result.affectedBuildingIds = ctx.affected.flatMap((building) => building.id ? [building.id] : []);
      result.preservedBuildingParts = ctx.preservedBuildingParts;
      if (ctx.conflictsWithRoad) {
        result.validation = 'road-conflict';
        result.message = `The fixed plot overlaps the modeled right-of-way by ${ctx.road!.conflictM2.toFixed(2)} m². Change the width or edit the parcel.`;
        return result;
      }
      if (ctx.unsupportedReason) {
        result.validation = 'unsupported-site';
        result.message = ctx.unsupportedReason;
        return result;
      }
      if (!ctx.alignmentVerified) {
        if (input.nearbyRoads !== undefined) result.validation = 'unsupported-site';
        result.message = 'The selected road segment does not span this entire plot. Select the relevant frontage segment.';
        return result;
      }
      if (!ctx.frontageMatched) {
        if (input.nearbyRoads !== undefined) result.validation = 'unsupported-site';
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
      if (model) {
        const described = describeEnvelope(ctx, model, categoryGfa, 'capacity');
        result.envelope = described.envelope;
        result.boundExplanation = described.explanation;
        result.rules = described.rules;
      }
      result.capacity = {
        regulatoryFar: FAR,
        regulatoryGfaCeilingM2: ctx.plotArea * FAR,
        geometricGfaUpperBoundM2: Math.max(0, maxArea),
        profileGfaLimitM2: profile.gfaLimit,
        profileHeightLimitM: profile.heightLimit,
        profileMaxFloors: profile.maxFloors,
        retainedGfaM2: ctx.retainedGfa,
      };
      result.siteEvidence = [
        rule('plot-basis', 'Drawn plot boundary', 'แนวเขตที่ดิน', 'Site evidence', '',
          'review', 'scenario', 'Editable scenario polygon. Its edges, title, and easements require survey or title evidence.'),
        rule('site-screening', 'Parcel-specific mapped screening', 'ข้อจำกัดเฉพาะพื้นที่', 'Site evidence', PLAN,
          'review', result.coverageVerified ? 'scenario' : 'unknown', result.coverageVerified
            ? input.screeningCoverage
              ? 'The supplied BMA overlay screening covers this parcel. The checked layers include land-use overlays and transportation corridors; some mapped restrictions concern specific uses. Other restrictions and title facts remain unverified.'
              : 'The previous study-area overlay screening applies here. Other restrictions and title facts remain unverified.'
            : 'This parcel is outside the earlier mapped overlay screening. Verify parcel-specific water, infrastructure, environmental, and other restrictions before relying on these calculations.'),
        rule('road-basis', 'Road width and alignment', 'เขตทาง', 'BMA §5(4)', input.road.sourceUrl ?? BANGKOK,
          'review', 'scenario',
          `${ctx.road!.widthM.toFixed(2)} m total modeled width. ${ctx.road!.frontageM.toFixed(2)} m modeled parcel contact. ${ctx.road!.inferred ? 'Road edges inferred from the mapped centerline.' : 'Edge lines supplied.'} Confirm legal frontage, public access and road/plot elevations.`),
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
      else result.conceptMessages.wide = 'The bounded search did not find a connected lower form passing all modeled checks. The geometric envelope remains nonempty; other forms may fit.';
      if (stepped.concept) result.concepts.push(stepped.concept);
      else result.conceptMessages.stepped = stepped.frontageFailures
        ? 'The bounded search found no second form passing all modeled checks. Some candidates need the unsupported §52(6) alternative frontage/internal access branch. Other forms may fit.'
        : 'The bounded search did not find a meaningfully different second design passing all modeled checks. Other forms may fit.';
      for (const concept of result.concepts) {
        const described = scope.temporary(() => describeEnvelope(ctx,
          floorEnvelopes(ctx, concept.floors.length, concept.gfaM2, true, concept.floors), concept.gfaM2, 'concept'));
        concept.envelope = described.envelope;
        concept.envelopeRules = described.rules;
        concept.envelopeExplanation = described.explanation;
      }
      return result;
    } catch (error) {
      result.message = error instanceof Error ? error.message : 'Could not calculate this scenario.';
      result.validation = input.nearbyRoads !== undefined && result.plotAreaM2 > 0 && result.zoneEligibility !== 'outside'
        ? 'unsupported-site' : 'invalid';
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
    const eligibility = assessSite(scope, input, plot);
    if (eligibility.status !== 'eligible') {
      return [rule('site-eligibility', 'Site eligibility', 'ขอบเขตพื้นที่', 'Model scope', PLAN,
        'fail', 'scenario', eligibility.message ?? 'This site requires further assessment before automatic validation.')];
    }
    const ctx = prepare(scope, input, plot, eligibility);
    const invalidGeometry = () => [
      rule('plot', 'Plot containment and support', 'แนวเขตที่ดิน', 'Independent geometry check', PLAN,
        'fail', 'scenario', 'A serialized floor or planting polygon is invalid in geographic or projected coordinates.'),
      rule('applicable-envelope', 'Containment in the applicable floor slices', 'ขอบเขตที่อนุญาต', 'Independent geometry check', '',
        'fail', 'scenario', 'Invalid serialized geometry cannot be assessed against the applicable slices.'),
    ];
    if (!proposal.floors.every((floor) => scope.valid(scope.read(floor.geometry)))
        || (proposal.planting && !scope.valid(scope.read(proposal.planting)))) return invalidGeometry();
    const floors: NativeFloor[] = proposal.floors.map((floor) => ({
      ...floor, geometry: scope.read(mapArea(floor.geometry, ctx.frame.toLocal)),
    }));
    const planting = proposal.planting && scope.read(mapArea(proposal.planting, ctx.frame.toLocal));
    if (!floors.every(({ geometry }) => scope.isPolygon(geometry) && scope.valid(geometry))
        || (planting && !scope.valid(planting))) return invalidGeometry();
    const audit = checkConcept(ctx, floors, planting, proposal.floors.map((floor) => floor.areaM2));
    const siteReason = ctx.conflictsWithRoad ? 'The scenario parcel overlaps the modeled right-of-way.'
      : ctx.unsupportedReason ?? (!ctx.alignmentVerified ? 'The selected alignment does not span the plot.'
        : !ctx.frontageMatched ? 'The selected road does not match the parcel frontage.' : undefined);
    return [
      ...(siteReason ? [rule('site-eligibility', 'Site eligibility', 'ขอบเขตพื้นที่', 'Model scope', PLAN,
        'fail', 'scenario', siteReason)] : []),
      ...audit.checks, ...audit.siteEvidence,
    ];
  });
}
