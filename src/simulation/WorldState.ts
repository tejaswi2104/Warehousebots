import { Environment } from "../models/Environment";
import type { Robot } from "../models/Robot";
import type { Task } from "../models/Task";

export class WorldState {
  environment: Environment;

  robots: Robot[] = [];

  tasks: Task[] = [];

  simulationTime = 0;

  completedTasks = 0;

  constructor() {
    this.environment = new Environment();
  }

  reset(): void {
    this.robots = [];
    this.tasks = [];
    this.simulationTime = 0;
    this.completedTasks = 0;

    this.environment = new Environment();
  }
}