import type { Robot } from "../models/Robot";
import type { Task } from "../models/Task";

export interface Bid {
  robotId: string;

  taskId: string;

  distance: number;

  estimatedTime: number;

  batteryAfterTask: number;

  workload: number;

  priority: number;

  score: number;

  timestamp: number;
}

export interface BidContext {
  robot: Robot;

  task: Task;

  distance: number;

  estimatedTime: number;

  batteryAfterTask: number;

  workload: number;
}