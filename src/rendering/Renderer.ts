import type { Robot } from "../models/Robot";
import type { Task } from "../models/Task";
import type { Environment } from "../models/Environment";

/**
 * Responsive warehouse renderer.
 * The complete logical warehouse is always drawn; the canvas scales to its
 * parent width so a 60x40 warehouse remains usable on desktop and laptop.
 */
export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly environment: Environment;
  private readonly ctx: CanvasRenderingContext2D;
  private cellSize = 16;
  private offsetX = 0;
  private offsetY = 0;
  private cssWidth = 900;
  private cssHeight = 600;

  constructor(canvas: HTMLCanvasElement, environment: Environment) {
    this.canvas = canvas;
    this.environment = environment;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not create 2D canvas context");
    }

    this.ctx = ctx;

    const parent = canvas.parentElement;
    if (parent && "ResizeObserver" in window) {
      const observer = new ResizeObserver(() => this.resize());
      observer.observe(parent);
    } else {
      window.addEventListener("resize", () => this.resize());
    }

    this.resize();
  }

  private resize(): void {
    const parentWidth =
      this.canvas.parentElement?.clientWidth ?? 1100;

    this.cssWidth = Math.max(520, parentWidth);
    this.cssHeight = Math.round(
      this.cssWidth * (this.environment.height / this.environment.width)
    );

    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

    this.canvas.style.width = `${this.cssWidth}px`;
    this.canvas.style.height = `${this.cssHeight}px`;
    this.canvas.width = Math.round(this.cssWidth * dpr);
    this.canvas.height = Math.round(this.cssHeight * dpr);

    this.cellSize = Math.min(
      this.cssWidth / this.environment.width,
      this.cssHeight / this.environment.height
    );

    this.offsetX =
      (this.cssWidth - this.cellSize * this.environment.width) / 2;
    this.offsetY =
      (this.cssHeight - this.cellSize * this.environment.height) / 2;
  }

  render(robots: Robot[], tasks: Task[]): void {
    this.resize();

    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const ctx = this.ctx;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);

    // Warehouse background.
    ctx.fillStyle = "#07101a";
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);

    this.drawWarehouseFloor();
    this.drawTrafficLanes();
    this.drawObstacles();
    this.drawChargingStations();
    this.drawRobotPaths(robots);
    this.drawTasks(tasks);
    this.drawRobots(robots);

    ctx.restore();
  }

  private drawWarehouseFloor(): void {
    const ctx = this.ctx;
    const w = this.environment.width * this.cellSize;
    const h = this.environment.height * this.cellSize;

    // A clean industrial floor. The logical routing grid is deliberately
    // invisible so the simulator reads like a warehouse rather than graph paper.
    ctx.fillStyle = "#0b141d";
    ctx.fillRect(0, 0, w, h);

    // Large floor zones give subtle spatial structure without grid lines.
    const zoneSize = this.cellSize * 8;
    ctx.strokeStyle = "rgba(104, 143, 171, 0.055)";
    ctx.lineWidth = 1;

    for (let x = 0; x < w; x += zoneSize) {
      for (let y = 0; y < h; y += zoneSize) {
        ctx.strokeRect(x + 0.5, y + 0.5, zoneSize, zoneSize);
      }
    }

    ctx.strokeStyle = "rgba(53, 214, 255, 0.25)";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, w, h);
  }

  private drawTrafficLanes(): void {
    const ctx = this.ctx;
    const laneWidth = Math.max(5, this.cellSize * 0.75);

    // Broad aisle bands sit underneath the route paths. They make the map
    // read as a real warehouse floor while keeping the A* grid invisible.
    const horizontalLanes = [4.5, 11.5, 18.5, 25.5, 32.5, 37.5];
    for (const y of horizontalLanes) {
      ctx.fillStyle = "rgba(41, 73, 91, 0.12)";
      ctx.fillRect(0, y * this.cellSize - laneWidth / 2, this.environment.width * this.cellSize, laneWidth);

      ctx.strokeStyle = "rgba(122, 165, 190, 0.10)";
      ctx.lineWidth = 1;
      ctx.setLineDash([this.cellSize * 0.45, this.cellSize * 0.55]);
      ctx.beginPath();
      ctx.moveTo(0, y * this.cellSize);
      ctx.lineTo(this.environment.width * this.cellSize, y * this.cellSize);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const verticalLanes = [4.5, 26.5, 33.5, 55.5];
    for (const x of verticalLanes) {
      ctx.fillStyle = "rgba(41, 73, 91, 0.09)";
      ctx.fillRect(x * this.cellSize - laneWidth / 2, 0, laneWidth, this.environment.height * this.cellSize);
    }
  }

  private drawObstacles(): void {
    const ctx = this.ctx;

    for (const row of this.environment.grid) {
      for (const cell of row) {
        if (cell.type !== "OBSTACLE") continue;

        const x = cell.x * this.cellSize;
        const y = cell.y * this.cellSize;

        ctx.fillStyle = "#182532";
        ctx.fillRect(x + 0.5, y + 0.5, this.cellSize - 1, this.cellSize - 1);
      }
    }

    // Emphasize shelf faces as long physical storage racks.
    ctx.strokeStyle = "rgba(126, 162, 187, 0.32)";
    ctx.lineWidth = Math.max(1, this.cellSize * 0.07);

    for (let y = 7; y <= 30; y += 7) {
      for (const x of [8, 34]) {
        ctx.strokeRect(
          x * this.cellSize + 2,
          y * this.cellSize + 2,
          18 * this.cellSize - 4,
          3 * this.cellSize - 4
        );
      }
    }
  }

  private drawChargingStations(): void {
    const ctx = this.ctx;

    for (const station of this.environment.chargingStations) {
      const cx = (station.x + 0.5) * this.cellSize;
      const cy = (station.y + 0.5) * this.cellSize;
      const radius = this.cellSize * 0.38;

      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.35, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(53, 214, 255, 0.08)";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = "#12384a";
      ctx.fill();
      ctx.strokeStyle = "#35d6ff";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = "#35d6ff";
      ctx.font = `${Math.max(9, this.cellSize * 0.52)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("⚡", cx, cy);
    }

    // Subtle parking-slot markers keep completed robots visibly separated.
    for (const item of this.environment.chargingSlots) {
      const x = item.slot.x * this.cellSize;
      const y = item.slot.y * this.cellSize;
      ctx.strokeStyle = "rgba(53, 214, 255, 0.22)";
      ctx.lineWidth = 1;
      ctx.strokeRect(
        x + 3,
        y + 3,
        this.cellSize - 6,
        this.cellSize - 6
      );
    }
  }

  private drawTasks(tasks: Task[]): void {
    for (const task of tasks) {
      if (task.status !== "IN_PROGRESS" && task.status !== "COMPLETED") {
        this.drawTaskObject(task.pickup, this.taskSymbol(task.type), this.taskObjectColor(task.type), "P");
      }

      if (task.status !== "COMPLETED") {
        this.drawTaskObject(task.dropoff, "D", "#ff9f43", "D");
      }
    }
  }

  private drawTaskObject(
    point: { x: number; y: number },
    symbol: string,
    fill: string,
    label: string
  ): void {
    const ctx = this.ctx;
    const x = point.x * this.cellSize;
    const y = point.y * this.cellSize;
    const pad = Math.max(2, this.cellSize * 0.13);
    const size = this.cellSize - pad * 2;

    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.fillRect(x + pad + 2, y + pad + 2, size, size);
    ctx.fillStyle = fill;
    ctx.globalAlpha = 0.90;
    ctx.fillRect(x + pad, y + pad, size, size);
    ctx.globalAlpha = 1;

    ctx.strokeStyle = "rgba(255,255,255,0.58)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + pad, y + pad, size, size);

    // Simple canvas-drawn pictogram: stable across browsers and does not
    // depend on an emoji font being installed.
    ctx.fillStyle = "#061016";
    ctx.font = `bold ${Math.max(8, this.cellSize * 0.34)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(symbol, x + this.cellSize / 2, y + this.cellSize * 0.47);

    ctx.font = `bold ${Math.max(5, this.cellSize * 0.16)}px sans-serif`;
    ctx.fillText(label, x + this.cellSize / 2, y + this.cellSize * 0.82);
  }

  private taskSymbol(type: Task["type"]): string {
    switch (type) {
      case "HEAVY_TRANSPORT": return "H";
      case "INSPECTION": return "⌕";
      case "EMERGENCY": return "!";
      case "PICKUP": return "□";
      case "DELIVERY":
      default: return "□";
    }
  }

  private taskObjectColor(type: Task["type"]): string {
    switch (type) {
      case "HEAVY_TRANSPORT": return "#ff9f43";
      case "INSPECTION": return "#a78bfa";
      case "EMERGENCY": return "#ff5d7d";
      default: return "#35d6ff";
    }
  }

  private drawRobotPaths(robots: Robot[]): void {
    const ctx = this.ctx;

    // Only draw the robot's forward/planned route.
    // Historical movement trails are intentionally hidden so the warehouse
    // remains clean and easy to read during long simulations.
    for (const robot of robots) {
      const color = this.robotColor(robot);

      if (robot.route.length <= robot.routeIndex) {
        continue;
      }

      const start = robot.position;

      ctx.beginPath();
      ctx.moveTo(
        (start.x + 0.5) * this.cellSize,
        (start.y + 0.5) * this.cellSize
      );

      for (let i = robot.routeIndex; i < robot.route.length; i++) {
        const point = robot.route[i];
        ctx.lineTo(
          (point.x + 0.5) * this.cellSize,
          (point.y + 0.5) * this.cellSize
        );
      }

      ctx.strokeStyle = `${color}99`;
      ctx.lineWidth = Math.max(1.2, this.cellSize * 0.075);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.setLineDash([
        Math.max(3, this.cellSize * 0.30),
        Math.max(3, this.cellSize * 0.22),
      ]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private drawRobots(robots: Robot[]): void {
    const ctx = this.ctx;

    for (const robot of robots) {
      const cx = (robot.position.x + 0.5) * this.cellSize;
      const cy = (robot.position.y + 0.5) * this.cellSize;
      const radius = Math.max(5, this.cellSize * 0.38);

      const fill = this.robotColor(robot);

      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.45, 0, Math.PI * 2);
      ctx.fillStyle = `${fill}22`;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();

      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = "#061016";
      ctx.font = `bold ${Math.max(8, this.cellSize * 0.32)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.robotSymbol(robot.type), cx, cy);

      ctx.fillStyle = "rgba(235,245,250,0.92)";
      ctx.font = `bold ${Math.max(5, this.cellSize * 0.15)}px sans-serif`;
      ctx.fillText(robot.id, cx, cy - radius - Math.max(3, this.cellSize * 0.10));

      if (robot.state === "CHARGING") {
        ctx.strokeStyle = "rgba(53,214,255,0.9)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, radius + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  private robotSymbol(type: Robot["type"]): string {
    switch (type) {
      case "FAST_PICKER": return "P";
      case "HEAVY_CARRIER": return "C";
      case "INSPECTION": return "I";
      case "EMERGENCY": return "!";
      default: return "R";
    }
  }

  private robotColor(robot: Robot): string {
    switch (robot.type) {
      case "FAST_PICKER":
        return "#35d6ff";
      case "HEAVY_CARRIER":
        return "#ff9f43";
      case "INSPECTION":
        return "#a78bfa";
      case "EMERGENCY":
        return "#ff5d7d";
      default:
        return "#ffffff";
    }
  }
}
