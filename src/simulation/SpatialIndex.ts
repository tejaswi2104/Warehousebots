import type { Point, Robot } from "../models/Robot";

/**
 * Lightweight uniform-grid spatial index used by the simulation for local
 * traffic, communication and collision queries. It deliberately exposes
 * only nearby objects so fleet-wide scans are avoided.
 */
export class SpatialIndex {
  private readonly cellSize: number;
  private readonly buckets = new Map<string, Robot[]>();

  constructor(cellSize = 3) {
    this.cellSize = Math.max(1, cellSize);
  }

  rebuild(robots: Robot[]): void {
    this.buckets.clear();
    for (const robot of robots) {
      if (robot.state === "FAILED") continue;
      const key = this.key(robot.position.x, robot.position.y);
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(robot);
      else this.buckets.set(key, [robot]);
    }
  }

  nearby(point: Point, radius: number): Robot[] {
    const result: Robot[] = [];
    const cellRadius = Math.ceil(radius / this.cellSize);
    const cx = Math.floor(point.x / this.cellSize);
    const cy = Math.floor(point.y / this.cellSize);
    const radiusSq = radius * radius;

    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      for (let dy = -cellRadius; dy <= cellRadius; dy++) {
        const bucket = this.buckets.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const robot of bucket) {
          const rx = robot.position.x - point.x;
          const ry = robot.position.y - point.y;
          if (rx * rx + ry * ry <= radiusSq) result.push(robot);
        }
      }
    }
    return result;
  }

  nearbyRobot(robot: Robot, radius: number): Robot[] {
    return this.nearby(robot.position, radius).filter(item => item.id !== robot.id);
  }

  private key(x: number, y: number): string {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }
}
