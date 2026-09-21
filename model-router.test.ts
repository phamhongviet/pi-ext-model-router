import assert from "node:assert/strict";
import test from "node:test";

import { routeByProbability } from "./model-router.ts";

test("routes on cumulative escalation probability instead of top choice", () => {
  assert.equal(
    routeByProbability({
      "gpt-6-astra": 0.42,
      "gpt-5.6-terra": 0.27,
      "gpt-5.6-sol": 0.19,
      "gpt-5.6-luna": 0.12,
    }),
    "gpt-5.6-terra",
  );
  assert.equal(
    routeByProbability({
      "gpt-6-astra": 0.76,
      "gpt-5.6-terra": 0.08,
      "gpt-5.6-sol": 0.08,
      "gpt-5.6-luna": 0.08,
    }),
    "gpt-6-astra",
  );
  assert.equal(
    routeByProbability({
      "gpt-6-astra": 0.35,
      "gpt-5.6-terra": 0.1,
      "gpt-5.6-sol": 0.3,
      "gpt-5.6-luna": 0.25,
    }),
    "gpt-5.6-sol",
  );
  assert.equal(
    routeByProbability({
      "gpt-6-astra": 0.1,
      "gpt-5.6-terra": 0.1,
      "gpt-5.6-sol": 0.1,
      "gpt-5.6-luna": 0.7,
    }),
    "gpt-5.6-luna",
  );
});
