import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownRight, ArrowRight, ArrowUpRight, BookOpen, Building2, Check, ChevronDown,
  CircleAlert, ExternalLink, House, Layers3, MapPin, PencilLine, RotateCcw, Ruler, ScanLine, X,
} from 'lucide-react';
import type { Polygon } from 'geojson';
import AnalysisMap, { type MapMode } from './AnalysisMap';
import { loadContext, namedRoadLocations, nearbyBuildings, roadsForPlot, type ContextData } from './context';
import type {
  CalculateRequest, CalculateResponse, Concept, FloorPlate, ProfileId, RuleResult, ScenarioInput, ScenarioResult, Strategy,
} from './engine/types';

const plan = 'https://download.asa.or.th/03media/04law/cpa/mr56-bma.pdf#page=35';
const local = 'https://webportal.bangkok.go.th/public/user_files_editor/76/law/y07.pdf';
const national = 'https://webportal.bangkok.go.th/public/user_files_editor/426/mr43-55-upd68.pdf';
const format = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const twoPlaces = new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sqm = (n: number) => `${format.format(n)} m²`;
const areaCents = (area: number) => Math.round(area * 100);
const sqmCents = (cents: number) => `${twoPlaces.format(cents / 100)} m²`;
const sqmExactDisplay = (area: number) => sqmCents(areaCents(area));
const noIds: string[] = [];

interface PendingCalculation extends CalculateRequest {
  run: number;
  sentAt: number;
}

interface SettledCalculation {
  request: PendingCalculation;
  result: ScenarioResult | null;
  roundtrip: number;
  error?: string;
}

function useAnalysis(input: ScenarioInput | null) {
  const worker = useRef<Worker | null>(null);
  const revision = useRef(0);
  const outstanding = useRef<PendingCalculation | null>(null);
  const [run, setRun] = useState(0);
  const [settlement, setSettlement] = useState<SettledCalculation | null>(null);
  const [workerError, setWorkerError] = useState('');

  useEffect(() => {
    setWorkerError('');
    let instance: Worker;
    try {
      instance = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      setWorkerError('This browser could not start the geometry worker. Restart analysis to try again.');
      return;
    }
    worker.current = instance;
    instance.onmessage = ({ data }: MessageEvent<CalculateResponse>) => {
      const request = outstanding.current;
      if (worker.current !== instance || request?.id !== data.id) return;
      outstanding.current = null;
      const roundtrip = performance.now() - request.sentAt;
      if ('error' in data) {
        setSettlement({ request, result: null, error: data.error, roundtrip });
      } else {
        setSettlement({ request, result: data.result, roundtrip });
      }
    };
    function stop(message: string) {
      if (worker.current !== instance) return;
      worker.current = null;
      outstanding.current = null;
      instance.terminate();
      setWorkerError(message);
    }
    instance.onerror = (event) => {
      event.preventDefault();
      stop('The geometry worker stopped. Restart analysis to try again.');
    };
    instance.onmessageerror = () => {
      stop('The browser could not read the geometry result. Restart analysis to try again.');
    };
    return () => {
      instance.terminate();
      worker.current = null;
      outstanding.current = null;
    };
  }, [run]);

  useEffect(() => {
    outstanding.current = null;
    if (!worker.current || !input) return;
    const task = window.setTimeout(() => {
      const instance = worker.current;
      if (!instance) return;
      const id = ++revision.current;
      const request = { id, input, run, sentAt: performance.now() };
      outstanding.current = request;
      try {
        instance.postMessage({ id, input } satisfies CalculateRequest);
      } catch {
        outstanding.current = null;
        setSettlement({ request, result: null, error: 'The scenario could not be sent to the geometry worker.', roundtrip: 0 });
      }
    }, 55);
    return () => {
      window.clearTimeout(task);
      outstanding.current = null;
    };
  }, [input, run]);

  const current = !workerError && settlement?.request.input === input && settlement.request.run === run ? settlement : null;
  return {
    result: current?.result ?? null,
    pending: input !== null && current === null && !workerError,
    error: workerError || current?.error || '',
    roundtrip: current?.roundtrip ?? 0,
    requestId: current?.result ? current.request.id : undefined,
    resultWidth: current?.result && current.request.input.roadSelectionAvailable !== false ? current.request.input.road.widthM : undefined,
    restart: () => setRun((value) => value + 1),
  };
}

function Source({ href, children }: { href: string; children: React.ReactNode }) {
  return <a className="source-link" href={href} target="_blank" rel="noreferrer">{children}<ArrowUpRight size={13} /></a>;
}

type RuleGroup = 'envelope' | 'design' | 'evidence';

function Rules({ rules, group, emptyText }: { rules: RuleResult[]; group: RuleGroup; emptyText: string }) {
  if (!rules.length) return <p className="empty-text">{emptyText}</p>;
  const states = { pass: 'Pass', fail: 'Fail', review: 'Review', 'not-applicable': 'Not applicable' };
  const evidence = { documented: 'Documented', scenario: 'Scenario', unknown: 'Unverified' };
  function outcome(rule: RuleResult) {
    if (group === 'envelope' && rule.status === 'pass') {
      return rule.controls ? { label: 'Constrains', style: 'constrains' } : { label: 'Nonbinding', style: 'nonbinding' };
    }
    if (group === 'envelope' && rule.status === 'not-applicable') return { label: 'Not applied', style: 'not-applicable' };
    return { label: states[rule.status], style: rule.status };
  }

  return <div className="rule-list">
    {rules.map((rule) => {
      const { label, style } = outcome(rule);
      return (
        <details className="rule-row" key={rule.id}>
          <summary>
            <span className="rule-name">{rule.label}</span>
            <span className={`rule-status ${style}`}>{label}</span>
            <span className="evidence-summary" title="Evidence status">{evidence[rule.evidence]}</span>
            <ChevronDown size={14} className="rule-chevron" />
          </summary>
          <div className="rule-detail">
            <p>{rule.detail}</p>
            {rule.measurement && <dl className="rule-measurement" data-testid={`measurement-${rule.id}`}>
              <div><dt>Measured clearance</dt><dd>{rule.measurement.actualM.toFixed(4)} m</dd></div>
              <div><dt>Required clearance</dt><dd>{rule.measurement.requiredM.toFixed(4)} m</dd></div>
              <div><dt>Margin</dt><dd>{(rule.measurement.actualM - rule.measurement.requiredM).toFixed(4)} m</dd></div>
              <div><dt>Verifier tolerance</dt><dd>{rule.measurement.toleranceM.toFixed(5)} m</dd></div>
            </dl>}
            {rule.thai && <p className="thai-term" lang="th">{rule.thai}</p>}
            <div className="rule-meta">
              {rule.sourceUrl && <Source href={rule.sourceUrl}>{rule.clause || 'Source'}</Source>}
            </div>
          </div>
        </details>
      );
    })}
  </div>;
}

function FloorSchedule({ floors, total, kind }: {
  floors: Pick<FloorPlate, 'floor' | 'topM' | 'areaM2'>[];
  total: number;
  kind: 'envelope' | 'design';
}) {
  const totalCents = areaCents(total);
  const rowsCents = floors.reduce((sum, floor) => sum + areaCents(floor.areaM2), 0);
  const difference = rowsCents - totalCents;
  return <>
    <table className="floor-schedule" aria-label={kind === 'envelope' ? 'Permissible envelope slices' : 'Actual design floor areas'}>
      <thead><tr><th scope="col">Floor</th><th scope="col">Top elevation</th><th scope="col">{kind === 'envelope' ? 'Permissible slice' : 'Plate area'}</th></tr></thead>
      <tbody>
        {floors.map((floor) => <tr key={floor.floor}><th scope="row">{floor.floor}</th><td>{twoPlaces.format(floor.topM)} m</td><td>{sqmExactDisplay(floor.areaM2)}</td></tr>)}
      </tbody>
      <tfoot><tr><th colSpan={2} scope="row">{kind === 'envelope' ? 'Slice-area sum' : 'Total design GFA'}</th><td>{sqmCents(totalCents)}</td></tr></tfoot>
    </table>
    <p className="fine-print rounding-note" data-testid={`${kind}-rounding-note`}>
      The total uses full-precision polygon areas. Each displayed value is rounded to two decimal places.
      {difference !== 0 && ` The displayed rows sum to ${sqmCents(rowsCents)}, ${sqmCents(Math.abs(difference))} ${difference > 0 ? 'more' : 'less'} than the displayed total.`}
    </p>
  </>;
}

function DesignSchedule({ concept }: { concept: Concept }) {
  return <details className="inspection-details" data-testid="design-floor-schedule">
    <summary><span>Floor-area schedule</span><span className="inspection-value">{sqmExactDisplay(concept.gfaM2)}</span><ChevronDown size={15} /></summary>
    <div className="inspection-body"><FloorSchedule floors={concept.floors} total={concept.gfaM2} kind="design" /></div>
  </details>;
}

function BoundExplanation({ bound, selected, onViewBound }: {
  bound: ScenarioResult['boundExplanation']; selected?: boolean; onViewBound: () => void;
}) {
  if (!bound) return null;
  return <details className="inspection-details" data-testid={selected ? 'selected-envelope-explanation' : 'bound-explanation'}>
    <summary><span>{selected ? 'Inspect selected envelope' : 'Inspect geometric bound'}</span><span className="inspection-value">{sqmExactDisplay(bound.sumM2)}</span><ChevronDown size={15} /></summary>
    <div className="inspection-body">
      <dl className="bound-candidate">
        <div><dt>{selected ? 'Selected design' : 'Capacity candidate'}</dt><dd>{bound.floorCount} {bound.floorCount === 1 ? 'floor' : 'floors'} · {twoPlaces.format(bound.heightM)} m</dd></div>
        <div><dt>Building classification</dt><dd>{bound.classification.join(' · ')}</dd></div>
      </dl>
      <FloorSchedule floors={bound.floors} total={bound.sumM2} kind="envelope" />
      <div className="bound-constraints">
        <div><h3>Included in the slices</h3><ul>{bound.included.map((item) => <li key={item}>{item}</li>)}</ul></div>
        <div><h3>Excluded from the slice sum</h3><ul>{bound.excluded.map((item) => <li key={item}>{item}</li>)}</ul></div>
      </div>
      <p className="fine-print">{bound.reason}</p>
      <button type="button" className="text-button bound-view" data-testid={selected ? 'show-selected-envelope' : 'show-envelope-bound'} onClick={onViewBound}><Layers3 size={15} /> {selected ? 'Show selected envelope in 3D' : 'Show capacity bound in 3D'}</button>
    </div>
  </details>;
}

function Capacity({ result, concept }: { result: ScenarioResult | null; concept: Concept | null }) {
  const capacity = result?.capacity;
  const heightLimit = capacity?.profileHeightLimitM === 23
    ? 'below 23 m'
    : `up to ${format.format(capacity?.profileHeightLimitM ?? 0)} m`;
  return <dl className="capacity-table">
    <div><dt><span className="budget-dot legal" /> Regulatory FAR ceiling <small>Base FAR {capacity?.regulatoryFar ?? '7'}:1 × eligible site</small></dt><dd>{capacity ? sqmExactDisplay(capacity.regulatoryGfaCeilingM2) : '—'}</dd></div>
    <div><dt><span className="budget-dot geometric" /> Geometric upper bound <small>Sum of permissible floor slices</small></dt><dd>{capacity ? sqmExactDisplay(capacity.geometricGfaUpperBoundM2) : '—'}</dd></div>
    <div><dt><span className="budget-dot profile" /> Application profile limits <small>{capacity ? `${capacity.profileMaxFloors} floors · ${heightLimit}` : 'Supported scope'}</small></dt><dd>{capacity?.profileGfaLimitM2 != null ? sqmExactDisplay(capacity.profileGfaLimitM2) : '—'}</dd></div>
    <div><dt><span className="budget-dot design" /> Achieved design GFA <small>Sum of generated occupied plates</small></dt><dd>{concept ? sqmExactDisplay(concept.gfaM2) : '—'}</dd></div>
  </dl>;
}

function ConceptCard({ strategy, concept, message, active, onSelect }: {
  strategy: Strategy;
  concept?: Concept;
  message?: string;
  active: boolean;
  onSelect: () => void;
}) {
  const wide = strategy === 'wide';
  return <button
    type="button"
    data-testid={`concept-${strategy}`}
    className={`concept-card ${active ? 'selected' : ''}`}
    aria-pressed={active}
    disabled={!concept}
    onClick={onSelect}
  >
    <span className={`concept-icon ${wide ? 'wide' : 'stepped'}`}>{wide ? <Building2 size={20} /> : <Layers3 size={20} />}</span>
    <span className="concept-main">
      <strong>{wide ? 'Wider / lower' : concept?.name === 'Compact garden form' ? 'Narrower / garden' : 'Narrower / stepped'}</strong>
      {concept
        ? <span>{concept.floors.length} {concept.floors.length === 1 ? 'floor' : 'floors'} · {format.format(concept.heightM)} m</span>
        : <span>{message || 'Awaiting a feasible envelope'}</span>}
    </span>
    {concept && <span className="concept-area">{sqmExactDisplay(concept.gfaM2)}</span>}
    {concept && (active ? <Check className="selected-check" size={16} /> : <ArrowRight size={14} />)}
  </button>;
}

function Sources({ context, dialog }: { context: ContextData; dialog: React.RefObject<HTMLDialogElement | null> }) {
  return <dialog ref={dialog} className="sources-dialog">
    <div className="dialog-top">
      <div><div className="eyebrow"><BookOpen size={16} /> Evidence</div><h2>Sources and scope</h2></div>
      <form method="dialog"><button className="icon-button" aria-label="Close sources"><X size={20} /></button></form>
    </div>
    <div className="dialog-body">
      <section>
        <h3>Planning rules</h3>
        <p>The 2013 plan governs the study area. Each calculated rule links to the underlying clause. The 2026 public-inspection draft has a separate status.</p>
        <div className="source-links">
          <Source href={plan}>2013 plan §16</Source>
          <Source href={national}>Ministerial Regulation No. 55</Source>
          <Source href={local}>BMA Building Control Ordinance</Source>
          <Source href="https://plan4bangkok.com/process/">2026 public-inspection materials</Source>
        </div>
      </section>
      <section>
        <h3>Neighborhood data</h3>
        <p>{context.site.zoneBoundary ? 'The green outline is the published ย.๙-๑๓ zoning boundary.' : 'The dashed outline marks the original verified study area within ย.๙-๑๓; the full zone geometry is unavailable.'} The scenario parcel is editable. Road edges are inferred from the chosen centerline and width. Zoning membership, available neighborhood data and parcel-specific screening each have their own status.</p>
        <div className="source-links">
          <Source href={context.site.road.sourceUrl}>District road inventory</Source>
          <Source href={context.site.zone?.sourceUrl ?? 'https://data.go.th/en/dataset/lup_polygon'}>BMA land-use geometry</Source>
          {context.site.zone?.catalogUrl && <Source href={context.site.zone.catalogUrl}>Government data catalogue</Source>}
          {context.site.zone?.licenseUrl && <Source href={context.site.zone.licenseUrl}>Reuse basis</Source>}
          {context.site.zone?.boundaryDescriptionUrl && <Source href={context.site.zone.boundaryDescriptionUrl}>Statutory boundary description</Source>}
          <Source href={`${import.meta.env.BASE_URL}data/manifest.json`}>Data provenance and screening coverage</Source>
          <Source href="https://www.openstreetmap.org/copyright">OpenStreetMap roads</Source>
          <Source href="https://stac.overturemaps.org/2026-11-18.0/buildings/building/collection.json">Overture building collection</Source>
        </div>
      </section>
    </div>
  </dialog>;
}

function Workspace({ context }: { context: ContextData }) {
  const { site } = context;
  const baselineRoad = site.road;
  const [plot, setPlot] = useState(site.parcel);
  const [profile, setProfile] = useState<ProfileId>('multifamily');
  const [roadId, setRoadId] = useState(String(baselineRoad.wayId));
  const [widthOverride, setWidthOverride] = useState<string | null>(null);
  const [widthRoadId, setWidthRoadId] = useState(String(baselineRoad.wayId));
  const [edge, setEdge] = useState<number>();
  const [mode, setMode] = useState<MapMode>('3d');
  const drawing = mode === 'draw';
  const [redevelopment, setRedevelopment] = useState<'clear' | 'retain'>('clear');
  const [retainedAmounts, setRetainedAmounts] = useState<Record<string, string>>({});
  const [footprintsOnly, setFootprintsOnly] = useState(false);
  const [envelopeVisible, setEnvelopeVisible] = useState(true);
  const [conceptVisible, setConceptVisible] = useState(true);
  const [envelopeKind, setEnvelopeKind] = useState<'selected' | 'capacity'>('selected');
  const [cameraTarget, setCameraTarget] = useState<{ center: [number, number]; zoom: number; bearing?: number; pitch?: number }>();
  const [locationKey, setLocationKey] = useState('');
  const [selected, setSelected] = useState<Strategy>('wide');
  const [tab, setTab] = useState<'scenario' | 'rules'>('scenario');
  const dialog = useRef<HTMLDialogElement>(null);
  const sidebarContent = useRef<HTMLDivElement>(null);
  const designSection = useRef<HTMLElement>(null);
  const jumpToDesign = useRef(false);
  const roadOptions = useMemo(() => roadsForPlot(plot, context), [plot, context]);
  const roadLocations = useMemo(() => namedRoadLocations(context.roads), [context.roads]);
  const road = roadOptions.find((option) => option.key === roadId) ?? roadOptions[0];
  const currentWidthOverride = road?.key === widthRoadId ? widthOverride : null;
  const widthText = currentWidthOverride ?? (road?.width != null ? road.width.toFixed(2) : '');
  const widthM = Number(widthText);
  const validWidth = widthText.trim() !== '' && Number.isFinite(widthM) && widthM >= 2 && widthM <= 100;

  const input = useMemo<ScenarioInput | null>(() => {
    if (drawing) return null;
    return {
      plot,
      profile,
      frontageEdgeIndex: road?.key === roadId ? edge : undefined,
      redevelopment,
      zoneBoundary: site.zoneBoundary ?? null,
      contextCoverage: site.coverage,
      screeningCoverage: site.screeningCoverage ?? site.coverage,
      screeningAreas: site.screeningAreas,
      roadSelectionAvailable: road !== undefined && validWidth,
      nearbyRoads: roadOptions.map((option) => ({
        id: String(option.wayId), name: option.name, centerline: option.mappedCenterline, widthM: option.width ?? undefined, roadClass: option.roadClass,
      })),
      retainedBuildings: nearbyBuildings(plot, context.buildings).map((building) => {
        const entered = retainedAmounts[building.id];
        const eligibleGrossFloorAreaM2 = entered ? Number(entered) : undefined;
        return { ...building, eligibleGrossFloorAreaM2: eligibleGrossFloorAreaM2 && eligibleGrossFloorAreaM2 > 0 ? eligibleGrossFloorAreaM2 : undefined };
      }),
      road: {
        id: road ? String(road.wayId) : undefined,
        sameRoadIds: road?.sameRoadIds,
        roadClass: road?.roadClass,
        access: road?.access,
        vehicle: road?.vehicle,
        motorVehicle: road?.motorVehicle,
        bridge: road?.bridge,
        tunnel: road?.tunnel,
        layer: road?.layer,
        name: road?.name ?? 'Road selection unavailable',
        widthM: validWidth ? widthM : (baselineRoad.width ?? 2),
        widthSource: !validWidth ? 'unverified' : currentWidthOverride === null ? 'district-inventory' : 'user-override',
        baselineWidthM: road?.width ?? undefined,
        sourceUrl: road?.sourceUrl,
        centerline: road?.centerline ?? baselineRoad.centerline,
        publicStatus: road?.wayId === baselineRoad.wayId ? 'documented' : 'unknown',
      },
    };
  }, [baselineRoad, context.buildings, currentWidthOverride, drawing, edge, plot, profile, redevelopment, retainedAmounts, road, roadId, roadOptions, site, validWidth, widthM]);

  const { result, pending, error, roundtrip, requestId, resultWidth, restart } = useAnalysis(input);
  const concept = result?.concepts.find(({ id }) => id === selected) ?? result?.concepts[0] ?? null;
  const mapEnvelopeKind = concept && envelopeKind === 'selected' ? 'selected' : 'capacity';
  const mapEnvelope = mapEnvelopeKind === 'selected' ? concept?.envelope ?? [] : result?.envelope ?? [];
  const siteEvidence = [...(result?.siteEvidence ?? []), ...(concept?.siteEvidence ?? [])];
  const affectedIds = result?.affectedBuildingIds ?? noIds;
  const open = concept && result?.plotAreaM2 ? (concept.openM2 / result.plotAreaM2) * 100 : null;
  const editing = mode === 'vertices' || mode === 'draw';
  const resultProvenance = { 'data-request-id': requestId, 'data-result-width': resultWidth };
  const search = result?.search;
  const eligibilityText = result?.zoneEligibility === 'inside' ? 'Inside ย.๙-๑๓'
    : result?.zoneEligibility === 'outside' ? 'Outside ย.๙-๑๓'
      : result?.zoneEligibility === 'study-area-only' ? 'Inside the verified study area'
        : result?.zoneEligibility === 'unavailable' ? 'Zone eligibility unavailable'
          : pending ? 'Checking zone membership…' : 'Awaiting a parcel';
  const siteStatusText = result?.validation === 'valid' ? 'Supported conditions modeled'
    : result?.validation === 'outside-zone' ? 'Outside the chosen zone'
      : result?.validation === 'unsupported-site' ? 'Site conditions require review'
        : result?.validation === 'data-unavailable' || result?.validation === 'outside-coverage' ? 'Site data unavailable'
          : result?.validation === 'road-conflict' ? 'Road right-of-way conflict'
            : result?.validation === 'invalid' ? 'Invalid plot or inputs' : pending ? 'Checking inputs…' : 'Waiting for inputs';

  useEffect(() => {
    if (tab === 'rules' && jumpToDesign.current) {
      designSection.current?.scrollIntoView({ block: 'start' });
      designSection.current?.focus({ preventScroll: true });
    } else {
      sidebarContent.current?.scrollTo({ top: 0 });
    }
    jumpToDesign.current = false;
  }, [tab]);

  function inspectDesign() {
    jumpToDesign.current = true;
    setTab('rules');
  }

  function showBound() {
    setEnvelopeKind('capacity');
    setEnvelopeVisible(true);
    setConceptVisible(false);
    setMode('3d');
  }

  function showSelectedEnvelope() {
    setEnvelopeKind('selected');
    setEnvelopeVisible(true);
    setConceptVisible(false);
    setMode('3d');
  }

  function changeRoad(key: string) {
    setRoadId(key);
    setWidthRoadId(key);
    setWidthOverride(null);
    setEdge(undefined);
  }

  function overrideWidth(value: string | null) {
    if (!road) return;
    if (road.key !== roadId) setRoadId(road.key);
    setWidthRoadId(road.key);
    setWidthOverride(value);
  }

  function changePlot(next: Polygon) {
    if (next.coordinates[0].length !== plot.coordinates[0].length || mode === 'draw') setEdge(undefined);
    if (mode === 'draw') {
      setRetainedAmounts({});
      setWidthOverride(null);
      setEnvelopeKind('selected');
      setConceptVisible(true);
      setLocationKey('');
      // A new drawing may be in another neighborhood. Auto-select its nearest mapped road.
      const nearest = roadsForPlot(next, context)[0];
      changeRoad(nearest?.key ?? '');
    }
    setPlot(next);
  }

  function reset() {
    setPlot(site.parcel);
    setProfile('multifamily');
    setRoadId(String(baselineRoad.wayId));
    setWidthRoadId(String(baselineRoad.wayId));
    setWidthOverride(null);
    setEdge(undefined);
    setMode('3d');
    setRedevelopment('clear');
    setRetainedAmounts({});
    setSelected('wide');
    setFootprintsOnly(false);
    setEnvelopeVisible(true);
    setConceptVisible(true);
    setEnvelopeKind('selected');
    setLocationKey('');
    setCameraTarget({ ...site.camera });
  }

  function goToRoad(key: string) {
    setLocationKey(key);
    const example = site.examples?.find((item) => `example:${item.id}` === key);
    if (example) {
      setMode('plan');
      setCameraTarget({ center: example.camera.center, zoom: example.camera.zoom, bearing: 0, pitch: 0 });
      return;
    }
    const target = roadLocations.find((location) => location.key === key);
    if (!target) return;
    setMode('plan');
    setCameraTarget({ center: target.center, zoom: 17.8, bearing: 0, pitch: 0 });
  }

  const locationExample = site.examples?.find((item) => `example:${item.id}` === locationKey);

  function loadExample() {
    if (!locationExample) return;
    const key = String(locationExample.roadId);
    const exampleRoad = roadsForPlot(locationExample.parcel, context).find((option) => option.key === key || String(option.wayId) === key);
    setPlot(locationExample.parcel);
    setProfile(locationExample.profile);
    changeRoad(exampleRoad?.key ?? key);
    setWidthOverride(String(locationExample.widthM));
    setRetainedAmounts({});
    setRedevelopment('clear');
    setSelected('wide');
    setEnvelopeKind('selected');
    setConceptVisible(true);
    setMode('plan');
    setCameraTarget({ center: locationExample.camera.center, zoom: locationExample.camera.zoom, bearing: 0, pitch: 0 });
    setLocationKey('');
  }

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><span className="brand-icon"><Layers3 size={21} strokeWidth={1.8} /></span><span>Bangkok <b>Site Study</b></span></div>
      <div className="header-location"><MapPin size={16} /> Din Daeng, Bangkok <span>ย.๙-๑๓</span></div>
      <button className="header-source" type="button" onClick={() => dialog.current?.showModal()}><BookOpen size={16} /> Sources</button>
    </header>

    <main className="workspace">
      <div className="map-column">
        <AnalysisMap
          context={context}
          plot={plot}
          mode={mode}
          onMode={setMode}
          onPlot={changePlot}
          result={result}
          requestId={requestId}
          resultWidth={resultWidth}
          concept={conceptVisible ? concept : null}
          envelope={mapEnvelope}
          envelopeKind={mapEnvelopeKind}
          centerline={road?.centerline}
          roadName={road?.name}
          roadId={road?.key}
          nearbyRoadCount={roadOptions.length}
          cameraTarget={cameraTarget}
          frontageEdgeIndex={edge}
          footprintsOnly={footprintsOnly}
          envelopeVisible={envelopeVisible}
          clearedIds={redevelopment === 'clear' ? affectedIds : noIds}
        />
        <div className="map-footer">
          <span><ScanLine size={14} /> Editable scenario boundary <span className="desktop-source">· Surveyed title boundary unavailable</span></span>
          <div className="map-footer-options">
            <label><input type="checkbox" data-testid="footprints-toggle" checked={footprintsOnly} onChange={(event) => setFootprintsOnly(event.target.checked)} /> Footprints only</label>
            <label><input type="checkbox" checked={envelopeVisible} onChange={(event) => setEnvelopeVisible(event.target.checked)} /> {envelopeKind === 'capacity' ? 'Capacity bound' : 'Envelope'}</label>
            <label title="Hide the design to see the full 3D floor envelope."><input type="checkbox" checked={conceptVisible} onChange={(event) => { setConceptVisible(event.target.checked); if (event.target.checked) setEnvelopeKind('selected'); }} /> Design</label>
          </div>
        </div>
      </div>

      <aside className="sidebar" aria-label="Scenario analysis">
        <div className="sidebar-intro">
          <div className="eyebrow"><span className="location-dot" /> {site.zoneBoundary ? 'DIN DAENG · ย.๙-๑๓' : 'INTHAMARA STUDY AREA'}</div>
          <div className="sidebar-heading"><h1>{road?.name === 'Pracha Suk Road' ? 'Pracha Suk' : road?.name ?? 'New parcel'}</h1><button type="button" className="icon-button reset-button" data-testid="reset-scenario" onClick={reset} title="Reset scenario" aria-label="Reset scenario"><RotateCcw size={18} /></button></div>
          <p className="site-meta">Residential feasibility · 2013 Bangkok plan</p>
          <div className="site-eligibility" data-testid="site-eligibility" data-zone={result?.zoneEligibility} data-state={result?.validation} {...resultProvenance}>
            <span className={result?.zoneEligibility === 'inside' || result?.zoneEligibility === 'study-area-only' ? 'eligible' : 'conditional'}>{eligibilityText}</span>
            <span>{siteStatusText}</span>
          </div>
          <div className="top-metrics" data-testid="scenario-metrics" {...resultProvenance}>
            <div><span>Scenario parcel</span><strong>{result?.plotAreaM2 != null ? format.format(result.plotAreaM2) : '—'} <small>m²</small></strong></div>
            <div><span>Design GFA</span><strong>{concept ? format.format(concept.gfaM2) : '—'} <small>m²</small></strong></div>
            <div><span>Site open area</span><strong>{open != null ? format.format(open) : '—'} <small>%</small></strong></div>
          </div>
        </div>

        <div className="sidebar-tabs" role="tablist" aria-label="Analysis sections">
          <button id="scenario-tab" role="tab" type="button" aria-controls="analysis-panel" aria-selected={tab === 'scenario'} onClick={() => setTab('scenario')}>Scenario</button>
          <button id="rules-tab" role="tab" type="button" aria-controls="analysis-panel" aria-selected={tab === 'rules'} onClick={() => setTab('rules')}>Rules & evidence</button>
        </div>

        <div id="analysis-panel" role="tabpanel" aria-labelledby={`${tab}-tab`} className="sidebar-content" ref={sidebarContent}>
          {error && <div className="alert-msg" role="alert"><CircleAlert size={17} /><div>{error}<button type="button" onClick={restart}>Restart analysis</button></div></div>}
          {!error && result?.message && <div className={`alert-msg ${result.validation === 'valid' ? 'note' : ''}`} role="status"><CircleAlert size={17} /><div>{result.message}</div></div>}
          {tab === 'scenario' ? <>
            <section className="analysis-section">
              <div className="section-heading"><h2>Site inputs</h2><button type="button" className="text-button" data-testid="edit-plot" onClick={() => setMode(editing ? '3d' : 'vertices')}><PencilLine size={15} /> {editing ? 'Finish editing' : 'Edit plot'}</button></div>
              <div className="input-row">
                <label htmlFor="road-location"><MapPin size={15} /> Explore map</label>
                <select id="road-location" data-testid="road-location" value={locationKey} onChange={(event) => goToRoad(event.target.value)}>
                  <option value="">Go to a mapped street</option>
                  {site.examples && site.examples.length > 0 && <optgroup label="Illustrative scenario locations">{site.examples.map((example) => <option key={example.id} value={`example:${example.id}`}>{example.label}</option>)}</optgroup>}
                  {roadLocations.map((location) => <option value={location.key} key={location.key}>{location.name}</option>)}
                </select>
              </div>
              {locationKey && <p className="fine-print">The current analysis still refers to the outlined parcel. Draw a new parcel at the browsed location to calculate there.</p>}
              {locationExample && <button className="text-button location-example" data-testid="load-location-example" type="button" onClick={loadExample}><PencilLine size={15} /> Load editable scenario example</button>}
              <div className="input-row">
                <label htmlFor="building-profile"><House size={15} /> Building type</label>
                <select id="building-profile" data-testid="building-profile" value={profile} onChange={(event) => setProfile(event.target.value as ProfileId)}>
                  <option value="multifamily">Small multifamily</option>
                  <option value="house">Detached house</option>
                </select>
              </div>
              <div className="input-row">
                <label htmlFor="road-select"><ArrowDownRight size={15} /> Facing road</label>
                <select id="road-select" data-testid="road-select" value={road?.key ?? ''} disabled={!roadOptions.length} onChange={(event) => changeRoad(event.target.value)}>
                  {!roadOptions.length && <option value="">No mapped road nearby</option>}
                  {roadOptions.map((option) => <option key={option.key} value={option.key}>{option.name} · {format.format(option.distanceM)} m</option>)}
                </select>
              </div>
              {road && <div className="road-provenance" data-testid="road-provenance" data-road-id={road.key}>
                <span>{road.roadClass ?? 'Mapped road'} · {road.wayId === baselineRoad.wayId ? 'District inventory' : 'Legal public access unverified'}</span>
                {road.geometrySourceUrl && <Source href={road.geometrySourceUrl}>OSM alignment</Source>}
                {road.accessEvidence && <span>{road.accessEvidence}</span>}
                {road.mappedWidth != null && <span>OSM width tag: {road.mappedWidth} (legal ROW unverified)</span>}
              </div>}
              <div className="input-row">
                <label htmlFor="road-width"><Ruler size={15} /> Right-of-way width</label>
                <div className="width-field"><input id="road-width" data-testid="road-width" type="number" min="2" max="100" step="0.01" inputMode="decimal" placeholder="Scenario width" value={widthText} disabled={!road} onChange={(event) => overrideWidth(event.target.value)} /><span>m</span></div>
              </div>
              <div className="width-source">
                {validWidth && currentWidthOverride !== null ? <span className="what-if-tag">What-if width</span> : road?.width != null && currentWidthOverride === null ? <Source href={road.sourceUrl}>District inventory</Source> : <span>Width unavailable</span>}
                {currentWidthOverride !== null && road?.width != null && <button className="text-button" type="button" onClick={() => overrideWidth(null)}>Restore {road.width.toFixed(2)} m</button>}
                {currentWidthOverride === null && road?.width != null && <button className="text-button" type="button" onClick={() => overrideWidth('6')}>Try 6 m</button>}
                {road?.width != null && widthM !== 2 && <button className="text-button" type="button" onClick={() => overrideWidth('2')}>2 m stress test</button>}
              </div>
              {!validWidth && road && <p className="inline-error">Enter a right-of-way scenario width from 2 to 100 m (supported application range).</p>}
              {currentWidthOverride !== null && widthM === 2 && <p className="fine-print road-stress-note">The narrow road can clip upper envelope slices. A design may keep the same area when all of its plates fit inside the revised slices.</p>}
              <div className="input-row">
                <label htmlFor="frontage-edge">Parcel frontage</label>
                <select id="frontage-edge" data-testid="frontage-select" value={edge ?? ''} onChange={(event) => setEdge(event.target.value === '' ? undefined : Number(event.target.value))}>
                  <option value="">Auto-detect facing edge</option>
                  {plot.coordinates[0].slice(0, -1).map((_, index) => <option key={index} value={index}>Side {index + 1}</option>)}
                </select>
              </div>
              <details className="assumption-details">
                <summary>Site and redevelopment assumptions <ChevronDown size={14} /></summary>
                <p>Editable scenario boundary. The legal title boundary and surveyed road edges are unavailable. The road-edge positions use the mapped centerline and selected width.</p>
                <div className="input-row">
                  <label htmlFor="redevelopment">On-site buildings</label>
                  <select id="redevelopment" value={redevelopment} onChange={(event) => setRedevelopment(event.target.value as 'clear' | 'retain')}>
                    <option value="clear">Assume removal</option><option value="retain">Retain intersecting buildings</option>
                  </select>
                </div>
                <p>{affectedIds.length} intersecting {affectedIds.length === 1 ? 'footprint' : 'footprints'} found. Removal is modeled within the parcel. Outside portions and surrounding footprints stay visible.</p>
                {redevelopment === 'retain' && affectedIds.map((id, index) => <div className="input-row" key={id}>
                  <label title={id} htmlFor={`retained-${id}`}>Retained building {index + 1}</label>
                  <div className="width-field"><input id={`retained-${id}`} type="number" min="0.01" step="any" placeholder="GFA within plot" value={retainedAmounts[id] ?? ''} onChange={(event) => {
                    const { value } = event.target;
                    setRetainedAmounts((old) => ({ ...old, [id]: value }));
                  }} /><span>m²</span></div>
                </div>)}
                <p>Context heights distinguish sourced height, estimates from reported floor counts × 3.1 m, and 6 m schematic extrusions where neither is available. The map supports a single editable outer parcel ring. The engine can evaluate polygon holes, but the drawing controls do not create them.</p>
                <p>Screening coverage is separate from zoning membership. {result?.coverageVerified ? 'The parcel lies in the area covered by the listed overlay checks.' : 'The listed parcel-specific overlay screening coverage is incomplete here.'} Other site design and legal checks remain open.</p>
                {site.screeningNotes?.map((note) => <p key={note}>{note}</p>)}
              </details>
            </section>

            <section className="analysis-section concepts-section">
              <div className="section-heading"><h2>Design concepts</h2><span className="muted-count">{result?.concepts.length ?? 0} available</span></div>
              <div className="concept-list" data-testid="concept-list" {...resultProvenance}>
                {(['wide', 'stepped'] as const).map((strategy) => <ConceptCard
                  key={strategy}
                  strategy={strategy}
                  concept={result?.concepts.find(({ id }) => id === strategy)}
                  active={concept?.id === strategy}
                  onSelect={() => { setSelected(strategy); setConceptVisible(true); setEnvelopeKind('selected'); }}
                  message={result?.conceptMessages[strategy]}
                />)}
              </div>
              {concept && <>
                <div className="concept-rationale">
                  <p>{concept.rationale}</p>
                  <p>{concept.tradeOff}</p>
                  {concept.limitingFactors.length > 0 && <p><strong>What limited this design</strong><br />{concept.limitingFactors.join(' · ')}</p>}
                </div>
                <DesignSchedule concept={concept} />
                <button type="button" className="text-button inspect-button" onClick={inspectDesign}>Inspect selected design checks <ArrowRight size={15} /></button>
              </>}
              {search && <details className="assumption-details search-details">
                <summary>Search and design assumptions <ChevronDown size={14} /></summary>
                <p>{format.format(search.evaluated)} candidates generated. {format.format(search.independentlyChecked)} independently checked, {format.format(search.validated)} passed the modeled checks.</p>
                {search.bestValidatedGfaM2 != null && <p><strong>Best validated GFA found</strong> {sqmExactDisplay(search.bestValidatedGfaM2)}. The search covers a bounded set of candidate forms.</p>}
                <p>Design heuristics: at least {sqm(search.minimumPlateM2)} per plate and a {format.format(search.minimumCoreWidthM)} m minimum core width. These thresholds describe the form generator.</p>
              </details>}
            </section>
          </> : <>
            <section className="analysis-section">
              <div className="section-heading"><h2>Capacity</h2><Source href={plan}>Plan §16</Source></div>
              <Capacity result={result} concept={concept} />
              <BoundExplanation bound={result?.boundExplanation ?? null} onViewBound={showBound} />
            </section>
            <section className="analysis-section" data-testid="envelope-rules" {...resultProvenance}>
              <div className="section-heading"><h2>{mapEnvelopeKind === 'selected' ? 'Selected envelope constraints' : 'Capacity envelope constraints'}</h2><span className="muted-count">{mapEnvelopeKind === 'selected' ? concept?.floors.length : result?.boundExplanation?.floorCount} floors</span></div>
              <div className="envelope-view-switch" aria-label="Envelope view">
                <button type="button" data-testid="envelope-view-selected" aria-pressed={mapEnvelopeKind === 'selected'} disabled={!concept} onClick={() => { setEnvelopeKind('selected'); setEnvelopeVisible(true); setConceptVisible(true); }}>Selected design</button>
                <button type="button" data-testid="envelope-view-capacity" aria-pressed={mapEnvelopeKind === 'capacity'} disabled={!result?.envelope.length} onClick={() => { setEnvelopeKind('capacity'); setEnvelopeVisible(true); setConceptVisible(false); }}>Capacity bound</button>
              </div>
              <p className="fine-print">{mapEnvelopeKind === 'selected' ? 'These slices use the selected design’s actual height, floor count and category. Each occupied plate is checked against its applicable slice.' : 'These rows describe the height and floor count used to compute the separate maximum slice-area bound.'}</p>
              {concept && <BoundExplanation bound={concept.envelopeExplanation ?? null} selected onViewBound={showSelectedEnvelope} />}
              <Rules rules={mapEnvelopeKind === 'selected' ? concept?.envelopeRules ?? [] : result?.rules ?? []} group="envelope" emptyText="No envelope constraints are available for this scenario." />
            </section>
            <section className="analysis-section" data-testid="design-rules" data-concept-id={concept?.id} ref={designSection} tabIndex={-1} {...resultProvenance}>
              <div className="section-heading"><h2>Selected-design checks</h2>{concept && <span className="muted-count">{concept.id === 'wide' ? 'Wider / lower' : concept.name === 'Compact garden form' ? 'Narrower / garden' : 'Narrower / stepped'}</span>}</div>
              <p className="fine-print">These checks use the actual selected design. Its height and floor count can trigger different rules from the bound candidate.</p>
              {concept && <dl className="area-detail">
                <div><dt>Covered projection</dt><dd>{sqmExactDisplay(concept.coveredM2)}</dd></div>
                <div><dt>Qualifying open area</dt><dd>{sqmExactDisplay(concept.openM2)}</dd></div>
                <div><dt>Pervious planting</dt><dd>{sqmExactDisplay(concept.perviousM2)}</dd></div>
                <div><dt>Largest floor</dt><dd>{sqmExactDisplay(Math.max(...concept.floors.map((f) => f.areaM2)))}</dd></div>
              </dl>}
              {concept && <DesignSchedule concept={concept} />}
              <Rules rules={concept?.checks ?? []} group="design" emptyText="No generated design is available for these inputs." />
            </section>
            <section className="analysis-section" data-testid="evidence-rules" {...resultProvenance}>
              <div className="section-heading"><h2>Unresolved site and design evidence</h2></div>
              <p className="fine-print">Confirm the facts below before relying on the modeled checks for a real development.</p>
              <Rules rules={siteEvidence} group="evidence" emptyText={result ? 'No outstanding evidence was returned.' : 'A calculated scenario is needed before evidence can be listed.'} />
            </section>
          </>}
        </div>

        <div className="sidebar-footer" aria-live="polite">
          {!pending && result ? <span data-testid="result-ready" {...resultProvenance} data-state={result.validation} data-zone={result.zoneEligibility} data-road-id={road?.key} data-elapsed-ms={result.elapsedMs} data-roundtrip-ms={roundtrip}><i className={result.validation === 'valid' ? 'ready' : 'needs-review'} /> {result.validation === 'valid' ? 'Scenario calculated' : siteStatusText}</span>
            : <span><i className={pending ? 'busy' : 'needs-review'} /> {pending ? 'Calculating…' : 'Waiting for inputs'}</span>}
          {!pending && result && <span>{Math.round(result.elapsedMs)} ms</span>}
          <button type="button" className="mobile-source text-button" onClick={() => dialog.current?.showModal()}>Sources <ExternalLink size={12} /></button>
        </div>
      </aside>
    </main>
    <Sources context={context} dialog={dialog} />
  </div>;
}

export default function App() {
  const [context, setContext] = useState<ContextData | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    loadContext(controller.signal).then(setContext).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Failed to load the neighborhood data.');
    });
    return () => controller.abort();
  }, [attempt]);

  if (context) return <Workspace context={context} />;
  return <div className="app-loading"><Layers3 size={29} /><h1>Bangkok Site Study</h1>{error ? <><p role="alert">{error}</p><button className="header-source" type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button></> : <p role="status">Loading the Din Daeng neighborhood data…</p>}</div>;
}
