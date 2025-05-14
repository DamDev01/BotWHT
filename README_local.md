# Bot WhatsApp NutriFacil

Este projeto é um bot para WhatsApp focado em grupos de nutrição, com integração ao Telegram e automações úteis para profissionais e estudantes da área.

## Funcionalidades

- **Comandos no WhatsApp:**
  - `!mencionar [msg]` — Menciona todos os membros do grupo com uma mensagem personalizada.
  - `!resumo [qtd]` — Gera um resumo técnico das conversas recentes do grupo.
  - `!membros` — Mostra o total de membros do grupo.
  - `!ajuda` — Exibe a lista de comandos disponíveis.
  - `!braia` — Envia o link do grupo no Telegram.
  - `!grupo` — Envia o link de convite do grupo WhatsApp.
  - `!artigo [DOI/título]` — Baixa artigos científicos por DOI ou título.
  - `!bot [pedido]` — Encaminha pedidos diretamente para o grupo do Telegram.
  - `!traduzir` — Traduz arquivos PDF enviados.

- **Automação:**
  - Notificação automática de novos posts do Instagram.
  - Resumo técnico das conversas baseado em palavras-chave da área de saúde.
  - Download de artigos científicos de diversas fontes.
  - Integração com Telegram para envio de mensagens e pedidos.

- **Gerenciamento de membros:**
  - Mensagem de boas-vindas automática.
  - Controle de entrada e saída de membros.

## Requisitos

- Node.js >= 16
- Conta no WhatsApp e Telegram
- Token do Telegram Bot

## Instalação

1. Clone o repositório:
   ```powershell
   git clone https://github.com/DamDev01/<nome-do-repo>.git
   cd <nome-do-repo>
   ```
2. Instale as dependências:
   ```powershell
   npm install
   ```
3. Configure as variáveis de ambiente (se necessário) e ajuste os tokens no código.
4. Inicie o bot:
   ```powershell
   node bot.js
   ```

## Observações
- O bot utiliza autenticação local do WhatsApp (`LocalAuth`).
- O arquivo `membros_grupo.json` armazena os membros do grupo.
- O bot precisa ser executado em ambiente com acesso à interface gráfica para autenticação inicial do WhatsApp.

## Licença

MIT
