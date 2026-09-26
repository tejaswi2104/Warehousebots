import { HybridPathfinder } from "../navigation/HybridPathfinder";
import { WorldState } from "./WorldState";
import { SpatialIndex } from "./SpatialIndex";
import { ChargingManager } from "./ChargingManager";

import {
  Negotiator,
  type NegotiationResult,
} from "../negotiation/Negotiator";

import {
  CollisionDetector,
  type CollisionPrediction,
} from "../safety/CollisionDetector";

import {
  RightOfWayNegotiator,
  type RightOfWayDecision,
} from "../safety/RightOfWayNegotiator";

import {
  DeadlockDetector,
  type DeadlockEvent,
} from "../safety/DeadlockDetector";

import type {
  Point,
  Robot,
  RobotType,
} from "../models/Robot";

import type { ChargingStation } from "../models/Environment";

import type {
  Task,
  TaskType,
} from "../models/Task";

export class SimulationEngine {
  world: WorldState;

  private pathfinder: HybridPathfinder;
  private negotiator: Negotiator;
  private collisionDetector: CollisionDetector;
  private rightOfWayNegotiator: RightOfWayNegotiator;
  private deadlockDetector: DeadlockDetector;
  private spatialIndex: SpatialIndex;
  private chargingManager: ChargingManager;
  // Robots keep their charging reservation until they clear the exit lane.
  private readonly chargingExitByRobot = new Map<string, Point>();
  // Stable home station per robot; individual charging bays remain dynamic.
  private readonly homeStationByRobot = new Map<string, string>();

  private running = false;

  simulationSpeed = 1;
  autoTaskAssignment = false;
  deadlockEvents: DeadlockEvent[] = [];
  deadlockRecoveryCount = 0;
  private handledDeadlocks = new Set<string>();

  // Prevent temporary right-of-way waits from becoming permanent stalls.
  private stagnantTicks = new Map<string, number>();

  // Short-lived movement-level right-of-way locks. These are used for
  // immediate physical conflicts before the slower predictive detector runs.
  private yieldUntil = new Map<string, number>();

  // ------------------------------------------------------------
  // SAFE LAUNCH QUEUE
  // ------------------------------------------------------------
  // Robots start on separate charging slots, but they must not all
  // enter the warehouse network on the same simulation tick.
  private launchQueue: string[] = [];
  private launchQueued = new Set<string>();
  private launchHoldRoutes = new Map<string, Point[]>();
  private releasedFromLaunch = new Set<string>();
  private nextLaunchTime = 0;
  private readonly launchSpacingSeconds = 1.0;

  // Minimum center-to-center robot separation.
  // Robots are treated as physical bodies, not point particles.
  // 1.0 grid unit is the physical center-to-center limit. Robots may
  // visually touch/brush past each other, but their centers cannot occupy
  // the same point. This avoids the old large invisible traffic barrier.
  private readonly robotClearance = 1.0;

  private tickAccumulator = 0;
  private movementAccumulator = 0;
  private collisionAccumulator = 0;
  private deadlockAccumulator = 0;
  private assignmentAccumulator = 0;
  private communicationAccumulator = 0;
  private chargingRecoveryAccumulator = 0;
  // Counts repeated failed return-to-charge attempts so a transient traffic
  // conflict cannot strand a robot indefinitely.
  private chargingRecoveryAttempts = new Map<string, number>();
  // Movement/rendering is kept light at 30 simulation updates/sec.
  // Coordination runs on real-time cadence so 10x does not multiply CPU work.
  private readonly movementRate = 30;
  private tickRate = 10;
  private readonly collisionInterval = 0.10;
  private readonly deadlockInterval = 0.75;
  private readonly assignmentInterval = 0.75;
  private readonly communicationInterval = 0.30;
  private readonly autoAssignmentTaskBudget = 8;

  // ============================================================
  // RANDOM TASK GENERATION
  // ============================================================

  generateRandomTasks(
    count: number = 5
  ): Task[] {
    const generatedTasks: Task[] = [];

    const safeCount = Math.max(
      1,
      Math.min(50, Math.floor(count))
    );

    for (let i = 0; i < safeCount; i++) {
      const taskType =
        this.getRandomTaskType();

      const pickup =
        this.getRandomWalkablePoint();

      let dropoff =
        this.getRandomWalkablePoint();

      let attempts = 0;

      while (
        dropoff.x === pickup.x &&
        dropoff.y === pickup.y &&
        attempts < 20
      ) {
        dropoff =
          this.getRandomWalkablePoint();

        attempts++;
      }

      const task =
        this.buildRandomTask(
          taskType,
          pickup,
          dropoff
        );

      this.world.tasks.push(task);
      generatedTasks.push(task);
    }

    this.totalTasksGenerated +=
      generatedTasks.length;

    this.lastTaskGenerationCount =
      generatedTasks.length;

    return generatedTasks;
  }

  assignPendingTasks(): void {
    this.assignmentAccumulator = 0;
    // Manual assignment is also bounded so a large task burst cannot freeze
    // the browser in one click. Repeated scheduling cycles continue the queue.
    this.assignTasks(this.autoAssignmentTaskBudget);
  }

  setAutoTaskAssignment(enabled: boolean): void {
    this.autoTaskAssignment = enabled;

    // If automatic assignment is enabled while the simulation is already
    // running, assign any currently pending work immediately.
    if (enabled) {
      this.assignTasks();
    }
  }

  toggleAutoTaskAssignment(): boolean {
    this.setAutoTaskAssignment(!this.autoTaskAssignment);
    return this.autoTaskAssignment;
  }

  private buildRandomTask(
    type: TaskType,
    pickup: Point,
    dropoff: Point
  ): Task {
    let payload = 10;
    let requiredCapabilities: string[] = [];
    let priority = 5;
    let deadline = 120;

    switch (type) {
      case "DELIVERY":
        payload =
          this.randomInteger(5, 25);

        requiredCapabilities = [
          "TRANSPORT",
        ];

        priority =
          this.randomInteger(3, 8);

        deadline =
          this.randomInteger(90, 180);

        break;

      case "HEAVY_TRANSPORT":
        payload =
          this.randomInteger(50, 90);

        requiredCapabilities = [
          "TRANSPORT",
          "HEAVY_LOAD",
        ];

        priority =
          this.randomInteger(5, 9);

        deadline =
          this.randomInteger(100, 180);

        break;

      case "INSPECTION":
        payload = 0;

        requiredCapabilities = [
          "INSPECTION",
        ];

        priority =
          this.randomInteger(2, 7);

        deadline =
          this.randomInteger(120, 220);

        break;

      case "EMERGENCY":
        payload =
          this.randomInteger(1, 10);

        requiredCapabilities = [
          "TRANSPORT",
          "EMERGENCY",
        ];

        priority = 10;

        deadline =
          this.randomInteger(40, 80);

        break;

      case "PICKUP":
        payload =
          this.randomInteger(5, 20);

        requiredCapabilities = [
          "TRANSPORT",
        ];

        priority =
          this.randomInteger(3, 7);

        deadline =
          this.randomInteger(90, 180);

        break;
    }

    return {
      id: this.getNextTaskId(),

      type,

      pickup,

      dropoff,

      priority,

      deadline,

      payload,

      requiredCapabilities,

      status: "PENDING",

      assignedRobotId: null,
    };
  }

  private getRandomTaskType(): TaskType {
    const taskTypes: TaskType[] = [
      "DELIVERY",
      "DELIVERY",
      "DELIVERY",
      "HEAVY_TRANSPORT",
      "INSPECTION",
      "EMERGENCY",
    ];

    return taskTypes[
      Math.floor(
        Math.random() *
        taskTypes.length
      )
    ];
  }

  private getRandomWalkablePoint(): Point {
    const width =
      this.world.environment.width;

    const height =
      this.world.environment.height;

    for (let attempt = 0; attempt < 100; attempt++) {
      const x =
        this.randomInteger(
          1,
          width - 2
        );

      const y =
        this.randomInteger(
          1,
          height - 2
        );

      if (
        this.world.environment.isWalkable(
          x,
          y
        )
      ) {
        return {
          x,
          y,
        };
      }
    }

    return {
      x: 1,
      y: 1,
    };
  }

  private getNextTaskId(): string {
    let highestId = 0;

    for (const task of this.world.tasks) {
      const match =
        task.id.match(/^T(\d+)$/);

      if (!match) {
        continue;
      }

      highestId =
        Math.max(
          highestId,
          Number(match[1])
        );
    }

    return `T${String(
      highestId + 1
    ).padStart(3, "0")}`;
  }

  private randomInteger(
    min: number,
    max: number
  ): number {
    return Math.floor(
      Math.random() *
      (max - min + 1)
    ) + min;
  }

  // ============================================================
  // SAFE LAUNCH QUEUE
  // ============================================================

  /**
   * Put a robot into the startup/depot launch queue. Its task route is held
   * while it remains physically parked on its charging slot. This keeps the
   * collision detector from treating parked robots as moving traffic.
   */
  private queueRobotForLaunch(robot: Robot): void {
    if (robot.state === "FAILED") return;
    if (robot.currentTaskId === null) return;
    if (this.releasedFromLaunch.has(robot.id)) return;
    if (this.launchQueued.has(robot.id)) return;

    const atChargingSlot = this.world.environment.chargingSlots.some(item =>
      Math.round(robot.position.x) === item.slot.x &&
      Math.round(robot.position.y) === item.slot.y
    );

    if (!atChargingSlot) return;

    this.launchQueued.add(robot.id);
    this.launchQueue.push(robot.id);

    if (robot.route.length > 0) {
      this.launchHoldRoutes.set(
        robot.id,
        robot.route.map(point => ({ x: point.x, y: point.y }))
      );
    }

    robot.route = [];
    robot.routeIndex = 0;
    robot.state = "WAITING";
  }

  /**
   * Release at most one parked robot per launch interval. The first robot
   * may leave immediately; subsequent robots wait for the configured spacing.
   */
  private updateLaunchQueue(): void {
    if (this.launchQueue.length === 0) return;
    if (this.world.simulationTime < this.nextLaunchTime) return;

    const robotId = this.launchQueue.shift();
    if (!robotId) return;

    this.launchQueued.delete(robotId);

    const robot = this.world.robots.find(item => item.id === robotId);
    if (!robot || robot.state === "FAILED" || robot.currentTaskId === null) {
      this.launchHoldRoutes.delete(robotId);
      this.nextLaunchTime = this.world.simulationTime + this.launchSpacingSeconds;
      return;
    }

    const heldRoute = this.launchHoldRoutes.get(robotId);
    this.launchHoldRoutes.delete(robotId);

    if (!heldRoute || heldRoute.length === 0) {
      robot.state = "WAITING";
      robot.route = [];
      robot.routeIndex = 0;
      this.nextLaunchTime = this.world.simulationTime + this.launchSpacingSeconds;
      return;
    }

    robot.route = heldRoute;
    robot.routeIndex = heldRoute.length > 1 ? 1 : 0;
    robot.state = "MOVING_TO_PICKUP";
    this.releasedFromLaunch.add(robot.id);

    this.nextLaunchTime =
      this.world.simulationTime + this.launchSpacingSeconds;
  }

  // ============================================================
  // TASK NEGOTIATION
  // ============================================================

  lastNegotiations: NegotiationResult[] = [];

  totalNegotiations = 0;
  successfulNegotiations = 0;

  // ============================================================
  // COLLISION DETECTION
  // ============================================================

  collisionPredictions: CollisionPrediction[] = [];

  totalCollisionWarnings = 0;

  communicationLinks: Array<{
    robotA: string;
    robotB: string;
    reason: string;
    expiresAt: number;
  }> = [];

  activeCollisionRiskCount = 0;
  activeCollisionPairs: Array<{
    robotA: string;
    robotB: string;
    distance: number;
  }> = [];

  // ============================================================
  // RIGHT-OF-WAY NEGOTIATION
  // ============================================================

  rightOfWayDecisions: RightOfWayDecision[] = [];

  totalRightOfWayNegotiations = 0;

  totalYieldActions = 0;

  // ============================================================
  // TASK GENERATION
  // ============================================================

  totalTasksGenerated = 0;
  lastTaskGenerationCount = 0;

  /*
   * Stores conflicts that have already been handled.
   *
   * Without this, the same collision can trigger
   * right-of-way negotiation every simulation tick.
   */
  private handledConflicts =
    new Set<string>();

  // ============================================================
  // CONSTRUCTOR
  // ============================================================

  constructor() {
    this.world =
      new WorldState();

    this.pathfinder =
      new HybridPathfinder(
        this.world.environment
      );

    this.negotiator =
      new Negotiator();

    this.collisionDetector =
      new CollisionDetector();

    this.rightOfWayNegotiator =
      new RightOfWayNegotiator();

    this.deadlockDetector =
      new DeadlockDetector();

    this.spatialIndex = new SpatialIndex(3);
    this.chargingManager = new ChargingManager();

    this.initialize();
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================

  private initialize(): void {
    this.world.reset();

    this.ensureChargingSlots();

    this.pathfinder =
      new HybridPathfinder(
        this.world.environment
      );

    this.lastNegotiations = [];

    this.totalNegotiations = 0;
    this.successfulNegotiations = 0;

    this.collisionPredictions = [];

    this.totalCollisionWarnings = 0;
    this.activeCollisionRiskCount = 0;
    this.activeCollisionPairs = [];

    this.rightOfWayDecisions = [];

    this.totalRightOfWayNegotiations = 0;

    this.totalYieldActions = 0;

    this.totalTasksGenerated = 0;
    this.lastTaskGenerationCount = 0;

    this.handledConflicts.clear();
    this.stagnantTicks.clear();
    this.yieldUntil.clear();

    this.launchQueue = [];
    this.launchQueued.clear();
    this.launchHoldRoutes.clear();
    this.releasedFromLaunch.clear();
    this.nextLaunchTime = 0;
    this.spatialIndex.rebuild([]);
    this.chargingManager.reset(this.world.environment.chargingStations);
    this.chargingExitByRobot.clear();
    this.homeStationByRobot.clear();
    this.tickAccumulator = 0;
    this.movementAccumulator = 0;
    this.collisionAccumulator = 0;
    this.deadlockAccumulator = 0;
    this.assignmentAccumulator = 0;
    this.communicationAccumulator = 0;
    this.chargingRecoveryAccumulator = 0;
    this.chargingRecoveryAttempts.clear();

    this.createRobots();

    this.createTasks();

    this.assignTasks();
  }

  // ============================================================
  // ROBOT CREATION
  // ============================================================

  private createRobots(): void {
    const robotTypes: RobotType[] = [
      "FAST_PICKER",
      "HEAVY_CARRIER",
      "INSPECTION",
      "EMERGENCY",
    ];

    // Start the fleet in the dedicated charging/depot yard. The 100 startup
    // positions are deliberately far apart (6 grid units) so the fleet never
    // appears as a packed column before launch. These are temporary startup
    // positions; charging reservations remain dynamic.
    const startupSlots = this.world.environment.chargingSlots;
    if (startupSlots.length < 100) {
      throw new Error(`Not enough startup slots: ${startupSlots.length}`);
    }

    for (let i = 0; i < 100; i++) {
      const type = robotTypes[i % robotTypes.length];
      const spawn = startupSlots[i].slot;

      let speed = 1.0;
      let payloadCapacity = 25;
      let capabilities: string[] = [];

      switch (type) {
        case "FAST_PICKER":
          speed = 1.5;
          payloadCapacity = 25;
          capabilities = ["TRANSPORT", "FAST_PICKUP"];
          break;
        case "HEAVY_CARRIER":
          speed = 0.7;
          payloadCapacity = 100;
          capabilities = ["TRANSPORT", "HEAVY_LOAD"];
          break;
        case "INSPECTION":
          speed = 1.0;
          payloadCapacity = 10;
          capabilities = ["INSPECTION"];
          break;
        case "EMERGENCY":
          speed = 1.8;
          payloadCapacity = 40;
          capabilities = ["TRANSPORT", "EMERGENCY", "FAST_PICKUP"];
          break;
      }

      const robot: Robot = {
        id: `R${String(i + 1).padStart(2, "0")}`,
        type,
        position: { x: spawn.x, y: spawn.y },
        speed,
        batteryCapacity: 100,
        battery: 70 + (i % 4) * 7,
        health: 100,
        payloadCapacity,
        capabilities,
        workload: 0,
        currentTaskId: null,
        route: [],
        routeIndex: 0,
        pathHistory: [{ x: spawn.x, y: spawn.y }],
        state: "IDLE",
        carryingPayload: false,
      };

      this.world.robots.push(robot);

      const homeSlot = this.world.environment.chargingSlots
        .find(item => item.slot.x === spawn.x && item.slot.y === spawn.y);
      if (homeSlot) {
        // ChargingSlot.station is typed as Point, so resolve the real
        // ChargingStation by coordinates before reading its optional id.
        const homeStation = this.world.environment.chargingStations.find(
          station => station.x === homeSlot.station.x && station.y === homeSlot.station.y,
        );
        const stationId = homeStation?.id ?? `${homeSlot.station.x},${homeSlot.station.y}`;
        this.homeStationByRobot.set(robot.id, stationId);
      }
    }
  }

  // ============================================================
  // TASK CREATION
  // ============================================================

  private createTasks(): void {
    const tasks: Task[] = [
      {
        id: "T001",

        type:
          "DELIVERY" as TaskType,

        pickup: {
          x: 8,
          y: 4,
        },

        dropoff: {
          x: 52,
          y: 35,
        },

        priority: 5,

        deadline: 120,

        payload: 10,

        requiredCapabilities: [
          "TRANSPORT",
        ],

        status: "PENDING",

        assignedRobotId: null,
      },

      {
        id: "T002",

        type:
          "HEAVY_TRANSPORT" as TaskType,

        pickup: {
          x: 14,
          y: 11,
        },

        dropoff: {
          x: 46,
          y: 28,
        },

        priority: 8,

        deadline: 100,

        payload: 80,

        requiredCapabilities: [
          "TRANSPORT",
          "HEAVY_LOAD",
        ],

        status: "PENDING",

        assignedRobotId: null,
      },

      {
        id: "T003",

        type:
          "INSPECTION" as TaskType,

        pickup: {
          x: 47,
          y: 11,
        },

        dropoff: {
          x: 13,
          y: 28,
        },

        priority: 4,

        deadline: 150,

        payload: 0,

        requiredCapabilities: [
          "INSPECTION",
        ],

        status: "PENDING",

        assignedRobotId: null,
      },

      {
        id: "T004",

        type:
          "DELIVERY" as TaskType,

        pickup: {
          x: 8,
          y: 35,
        },

        dropoff: {
          x: 52,
          y: 5,
        },

        priority: 6,

        deadline: 120,

        payload: 20,

        requiredCapabilities: [
          "TRANSPORT",
        ],

        status: "PENDING",

        assignedRobotId: null,
      },

      {
        id: "T005",

        type:
          "EMERGENCY" as TaskType,

        pickup: {
          x: 50,
          y: 35,
        },

        dropoff: {
          x: 10,
          y: 5,
        },

        priority: 10,

        deadline: 60,

        payload: 5,

        requiredCapabilities: [
          "TRANSPORT",
          "EMERGENCY",
        ],

        status: "PENDING",

        assignedRobotId: null,
      },
    ];

    this.world.tasks.push(
      ...tasks
    );
  }

  // ============================================================
  // CHARGING STATION MANAGEMENT
  // ============================================================

  /**
   * Create a large set of physical charging/parking slots around every
   * charging station. The station marker itself is not used as a parking
   * cell, so robots never have to stack on the same station coordinate.
   *
   * 8 slots per station gives the current fleet 32 independent positions.
   */
  private ensureChargingSlots(): void {
    const stations = this.world.environment.chargingStations;
    const slots: Array<{ station: Point; slot: Point }> = [];
    const used = new Set<string>();

    // Dedicated charging depot: two separate hubs, each with a 5x10 bay
    // matrix. Bay pitch is 6 grid units, so neighboring robots have a large
    // visible gap and can leave without squeezing through a packed column.
    // The hubs sit outside the 120x80 warehouse floor.
    const xOffsets = [-12, -6, 6, 12, 18];
    const yOffsets = [-27, -21, -15, -9, -3, 3, 9, 15, 21, 27];

    for (const station of stations) {
      const candidates: Point[] = [];
      for (const dy of yOffsets) {
        for (const dx of xOffsets) {
          const point = { x: station.x + dx, y: station.y + dy };
          if (!this.world.environment.isInside(point.x, point.y)) continue;
          if (!this.world.environment.isWalkable(point.x, point.y)) continue;
          if (stations.some(other => other !== station && Math.hypot(other.x - point.x, other.y - point.y) < 6)) continue;
          const key = `${point.x},${point.y}`;
          if (used.has(key)) continue;
          candidates.push(point);
          used.add(key);
        }
      }

      if (candidates.length < 50) {
        throw new Error(`Charging station ${station.id ?? ""} has only ${candidates.length} usable wide-spaced bays; 50 are required.`);
      }

      for (const slot of candidates.slice(0, 50)) {
        slots.push({ station: { x: station.x, y: station.y }, slot });
      }
    }

    if (slots.length < 100) {
      throw new Error(`Only ${slots.length} wide-spaced charging slots generated; 100 are required.`);
    }

    this.world.environment.chargingSlots = slots;
  }

  /**
   * Select a physical parking/charging slot rather than sending every
   * completed robot to the exact same station cell. This eliminates
   * visual and logical robot overlap after task completion.
   */
  /**
   * Charging stations are physical infrastructure, not drivable floor.
   * Keep the 3x3 footprint around each station center out of normal routes.
   * Parking slots are generated at radius >= 2, so robots can approach the
   * station from outside and settle on the perimeter without crossing it.
   */
  private getChargingStationObstaclePoints(): Point[] {
    const points: Point[] = [];

    for (const station of this.world.environment.chargingStations) {
      const halfWidth = Math.max(1, Math.floor((station.width ?? 7) / 2));
      const halfHeight = Math.max(1, Math.floor((station.height ?? 5) / 2));
      for (let dx = -halfWidth; dx <= halfWidth; dx++) {
        for (let dy = -halfHeight; dy <= halfHeight; dy++) {
          points.push({
            x: station.x + dx,
            y: station.y + dy,
          });
        }
      }
    }

    return points;
  }

  private isAtChargingSlot(robot: Robot): boolean {
    return this.world.environment.chargingSlots.some(item =>
      Math.round(robot.position.x) === item.slot.x &&
      Math.round(robot.position.y) === item.slot.y
    );
  }

  private getChargingStation(stationId: string): ChargingStation | null {
    return this.world.environment.chargingStations.find(
      station => (station.id ?? `${station.x},${station.y}`) === stationId
    ) ?? null;
  }

  private getChargingLanePoints(station: ChargingStation): { entry: Point; exit: Point } {
    // Parking-lot style circulation:
    //
    //   WAREHOUSE -> TOP GATE -> INBOUND AISLE -> BAY
    //                                      |
    //   WAREHOUSE <- BOTTOM GATE <- OUTBOUND AISLE <- BAY
    //
    // Entry and exit are deliberately separated by a large vertical gap.
    // This prevents a freshly charged robot from meeting an incoming robot
    // head-on at the station entrance.
    const entryY = 20;
    const exitY = 60;
    const entryX = Math.min(198, Math.max(128, station.x));
    const exitX = Math.min(198, Math.max(128, station.x));

    return {
      entry: { x: entryX, y: entryY },
      exit: { x: exitX, y: exitY },
    };
  }

  private buildChargingExitRoute(start: Point, exitPoint: Point): Point[] {
    const obstacles = this.getChargingStationObstaclePoints();
    const exitGate = { x: 121, y: 60 };

    // Dedicated outbound circulation: bay -> bottom aisle -> OUT gate.
    // Keep the return path independent of the inbound lane.
    const toExitLane = this.pathfinder.findPath(start, exitPoint, obstacles);
    if (toExitLane.length === 0) return [];

    const toGate = this.pathfinder.findPath(exitPoint, exitGate, obstacles);
    if (toGate.length === 0) return [];

    const route = [...toExitLane];
    for (let i = 1; i < toGate.length; i++) route.push(toGate[i]);

    return route;
  }

  private sendRobotToChargingStation(robot: Robot): void {
    if (robot.state === "FAILED") return;

    const reservation = this.chargingManager.request(
      robot,
      this.world.environment,
      this.world.robots,
      this.homeStationByRobot.get(robot.id),
    );

    if (!reservation || reservation.state === "QUEUED") {
      const queuePoint = this.chargingManager.getQueuePoint(
        robot.id,
        this.world.environment
      );

      // Only the short staging queue is allowed to approach the charging
      // infrastructure. Everyone else waits where they are until a bay opens.
      if (queuePoint) {
        const queueRoute = this.pathfinder.findPath(
          robot.position,
          queuePoint,
          this.getChargingStationObstaclePoints()
        );
        if (queueRoute.length > 0) {
          robot.route = queueRoute;
          robot.routeIndex = queueRoute.length > 1 ? 1 : 0;
          robot.state = "WAITING";
          return;
        }
      }

      robot.state = "WAITING";
      robot.route = [];
      robot.routeIndex = 0;
      return;
    }

    const station = this.getChargingStation(reservation.stationId);
    if (!station) return;

    const lanes = this.getChargingLanePoints(station);
    const obstacles = this.getChargingStationObstaclePoints();
    const gateIn = { x: 121, y: 20 };

    // Dedicated inbound circulation: warehouse -> IN gate -> top aisle ->
    // station column -> bay. We explicitly use waypoints so A* cannot decide
    // to take a shortcut through the outbound lane.
    const approachRoute = this.pathfinder.findPath(
      robot.position,
      gateIn,
      obstacles
    );

    const entryAisleRoute = this.pathfinder.findPath(
      gateIn,
      lanes.entry,
      obstacles
    );

    const slotRoute = this.pathfinder.findPath(
      lanes.entry,
      reservation.slot,
      obstacles
    );

    if (approachRoute.length === 0 || entryAisleRoute.length === 0 || slotRoute.length === 0) {
      this.chargingManager.release(robot.id);
      robot.state = "WAITING";
      robot.route = [];
      robot.routeIndex = 0;
      return;
    }

    const route = [...approachRoute];
    for (let i = 1; i < entryAisleRoute.length; i++) route.push(entryAisleRoute[i]);
    for (let i = 1; i < slotRoute.length; i++) route.push(slotRoute[i]);

    robot.route = route;
    robot.routeIndex = route.length > 1 ? 1 : 0;
    robot.state = "RETURNING_TO_CHARGE";
    this.chargingRecoveryAttempts.set(robot.id, 0);
  }

  // ============================================================
  // TASK NEGOTIATION
  // ============================================================

  private assignTasks(maxTasks: number = Number.POSITIVE_INFINITY): void {
    const pendingTasks =
      this.world.tasks
        .filter(task => task.status === "PENDING")
        .sort((a, b) => b.priority - a.priority || a.deadline - b.deadline)
        .slice(0, Number.isFinite(maxTasks) ? maxTasks : undefined);

    if (
      pendingTasks.length === 0
    ) {
      return;
    }

    const candidateRobots = new Map<string, Robot>();

    for (const task of pendingTasks) {
      const candidates = this.world.robots
        .filter(robot =>
          robot.state === "IDLE" &&
          robot.currentTaskId === null &&
          robot.battery >= 20 &&
          robot.payloadCapacity >= task.payload &&
          task.requiredCapabilities.every(cap => robot.capabilities.includes(cap))
        )
        .sort((a, b) => {
          const da = Math.hypot(a.position.x - task.pickup.x, a.position.y - task.pickup.y);
          const db = Math.hypot(b.position.x - task.pickup.x, b.position.y - task.pickup.y);
          return da - db;
        })
        .slice(0, 12);

      for (const robot of candidates) candidateRobots.set(robot.id, robot);
    }

    const results = this.negotiator.negotiateTasks(
      pendingTasks,
      [...candidateRobots.values()],
      this.world.simulationTime
    );

    this.lastNegotiations =
      results;

    this.totalNegotiations +=
      results.length;

    const awardedRobots =
      new Set<string>();

    for (
      const result of results
    ) {
      const winningBid =
        result.winningBid;

      if (
        winningBid === null
      ) {
        continue;
      }

      if (
        awardedRobots.has(
          winningBid.robotId
        )
      ) {
        continue;
      }

      const task =
        this.world.tasks.find(
          item =>
            item.id ===
            winningBid.taskId
        );

      const robot =
        this.world.robots.find(
          item =>
            item.id ===
            winningBid.robotId
        );

      if (
        !task ||
        !robot
      ) {
        continue;
      }

      if (
        task.status !==
        "PENDING"
      ) {
        continue;
      }

      if (
        robot.state !==
        "IDLE"
      ) {
        continue;
      }

      const assigned =
        this.assignTask(
          robot,
          task
        );

      if (assigned) {
        awardedRobots.add(
          robot.id
        );

        this.successfulNegotiations++;
      }
    }
  }

  private getTaskObstaclePoints(excludeTaskId: string | null = null): { x: number; y: number }[] {
    const points: { x: number; y: number }[] = [];

    for (const task of this.world.tasks) {
      if (task.id === excludeTaskId) continue;
      if (task.status === "COMPLETED") continue;

      points.push({ x: task.pickup.x, y: task.pickup.y });
      points.push({ x: task.dropoff.x, y: task.dropoff.y });
    }

    return points;
  }

  // ============================================================
  // ASSIGN TASK
  // ============================================================

  private assignTask(
    robot: Robot,
    task: Task
  ): boolean {
    this.chargingManager.release(robot.id);

    const taskObstacles = [
      ...this.getTaskObstaclePoints(task.id),
      ...this.getChargingStationObstaclePoints(),
    ];

    const pickupRoute =
      this.pathfinder.findNaturalPathToObject(
        robot.position,
        task.pickup,
        taskObstacles
      );

    if (
      pickupRoute.length === 0
    ) {
      return false;
    }

    task.status =
      "ASSIGNED";

    task.assignedRobotId =
      robot.id;

    robot.currentTaskId =
      task.id;

    robot.workload += 1;

    robot.state =
      "MOVING_TO_PICKUP";

    robot.route =
      pickupRoute;

    robot.routeIndex =
      pickupRoute.length > 1
        ? 1
        : 0;

    // If the robot is parked on a charging slot, do not let every assigned
    // robot launch simultaneously. Hold its route until its launch turn.
    this.queueRobotForLaunch(robot);

    return true;
  }

  /**
   * Safety net for robots that somehow become IDLE/WAITING in the warehouse
   * without a mission. Completed missions already trigger charging directly,
   * but this periodic sweep guarantees that a transient recovery state cannot
   * strand a robot on the warehouse floor.
   */
  private enforceChargingReturn(): void {
    // Charging is a fleet lifecycle state, not only a low-battery fallback.
    // Every robot with no active mission must either be parked/charging or
    // have an active route back to the charging yard. This is deliberately a
    // watchdog: it repairs stray IDLE/WAITING robots and broken return routes.
    //
    // A second protection below prevents two robots from holding the same
    // temporary bay reservation. Duplicate reservations can otherwise make
    // two robots wait forever at one physical slot.
    const reservedSlots = new Map<string, string>();

    for (const robot of this.world.robots) {
      if (robot.state === "FAILED" || robot.state === "CHARGING") continue;
      if (robot.currentTaskId !== null) continue;

      const reservation = this.chargingManager.get(robot.id);
      if (reservation?.state === "RESERVED") {
        const key = `${reservation.stationId}|${reservation.slot.x},${reservation.slot.y}`;
        const owner = reservedSlots.get(key);
        if (owner && owner !== robot.id) {
          // Keep the first reservation and force the duplicate to obtain a
          // fresh temporary bay on the next request.
          this.chargingManager.release(robot.id);
          robot.route = [];
          robot.routeIndex = 0;
          robot.state = "WAITING";
          this.chargingRecoveryAttempts.set(robot.id, 0);
          continue;
        }
        reservedSlots.set(key, robot.id);
      }

      if (this.isAtChargingSlot(robot)) {
        // If a robot reached a bay but somehow lost its reservation, request
        // a fresh temporary reservation immediately instead of leaving it as
        // an idle visual stray.
        if (!reservation) {
          this.sendRobotToChargingStation(robot);
        }
        continue;
      }

      const routeBroken =
        robot.route.length === 0 ||
        robot.routeIndex >= robot.route.length;

      const returning = robot.state === "RETURNING_TO_CHARGE";
      const waiting = robot.state === "WAITING";
      const idle = robot.state === "IDLE";

      // A healthy no-task robot must never remain idle in the warehouse.
      // Re-requesting is cheap and lets the charging manager move it from a
      // queue to a real bay as soon as capacity becomes available.
      if (idle || waiting || (returning && routeBroken)) {
        this.sendRobotToChargingStation(robot);

        const attempts = (this.chargingRecoveryAttempts.get(robot.id) ?? 0) + 1;
        this.chargingRecoveryAttempts.set(robot.id, attempts);
      }

      // After repeated failures, force a clean replan from the robot's actual
      // position. This keeps a transient collision from becoming permanent.
      const attempts = this.chargingRecoveryAttempts.get(robot.id) ?? 0;
      if (attempts >= 3 && robot.state === "RETURNING_TO_CHARGE") {
        this.recoverStalledRobot(robot);
        this.chargingRecoveryAttempts.set(robot.id, 0);
      }
    }
  }

  // ============================================================
  // SIMULATION UPDATE
  // ============================================================

  update(
    deltaTime: number
  ): void {
    if (!this.running) {
      return;
    }

    // Keep real-time cadence separate from simulation time. At 10x the
    // simulation advances ten times faster, but collision/deadlock/auction
    // work does NOT run ten times more often. This is the main CPU saving.
    const realDeltaTime = Math.min(0.05, Math.max(0, deltaTime));
    const simulationDelta = realDeltaTime * this.simulationSpeed;

    this.world.simulationTime += simulationDelta;

    // Update robot positions at a bounded 30 Hz instead of every browser
    // frame. The canvas can still render at 60 Hz while the simulation does
    // only the expensive robot loop when needed.
    this.movementAccumulator += realDeltaTime;
    const movementInterval = 1 / this.movementRate;
    if (this.movementAccumulator >= movementInterval) {
      const movementRealDelta = Math.min(0.05, this.movementAccumulator);
      this.movementAccumulator %= movementInterval;
      this.spatialIndex.rebuild(this.world.robots);
      this.updateRobots(movementRealDelta * this.simulationSpeed);
    }

    // Coordination cadence is based on wall-clock time, not accelerated
    // simulation time. This prevents 10x mode from turning a 10 Hz detector
    // into a 100 Hz detector.
    this.collisionAccumulator += realDeltaTime;
    this.communicationAccumulator += realDeltaTime;
    this.deadlockAccumulator += realDeltaTime;
    this.assignmentAccumulator += realDeltaTime;

    this.tickAccumulator += realDeltaTime;
    const tickInterval = 1 / this.tickRate;
    if (this.tickAccumulator < tickInterval) {
      return;
    }
    this.tickAccumulator %= tickInterval;

    // Release parked robots one at a time.
    this.updateLaunchQueue();

    // Guarantee that completed/stranded robots eventually return to the
    // dedicated charging yard. This runs at coordination cadence, not every
    // render frame, so it is cheap even in 10x mode.
    this.chargingRecoveryAccumulator += realDeltaTime;
    if (this.chargingRecoveryAccumulator >= 0.50) {
      this.chargingRecoveryAccumulator %= 0.50;
      this.enforceChargingReturn();
    }

    // Collision prediction is deliberately decoupled from movement.
    if (this.collisionAccumulator >= this.collisionInterval) {
      this.collisionAccumulator %= this.collisionInterval;
      this.collisionPredictions = this.collisionDetector.detectCollisions(this.world.robots);
      this.updateLiveCollisionRisks();

      if (this.collisionPredictions.length > 0) {
        this.totalCollisionWarnings += this.collisionPredictions.length;
        this.resolveRightOfWay();
      }
    }

    // Communication is local and inexpensive, but still does not need to run
    // on every render frame.
    if (this.communicationAccumulator >= this.communicationInterval) {
      this.communicationAccumulator %= this.communicationInterval;
      this.communicationLinks = this.communicationLinks.filter(
        link => link.expiresAt > this.world.simulationTime
      );
      this.refreshCommunicationNetwork();
    }

    // Deadlock checks are intentionally slower than collision checks.
    if (this.deadlockAccumulator >= this.deadlockInterval) {
      this.deadlockAccumulator %= this.deadlockInterval;
      const deadlocks = this.deadlockDetector.detect(this.world.robots);
      for (const deadlock of deadlocks) {
        if (this.handledDeadlocks.has(deadlock.id)) continue;
        this.handledDeadlocks.add(deadlock.id);
        this.deadlockEvents.unshift(deadlock);
        if (this.deadlockEvents.length > 10) this.deadlockEvents.pop();
        this.recoverDeadlock(deadlock);
      }
    }

    // Task allocation is a scheduler, not a frame-by-frame operation.
    // Automatic mode handles a bounded number of missions per cycle, which
    // prevents a large task burst from freezing the browser.
    if (this.autoTaskAssignment && this.assignmentAccumulator >= this.assignmentInterval) {
      this.assignmentAccumulator %= this.assignmentInterval;
      this.assignTasks(this.autoAssignmentTaskBudget);
    }
  }

  // ============================================================
  // CONFLICT KEY
  // ============================================================

  private getConflictKey(
    conflict: CollisionPrediction
  ): string {
    const robotIds = [
      conflict.robotA,
      conflict.robotB,
    ].sort();

    return [
      robotIds[0],
      robotIds[1],
      conflict.conflictPoint.x,
      conflict.conflictPoint.y,
    ].join("|");
  }

  // ============================================================
  // RIGHT-OF-WAY NEGOTIATION
  // ============================================================

  private addCommunicationLink(
    robotA: string,
    robotB: string,
    reason: string,
    durationSeconds: number = 0.25
  ): void {
    if (robotA === robotB) return;
    const a = robotA < robotB ? robotA : robotB;
    const b = robotA < robotB ? robotB : robotA;
    const expiresAt = this.world.simulationTime + durationSeconds;
    const existing = this.communicationLinks.find(
      link => link.robotA === a && link.robotB === b
    );
    if (existing) {
      existing.reason = reason;
      existing.expiresAt = Math.max(existing.expiresAt, expiresAt);
      return;
    }
    this.communicationLinks.push({ robotA: a, robotB: b, reason, expiresAt });
    if (this.communicationLinks.length > 120) this.communicationLinks.shift();
  }

  private refreshCommunicationNetwork(): void {
    const robots = this.world.robots.filter(robot => robot.state !== "FAILED");
    const radius = 3.25;

    for (const a of robots) {
      for (const b of this.spatialIndex.nearbyRobot(a, radius)) {
        if (a.id >= b.id) continue;
        this.addCommunicationLink(a.id, b.id, "P2P TRAFFIC SYNC", 0.18);
      }
    }
  }

  private resolveRightOfWay(): void {
    for (
      const conflict of
        this.collisionPredictions
    ) {
      const conflictKey =
        this.getConflictKey(
          conflict
        );

      /*
       * Same conflict was already negotiated.
       * Don't continuously reroute the same robot.
       */
      if (
        this.handledConflicts.has(
          conflictKey
        )
      ) {
        continue;
      }

      this.addCommunicationLink(
        conflict.robotA,
        conflict.robotB,
        "P2P CONFLICT NEGOTIATION",
        0.5
      );

      const decision =
        this.rightOfWayNegotiator
          .negotiate(
            conflict,
            this.world.robots,
            this.world.tasks
          );

      if (
        decision === null
      ) {
        continue;
      }

      this.handledConflicts.add(
        conflictKey
      );

      this.rightOfWayDecisions.unshift(
        decision
      );

      if (
        this.rightOfWayDecisions
          .length > 10
      ) {
        this.rightOfWayDecisions.pop();
      }

      this.totalRightOfWayNegotiations++;

      this.applyYieldDecision(
        decision
      );
    }

    /*
     * Remove old handled conflicts
     * when they are no longer predicted.
     *
     * This allows the system to negotiate
     * a genuinely new conflict later.
     */
    const activeKeys =
      new Set(
        this.collisionPredictions.map(
          conflict =>
            this.getConflictKey(
              conflict
            )
        )
      );

    for (
      const key of
        this.handledConflicts
    ) {
      if (
        !activeKeys.has(key)
      ) {
        this.handledConflicts.delete(
          key
        );
      }
    }
  }

  // ============================================================
  // APPLY YIELD DECISION / COOPERATIVE RE-ROUTE
  // ============================================================

  /**
   * P2P right-of-way is a temporary crossing token, not a route rewrite.
   *
   * The highest-priority robot keeps its existing route and crosses first.
   * Every lower-priority participant waits upstream for a short, bounded
   * window. Once the winner clears the conflict, the waiting robot resumes
   * the original route. This is much more stable in dense parking/aisle
   * intersections than repeatedly replanning every loser.
   */
  private applyYieldDecision(
    decision: RightOfWayDecision
  ): void {
    const yieldingRobot = this.world.robots.find(
      robot => robot.id === decision.yieldingRobotId
    );

    if (!yieldingRobot) return;
    if (yieldingRobot.state === "FAILED") return;

    const priorityRobotId =
      decision.conflict.robotA === decision.yieldingRobotId
        ? decision.conflict.robotB
        : decision.conflict.robotA;

    const priorityRobot = this.world.robots.find(
      robot => robot.id === priorityRobotId
    );

    if (!priorityRobot || priorityRobot.state === "FAILED") return;

    const now = this.world.simulationTime;

    // Tell both peers that this is an active P2P right-of-way decision.
    this.addCommunicationLink(
      priorityRobot.id,
      yieldingRobot.id,
      "P2P RIGHT-OF-WAY: PRIORITY ROBOT",
      1.0
    );

    // Keep the losing robot on its original route. It simply waits before
    // entering the contested crossing. The winner is never stopped here.
    //
    // Use a bounded hold so a stale prediction cannot create a permanent
    // parking-lot stall. Immediate traffic checks will extend the hold if the
    // physical crossing is still occupied.
    const holdSeconds = 0.85;
    this.yieldUntil.set(
      yieldingRobot.id,
      Math.max(
        this.yieldUntil.get(yieldingRobot.id) ?? 0,
        now + holdSeconds
      )
    );

    // Do not clear the route or change WAITING state. Keeping the route is
    // critical: when the winner passes, the loser should simply continue.
    this.totalYieldActions++;
  }

  /**
   * Recalculate one robot's route while explicitly avoiding the predicted
   * conflict cell and the other robot's immediate traffic corridor.
   */
  private replanRobotAroundConflict(
    robot: Robot,
    conflictPoint: Point,
    extraBlocked: Point[]
  ): Point[] {
    const destination = this.getRobotRouteDestination(robot);
    if (!destination) return [];

    const blocked = this.uniquePoints([
      conflictPoint,
      ...extraBlocked,
      ...this.getNearbyTrafficBlockPoints(robot.id),
      ...this.getTaskObstaclePoints(robot.currentTaskId),
      ...this.getChargingStationObstaclePoints(),
    ]);

    // Never block the robot's own start or destination.
    const filteredBlocked = blocked.filter(point =>
      !this.samePoint(point, robot.position) &&
      !this.samePoint(point, destination)
    );

    let route = this.pathfinder.findPath(
      robot.position,
      destination,
      filteredBlocked
    );

    // If traffic temporarily occupies too much of the local area, retry with
    // only the actual conflict and the other robot's predicted corridor.
    if (route.length === 0) {
      route = this.pathfinder.findPath(
        robot.position,
        destination,
        this.uniquePoints([
          conflictPoint,
          ...extraBlocked.slice(0, 12),
        ]).filter(point =>
          !this.samePoint(point, robot.position) &&
          !this.samePoint(point, destination)
        )
      );
    }

    if (route.length === 0) return [];

    robot.route = route;
    robot.routeIndex = route.length > 1 ? 1 : 0;
    this.restoreMovementState(robot);

    return route;
  }

  private getRobotRouteDestination(robot: Robot): Point | null {
    if (robot.currentTaskId !== null) {
      const task = this.world.tasks.find(
        item => item.id === robot.currentTaskId
      );

      return task ? this.getTaskDestination(robot, task) : null;
    }

    // Charging has a stable destination independent of the current route
    // segment. This prevents deadlock recovery from accidentally changing a
    // return-to-charge robot's destination to a temporary waypoint.
    const exitPoint = this.chargingExitByRobot.get(robot.id);
    if (exitPoint) return exitPoint;

    const reservation = this.chargingManager.get(robot.id);
    if (reservation?.state === "RESERVED") {
      return { x: reservation.slot.x, y: reservation.slot.y };
    }

    const queuePoint = this.chargingManager.getQueuePoint(
      robot.id,
      this.world.environment
    );
    if (queuePoint) return queuePoint;

    return robot.route[robot.route.length - 1] ?? null;
  }

  /**
   * Return a small local reservation window instead of every robot in the
   * warehouse. This keeps conflict recovery scalable for the 100+ robot demo.
   */
  private getNearbyTrafficBlockPoints(excludeRobotId: string): Point[] {
    const points: Point[] = [];

    const source = this.world.robots.find(
      robot => robot.id === excludeRobotId
    );

    if (!source) return points;

    for (const other of this.spatialIndex.nearbyRobot(source, 10)) {
      if (other.state === "FAILED") continue;

      points.push({
        x: Math.round(other.position.x),
        y: Math.round(other.position.y),
      });

      // Reserve only the next few cells. Reserving an entire route would make
      // A* unnecessarily restrictive in a large fleet.
      for (let i = other.routeIndex; i < Math.min(other.routeIndex + 4, other.route.length); i++) {
        const point = other.route[i];
        if (point) points.push({ x: Math.round(point.x), y: Math.round(point.y) });
      }
    }

    return points;
  }

  private samePoint(a: Point, b: Point): boolean {
    return Math.round(a.x) === Math.round(b.x) &&
      Math.round(a.y) === Math.round(b.y);
  }

  private uniquePoints(points: Point[]): Point[] {
    const seen = new Set<string>();
    const result: Point[] = [];

    for (const point of points) {
      const key = `${Math.round(point.x)},${Math.round(point.y)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ x: Math.round(point.x), y: Math.round(point.y) });
    }

    return result;
  }

  // ============================================================
  // GET CURRENT TASK DESTINATION
  // ============================================================

  private getTaskDestination(
    robot: Robot,
    task: Task
  ): Point {
    if (
      robot.state ===
      "MOVING_TO_PICKUP"
    ) {
      return task.pickup;
    }

    return task.dropoff;
  }

  // ============================================================
  // ROBOT MOVEMENT
  // ============================================================

  private updateLiveCollisionRisks(): void {
    const active: Array<{ robotA: string; robotB: string; distance: number }> = [];
    const radius = this.robotClearance + 0.15;

    for (const a of this.world.robots) {
      if (a.state === "FAILED") continue;
      const moving = a.route.length > 0 && a.state !== "CHARGING" && a.state !== "IDLE";
      if (!moving) continue;

      for (const b of this.spatialIndex.nearbyRobot(a, radius)) {
        if (a.id >= b.id) continue;
        const bMoving = b.route.length > 0 && b.state !== "CHARGING" && b.state !== "IDLE";
        if (!bMoving) continue;

        const distance = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
        if (distance < this.robotClearance) {
          active.push({ robotA: a.id, robotB: b.id, distance });
          continue;
        }

        const nextA = a.route[a.routeIndex];
        const nextB = b.route[b.routeIndex];
        if (nextA && nextB) {
          const targetDistance = Math.hypot(nextA.x - nextB.x, nextA.y - nextB.y);
          if (targetDistance < this.robotClearance && distance < radius) {
            active.push({ robotA: a.id, robotB: b.id, distance });
          }
        }
      }
    }

    this.activeCollisionPairs = active;
    this.activeCollisionRiskCount = active.length;
  }

  private updateRobots(
    deltaTime: number
  ): void {
    for (
      const robot of
        this.world.robots
    ) {
      if (
        robot.state ===
        "FAILED"
      ) {
        continue;
      }

      // A launch-queued robot stays at its startup position until the launch
      // scheduler releases it.
      if (this.launchQueued.has(robot.id)) {
        continue;
      }

      const chargingExit = this.chargingExitByRobot.get(robot.id);
      if (chargingExit && robot.state === "RETURNING_TO_CHARGE") {
        if (robot.route.length === 0) {
          const exitDistance = Math.hypot(
            robot.position.x - chargingExit.x,
            robot.position.y - chargingExit.y
          );
          if (exitDistance < 0.75) {
            this.chargingExitByRobot.delete(robot.id);
            this.chargingManager.release(robot.id);
            robot.state = "IDLE";
            robot.route = [];
            robot.routeIndex = 0;
            continue;
          }
          const route = this.pathfinder.findPath(
            robot.position,
            chargingExit,
            this.getChargingStationObstaclePoints()
          );
          if (route.length > 0) {
            robot.route = route;
            robot.routeIndex = route.length > 1 ? 1 : 0;
          }
        }
      }

      if (
        robot.state ===
        "CHARGING"
      ) {
        this.chargeRobot(
          robot,
          deltaTime
        );

        continue;
      }

      // A robot can temporarily enter WAITING when right-of-way or
      // deadlock recovery cannot find a safe path on that tick. Do not
      // leave it permanently stranded: retry its mission/charging route
      // automatically on later simulation ticks.
      // Startup parking is temporary. Charging trips after a mission use
      // dynamically allocated station slots.
      if (robot.currentTaskId === null && this.isAtChargingSlot(robot)) {
        robot.route = [];
        robot.routeIndex = 0;

        if (robot.battery < robot.batteryCapacity) {
          robot.state = "CHARGING";
        } else {
          robot.state = "IDLE";
        }

        continue;
      }

      if (robot.state === "WAITING") {
        this.retryWaitingRobot(robot);
      }

      if (robot.route.length === 0) {
        // A robot with no mission must not remain stranded in the middle
        // of the warehouse. If there is no active work for it, send it
        // to the charging manager for a temporary bay.
        if (robot.currentTaskId === null && !this.isAtChargingSlot(robot)) {
          if (robot.state === "RETURNING_TO_CHARGE") {
            this.sendRobotToChargingStation(robot);
          } else if (this.world.tasks.every(task => task.status !== "PENDING")) {
            this.sendRobotToChargingStation(robot);
          }
        }

        continue;
      }

      const beforeX = robot.position.x;
      const beforeY = robot.position.y;

      // Resolve immediate body-to-body conflicts before the movement step.
      // Predictive collision negotiation runs at 10 Hz, but a physical block
      // can happen between two detector cycles. The local right-of-way check
      // below prevents the classic head-on deadlock where both robots keep
      // waiting for the other one to move first.
      if (this.handleImmediateTrafficConflict(robot)) {
        continue;
      }

      this.moveRobot(
        robot,
        deltaTime
      );

      const moved = Math.hypot(
        robot.position.x - beforeX,
        robot.position.y - beforeY
      );

      if (moved < 0.001 && robot.route.length > 0) {
        const count = (this.stagnantTicks.get(robot.id) ?? 0) + 1;
        this.stagnantTicks.set(robot.id, count);

        // About 0.6 s at the 10 Hz coordination tick. A robot can wait briefly
        // for traffic, but after this threshold it gets a fresh route.
        if (count >= 6) {
          this.recoverStalledRobot(robot);
          this.stagnantTicks.set(robot.id, 0);
        }
      } else {
        this.stagnantTicks.set(robot.id, 0);
      }

      robot.battery -=
        0.03;

      if (
        robot.battery <= 0
      ) {
        robot.battery = 0;

        robot.state =
          "FAILED";
      }
    }

    // Refresh once after the movement batch so the next coordination cycle
    // sees the actual robot positions. We deliberately do not rebuild after
    // every robot, keeping the 100-robot simulation inexpensive.
    this.spatialIndex.rebuild(this.world.robots);
  }

  /**
   * Retry a temporarily blocked robot instead of allowing WAITING to become
   * a permanent state. The robot keeps its current task and recalculates a
   * safe natural path around physical task objects and other robots.
   */
  private retryWaitingRobot(robot: Robot): void {
    if (robot.state !== "WAITING") return;

    if (robot.currentTaskId !== null) {
      const task = this.world.tasks.find(
        item => item.id === robot.currentTaskId
      );

      if (!task || task.status === "COMPLETED") {
        robot.currentTaskId = null;
        robot.route = [];
        robot.routeIndex = 0;
        robot.state = "IDLE";
        return;
      }

      const destination =
        task.status === "IN_PROGRESS"
          ? task.dropoff
          : task.pickup;

      const blocked = this.uniquePoints([
        ...this.getTaskObstaclePoints(task.id),
        ...this.getNearbyTrafficBlockPoints(robot.id),
      ]);

      // Recovery always prefers the shortest safe route while keeping the
      // robot away from the immediate traffic corridor that caused the wait.
      // is only for normal planning; it should not make a stalled robot take
      // a new long detour.
      const route = this.pathfinder.findPath(
        robot.position,
        destination,
        blocked
      );

      if (route.length > 0) {
        robot.route = route;
        robot.routeIndex = route.length > 1 ? 1 : 0;
        robot.state =
          task.status === "IN_PROGRESS"
            ? "MOVING_TO_DROPOFF"
            : "MOVING_TO_PICKUP";
        return;
      }

      // If the direct route is temporarily blocked, allow one bounded natural
      // alternative. It will still be constrained by the A* planner.
      const fallback = this.pathfinder.findNaturalPathToObject(
        robot.position,
        destination,
        blocked
      );

      if (fallback.length > 0) {
        robot.route = fallback;
        robot.routeIndex = fallback.length > 1 ? 1 : 0;
        robot.state =
          task.status === "IN_PROGRESS"
            ? "MOVING_TO_DROPOFF"
            : "MOVING_TO_PICKUP";
      }

      return;
    }

    // Charging positions are temporary reservations. Once a robot leaves a
    // bay, the next queued robot is free to claim that position.
    if (this.isAtChargingSlot(robot)) {
      const reservation = this.chargingManager.get(robot.id);
      if (reservation?.state === "RESERVED") {
        robot.route = [];
        robot.routeIndex = 0;
        robot.state = "CHARGING";
        return;
      }
    }

    this.sendRobotToChargingStation(robot);
  }

  /**
   * Re-plan a robot that has stopped making progress while still holding a
   * valid route. This handles temporary traffic blockage without repeatedly
   * rewriting routes that are already working.
   */
  private recoverStalledRobot(robot: Robot): void {
    if (robot.state === "FAILED" || robot.state === "CHARGING") return;

    let destination: Point | null = null;
    let blocked: Point[] = [];

    if (robot.currentTaskId !== null) {
      const task = this.world.tasks.find(
        item => item.id === robot.currentTaskId
      );

      if (!task) return;

      destination =
        task.status === "IN_PROGRESS"
          ? task.dropoff
          : task.pickup;
      blocked = this.getTaskObstaclePoints(task.id);
    } else if (robot.state === "RETURNING_TO_CHARGE") {
      destination = this.getRobotRouteDestination(robot);
    }

    if (!destination) return;

    const otherRobots = this.spatialIndex
      .nearbyRobot(robot, 8)
      .filter(other => other.state !== "FAILED" && other.state !== "CHARGING")
      .map(other => ({ x: Math.round(other.position.x), y: Math.round(other.position.y) }));

    const direct = this.pathfinder.findPath(
      robot.position,
      destination,
      [...blocked, ...otherRobots]
    );

    if (direct.length > 0) {
      robot.route = direct;
      robot.routeIndex = direct.length > 1 ? 1 : 0;
      this.restoreMovementState(robot);
      return;
    }

    // Let the normal collision/right-of-way system resolve the traffic
    // conflict rather than freezing the robot indefinitely.
    const fallback = this.pathfinder.findPath(
      robot.position,
      destination,
      blocked
    );

    if (fallback.length > 0) {
      robot.route = fallback;
      robot.routeIndex = fallback.length > 1 ? 1 : 0;
      this.restoreMovementState(robot);
    }
  }

  private restoreMovementState(robot: Robot): void {
    if (robot.currentTaskId === null) {
      if (robot.state !== "RETURNING_TO_CHARGE") {
        robot.state = "RETURNING_TO_CHARGE";
      }
      return;
    }

    const task = this.world.tasks.find(
      item => item.id === robot.currentTaskId
    );

    robot.state = task?.status === "IN_PROGRESS"
      ? "MOVING_TO_DROPOFF"
      : "MOVING_TO_PICKUP";
  }

  // ============================================================
  // IMMEDIATE TRAFFIC RIGHT-OF-WAY
  // ============================================================

  private handleImmediateTrafficConflict(robot: Robot): boolean {
    const lockedUntil = this.yieldUntil.get(robot.id) ?? 0;
    if (lockedUntil > this.world.simulationTime) {
      return true;
    }
    if (lockedUntil > 0) {
      this.yieldUntil.delete(robot.id);
    }

    if (robot.routeIndex >= robot.route.length) return false;

    const target = robot.route[robot.routeIndex];
    if (!target) return false;

    const blockers = this.spatialIndex
      .nearby(target, this.robotClearance + 0.12)
      .filter(other =>
        other.id !== robot.id &&
        other.state !== "FAILED"
      );

    if (blockers.length === 0) return false;

    // Ignore a robot that is safely behind the target rather than in the
    // movement corridor. This avoids unnecessary yielding in open aisles.
    const blocker = blockers
      .map(other => ({
        robot: other,
        distance: Math.hypot(
          other.position.x - target.x,
          other.position.y - target.y
        ),
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.robot;

    if (!blocker) return false;

    const now = this.world.simulationTime;
    const robotScore = this.getTrafficPriority(robot);
    const blockerScore = this.getTrafficPriority(blocker);

    // Deterministic tie break prevents two robots from choosing to yield at
    // the same time. Lower robot ID wins only when all operational factors
    // are equal.
    const robotWins =
      robotScore > blockerScore ||
      (robotScore === blockerScore && robot.id < blocker.id);

    // Physical body conflict is handled with the same P2P token as the
    // predictive layer: one robot moves, the other waits. Do not rewrite
    // either route here; route rewriting in a dense parking area can make
    // several robots chase one another into the same bottleneck.
    if (!robotWins) {
      this.addCommunicationLink(
        blocker.id,
        robot.id,
        "P2P RIGHT-OF-WAY: BLOCKER PRIORITY",
        0.75
      );

      // First give the higher-priority peer a short crossing window. If the
      // same robot is still blocked after that window, actively calculate an
      // alternate route instead of waiting forever.
      const nextYield = this.yieldUntil.get(robot.id) ?? 0;
      if (nextYield <= now) {
        const reroute = this.replanRobotAroundConflict(
          robot,
          target,
          blocker.route.slice(blocker.routeIndex, blocker.routeIndex + 8)
        );

        if (reroute.length > 1) {
          this.stagnantTicks.set(robot.id, 0);
          return false;
        }
      }

      this.yieldUntil.set(robot.id, now + 0.65);
      return true;
    }

    this.addCommunicationLink(
      robot.id,
      blocker.id,
      "P2P RIGHT-OF-WAY: CURRENT ROBOT PRIORITY",
      0.75
    );

    // The winner keeps moving. The blocker first gets a short yield window;
    // if it cannot clear, force it to calculate a route around the winner
    // rather than making both robots wait at the same intersection.
    const forced = this.forceTrafficYield(blocker, robot);
    if (!forced) {
      this.yieldUntil.set(blocker.id, now + 0.65);
    }

    // Do NOT stop the priority robot. It owns this crossing.
    return false;
  }

  private getTrafficPriority(robot: Robot): number {
    let score = 0;

    const task = robot.currentTaskId === null
      ? null
      : this.world.tasks.find(item => item.id === robot.currentTaskId) ?? null;

    if (task) {
      score += task.priority * 100;
      if (task.type === "EMERGENCY") score += 5000;
    }

    // A robot that is close to its minimum battery threshold gets a small
    // priority boost so it is not trapped behind normal traffic on the way to
    // charging.
    if (robot.battery < 20) score += 900;
    else if (robot.battery < 35) score += 300;

    if (robot.state === "RETURNING_TO_CHARGE") score += 150;
    if (robot.state === "MOVING_TO_DROPOFF") score += 40;
    if (robot.state === "MOVING_TO_PICKUP") score += 20;

    return score;
  }

  private forceTrafficYield(blocker: Robot, priorityRobot: Robot): boolean {
    if (blocker.state === "FAILED" || blocker.state === "CHARGING") {
      return false;
    }

    // An idle warehouse robot has no reason to occupy a traffic lane. Move it
    // to the charging/depot area so a working robot is never permanently
    // blocked by an unused agent.
    if (blocker.currentTaskId === null && blocker.state === "IDLE") {
      const previousRoute = blocker.route;
      this.sendRobotToChargingStation(blocker);
      if (blocker.route.length > 0) {
        this.yieldUntil.set(blocker.id, 0);
        return true;
      }
      blocker.route = previousRoute;
    }

    const destination = this.getRobotRouteDestination(blocker);
    if (!destination) return false;

    const blocked = this.uniquePoints([
      { x: priorityRobot.position.x, y: priorityRobot.position.y },
      ...priorityRobot.route
        .slice(priorityRobot.routeIndex, priorityRobot.routeIndex + 8)
        .map(point => ({ x: point.x, y: point.y })),
    ]).filter(point =>
      !this.samePoint(point, blocker.position) &&
      !this.samePoint(point, destination)
    );

    let route = this.pathfinder.findPath(
      blocker.position,
      destination,
      blocked
    );

    // A busy warehouse can make the first reservation window too restrictive.
    // Retry with only the priority robot's current cell blocked.
    if (route.length === 0) {
      route = this.pathfinder.findPath(
        blocker.position,
        destination,
        [{ x: Math.round(priorityRobot.position.x), y: Math.round(priorityRobot.position.y) }]
      );
    }

    if (route.length === 0) return false;

    blocker.route = route;
    blocker.routeIndex = route.length > 1 ? 1 : 0;
    this.restoreMovementState(blocker);
    this.yieldUntil.set(blocker.id, 0);
    this.stagnantTicks.set(blocker.id, 0);
    return true;
  }

  // ============================================================
  // MOVE ROBOT
  // ============================================================

  private moveRobot(
    robot: Robot,
    deltaTime: number
  ): void {
    if (
      robot.routeIndex >=
      robot.route.length
    ) {
      this.handleDestination(
        robot
      );

      return;
    }

    const target =
      robot.route[
        robot.routeIndex
      ];

    const dx =
      target.x -
      robot.position.x;

    const dy =
      target.y -
      robot.position.y;

    const distance =
      Math.sqrt(
        dx * dx +
        dy * dy
      );

    if (
      distance < 0.05
    ) {
      // Do not snap onto an occupied target cell. This is important at
      // charging stations where several robots can approach nearby slots
      // at the same time. Hold the robot until the target is clear.
      const targetOccupied = this.spatialIndex
        .nearby(target, this.robotClearance)
        .some(other =>
          other.id !== robot.id &&
          other.state !== "FAILED"
        );

      if (targetOccupied) {
        return;
      }

      robot.position = {
        x: target.x,
        y: target.y,
      };

      robot.routeIndex++;

      if (
        robot.routeIndex >=
        robot.route.length
      ) {
        this.handleDestination(
          robot
        );
      }

      return;
    }

    // Slightly increase fleet motion speed without changing the
    // robot-type speed definitions used by negotiation/bidding.
    // This keeps the existing 0.5x/1x/2x/4x/10x simulation controls intact.
    const movement =
      robot.speed *
      1.15 *
      deltaTime;

    const ratio =
      Math.min(
        1,
        movement / distance
      );

    const proposedX =
      robot.position.x +
      dx * ratio;

    const proposedY =
      robot.position.y +
      dy * ratio;

    // ----------------------------------------------------------
    // PHYSICAL ROBOT SEPARATION
    // ----------------------------------------------------------
    // The collision detector predicts future conflicts, but the old
    // movement step could still place two robot sprites on the same
    // coordinate before the detector had a chance to react. Treat the
    // robot body as a small physical exclusion radius during movement.
    // The moving robot simply waits for one simulation tick if another
    // robot occupies the proposed position.
    const robotClearance = this.robotClearance;

    const blockedByRobot = this.spatialIndex
      .nearby(
        { x: proposedX, y: proposedY },
        robotClearance
      )
      .some(other =>
        other.id !== robot.id &&
        other.state !== "FAILED"
      );

    if (blockedByRobot) {
      const stagnant = (this.stagnantTicks.get(robot.id) ?? 0) + 1;
      this.stagnantTicks.set(robot.id, stagnant);

      return;
    }

    this.stagnantTicks.set(robot.id, 0);
    robot.position.x = proposedX;
    robot.position.y = proposedY;

    this.recordRobotPath(robot);
  }

  private recordRobotPath(robot: Robot): void {
    const last =
      robot.pathHistory[robot.pathHistory.length - 1];

    if (!last) {
      robot.pathHistory.push({
        x: robot.position.x,
        y: robot.position.y,
      });
      return;
    }

    const distance =
      Math.hypot(
        robot.position.x - last.x,
        robot.position.y - last.y
      );

    // Only keep meaningful movement samples so the trail stays lightweight.
    if (distance < 0.18) return;

    robot.pathHistory.push({
      x: robot.position.x,
      y: robot.position.y,
    });

    // Keep the most recent trail bounded for long simulations.
    const maxTrailPoints = 300;
    if (robot.pathHistory.length > maxTrailPoints) {
      robot.pathHistory.splice(
        0,
        robot.pathHistory.length - maxTrailPoints
      );
    }
  }

  // ============================================================
  // DESTINATION HANDLING
  // ============================================================

  private handleDestination(
    robot: Robot
  ): void {
    if (
      robot.currentTaskId ===
      null
    ) {
      if (robot.state === "RETURNING_TO_CHARGE") {
        const exitPoint = this.chargingExitByRobot.get(robot.id);

        // A charged robot is considered clear only after it reaches the
        // dedicated exit-lane waypoint. Release the temporary bay reservation
        // only then, so another robot cannot enter behind it.
        if (exitPoint && Math.hypot(
          robot.position.x - exitPoint.x,
          robot.position.y - exitPoint.y
        ) < 1.0) {
          this.chargingExitByRobot.delete(robot.id);
          this.chargingManager.release(robot.id);
          this.chargingRecoveryAttempts.delete(robot.id);
          robot.state = "IDLE";
          robot.route = [];
          robot.routeIndex = 0;
          return;
        }

        const atChargingSlot =
          this.world.environment.chargingSlots.some(item =>
            Math.round(robot.position.x) === item.slot.x &&
            Math.round(robot.position.y) === item.slot.y
          );

        const atStation =
          this.world.environment.chargingStations.some(item =>
            Math.round(robot.position.x) === item.x &&
            Math.round(robot.position.y) === item.y
          );

        if (atChargingSlot) {
          const reservation = this.chargingManager.get(robot.id);
          const exitPoint = this.chargingExitByRobot.get(robot.id);

          if (exitPoint) {
            // Finished charging: continue to the exit lane before releasing
            // the temporary bay reservation.
            const exitRoute = this.buildChargingExitRoute(
              robot.position,
              exitPoint
            );
            if (exitRoute.length > 0) {
              robot.route = exitRoute;
              robot.routeIndex = exitRoute.length > 1 ? 1 : 0;
              robot.state = "RETURNING_TO_CHARGE";
            }
            return;
          }

          if (reservation?.state === "RESERVED") {
            robot.route = [];
            robot.routeIndex = 0;
            robot.state = "CHARGING";
            this.chargingRecoveryAttempts.delete(robot.id);
            return;
          }

          robot.route = [];
          robot.routeIndex = 0;
          robot.state = "WAITING";
          return;
        }

        if (atStation) {
          // The station marker itself is not a parking position. Redirect to
          // the robot's permanent physical slot instead of allowing robots to
          // stack on the station center.
          this.sendRobotToChargingStation(robot);
          return;
        }
      }

      robot.state = "IDLE";
      robot.route = [];
      robot.routeIndex = 0;
      return;
    }

    const task =
      this.world.tasks.find(
        item =>
          item.id ===
          robot.currentTaskId
      );

    if (!task) {
      robot.state =
        "IDLE";

      robot.route = [];

      robot.routeIndex = 0;

      robot.currentTaskId =
        null;

      return;
    }

    // ----------------------------------------------------------
    // Pickup
    // ----------------------------------------------------------

    if (
      robot.state ===
      "MOVING_TO_PICKUP"
    ) {
      // The pickup is a physical object on the floor. The robot interacts
      // from the adjacent approach cell instead of driving over it.
      robot.carryingPayload =
        true;

      task.status =
        "IN_PROGRESS";

      robot.state =
        "MOVING_TO_DROPOFF";

      const deliveryRoute =
        this.pathfinder.findNaturalPathToObject(
          robot.position,
          task.dropoff,
          [
            ...this.getTaskObstaclePoints(task.id),
            ...this.getChargingStationObstaclePoints(),
          ]
        );

      if (
        deliveryRoute.length ===
        0
      ) {
        robot.state =
          "WAITING";

        robot.route = [];

        return;
      }

      robot.route =
        deliveryRoute;

      robot.routeIndex =
        deliveryRoute.length > 1
          ? 1
          : 0;

      return;
    }

    // ----------------------------------------------------------
    // Dropoff
    // ----------------------------------------------------------

    if (
      robot.state ===
      "MOVING_TO_DROPOFF"
    ) {
      // Delivery is also performed from the safe approach cell.
      task.status =
        "COMPLETED";

      this.world.completedTasks++;

      robot.carryingPayload =
        false;

      robot.currentTaskId =
        null;

      robot.route = [];

      robot.routeIndex = 0;

      robot.workload =
        Math.max(
          0,
          robot.workload - 1
        );

      // The next mission should use the launch queue again if this robot
      // is assigned while parked at a charging slot.
      this.releasedFromLaunch.delete(robot.id);

      // Work is complete: return to a charging station before becoming
      // available for another mission. This keeps the fleet assembled
      // around the charging infrastructure between jobs.
      this.sendRobotToChargingStation(robot);
    }
  }

  // ============================================================
  // BATTERY CHARGING
  // ============================================================

  private chargeRobot(
    robot: Robot,
    deltaTime: number
  ): void {
    const reservation = this.chargingManager.get(robot.id);
    const atChargingSlot = this.isAtChargingSlot(robot);

    // Robots that start the simulation already parked in a bay may charge
    // there without owning a permanent reservation. This is only a startup /
    // idle condition. As soon as the robot receives a mission it leaves the
    // bay; all subsequent charging trips use temporary reservations.
    if (!reservation) {
      if (atChargingSlot && robot.currentTaskId === null) {
        robot.battery += 10 * deltaTime;
        if (robot.battery >= robot.batteryCapacity) {
          robot.battery = robot.batteryCapacity;
          robot.state = "IDLE";
        }
        return;
      }

      robot.state = "WAITING";
      robot.route = [];
      robot.routeIndex = 0;
      return;
    }

    if (reservation.state !== "RESERVED") {
      robot.state = "WAITING";
      robot.route = [];
      robot.routeIndex = 0;
      return;
    }

    if (!atChargingSlot) {
      robot.state = "RETURNING_TO_CHARGE";
      this.sendRobotToChargingStation(robot);
      return;
    }

    robot.battery += 10 * deltaTime;

    if (robot.battery >= robot.batteryCapacity) {
      robot.battery = robot.batteryCapacity;

      const station = this.getChargingStation(reservation.stationId);
      if (!station) {
        this.chargingManager.release(robot.id);
        robot.state = "IDLE";
        return;
      }

      // Charging is complete. Do not release the bay yet: the robot must
      // first travel through the dedicated exit lane so another robot cannot
      // enter and block the outgoing robot.
      const lanes = this.getChargingLanePoints(station);
      const exitRoute = this.buildChargingExitRoute(
        robot.position,
        lanes.exit
      );

      if (exitRoute.length > 0) {
        robot.route = exitRoute;
        robot.routeIndex = exitRoute.length > 1 ? 1 : 0;
        robot.state = "RETURNING_TO_CHARGE";
        this.chargingExitByRobot.set(robot.id, lanes.exit);
      } else {
        // Keep the reservation and retry the exit route rather than
        // releasing the bay and creating a station jam.
        robot.state = "CHARGING";
      }
    }
  }

  // ============================================================
  // DEADLOCK TEST / RECOVERY
  // ============================================================

  injectRobotFailure(robotId?: string): void {
    const candidates = this.world.robots.filter(
      robot => robot.state !== "FAILED"
    );

    if (candidates.length === 0) {
      return;
    }

    // Prefer a robot that is actively working so the failure injection
    // exercises task recovery instead of only failing an idle depot robot.
    const selected = robotId
      ? this.world.robots.find(
          robot => robot.id === robotId && robot.state !== "FAILED"
        )
      : candidates.find(
          robot => robot.currentTaskId !== null
        ) ?? candidates[0];

    if (!selected) {
      return;
    }

    if (selected.currentTaskId !== null) {
      const task = this.world.tasks.find(
        item => item.id === selected.currentTaskId
      );

      if (task && task.status !== "COMPLETED") {
        task.status = "PENDING";
        task.assignedRobotId = null;
      }
    }

    selected.currentTaskId = null;
    selected.route = [];
    selected.routeIndex = 0;
    selected.state = "FAILED";
    selected.workload = 0;
    selected.carryingPayload = false;

        this.chargingManager.release(selected.id);
    this.chargingExitByRobot.delete(selected.id);
    this.launchQueued.delete(selected.id);
    this.launchHoldRoutes.delete(selected.id);
    this.releasedFromLaunch.delete(selected.id);
  }

  injectDeadlockScenario(): void {
    const a = this.world.robots[0];
    const b = this.world.robots[1];

    if (!a || !b) return;

    a.position = { x: 10, y: 10 };
    b.position = { x: 11, y: 10 };

    a.pathHistory = [{ x: 10, y: 10 }];
    b.pathHistory = [{ x: 11, y: 10 }];

    a.route = [
      { x: 10, y: 10 },
      { x: 11, y: 10 },
    ];

    b.route = [
      { x: 11, y: 10 },
      { x: 10, y: 10 },
    ];

    a.routeIndex = 1;
    b.routeIndex = 1;
    a.state = "WAITING";
    b.state = "WAITING";

    this.deadlockEvents = [];
    this.handledDeadlocks.clear();

    const detected = this.deadlockDetector.detect(
      this.world.robots
    );

    for (const deadlock of detected) {
      this.deadlockEvents.push(deadlock);
      this.recoverDeadlock(deadlock);
    }
  }

  private recoverDeadlock(
    deadlock: DeadlockEvent
  ): void {
    const robot = this.world.robots.find(
      item => item.id === deadlock.recoveryRobotId
    );

    if (!robot || robot.state === "FAILED") return;

    const destination = robot.route[robot.route.length - 1];
    if (!destination) return;

    const blockedPoints = deadlock.robotIds
      .filter(id => id !== robot.id)
      .map(id => this.world.robots.find(item => item.id === id))
      .filter((item): item is Robot => Boolean(item))
      .map(item => ({
        x: Math.round(item.position.x),
        y: Math.round(item.position.y),
      }));

    const alternateRoute = this.pathfinder.findPath(
      robot.position,
      destination,
      [deadlock.point, ...blockedPoints]
    );

    if (alternateRoute.length > 0) {
      robot.route = alternateRoute;
      robot.routeIndex = alternateRoute.length > 1 ? 1 : 0;
      if (robot.state === "WAITING") {
        if (robot.currentTaskId === null) {
          robot.state = "RETURNING_TO_CHARGE";
        } else {
          const task = this.world.tasks.find(
            item => item.id === robot.currentTaskId
          );
          robot.state = task?.status === "IN_PROGRESS"
            ? "MOVING_TO_DROPOFF"
            : "MOVING_TO_PICKUP";
        }
      }
      this.deadlockRecoveryCount++;
      return;
    }

    // No safe alternate route yet: keep the mission intact and wait.
    // A later tick can retry after the other robot has moved.
    robot.state = "WAITING";
    robot.route = [robot.position, destination];
    robot.routeIndex = 1;
    this.deadlockRecoveryCount++;
  }

  // ============================================================
  // PUBLIC CONTROLS
  // ============================================================

  setSimulationSpeed(speed: number): void {
    const allowed = [0.5, 1, 2, 4, 10];
    if (allowed.includes(speed)) {
      this.simulationSpeed = speed;
    }
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
  }

  pause(): void {
    this.running = false;
  }

  togglePause(): void {
    this.running =
      !this.running;
  }

  reset(): void {
    this.running = false;

    this.initialize();
  }

  isRunning(): boolean {
    return this.running;
  }
}