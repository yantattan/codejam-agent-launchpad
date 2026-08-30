import { describe, expect, it } from "vitest";
import { UnconfiguredVerifier } from "./auth.js";

describe("UnconfiguredVerifier", () => {
  it("fails closed when Supabase is not configured", async () => {
    const verifier = new UnconfiguredVerifier();
    expect(await verifier.verify("any-token")).toBeNull();
    expect(await verifier.verify("")).toBeNull();
  });
});
