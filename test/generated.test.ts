// The generated layer read against what it was generated from: the API
// version, and field types that accept values added after a release.

import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { parse } from "yaml";
import type { Call, CallOutcome, ErrorDetail, RefusedCall, RefusedCallSummary } from "../src/index.js";
import { API_VERSION } from "../src/index.js";

const spec = parse(readFileSync(new URL("../openapi/talki-v1.yaml", import.meta.url), "utf8")) as {
  info: { version: string };
};

describe("the generated types", () => {
  it("send the spec's version", () => {
    expect(API_VERSION).toBe(spec.info.version);
  });

  it("take a value added later to an extensible enum, and still suggest the listed ones", () => {
    expectTypeOf<"value_added_later">().toExtend<NonNullable<Call["outcome"]>>();
    expectTypeOf<"booked">().toExtend<NonNullable<Call["outcome"]>>();
    expectTypeOf<null>().toExtend<Call["outcome"]>();
    expectTypeOf<"value_added_later">().toExtend<RefusedCall["reason"]>();
    expectTypeOf<"value_added_later">().toExtend<RefusedCallSummary["actions"][number]>();
  });

  it("keep a closed enum closed", () => {
    expectTypeOf<CallOutcome>().toEqualTypeOf<
      "booked" | "rescheduled" | "cancelled" | "transferred" | "unresolved" | "info"
    >();
    expectTypeOf<"value_added_later">().not.toExtend<CallOutcome>();
    expectTypeOf<ErrorDetail["type"]>().toExtend<string>();
  });

  it("keep dates as ISO strings", () => {
    expectTypeOf<Call["started_at"]>().toEqualTypeOf<string>();
  });
});
