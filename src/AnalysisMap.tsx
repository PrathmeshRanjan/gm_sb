import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type FillExtrusionLayerSpecification, type FillLayerSpecification, type GeoJSONSource, type Map as MapInstance, type StyleSpecification } from 'maplibre-gl';
import { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode } from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import { Box, Check, Compass, Layers2, LocateFixed, Minus, PencilLine, Plus } from 'lucide-react';
import type { FeatureCollection, LineString, Polygon } from 'geojson';
import type { Concept, FloorPlate, ScenarioResult } from './engine/types';
import { feature, type ContextData } from './context';

export type MapMode = '3d' | 'plan' | 'vertices' | 'draw';

interface Props {
  context: ContextData;
  plot: Polygon;
  mode: MapMode;
  onMode: (mode: MapMode) => void;
  onPlot: (plot: Polygon) => void;
  result: ScenarioResult | null;
  requestId?: number;
  resultWidth?: number;
  concept: Concept | null;
  envelope: FloorPlate[];
  envelopeKind: 'selected' | 'capacity';
  centerline?: LineString;
  roadName?: string;
  roadId?: string;
  nearbyRoadCount: number;
  cameraTarget?: { center: [number, number]; zoom: number; bearing?: number; pitch?: number };
  frontageEdgeIndex?: number;
  footprintsOnly: boolean;
  envelopeVisible: boolean;
  clearedIds: string[];
}

const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
const scenarioSources = ['plot', 'road-reference', 'envelope', 'design', 'planting', 'preserved-buildings'] as const;

const layout: StyleSpecification = {
  version: 8,
  light: { anchor: 'viewport', color: '#ffffff', intensity: 0.37, position: [1.25, 230, 44] },
  sources: {},
  layers: [{ id: 'base', type: 'background', paint: { 'background-color': '#e8e7dc' } }],
};

function collection(features: FeatureCollection['features']): FeatureCollection {
  return { type: 'FeatureCollection', features };
}

function plateFeatures(plates: FloorPlate[]) {
  return plates.map(({ geometry, baseM, topM, floor }) => feature(geometry, { baseM, topM, floor }));
}

function setData(map: MapInstance, name: string, data: FeatureCollection) {
  const source = map.getSource(name) as GeoJSONSource | undefined;
  return source?.setData(data, true) ?? Promise.resolve();
}

const buildingFootprintPaint = {
  'fill-color': '#b8b5a6',
  'fill-opacity': 0.67,
  'fill-outline-color': '#a19f91',
} satisfies FillLayerSpecification['paint'];

const buildingMassingPaint = {
  'fill-extrusion-height': ['coalesce', ['get', 'height'], 5],
  'fill-extrusion-color': ['match', ['get', 'heightKind'], 'sourced', '#919985', 'estimate', '#a8aa91', '#d2cfc0'],
  'fill-extrusion-opacity': 0.94,
} satisfies FillExtrusionLayerSpecification['paint'];

function addLayers(map: MapInstance, data: ContextData) {
  map.addSource('coverage', { type: 'geojson', data: collection([feature(data.site.coverage, {})]) });
  map.addSource('zone', { type: 'geojson', data: data.site.zoneBoundary ? collection([feature(data.site.zoneBoundary, {})]) : empty });
  map.addSource('screening', { type: 'geojson', data: collection((data.site.screeningAreas ?? []).map((area) => feature(area.geometry, { id: area.id, label: area.label }))) });
  map.addSource('roads', { type: 'geojson', data: data.roads });
  map.addSource('buildings', { type: 'geojson', data: data.buildings });
  for (const id of scenarioSources) {
    map.addSource(id, { type: 'geojson', data: empty });
  }

  map.addLayer({ id: 'study-fill', type: 'fill', source: 'coverage', paint: { 'fill-color': '#f0eee4', 'fill-opacity': 0.53 } });
  map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zone', paint: { 'fill-color': '#c3ddce', 'fill-opacity': 0.25 } });
  map.addLayer({ id: 'screening-fill', type: 'fill', source: 'screening', paint: { 'fill-color': '#d4a65a', 'fill-opacity': 0.13 } });
  map.addLayer({
    id: 'street-case', type: 'line', source: 'roads', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#d2cfc0', 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 2.6, 17, 6.5, 20, 29.5] },
  });
  map.addLayer({
    id: 'street', type: 'line', source: 'roads', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#faf8f0', 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 1.1, 17, 5, 20, 28] },
  });
  map.addLayer({
    id: 'study-boundary', type: 'line', source: 'coverage',
    paint: { 'line-color': '#6c8577', 'line-width': 1.2, 'line-dasharray': [2.5, 3] },
  });
  map.addLayer({ id: 'zone-boundary', type: 'line', source: 'zone', paint: { 'line-color': '#1e7351', 'line-width': 2.8 } });
  map.addLayer({ id: 'screening-boundaries', type: 'line', source: 'screening', paint: { 'line-color': '#b08846', 'line-width': 1.5, 'line-dasharray': [2, 2] } });
  map.addLayer({
    id: 'road-reference-all', type: 'line', source: 'road-reference', layout: { 'line-cap': 'round' },
    paint: {
      'line-color': ['match', ['get', 'kind'], 'centerline', '#a75c2b', 'frontage', '#164d3c', 'near', '#a4754f', '#837194'],
      'line-width': ['match', ['get', 'kind'], 'centerline', 2.5, 'frontage', 4, 1.35],
      'line-dasharray': [3, 3],
    },
  });
  map.addLayer({
    id: 'scenario-fill', type: 'fill', source: 'plot',
    paint: { 'fill-color': '#69a488', 'fill-opacity': 0.3 },
  });
  map.addLayer({
    id: 'context-footprints', type: 'fill', source: 'buildings',
    paint: buildingFootprintPaint,
  });
  map.addLayer({
    id: 'affected-footprints', type: 'line', source: 'buildings', layout: { visibility: 'none' },
    paint: { 'line-color': '#7a7363', 'line-width': 1.25, 'line-opacity': 0.7, 'line-dasharray': [2, 2] },
  });
  map.addLayer({
    id: 'context-massing', type: 'fill-extrusion', source: 'buildings',
    paint: buildingMassingPaint,
  });
  map.addLayer({
    id: 'preserved-footprints', type: 'fill', source: 'preserved-buildings',
    paint: buildingFootprintPaint,
  });
  map.addLayer({
    id: 'preserved-massing', type: 'fill-extrusion', source: 'preserved-buildings',
    paint: buildingMassingPaint,
  });
  map.addLayer({
    id: 'scenario-outline', type: 'line', source: 'plot',
    paint: {
      'line-color': ['case', ['get', 'warning'], '#bd4a2e', '#075c49'],
      'line-width': 3.2,
      'line-dasharray': [3, 1.25],
    },
  });
  map.addLayer({
    id: 'envelope-flat', type: 'fill', source: 'envelope',
    filter: ['==', ['get', 'floor'], 1],
    paint: { 'fill-color': '#67a88a', 'fill-opacity': 0.29, 'fill-outline-color': '#33795d' },
  });
  map.addLayer({
    id: 'envelope-volume', type: 'fill-extrusion', source: 'envelope',
    paint: {
      'fill-extrusion-color': '#71ad92',
      'fill-extrusion-base': ['get', 'baseM'],
      // Separate coincident rendered roof surfaces by 2 cm. The floor geometry,
      // elevation schedule and independent containment check remain exact.
      'fill-extrusion-height': ['-', ['get', 'topM'], 0.02],
      'fill-extrusion-opacity': 0.22,
    },
  });
  map.addLayer({
    id: 'planting-ground', type: 'fill', source: 'planting',
    paint: { 'fill-color': '#89ae53', 'fill-opacity': 0.63, 'fill-outline-color': '#526e34' },
  });
  map.addLayer({
    id: 'design-flat', type: 'fill', source: 'design', filter: ['==', ['get', 'floor'], 1],
    paint: { 'fill-color': '#0c6855', 'fill-opacity': 0.8, 'fill-outline-color': '#0a4c3e' },
  });
  map.addLayer({
    id: 'design-volume', type: 'fill-extrusion', source: 'design',
    paint: {
      'fill-extrusion-color': ['case', ['==', ['%', ['get', 'floor'], 2], 0], '#277d68', '#0e6755'],
      'fill-extrusion-base': ['get', 'baseM'],
      'fill-extrusion-height': ['get', 'topM'],
      'fill-extrusion-opacity': 1,
    },
  });
}

export default function AnalysisMap(props: Props) {
  const { context, plot, mode, result, requestId, resultWidth, concept, envelope, envelopeKind, centerline, roadName, roadId, nearbyRoadCount, cameraTarget, frontageEdgeIndex, footprintsOnly, envelopeVisible, clearedIds } = props;
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const activeDrawId = useRef<string | number | null>(null);
  const lastEditedPlot = useRef('');
  const latest = useRef(props);
  const lastCamera = useRef<{ zoom: number; center: maplibregl.LngLat; bearing: number; pitch: number } | null>(null);
  const previousMode = useRef<MapMode>('3d');
  const [loaded, setLoaded] = useState(false);
  const [mapError, setMapError] = useState('');
  const [editError, setEditError] = useState('');
  const [applied, setApplied] = useState<{ result: ScenarioResult | null; concept: Concept | null; envelope: FloorPlate[]; plot: Polygon; centerline?: LineString; drawing: boolean } | null>(null);
  const [bearing, setBearing] = useState(context.site.camera.bearing);
  const [camera, setCamera] = useState(context.site.camera);
  const drawing = mode === 'draw';
  const sourceApplied = applied !== null && applied.plot === plot && applied.centerline === centerline && applied.drawing === drawing;
  const rendered = sourceApplied && result !== null && applied.result === result && applied.concept === concept && applied.envelope === envelope;
  const originalBuildings = useMemo(() => new Map(
    context.buildings.features.map(({ properties }) => [String(properties.id), properties]),
  ), [context.buildings]);
  latest.current = props;

  useEffect(() => {
    if (!mapEl.current) return;
    let map: MapInstance;
    try {
      map = new maplibregl.Map({
        container: mapEl.current,
        style: layout,
        ...context.site.camera,
        attributionControl: false,
        minZoom: 13,
        maxZoom: 21,
        maxPitch: 70,
        canvasContextAttributes: { antialias: true },
      });
    } catch {
      setMapError('The map needs WebGL. Enable hardware acceleration or try another browser.');
      return;
    }
    mapRef.current = map;
    map.on('rotate', () => setBearing(map.getBearing()));
    const reportCamera = () => {
      const center = map.getCenter();
      setCamera({ center: [center.lng, center.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() });
    };
    map.on('moveend', reportCamera);
    map.on('error', (event) => {
      if (!map.loaded() && !map.getSource('coverage')) setMapError(event.error.message);
    });
    map.once('load', () => {
      addLayers(map, context);
      reportCamera();
      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map, coordinatePrecision: 9 }),
        modes: [
          new TerraDrawPolygonMode({
            styles: { fillColor: '#6bbb97', fillOpacity: 0.27, outlineColor: '#0b654c', outlineWidth: 2.5 },
          }),
          new TerraDrawSelectMode({
            flags: { polygon: { feature: { coordinates: { draggable: true, deletable: true, midpoints: { draggable: true } } } } },
            styles: {
              selectedPolygonColor: '#6bbb97',
              selectedPolygonFillOpacity: 0.17,
              selectedPolygonOutlineColor: '#0b654c',
              selectedPolygonOutlineWidth: 2.5,
              selectionPointColor: '#0b654c',
              selectionPointOutlineColor: '#ffffff',
              selectionPointWidth: 5,
              midPointColor: '#f3f7ef',
              midPointOutlineColor: '#0b654c',
            },
          }),
        ],
      });
      draw.start();
      draw.setMode('static');
      draw.on('change', () => {
        if (latest.current.mode !== 'vertices' || activeDrawId.current == null) return;
        const updated = draw.getSnapshotFeature(activeDrawId.current)?.geometry;
        if (updated?.type !== 'Polygon') return;
        const serialized = JSON.stringify(updated);
        if (serialized === lastEditedPlot.current) return;
        lastEditedPlot.current = serialized;
        latest.current.onPlot(updated);
      });
      draw.on('finish', (id) => {
        if (latest.current.mode !== 'draw') return;
        const next = draw.getSnapshotFeature(id)?.geometry;
        if (next?.type === 'Polygon') {
          latest.current.onPlot(next);
          latest.current.onMode('vertices');
        }
      });
      drawRef.current = draw;
      setMapError('');
      setLoaded(true);
    });

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(mapEl.current);
    return () => {
      observer.disconnect();
      drawRef.current?.stop();
      drawRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [context]);

  useEffect(() => {
    const map = mapRef.current;
    const draw = drawRef.current;
    if (!map || !draw || !loaded) return;
    const prior = previousMode.current;
    if (mode === '3d' && prior !== '3d') {
      const priorCamera = lastCamera.current ?? context.site.camera;
      map.easeTo({ center: map.getCenter(), zoom: map.getZoom(), bearing: priorCamera.bearing, pitch: priorCamera.pitch, duration: 420 });
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
    } else if (mode !== '3d' && prior === '3d') {
      lastCamera.current = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
      // Editing must start on an exactly flat map even if a user interrupts a camera animation.
      map.jumpTo({ pitch: 0, bearing: 0 });
    } else if (mode !== '3d' && (map.getPitch() !== 0 || map.getBearing() !== 0)) {
      map.jumpTo({ pitch: 0, bearing: 0 });
    }
    previousMode.current = mode;
    setEditError('');
    activeDrawId.current = null;
    draw.setMode('static');
    draw.clear();
    if (mode === 'vertices') {
      const geometry: Polygon = {
        type: 'Polygon',
        coordinates: latest.current.plot.coordinates.map((ring) =>
          ring.map((point) => point.map((value) => Number(value.toFixed(9)))),
        ),
      };
      const [added] = draw.addFeatures([feature(geometry, { mode: 'polygon' })]);
      if (added?.valid && added.id !== undefined) {
        activeDrawId.current = added.id;
        lastEditedPlot.current = JSON.stringify(geometry);
        draw.setMode('select');
        draw.selectFeature(added.id);
      } else {
        setEditError('Vertex editing is unavailable for this plot. Draw a new outline to replace it.');
      }
    } else if (mode === 'draw') {
      draw.setMode('polygon');
    }
  }, [context, loaded, mode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!loaded || !map || !cameraTarget) return;
    map.easeTo({ ...cameraTarget, duration: 420 });
  }, [cameraTarget, loaded]);

  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const plotSource = drawing ? empty : collection([feature(plot, {
      warning: Boolean(result && result.validation !== 'valid'),
    })]);
    const reference: FeatureCollection['features'] = !drawing && centerline ? [feature(centerline, { kind: 'centerline' })] : [];
    if (result?.road) {
      reference.push(feature(result.road.nearEdge, { kind: 'near' }), feature(result.road.farEdge, { kind: 'far' }));
      if (result.road.frontage?.coordinates.length) reference.push(feature(result.road.frontage, { kind: 'frontage' }));
    }
    if (!drawing && !result?.road?.frontage && frontageEdgeIndex !== undefined) {
      const ring = plot.coordinates[0];
      if (ring[frontageEdgeIndex + 1]) {
        reference.push(feature({ type: 'LineString', coordinates: ring.slice(frontageEdgeIndex, frontageEdgeIndex + 2) }, { kind: 'frontage' }));
      }
    }
    const pieces = clearedIds.length ? (result?.preservedBuildingParts ?? []).flatMap(({ id, geometry }) => {
      const properties = originalBuildings.get(id);
      return properties ? [feature(geometry, properties)] : [];
    }) : [];
    let current = true;
    const finish = () => {
      // A setData promise can resolve early when MapLibre queues a second update.
      // Wait for every source to finish its active update and drain its queue.
      if (!current || !scenarioSources.every((id) => (map.getSource(id) as GeoJSONSource | undefined)?.loaded())) return;
      current = false;
      map.off('sourcedata', finish);
      setMapError('');
      setApplied({ result, concept, envelope, plot, centerline, drawing });
    };
    map.on('sourcedata', finish);
    Promise.all([
      setData(map, 'plot', plotSource),
      setData(map, 'road-reference', collection(reference)),
      setData(map, 'envelope', collection(plateFeatures(envelope))),
      setData(map, 'design', collection(plateFeatures(concept?.floors ?? []))),
      setData(map, 'planting', collection(concept?.planting ? [feature(concept.planting, {})] : [])),
      setData(map, 'preserved-buildings', collection(pieces)),
    ]).then(finish).catch(() => {
      if (current) {
        map.off('sourcedata', finish);
        setApplied(null);
        setMapError('The browser could not update the scenario layers.');
      }
    });
    return () => {
      current = false;
      map.off('sourcedata', finish);
    };
  }, [centerline, clearedIds, concept, drawing, envelope, frontageEdgeIndex, loaded, originalBuildings, plot, result]);

  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const flat = mode !== '3d';
    const cleared = rendered ? clearedIds : [];
    const toggle = (layer: string, visible: boolean) => map.setLayoutProperty(layer, 'visibility', visible ? 'visible' : 'none');
    toggle('scenario-fill', sourceApplied && !drawing);
    toggle('scenario-outline', sourceApplied && !drawing);
    toggle('road-reference-all', sourceApplied && !drawing);
    toggle('context-footprints', flat || footprintsOnly);
    toggle('context-massing', !flat && !footprintsOnly);
    toggle('preserved-footprints', cleared.length > 0 && (flat || footprintsOnly));
    toggle('preserved-massing', cleared.length > 0 && !flat && !footprintsOnly);
    toggle('design-flat', rendered && concept !== null && flat);
    toggle('design-volume', rendered && concept !== null && !flat);
    toggle('planting-ground', rendered && Boolean(concept?.planting));
    toggle('envelope-flat', rendered && envelopeVisible && (flat || concept !== null));
    toggle('envelope-volume', rendered && envelopeVisible && !flat);
    toggle('affected-footprints', cleared.length > 0);
    map.setFilter('affected-footprints', ['in', ['to-string', ['get', 'id']], ['literal', cleared]]);
    map.setFilter('road-reference-all', rendered ? null : ['in', ['get', 'kind'], ['literal', ['centerline', 'frontage']]]);
    for (const id of ['context-footprints', 'context-massing']) {
      map.setFilter(id, cleared.length ? ['!', ['in', ['to-string', ['get', 'id']], ['literal', cleared]]] : null);
    }
  }, [clearedIds, concept, drawing, envelopeVisible, footprintsOnly, loaded, mode, rendered, sourceApplied]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || mode === 'draw' || !centerline || !roadName) return;
    const first = centerline.coordinates[0];
    const end = centerline.coordinates.at(-1);
    if (!first || !end) return;
    const element = document.createElement('span');
    element.className = 'road-map-label';
    element.textContent = roadName;
    const label = new maplibregl.Marker({ element, offset: [13, -5], anchor: 'left' })
      .setLngLat([first[0] * 0.12 + end[0] * 0.88, first[1] * 0.12 + end[1] * 0.88])
      .addTo(map);
    return () => { label.remove(); };
  }, [centerline, loaded, mode, roadName]);

  function showCoverage() {
    const map = mapRef.current;
    if (!map) return;
    const area = context.site.zoneBoundary ?? context.site.coverage;
    const rings = area.type === 'Polygon' ? area.coordinates : area.coordinates.flat();
    const bounds = rings.flat().reduce((box, point) => box.extend([point[0], point[1]]), new maplibregl.LngLatBounds());
    map.fitBounds(bounds, { padding: 70, pitch: mode === '3d' ? 25 : 0, duration: 450 });
  }

  const editing = mode === 'vertices' || mode === 'draw';
  return (
    <section className="map-panel"
      data-testid="site-map"
      data-request-id={rendered ? requestId : undefined}
      data-result-width={rendered ? resultWidth : undefined}
      data-concept-id={rendered ? concept?.id : undefined}
      data-envelope-floors={rendered ? envelope.length : undefined}
      data-envelope-kind={rendered ? envelopeKind : undefined}
      data-road-id={roadId}
      data-context-buildings={context.buildings.features.length}
      data-context-roads={context.roads.features.length}
      data-nearby-roads={nearbyRoadCount}
      data-camera-center={camera.center.join(',')}
      data-camera-zoom={camera.zoom}
      data-camera-bearing={camera.bearing}
      data-camera-pitch={camera.pitch}
      aria-label="Interactive neighborhood map"
      aria-busy={Boolean(result) && !rendered}
    >
      <div className="map-canvas" data-testid="map-canvas" ref={mapEl} />
      <div className="map-navigator" aria-label="Map view">
        {editing ? <>
          <button type="button" className={mode === 'vertices' ? 'active' : ''} onClick={() => props.onMode('vertices')} disabled={!loaded}><PencilLine size={16} /> Move vertices</button>
          <button type="button" className={mode === 'draw' ? 'active' : ''} onClick={() => props.onMode('draw')} disabled={!loaded}><Plus size={16} /> Draw new</button>
          <button type="button" className="map-done" onClick={() => props.onMode('3d')} disabled={!loaded}><Check size={16} /> Done</button>
        </> : <>
          <button type="button" data-testid="view-3d" className={mode === '3d' ? 'active' : ''} onClick={() => props.onMode('3d')} disabled={!loaded} aria-pressed={mode === '3d'}><Box size={16} /> 3D view</button>
          <button type="button" data-testid="view-plan" className={mode === 'plan' ? 'active' : ''} onClick={() => props.onMode('plan')} disabled={!loaded} aria-pressed={mode === 'plan'}><Layers2 size={16} /> Plan</button>
          <button type="button" data-testid="draw-new-plot" onClick={() => props.onMode('draw')} disabled={!loaded}><Plus size={16} /> Draw parcel</button>
        </>}
      </div>
      {editing && <div className="map-hint" role="status">{editError || (mode === 'draw' ? 'Click to add corners. Click the first corner to finish.' : 'Drag a corner to edit. Drag a midpoint to add a vertex.')}</div>}
      <div className="map-controls" aria-label="Map controls">
        <button type="button" title="Reset north" aria-label="Reset north" onClick={() => mapRef.current?.resetNorth({ duration: 300 })}><Compass size={19} style={{ transform: `rotate(${-bearing}deg)` }} /></button>
        <div className="map-zoom">
          <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}><Plus size={18} /></button>
          <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}><Minus size={18} /></button>
        </div>
        <button type="button" title={context.site.zoneBoundary ? 'Show chosen zone' : 'Show study coverage'} aria-label={context.site.zoneBoundary ? 'Show chosen zone' : 'Show study coverage'} onClick={showCoverage}><LocateFixed size={18} /></button>
      </div>
      <div className="map-legend" aria-label="Map legend">
        <span><i className="legend-key plot-key" /> Scenario parcel</span>
        {rendered && envelopeVisible && envelope.length !== 0 && <span><i className="legend-key envelope-key" /> {envelopeKind === 'selected' ? 'Selected envelope' : 'Capacity envelope'}</span>}
        {rendered && concept && <span><i className="legend-key design-key" /> Selected concept</span>}
        {rendered && concept?.planting && <span><i className="legend-key planting-key" /> Planting</span>}
        {centerline && <span><i className="legend-key road-key" /> Facing road</span>}
        {rendered && result?.road && <span title="Brown is the near edge. Purple is the far edge."><i className="legend-key edge-key" /> {result.road.inferred ? 'Inferred ROW edges' : 'Surveyed ROW edges'}</span>}
        {rendered && result?.road?.frontage && result.road.frontage.coordinates.length > 0 && <span><i className="legend-key frontage-key" /> Modeled contact</span>}
        {rendered && clearedIds.length > 0 && <span><i className="legend-key affected-key" /> Assumed removal</span>}
        {context.site.zoneBoundary && <span><i className="legend-key zone-key" /> ย.๙-๑๓ boundary</span>}
        <span><i className="legend-key coverage-key" /> Context coverage</span>
        {Boolean(context.site.screeningAreas?.length) && <span><i className="legend-key screening-key" /> Screened restriction areas</span>}
        {mode === '3d' && !footprintsOnly && <span title="Building context height provenance"><i className="legend-key measured-height-key" /> Sourced <i className="legend-key estimate-height-key" /> Floor estimate <i className="legend-key schematic-height-key" /> Schematic</span>}
      </div>
      <div className="map-attribution">
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
        <span aria-hidden="true"> · </span>
        <a href="https://docs.overturemaps.org/attribution/" target="_blank" rel="noreferrer">Overture Maps Foundation</a>
        <span aria-hidden="true"> · </span>
        <a href="https://data.go.th/en/dataset/lup_polygon" target="_blank" rel="noreferrer">BMA zone evidence</a>
      </div>
      {mapError ? <div className="map-notice" role="alert">{mapError}</div> : !loaded && <div className="map-notice" role="status">Preparing the neighborhood map…</div>}
    </section>
  );
}
