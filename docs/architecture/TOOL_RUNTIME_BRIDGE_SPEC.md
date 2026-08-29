# Tool Runtime / Tool Bridge

Status: especificacao tecnica P0/P1/P2
Data: 2026-08-29
Escopo: desenho e laboratorio; nenhum runtime de producao e ativado por este documento.

## 1. Decisao arquitetural

A primeira implementacao deve usar o modelo hibrido:

- Main Agent continua podendo usar um conjunto pequeno de tools CORE.
- O Main Agent recebe uma tool explicita de delegacao.
- O Tool Broker seleciona um toolset permitido por dominio.
- O Tool Agent executa somente tools server-side autorizadas.
- O Result Reducer devolve conclusao, evidencias e referencias compactas.
- O Main Agent continua sendo o responsavel pela decisao final.

Nao criar `cyber/tool-runtime` como combo tradicional. Combos substituem ou alternam modelos; o Tool Runtime e uma subexecucao explicita e observavel.

## 2. Evidencia atual

Logs de 2026-08-24 a 2026-08-29 indicaram:

- 459 ferramentas distintas oferecidas.
- 8.898 requests com ferramentas nos artefatos analisaveis.
- Media de aproximadamente 18 ferramentas por request.
- Maximo observado de 102 ferramentas por request.
- Mediana estimada de schemas: 2.879 tokens.
- P90 estimado de schemas: 5.222 tokens.
- Maximo estimado: 19.173 tokens.

Esses valores sao estimativas de logs limitados e usam a heuristica do projeto (JSON serializado dividido por 4). Nao sao contagem feita pelo tokenizer de cada provider.

A telemetria atual mede principalmente `offered`. Nao existe ainda um registro duravel confiavel de `called` por nome. A tabela `mcp_tool_audit` esta vazia; `routing_observations` registra apenas sinais agregados de uso de tools.

## 3. Limites da implementacao

### 3.1 Tools client-side

Tools como `read`, `edit`, `run_code` e parte do Playwright normalmente sao executadas pelo cliente (VS Code/Cursor/agent harness). Um Tool Agent no servidor nao pode chama-las diretamente.

Essas tools so podem entrar no Tool Runtime se existir um executor cliente explicitamente conectado. Na P0 elas ficam fora da delegacao server-side.

### 3.2 Tools server-side

Podem ser candidatas iniciais:

- built-ins do OmniRouter;
- skills registradas com executor server-side;
- MCPs acessiveis pelo processo do OmniRouter;
- consultas read-only a servicos autorizados.

Cada tool deve declarar `execution_owner: server | client` antes de ser elegivel para um toolset.

## 4. Componentes

### 4.1 Main Agent

Recebe:

- contexto da conversa;
- tools CORE selecionadas;
- `delegate_tool_task`;
- opcionalmente `fetch_tool_artifact`.

Nao recebe automaticamente o catalogo inteiro de MCP ou tools DOMAIN/LAZY.

### 4.2 Tool Bridge

Responsabilidades:

- reconhecer a chamada de `delegate_tool_task`;
- gerar `delegation_id`;
- preservar o `main_tool_call_id`;
- iniciar a subexecucao;
- retornar somente o envelope estruturado;
- impedir que o modelo filho substitua o modelo principal.

### 4.3 Tool Broker

Na P0 deve ser deterministico, baseado em:

- dominio declarado;
- nomes e metadados das tools;
- allowlist da API key;
- ownership server-side;
- tamanho maximo do toolset;
- politica de seguranca.

Nao usar um segundo LLM para escolher tools na primeira prova. Isso adicionaria latencia e uma nova fonte de erro antes de sabermos se a reducao funciona.

### 4.4 Tool Agent

Recebe uma sessao curta com:

- tarefa delegada;
- somente o toolset selecionado;
- contexto minimo necessario;
- limites de tempo, chamadas e tokens.

Modelo inicial do laboratorio: `[VB]-/deepseek-v4-flash`.

O Tool Agent nao decide o modelo final da sessao principal e nao deve acessar credenciais ou tools fora do escopo.

### 4.5 Result Reducer

Formato minimo:

```json
{
  "status": "completed",
  "conclusion": "string",
  "evidence": [{ "kind": "file", "ref": "src/x.ts:10-18", "summary": "string" }],
  "artifacts": [],
  "warnings": [],
  "unresolved": [],
  "confidence": 0.0,
  "raw_result_ref": "string"
}
```

Regras:

- limitar tamanho do resultado retornado ao Main Agent;
- preservar referencias recuperaveis;
- nunca descartar silenciosamente erro ou ambiguidade;
- guardar raw output fora do contexto principal quando permitido;
- nao inventar linhas, arquivos, comandos ou evidencias.

## 5. Contrato de IDs

Nunca reutilizar IDs entre a sessao principal e a sessao filha.

```
main_request_id
  -> delegation_id
      -> child_request_id
          -> child_tool_call_id
```

O retorno para o cliente usa somente o `main_tool_call_id` original:

```json
{
  "tool_call_id": "main_call_123",
  "output": {
    "delegation_id": "dlg_123",
    "status": "completed",
    "result": {}
  }
}
```

O mapa deve ser persistido enquanto a delegacao estiver ativa. Translators continuam responsaveis por adaptar IDs para OpenAI, Responses, Claude, Gemini, Cursor e Kiro.

## 6. Fluxo

```text
client request
  -> chat route
  -> sanitize / policy / request metrics
  -> Main Agent
  -> delegate_tool_task
  -> Tool Bridge
  -> Tool Broker
  -> Tool Agent + selected tools
  -> Result Reducer
  -> tool result com main_tool_call_id
  -> Main Agent continua
  -> resposta final
```

Falhas devem retornar estado estruturado ao Main Agent ou ao cliente, nunca uma troca silenciosa de modelo:

- `tool_task_timeout`
- `tool_task_denied`
- `tool_task_no_executor`
- `tool_task_loop_limit`
- `tool_task_provider_error`
- `tool_task_reducer_error`

## 7. Ownership e toolsets

Classificacao inicial:

| Grupo    | Exemplos                               | P0                                                             |
| -------- | -------------------------------------- | -------------------------------------------------------------- |
| CORE     | `read`, `run_code`, `webfetch`, `task` | somente quando server-side; tools client-side ficam no cliente |
| BROWSER  | Playwright e browser                   | fora da P0 server-side                                         |
| REVIEW   | comentarios e revisao                  | DOMAIN, somente executor autorizado                            |
| OBRUXO   | RAG, guardrails, checkpoint            | candidato server-side read-only                                |
| INFRA    | firewall, projeto, chaves, deploy      | bloqueado por padrao                                           |
| DATABASE | consulta e health                      | read-only primeiro                                             |
| LAZY     | tools raras/especificas                | descoberta explicita                                           |

Frequencia nao define CORE sozinha. A classificacao deve usar `called/offer`, ownership, risco e custo de schema.

## 8. Seguranca

Politica padrao do Tool Runtime:

- deny-by-default para mutacoes;
- allowlist por API key, dominio e tool;
- tools de infraestrutura e credenciais exigem aprovacao explicita;
- `delete`, `git push`, escrita de banco, firewall e comandos de producao nao entram na P0;
- bloquear prompt injection que tente ampliar o toolset;
- registrar actor, API key, tarefa, tools selecionadas e decisao;
- limitar profundidade de delegacao a 1 na P0;
- limitar chamadas, tempo total e tamanho de resultado.

A politica existente em `src/lib/toolPolicy.ts` pode ser reutilizada como camada complementar, mas nao substitui o Broker.

## 9. Persistencia e observabilidade

A implementacao P1 deve criar entidades separadas de `call_logs`:

### `tool_runtime_tasks`

- `delegation_id`
- `parent_request_id`
- `main_tool_call_id`
- `tool_task`
- `tool_model`
- `provider`
- `status`
- `started_at`
- `finished_at`
- `latency_ms`
- `raw_result_tokens`
- `reduced_result_tokens`
- `error_code`
- `approval_status`

### `tool_runtime_task_tools`

- `delegation_id`
- `tool_name`
- `source`
- `execution_owner`
- `offered`
- `called`
- `schema_bytes`
- `schema_tokens_estimated`
- `call_count`
- `duration_ms`
- `status`

### Metricas obrigatorias

- `tools_offered`
- `tools_called`
- `tool_schema_bytes`
- `tool_schema_tokens_estimated`
- `main_prompt_tokens`
- `tool_prompt_tokens`
- `raw_result_tokens`
- `reduced_result_tokens`
- `ttft`
- `total_latency`
- `fallback_count`
- `context_overflow`
- `tool_limit_error`
- `tool_call_success`

A relacao `called/offer` deve ser calculada por tool e por dominio, sem usar frequencia de oferta como substituto de uso real.

## 10. Feature flags

Nenhuma mudanca de comportamento deve ficar ativa por padrao.

Flags sugeridas:

- `TOOL_RUNTIME_ENABLED=false`
- `TOOL_RUNTIME_LAB_ENABLED=false`
- `TOOL_RUNTIME_MAX_DEPTH=1`
- `TOOL_RUNTIME_MAX_CALLS=20`
- `TOOL_RUNTIME_MAX_RESULT_TOKENS=8000`
- `TOOL_RUNTIME_SERVER_ONLY=true`
- `TOOL_RUNTIME_APPROVAL_MODE=deny`

O fallback quando a flag estiver desligada e o fluxo atual, byte-identico.

## 11. Plano P0

P0 nao altera a rota de producao:

1. Criar um runner de laboratorio fora do dispatch normal.
2. Fixar Main Model e Tool Agent.
3. Usar somente tools server-side read-only controladas.
4. Executar tarefas com 5, 25 e 70 tools oferecidas.
5. Comparar fluxo atual e delegacao.
6. Registrar offered/called/schema/result/latencia.
7. Testar timeout, erro do filho, reducer e IDs.
8. Validar que nenhuma mutacao e executada.

Criterios de aprovacao:

- zero chamadas fora do toolset autorizado;
- zero perda ou colisao de IDs;
- zero erro de limite de tools;
- reducao de pelo menos 50% dos schemas no Main Agent;
- resultado reduzido recuperavel;
- aumento de latencia documentado e aceitavel;
- falha do Tool Agent nao altera o modelo principal;
- nenhuma acao destrutiva sem aprovacao.

## 12. Plano P1

Depois do laboratorio:

1. adicionar interceptacao explicita de `delegate_tool_task`;
2. adicionar Broker deterministico;
3. adicionar sessoes filhas e persistencia;
4. adicionar reducer com artifact store;
5. integrar allowlist, aprovacao e limites;
6. suportar primeiro OpenAI Chat Completions;
7. testar Responses, Anthropic, Gemini e Cursor;
8. liberar por API key;
9. acompanhar por 24 horas antes de ampliar.

## 13. Plano P2

- Broker semantico;
- descoberta lazy;
- context ladder;
- selecao dinamica de modelo;
- paralelismo seguro;
- cache de resultados;
- executor cliente para tools do VS Code;
- avaliacao automatica de qualidade.

## 14. Compatibilidade e rebuild

Este documento sozinho nao exige rebuild e nao muda producao.

Qualquer implementacao de P0/P1 em TypeScript, novas rotas, novos interceptors ou novas migracoes exige:

1. testes locais;
2. build da imagem;
3. recreacao do container;
4. smoke test com flag desligada;
5. teste controlado com flag ligada.

Alteracoes de configuracao como regex de combo, allowlist ou denylist podem ser feitas sem rebuild quando suportadas pelo painel/runtime, mas nao implementam o Tool Runtime.

## 15. Referencias do estado atual

- Entrada e admission: `src/app/api/v1/chat/completions/route.ts`
- Pipeline e estimativa: `open-sse/handlers/chatCore.ts`
- Filtro de combo: `open-sse/services/comboAgentMiddleware.ts`
- Limite de tools: `open-sse/services/toolLimitDetector.ts`
- Truncamento upstream: `open-sse/handlers/chatCore/upstreamBody.ts`
- Interceptacao de built-ins/skills: `src/lib/skills/interception.ts`
- Politica de tools: `src/lib/toolPolicy.ts`
- Observabilidade de routing: `src/lib/usage/routingObservations.ts`
- Artefatos de request: `src/lib/usage/callLogArtifacts.ts`

## Decisao para implementacao

Aprovado para especificacao e laboratorio:

```text
Main Agent
  + poucas tools CORE
  + delegate_tool_task
  -> Tool Broker deterministico
  -> Tool Agent server-side read-only
  -> Result Reducer
  -> Main Agent
```

Nao aprovado nesta fase:

- delegacao automatica de todas as tools;
- Tool Agent executando tools locais do VS Code sem executor conectado;
- mutacoes de infraestrutura;
- fallback silencioso para trocar o modelo principal;
- Broker baseado em LLM antes da telemetria P0.
