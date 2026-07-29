/**
 * Id da task quando a janela foi aberta como `index.html?task=<id>`
 * (janela destacada). `null` na janela principal.
 */
export function parseTaskParam(search: string): string | null {
  const raw = new URLSearchParams(search).get("task");
  const id = raw?.trim() ?? "";
  return id === "" ? null : id;
}
