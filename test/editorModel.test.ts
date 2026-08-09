import { test } from "node:test";
import assert from "node:assert/strict";

import { trackHeightFor } from "../editor/client/model.ts";

test("trackHeightFor: cutAudio は BGM と同じ音声トラック高", () => {
  assert.equal(trackHeightFor("cutAudio"), trackHeightFor("bgm"));
});
