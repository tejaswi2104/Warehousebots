import type { Point } from "./Robot";

export type TaskType =
  | "PICKUP"
  | "DELIVERY"
  | "HEAVY_TRANSPORT"
  | "INSPECTION"
  | "EMERGENCY";

export type TaskStatus =
  | "PENDING"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "COMPLETED";

export interface Task {
  id: string;

  type: TaskType;

  pickup: Point;

  dropoff: Point;

  priority: number;

  deadline: number;

  payload: number;

  requiredCapabilities: string[];

  status: TaskStatus;

  assignedRobotId: string | null;
}