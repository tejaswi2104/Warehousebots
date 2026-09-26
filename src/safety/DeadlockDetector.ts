import type { Robot } from "../models/Robot";

export interface DeadlockEvent {
  id: string;
  robotIds: string[];
  recoveryRobotId: string;
  point: { x: number; y: number };
  reason: string;
  timestamp: number;
}

/**
 * Detects actual cyclic wait dependencies rather than treating
 * every pair of waiting robots as a deadlock.
 */
export class DeadlockDetector {
  detect(robots: Robot[]): DeadlockEvent[] {
    const active = robots.filter(
      robot =>
        robot.state !== "FAILED" &&
        robot.routeIndex < robot.route.length
    );

    const byId = new Map(
      active.map(robot => [robot.id, robot])
    );

    const waitFor = new Map<string, string>();

    for (const robot of active) {
      const next = robot.route[robot.routeIndex];
      if (!next) continue;

      // A robot is blocked when its next cell is occupied by another robot.
      const blocker = active.find(
        other =>
          other.id !== robot.id &&
          Math.round(other.position.x) === next.x &&
          Math.round(other.position.y) === next.y
      );

      if (blocker) {
        waitFor.set(robot.id, blocker.id);
      }
    }

    const events: DeadlockEvent[] = [];
    const seen = new Set<string>();

    for (const start of active) {
      if (!waitFor.has(start.id)) continue;

      const path: string[] = [];
      const index = new Map<string, number>();
      let current: string | undefined = start.id;

      while (current && waitFor.has(current)) {
        if (index.has(current)) {
          const cycle = path.slice(index.get(current)!);
          if (cycle.length >= 2) {
            const robotIds = [...cycle].sort();
            const key = robotIds.join("|");

            if (!seen.has(key)) {
              seen.add(key);

              const cycleRobots = robotIds
                .map(id => byId.get(id))
                .filter((robot): robot is Robot => Boolean(robot));

              const recovery = this.chooseRecoveryRobot(cycleRobots);
              const recoveryRobot = byId.get(recovery);
              const point = recoveryRobot?.route[recoveryRobot.routeIndex] ?? recoveryRobot?.position ?? { x: 0, y: 0 };

              events.push({
                id: `${key}@${point.x},${point.y}`,
                robotIds,
                recoveryRobotId: recovery,
                point: { x: point.x, y: point.y },
                reason: `Cyclic wait-for dependency detected across ${robotIds.length} robots.`,
                timestamp: Date.now(),
              });
            }
          }
          break;
        }

        index.set(current, path.length);
        path.push(current);
        current = waitFor.get(current);
      }
    }

    return events;
  }

  private chooseRecoveryRobot(robots: Robot[]): string {
    // Preserve urgent missions. Prefer a robot without an emergency mission,
    // then lower task priority, then lower battery pressure, then ID.
    return [...robots].sort((a, b) => {
      const emergencyA = a.type === "EMERGENCY" ? 1 : 0;
      const emergencyB = b.type === "EMERGENCY" ? 1 : 0;
      if (emergencyA !== emergencyB) return emergencyA - emergencyB;

      const priorityA = this.getTaskPriority(a);
      const priorityB = this.getTaskPriority(b);
      if (priorityA !== priorityB) return priorityA - priorityB;

      if (a.battery !== b.battery) return a.battery - b.battery;
      return a.id.localeCompare(b.id);
    })[0]?.id ?? robots[0].id;
  }

  private getTaskPriority(robot: Robot): number {
    // The detector intentionally stays independent of Task[] so it can be
    // used by the simulator and by the standalone deadlock test.
    return robot.currentTaskId ? 1 : 0;
  }
}
