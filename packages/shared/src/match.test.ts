import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, PHYSICS, STADIUM, TICK_RATE, TIMING } from "./constants";
import { Match, type MatchEvent } from "./match";
import { Input } from "./types";

function newMatch(settings = DEFAULT_SETTINGS) {
  const m = new Match(settings);
  m.addPlayer("a", 1, "Ana", "moscow");
  m.addPlayer("b", 2, "Beto", "cairo");
  return m;
}

function run(m: Match, ticks: number): MatchEvent[] {
  const events: MatchEvent[] = [];
  for (let i = 0; i < ticks; i++) events.push(...m.step());
  return events;
}

describe("Match", () => {
  it("chute empurra a bola para longe do jogador", () => {
    const m = newMatch();
    const a = m.players.get("a")!;
    a.x = -PHYSICS.player.radius - PHYSICS.ball.radius - 1;
    a.y = 0;
    m.setInput("a", Input.kick);
    m.step();
    expect(m.ball.vx).toBeGreaterThan(4);
    expect(m.kickoffTeam).toBeNull();
  });

  it("segurar o chute só chuta uma vez até soltar", () => {
    const m = newMatch();
    const a = m.players.get("a")!;
    a.x = -26;
    m.setInput("a", Input.kick);
    m.step();
    const v = m.ball.vx;
    m.ball.x = a.x + 26;
    m.ball.vx = 0;
    m.step();
    expect(m.ball.vx).toBeLessThan(v);
  });

  it("dash só funciona em movimento e respeita a recarga", () => {
    const m = newMatch();
    const a = m.players.get("a")!;
    m.setInput("a", Input.dash);
    m.step();
    expect(a.dashCooldown).toBe(0);

    m.setInput("a", Input.up);
    m.setInput("a", Input.up | Input.dash);
    m.step();
    const cooldown = DEFAULT_SETTINGS.dashCooldownSec * TICK_RATE;
    expect(a.dashCooldown).toBe(cooldown);
    expect(Math.abs(a.vy)).toBeGreaterThan(PHYSICS.dash.impulse * 0.9);

    m.setInput("a", Input.up);
    m.setInput("a", Input.up | Input.dash);
    m.step();
    expect(a.dashCooldown).toBe(cooldown - 1);
  });

  it("time sem a saída não entra no círculo central nem no campo adversário", () => {
    const m = newMatch();
    const b = m.players.get("b")!;
    m.setInput("b", Input.left);
    run(m, 300);
    expect(Math.hypot(b.x, b.y)).toBeGreaterThanOrEqual(STADIUM.centerRadius + b.radius - 0.01);
    expect(b.x).toBeGreaterThan(0);
  });

  it("gol conta ponto, credita autor e passa por replay até a nova saída", () => {
    const m = newMatch();
    m.players.get("a")!.x = -26;
    m.setInput("a", Input.kick);
    m.step();
    m.setInput("a", 0);
    // Coloca a bola rolando para dentro do gol do Cairo.
    m.ball.x = STADIUM.halfWidth - 5;
    m.ball.y = 0;
    m.ball.vx = 8;
    m.ball.vy = 0;
    const events = run(m, 3);
    const goal = events.find((e) => e.type === "goal");
    expect(goal).toMatchObject({ goal: { team: "moscow", scorer: "Ana", ownGoal: false } });
    expect(m.score).toEqual({ moscow: 1, cairo: 0 });
    expect(m.phase).toBe("goal");

    run(m, TIMING.goalCelebrationTicks);
    expect(m.phase).toBe("replay");
    run(m, TIMING.replayTicks);
    expect(m.phase).toBe("playing");
    expect(m.kickoffTeam).toBe("cairo");
    expect(m.ball.x).toBe(0);
  });

  it("gol contra é marcado como gol contra", () => {
    const m = newMatch();
    const b = m.players.get("b")!;
    b.x = 26;
    b.y = 0;
    m.setInput("b", Input.kick);
    m.step();
    m.ball.x = STADIUM.halfWidth - 5;
    m.ball.vx = 8;
    m.ball.vy = 0;
    const goal = run(m, 3).find((e) => e.type === "goal");
    expect(goal).toMatchObject({ goal: { team: "moscow", scorer: "Beto", ownGoal: true } });
  });

  it("empate no fim do tempo vai para o gol de ouro", () => {
    const m = newMatch({ ...DEFAULT_SETTINGS, timeLimitMin: 1 });
    const events = run(m, 60 * TICK_RATE + 1);
    expect(events.find((e) => e.type === "ended")).toBeUndefined();
    expect(m.overtime).toBe(true);
  });

  it("time vencendo no fim do tempo encerra a partida", () => {
    const m = newMatch({ ...DEFAULT_SETTINGS, timeLimitMin: 1 });
    m.score.cairo = 2;
    const events = run(m, 60 * TICK_RATE);
    expect(events).toContainEqual({
      type: "ended",
      result: { score: { moscow: 0, cairo: 2 }, winner: "cairo" },
    });
    run(m, TIMING.endedTicks - 1);
    expect(m.step()).toContainEqual({ type: "finished" });
  });

  it("bola não atravessa as laterais nem a trave", () => {
    const m = newMatch();
    m.kickoffTeam = null;
    m.ball.x = 100;
    m.ball.y = 0;
    m.ball.vx = 3;
    m.ball.vy = 9;
    for (let i = 0; i < 600; i++) {
      m.step();
      expect(Math.abs(m.ball.y)).toBeLessThanOrEqual(STADIUM.halfHeight);
      if (m.phase !== "playing") break;
    }
  });
});
