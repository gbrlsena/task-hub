# Contribuindo com o Task Hub

Obrigado pelo interesse! Este é um projeto pessoal que ganhou vida própria —
PRs são bem-vindos, mas leia [`task-hub-spec.md`](task-hub-spec.md) antes de
propor mudanças de arquitetura: ele documenta as decisões e as regras duras
do produto (nenhuma chamada HTTP direta do frontend, nunca hardcodar strings
de status do ClickUp, segredos só no keyring, etc.).

Se você está usando o Claude Code, o [`CLAUDE.md`](CLAUDE.md) na raiz tem o
contexto operacional completo (stack, convenções, estado atual do projeto).

## Setup

```bash
npm install
npm run tauri dev
```

Pré-requisitos: Node + npm, e o toolchain do Tauri para o seu SO — veja
[Tauri prerequisites](https://tauri.app/start/prerequisites/). No Windows,
o PowerShell bloqueia o shim `npm.ps1` por padrão; use `npm.cmd` em vez de
`npm`, ou rode em Git Bash/cmd.

## Testes

Rode os dois conjuntos de teste antes de abrir um PR:

```bash
npm test                    # frontend (vitest)
cd src-tauri && cargo test  # backend (Rust)
```

`npm run build` também deve passar limpo (typecheck + build do Vite).

## Abrindo um PR

1. Fork o repositório e crie uma branch descritiva (`feature/...`, `fix/...`).
2. Mudanças pequenas e focadas — evite misturar refactors não relacionados
   com a feature/fix.
3. Sem novas dependências pesadas sem necessidade real; se adicionar uma
   fonte ou lib, prefira pacotes que funcionem **offline** (o app não deve
   depender de rede além das APIs que ele já integra).
4. Descreva no PR o que mudou e por quê. Se mexer em UI, screenshots ajudam.

## O que não aceitar mudar sem discussão prévia

- As regras duras listadas em `CLAUDE.md` / `task-hub-spec.md`.
- O sistema de tokens de design (`src/App.css`) — mudanças visuais devem
  manter a pegada existente (tokens OKLCH, um acento usado com parcimônia).
- Qualquer coisa que grave no ClickUp sem confirmação explícita do usuário.
