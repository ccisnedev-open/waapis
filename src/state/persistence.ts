import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { SimulatorState } from './simulator-state.js';
import type { SimulatorStateSnapshot } from './simulator-state.js';

/**
 * Reads persisted simulator state from a JSON file.
 * Returns a fresh SimulatorState if the file is missing or corrupted.
 */
export function loadState(filePath: string): SimulatorState {
  if (!existsSync(filePath)) {
    return new SimulatorState();
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const snapshot: SimulatorStateSnapshot = JSON.parse(raw);
    return SimulatorState.fromJSON(snapshot);
  } catch {
    // Corrupted file — start fresh rather than crashing
    return new SimulatorState();
  }
}

/** Writes the current simulator state to a JSON file (atomic-ish for a single process). */
export function saveState(state: SimulatorState, filePath: string): void {
  const json = JSON.stringify(state.toJSON(), null, 2);
  writeFileSync(filePath, json, 'utf-8');
}
