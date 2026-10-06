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

No lobby, cada pessoa escolhe **Moscow**, **Cairo** ou **Arquibancada**. A partida começa sozinha quando todos que estão nos times clicam em **Pronto**. Quem criou a sala (★) ajusta o tempo, o limite de gols, a recarga do dash e a **Rede**.

Para criar uma sala separada, use `?sala=nome` na URL. O padrão é `moscairo`.

## Arquitetura

```
apps/client      Vite + TypeScript + Canvas 2D   → Vercel (site estático)
apps/server      Cloudflare Worker + Durable Object (PartyServer) → 1 sala = 1 objeto
packages/shared  Física, regras da partida e protocolo (usado por todos)
```

### Rede: P2P (padrão) ou Servidor (reserva)

A Cloudflare não roda Durable Objects na América do Sul (a sala ficaria nos EUA, com ~150–250 ms de ping). Por isso o padrão é **P2P, como no HaxBall**:

- O **navegador de quem criou a sala** roda a partida (física a 60 ticks/s) num *Web Worker*, que continua rodando mesmo com a aba em segundo plano.
- Os outros **conectam direto nele via WebRTC** (dois canais: um confiável para comandos/eventos e um sem retransmissão para os snapshots).
- O servidor da Cloudflare só cuida do lobby, do placar e da **sinalização** (troca das ofertas WebRTC). Durante a partida ele hiberna.
- Se o host sair, a partida é encerrada e todos voltam ao lobby.

Se a rede de alguém bloquear P2P (algumas redes corporativas/VPN), o jogo avisa. Aí dá para:
1. trocar a **Rede** para **Servidor** no lobby (a partida roda na Cloudflare, com mais atraso), ou
2. configurar o TURN da Cloudflare (veja abaixo), que retransmite a conexão.

### Outros detalhes

- **Predição no cliente:** o próprio jogador e a bola (quando você está com ela) são simulados na hora no navegador, com a mesma física de quem hospeda; as divergências são corrigidas suavemente.
- **Custo zero:** o cliente só envia comando quando o teclado muda e a sala hiberna fora do lobby. Tudo cabe nos planos gratuitos (se um limite estourar, o serviço para; não há cobrança).
- **Replay do gol:** cada navegador guarda os últimos snapshots e reproduz ~6s (3s normais + câmera lenta).

## Desenvolvimento

Requisitos: Node.js 20+.

```bash
npm install
npm run dev        # servidor em localhost:8787 + cliente em localhost:5173
npm test           # testes da física/regras e da predição
npm run typecheck
```

Para testar com mais de um jogador, abra `http://localhost:5173` em várias abas (a primeira a entrar hospeda a partida no modo P2P).

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

### 3. (Opcional) TURN para redes que bloqueiam P2P

No painel da Cloudflare, em **Realtime → TURN Server**, crie uma chave (1.000 GB/mês grátis; pode exigir cartão cadastrado). Depois:

```bash
cd apps/server
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

Sem esses segredos o jogo usa só STUN (conexão direta), que funciona na maioria das redes domésticas.

## Ideias para depois

Estatísticas da sessão (artilheiro, garçom, gol contra do dia), troca de host sem encerrar a partida, votação para pular o replay e o modo caos opcional.
