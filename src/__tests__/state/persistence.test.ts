import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadState, saveState } from '../../state/persistence.js';
import { SimulatorState } from '../../state/simulator-state.js';

describe('persistence', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `wa_api_test_${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    tempFile = join(tempDir, 'state.json');
  });

  afterEach(() => {
    if (existsSync(tempFile)) unlinkSync(tempFile);
  });

  it('returns a fresh SimulatorState when file does not exist', () => {
    const state = loadState(tempFile);

    expect(state).toBeInstanceOf(SimulatorState);
    expect(state.isWithin24hWindow('any')).toBe(false);
  });

  it('saves state to file and loads it back', () => {
    const state = new SimulatorState();
    state.recordInbound('51999000001', Date.now());

    saveState(state, tempFile);

    expect(existsSync(tempFile)).toBe(true);

    const loaded = loadState(tempFile);
    expect(loaded.isWithin24hWindow('51999000001')).toBe(true);
  });

  it('handles corrupted JSON file gracefully', () => {
    writeFileSync(tempFile, '{invalid json!!!', 'utf-8');

    const state = loadState(tempFile);

    // Should return a fresh state instead of crashing
    expect(state).toBeInstanceOf(SimulatorState);
  });
});
