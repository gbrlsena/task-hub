import { useEffect, useRef } from "react";
import type { Role } from "./task";

/**
 * Pill de status + dropdown de troca, compartilhado pelo cartão de task
 * (ClickUp) e pelo de bug (Slack List).
 *
 * Existe para as duas telas não divergirem. Quem muda o comportamento aqui muda
 * nos dois lugares — que é o ponto.
 *
 * A lista aberta é **ancorada e fora do fluxo** (`position: absolute`). Quando
 * ela ficava no fluxo, dentro da linha `.task-main`, disputava largura com o
 * nome da task e esmagava o título numa palavra por linha.
 *
 * O componente não sabe de onde vêm as opções nem como se grava: recebe a lista
 * já resolvida (ClickUp resolve por `GET /list/{id}`, Slack pelo schema da List)
 * e devolve a escolha. Nenhuma string de status é fixada aqui.
 */

export interface StatusOption {
  /** Identificador usado na escrita: `status` no ClickUp, `Opt…` no Slack. */
  id: string;
  label: string;
  role: Role;
}

interface Props {
  current: string;
  currentRole: Role;
  open: boolean;
  onToggle: () => void;
  /** `null` = ainda carregando as opções. */
  options: StatusOption[] | null;
  onPick: (option: StatusOption) => void;
  /** Grava em andamento: a pill vira "gravando…" e o clique fica travado. */
  busy?: boolean;
  loadingLabel?: string;
}

export default function StatusPicker({
  current,
  currentRole,
  open,
  onToggle,
  options,
  onPick,
  busy = false,
  loadingLabel = "carregando…",
}: Props) {
  const wrapper = useRef<HTMLDivElement>(null);

  // Clique fora fecha, como qualquer dropdown. Sem isso, a lista só fecha
  // clicando de novo na pill, o que confunde com o cartão inteiro clicável.
  useEffect(() => {
    if (!open) return;
    function aoClicarFora(e: PointerEvent) {
      if (!wrapper.current?.contains(e.target as Node)) onToggle();
    }
    document.addEventListener("pointerdown", aoClicarFora);
    return () => document.removeEventListener("pointerdown", aoClicarFora);
  }, [open, onToggle]);

  return (
    <div className="status-picker" ref={wrapper}>
      <button
        className={`status-pill role-${currentRole}`}
        onClick={onToggle}
        disabled={busy}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Mudar status"
      >
        {busy ? "gravando…" : current || "—"} <span className="caret">▾</span>
      </button>

      {open && (
        <div className="status-dropdown" role="menu">
          {options === null ? (
            <span className="status-dropdown-hint muted">{loadingLabel}</span>
          ) : (
            options.map((o) => (
              <button
                key={o.id}
                role="menuitem"
                className={`status-item${o.label === current ? " current" : ""}`}
                onClick={() => onPick(o)}
              >
                <span className={`status-dot role-${o.role}`} aria-hidden="true" />
                <span className="status-item-label">{o.label}</span>
                {o.label === current && <span aria-hidden="true">✓</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
