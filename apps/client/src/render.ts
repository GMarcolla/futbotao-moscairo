import {
  PHYSICS,
  PlayerFlag,
  type PlayerInfo,
  type PlayingTeam,
  QUICK_CHAT,
  STADIUM,
  TEAMS,
} from "@futbotao/shared";
import type { Frame } from "./timeline";

const W = STADIUM.halfWidth;
const H = STADIUM.halfHeight;
const G = STADIUM.goalHalfWidth;
const D = STADIUM.goalDepth;
/** Área visível do mundo (campo + margem dos jogadores + folga). */
const VIEW_HALF_W = W + STADIUM.playerMargin + 20;
const VIEW_HALF_H = H + STADIUM.playerMargin + 20;

const COLORS = {
  outside: "#3e6b35",
  grassA: "#4f8a3f",
  grassB: "#4a8239",
  line: "rgba(255,255,255,0.85)",
  net: "rgba(255,255,255,0.22)",
};

export interface ChatBubble {
  num: number;
  index: number;
  until: number;
}

export interface RenderInput {
  frame: Frame;
  /** Poses alguns ticks atrás, para desenhar o rastro do dash. */
  trail: Frame[];
  players: Map<number, PlayerInfo>;
  myNum: number | null;
  /** Recarga total do dash em ticks (para desenhar a fração). */
  dashCooldownTicks: number;
  bubbles: ChatBubble[];
  now: number;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.scale = Math.min(
      this.canvas.width / (VIEW_HALF_W * 2),
      this.canvas.height / (VIEW_HALF_H * 2),
    );
  }

  draw(input: RenderInput | null, kickoff: PlayingTeam | null = null) {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLORS.outside;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(this.scale, 0, 0, this.scale, canvas.width / 2, canvas.height / 2);

    this.drawField(kickoff);
    if (!input) {
      this.drawBall(0, 0);
      return;
    }
    const { frame } = input;
    for (const [num, pose] of frame.players) {
      if (!(pose.flags & PlayerFlag.dashing)) continue;
      const info = input.players.get(num);
      if (!info || info.team === "spectator") continue;
      input.trail.forEach((past, i) => {
        const p = past.players.get(num);
        if (!p) return;
        ctx.globalAlpha = 0.25 - i * 0.07;
        this.disc(p.x, p.y, PHYSICS.player.radius, TEAMS[info.team as PlayingTeam].color);
      });
      ctx.globalAlpha = 1;
    }
    for (const [num, pose] of frame.players) {
      const info = input.players.get(num);
      if (info && info.team !== "spectator") {
        const cooldown = Math.min(1, pose.cooldown / input.dashCooldownTicks);
        this.drawPlayer(pose.x, pose.y, pose.flags, cooldown, info, num === input.myNum);
      }
    }
    this.drawBall(frame.ball.x, frame.ball.y);
    for (const [num, pose] of frame.players) {
      const info = input.players.get(num);
      if (info) this.drawName(pose.x, pose.y, info.name);
    }
    for (const b of input.bubbles) {
      const pose = frame.players.get(b.num);
      if (pose && b.until > input.now) this.drawBubble(pose.x, pose.y, QUICK_CHAT[b.index]!);
    }
  }

  private drawField(kickoff: PlayingTeam | null) {
    const { ctx } = this;
    const stripes = 12;
    const stripeW = (W * 2) / stripes;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 ? COLORS.grassA : COLORS.grassB;
      ctx.fillRect(-W + i * stripeW, -H, stripeW + 0.5, H * 2);
    }

    if (kickoff) {
      // Destaca o lado de quem dá a saída.
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      const side = TEAMS[kickoff].side;
      ctx.fillRect(side < 0 ? -W : 0, -H, W, H * 2);
    }

    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 3;
    ctx.strokeRect(-W, -H, W * 2, H * 2);
    ctx.beginPath();
    ctx.moveTo(0, -H);
    ctx.lineTo(0, H);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, STADIUM.centerRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = COLORS.line;
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fill();

    // Grandes áreas (só decoração).
    for (const side of [-1, 1]) {
      const areaW = 110;
      const areaH = 170;
      ctx.strokeRect(side < 0 ? -W : W - areaW, -areaH, areaW, areaH * 2);
    }

    for (const team of ["moscow", "cairo"] as const) {
      const side = TEAMS[team].side;
      const x0 = side * W;
      const x1 = side * (W + D);
      ctx.fillStyle = COLORS.net;
      ctx.fillRect(Math.min(x0, x1), -G, D, G * 2);
      ctx.strokeStyle = COLORS.line;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0, -G);
      ctx.lineTo(x1, -G);
      ctx.lineTo(x1, G);
      ctx.lineTo(x0, G);
      ctx.stroke();
      for (const sy of [-1, 1]) {
        this.disc(x0, sy * G, PHYSICS.post.radius, TEAMS[team].color);
      }
    }
  }

  private drawPlayer(
    x: number,
    y: number,
    flags: number,
    cooldown: number,
    info: PlayerInfo,
    isMe: boolean,
  ) {
    const { ctx } = this;
    const r = PHYSICS.player.radius;
    const color = TEAMS[info.team as PlayingTeam].color;
    const kickArmed = (flags & PlayerFlag.kickArmed) !== 0;
    this.disc(x, y, r, color, kickArmed ? "#ffffff" : "#000000", kickArmed ? 3 : 2);

    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(info.num), x, y + 1);

    if (cooldown > 0) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,230,120,0.9)";
      ctx.beginPath();
      const start = -Math.PI / 2;
      ctx.arc(x, y, r + 5, start, start + (1 - cooldown) * Math.PI * 2);
      ctx.stroke();
    }

    if (isMe) {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.moveTo(x - 6, y - r - 16);
      ctx.lineTo(x + 6, y - r - 16);
      ctx.lineTo(x, y - r - 9);
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawName(x: number, y: number, name: string) {
    const { ctx } = this;
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.strokeText(name, x, y + PHYSICS.player.radius + 7);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(name, x, y + PHYSICS.player.radius + 7);
  }

  private drawBubble(x: number, y: number, text: string) {
    const { ctx } = this;
    ctx.font = "600 14px system-ui, sans-serif";
    const w = ctx.measureText(text).width + 16;
    const h = 24;
    const bx = x - w / 2;
    const by = y - PHYSICS.player.radius - 26 - h;
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.roundRect(bx, by, w, h, 8);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 5, by + h);
    ctx.lineTo(x + 5, by + h);
    ctx.lineTo(x, by + h + 6);
    ctx.fill();
    ctx.fillStyle = "#1b1b1b";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, by + h / 2 + 1);
  }

  private drawBall(x: number, y: number) {
    this.disc(x, y, PHYSICS.ball.radius, "#ffffff", "#000000", 2);
  }

  private disc(x: number, y: number, r: number, fill: string, stroke?: string, width = 2) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.lineWidth = width;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }
}
