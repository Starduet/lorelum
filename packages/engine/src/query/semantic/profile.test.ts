import { expect, test } from "bun:test";

import { createEmbeddingProfile } from "./profile";

test("pins the representation-group multi-view Profile identity shape", () => {
  const profile = createEmbeddingProfile({
    encodingId: "a".repeat(64),
    dimensions: 384,
  });

  expect(profile.documentProjectionVersion).toBe(4);
  expect(profile.profileId).toBe(
    "58102707e73827188baac74c285066e0ae9a6c11a27a662751d89e4c2e7caaef",
  );
});
