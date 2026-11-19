import { calculateScenario } from './engine';
import type { CalculateRequest, CalculateResponse } from './engine/types';

let latest: CalculateRequest | undefined;
let calculating = false;

async function processQueue() {
  if (calculating) return;
  calculating = true;
  try {
    while (latest) {
      const { id, input } = latest;
      latest = undefined;
      let response: CalculateResponse;
      try {
        response = { id, result: await calculateScenario(input) };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The geometry engine failed.';
        response = { id, error: message };
      }
      self.postMessage(response);
      // Give pending input events a chance to replace older queued edits.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    calculating = false;
  }
}

self.addEventListener('message', ({ data }: MessageEvent<CalculateRequest>) => {
  latest = data;
  void processQueue();
});
