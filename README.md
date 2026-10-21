# mods

Mods do Claude Code de Rafael Costa: uma pasta por mod, todas listadas em `.claude-plugin/marketplace.json`.

| Mod | O que faz |
| --- | --- |
| [`run-ledger`](run-ledger/README.md) | Alocação de modelos dos subagentes: grafo de agentes ao vivo, roteamento (local ou Jev), troca de contexto e custos a preço de API |

## Instalar

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

O repositório é privado: a instalação só funciona para quem tem acesso a ele no GitHub e já tem uma credencial git para github.com na máquina (uma chave SSH, ou `gh auth login` seguido de `gh auth setup-git`). A instalação nunca pede essa credencial.

## Adicionar um mod

1. Copie a pasta do mod para a raiz deste repositório (`<mod>/.claude-plugin/plugin.json`, `<mod>/hooks/…`).
2. Acrescente uma entrada em `.claude-plugin/marketplace.json`: `{ "name": "<mod>", "source": "./<mod>" }`, com o `name` igual ao do `plugin.json` do mod.
3. Rode `claude plugin validate .` na raiz e faça o commit.
