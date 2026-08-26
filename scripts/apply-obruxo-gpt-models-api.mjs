#!/usr/bin/env node
/** Apply the `un-` GPT candidates through the authenticated Combo API. */
import Database from "better-sqlite3";

const baseUrl = (process.env.OMNIROUTE_URL ?? "http://127.0.0.1:20128").replace(/\/$/, "");
const password = process.env.INITIAL_PASSWORD;
if (!password) throw new Error("INITIAL_PASSWORD ausente");

const premiumModels = [
  ["un-/gpt-5.5", "UN GPT-5.5 (free promo)", 15],
  ["un-/gpt-5.6-sol", "UN GPT-5.6 Sol (free promo)", 10],
];
const visionModels = [
  ["[VB]-/deepseek-v4-flash", "Verboo DeepSeek V4 Flash"],
  ["[VOID]/deepseek-v4-pro", "VOID DeepSeek V4 Pro"],
  ["antigravity/gemini-3.6-flash-medium", "Antigravity Gemini 3.6 Flash Medium"],
];
const removedVisionModels = new Set(["nvidia/meta/llama-3.2-11b-vision-instruct"]);

const login = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password }),
});
if (!login.ok) throw new Error(`login falhou: ${login.status}`);
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
if (!cookie) throw new Error("sessao nao retornada");

const list = await fetch(`${baseUrl}/api/combos?limit=100`, { headers: { cookie } });
if (!list.ok) throw new Error(`listagem falhou: ${list.status}`);
const payload = await list.json();
const db = new Database(process.env.DATABASE_PATH ?? "/app/data/storage.sqlite", {
  readonly: true,
});
const comboIds = new Map(
  db
    .prepare("SELECT name, id FROM combos")
    .all()
    .map((row) => [row.name, row.id])
);
db.close();

for (const [name, free] of [
  ["obruxo", false],
  ["obruxo-free", true],
]) {
  const combo = payload.combos?.find((item) => item.name === name);
  if (!combo) throw new Error(`combo nao encontrado: ${name}`);
  const comboId = combo.id ?? comboIds.get(name);
  if (!comboId) throw new Error(`id nao encontrado: ${name}`);
  let models = Array.isArray(combo.models) ? combo.models.map((item) => ({ ...item })) : [];
  const premiumIds = new Set(premiumModels.map(([model]) => model));
  if (free) {
    // The free route must remain compatible with its 1M-context contract.
    models = models.filter((item) => !premiumIds.has(item.model));
  }
  const basePriority = Math.max(
    0,
    ...models
      .filter((item) => !premiumIds.has(item.model))
      .map((item) => (Number.isFinite(item.priority) ? item.priority : 0))
  );

  if (!free) {
    for (let index = 0; index < premiumModels.length; index += 1) {
      const [model, label, weight] = premiumModels[index];
      const existing = models.find((item) => item.model === model);
      if (existing) {
        if (existing.label !== label) {
          existing.label = label;
        }
        continue;
      }
      models.push({ model, label, weight });
    }
  }

  const update = await fetch(`${baseUrl}/api/combos/${encodeURIComponent(comboId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ models }),
  });
  if (!update.ok) {
    throw new Error(
      `${name} update falhou: ${update.status} ${(await update.text()).slice(0, 300)}`
    );
  }
  console.log(`${name}: atualizado`);
}

const specialized = ["vision-free-mid", "vision-free-high", "vision-free-xhigh"];
for (const name of specialized) {
  let combo = payload.combos?.find((item) => item.name === name);
  if (!combo) {
    const created = await fetch(`${baseUrl}/api/combos`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name,
        description: `BRUXO Free Vision — ${name.split("-").at(-1).toUpperCase()}`,
        strategy: "priority",
        context_length: 1_000_000,
        models: visionModels.map(([model, label]) => ({ model, label, weight: 0 })),
      }),
    });
    if (!created.ok) {
      throw new Error(
        `${name} create falhou: ${created.status} ${(await created.text()).slice(0, 300)}`
      );
    }
    combo = await created.json();
    console.log(`${name}: criado`);
  }
  const comboId = combo.id ?? comboIds.get(name);
  if (!comboId) throw new Error(`id nao encontrado: ${name}`);
  const models = Array.isArray(combo.models) ? combo.models.map((item) => ({ ...item })) : [];
  const ordered = [
    ...visionModels.map(([model, label], index) => ({
      id: `${name}-vision-${index + 1}`,
      kind: "model",
      model,
      label,
      priority: index + 1,
      weight: 0,
    })),
    ...models.filter(
      (item) =>
        !visionModels.some(([model]) => model === item.model) &&
        !removedVisionModels.has(item.model)
    ),
  ];
  const update = await fetch(`${baseUrl}/api/combos/${encodeURIComponent(comboId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ models: ordered }),
  });
  if (!update.ok) {
    throw new Error(
      `${name} update falhou: ${update.status} ${(await update.text()).slice(0, 300)}`
    );
  }
  console.log(`${name}: atualizado`);
}

const bruxoConfigResponse = await fetch(`${baseUrl}/api/obruxo/config`, { headers: { cookie } });
if (!bruxoConfigResponse.ok) {
  throw new Error(`config bruxo falhou: ${bruxoConfigResponse.status}`);
}
const bruxoPayload = await bruxoConfigResponse.json();
const config = bruxoPayload.config;
if (!config || typeof config !== "object") throw new Error("config bruxo ausente");
config.entryRoutes ??= {};
config.entryRoutes["obruxo-free"] ??= {};
config.entryRoutes["obruxo-free"].vision = {
  mid: "vision-free-mid",
  high: "vision-free-high",
  xhigh: "vision-free-xhigh",
};
const configUpdate = await fetch(`${baseUrl}/api/obruxo/config`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ config, expectedRevision: bruxoPayload.revision }),
});
if (!configUpdate.ok) {
  throw new Error(
    `config bruxo update falhou: ${configUpdate.status} ${(await configUpdate.text()).slice(0, 300)}`
  );
}
console.log("obruxo-free: rota vision atualizada");
