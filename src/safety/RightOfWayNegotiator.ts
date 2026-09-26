import type { Robot } from "../models/Robot";
import type { Task } from "../models/Task";
import type { CollisionPrediction } from "./CollisionDetector";

export interface RightOfWayDecision {
  conflict: CollisionPrediction;

  priorityRobotId: string;
  yieldingRobotId: string;

  priorityScore: number;
  yieldingScore: number;

  reason: string;
}

export class RightOfWayNegotiator {
  negotiate(
    conflict: CollisionPrediction,
    robots: Robot[],
    tasks: Task[]
  ): RightOfWayDecision | null {
    const robotA = robots.find(
      robot =>
        robot.id === conflict.robotA
    );

    const robotB = robots.find(
      robot =>
        robot.id === conflict.robotB
    );

    if (!robotA || !robotB) {
      return null;
    }

    const taskA = this.getRobotTask(
      robotA,
      tasks
    );

    const taskB = this.getRobotTask(
      robotB,
      tasks
    );

    const scoreA =
      this.calculatePriorityScore(
        robotA,
        taskA,
        conflict.timeA
      );

    const scoreB =
      this.calculatePriorityScore(
        robotB,
        taskB,
        conflict.timeB
      );

    let priorityRobot: Robot;
    let yieldingRobot: Robot;

    let priorityScore: number;
    let yieldingScore: number;

    if (scoreA >= scoreB) {
      priorityRobot = robotA;
      yieldingRobot = robotB;

      priorityScore = scoreA;
      yieldingScore = scoreB;
    } else {
      priorityRobot = robotB;
      yieldingRobot = robotA;

      priorityScore = scoreB;
      yieldingScore = scoreA;
    }

    const reason =
      this.buildReason(
        priorityRobot,
        priorityScore,
        taskA,
        taskB
      );

    return {
      conflict,

      priorityRobotId:
        priorityRobot.id,

      yieldingRobotId:
        yieldingRobot.id,

      priorityScore,

      yieldingScore,

      reason,
    };
  }

  private calculatePriorityScore(
    robot: Robot,
    task: Task | null,
    eta: number
  ): number {
    let score = 0;

    // Emergency robots get strong priority.
    if (
      robot.type === "EMERGENCY"
    ) {
      score += 100;
    }

    // Emergency tasks get strong priority.
    if (
      task?.type === "EMERGENCY"
    ) {
      score += 80;
    }

    // Task priority contributes directly.
    if (task) {
      score +=
        task.priority * 10;
    }

    // Robots with lower battery receive
    // some priority because unnecessary
    // waiting may leave them stranded.
    if (robot.battery < 30) {
      score += 15;
    } else if (
      robot.battery < 50
    ) {
      score += 5;
    }

    // Earlier ETA gets a small advantage.
    score +=
      Math.max(
        0,
        10 - eta
      );

    // Higher workload slightly reduces
    // priority so heavily loaded robots
    // are not continuously favored.
    score -=
      robot.workload * 3;

    return score;
  }

  private getRobotTask(
    robot: Robot,
    tasks: Task[]
  ): Task | null {
    if (
      robot.currentTaskId === null
    ) {
      return null;
    }

    return (
      tasks.find(
        task =>
          task.id ===
          robot.currentTaskId
      ) ?? null
    );
  }

  private buildReason(
    robot: Robot,
    score: number,
    taskA: Task | null,
    taskB: Task | null
  ): string {
    if (
      robot.type === "EMERGENCY"
    ) {
      return `${robot.id} receives priority because it is an emergency-response robot.`;
    }

    if (
      taskA?.type === "EMERGENCY" ||
      taskB?.type === "EMERGENCY"
    ) {
      return `${robot.id} receives priority because the conflicting mission contains an emergency task.`;
    }

    if (score >= 80) {
      return `${robot.id} receives priority from mission urgency and task priority.`;
    }

    if (robot.battery < 30) {
      return `${robot.id} receives priority because its battery is critically low.`;
    }

    return `${robot.id} receives priority from decentralized mission priority, ETA and workload scoring.`;
  }
}