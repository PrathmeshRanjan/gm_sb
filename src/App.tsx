import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownRight, ArrowRight, ArrowUpRight, BookOpen, Building2, Check, ChevronDown,
  CircleAlert, ExternalLink, House, Layers3, MapPin, PencilLine, RotateCcw, Ruler, ScanLine, X,
} from 'lucide-react';
import type { Polygon } from 'geojson';
import AnalysisMap, { type MapMode } from './AnalysisMap';
import { loadContext, nearbyBuildings, type ContextData } from './context';
import type {
  CalculateRequest, CalculateResponse, Concept, ProfileId, RuleResult, ScenarioInput, ScenarioResult, Strategy,
} from './engine/types';

const plan = 'https://download.asa.or.th/03media/04law/cpa/mr56-bma.pdf#page=35';
const local = 'https://webportal.bangkok.go.th/public/user_files_editor/76/law/y07.pdf';
const national = 'https://webportal.bangkok.go.th/public/user_files_editor/426/mr43-55-upd68.pdf';
const format = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const sqm = (n: number) => `${format.format(n)} m²`;
const noIds: string[] = [];

function useAnalysis(input: ScenarioInput | null) {
  const worker = useRef<Worker | null>(null);
  const revision = useRef(0);
  const sent = useRef(0);
  const [run, setRun] = useState(0);
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [roundtrip, setRoundtrip] = useState(0);

  useEffect(() => {
    let instance: Worker;
    try {
      instance = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      setPending(false);
      setResult(null);
      setError('This browser could not start the geometry worker. Restart analysis to try again.');
      return;
    }
    worker.current = instance;
    instance.onmessage = ({ data }: MessageEvent<CalculateResponse>) => {
      if (data.id !== revision.current) return;
      setPending(false);
      if ('error' in data) {
        setError(data.error);
        setResult(null);
      } else {
        setError('');
        setResult(data.result);
        setRoundtrip(performance.now() - sent.current);
      }
    };
    instance.onerror = (event) => {
      event.preventDefault();
      setPending(false);
      setResult(null);
      setError('The geometry worker stopped. Restart analysis to try again.');
    };
    instance.onmessageerror = () => {
      setPending(false);
      setResult(null);
      setError('The browser could not read the geometry result. Restart analysis to try again.');
    };
    return () => {
      instance.terminate();
      worker.current = null;
    };
  }, [run]);

  useEffect(() => {
    const id = ++revision.current;
    if (!worker.current) return;
    setError('');
    if (!input) {
      setPending(false);
      setResult(null);
      return;
    }
    setPending(true);
    const task = window.setTimeout(() => {
      sent.current = performance.now();
      worker.current?.postMessage({ id, input } satisfies CalculateRequest);
    }, 55);
    return () => {
      window.clearTimeout(task);
      ++revision.current;
    };
  }, [input, run]);

  return { result, pending, error, roundtrip, restart: () => setRun((value) => value + 1) };
}

function Source({ href, children }: { href: string; children: React.ReactNode }) {
  return <a className="source-link" href={href} target="_blank" rel="noreferrer">{children}<ArrowUpRight size={13} /></a>;
}

function Rules({ rules }: { rules: RuleResult[] }) {
  if (!rules.length) return <p className="empty-text">Draw a plot and provide a right-of-way width to calculate rule outcomes.</p>;

  const states = { pass: 'Pass', fail: 'Fail', review: 'Review', 'not-applicable': 'Not applicable' };
  const evidence = { documented: 'Documented', scenario: 'Scenario', unknown: 'Unverified' };

  return <div className="rule-list">
    {rules.map((rule) => (
      <details className="rule-row" key={rule.id}>
        <summary>
          <span className="rule-name">{rule.label}{rule.controls && <span className="binding-tag">Controls</span>}</span>
          <span className={`rule-status ${rule.status}`}>{states[rule.status]}</span>
          <span className="evidence-summary" title="Evidence status">{evidence[rule.evidence]}</span>
          <ChevronDown size={14} className="rule-chevron" />
        </summary>
        <div className="rule-detail">
          <p>{rule.detail}</p>
          {rule.thai && <p className="thai-term" lang="th">{rule.thai}</p>}
          <div className="rule-meta">
            {rule.sourceUrl && <Source href={rule.sourceUrl}>{rule.clause || 'Source'}</Source>}
          </div>
        </div>
      </details>
    ))}
  </div>;
}

function Capacity({ result, concept }: { result: ScenarioResult | null; concept: Concept | null }) {
  const capacity = result?.capacity;
  return <dl className="capacity-table">
    <div><dt><span className="budget-dot legal" /> Regulatory FAR ceiling <small>Base FAR {capacity?.regulatoryFar ?? '7'}:1 × eligible site</small></dt><dd>{capacity ? sqm(capacity.regulatoryGfaCeilingM2) : '—'}</dd></div>
    <div><dt><span className="budget-dot geometric" /> Geometry bound <small>Sum of permissible floor slices</small></dt><dd>{capacity ? sqm(capacity.geometricGfaUpperBoundM2) : '—'}</dd></div>
    <div><dt><span className="budget-dot profile" /> Supported profile <small>{capacity ? `${capacity.profileMaxFloors} floors · ${format.format(capacity.profileHeightLimitM)} m height limit` : 'Application scope'}</small></dt><dd>{capacity?.profileGfaLimitM2 != null ? sqm(capacity.profileGfaLimitM2) : '—'}</dd></div>
    <div><dt><span className="budget-dot design" /> Selected design <small>Sum of generated occupied plates</small></dt><dd>{concept ? sqm(concept.gfaM2) : '—'}</dd></div>
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
      <strong>{wide ? 'Wider / lower' : 'Narrower / stepped'}</strong>
      {concept
        ? <span>{concept.floors.length} {concept.floors.length === 1 ? 'floor' : 'floors'} · {format.format(concept.heightM)} m</span>
        : <span>{message || 'Awaiting a feasible envelope'}</span>}
    </span>
    {concept && <span className="concept-area">{sqm(concept.gfaM2)}</span>}
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
        <p>The green coverage outline marks the study area within ย.๙-๑๓. The scenario parcel is editable. Road edges are inferred from the chosen centerline and width.</p>
        <div className="source-links">
          <Source href={context.site.road.sourceUrl}>District road inventory</Source>
          <Source href="https://data.go.th/en/dataset/lup_polygon">BMA land-use dataset</Source>
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
  const roadOptions = site.roadOptions ?? [baselineRoad];
  const [plot, setPlot] = useState(site.parcel);
  const [profile, setProfile] = useState<ProfileId>('multifamily');
  const [roadId, setRoadId] = useState(String(baselineRoad.wayId));
  const [widthOverride, setWidthOverride] = useState<string | null>(null);
  const [edge, setEdge] = useState<number>();
  const [mode, setMode] = useState<MapMode>('3d');
  const [redevelopment, setRedevelopment] = useState<'clear' | 'retain'>('clear');
  const [retainedAmounts, setRetainedAmounts] = useState<Record<string, string>>({});
  const [footprintsOnly, setFootprintsOnly] = useState(false);
  const [envelopeVisible, setEnvelopeVisible] = useState(true);
  const [conceptVisible, setConceptVisible] = useState(true);
  const [selected, setSelected] = useState<Strategy>('wide');
  const [tab, setTab] = useState<'scenario' | 'rules'>('scenario');
  const dialog = useRef<HTMLDialogElement>(null);
  const road = roadOptions.find((option) => String(option.wayId) === roadId) ?? baselineRoad;
  const widthText = widthOverride ?? (road.width != null ? String(road.width) : '');
  const widthM = Number(widthText);
  const validWidth = widthText.trim() !== '' && Number.isFinite(widthM) && widthM > 0 && widthM <= 100;

  const input = useMemo<ScenarioInput | null>(() => {
    if (!validWidth) return null;
    return {
      plot,
      profile,
      frontageEdgeIndex: edge,
      redevelopment,
      retainedBuildings: nearbyBuildings(plot, context.buildings).map((building) => {
        const entered = retainedAmounts[building.id];
        const eligibleGrossFloorAreaM2 = entered ? Number(entered) : undefined;
        return { ...building, eligibleGrossFloorAreaM2: eligibleGrossFloorAreaM2 && eligibleGrossFloorAreaM2 > 0 ? eligibleGrossFloorAreaM2 : undefined };
      }),
      road: {
        name: road.name,
        widthM,
        widthSource: widthOverride === null ? 'district-inventory' : 'user-override',
        baselineWidthM: road.width ?? undefined,
        sourceUrl: road.sourceUrl,
        centerline: road.centerline,
        publicStatus: road.wayId === baselineRoad.wayId ? 'documented' : 'assumed',
      },
    };
  }, [baselineRoad.wayId, context.buildings, edge, plot, profile, redevelopment, retainedAmounts, road, validWidth, widthM, widthOverride]);

  const { result, pending, error, roundtrip, restart } = useAnalysis(input);
  const concept = result?.concepts.find(({ id }) => id === selected) ?? result?.concepts[0] ?? null;
  const allRules = [...(result?.rules ?? []), ...(concept?.checks ?? [])];
  const affectedIds = result?.affectedBuildingIds ?? noIds;
  const controls = [...new Set(allRules.filter((rule) => rule.controls).map((rule) => rule.label))];
  const open = concept && result?.plotAreaM2 ? (concept.openM2 / result.plotAreaM2) * 100 : null;
  const editing = mode === 'vertices' || mode === 'draw';

  function changePlot(next: Polygon) {
    if (next.coordinates[0].length !== plot.coordinates[0].length || mode === 'draw') setEdge(undefined);
    setPlot(next);
  }

  function reset() {
    setPlot(site.parcel);
    setProfile('multifamily');
    setRoadId(String(baselineRoad.wayId));
    setWidthOverride(null);
    setEdge(undefined);
    setMode('3d');
    setRedevelopment('clear');
    setRetainedAmounts({});
    setSelected('wide');
    setFootprintsOnly(false);
    setEnvelopeVisible(true);
    setConceptVisible(true);
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
          concept={conceptVisible ? concept : null}
          centerline={road.centerline}
          roadName={road.name}
          frontageEdgeIndex={edge}
          footprintsOnly={footprintsOnly}
          envelopeVisible={envelopeVisible}
          clearedIds={redevelopment === 'clear' ? affectedIds : noIds}
        />
        <div className="map-footer">
          <span><ScanLine size={14} /> Editable scenario boundary <span className="desktop-source">· Surveyed title boundary unavailable</span></span>
          <div className="map-footer-options">
            <label><input type="checkbox" data-testid="footprints-toggle" checked={footprintsOnly} onChange={(event) => setFootprintsOnly(event.target.checked)} /> Footprints only</label>
            <label><input type="checkbox" checked={envelopeVisible} onChange={(event) => setEnvelopeVisible(event.target.checked)} /> Envelope</label>
            <label title="Hide the design to see the full 3D floor envelope."><input type="checkbox" checked={conceptVisible} onChange={(event) => setConceptVisible(event.target.checked)} /> Design</label>
          </div>
        </div>
      </div>

      <aside className="sidebar" aria-label="Scenario analysis">
        <div className="sidebar-intro">
          <div className="eyebrow"><span className="location-dot" /> INTHAMARA STUDY AREA</div>
          <div className="sidebar-heading"><h1>Pracha Suk</h1><button type="button" className="icon-button reset-button" data-testid="reset-scenario" onClick={reset} title="Reset scenario" aria-label="Reset scenario"><RotateCcw size={18} /></button></div>
          <p className="site-meta">Residential feasibility · 2013 Bangkok plan</p>
          <div className="top-metrics">
            <div><span>Scenario parcel</span><strong>{result?.plotAreaM2 != null ? format.format(result.plotAreaM2) : '—'} <small>m²</small></strong></div>
            <div><span>Design GFA</span><strong>{concept ? format.format(concept.gfaM2) : '—'} <small>m²</small></strong></div>
            <div><span>Site open area</span><strong>{open != null ? format.format(open) : '—'} <small>%</small></strong></div>
          </div>
        </div>

        <div className="sidebar-tabs" role="tablist" aria-label="Analysis sections">
          <button role="tab" type="button" aria-selected={tab === 'scenario'} onClick={() => setTab('scenario')}>Scenario</button>
          <button role="tab" type="button" aria-selected={tab === 'rules'} onClick={() => setTab('rules')}>Rules & evidence</button>
        </div>

        <div className="sidebar-content">
          {error && <div className="alert-msg" role="alert"><CircleAlert size={17} /><div>{error}<button type="button" onClick={restart}>Restart analysis</button></div></div>}
          {!error && result?.message && <div className={`alert-msg ${result.validation === 'valid' ? 'note' : ''}`} role="status"><CircleAlert size={17} /><div>{result.message}</div></div>}
          {tab === 'scenario' ? <>
            <section className="analysis-section">
              <div className="section-heading"><h2>Site inputs</h2><button type="button" className="text-button" data-testid="edit-plot" onClick={() => setMode(editing ? '3d' : 'vertices')}><PencilLine size={15} /> {editing ? 'Finish editing' : 'Edit plot'}</button></div>
              <div className="input-row">
                <label htmlFor="building-profile"><House size={15} /> Building type</label>
                <select id="building-profile" data-testid="building-profile" value={profile} onChange={(event) => setProfile(event.target.value as ProfileId)}>
                  <option value="multifamily">Small multifamily</option>
                  <option value="house">Detached house</option>
                </select>
              </div>
              <div className="input-row">
                <label htmlFor="road-select"><ArrowDownRight size={15} /> Facing road</label>
                <select id="road-select" data-testid="road-select" value={roadId} onChange={(event) => { setRoadId(event.target.value); setWidthOverride(null); setEdge(undefined); }}>
                  {roadOptions.map((option) => <option key={option.wayId} value={option.wayId}>{option.name}</option>)}
                </select>
              </div>
              <div className="input-row">
                <label htmlFor="road-width"><Ruler size={15} /> Right-of-way width</label>
                <div className="width-field"><input id="road-width" data-testid="road-width" type="number" min="0.01" max="100" step="0.01" inputMode="decimal" placeholder="Scenario width" value={widthText} onChange={(event) => setWidthOverride(event.target.value)} /><span>m</span></div>
              </div>
              <div className="width-source">
                {widthOverride !== null ? <span className="what-if-tag">What-if width</span> : road.width != null ? <Source href={road.sourceUrl}>District inventory</Source> : <span>Width unavailable</span>}
                {widthOverride !== null && road.width != null && <button className="text-button" type="button" onClick={() => setWidthOverride(null)}>Restore {road.width.toFixed(2)} m</button>}
                {widthOverride === null && road.width != null && <button className="text-button" type="button" onClick={() => setWidthOverride('6')}>Try 6 m</button>}
              </div>
              {!validWidth && <p className="inline-error">Enter a scenario width greater than 0 m and at most 100 m.</p>}
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
                <p>Context heights use reported floor counts × 3.1 m where available. The remaining buildings use 6 m schematic extrusions.</p>
              </details>
            </section>

            <section className="analysis-section concepts-section">
              <div className="section-heading"><h2>Design concepts</h2><span className="muted-count">{result?.concepts.length ?? 0} available</span></div>
              <div className="concept-list">
                {(['wide', 'stepped'] as const).map((strategy) => <ConceptCard
                  key={strategy}
                  strategy={strategy}
                  concept={result?.concepts.find(({ id }) => id === strategy)}
                  active={concept?.id === strategy}
                  onSelect={() => { setSelected(strategy); setConceptVisible(true); }}
                  message={result?.conceptMessages[strategy]}
                />)}
              </div>
              {concept && <button type="button" className="text-button inspect-button" onClick={() => setTab('rules')}>Inspect selected design checks <ArrowRight size={15} /></button>}
            </section>
          </> : <>
            <section className="analysis-section">
              <div className="section-heading"><h2>Capacity</h2><Source href={plan}>Plan §16</Source></div>
              <Capacity result={result} concept={concept} />
              <p className="fine-print">Floor-slice envelopes test the top of each proposed storey. Area and planting budgets are calculated on the design separately.</p>
              <p className="fine-print">{controls.length ? `Controls in this scenario: ${controls.join(', ')}.` : 'No active constraint has been identified in the current result.'}</p>
              {concept && <dl className="area-detail">
                <div><dt>Covered projection</dt><dd>{sqm(concept.coveredM2)}</dd></div>
                <div><dt>Qualifying open area</dt><dd>{sqm(concept.openM2)}</dd></div>
                <div><dt>Pervious planting</dt><dd>{sqm(concept.perviousM2)}</dd></div>
                <div><dt>Largest floor</dt><dd>{sqm(Math.max(...concept.floors.map((f) => f.areaM2)))}</dd></div>
              </dl>}
            </section>
            <section className="analysis-section">
              <div className="section-heading"><h2>Rule checks</h2>{concept && <span className="muted-count">{concept.id === 'wide' ? 'Wider / lower' : 'Narrower / stepped'}</span>}</div>
              <p className="fine-print">Expand a result for the limit, source clause, and evidence status.</p>
              <Rules rules={allRules} />
            </section>
          </>}
        </div>

        <div className="sidebar-footer" aria-live="polite">
          {!pending && result ? <span data-testid="result-ready" data-state={result.validation} data-elapsed-ms={result.elapsedMs} data-roundtrip-ms={roundtrip}><i className={result.validation === 'valid' ? 'ready' : 'needs-review'} /> {result.validation === 'valid' ? 'Scenario calculated' : 'Scenario needs review'}</span>
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
  return <div className="app-loading"><Layers3 size={29} /><h1>Bangkok Site Study</h1>{error ? <><p role="alert">{error}</p><button className="header-source" type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button></> : <p role="status">Loading the Din Daeng study area…</p>}</div>;
}
