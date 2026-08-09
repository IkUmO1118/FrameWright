import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isWaveformEntryFresh,
  referencedBinNames,
  WAVEFORM_GENERATION,
  waveformBinName,
} from "../src/lib/waveformCache.ts";
import type { WaveformEntry, WaveformEntryKey, WaveformIndex } from "../src/lib/waveformCache.ts";

function key(overrides: Partial<WaveformEntryKey> = {}): WaveformEntryKey {
  return {
    generation: WAVEFORM_GENERATION,
    source: "materials/a.mp4",
    mtimeMs: 1234.5,
    size: 98765,
    rate: 100,
    ...overrides,
  };
}

function entry(entryKey: WaveformEntryKey = key()): WaveformEntry {
  return {
    key: entryKey,
    durationSec: 12.34,
    bins: 1234,
    file: `timeline.probe/waveform/${waveformBinName(entryKey)}`,
  };
}

test("waveformBinName: 同じ key から同じ名前が出る", () => {
  assert.equal(waveformBinName(key()), waveformBinName(key()));
  assert.match(waveformBinName(key()), /^[0-9a-f]{16}\.bin$/);
});

test("waveformBinName: key が 1 フィールド違えば名前が変わる", () => {
  const base = waveformBinName(key());
  for (const changed of [
    key({ generation: WAVEFORM_GENERATION + 1 }),
    key({ source: "materials/b.mp4" }),
    key({ mtimeMs: 1234.6 }),
    key({ size: 98766 }),
    key({ rate: 50 }),
  ]) {
    assert.notEqual(waveformBinName(changed), base);
  }
});

test("isWaveformEntryFresh: 完全一致だけを fresh と判定する", () => {
  const current = key();
  assert.equal(isWaveformEntryFresh(undefined, current), false);
  assert.equal(isWaveformEntryFresh(entry(key({ size: 1 })), current), false);
  assert.equal(isWaveformEntryFresh(entry(current), current), true);
});

test("referencedBinNames: bins=0 の entry は file を持たないので集合に入らない", () => {
  const audioKey = key();
  const index: WaveformIndex = {
    generation: WAVEFORM_GENERATION,
    entries: {
      "": {
        key: key({ source: "" }),
        durationSec: 0,
        bins: 0,
      },
      "materials/a.mp4": entry(audioKey),
    },
  };
  assert.deepEqual(referencedBinNames(index), new Set([waveformBinName(audioKey)]));
});
