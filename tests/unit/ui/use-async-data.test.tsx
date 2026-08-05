// @vitest-environment jsdom
// tests/unit/ui/use-async-data.test.tsx
// Runs via Vitest (vitest.config.ts)
// Uses React DOM directly (no @testing-library/dom dep required).
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";
import { useAsyncData } from "../../../src/shared/hooks/useAsyncData";

// Sem esta flag o React emite "The current testing environment is not configured
// to support act(...)" a cada act(). O teste de desmontagem afirma sobre
// console.error, entao esse ruido precisaria ser filtrado — melhor eliminar a
// causa e deixar a assercao valer so para avisos reais do React.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Minimal hook test harness ────────────────────────────────────────────────

type HookResult<T> = { current: T };

function mountHook<T>(useHook: () => T): {
  hookRef: HookResult<T>;
  unmount: () => void;
} {
  const hookRef: HookResult<T> = { current: undefined as unknown as T };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  function HookComponent() {
    const captureRef = useRef<T>(undefined as unknown as T);
    captureRef.current = useHook();
     
    hookRef.current = captureRef.current;
    return null;
  }

  act(() => {
    root.render(React.createElement(HookComponent));
  });

  return {
    hookRef,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Deixa as microtasks pendentes drenarem dentro de act(). */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Promise controlavel manualmente, para observar o estado intermediario. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useAsyncData", () => {
  it("busca na montagem e expoe o resultado", async () => {
    const fetcher = vi.fn(async () => ({ agents: ["a", "b"] }));
    const { hookRef, unmount } = mountHook(() => useAsyncData(fetcher, []));

    await flush();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(hookRef.current.data).toEqual({ agents: ["a", "b"] });
    expect(hookRef.current.loading).toBe(false);
    expect(hookRef.current.error).toBeNull();
    unmount();
  });

  it("comeca em loading e desliga ao resolver", async () => {
    const d = deferred<string>();
    const { hookRef, unmount } = mountHook(() => useAsyncData(() => d.promise, []));

    expect(hookRef.current.loading).toBe(true);
    expect(hookRef.current.data).toBeUndefined();

    await act(async () => {
      d.resolve("pronto");
    });

    expect(hookRef.current.loading).toBe(false);
    expect(hookRef.current.data).toBe("pronto");
    unmount();
  });

  it("captura erro sem derrubar o componente e desliga o loading", async () => {
    const boom = new Error("falhou");
    const onError = vi.fn();
    const { hookRef, unmount } = mountHook(() =>
      useAsyncData(
        async () => {
          throw boom;
        },
        [],
        { onError }
      )
    );

    await flush();

    expect(hookRef.current.error).toBe(boom);
    expect(hookRef.current.loading).toBe(false);
    expect(onError).toHaveBeenCalledWith(boom);
    unmount();
  });

  it("respeita initialData antes da primeira resposta", async () => {
    const d = deferred<number[]>();
    const { hookRef, unmount } = mountHook(() =>
      useAsyncData(() => d.promise, [], { initialData: [] as number[] })
    );

    expect(hookRef.current.data).toEqual([]);

    await act(async () => {
      d.resolve([1, 2]);
    });

    expect(hookRef.current.data).toEqual([1, 2]);
    unmount();
  });

  it("nao busca quando enabled=false", async () => {
    const fetcher = vi.fn(async () => "x");
    const { hookRef, unmount } = mountHook(() => useAsyncData(fetcher, [], { enabled: false }));

    await flush();

    expect(fetcher).not.toHaveBeenCalled();
    expect(hookRef.current.loading).toBe(false);
    unmount();
  });

  it("reload dispara nova busca", async () => {
    let n = 0;
    const fetcher = vi.fn(async () => ++n);
    const { hookRef, unmount } = mountHook(() => useAsyncData(fetcher, []));

    await flush();
    expect(hookRef.current.data).toBe(1);

    await act(async () => {
      hookRef.current.reload();
    });
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(hookRef.current.data).toBe(2);
    unmount();
  });

  it("setData permite atualizacao otimista sem refetch", async () => {
    const fetcher = vi.fn(async () => ["a"]);
    const { hookRef, unmount } = mountHook(() => useAsyncData(fetcher, []));

    await flush();

    await act(async () => {
      hookRef.current.setData(["a", "b"]);
    });

    expect(hookRef.current.data).toEqual(["a", "b"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("nao aplica o resultado se o componente desmontou antes da resposta", async () => {
    const d = deferred<string>();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { hookRef, unmount } = mountHook(() => useAsyncData(() => d.promise, []));

    unmount();

    await act(async () => {
      d.resolve("tarde demais");
    });

    // Sem warning de "update on unmounted component" e sem estado aplicado.
    expect(errSpy).not.toHaveBeenCalled();
    expect(hookRef.current.data).toBeUndefined();
    errSpy.mockRestore();
  });

  it("passa um AbortSignal ao fetcher", async () => {
    const fetcher = vi.fn(async (signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      return "ok";
    });
    const { unmount } = mountHook(() => useAsyncData(fetcher, []));

    await flush();

    expect(fetcher).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("reload e aguardavel e resolve com o resultado", async () => {
    let n = 0;
    const { hookRef, unmount } = mountHook(() => useAsyncData(async () => ++n, []));
    await flush();

    let resolved: number | undefined;
    await act(async () => {
      resolved = await hookRef.current.reload();
    });

    // Os call sites fazem `await fetchX()` apos criar/remover e contam com o
    // estado ja atualizado quando a promise resolve.
    expect(resolved).toBe(2);
    expect(hookRef.current.data).toBe(2);
    unmount();
  });

  it("reload silencioso nao liga loading, mas ainda atualiza", async () => {
    let n = 0;
    const d = deferred<number>();
    const { hookRef, unmount } = mountHook(() =>
      useAsyncData(async () => {
        n += 1;
        return n === 1 ? 1 : d.promise;
      }, [])
    );
    await flush();
    expect(hookRef.current.loading).toBe(false);

    let pending!: Promise<number | undefined>;
    await act(async () => {
      pending = hookRef.current.reload({ silent: true });
    });

    // Telas com `if (loading) return <spinner/>` nao podem piscar a pagina
    // inteira durante um refresh.
    expect(hookRef.current.loading).toBe(false);

    await act(async () => {
      d.resolve(2);
      await pending;
    });

    expect(hookRef.current.data).toBe(2);
    expect(hookRef.current.loading).toBe(false);
    unmount();
  });

  it("reload nao-silencioso liga loading durante a busca", async () => {
    let n = 0;
    const d = deferred<number>();
    const { hookRef, unmount } = mountHook(() =>
      useAsyncData(async () => {
        n += 1;
        return n === 1 ? 1 : d.promise;
      }, [])
    );
    await flush();

    let pending!: Promise<number | undefined>;
    await act(async () => {
      pending = hookRef.current.reload();
    });

    expect(hookRef.current.loading).toBe(true);

    await act(async () => {
      d.resolve(2);
      await pending;
    });

    expect(hookRef.current.loading).toBe(false);
    unmount();
  });

  it("reload resolve undefined quando a busca falha", async () => {
    let call = 0;
    const { hookRef, unmount } = mountHook(() =>
      useAsyncData(
        async () => {
          call += 1;
          if (call > 1) throw new Error("falhou");
          return "ok";
        },
        [],
        { onError: () => {} }
      )
    );
    await flush();

    let resolved: string | undefined = "sentinela";
    await act(async () => {
      resolved = await hookRef.current.reload();
    });

    expect(resolved).toBeUndefined();
    expect(hookRef.current.error).toBeInstanceOf(Error);
    // O dado anterior sobrevive ao erro — a tela nao esvazia.
    expect(hookRef.current.data).toBe("ok");
    unmount();
  });

  it("reload em voo nao aplica estado se o componente desmontar antes", async () => {
    const d = deferred<string>();
    let first = true;
    const { hookRef, unmount } = mountHook(() =>
      useAsyncData(() => {
        if (first) {
          first = false;
          return Promise.resolve("inicial");
        }
        return d.promise;
      }, [])
    );
    await flush();
    expect(hookRef.current.data).toBe("inicial");

    let resolved: string | undefined = "sentinela";
    const pending = hookRef.current.reload().then((r) => {
      resolved = r;
    });

    unmount();

    await act(async () => {
      d.resolve("tarde demais");
      await pending;
    });

    expect(resolved).toBeUndefined();
    expect(hookRef.current.data).toBe("inicial");
  });

  it("aborta a requisicao em voo ao desmontar", async () => {
    let captured: AbortSignal | null = null;
    const d = deferred<string>();
    const { unmount } = mountHook(() =>
      useAsyncData((signal) => {
        captured = signal;
        return d.promise;
      }, [])
    );

    expect(captured).not.toBeNull();
    expect(captured!.aborted).toBe(false);

    unmount();

    expect(captured!.aborted).toBe(true);
  });
});
