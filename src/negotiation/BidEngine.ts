import type { Robot } from "../models/Robot";
import type { Task } from "../models/Task";
import type { Bid } from "./Bid";

export class BidEngine {

  // ==========================================================
  // GENERATE BID
  // ==========================================================

  generateBid(
    robot: Robot,
    task: Task,
    currentTime: number
  ): Bid | null {

    // --------------------------------------------------------
    // Robot must be available
    // --------------------------------------------------------

    if (robot.state !== "IDLE") {
      return null;
    }

    // --------------------------------------------------------
    // Battery check
    // --------------------------------------------------------

    if (robot.battery < 20) {
      return null;
    }

    // --------------------------------------------------------
    // Payload check
    // --------------------------------------------------------

    if (
      robot.payloadCapacity <
      task.payload
    ) {
      return null;
    }

    // --------------------------------------------------------
    // Capability check
    // --------------------------------------------------------

    for (
      const capability
      of task.requiredCapabilities
    ) {

      if (
        !robot.capabilities.includes(
          capability
        )
      ) {
        return null;
      }
    }

    // --------------------------------------------------------
    // Distance
    // --------------------------------------------------------

    const pickupDistance =
      this.distance(
        robot.position.x,
        robot.position.y,
        task.pickup.x,
        task.pickup.y
      );

    const deliveryDistance =
      this.distance(
        task.pickup.x,
        task.pickup.y,
        task.dropoff.x,
        task.dropoff.y
      );

    const totalDistance =
      pickupDistance +
      deliveryDistance;

    // --------------------------------------------------------
    // Estimated execution time
    // --------------------------------------------------------

    const speed =
      Math.max(
        robot.speed,
        0.1
      );

    const estimatedTime =
      totalDistance / speed;

    // --------------------------------------------------------
    // Battery prediction
    // --------------------------------------------------------

    const batteryConsumption =
      totalDistance * 0.15;

    const batteryAfterTask =
      Math.max(
        0,
        robot.battery -
          batteryConsumption
      );

    // --------------------------------------------------------
    // Current workload
    // --------------------------------------------------------

    const workload =
      robot.workload;

    // --------------------------------------------------------
    // Bid score
    //
    // Lower score = better bid
    // --------------------------------------------------------

    const distanceCost =
      totalDistance * 1.0;

    const timeCost =
      estimatedTime * 0.8;

    const batteryCost =
      (100 - batteryAfterTask) *
      0.6;

    const workloadCost =
      workload * 15;

    const priorityBenefit =
      task.priority * 5;

    // Strongly discourage a robot from
    // accepting a task that leaves it
    // nearly empty.
    const batteryPenalty =
      batteryAfterTask < 25
        ? 100
        : 0;

    const score =
      distanceCost +
      timeCost +
      batteryCost +
      workloadCost +
      batteryPenalty -
      priorityBenefit;

    return {
      robotId: robot.id,

      taskId: task.id,

      distance: totalDistance,

      estimatedTime,

      batteryAfterTask,

      workload,

      priority: task.priority,

      score,

      timestamp: currentTime,
    };
  }

  // ==========================================================
  // MANHATTAN DISTANCE
  // ==========================================================

  private distance(
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): number {

    return (
      Math.abs(x1 - x2) +
      Math.abs(y1 - y2)
    );
  }
}