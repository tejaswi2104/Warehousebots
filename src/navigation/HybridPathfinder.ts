import type { Point } from "../models/Robot";
import { Environment } from "../models/Environment";

interface Node { x:number; y:number; g:number; f:number; parent:Node|null; direction:number; }
interface HeapItem { node:Node; priority:number; }

export class HybridPathfinder {
  private readonly environment: Environment;
  private readonly directions: Array<[number, number]> = [
    [1,0],[0,1],[-1,0],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1],
  ];
  private readonly diagonalCost = Math.SQRT2;
  private readonly turnPenalty = 0.12;
  private readonly trafficPenalty = 7;
  private readonly nearTrafficPenalty = 1.8;

  constructor(environment: Environment) { this.environment = environment; }

  findPath(start: Point, goal: Point, blockedPoints: Point[] = []): Point[] {
    const sx=Math.round(start.x), sy=Math.round(start.y);
    const gx=Math.round(goal.x), gy=Math.round(goal.y);
    if (!this.environment.isInside(sx,sy) || !this.environment.isInside(gx,gy)) return [];
    if (sx===gx && sy===gy) return [{x:sx,y:sy}];
    const traffic=this.toKeySet(blockedPoints);
    const strict=this.search(sx,sy,gx,gy,traffic,true);
    return strict.length>0 ? strict : this.search(sx,sy,gx,gy,traffic,false);
  }

  findNaturalPathToObject(start: Point, object: Point, blockedPoints: Point[]=[]): Point[] {
    const ox=Math.round(object.x), oy=Math.round(object.y);
    const approaches: Point[]=[];
    for (const [dx,dy] of this.directions) {
      const x=ox+dx, y=oy+dy;
      if (this.environment.isInside(x,y) && !this.isHardObstacle(x,y)) approaches.push({x,y});
    }
    approaches.sort((a,b)=>(Math.abs(a.x-start.x)+Math.abs(a.y-start.y))-(Math.abs(b.x-start.x)+Math.abs(b.y-start.y)));
    // Trying every possible approach can multiply A* work dramatically when
    // many robots are replanning. Four nearest valid approaches are enough to
    // provide robust object access without creating CPU spikes.
    let best:Point[]=[];
    for (const approach of approaches.slice(0, 4)) {
      const route=this.findPath(start,approach,blockedPoints);
      if (route.length>0 && (best.length===0 || route.length<best.length)) best=route;
    }
    if (best.length===0 && this.environment.isWalkable(ox,oy)) best=this.findPath(start,{x:ox,y:oy},blockedPoints);
    return best;
  }

  private search(sx:number,sy:number,gx:number,gy:number,traffic:Set<string>,strictTraffic:boolean):Point[] {
    const open:HeapItem[]=[];
    const bestG=new Map<string,number>();
    const closed=new Set<string>();
    const start:Node={x:sx,y:sy,g:0,f:this.heuristic(sx,sy,gx,gy),parent:null,direction:-1};
    bestG.set(this.key(sx,sy),0); this.push(open,{node:start,priority:start.f});
    let iterations=0;
    // Bound each search. The warehouse is 120x80 (9600 cells), so a 12000
    // node budget is enough for normal routes while preventing pathological
    // traffic replans from freezing the browser.
    const maxIterations=Math.min(this.environment.width*this.environment.height + 2400, 12000);

    while(open.length && iterations++<maxIterations) {
      const item=this.pop(open); if(!item) break;
      const current=item.node, currentKey=this.key(current.x,current.y);
      if(closed.has(currentKey)) continue;
      closed.add(currentKey);
      if(current.x===gx && current.y===gy) return this.reconstruct(current);

      for(let direction=0;direction<this.directions.length;direction++) {
        const [dx,dy]=this.directions[direction];
        const nx=current.x+dx, ny=current.y+dy, nextKey=this.key(nx,ny);
        if(!this.environment.isInside(nx,ny) || this.isHardObstacle(nx,ny)) continue;
        if(dx!==0 && dy!==0 && (this.isHardObstacle(current.x+dx,current.y) || this.isHardObstacle(current.x,current.y+dy))) continue;
        const isTraffic=traffic.has(nextKey) && !(nx===gx && ny===gy);
        if(strictTraffic && isTraffic) continue;
        const movement=dx!==0 && dy!==0 ? this.diagonalCost : 1;
        const turn=current.direction>=0 && current.direction!==direction ? this.turnPenalty : 0;
        const trafficCost=isTraffic ? this.trafficPenalty : this.nearTrafficCost(nx,ny,traffic);
        const g=current.g+movement+turn+trafficCost;
        const old=bestG.get(nextKey); if(old!==undefined && g>=old) continue;
        const node:Node={x:nx,y:ny,g,f:g+this.heuristic(nx,ny,gx,gy),parent:current,direction};
        bestG.set(nextKey,g); this.push(open,{node,priority:node.f});
      }
    }
    return [];
  }

  private isHardObstacle(x:number,y:number):boolean {
    if(!this.environment.isWalkable(x,y)) return true;
    for(const station of this.environment.chargingStations) {
      const halfWidth = Math.max(1, Math.floor((station.width ?? 7) / 2));
      const halfHeight = Math.max(1, Math.floor((station.height ?? 5) / 2));
      if(Math.abs(x-station.x)<=halfWidth && Math.abs(y-station.y)<=halfHeight) return true;
    }
    return false;
  }

  private nearTrafficCost(x:number,y:number,traffic:Set<string>):number {
    if(!traffic.size) return 0;
    for(const [dx,dy] of this.directions) if(traffic.has(this.key(x+dx,y+dy))) return this.nearTrafficPenalty;
    return 0;
  }

  private heuristic(x:number,y:number,gx:number,gy:number):number {
    const dx=Math.abs(gx-x), dy=Math.abs(gy-y);
    return Math.max(dx,dy)+(Math.SQRT2-1)*Math.min(dx,dy);
  }

  private reconstruct(node:Node):Point[] {
    const route:Point[]=[]; let current:Node|null=node;
    while(current){ route.push({x:current.x,y:current.y}); current=current.parent; }
    route.reverse(); return route;
  }

  private toKeySet(points:Point[]):Set<string> {
    const result=new Set<string>();
    for(const p of points) result.add(this.key(Math.round(p.x),Math.round(p.y)));
    return result;
  }
  private key(x:number,y:number):string { return `${x},${y}`; }

  private push(heap:HeapItem[],item:HeapItem):void {
    heap.push(item); let i=heap.length-1;
    while(i>0){ const p=Math.floor((i-1)/2); if(heap[p].priority<=heap[i].priority) break; [heap[p],heap[i]]=[heap[i],heap[p]]; i=p; }
  }
  private pop(heap:HeapItem[]):HeapItem|undefined {
    if(!heap.length) return undefined;
    const root=heap[0], last=heap.pop();
    if(heap.length && last){ heap[0]=last; let i=0;
      while(true){ const l=i*2+1,r=l+1; let s=i;
        if(l<heap.length && heap[l].priority<heap[s].priority) s=l;
        if(r<heap.length && heap[r].priority<heap[s].priority) s=r;
        if(s===i) break; [heap[i],heap[s]]=[heap[s],heap[i]]; i=s;
      }
    }
    return root;
  }
}
