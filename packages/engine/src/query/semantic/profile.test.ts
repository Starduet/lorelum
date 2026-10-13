import { expect, test } from "bun:test";

import { createEmbeddingProfile } from "./profile";

test("pins the representation-group multi-view Profile identity shape", () => {
  const profile = createEmbeddingProfile({
    encodingId: "a".repeat(64),
    dimensions: 384,
  });

  expect(profile.documentProjectionVersion).toBe(5);
  expect(profile.profileId).toBe(
    "c9b491a1797d29351fbf789f434ed57373c1f17e98c92b7ed07510cfc6c0220b",
  );
});
