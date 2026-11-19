import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MapInstance, type StyleSpecification } from 'maplibre-gl';
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
  concept: Concept | null;
  centerline: LineString;
  frontageEdgeIndex?: number;
  footprintsOnly: boolean;
  envelopeVisible: boolean;
  clearedIds: string[];
}

const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };

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
  (map.getSource(name) as GeoJSONSource | undefined)?.setData(data);
}

function addLayers(map: MapInstance, data: ContextData) {
  map.addSource('coverage', { type: 'geojson', data: collection([feature(data.site.coverage, {})]) });
  map.addSource('roads', { type: 'geojson', data: data.roads });
  map.addSource('buildings', { type: 'geojson', data: data.buildings });
  for (const id of ['plot', 'road-reference', 'envelope', 'design', 'planting']) {
    map.addSource(id, { type: 'geojson', data: empty });
  }

  map.addLayer({ id: 'study-fill', type: 'fill', source: 'coverage', paint: { 'fill-color': '#f0eee4', 'fill-opacity': 0.53 } });
  const roadWidth = ['interpolate', ['linear'], ['zoom'], 14, 1.1, 17, 5, 20, 28] as const;
  map.addLayer({
    id: 'street-case', type: 'line', source: 'roads', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#d2cfc0', 'line-width': ['+', [...roadWidth], 1.5] },
  });
  map.addLayer({
    id: 'street', type: 'line', source: 'roads', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#faf8f0', 'line-width': [...roadWidth] },
  });
  map.addLayer({
    id: 'study-boundary', type: 'line', source: 'coverage',
    paint: { 'line-color': '#6c8577', 'line-width': 1.2, 'line-dasharray': [2.5, 3] },
  });
  map.addLayer({
    id: 'road-reference-all', type: 'line', source: 'road-reference', layout: { 'line-cap': 'round' },
    paint: {
      'line-color': ['match', ['get', 'kind'], 'centerline', '#a75c2b', 'frontage', '#164d3c', 'near', '#b27746', '#b27746'],
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
    paint: { 'fill-color': '#b8b5a6', 'fill-opacity': 0.67, 'fill-outline-color': '#a19f91' },
  });
  map.addLayer({
    id: 'context-massing', type: 'fill-extrusion', source: 'buildings',
    paint: {
      'fill-extrusion-height': ['coalesce', ['get', 'height'], 5],
      'fill-extrusion-color': ['match', ['get', 'heightKind'], 'sourced', '#b6b7a8', 'estimate', '#bcbaa9', '#d2cfc0'],
      'fill-extrusion-opacity': 0.94,
    },
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
      'fill-extrusion-height': ['get', 'topM'],
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
  const { context, plot, mode, result, concept, centerline, frontageEdgeIndex, footprintsOnly, envelopeVisible, clearedIds } = props;
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const activeDrawId = useRef<string | number | null>(null);
  const latest = useRef(props);
  const lastCamera = useRef<{ zoom: number; center: maplibregl.LngLat; bearing: number; pitch: number } | null>(null);
  const previousMode = useRef<MapMode>('3d');
  const [loaded, setLoaded] = useState(false);
  const [mapError, setMapError] = useState('');
  const [editError, setEditError] = useState('');
  const [bearing, setBearing] = useState(context.site.camera.bearing);
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
    map.on('error', (event) => {
      if (!map.loaded() && !map.getSource('coverage')) setMapError(event.error.message);
    });
    map.once('load', () => {
      addLayers(map, context);
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
              selectedPolygonOpacity: 0.17,
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
        if (updated?.type === 'Polygon' && JSON.stringify(updated) !== JSON.stringify(latest.current.plot)) {
          latest.current.onPlot(updated);
        }
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
      const camera = lastCamera.current ?? context.site.camera;
      map.easeTo({ ...camera, duration: 420 });
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
    } else if (mode !== '3d' && prior === '3d') {
      lastCamera.current = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
      map.easeTo({ pitch: 0, bearing: 0, duration: 300 });
    }
    previousMode.current = mode;
    setEditError('');
    activeDrawId.current = null;
    draw.setMode('static');
    draw.clear();
    if (mode === 'vertices') {
      const geometry = latest.current.plot;
      const [added] = draw.addFeatures([feature(geometry, { mode: 'polygon' })]);
      if (added?.valid) {
        activeDrawId.current = added.id;
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
    if (!map || !loaded) return;
    setData(map, 'plot', collection([feature(plot, {
      warning: result?.validation === 'outside-coverage' || result?.validation === 'road-conflict' || result?.validation === 'invalid',
    })]));
    const reference = [feature(centerline, { kind: 'centerline' })];
    if (result?.road) {
      reference.push(feature(result.road.nearEdge, { kind: 'near' }), feature(result.road.farEdge, { kind: 'far' }));
    }
    if (frontageEdgeIndex !== undefined) {
      const ring = plot.coordinates[0];
      if (ring[frontageEdgeIndex + 1]) {
        reference.push(feature({ type: 'LineString', coordinates: ring.slice(frontageEdgeIndex, frontageEdgeIndex + 2) }, { kind: 'frontage' }));
      }
    }
    setData(map, 'road-reference', collection(reference));
    setData(map, 'envelope', collection(plateFeatures(result?.envelope ?? [])));
    setData(map, 'design', collection(plateFeatures(concept?.floors ?? [])));
    setData(map, 'planting', collection(concept?.planting ? [feature(concept.planting, {})] : []));
  }, [loaded, plot, result, concept, centerline, frontageEdgeIndex]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const flat = mode !== '3d';
    const toggle = (layer: string, visible: boolean) => map.setLayoutProperty(layer, 'visibility', visible ? 'visible' : 'none');
    toggle('context-footprints', flat || footprintsOnly);
    toggle('context-massing', !flat && !footprintsOnly);
    toggle('design-flat', flat);
    toggle('design-volume', !flat);
    toggle('envelope-flat', flat && envelopeVisible);
    toggle('envelope-volume', !flat && envelopeVisible);
    for (const id of ['context-footprints', 'context-massing']) {
      map.setFilter(id, clearedIds.length ? ['!', ['in', ['to-string', ['get', 'id']], ['literal', clearedIds]]] : null);
    }
  }, [mode, footprintsOnly, loaded, envelopeVisible, clearedIds]);

  function showCoverage() {
    const map = mapRef.current;
    if (!map) return;
    const bounds = context.site.coverage.coordinates[0].reduce(
      (box, point) => box.extend([point[0], point[1]]),
      new maplibregl.LngLatBounds(),
    );
    map.fitBounds(bounds, { padding: 70, pitch: mode === '3d' ? 25 : 0, duration: 450 });
  }

  const editing = mode === 'vertices' || mode === 'draw';
  return (
    <section className="map-panel" aria-label="Interactive neighborhood map">
      <div className="map-canvas" ref={mapEl} />
      <div className="map-navigator" aria-label="Map view">
        {editing ? <>
          <button type="button" className={mode === 'vertices' ? 'active' : ''} onClick={() => props.onMode('vertices')} disabled={!loaded}><PencilLine size={16} /> Move vertices</button>
          <button type="button" className={mode === 'draw' ? 'active' : ''} onClick={() => props.onMode('draw')} disabled={!loaded}><Plus size={16} /> Draw new</button>
          <button type="button" className="map-done" onClick={() => props.onMode('3d')} disabled={!loaded}><Check size={16} /> Done</button>
        </> : <>
          <button type="button" className={mode === '3d' ? 'active' : ''} onClick={() => props.onMode('3d')} disabled={!loaded} aria-pressed={mode === '3d'}><Box size={16} /> 3D view</button>
          <button type="button" className={mode === 'plan' ? 'active' : ''} onClick={() => props.onMode('plan')} disabled={!loaded} aria-pressed={mode === 'plan'}><Layers2 size={16} /> Plan</button>
        </>}
      </div>
      {editing && <div className="map-hint" role="status">{editError || (mode === 'draw' ? 'Click to add corners. Click the first corner to finish.' : 'Drag a corner to edit. Drag a midpoint to add a vertex.')}</div>}
      <div className="map-controls" aria-label="Map controls">
        <button type="button" title="Reset north" aria-label="Reset north" onClick={() => mapRef.current?.resetNorth({ duration: 300 })}><Compass size={19} style={{ transform: `rotate(${-bearing}deg)` }} /></button>
        <div className="map-zoom">
          <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}><Plus size={18} /></button>
          <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}><Minus size={18} /></button>
        </div>
        <button type="button" title="Show study coverage" aria-label="Show study coverage" onClick={showCoverage}><LocateFixed size={18} /></button>
      </div>
      <div className="map-legend" aria-label="Map legend">
        <span><i className="legend-key plot-key" /> Scenario parcel</span>
        {envelopeVisible && <span><i className="legend-key envelope-key" /> Floor envelopes</span>}
        {concept && <span><i className="legend-key design-key" /> Selected concept</span>}
        {concept?.planting && <span><i className="legend-key planting-key" /> Planting</span>}
        <span><i className="legend-key road-key" /> Road references</span>
        <span><i className="legend-key coverage-key" /> Study coverage</span>
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
