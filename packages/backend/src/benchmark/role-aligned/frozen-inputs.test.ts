import { expect, test } from "bun:test";

import { EMBEDDING_MODEL } from "../../modules/embedding/model";
import { FROZEN_CONTROL_INPUTS } from "./frozen-inputs";

test("the frozen model pin is the model the production runtime requires", () => {
  expect(FROZEN_CONTROL_INPUTS.modelSha256).toBe(EMBEDDING_MODEL.sha256);
  expect(FROZEN_CONTROL_INPUTS.modelBytes).toBe(EMBEDDING_MODEL.bytes);
  expect(FROZEN_CONTROL_INPUTS.dimensions).toBe(EMBEDDING_MODEL.dimensions);
});
