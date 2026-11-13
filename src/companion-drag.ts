export type Point = { x: number; y: number };
/** Positions are absolute desktop DIP, independent of the moving overlay viewport. */
export class CompanionDrag {
  private origin: Point;
  private pointer: Point;
  moved = false;
  constructor(origin: Point, pointer: Point) { this.origin = origin; this.pointer = pointer; }
  sample(pointer: Point) {
    const dx = pointer.x - this.pointer.x, dy = pointer.y - this.pointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) this.moved = true;
    return { x: Math.round(this.origin.x + dx), y: Math.round(this.origin.y + dy) };
  }
}
