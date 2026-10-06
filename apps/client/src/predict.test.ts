import {
  DEFAULT_SETTINGS,
  Input,
  Match,
  PHYSICS,
  type Snapshot,
  TICK_MS,
  TICK_RATE,
} from "@futbotao/shared";
import { describe, expect, it } from "vitest";
import { Predictor } from "./predict";

type Script = (tick: number) => number | null;

/**
 * Simula cliente e servidor a 60Hz com latência fixa nas duas direções.
 * `other` controla o adversário direto no servidor (o cliente não prevê ele).
 */
function simulate(script: Script, ticks: number, latencyTicks: number, other?: Script) {
  const match = new Match(DEFAULT_SETTINGS);
  match.addPlayer("me", 1, "Eu", "moscow");
  match.addPlayer("other", 2, "Outro", "cairo");
  match.kickoffTeam = null;
  const predictor = new Predictor();
  const toServer: { at: number; bits: number; seq: number }[] = [];
  const toClient: { at: number; snap: Snapshot }[] = [];
  const cooldown = DEFAULT_SETTINGS.dashCooldownSec * TICK_RATE;
  let maxCorrection = 0;
  let minBallGap = Infinity;

  for (let t = 0; t < ticks; t++) {
    while (toServer[0] && toServer[0].at <= t) {
      const m = toServer.shift()!;
      match.setInput("me", m.bits, m.seq);
    }
    const otherBits = other?.(t);
    if (otherBits !== undefined && otherBits !== null) match.setInput("other", otherBits);
    match.step();
    toClient.push({ at: t + latencyTicks, snap: match.snapshot() });

    while (toClient[0] && toClient[0].at <= t) {
      const { snap } = toClient.shift()!;
      predictor.onServerState(snap, snap.p.find((p) => p[0] === 1)!, "moscow", cooldown);
      maxCorrection = Math.max(maxCorrection, predictor.correction);
    }
    const bits = script(t);
    if (bits !== null) toServer.push({ at: t + latencyTicks, bits, seq: predictor.setInput(bits) });
    predictor.update(t * TICK_MS + 0.5);

    const me = predictor.pose();
    const ball = predictor.ballPose();
    if (me && ball) minBallGap = Math.min(minBallGap, Math.hypot(me.x - ball.x, me.y - ball.y));
  }
  return { match, predictor, maxCorrection, minBallGap };
}

const touching = PHYSICS.player.radius + PHYSICS.ball.radius;

function expectAgreement(match: Match, predictor: Predictor) {
  const server = match.players.get("me")!;
  const pose = predictor.pose()!;
  const ball = predictor.ballPose()!;
  expect(Math.hypot(pose.x - server.x, pose.y - server.y)).toBeLessThan(0.5);
  expect(Math.hypot(ball.x - match.ball.x, ball.y - match.ball.y)).toBeLessThan(0.5);
}

describe("Predictor", () => {
  it("movimento, paredes e dash previstos batem com o servidor (sem correções)", () => {
    // Longe da bola e do adversário.
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
    expectAgreement(match, predictor);
  });

  it("o jogador anda na hora, antes da resposta do servidor", () => {
    const script = (t: number) => (t === 30 ? Input.right : null);
    const { match, predictor } = simulate(script, 34, 7);
    // Só 3 ticks depois do aperto: o servidor nem recebeu o comando ainda.
    expect(match.players.get("me")!.x).toBe(-180);
    expect(predictor.pose()!.x).toBeGreaterThan(-180);
  });

  it("conduzir a bola: não atravessa a bola e bate com o servidor", () => {
    // Conduz um pouco e solta (a bola para antes do gol: gol muda a fase da partida).
    const script = (t: number) => (t === 10 ? Input.right : t === 80 ? 0 : null);
    // Adversário sai do caminho da bola (colisão com ele o cliente não prevê).
    const other = (t: number) => (t === 0 ? Input.up : t === 60 ? 0 : null);
    const { match, predictor, maxCorrection, minBallGap } = simulate(script, 500, 7, other);
    expect(minBallGap).toBeGreaterThan(touching - 1);
    // Ao trocar de tecla, cliente e servidor podem contar um tick a mais/menos
    // entre os comandos: no máximo ~1 tick de movimento, suavizado na tela.
    expect(maxCorrection).toBeLessThan(3.5);
    expectAgreement(match, predictor);
  });

  it("o chute sai na hora, antes da resposta do servidor", () => {
    // Anda até a bola e chuta ao encostar.
    const script = (t: number) => (t === 10 ? Input.right : t === 70 ? Input.right | Input.kick : null);
    const { match, predictor } = simulate(script, 74, 7);
    expect(match.ball.vx).toBe(0);
    expect(predictor.ballPose()!.x).toBeGreaterThan(0);
  });

  it("adversário toca na bola: corrige e volta a concordar com o servidor", () => {
    const script = (t: number) => (t === 10 ? Input.right : t === 120 ? 0 : null);
    // O adversário vem de frente para a bola.
    const other = (t: number) => (t === 10 ? Input.left : t === 120 ? 0 : null);
    const { match, predictor } = simulate(script, 500, 7, other);
    expectAgreement(match, predictor);
  });
});
