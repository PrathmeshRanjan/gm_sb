import type { ProfileId, RuleResult } from './types';

export const PLAN = 'https://download.asa.or.th/03media/04law/cpa/mr56-bma.pdf#page=35';
export const NATIONAL = 'https://webportal.bangkok.go.th/public/user_files_editor/426/mr43-55-upd68.pdf';
export const BANGKOK = 'https://webportal.bangkok.go.th/public/user_files_editor/76/law/y07.pdf';
export const BUILDING_ACT = 'https://gov.bangkok.go.th/LegalDetail?id=dc747543-747e-4b37-a237-de16e38b9f32';
export const ACCESSIBILITY = 'https://webportal.bangkok.go.th/user_files/262/125472781168cd2119038fc4.27828110.pdf';
export const ENVIRONMENT = 'https://www.onep.go.th/wp-content/uploads/2024/11/eiathailand2567.pdf';
export const FAR = 7;
export const OSR = 0.045;
export const PLANTING = 0.5;
export const AREA_TOLERANCE = 0.025;
export const ROAD_ALIGNMENT_TOLERANCE = 0.015;
export const DISTANCE_TOLERANCE = 1e-5;
export const BUDGET_TOLERANCE = 1e-6;
export const GEOMETRY_AREA_TOLERANCE = 1e-5;
export const DESIGN_CLEARANCE_RESERVE_M = 0.002;

export const PROFILES = {
  house: { gfaLimit: null, maxFloors: 2, heightLimit: 8, floorHeight: 3.2, minArea: 27, minDepth: 4 },
  multifamily: { gfaLimit: 1000, maxFloors: 6, heightLimit: 23, floorHeight: 3.2, minArea: 48, minDepth: 5 },
} as const;

export function classify(heightM: number, gfaM2: number, structuralSpanM?: number) {
  return {
    high: heightM >= 23,
    large: gfaM2 > 2000 || (heightM >= 15 && gfaM2 > 1000),
    extraLarge: gfaM2 >= 10_000,
    specialByHeight: heightM > 15,
    specialByKnownSpan: structuralSpanM !== undefined && structuralSpanM > 10,
  };
}

export function clearance(profile: ProfileId, heightM: number, gfaM2: number) {
  if (heightM > 15) return 2;
  return profile === 'house' && gfaM2 <= 300 ? 0 : 1;
}

export function boundaryDistances(totalHeightM: number, floor: number, floorTopM: number) {
  return {
    national: totalHeightM > 9 ? 3 : 2,
    local: floor >= 3 || floorTopM > 9 ? 3 : 2,
  };
}

export type RoadLimit = { reference: 'near-edge' | 'centerline'; distance: number } | null;

export function frontLimits(widthM: number, floors: number, heightM: number, gfaM2: number) {
  const general: RoadLimit = widthM < 6 ? { reference: 'centerline', distance: 3 } : null;
  const taller: RoadLimit = widthM < 10
    ? { reference: 'centerline', distance: 6 }
    : { reference: 'near-edge', distance: widthM <= 20 ? widthM / 10 : 2 };
  const nationalTrigger = floors > 2 || heightM > 8;
  const localExemption = (floors <= 3 || heightM <= 10) && gfaM2 <= 1000;
  const localTrigger = (nationalTrigger || classify(heightM, gfaM2).large) && !localExemption;
  return { national: nationalTrigger ? taller : general, local: localTrigger ? taller : general, localExemption };
}

export function rule(
  id: string,
  label: string,
  thai: string,
  clause: string,
  sourceUrl: string,
  status: RuleResult['status'],
  evidence: RuleResult['evidence'],
  detail: string,
  controls = false,
): RuleResult {
  return { id, label, thai, clause, sourceUrl, status, evidence, detail, controls };
}
