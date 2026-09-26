import type { Point } from "../models/Robot";
import type { Environment } from "../models/Environment";

interface Node {
  x: number;
  y: number;
  g: number;
  h: number;
  f: number;
  parent: Node | null;
}

/**
 * Grid A* implementation that scales with Environment.width/height.
 *
 * The normal findPath() returns the shortest safe grid route.
 * findNaturalPath() deliberately introduces a small, bounded detour
 * through a walkable waypoint. This makes the fleet look less like every
 * robot is following the exact same Manhattan corridor while keeping
 * routes safe and reasonably efficient.
 */
export class AStar {
  private readonly environment: Environment;

  constructor(environment: Environment) {
    this.environment = environment;
  }

  findPath(
    start: Point,
    goal: Point,
    blockedPoints: Point[] = []
  ): Point[] {
    const sx = Math.round(start.x);
    const sy = Math.round(start.y);
    const gx = Math.round(goal.x);
    const gy = Math.round(goal.y);

    if (!this.environment.isWalkable(gx, gy)) return [];
    if (!this.environment.isInside(sx, sy)) return [];

    const blocked = new Set(
      blockedPoints.map(point => `${Math.round(point.x)},${Math.round(point.y)}`)
    );

    blocked.delete(`${sx},${sy}`);
    blocked.delete(`${gx},${gy}`);

    const key = (x: number, y: number) => `${x},${y}`;
    const heuristic = (x: number, y: number) =>
      Math.abs(x - gx) + Math.abs(y - gy);

    const open: Node[] = [{
      x: sx,
      y: sy,
      g: 0,
      h: heuristic(sx, sy),
      f: heuristic(sx, sy),
      parent: null,
    }];

    const bestG = new Map<string, number>();
    bestG.set(key(sx, sy), 0);

    const closed = new Set<string>();

    // Keep the base A* deterministic. Natural variation is handled by
    // findNaturalPath(), not by changing the core shortest-path search.
    const directions = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ];

    while (open.length > 0) {
      open.sort((a, b) => a.f - b.f || a.h - b.h);
      const current = open.shift()!;
      const currentKey = key(current.x, current.y);

      if (current.x === gx && current.y === gy) {
        return this.reconstruct(current);
      }

      if (closed.has(currentKey)) continue;
      closed.add(currentKey);

      for (const direction of directions) {
        const nx = current.x + direction.x;
        const ny = current.y + direction.y;
        const nextKey = key(nx, ny);

        if (
          !this.environment.isWalkable(nx, ny) ||
          blocked.has(nextKey) ||
          closed.has(nextKey)
        ) {
          continue;
        }

        const g = current.g + 1;
        const previousBest = bestG.get(nextKey);
        if (previousBest !== undefined && g >= previousBest) continue;

        bestG.set(nextKey, g);
        const h = heuristic(nx, ny);

        open.push({
          x: nx,
          y: ny,
          g,
          h,
          f: g + h,
          parent: current,
        });
      }
    }

    return [];
  }

  /**
   * Generate a natural-looking route.
   *
   * Most missions still use a direct shortest path. For longer missions,
   * a bounded random waypoint is selected and two safe A* segments are
   * joined. This creates different crossing patterns between robots and
   * avoids the visual effect of every robot taking one straight corridor.
   */
  findNaturalPath(
    start: Point,
    goal: Point,
    blockedPoints: Point[] = []
  ): Point[] {
    const direct = this.findPath(start, goal, blockedPoints);

    if (direct.length <= 7) {
      return direct;
    }

    // Roughly one third of longer trips remain shortest-path routes so the
    // fleet still contains some efficient/direct agents.
    if (Math.random() < 0.35) {
      return direct;
    }

    const candidates: Point[] = [];
    const sx = Math.round(start.x);
    const sy = Math.round(start.y);
    const gx = Math.round(goal.x);
    const gy = Math.round(goal.y);

    const directDistance = Math.abs(gx - sx) + Math.abs(gy - sy);
    const minLegDistance = Math.max(3, Math.floor(directDistance * 0.16));

    // Sample walkable points. The map is only 60x40, so this is cheap and
    // gives enough variety without maintaining another routing structure.
    for (let i = 0; i < 28; i++) {
      // Keep waypoints near the direct start→goal corridor. Sampling the
      // entire warehouse can produce visually dramatic but unnecessary loops.
      const minX = Math.max(2, Math.min(sx, gx) - 8);
      const maxX = Math.min(this.environment.width - 3, Math.max(sx, gx) + 8);
      const minY = Math.max(2, Math.min(sy, gy) - 8);
      const maxY = Math.min(this.environment.height - 3, Math.max(sy, gy) + 8);
      const x = minX + Math.floor(Math.random() * (maxX - minX + 1));
      const y = minY + Math.floor(Math.random() * (maxY - minY + 1));

      if (!this.environment.isWalkable(x, y)) continue;

      const fromStart = Math.abs(x - sx) + Math.abs(y - sy);
      const toGoal = Math.abs(gx - x) + Math.abs(gy - y);

      if (fromStart < minLegDistance || toGoal < minLegDistance) continue;

      candidates.push({ x, y });
    }

    // Try random candidates until one gives a useful, bounded detour.
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    for (const waypoint of candidates) {
      const first = this.findPath(start, waypoint, blockedPoints);
      if (first.length === 0) continue;

      const secondBlocked = [
        ...blockedPoints,
        ...first.slice(1, -1),
      ];

      const second = this.findPath(waypoint, goal, secondBlocked);
      if (second.length === 0) continue;

      const combined = [
        ...first,
        ...second.slice(1),
      ];

      // Keep the detour bounded. We want natural traffic, not silly loops.
      if (combined.length <= direct.length * 1.20) {
        return this.removeCollinearPoints(combined);
      }
    }

    return this.removeCollinearPoints(direct);
  }

  /**
   * Route to a safe interaction cell next to a physical floor object.
   * Robots never need to drive through the object's own grid cell.
   */
  findNaturalPathToObject(
    start: Point,
    objectPoint: Point,
    blockedPoints: Point[] = []
  ): Point[] {
    const ox = Math.round(objectPoint.x);
    const oy = Math.round(objectPoint.y);
    const blocked = [
      ...blockedPoints,
      { x: ox, y: oy },
    ];

    const candidates: Point[] = [
      { x: ox + 1, y: oy },
      { x: ox - 1, y: oy },
      { x: ox, y: oy + 1 },
      { x: ox, y: oy - 1 },
    ].filter(point =>
      this.environment.isWalkable(point.x, point.y) &&
      !blocked.some(
        blockedPoint =>
          Math.round(blockedPoint.x) === point.x &&
          Math.round(blockedPoint.y) === point.y
      )
    );

    if (candidates.length === 0) return [];

    // Prefer the closest approach cell, while allowing natural-path
    // variation to choose different sides of the object.
    const ranked = candidates
      .map(point => ({
        point,
        distance: Math.abs(Math.round(start.x) - point.x) +
          Math.abs(Math.round(start.y) - point.y),
      }))
      .sort((a, b) => a.distance - b.distance);

    const pool = ranked.slice(0, Math.min(3, ranked.length));

    // Shuffle the best approach cells, then try each one. This preserves
    // natural variation without making a task fail just because one side
    // of the object is temporarily inaccessible.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    for (const candidate of pool) {
      const route = this.findNaturalPath(start, candidate.point, blocked);
      if (route.length > 0) return route;
    }

    return [];
  }

  private removeCollinearPoints(path: Point[]): Point[] {
    if (path.length < 3) return path;

    const result: Point[] = [path[0]];

    for (let i = 1; i < path.length - 1; i++) {
      const prev = path[i - 1];
      const current = path[i];
      const next = path[i + 1];

      const dx1 = current.x - prev.x;
      const dy1 = current.y - prev.y;
      const dx2 = next.x - current.x;
      const dy2 = next.y - current.y;

      if (dx1 === dx2 && dy1 === dy2) {
        continue;
      }

      result.push(current);
    }

    result.push(path[path.length - 1]);
    return result;
  }

  private reconstruct(node: Node): Point[] {
    const path: Point[] = [];
    let current: Node | null = node;

    while (current) {
      path.push({ x: current.x, y: current.y });
      current = current.parent;
    }

    path.reverse();
    return path;
  }
}
