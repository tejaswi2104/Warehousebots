import type { Robot } from "../models/Robot";
import type { Task } from "../models/Task";

import type { Bid } from "./Bid";

import { BidEngine } from "./BidEngine";

export interface NegotiationResult {
  taskId: string;

  bids: Bid[];

  winningBid: Bid | null;

  negotiationTime: number;
}

export class Negotiator {

  private bidEngine: BidEngine;

  constructor() {

    this.bidEngine =
      new BidEngine();
  }

  // ==========================================================
  // ANNOUNCE TASK
  // ==========================================================

  announceTask(
    task: Task,
    robots: Robot[],
    currentTime: number
  ): NegotiationResult {

    const startTime =
      performance.now();

    const bids: Bid[] = [];

    // --------------------------------------------------------
    // Broadcast task to robots
    // --------------------------------------------------------

    for (
      const robot
      of robots
    ) {

      const bid =
        this.bidEngine.generateBid(
          robot,
          task,
          currentTime
        );

      if (bid !== null) {
        bids.push(bid);
      }
    }

    // --------------------------------------------------------
    // Find winning bid
    // --------------------------------------------------------

    let winningBid:
      Bid | null = null;

    for (
      const bid
      of bids
    ) {

      if (
        winningBid === null ||
        bid.score <
        winningBid.score
      ) {

        winningBid =
          bid;
      }
    }

    const negotiationTime =
      performance.now() -
      startTime;

    return {

      taskId:
        task.id,

      bids,

      winningBid,

      negotiationTime,
    };
  }

  // ==========================================================
  // NEGOTIATE ALL PENDING TASKS
  // ==========================================================

  negotiateTasks(
    tasks: Task[],
    robots: Robot[],
    currentTime: number
  ): NegotiationResult[] {

    const results:
      NegotiationResult[] = [];

    for (
      const task
      of tasks
    ) {

      if (
        task.status !==
        "PENDING"
      ) {
        continue;
      }

      const result =
        this.announceTask(
          task,
          robots,
          currentTime
        );

      results.push(result);
    }

    return results;
  }
}