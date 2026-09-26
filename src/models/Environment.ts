import type { Point } from "./Robot";

export type CellType = "FREE" | "OBSTACLE" | "CHARGING";

export interface GridCell {
  x: number;
  y: number;
  type: CellType;
}

export interface ChargingStation extends Point {
  id?: string;
  width?: number;
  height?: number;
}

export interface ChargingSlot {
  station: Point;
  slot: Point;
}

/**
 * Large scalable warehouse for the 100-robot NEXUS demo.
 * 120 x 80 grid: roughly 2x the earlier 60 x 40 working area.
 * Obstacles are arranged as long shelves with wide traffic aisles.
 */
export class Environment {
  width = 200;
  height = 80;

  obstacles: Point[] = [];
  grid: GridCell[][] = [];
  // The warehouse occupies x=1..119. Charging is deliberately moved into
  // a separate depot on the right side so charging traffic never shares the
  // main warehouse floor.
  chargingStations: ChargingStation[] = [
    { x: 137, y: 40, id: "CS1", width: 11, height: 11 },
    { x: 180, y: 40, id: "CS2", width: 11, height: 11 },
  ];

  chargingSlots: ChargingSlot[] = [];

  private obstacleKeys = new Set<string>();

  constructor() {
    this.buildWarehouse();
    this.buildGrid();
  }

  private buildGrid(): void {
    this.grid = [];
    for (let y = 0; y < this.height; y++) {
      const row: GridCell[] = [];
      for (let x = 0; x < this.width; x++) {
        row.push({
          x, y,
          type: this.obstacleKeys.has(this.key(x, y)) ? "OBSTACLE" : "FREE",
        });
      }
      this.grid.push(row);
    }
    // Mark the complete right-side charging yard separately from warehouse
    // floor cells. This gives the renderer a distinct infrastructure zone.
    for (let y = 2; y < this.height - 2; y++) {
      for (let x = 124; x < this.width - 2; x++) {
        if (this.isInside(x, y) && !this.obstacleKeys.has(this.key(x, y))) {
          this.grid[y][x].type = "CHARGING";
        }
      }
    }
    for (const station of this.chargingStations) {
      if (this.isInside(station.x, station.y)) this.grid[station.y][station.x].type = "CHARGING";
    }
    for (const item of this.chargingSlots) {
      if (this.isInside(item.slot.x, item.slot.y)) this.grid[item.slot.y][item.slot.x].type = "CHARGING";
    }
  }

  private key(x: number, y: number): string {
    return `${x},${y}`;
  }

  private addObstacle(x: number, y: number): void {
    if (!this.isInside(x, y)) return;
    const key = this.key(x, y);
    if (this.obstacleKeys.has(key)) return;
    this.obstacleKeys.add(key);
    this.obstacles.push({ x, y });
  }

  private addRectangle(x1: number, y1: number, x2: number, y2: number): void {
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        this.addObstacle(x, y);
      }
    }
  }

  private buildWarehouse(): void {
    // Outer boundary of the complete simulation canvas. The warehouse itself
    // remains the left 120x80 area; the right-side depot is a separate yard.
    for (let x = 0; x < this.width; x++) {
      this.addObstacle(x, 0);
      this.addObstacle(x, this.height - 1);
    }
    for (let y = 0; y < this.height; y++) {
      this.addObstacle(0, y);
      this.addObstacle(this.width - 1, y);
    }

    // Long shelf blocks. Wide horizontal aisles are intentionally left open.
    const shelfRows = [
      [18, 23],
      [30, 35],
      [42, 47],
      [54, 59],
    ];

    for (const [y1, y2] of shelfRows) {
      this.addRectangle(18, y1, 52, y2);
      this.addRectangle(68, y1, 102, y2);
    }

    // Short central blocks create realistic intersections without splitting
    // the warehouse into disconnected regions.
    this.addRectangle(57, 25, 63, 29);
    this.addRectangle(57, 51, 63, 55);

    // Physical separation between the warehouse and the charging yard.
    // There are now two dedicated gates: a TOP/IN gate and a BOTTOM/OUT
    // gate. This makes the depot behave like a real parking lot: robots do
    // not enter and leave through the same narrow opening.
    for (let y = 1; y < this.height - 1; y++) {
      const inGate = y >= 18 && y <= 22;
      const outGate = y >= 58 && y <= 62;
      if (!inGate && !outGate) {
        this.addObstacle(120, y);
      }
    }

    // Keep the dedicated charging-yard station footprints free from ordinary
    // obstacles. The charging yard itself is separate from warehouse traffic.
    for (const station of this.chargingStations) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const key = this.key(station.x + dx, station.y + dy);
          if (this.obstacleKeys.delete(key)) {
            this.obstacles = this.obstacles.filter(
              p => p.x !== station.x + dx || p.y !== station.y + dy
            );
          }
        }
      }
    }
  }

  isInside(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  isWalkable(x: number, y: number): boolean {
    if (!this.isInside(x, y)) return false;
    return !this.obstacleKeys.has(this.key(x, y));
  }
}
