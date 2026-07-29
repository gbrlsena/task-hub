import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const CHANGED = "taskhub:changed";
const DETACHED = "taskhub:detached";

function selfLabel(): string {
  return getCurrentWindow().label;
}

/**
 * Avisa as outras janelas que o SQLite local mudou. Sem payload de dados: o
 * banco é a fonte da verdade, cada janela relê o que lhe interessa.
 * Fire-and-forget — nenhuma escrita espera o ping.
 */
export function notifyChanged(): void {
  emit(CHANGED, { from: selfLabel() }).catch(() => {});
}

/** Roda `handler` quando OUTRA janela escreve no banco (ignora o próprio ping). */
export function onChanged(handler: () => void): Promise<UnlistenFn> {
  const self = selfLabel();
  return listen<{ from: string }>(CHANGED, (e) => {
    if (e.payload?.from !== self) handler();
  });
}

/** Lista de tasks com janela destacada aberta, empurrada pelo Rust. */
export function onDetached(handler: (ids: string[]) => void): Promise<UnlistenFn> {
  return listen<string[]>(DETACHED, (e) => handler(e.payload ?? []));
}
