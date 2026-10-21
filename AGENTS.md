# Instruções para agentes: instalar os mods deste repositório

Este repositório (`rafaelscosta/mods`, privado) é um marketplace de mods do Claude Code. Cada mod fica numa pasta própria e está listado em `.claude-plugin/marketplace.json` (`plugins[].name`). O nome do marketplace é `mods`, então um mod instalado daqui recebe o id `<mod>@mods`.

Siga os passos na ordem. Pare e pergunte à pessoa sempre que um passo pedir uma decisão dela.

## 1. Pré-requisitos

- `claude --version` responde (Claude Code instalado).
- O GitHub está autenticado com uma conta que lê `rafaelscosta/mods`: `gh auth status`. A instalação nunca pede credencial; sem ela, falha. Se não houver login, peça à pessoa para rodar `gh auth login` e depois `gh auth setup-git`. Não inicie o login por ela.

## 2. Ver o que já está instalado

```sh
claude plugin list --json
```

Para cada mod que a pessoa pediu, procure na saída um `id` que comece com `<mod>@`. Se já existir (por exemplo `run-ledger@skills-dir`, carregado de `~/.claude/skills/run-ledger`), **não instale uma segunda cópia**: dois carregamentos registram os mesmos hooks e o mesmo comando duas vezes. Conte à pessoa qual cópia existe e pergunte se ela quer manter essa cópia ou trocar pela do marketplace. Para trocar, mova a pasta antiga para um backup (`~/.claude/backups/<mod>-<data>`) em vez de apagar e só então instale.

## 3. Instalar

Do shell (escopo de usuário, o padrão):

```sh
claude plugin install <mod> --marketplace rafaelscosta/mods
```

- Na primeira vez, o marketplace é adicionado às configurações do usuário antes da instalação.
- Opções do mod podem ser definidas já na instalação, com `--config chave=valor` (repetível).
- Use `--json` para um resultado de uma linha que dê para conferir.
- Se aparecer uma confirmação, mostre o que ela diz à pessoa e espere a resposta dela; não responda por ela.

Alternativas para a própria pessoa: no prompt de uma sessão de terminal, `/plugin install <mod> --marketplace rafaelscosta/mods` (responda `y` para adicionar o marketplace e escolha o escopo de usuário). No app desktop: + ao lado da caixa do prompt → Plugins → Add marketplace com `rafaelscosta/mods` → Add plugin.

Erros comuns:

- `Marketplace file not found at …`: a origem está errada, ou a conta não tem acesso ao repositório privado.
- `Plugin "<mod>" not found in marketplace "mods"`: o nome não está em `.claude-plugin/marketplace.json`.

## 4. Conferir

```sh
claude plugin list --json
```

O mod deve aparecer como `<mod>@mods`, com `enabled: true`. Ele carrega nas sessões iniciadas depois da instalação; numa sessão aberta, peça à pessoa para reiniciá-la. Depois faça o teste do mod (seção 7).

## 5. Atualizar e desinstalar

```sh
claude plugin marketplace update mods     # busca o que mudou no repositório
claude plugin update <mod>@mods           # aplica; reinicie a sessão depois
claude plugin uninstall <mod>@mods        # --keep-data preserva os dados salvos do mod
```

## 6. Regras

- Nunca grave chaves, tokens nem `.env` neste repositório, nem em configurações versionadas.
- Não altere `~/.claude/settings.json` à mão para instalar um mod: use os comandos acima.
- Não use `git push --force` neste repositório.

## 7. Notas por mod

### run-ledger

Painel de alocação de modelos dos subagentes: grafo de agentes ao vivo, roteamento de modelos (local ou Jev), troca de contexto e custos a preço de API. Detalhes em [`run-ledger/README.md`](run-ledger/README.md).

- **Instalar:** `claude plugin install run-ledger --marketplace rafaelscosta/mods`
- **Teste sem gastar tokens:** numa sessão nova, rode `/run-ledger demo`. O painel abre e uma execução de exemplo roda por cerca de 35 s. `/run-ledger demo off` encerra.
- **Configuração:** nada é obrigatório; o padrão é o roteador local, que não faz nenhuma chamada de rede. Para ver as opções e quais estão vazias: `claude plugin configure run-ledger@mods --json`.
- **Jev (opcional, só se a pessoa pedir):** o roteamento pelo Jev precisa do adaptador local que vem com o mod, e ele exige a chave `TYPESAFE_API_KEY`. Peça à pessoa onde está a chave (variável de ambiente ou um `.env` fora de qualquer repositório); nunca a escreva em arquivo versionado.
  1. Descubra a pasta instalada: o `installPath` de `run-ledger@mods` em `claude plugin list --json`.
  2. Suba o adaptador (processo de longa duração, Node 18+): `node <installPath>/adapter/jev-adapter.mjs --env-file <caminho do .env>`. Ele escuta em `http://127.0.0.1:8787`; `GET /health` responde sem chamar o Jev.
  3. Aponte o mod para ele: `echo '{"jevEndpoint":"http://127.0.0.1:8787/recommend"}' | claude plugin configure run-ledger@mods --values-stdin`.
- **Gráficos no terminal:** no Ghostty e no kitty o grafo usa pixels. Em outros terminais, e no Tern (que se identifica como kitty, mas não desenha essas imagens), usa braille sozinho. Para forçar um modo: `/run-ledger graphics braille`, `pixels` ou `auto`.
- **Se o grafo aparecer vazio:** rode `/run-ledger graphics braille`. Se assim os nós aparecem, o terminal não desenha as imagens do modo pixels.
