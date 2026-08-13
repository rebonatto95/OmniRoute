/**
 * Codex reasoning tiers `max` / `ultra` inherited the global 90s header timeout.
 *
 * `#6354` gave the reasoning-heavy tiers extra room to return response headers
 * ("more header-wait room than the global default"), but the override landed on
 * a contiguous slice of the effort ladder — `high` and `xhigh` — instead of
 * "high and above". `max` and `ultra` reason MORE than `xhigh`, so they are the
 * tiers that need the room most, and they were left on
 * `DEFAULT_FETCH_TIMEOUT_MS` (90_000).
 *
 * Operator symptom: `GPT TERRA [MAX]` "takes much longer" than `[XHIGH]` in real
 * use. A slow `max` blows the 90s header budget, is scored as a target failure,
 * and the combo falls through / retries — so the client pays the wasted 90s plus
 * the second attempt. It reads as latency, not as an error.
 *
 * The assertion is ordinal on purpose: any effort tier at `high` or above must
 * carry the extended timeout. A per-id allowlist would re-open the same hole the
 * next time a tier is added above `ultra`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { codexProvider } from "../../open-sse/config/providers/registry/codex/index.ts";
import { REASONING_HEAVY_TIMEOUT_MS } from "../../open-sse/config/providers/registry/codex/index.ts";

/** Effort ladder, ascending. Tiers at or above `high` are reasoning-heavy. */
const EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
const REASONING_HEAVY_FLOOR = EFFORT_LADDER.indexOf("high");

type CodexModel = { id: string; timeoutMs?: number };

const models = (codexProvider.models ?? []) as CodexModel[];

/** Trailing effort suffix of a model id, or null when it carries none. */
function effortOf(id: string): (typeof EFFORT_LADDER)[number] | null {
  for (const tier of EFFORT_LADDER) {
    if (id.endsWith(`-${tier}`)) return tier;
  }
  return null;
}

test("registry actually exposes models", () => {
  assert.ok(models.length > 0, "codexProvider.models is empty — test would vacuously pass");
});

test("every effort tier at `high` or above carries the extended header timeout", () => {
  const offenders: string[] = [];

  for (const model of models) {
    const effort = effortOf(model.id);
    if (!effort) continue;
    if (EFFORT_LADDER.indexOf(effort) < REASONING_HEAVY_FLOOR) continue;

    if (model.timeoutMs !== REASONING_HEAVY_TIMEOUT_MS) {
      offenders.push(`${model.id} (effort=${effort}, timeoutMs=${model.timeoutMs ?? "unset"})`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `reasoning-heavy tiers missing timeoutMs=${REASONING_HEAVY_TIMEOUT_MS}:\n  ${offenders.join("\n  ")}`
  );
});

test("light tiers keep the global default — the override is not blanket", () => {
  for (const model of models) {
    const effort = effortOf(model.id);
    if (!effort) continue;
    if (EFFORT_LADDER.indexOf(effort) >= REASONING_HEAVY_FLOOR) continue;

    assert.equal(
      model.timeoutMs,
      undefined,
      `${model.id} (effort=${effort}) should inherit the global fetch timeout, not override it`
    );
  }
});

test("the five ids from the report are covered", () => {
  // Regression anchors: these are the exact models the operator's combos fall
  // back to, and the ones measured as unset on release/v3.8.50.
  const reported = [
    "gpt-5.6-terra-max",
    "gpt-5.6-terra-ultra",
    "gpt-5.6-sol-max",
    "gpt-5.6-sol-ultra",
    "gpt-5.6-luna-max",
  ];

  for (const id of reported) {
    const model = models.find((m) => m.id === id);
    assert.ok(model, `${id} vanished from the registry — update this test deliberately`);
    assert.equal(model.timeoutMs, REASONING_HEAVY_TIMEOUT_MS, `${id} lost its extended timeout`);
  }
});

test("xhigh and high did not regress", () => {
  for (const id of ["gpt-5.6-terra-xhigh", "gpt-5.6-terra-high", "gpt-5.5-xhigh"]) {
    const model = models.find((m) => m.id === id);
    assert.ok(model, `${id} missing from registry`);
    assert.equal(model.timeoutMs, REASONING_HEAVY_TIMEOUT_MS);
  }
});
