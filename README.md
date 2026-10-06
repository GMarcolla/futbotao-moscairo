# Futbotão Moscairo ⚽

Futebol de botão multiplayer no navegador, no estilo HaxBall, feito para as reuniões de descompressão do time Moscairo. **Moscow** 🔴 x **Cairo** 🔵.

## Como jogar

| Ação | Teclas |
|---|---|
| Mover | `WASD` ou setas |
| Chutar (segure para ficar "armado"; fica um pouco mais lento) | `Espaço` ou `X` |
| Dash (com recarga) | `Shift` ou `C` |
| Chat rápido | `1` Passa! · `2` Boa! · `3` Foi mal 😅 · `4` GOOOL! |
| Painel da sala (trocar de time durante a partida) | `Esc` |

No lobby, cada pessoa escolhe **Moscow**, **Cairo** ou **Arquibancada**. A partida começa sozinha quando todos que estão nos times clicam em **Pronto**. Quem criou a sala (★) ajusta o tempo, o limite de gols e a recarga do dash.

Para criar uma sala separada, use `?sala=nome` na URL. O padrão é `moscairo`.

## Arquitetura

```
apps/client      Vite + TypeScript + Canvas 2D   → Vercel (site estático)
apps/server      Cloudflare Worker + Durable Object (PartyServer) → 1 sala = 1 objeto
packages/shared  Física, regras da partida e protocolo (usado pelos dois lados)
```

- **O servidor é a autoridade:** a física roda a 60 ticks/s no Durable Object da sala. Não existe "vantagem de host".
- **Custo zero:** o cliente só envia mensagem quando o estado do teclado muda. Fora da partida a sala hiberna. Tudo cabe no plano gratuito da Cloudflare (se o limite estourar, o serviço para; não há cobrança).
- **Replay do gol:** cada navegador guarda os últimos snapshots e reproduz ~6s (3s normais + câmera lenta), sem custo extra de servidor.

## Desenvolvimento

Requisitos: Node.js 20+.

```bash
npm install
npm run dev        # servidor em localhost:8787 + cliente em localhost:5173
npm test           # testes da física/regras
npm run typecheck
```

Para testar com mais de um jogador, abra `http://localhost:5173` em várias abas.

## Deploy (tudo no plano gratuito)

### 1. Servidor de salas (Cloudflare)

```bash
npx wrangler login          # uma vez; abre o navegador
npm run deploy:server
```

O comando mostra a URL do Worker, por exemplo `https://futbotao-server.<seu-subdominio>.workers.dev`.

### 2. Site (Vercel)

1. Suba o repositório no GitHub e importe-o na Vercel, deixando a raiz do repo como *Root Directory*. O `vercel.json` já define o build.
2. Em *Environment Variables*, crie `VITE_PARTY_HOST` com o host do Worker, **sem** `https://` (ex.: `futbotao-server.<seu-subdominio>.workers.dev`).
3. Faça o deploy.

## Ideias para depois do MVP

Predição de movimento no cliente (menos atraso percebido), estatísticas da sessão (artilheiro, garçom, gol contra do dia), votação para pular o replay e o modo caos opcional.
