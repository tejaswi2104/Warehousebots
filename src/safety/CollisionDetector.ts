import type { Point, Robot } from "../models/Robot";

export interface CollisionPrediction {
  robotA: string;
  robotB: string;
  conflictPoint: Point;
  timeA: number;
  timeB: number;
  timeDifference: number;
  severity: "LOW" | "MEDIUM" | "HIGH";
}

export class CollisionDetector {
  private predictionHorizon = 8;

  detectCollisions(robots: Robot[]): CollisionPrediction[] {
    const predictions: CollisionPrediction[] = [];

    for (let i = 0; i < robots.length; i++) {
      for (let j = i + 1; j < robots.length; j++) {
        const robotA = robots[i];
        const robotB = robots[j];

        const prediction =
          this.predictCollision(robotA, robotB);

        if (prediction !== null) {
          predictions.push(prediction);
        }
      }
    }

    return predictions;
  }

  private predictCollision(
    robotA: Robot,
    robotB: Robot
  ): CollisionPrediction | null {
    if (
      robotA.state === "FAILED" ||
      robotB.state === "FAILED"
    ) {
      return null;
    }

    if (
      robotA.route.length === 0 ||
      robotB.route.length === 0
    ) {
      return null;
    }

    const routeA = this.getFutureRoute(robotA);
    const routeB = this.getFutureRoute(robotB);

    for (let i = 0; i < routeA.length; i++) {
      const pointA = routeA[i];

      for (let j = 0; j < routeB.length; j++) {
        const pointB = routeB[j];

        if (
          pointA.x !== pointB.x ||
          pointA.y !== pointB.y
        ) {
          continue;
        }

        const timeA =
          this.estimateArrivalTime(robotA, i);

        const timeB =
          this.estimateArrivalTime(robotB, j);

        const timeDifference =
          Math.abs(timeA - timeB);

        // Robots reaching the same cell at nearly
        // the same time are considered a collision risk.
        if (timeDifference <= 2.0) {
          return {
            robotA: robotA.id,
            robotB: robotB.id,
            conflictPoint: pointA,
            timeA,
            timeB,
            timeDifference,
            severity:
              timeDifference <= 0.75
                ? "HIGH"
                : timeDifference <= 1.5
                  ? "MEDIUM"
                  : "LOW",
          };
        }
      }
    }

    return null;
  }

  private getFutureRoute(robot: Robot): Point[] {
    const startIndex = Math.max(
      0,
      robot.routeIndex
    );

    return robot.route.slice(
      startIndex,
      startIndex + this.predictionHorizon
    );
  }

  private estimateArrivalTime(
    robot: Robot,
    routeOffset: number
  ): number {
    const speed = Math.max(robot.speed, 0.1);

    return routeOffset / speed;
  }
}