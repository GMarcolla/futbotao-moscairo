import { DEFAULT_SETTINGS, Input, Match, type Snapshot, TICK_MS, TICK_RATE } from "@futbotao/shared";
import { describe, expect, it } from "vitest";
import { Predictor } from "./predict";

/** Simula cliente e servidor a 60Hz com latência fixa nas duas direções. */
function simulate(script: (tick: number) => number | null, ticks: number, latencyTicks: number) {
  const match = new Match(DEFAULT_SETTINGS);
  match.addPlayer("me", 1, "Eu", "moscow");
  match.addPlayer("other", 2, "Outro", "cairo");
  match.kickoffTeam = null;
  const predictor = new Predictor();
  const toServer: { at: number; bits: number; seq: number }[] = [];
  const toClient: { at: number; snap: Snapshot }[] = [];
  const cooldown = DEFAULT_SETTINGS.dashCooldownSec * TICK_RATE;
  let maxCorrection = 0;

  for (let t = 0; t < ticks; t++) {
    // Servidor: aplica comandos que chegaram e avança.
    while (toServer[0] && toServer[0].at <= t) {
      const m = toServer.shift()!;
      match.setInput("me", m.bits, m.seq);
    }
    match.step();
    toClient.push({ at: t + latencyTicks, snap: match.snapshot() });

    // Cliente: recebe snapshots, lê teclado e avança a predição.
    while (toClient[0] && toClient[0].at <= t) {
      const { snap } = toClient.shift()!;
      predictor.onServerState(snap.p.find((p) => p[0] === 1)!, "moscow", snap.ph, snap.ko, cooldown);
      maxCorrection = Math.max(maxCorrection, predictor.correction);
    }
    const bits = script(t);
    if (bits !== null) toServer.push({ at: t + latencyTicks, bits, seq: predictor.setInput(bits) });
    predictor.update(t * TICK_MS + 0.5);
  }
  return { match, predictor, maxCorrection };
}

describe("Predictor", () => {
  it("movimento, paredes e dash previstos batem com o servidor (sem correções)", () => {
    // Longe da bola e do adversário: só física que o cliente também simula.
    const script = (t: number) => {
      if (t === 20) return Input.left;
      if (t === 120) return Input.left | Input.up;
      if (t === 140) return Input.left | Input.up | Input.dash;
      if (t === 150) return Input.up | Input.kick;
      if (t === 200) return 0;
      return null;
    };
    const { match, predictor, maxCorrection } = simulate(script, 500, 7);
    expect(maxCorrection).toBeLessThan(0.5);
    const server = match.players.get("me")!;
    const pose = predictor.pose()!;
    expect(Math.abs(pose.x - server.x)).toBeLessThan(0.5);
    expect(Math.abs(pose.y - server.y)).toBeLessThan(0.5);
  });

  it("o jogador anda na hora, antes da resposta do servidor", () => {
    const script = (t: number) => (t === 30 ? Input.right : null);
    const { match, predictor } = simulate(script, 34, 7);
    // Só 3 ticks depois do aperto: o servidor nem recebeu o comando ainda.
    expect(match.players.get("me")!.x).toBe(-180);
    expect(predictor.pose()!.x).toBeGreaterThan(-180);
  });

  it("corrige quando o servidor discorda (empurrando a bola) e converge", () => {
    const script = (t: number) => (t === 10 ? Input.right : t === 160 ? 0 : null);
    const { match, predictor, maxCorrection } = simulate(script, 500, 7);
    expect(maxCorrection).toBeGreaterThan(0);
    const server = match.players.get("me")!;
    const pose = predictor.pose()!;
    expect(Math.hypot(pose.x - server.x, pose.y - server.y)).toBeLessThan(0.5);
  });
});
