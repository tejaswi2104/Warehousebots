import type { Point } from "./Robot";

export type ResourceType =
  | "INTERSECTION"
  | "CHARGING_STATION"
  | "LOADING_DOCK"
  | "CORRIDOR";

export interface Resource {
  id: string;

  type: ResourceType;

  position: Point;

  capacity: number;

  currentUsers: number[];
}