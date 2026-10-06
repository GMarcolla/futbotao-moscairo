import { PHYSICS, STADIUM } from "./constants";

export interface Disc {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** 0 = imóvel (traves). */
  invMass: number;
  bCoef: number;
  damping: number;
}

/** A quem uma parede se aplica. */
export const Mask = {
  ball: 1,
  player: 2,
} as const;

export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Normal unitária apontando para o lado permitido (paredes de um lado só). */
  nx: number;
  ny: number;
  /** Paredes de dois lados bloqueiam dos dois lados (rede do gol). */
  twoSided: boolean;
  mask: number;
  bCoef: number;
}

function segment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  inside: { x: number; y: number },
  mask: number,
  bCoef: number,
  twoSided = false,
): Segment {
  const len = Math.hypot(bx - ax, by - ay);
  let nx = -(by - ay) / len;
  let ny = (bx - ax) / len;
  if ((inside.x - ax) * nx + (inside.y - ay) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { ax, ay, bx, by, nx, ny, twoSided, mask, bCoef };
}

function buildStadium(): { segments: Segment[]; posts: Disc[] } {
  const W = STADIUM.halfWidth;
  const H = STADIUM.halfHeight;
  const G = STADIUM.goalHalfWidth;
  const D = STADIUM.goalDepth;
  const M = STADIUM.playerMargin;
  const center = { x: 0, y: 0 };
  const wall = PHYSICS.wallBCoef;
  const segments: Segment[] = [
    // Linhas do campo (só a bola).
    segment(-W, -H, W, -H, center, Mask.ball, wall),
    segment(-W, H, W, H, center, Mask.ball, wall),
    segment(-W, -H, -W, -G, center, Mask.ball, wall),
    segment(-W, G, -W, H, center, Mask.ball, wall),
    segment(W, -H, W, -G, center, Mask.ball, wall),
    segment(W, G, W, H, center, Mask.ball, wall),
    // Limite externo dos jogadores.
    segment(-W - M, -H - M, W + M, -H - M, center, Mask.player, PHYSICS.playerWallBCoef),
    segment(-W - M, H + M, W + M, H + M, center, Mask.player, PHYSICS.playerWallBCoef),
    segment(-W - M, -H - M, -W - M, H + M, center, Mask.player, PHYSICS.playerWallBCoef),
    segment(W + M, -H - M, W + M, H + M, center, Mask.player, PHYSICS.playerWallBCoef),
  ];
  // Redes dos dois gols (bola e jogadores, bloqueiam dos dois lados).
  for (const side of [-1, 1]) {
    const lineX = side * W;
    const backX = side * (W + D);
    const inGoal = { x: side * (W + D / 2), y: 0 };
    const both = Mask.ball | Mask.player;
    segments.push(
      segment(lineX, -G, backX, -G, inGoal, both, wall, true),
      segment(backX, -G, backX, G, inGoal, both, wall, true),
      segment(lineX, G, backX, G, inGoal, both, wall, true),
    );
  }
  const posts: Disc[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      posts.push({
        x: sx * W,
        y: sy * G,
        vx: 0,
        vy: 0,
        radius: PHYSICS.post.radius,
        invMass: 0,
        bCoef: PHYSICS.post.bCoef,
        damping: 1,
      });
    }
  }
  return { segments, posts };
}

export const STADIUM_GEOMETRY = buildStadium();

export function integrate(d: Disc): void {
  d.x += d.vx;
  d.y += d.vy;
  d.vx *= d.damping;
  d.vy *= d.damping;
}

/** Resolve colisão entre dois discos. Retorna true se encostaram. */
export function collideDiscs(a: Disc, b: Disc): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const minDist = a.radius + b.radius;
  const dist2 = dx * dx + dy * dy;
  if (dist2 >= minDist * minDist) return false;
  const massSum = a.invMass + b.invMass;
  if (massSum === 0) return false;
  const dist = Math.sqrt(dist2);
  // Discos exatamente sobrepostos: separa em uma direção qualquer.
  const nx = dist > 0 ? dx / dist : 1;
  const ny = dist > 0 ? dy / dist : 0;
  const overlap = minDist - dist;
  a.x -= nx * overlap * (a.invMass / massSum);
  a.y -= ny * overlap * (a.invMass / massSum);
  b.x += nx * overlap * (b.invMass / massSum);
  b.y += ny * overlap * (b.invMass / massSum);
  const relVel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (relVel < 0) {
    const impulse = (-(1 + a.bCoef * b.bCoef) * relVel) / massSum;
    a.vx -= nx * impulse * a.invMass;
    a.vy -= ny * impulse * a.invMass;
    b.vx += nx * impulse * b.invMass;
    b.vy += ny * impulse * b.invMass;
  }
  return true;
}

/**
 * Colisão disco x segmento. Só considera o interior do segmento: as pontas
 * expostas (aberturas do gol) são cobertas pelas traves.
 */
export function collideSegment(d: Disc, s: Segment): void {
  const sx = s.bx - s.ax;
  const sy = s.by - s.ay;
  const t = ((d.x - s.ax) * sx + (d.y - s.ay) * sy) / (sx * sx + sy * sy);
  if (t <= 0 || t >= 1) return;
  let dist = (d.x - s.ax) * s.nx + (d.y - s.ay) * s.ny;
  let nx = s.nx;
  let ny = s.ny;
  if (s.twoSided && dist < 0) {
    dist = -dist;
    nx = -nx;
    ny = -ny;
  }
  // Tolerância de um raio atrás da parede para não "puxar" discos de longe.
  if (dist >= d.radius || dist < -d.radius) return;
  d.x += nx * (d.radius - dist);
  d.y += ny * (d.radius - dist);
  const vn = d.vx * nx + d.vy * ny;
  if (vn < 0) {
    const k = (1 + d.bCoef * s.bCoef) * vn;
    d.vx -= nx * k;
    d.vy -= ny * k;
  }
}
