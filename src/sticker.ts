import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

/** Nunca menor que isso, senão a janela some atrás da própria barra de título. */
const MIN_H = 160;

/** Teto: uma descrição gigante não pode gerar janela maior que o monitor. */
const MAX_SCREEN_FRACTION = 0.9;

/**
 * Altura da janela destacada para um conteúdo de `content` px numa tela de
 * `availHeight` px. Pura, para poder testar sem DOM. O mínimo ganha do teto
 * quando a tela é absurdamente baixa — melhor cortar que inverter os limites.
 */
export function stickerHeight(content: number, availHeight: number): number {
  const max = Math.floor(availHeight * MAX_SCREEN_FRACTION);
  return Math.max(MIN_H, Math.min(Math.ceil(content), max));
}

/**
 * Cola a altura da janela na altura do conteúdo (efeito sticker) e continua
 * colando quando um painel abre ou fecha. A largura é do usuário: se ele
 * redimensionar na mão, ela é preservada.
 *
 * Devolve a função que desliga o observador.
 */
export function fitWindowToContent(): () => void {
  const win = getCurrentWindow();
  let applied = 0;
  let stopped = false;

  async function fit(): Promise<void> {
    const target = stickerHeight(document.body.scrollHeight, window.screen.availHeight);
    // Sem histerese o setSize realimenta o observador e a janela treme.
    if (Math.abs(target - applied) < 2) return;
    applied = target;
    const inner = await win.innerSize();
    const logical = inner.toLogical(await win.scaleFactor());
    await win.setSize(new LogicalSize(logical.width, target));
  }

  const observer = new ResizeObserver(() => {
    if (!stopped) fit().catch(() => {});
  });
  observer.observe(document.body);
  fit().catch(() => {});

  return () => {
    stopped = true;
    observer.disconnect();
  };
}
