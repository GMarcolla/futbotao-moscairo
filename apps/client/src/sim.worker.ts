/// <reference lib="webworker" />
/**
 * Roda a partida no navegador do host (modo P2P). Fica num Web Worker para
 * não congelar quando a aba do host vai para segundo plano (ex.: durante a
 * chamada de vídeo da reunião).
 */
import { Match, type MatchEvent, type PlayingTeam, type RoomSettings, type Snapshot, TICK_MS } from "@futbotao/shared";

export interface RosterEntry {
  id: string;
  num: number;
  name: string;
  team: PlayingTeam;
}

export type ToWorker =
  | { t: "start"; settings: RoomSettings }
  | { t: "roster"; players: RosterEntry[] }
  | { t: "input"; id: string; i: number; s: number }
  | { t: "stop" };

export type FromWorker = { t: "snap"; s: Snapshot } | { t: "event"; e: MatchEvent };

const MAX_STEPS_PER_LOOP = 5;

let match: Match | null = null;
let loop: ReturnType<typeof setInterval> | null = null;
let lastTime = 0;
let accumulator = 0;

const post = (msg: FromWorker) => self.postMessage(msg);

function runLoop() {
  if (!match) return;
  const now = performance.now();
  accumulator += now - lastTime;
  lastTime = now;
  let steps = 0;
  while (accumulator >= TICK_MS && steps < MAX_STEPS_PER_LOOP) {
    accumulator -= TICK_MS;
    steps++;
    for (const e of match.step()) post({ t: "event", e });
  }
  if (steps === MAX_STEPS_PER_LOOP) accumulator = 0;
  if (steps > 0) post({ t: "snap", s: match.snapshot() });
}

/** Ajusta os jogadores da partida à lista de quem está nos times. */
function syncRoster(players: RosterEntry[]) {
  if (!match) return;
  const wanted = new Map(players.map((p) => [p.id, p]));
  for (const p of [...match.players.values()]) {
    const w = wanted.get(p.id);
    if (!w || w.team !== p.team) match.removePlayer(p.id);
  }
  for (const p of players) {
    if (!match.players.has(p.id)) match.addPlayer(p.id, p.num, p.name, p.team);
  }
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  switch (msg.t) {
    case "start":
      match = new Match(msg.settings);
      lastTime = performance.now();
      accumulator = 0;
      if (loop) clearInterval(loop);
      loop = setInterval(runLoop, TICK_MS);
      break;
    case "roster":
      syncRoster(msg.players);
      break;
    case "input":
      match?.setInput(msg.id, msg.i & 63, msg.s);
      break;
    case "stop":
      if (loop) clearInterval(loop);
      loop = null;
      match = null;
      break;
  }
};
