"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DependencyList, Dispatch, SetStateAction } from "react";

export interface UseAsyncDataOptions<T> {
  /** Valor exibido antes da primeira resposta. */
  initialData?: T;
  /** Quando `false`, nao busca nada e nasce fora de loading. Default: `true`. */
  enabled?: boolean;
  /** Efeito colateral no erro (log, toast). O erro tambem vai para `error`. */
  onError?: (error: unknown) => void;
}

export interface UseAsyncDataResult<T> {
  data: T | undefined;
  loading: boolean;
  error: unknown;
  /**
   * Refaz a busca. Retorna o resultado, entao `await reload()` espera de fato a
   * atualizacao terminar — os call sites do dashboard fazem
   * `await fetchX()` depois de criar/remover algo e contam com isso.
   * Resolve `undefined` se a busca falhou ou foi descartada (desmontagem /
   * reload mais novo).
   *
   * `silent: true` refaz a busca sem ligar `loading`. Necessario para as telas
   * que fazem `if (loading) return <spinner/>` e mantem um estado proprio de
   * "atualizando": sem isto, um refresh trocaria a pagina inteira pelo spinner
   * em vez de so animar o botao.
   */
  reload: (options?: { silent?: boolean }) => Promise<T | undefined>;
  /** Atualizacao otimista, sem refetch. */
  setData: Dispatch<SetStateAction<T | undefined>>;
}

/**
 * Busca assincrona com cancelamento, para substituir o padrao:
 *
 *     const load = useCallback(async () => { ...; setX(r) }, []);
 *     useEffect(() => { load(); }, [load]);   // react-hooks/set-state-in-effect
 *
 * O React Compiler acusa aquele formato porque o corpo do effect chama
 * sincronamente uma funcao que faz setState. Aqui todo setState acontece dentro
 * de uma IIFE async, ja depois do primeiro await — forma que a regra aceita.
 *
 * Alem de silenciar a regra, resolve dois bugs que o padrao antigo carregava:
 * resposta de requisicao obsoleta sobrescrevendo a atual, e setState apos
 * desmontagem.
 */
export function useAsyncData<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
  options: UseAsyncDataOptions<T> = {}
): UseAsyncDataResult<T> {
  const { initialData, enabled = true, onError } = options;

  const [data, setData] = useState<T | undefined>(initialData);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<unknown>(null);

  // A maioria dos call sites passa uma arrow nova a cada render. Guardar em ref
  // evita refetch em loop sem obrigar todo chamador a memoizar o fetcher — quem
  // decide quando refazer a busca e o array `deps`.
  const fetcherRef = useRef(fetcher);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    fetcherRef.current = fetcher;
    onErrorRef.current = onError;
  });

  // `reload` vive fora do ciclo do effect, entao precisa do proprio controle de
  // vida: sem isto, um reload em voo aplicaria estado depois da desmontagem.
  const mountedRef = useRef(true);
  const reloadControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      reloadControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const result = await fetcherRef.current(controller.signal);
        if (cancelled) return;
        setData(result);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err);
        onErrorRef.current?.(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // `deps` e o contrato do chamador: e ele quem declara o que invalida a
    // busca. O spread e intencional e o array tem tamanho fixo por call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps dinamicas sao a API deste hook
  }, [enabled, ...deps]);

  const reload = useCallback(async (options?: { silent?: boolean }): Promise<T | undefined> => {
    // Um reload novo torna o anterior irrelevante; abortar evita que a resposta
    // antiga chegue depois e sobrescreva a nova.
    reloadControllerRef.current?.abort();
    const controller = new AbortController();
    reloadControllerRef.current = controller;

    const silent = options?.silent === true;
    if (!silent) setLoading(true);
    try {
      const result = await fetcherRef.current(controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return undefined;
      setData(result);
      setError(null);
      return result;
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted) return undefined;
      setError(err);
      onErrorRef.current?.(err);
      return undefined;
    } finally {
      if (!silent && mountedRef.current && !controller.signal.aborted) setLoading(false);
    }
  }, []);

  return { data, loading, error, reload, setData };
}
