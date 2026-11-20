import { mkdir, readdir, readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { Polygon } from 'geojson';
import proj4 from 'proj4';
import type { CalculateResponse, ScenarioInput } from '../../src/engine/types';
import { nearbyBuildings, roadsForPlot, type ContextData } from '../../src/context';
import { roadFrame } from '../../src/engine/spatial';

const utm = '+proj=utm +zone=47 +datum=WGS84 +units=m +no_defs';
const origin = proj4('WGS84', utm, [100.5658, 13.7844]);
const point = (x: number, y: number) => proj4(utm, 'WGS84', [origin[0] + x, origin[1] + y]);

function polygon(shell: number[][], ...holes: number[][][]): Polygon {
  return { type: 'Polygon', coordinates: [shell, ...holes].map((ring) => {
    const coordinates = ring.map(([x, y]) => point(x, y));
    return [...coordinates, coordinates[0]];
  }) };
}

const syntheticBase: ScenarioInput = {
  plot: polygon([[6, 0], [36, 0], [36, 27], [6, 27]]),
  profile: 'multifamily',
  redevelopment: 'clear',
  road: {
    name: 'Straight road test fixture',
    centerline: { type: 'LineString', coordinates: [point(0, -50), point(0, 120)] },
    widthM: 11.7,
    widthSource: 'user-override',
    publicStatus: 'assumed',
  },
};

async function capture(page: Page, name: string) {
  const prefix = process.env.FEASIBILITY_URL ? 'v4-live' : 'v4-candidate';
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: `artifacts/${prefix}-${name}.png`, animations: 'disabled' });
}

async function readContext(): Promise<ContextData> {
  const [site, buildings, roads] = await Promise.all(['site.json', 'buildings.geojson', 'roads.geojson'].map(async (name) => JSON.parse(await readFile(`public/data/${name}`, 'utf8'))));
  return { site, buildings, roads };
}

async function worldPixel(page: Page, coordinates: number[]) {
  const map = page.getByTestId('site-map');
  await expect.poll(async () => Math.abs(Number(await map.getAttribute('data-camera-pitch')))).toBeLessThan(0.01);
  await expect.poll(async () => Math.abs(Number(await map.getAttribute('data-camera-bearing')))).toBeLessThan(0.01);
  const canvas = map.locator('canvas.maplibregl-canvas');
  const center = (await map.getAttribute('data-camera-center'))!.split(',').map(Number);
  const zoom = Number(await map.getAttribute('data-camera-zoom'));
  expect(Number(await map.getAttribute('data-camera-pitch'))).toBeCloseTo(0, 2);
  expect(Number(await map.getAttribute('data-camera-bearing'))).toBeCloseTo(0, 2);
  const mapBounds = (await canvas.boundingBox())!;
  const mercator = ([lon, lat]: number[]) => [(lon + 180) / 360, (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2];
  const [cx, cy] = mercator(center);
  const [x, y] = mercator(coordinates);
  const size = 512 * 2 ** zoom;
  return { x: mapBounds.x + mapBounds.width / 2 + (x - cx) * size, y: mapBounds.y + mapBounds.height / 2 + (y - cy) * size };
}

async function drawRing(page: Page, ring: number[][]) {
  for (const corner of ring) {
    const { x, y } = await worldPixel(page, corner);
    await page.mouse.click(x, y);
    await page.waitForTimeout(70);
  }
}

test('production Worker projects, clips, rejects invalid geometry, and measures recalculation', async ({ page }) => {
  const workerFile = (await readdir('dist/assets')).find((file) => /^geometry\.worker-.+\.js$/.test(file));
  expect(workerFile, 'built geometry Worker asset').toBeTruthy();
  const context = await readContext();
  const { site } = context;
  const roads = roadsForPlot(site.parcel, context);
  const selected = roads.find(({ wayId }) => String(wayId) === String(site.road.wayId))!;
  const preset: ScenarioInput = {
    ...syntheticBase,
    plot: site.parcel,
    zoneBoundary: site.zoneBoundary,
    contextCoverage: site.coverage,
    screeningCoverage: site.screeningCoverage,
    screeningAreas: site.screeningAreas,
    nearbyRoads: roads.map((road) => ({ id: String(road.wayId), name: road.name, centerline: road.mappedCenterline, widthM: road.width ?? undefined, roadClass: road.roadClass })),
    retainedBuildings: nearbyBuildings(site.parcel, context.buildings),
    road: {
      id: String(selected.wayId), sameRoadIds: selected.sameRoadIds,
      name: site.road.name,
      centerline: site.road.centerline,
      widthM: site.road.width!,
      baselineWidthM: site.road.width!,
      widthSource: 'district-inventory',
      publicStatus: 'documented',
    },
  };
  const fixtures = [
    syntheticBase,
    { ...syntheticBase, plot: polygon([[6, 0], [20, 0], [20, 5], [30, 5], [30, 0], [44, 0], [44, 14], [30, 14], [30, 8], [20, 8], [20, 14], [6, 14]]) },
    { ...syntheticBase, plot: polygon([[6, 0], [8.8, 0], [8.8, 24], [6, 24]]) },
    { ...syntheticBase, plot: polygon([[6, 0], [52, 0], [52, 44], [6, 44]], [[23, 16], [23, 25], [34, 25], [34, 16]]) },
    { ...syntheticBase, plot: polygon([[6, 0], [34, 26], [6, 26], [34, 0]]) },
    preset,
    { ...preset, road: { ...preset.road, widthM: 6, widthSource: 'user-override' as const } },
    { ...preset, road: { ...preset.road, widthM: 2, widthSource: 'user-override' as const } },
    { ...preset, road: { ...preset.road, widthM: 14.7, widthSource: 'user-override' as const } },
  ];
  const workerAsset = await page.request.get(`assets/${workerFile}`);
  expect(workerAsset.ok()).toBe(true);
  expect(await workerAsset.text()).toContain('WebAssembly');
  // Navigate to a simple same-origin asset so only the measured Worker is running.
  await page.goto('data/manifest.json');
  const { outputs, samples, coldMs } = await page.evaluate(async ({ path, fixtures, preset }) => {
    const worker = new Worker(path, { type: 'module' });
    let id = 0;
    function calculate(input: ScenarioInput) {
      return new Promise<CalculateResponse>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<CalculateResponse>) => resolve(event.data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.postMessage({ id: ++id, input });
      });
    }
    try {
      const start = performance.now();
      const outputs = [await calculate(fixtures[0])];
      const coldMs = performance.now() - start;
      for (const fixture of fixtures.slice(1)) outputs.push(await calculate(fixture));
      const samples: { roundtripMs: number; engineMs: number }[] = [];
      for (let index = 0; index < 30; index += 1) {
        const input: ScenarioInput = {
          ...preset,
          profile: index % 3 === 0 ? 'house' : 'multifamily',
          road: { ...preset.road, widthM: [5, 9, 11.7][index % 3], widthSource: 'user-override' },
        };
        const start = performance.now();
        const output = await calculate(input);
        if ('error' in output) throw new Error(output.error);
        samples.push({ roundtripMs: performance.now() - start, engineMs: output.result.elapsedMs });
      }
      return { outputs, samples, coldMs };
    } finally {
      worker.terminate();
    }
  }, { path: new URL(`../assets/${workerFile}`, page.url()).href, fixtures, preset });
  const results = outputs.map((response) => {
    if ('error' in response) throw new Error(response.error);
    return response.result;
  });
  expect(results[0].plotAreaM2).toBeCloseTo(810, 2);
  expect(results[0].envelope.length).toBeGreaterThan(0);
  expect(results[1].envelope.some((floor) => floor.geometry.type === 'MultiPolygon')).toBe(true);
  expect(results[2].envelope).toHaveLength(0);
  expect(results[3].envelope.some(({ geometry }) => geometry.type === 'Polygon' && geometry.coordinates.length > 1)).toBe(true);
  expect(results[4].validation).toBe('invalid');
  expect(results[5].plotAreaM2).toBeCloseTo(828, 2);
  expect(results[5].concepts).toHaveLength(2);
  expect(results[6].plotAreaM2).toBeCloseTo(results[5].plotAreaM2, 4);
  expect(results[6].capacity?.geometricGfaUpperBoundM2).toBeCloseTo(results[5].capacity!.geometricGfaUpperBoundM2, 3);
  expect(results[7].plotAreaM2).toBeCloseTo(results[5].plotAreaM2, 4);
  expect(results[7].capacity?.geometricGfaUpperBoundM2).toBeLessThan(results[5].capacity!.geometricGfaUpperBoundM2);
  expect(results[7].rules.find(({ id }) => id === 'height-plane')?.controls).toBe(true);
  expect(results[8].plotAreaM2).toBeCloseTo(results[5].plotAreaM2, 4);
  expect(results[8].validation).toBe('road-conflict');
  expect(results[8].road?.conflictM2).toBeCloseTo(45, 2);
  expect(results[8].concepts).toHaveLength(0);
  console.log(`Baseline audit ${JSON.stringify({
    boundM2: results[5].boundExplanation?.sumM2,
    stressBoundM2: results[7].boundExplanation?.sumM2,
    search: results[5].search,
    designs: results[5].concepts.map((concept) => ({
      id: concept.id, floors: concept.floors.length, gfaM2: concept.gfaM2,
      coveredM2: concept.coveredM2, openM2: concept.openM2,
      opening: concept.checks.find(({ id }) => id === 'private-national')?.measurement,
      stressGfaM2: results[7].concepts.find(({ id }) => id === concept.id)?.gfaM2,
    })),
  })}`);
  const percentile = (values: number[], p: number) => values.sort((a, b) => a - b)[Math.ceil(p * values.length) - 1];
  const stats = {
    coldMs,
    samples: samples.length,
    roundtripP50Ms: percentile(samples.map((sample) => sample.roundtripMs), 0.5),
    roundtripP95Ms: percentile(samples.map((sample) => sample.roundtripMs), 0.95),
    engineP95Ms: percentile(samples.map((sample) => sample.engineMs), 0.95),
  };
  console.log(`Production Worker timings ${JSON.stringify(stats)}`);
});

test('public-facing map loads real context and updates a scenario in place', async ({ page }) => {
  const errors: string[] = [];
  const resources = new Set<string>();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.ok()) resources.add(new URL(response.url()).pathname);
  });
  const response = await page.goto('');
  expect(response?.ok()).toBe(true);
  const currentUrl = page.url();
  const result = page.getByTestId('result-ready');
  await expect(result).toHaveAttribute('data-state', 'valid');
  await expect(page.getByTestId('site-map').locator('canvas.maplibregl-canvas')).toBeVisible();
  await expect(page.getByTestId('view-plan')).toBeEnabled();
  const graphics = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return { webgl: !!gl, renderer: gl && debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null };
  });
  expect(graphics.webgl).toBe(true);
  if (process.env.FEASIBILITY_HARDWARE_WEBGL === '1') {
    expect(graphics.renderer).toBeTruthy();
    expect(graphics.renderer).not.toMatch(/SwiftShader|software|llvmpipe/i);
  }
  console.log(`WebGL renderer ${graphics.renderer}`);
  console.log(`Initial scenario and map ready ${Math.round(await page.evaluate(() => performance.now()))} ms after navigation`);
  await expect(page.getByTestId('concept-wide')).toBeVisible();
  await expect(page.getByTestId('concept-stepped')).toBeVisible();
  for (const pathname of ['/data/site.json', '/data/buildings.geojson', '/data/roads.geojson']) {
    expect([...resources].some((resource) => resource.endsWith(pathname)), pathname).toBe(true);
  }
  await page.getByTestId('concept-wide').click();
  await expect(page.getByTestId('site-map')).toHaveAttribute('data-envelope-floors', '2');
  await expect(page.getByTestId('site-map')).toHaveAttribute('data-envelope-kind', 'selected');
  await page.waitForTimeout(400);
  await capture(page, 'wide');

  const width = page.getByTestId('road-width');
  await width.fill('6');
  await width.press('Tab');
  await expect(result).toHaveAttribute('data-state', 'valid');
  await expect(width).toHaveValue('6');
  await page.getByTestId('building-profile').selectOption('house');
  await expect(result).toHaveAttribute('data-state', 'valid');
  await page.getByTestId('reset-scenario').click();
  await expect(result).toHaveAttribute('data-state', 'valid');
  await page.getByTestId('concept-stepped').click();
  await expect(page.getByTestId('site-map')).toHaveAttribute('data-envelope-floors', '6');
  await page.waitForTimeout(400);
  await capture(page, 'stepped');
  const canvas = page.getByTestId('site-map').locator('canvas.maplibregl-canvas');
  const beforeZoom = await canvas.screenshot();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.waitForTimeout(500);
  expect((await canvas.screenshot()).equals(beforeZoom)).toBe(false);
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await page.waitForTimeout(500);
  await page.getByTestId('view-plan').click();
  await page.waitForTimeout(400);

  const parcelMetric = page.getByRole('complementary', { name: 'Scenario analysis' })
    .getByText('Scenario parcel', { exact: true }).locator('..');
  const baseline = await parcelMetric.innerText();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.waitForTimeout(500);
  await page.getByTestId('edit-plot').click();
  await page.getByRole('button', { name: 'Draw new' }).click();
  await page.waitForTimeout(350);
  const { site } = await readContext();
  const drawPoints = site.parcel.coordinates[0].map((corner, index) => index === 2 ? [corner[0] - 0.000015, corner[1]] : corner);
  await drawRing(page, drawPoints);
  await expect(parcelMetric).not.toHaveText(baseline);
  await expect(result, 'new plot adjoining the modeled road').toHaveAttribute('data-state', 'valid');
  const drawnArea = await parcelMetric.innerText();
  const { x, y } = await worldPixel(page, drawPoints[2]);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 7, y - 5, { steps: 8 });
  await page.mouse.up();
  await expect(parcelMetric).not.toHaveText(drawnArea);
  await expect(result, 'edited irregular plot adjoining the modeled road').toHaveAttribute('data-state', 'valid');
  await capture(page, 'edited-parcel');
  await page.getByTestId('reset-scenario').click();
  await expect(result).toHaveAttribute('data-state', 'valid');
  await page.getByTestId('view-3d').click();
  await expect(page.getByTestId('site-map').locator('canvas.maplibregl-canvas')).toBeVisible();
  await page.getByTestId('footprints-toggle').check();
  await expect(page.getByTestId('footprints-toggle')).toBeChecked();
  await page.getByTestId('footprints-toggle').uncheck();
  const mapPanel = page.getByTestId('site-map');
  const beforeRules = await mapPanel.boundingBox();
  await page.getByRole('tab', { name: 'Rules & evidence' }).click();
  await expect(page.getByText('Regulatory FAR ceiling', { exact: false })).toBeVisible();
  const farRule = page.getByText('Floor area ratio', { exact: true });
  await farRule.click();
  await expect(farRule.locator('xpath=ancestor::details').getByRole('link'))
    .toHaveAttribute('href', /download\.asa\.or\.th.*mr56-bma\.pdf/);
  await page.getByText('Regulatory FAR ceiling', { exact: false }).scrollIntoViewIfNeeded();
  expect(await mapPanel.boundingBox()).toEqual(beforeRules);
  await page.waitForTimeout(500);
  await capture(page, 'capacity');
  expect(page.url()).toBe(currentUrl);
  expect(errors).toEqual([]);
});

test('three separated zone locations load the actual facing road, edit in plan, and validate both concepts', async ({ page }) => {
  test.setTimeout(120_000);
  const context = await readContext();
  const examples = context.site.examples!;
  expect(examples).toHaveLength(3);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('');
  const originalUrl = page.url();
  const result = page.getByTestId('result-ready');
  const map = page.getByTestId('site-map');
  const roadSelect = page.getByTestId('road-select');
  await expect(result).toHaveAttribute('data-state', 'valid');
  const metrics = page.getByTestId('scenario-metrics');
  for (const example of examples) {
    await page.getByRole('tab', { name: 'Scenario' }).click();
    const oldId = await result.getAttribute('data-request-id');
    await page.getByTestId('road-location').selectOption(`example:${example.id}`);
    await page.getByTestId('load-location-example').click();
    await expect(result).not.toHaveAttribute('data-request-id', oldId!);
    await expect(result).toHaveAttribute('data-state', 'valid');
    await expect(result).toHaveAttribute('data-zone', 'inside');
    const roads = roadsForPlot(example.parcel, context);
    const selected = roads.find(({ wayId }) => String(wayId) === String(example.roadId))!;
    const other = roads.find(({ key }) => key !== selected.key)!;
    await expect(roadSelect).toHaveValue(selected.key);

    // Selecting an actual neighboring mapped road must invalidate the previous road result.
    await roadSelect.selectOption(other.key);
    await expect(roadSelect).toHaveValue(other.key);
    await expect(result).toHaveAttribute('data-road-id', other.key);
    await roadSelect.selectOption(selected.key);
    await page.getByTestId('road-width').fill(String(example.widthM));
    await expect(result).toHaveAttribute('data-road-id', selected.key);
    await expect(result).toHaveAttribute('data-state', 'valid');
    await expect(map).toHaveAttribute('data-request-id', (await result.getAttribute('data-request-id'))!);
    await expect(map).toHaveAttribute('data-road-id', selected.key);
    expect(Number(await map.getAttribute('data-context-buildings'))).toBe(context.buildings.features.length);
    expect(Number(await map.getAttribute('data-context-roads'))).toBe(context.roads.features.length);
    await expect(page.getByTestId('concept-wide')).toBeEnabled();
    await expect(page.getByTestId('concept-stepped')).toBeEnabled();

    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.waitForTimeout(500);
    await page.getByTestId('edit-plot').click();
    await page.waitForTimeout(350);
    const frame = roadFrame(example.parcel, { name: selected.name, centerline: selected.centerline, widthM: example.widthM, widthSource: 'user-override' });
    const vertex = example.parcel.coordinates[0].slice(1, -1).reduce((best, point) => frame.toLocal(point)[0] > frame.toLocal(best)[0] ? point : best);
    const before = await metrics.innerText();
    const beforeEdit = await result.getAttribute('data-request-id');
    const from = await worldPixel(page, vertex);
    const [vx, vy] = frame.toLocal(vertex);
    const to = await worldPixel(page, frame.toWorld([vx + 1.5, vy]));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await expect(result).not.toHaveAttribute('data-request-id', beforeEdit!);
    await expect(result).toHaveAttribute('data-state', 'valid');
    await expect(metrics).not.toHaveText(before);
    await expect(page.getByTestId('concept-wide')).toBeEnabled();
    await expect(page.getByTestId('concept-stepped')).toBeEnabled();
    await expect(map).toHaveAttribute('data-request-id', (await result.getAttribute('data-request-id'))!);
    await capture(page, `${example.id}-edited`);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByTestId('concept-wide').click();
    await expect(map).toHaveAttribute('data-concept-id', 'wide');
    const wide = await page.getByTestId('concept-wide').innerText();
    await page.waitForTimeout(500);
    await capture(page, `${example.id}-wide`);
    await page.getByTestId('concept-stepped').click();
    await expect(map).toHaveAttribute('data-concept-id', 'stepped');
    const alternative = await page.getByTestId('concept-stepped').innerText();
    await page.waitForTimeout(400);
    await capture(page, `${example.id}-alternative`);
    await page.getByRole('tab', { name: 'Rules & evidence' }).click();
    await expect(page.getByTestId('design-rules')).toHaveAttribute('data-concept-id', 'stepped');
    const containment = page.getByText('Containment in the applicable floor slices', { exact: true }).locator('..');
    await expect(containment).toContainText('Pass');
    await page.getByTestId('selected-envelope-explanation').locator('summary').click();
    await expect(page.getByTestId('selected-envelope-explanation')).toContainText('floor');
    await page.getByTestId('design-floor-schedule').locator('summary').click();
    await expect(page.getByTestId('evidence-rules')).toContainText('Review');
    await capture(page, `${example.id}-checks`);
    console.log(`Geography browser ${example.id} ${JSON.stringify({ road: selected.name, widthM: example.widthM, metrics: await metrics.innerText(), wide, alternative, roundtripMs: await result.getAttribute('data-roundtrip-ms') })}`);
    expect(page.url()).toBe(originalUrl);
  }
  // Draw wholly outside the northern zone boundary without a reload. Zone status must win over road selection.
  await page.getByRole('tab', { name: 'Scenario' }).click();
  await page.getByTestId('road-location').selectOption('example:north');
  await page.getByTestId('load-location-example').click();
  await expect(result).toHaveAttribute('data-state', 'valid');
  await expect.poll(async () => Number((await map.getAttribute('data-camera-center'))!.split(',')[1])).toBeCloseTo(examples.find(({ id }) => id === 'north')!.camera.center[1], 5);
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await page.waitForTimeout(500);
  await page.getByTestId('draw-new-plot').click();
  await page.waitForTimeout(350);
  const north = Math.max(...context.site.zoneBoundary!.coordinates.flat(context.site.zoneBoundary!.type === 'Polygon' ? 1 : 2).map((coordinate) => (coordinate as number[])[1]));
  const lon = examples.find(({ id }) => id === 'north')!.camera.center[0];
  const outside = [[lon - .00015, north + .00012], [lon + .00015, north + .00012], [lon + .00015, north + .00028], [lon - .00015, north + .00028], [lon - .00015, north + .00012]];
  await drawRing(page, outside);
  await expect(result).toHaveAttribute('data-state', 'outside-zone');
  await expect(result).toHaveAttribute('data-zone', 'outside');
  await expect(page.getByTestId('concept-wide')).toBeDisabled();
  await capture(page, 'outside-zone');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByTestId('road-location').selectOption('example:east');
  await page.getByTestId('load-location-example').click();
  await expect(result).toHaveAttribute('data-state', 'valid');
  await page.getByTestId('road-width').fill('');
  await expect(result).toHaveAttribute('data-state', 'unsupported-site');
  await expect(result).toHaveAttribute('data-zone', 'inside');
  await expect(page.getByTestId('concept-wide')).toBeDisabled();
  await capture(page, 'unsupported-site');
  await page.getByTestId('road-width').fill('8');
  await expect(result).toHaveAttribute('data-state', 'valid');
  // A mapped-water caution polygon is an actual site condition, separate from missing width.
  await page.getByTestId('view-plan').click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Show chosen zone' }).click();
  await page.waitForTimeout(550);
  const water = [100.56025230809244, 13.77921198275633];
  const at = await worldPixel(page, water);
  const bounds = (await map.locator('canvas.maplibregl-canvas').boundingBox())!;
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.waitForTimeout(500);
  }
  await page.getByTestId('draw-new-plot').click();
  await page.waitForTimeout(350);
  const [wx, wy] = water;
  await drawRing(page, [[wx-.000045, wy-.000045], [wx+.000045, wy-.000045], [wx+.000045, wy+.000045], [wx-.000045, wy+.000045], [wx-.000045, wy-.000045]]);
  await expect(result).toHaveAttribute('data-state', 'unsupported-site');
  await expect(result).toHaveAttribute('data-zone', 'inside');
  await expect(page.getByText(/The plot intersects.*water/i)).toBeVisible();
  await capture(page, 'water-screening');
  expect(errors).toEqual([]);
});

test('rapid edits reject a delayed stale response and recover from a road conflict', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const probe = { held: false, released: false };
    Object.assign(window, { workerResponseProbe: probe });
    window.Worker = class extends NativeWorker {
      private readonly analysisWorker: boolean;
      private holdId: number | undefined;

      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.analysisWorker = String(url).includes('geometry.worker');
        if (!this.analysisWorker) return;
        this.addEventListener('message', (event) => {
          if (event.data?.id !== this.holdId || probe.held) return;
          event.stopImmediatePropagation();
          probe.held = true;
          window.setTimeout(() => {
            this.dispatchEvent(new MessageEvent('message', { data: event.data }));
            probe.released = true;
          }, 3200);
        });
      }

      postMessage(message: unknown, options?: StructuredSerializeOptions) {
        const request = message as { id?: number; input?: { road?: { widthM?: number } } } | null;
        if (this.analysisWorker && request?.input?.road?.widthM === 6) this.holdId = request.id;
        super.postMessage(message, options);
      }
    };
  });
  await page.goto('');
  const result = page.getByTestId('result-ready');
  await expect(result).toHaveAttribute('data-state', 'valid');
  const width = page.getByTestId('road-width');
  await width.fill('6');
  await page.waitForFunction(() => (window as Window & { workerResponseProbe?: { held: boolean } }).workerResponseProbe?.held);
  await width.fill('2');
  await expect(result).toHaveAttribute('data-result-width', '2');
  const currentId = await result.getAttribute('data-request-id');
  expect(currentId).toBeTruthy();
  for (const id of ['site-map', 'scenario-metrics', 'concept-list']) {
    await expect(page.getByTestId(id)).toHaveAttribute('data-request-id', currentId!);
  }
  await page.waitForFunction(() => (window as Window & { workerResponseProbe?: { released: boolean } }).workerResponseProbe?.released);
  await expect(result).toHaveAttribute('data-request-id', currentId!);
  await expect(page.getByTestId('site-map')).toHaveAttribute('data-request-id', currentId!);
  await page.getByRole('tab', { name: 'Rules & evidence' }).click();
  for (const id of ['envelope-rules', 'design-rules', 'evidence-rules']) {
    await expect(page.getByTestId(id)).toHaveAttribute('data-request-id', currentId!);
  }
  await page.getByTestId('bound-explanation').locator('summary').click();
  await page.getByTestId('show-envelope-bound').click();
  await page.getByTestId('bound-explanation').locator('summary').scrollIntoViewIfNeeded();
  await capture(page, 'height-plane-stress');

  await page.getByRole('tab', { name: 'Scenario' }).click();
  await width.fill('14.7');
  await expect(result).toHaveAttribute('data-state', 'road-conflict');
  await expect(page.getByTestId('site-map')).toHaveAttribute('data-result-width', '14.7');
  await expect(page.getByTestId('site-map')).toHaveAttribute('data-envelope-floors', '0');
  await expect(page.getByText(/45\.00 m²/)).toBeVisible();
  await expect(page.getByTestId('scenario-metrics')).toContainText('828');
  await expect(page.getByTestId('concept-wide')).toBeDisabled();
  await expect(page.getByTestId('concept-stepped')).toBeDisabled();
  await page.getByRole('button', { name: /Restore 11\.70 m/ }).click();
  await expect(result).toHaveAttribute('data-state', 'valid');
  await expect(result).toHaveAttribute('data-result-width', '11.7');
  await expect(page.getByTestId('concept-wide')).toBeEnabled();
  await expect(page.getByTestId('concept-stepped')).toBeEnabled();
  await page.getByRole('tab', { name: 'Rules & evidence' }).click();
  await page.getByText('National opening clearance', { exact: true }).click();
  const margin = page.getByTestId('measurement-private-national');
  await expect(margin).toBeVisible();
  await expect(margin).toContainText('0.00001 m');
  await margin.scrollIntoViewIfNeeded();
  await capture(page, 'numerical-checks');
  const schedule = page.getByTestId('design-floor-schedule');
  await schedule.locator('summary').click();
  await page.getByTestId('design-rounding-note').scrollIntoViewIfNeeded();
  await capture(page, 'floor-schedule');
});

test('rapid location, road, profile and plot updates share one current request', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const probe = { held: false, released: false };
    Object.assign(window, { locationResponseProbe: probe });
    window.Worker = class extends NativeWorker {
      private readonly geometry: boolean;
      private holdId?: number;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.geometry = String(url).includes('geometry.worker');
        if (this.geometry) this.addEventListener('message', (event) => {
          if (event.data?.id !== this.holdId || probe.held) return;
          event.stopImmediatePropagation();
          probe.held = true;
          window.setTimeout(() => {
            this.dispatchEvent(new MessageEvent('message', { data: event.data }));
            probe.released = true;
          }, 4500);
        });
      }
      postMessage(message: unknown, options?: StructuredSerializeOptions) {
        const request = message as { id?: number; input?: ScenarioInput };
        if (this.geometry && request.input?.road?.widthM === 6 && !probe.held) this.holdId = request.id;
        super.postMessage(message, options);
      }
    };
  });
  const context = await readContext();
  const east = context.site.examples!.find(({ id }) => id === 'east')!;
  const road = roadsForPlot(east.parcel, context).find(({ wayId }) => wayId === east.roadId)!;
  const alternatives = roadsForPlot(east.parcel, context).filter(({ key }) => key !== road.key);
  await page.goto('');
  const result = page.getByTestId('result-ready');
  const map = page.getByTestId('site-map');
  await expect(result).toHaveAttribute('data-state', 'valid');
  await page.getByTestId('road-width').fill('6');
  await page.waitForFunction(() => (window as Window & { locationResponseProbe?: { held: boolean } }).locationResponseProbe?.held);
  for (const id of ['southwest', 'north', 'east']) {
    await page.getByTestId('road-location').selectOption(`example:${id}`);
    await page.getByTestId('load-location-example').click();
  }
  await page.getByTestId('road-select').selectOption(alternatives[0].key);
  await page.getByTestId('building-profile').selectOption('house');
  await page.getByTestId('road-select').selectOption(road.key);
  await page.getByTestId('road-width').fill(String(east.widthM));
  await expect(result).toHaveAttribute('data-state', 'valid');
  await expect(result).toHaveAttribute('data-road-id', road.key);
  const mapId = await result.getAttribute('data-request-id');
  await expect(map).toHaveAttribute('data-request-id', mapId!);
  await expect(page.getByTestId('scenario-metrics')).toContainText('611');
  await expect(page.getByTestId('concept-wide')).toContainText('floors · 6.4 m');
  await page.waitForFunction(() => (window as Window & { locationResponseProbe?: { released: boolean } }).locationResponseProbe?.released);
  for (const id of ['site-map', 'scenario-metrics', 'concept-list']) await expect(page.getByTestId(id)).toHaveAttribute('data-request-id', mapId!);
  await page.getByRole('tab', { name: 'Rules & evidence' }).click();
  for (const id of ['envelope-rules', 'design-rules', 'evidence-rules']) await expect(page.getByTestId(id)).toHaveAttribute('data-request-id', mapId!);
  await expect(result).toHaveAttribute('data-road-id', road.key);
  expect(Number(await map.getAttribute('data-context-buildings'))).toBe(context.buildings.features.length);
});

test('an unavailable neighborhood asset prevents stale or partial calculations', async ({ page }) => {
  await page.route('**/data/buildings.geojson', (route) => route.abort());
  await page.goto('');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('result-ready')).toHaveCount(0);
  await expect(page.getByTestId('site-map')).toHaveCount(0);
});
