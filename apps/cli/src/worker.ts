/**
 * Diff worker: runs diffWithTier + narrate off the main thread so
 * CPU-bound tree matching parallelizes across cores on large changesets.
 */

import { diffWithTier } from "@differens/tiers";
import { narrate } from "@differens/narrate";
import type { EditAction } from "@differens/core";

// Minimal WebWorker globals for the worker entry (bun provides them at runtime)
declare const self: {
  onmessage: ((event: { data: DiffJob }) => void) | null;
  postMessage: (msg: DiffResult) => void;
};

export interface DiffJob {
  id: number;
  oldSource: string;
  newSource: string;
  oldPath: string;
  newPath: string;
}

export interface DiffResult {
  id: number;
  actions: EditAction[];
  descriptions: string[];
  fallback?: string;
  tier: number;
}

// bun's worker entry runs the module; the message handler is the contract
if (typeof self !== "undefined") {
  self.onmessage = (event: { data: DiffJob }): void => {
    const { id, oldSource, newSource, oldPath, newPath } = event.data;
    try {
      const result = diffWithTier(oldSource, newSource, oldPath, newPath);
      const changes = narrate(result.changes, { filePath: oldPath });
      const reply: DiffResult = {
        id,
        actions: result.changes,
        descriptions: changes.map((c) => c.description),
        fallback: result.fallback,
        tier: result.tier,
      };
      (self as unknown as { postMessage: (msg: DiffResult) => void }).postMessage(reply);
    } catch (err) {
      const reply: DiffResult = {
        id,
        actions: [],
        descriptions: [],
        fallback: `worker error: ${err instanceof Error ? err.message : String(err)}`,
        tier: -1,
      };
      (self as unknown as { postMessage: (msg: DiffResult) => void }).postMessage(reply);
    }
  };
}
