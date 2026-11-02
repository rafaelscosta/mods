# mods

Mods do Claude Code de Rafael Costa: uma pasta por mod, todas listadas em `.claude-plugin/marketplace.json`.

| Mod | O que faz |
| --- | --- |
| [`run-ledger`](run-ledger/README.md) | Alocação de modelos dos subagentes: grafo de agentes ao vivo, roteamento (local ou Jev), troca de contexto e custos a preço de API |

## Instalar

Requer **Claude Code 2.1.292 ou mais recente** (`claude --version`; para atualizar, `claude update`). É a versão em que `claude plugin install` ganhou `--marketplace`. O `run-ledger` em si roda desde a 2.1.284; numa versão anterior o mod não carrega.

No prompt de uma sessão de terminal:

```
/plugin install run-ledger --marketplace rafaelscosta/mods
```

Responda `y` para adicionar o marketplace e escolha o escopo (usuário primeiro).

De um shell:

```
claude plugin install run-ledger --marketplace rafaelscosta/mods
```

No app desktop, onde `/plugin` não roda: clique em + ao lado da caixa do prompt, depois Plugins, Add marketplace com `rafaelscosta/mods`, depois Add plugin.

O repositório é público: a instalação não pede conta nem credencial do GitHub.

### Pedir a um agente

Basta dizer, por exemplo, "instale o run-ledger do repositório rafaelscosta/mods". O passo a passo que o agente segue está em [`AGENTS.md`](AGENTS.md): pré-requisitos, como evitar uma segunda cópia de um mod já instalado, instalação, conferência, atualização e as notas de cada mod.

## Adicionar um mod

1. Copie a pasta do mod para a raiz deste repositório (`<mod>/.claude-plugin/plugin.json`, `<mod>/hooks/…`).
2. Acrescente uma entrada em `.claude-plugin/marketplace.json`: `{ "name": "<mod>", "source": "./<mod>" }`, com o `name` igual ao do `plugin.json` do mod.
3. Acrescente as notas do mod em `AGENTS.md`, seção 7 (como testar, opções, dependências).
4. Rode `claude plugin validate .` na raiz e faça o commit.
