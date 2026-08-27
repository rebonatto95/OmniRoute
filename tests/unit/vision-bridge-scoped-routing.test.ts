import assert from "node:assert/strict";
import test from "node:test";

import { VisionBridgeGuardrail } from "../../src/lib/guardrails/visionBridge.ts";

function imageBody(model: string) {
  return {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: "https://example.com/image.png" } },
        ],
      },
    ],
  };
}

test("BRUXO entries are not rerouted before the master router resolves them", async () => {
  let bridgeCalls = 0;
  const guardrail = new VisionBridgeGuardrail({
    enabled: true,
    deps: {
      getSettings: async () => ({ visionBridgeEnabled: true }),
      callVisionModel: async () => {
        bridgeCalls += 1;
        return "description";
      },
    },
  });

  const result = await guardrail.preCall(imageBody("obruxo-free"), {
    model: "obruxo-free",
  });

  assert.equal(result.modifiedPayload, undefined);
  assert.equal(bridgeCalls, 0);
});

test("free BRUXO routes honor the configured Vision Bridge model before free fallbacks", async () => {
  let selectedModel = "";
  let allowedModels: string[] | undefined;
  const guardrail = new VisionBridgeGuardrail({
    enabled: true,
    deps: {
      getSettings: async () => ({
        visionBridgeEnabled: true,
        visionBridgeModel: "[VB]-/minimax-m3",
      }),
      checkModelHasComboMapping: async () => true,
      callVisionModel: async (_image, config, _apiKey, routerConfig) => {
        selectedModel = config.model;
        allowedModels = routerConfig?.allowedModels;
        return "description";
      },
    },
  });

  const result = await guardrail.preCall(imageBody("coder-free-high"), {
    model: "coder-free-high",
    routingEntryModel: "obruxo-free",
  });

  assert.ok(result.modifiedPayload);
  assert.equal(selectedModel, "[VB]-/minimax-m3");
  assert.deepEqual(allowedModels, ["[VB]-/minimax-m3", "un-/gpt-5.5", "un-/gpt-5.6-sol"]);
});
