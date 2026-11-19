import { mkdir, readdir, readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { Polygon } from 'geojson';
import proj4 from 'proj4';
import type { CalculateResponse, ScenarioInput } from '../../src/engine/types';

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
  const prefix = process.env.FEASIBILITY_URL ? 'live' : 'candidate';
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: `artifacts/${prefix}-${name}.png`, animations: 'disabled' });
}

test('production Worker projects, clips, rejects invalid geometry, and measures recalculation', async ({ page }) => {
  const workerFile = (await readdir('dist/assets')).find((file) => /^geometry\.worker-.+\.js$/.test(file));
  expect(workerFile, 'built geometry Worker asset').toBeTruthy();
  const site = JSON.parse(await readFile('public/data/site.json', 'utf8'));
  const preset: ScenarioInput = {
    ...syntheticBase,
    plot: site.parcel,
    road: {
      name: site.road.name,
      centerline: site.road.centerline,
      widthM: site.road.width,
      baselineWidthM: site.road.width,
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
  const workerAsset = await page.request.get(`/assets/${workerFile}`);
  expect(workerAsset.ok()).toBe(true);
  expect(await workerAsset.text()).toContain('WebAssembly');
  // Navigate to a simple same-origin asset so only the measured Worker is running.
  await page.goto('/data/manifest.json');
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
  }, { path: `/assets/${workerFile}`, fixtures, preset });
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
  const response = await page.goto('/');
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
    expect(resources.has(pathname), pathname).toBe(true);
  }
  await page.getByTestId('concept-wide').click();
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
  await page.getByTestId('edit-plot').click();
  await page.getByRole('button', { name: 'Draw new' }).click();
  await page.waitForTimeout(350);
  const mapBounds = await page.getByTestId('site-map').locator('canvas.maplibregl-canvas').boundingBox();
  expect(mapBounds).toBeTruthy();
  const drawPoints = [[0.43, 0.47], [0.525, 0.47], [0.527, 0.54], [0.46, 0.53], [0.43, 0.54], [0.43, 0.47]];
  for (const [x, y] of drawPoints) {
    await page.mouse.click(mapBounds!.x + mapBounds!.width * x, mapBounds!.y + mapBounds!.height * y);
    await page.waitForTimeout(100);
  }
  await expect(parcelMetric).not.toHaveText(baseline);
  await expect(result, 'new plot adjoining the modeled road').toHaveAttribute('data-state', 'valid');
  const drawnArea = await parcelMetric.innerText();
  const [vertexX, vertexY] = drawPoints[0];
  const x = mapBounds!.x + mapBounds!.width * vertexX;
  const y = mapBounds!.y + mapBounds!.height * vertexY;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 18, y - 5, { steps: 8 });
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
  await page.goto('/');
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
