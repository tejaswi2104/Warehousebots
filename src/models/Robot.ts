export type RobotType =
  | "FAST_PICKER"
  | "HEAVY_CARRIER"
  | "INSPECTION"
  | "EMERGENCY";

export type RobotState =
  | "IDLE"
  | "MOVING_TO_PICKUP"
  | "MOVING_TO_DROPOFF"
  | "RETURNING_TO_CHARGE"
  | "WAITING"
  | "CHARGING"
  | "FAILED";

export interface Point {
  x: number;
  y: number;
}

export interface Robot {
  id: string;
  type: RobotType;
  position: Point;
  speed: number;
  battery: number;
  batteryCapacity: number;
  health: number;
  payloadCapacity: number;
  capabilities: string[];
  workload: number;
  currentTaskId: string | null;
  route: Point[];
  routeIndex: number;
  pathHistory: Point[];
  state: RobotState;
  carryingPayload: boolean;
}
