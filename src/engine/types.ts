import type { LineString, MultiPolygon, Polygon } from 'geojson';

export type AreaGeometry = Polygon | MultiPolygon;
export type ProfileId = 'house' | 'multifamily';
export type Strategy = 'wide' | 'stepped';
export type WidthSource = 'district-inventory' | 'user-override' | 'unverified';

export interface ScenarioRoad {
  name: string;
  centerline: LineString;
  widthM: number;
  widthSource: WidthSource;
  baselineWidthM?: number;
  sourceUrl?: string;
  /** Surveyed edges, when known, take the place of the inferred parallel edges. */
  surveyedEdges?: { near: LineString; far: LineString };
  publicStatus?: 'documented' | 'assumed' | 'unknown';
}

export interface ScenarioInput {
  plot: Polygon;
  profile: ProfileId;
  road: ScenarioRoad;
  redevelopment: 'clear' | 'retain';
  frontageEdgeIndex?: number;
  retainedBuildings?: {
    id?: string;
    footprint: AreaGeometry;
    grossFloorAreaM2?: number;
    eligibleGrossFloorAreaM2?: number;
  }[];
}

export interface RuleResult {
  id: string;
  label: string;
  thai?: string;
  clause: string;
  sourceUrl: string;
  status: 'pass' | 'fail' | 'review' | 'not-applicable';
  evidence: 'documented' | 'scenario' | 'unknown';
  detail: string;
  controls?: boolean;
  measurement?: { actualM: number; requiredM: number; toleranceM: number };
}

export interface FloorPlate {
  floor: number;
  baseM: number;
  topM: number;
  areaM2: number;
  geometry: AreaGeometry;
}

export interface Concept {
  id: Strategy;
  name: string;
  floors: FloorPlate[];
  heightM: number;
  gfaM2: number;
  coveredM2: number;
  openM2: number;
  perviousM2: number;
  planting: AreaGeometry | null;
  checks: RuleResult[];
  siteEvidence: RuleResult[];
  rationale: string;
  tradeOff: string;
  limitingFactors: string[];
}

export interface BoundExplanation {
  heightM: number;
  classification: string[];
  floorCount: number;
  floors: { floor: number; baseM: number; topM: number; areaM2: number }[];
  sumM2: number;
  included: string[];
  excluded: string[];
  reason: string;
}

export interface SearchSummary {
  evaluated: number;
  independentlyChecked: number;
  validated: number;
  bestValidatedGfaM2: number | null;
  minimumPlateM2: number;
  minimumCoreWidthM: number;
}

export interface ScenarioResult {
  validation: 'valid' | 'invalid' | 'outside-coverage' | 'road-conflict';
  message?: string;
  plotAreaM2: number;
  coverageVerified: boolean;
  affectedBuildingIds: string[];
  preservedBuildingParts: { id: string; geometry: AreaGeometry }[];
  road: {
    centerline: LineString;
    nearEdge: LineString;
    farEdge: LineString;
    widthM: number;
    inferred: boolean;
    frontageM: number;
    conflictM2: number;
  } | null;
  capacity: {
    regulatoryFar: number;
    regulatoryGfaCeilingM2: number;
    geometricGfaUpperBoundM2: number;
    profileGfaLimitM2: number | null;
    profileHeightLimitM: number;
    profileMaxFloors: number;
    retainedGfaM2: number | null;
  } | null;
  envelope: FloorPlate[];
  boundExplanation: BoundExplanation | null;
  search: SearchSummary | null;
  siteEvidence: RuleResult[];
  concepts: Concept[];
  conceptMessages: Partial<Record<Strategy, string>>;
  rules: RuleResult[];
  elapsedMs: number;
}

export interface CalculateRequest {
  id: number;
  input: ScenarioInput;
}

export type CalculateResponse =
  | { id: number; result: ScenarioResult }
  | { id: number; error: string };

export const STUDY_BBOX = [100.562, 13.7825, 100.569, 13.787] as const;
