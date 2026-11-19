import { mkdir, readdir, readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
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
  console.log(`Initial scenario and map ready ${Math.round(await page.evaluate(() => performance.now()))} ms after navigation`);
  await expect(page.getByTestId('concept-wide')).toBeVisible();
  await expect(page.getByTestId('concept-stepped')).toBeVisible();
  for (const pathname of ['/data/site.json', '/data/buildings.geojson', '/data/roads.geojson']) {
    expect(resources.has(pathname), pathname).toBe(true);
  }
  await page.getByTestId('concept-wide').click();
  await page.waitForTimeout(400);
  await mkdir('artifacts', { recursive: true });
  const suffix = process.env.FEASIBILITY_URL ? 'public' : 'local';
  await page.screenshot({ path: `artifacts/${suffix}-wide-3d.png`, animations: 'disabled' });

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
  await page.screenshot({ path: `artifacts/${suffix}-stepped-3d.png`, animations: 'disabled' });
  await page.getByTestId('view-plan').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `artifacts/${suffix}-stepped-plan.png`, animations: 'disabled' });

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
  await page.screenshot({ path: `artifacts/${suffix}-capacity-and-rules.png`, animations: 'disabled' });
  expect(page.url()).toBe(currentUrl);
  expect(errors).toEqual([]);
});
