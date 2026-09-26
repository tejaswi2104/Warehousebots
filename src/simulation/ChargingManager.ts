import type { Point, Robot } from "../models/Robot";
import type { Environment, ChargingSlot, ChargingStation } from "../models/Environment";

export interface ChargingReservation {
  robotId: string;
  stationId: string;
  slot: Point;
  state: "QUEUED" | "RESERVED";
}

/**
 * Dynamic charging resource manager.
 *
 * Stations are stable home destinations, while individual bays remain
 * temporary resources. A robot may prefer its home station without owning a
 * permanent bay.
 */
export class ChargingManager {
  private readonly queues = new Map<string, string[]>();
  private readonly reservations = new Map<string, ChargingReservation>();

  reset(stations: ChargingStation[]): void {
    this.queues.clear();
    this.reservations.clear();
    for (const station of stations) {
      this.queues.set(this.stationId(station), []);
    }
  }

  request(
    robot: Robot,
    environment: Environment,
    robots: Robot[],
    preferredStationId?: string,
  ): ChargingReservation | null {
    const existing = this.reservations.get(robot.id);
    if (existing) return existing;

    let station: ChargingStation | null = null;
    let stationId = "";

    // A robot keeps a stable preferred/home station, but the bay itself is
    // still allocated dynamically every charging trip.
    if (preferredStationId) {
      station = environment.chargingStations.find(
        item => this.stationId(item) === preferredStationId,
      ) ?? null;
      if (station) stationId = this.stationId(station);
    }

    if (!station) {
      station = this.chooseStation(robot, environment);
      if (!station) return null;
      stationId = this.stationId(station);
    }

    const queue = this.queues.get(stationId) ?? [];
    if (!queue.includes(robot.id)) queue.push(robot.id);
    this.queues.set(stationId, queue);

    const slot = this.chooseAvailableSlot(station, environment.chargingSlots, robots);
    if (!slot) {
      return null;
    }

    // Only one robot may own a physical bay at a time.
    const occupiedByReservation = [...this.reservations.values()].some(item =>
      item.state === "RESERVED" &&
      item.stationId === stationId &&
      item.slot.x === slot.x &&
      item.slot.y === slot.y,
    );
    if (occupiedByReservation) return null;

    const reservation: ChargingReservation = {
      robotId: robot.id,
      stationId,
      slot,
      state: "RESERVED",
    };
    this.reservations.set(robot.id, reservation);
    return reservation;
  }

  release(robotId: string): void {
    const reservation = this.reservations.get(robotId);
    if (reservation) {
      const queue = this.queues.get(reservation.stationId) ?? [];
      this.queues.set(
        reservation.stationId,
        queue.filter(id => id !== robotId),
      );
    } else {
      for (const [stationId, queue] of this.queues) {
        if (queue.includes(robotId)) {
          this.queues.set(stationId, queue.filter(id => id !== robotId));
        }
      }
    }
    this.reservations.delete(robotId);
  }

  get(robotId: string): ChargingReservation | null {
    return this.reservations.get(robotId) ?? null;
  }

  getQueuePoint(robotId: string, environment: Environment): Point | null {
    let stationId = "";
    let index = -1;
    for (const [id, queue] of this.queues) {
      const i = queue.indexOf(robotId);
      if (i >= 0) {
        stationId = id;
        index = i;
        break;
      }
    }
    if (!stationId || index < 0) return null;

    const station = environment.chargingStations.find(
      item => this.stationId(item) === stationId,
    );
    if (!station) return null;

    const side = station.x < environment.width / 2 ? 1 : -1;
    const queueDistance = 12 + Math.min(index, 7) * 5;
    return { x: station.x + side * queueDistance, y: station.y };
  }

  queuePosition(robotId: string): number {
    for (const queue of this.queues.values()) {
      const index = queue.indexOf(robotId);
      if (index >= 0) return index + 1;
    }
    return 0;
  }

  private chooseStation(robot: Robot, environment: Environment): ChargingStation | null {
    let best: ChargingStation | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const station of environment.chargingStations) {
      const d = Math.hypot(robot.position.x - station.x, robot.position.y - station.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = station;
      }
    }
    return best;
  }

  private chooseAvailableSlot(
    station: ChargingStation,
    slots: ChargingSlot[],
    robots: Robot[],
  ): Point | null {
    const stationSlots = slots.filter(item =>
      item.station.x === station.x && item.station.y === station.y,
    );

    let best: Point | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const item of stationSlots) {
      const occupied = robots.some(other =>
        other.id !== this.findRobotIdAtSlot(robots, item.slot) &&
        other.state !== "FAILED" &&
        Math.hypot(other.position.x - item.slot.x, other.position.y - item.slot.y) < 1.35,
      );
      if (occupied) continue;

      const reserved = [...this.reservations.values()].some(res =>
        res.state === "RESERVED" &&
        res.stationId === this.stationId(station) &&
        res.slot.x === item.slot.x &&
        res.slot.y === item.slot.y,
      );
      if (reserved) continue;

      const d = Math.abs(item.slot.x - station.x) + Math.abs(item.slot.y - station.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = { x: item.slot.x, y: item.slot.y };
      }
    }
    return best;
  }

  private findRobotIdAtSlot(robots: Robot[], slot: Point): string | null {
    const robot = robots.find(item =>
      Math.hypot(item.position.x - slot.x, item.position.y - slot.y) < 0.55,
    );
    return robot?.id ?? null;
  }

  private stationId(station: ChargingStation): string {
    return station.id ?? `${station.x},${station.y}`;
  }
}
