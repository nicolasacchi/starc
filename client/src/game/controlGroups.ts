/**
 * Control groups — ten numbered squads, plus the "tap the number twice to
 * jump the camera there" gesture.
 *
 * A group is a list, not a set: recall hands the ids back ascending so the
 * renderer draws selection rings in a stable order.
 */
export const CONTROL_GROUP_COUNT = 10;

export class ControlGroups {
  private readonly groups: number[][] = [];
  private centredGroup = -1;

  /**
   * Members of the group the camera was last sent to; the UI blips these on the
   * minimap. Empty until a group is first recalled.
   */
  centred: Set<number> = new Set();

  constructor(readonly count: number = CONTROL_GROUP_COUNT) {
    for (let g = 0; g < count; g++) this.groups.push([]);
  }

  isEmpty(group: number): boolean {
    return this.inRange(group) && this.groups[group].length === 0;
  }

  has(group: number): boolean {
    return this.inRange(group) && this.groups[group].length > 0;
  }

  /** Replaces the group, de-duplicated, preserving the incoming order. */
  assign(group: number, ids: Iterable<number>): void {
    if (!this.inRange(group)) return;
    const seen = new Set<number>();
    const next: number[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      next.push(id);
    }
    this.groups[group] = next;
  }

  /** Appends to the group; ids already in it keep their place. */
  addToGroup(group: number, ids: Iterable<number>): void {
    if (!this.inRange(group)) return;
    const list = this.groups[group];
    const seen = new Set(list);
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      list.push(id);
    }
  }

  removeFromGroup(group: number, ids: Iterable<number>): void {
    if (!this.inRange(group)) return;
    const drop = new Set(ids);
    this.groups[group] = this.groups[group].filter((id) => !drop.has(id));
  }

  /** The group's members, ascending by id. Empty array for an unknown group. */
  recall(group: number): number[] {
    if (!this.inRange(group)) return [];
    return [...this.groups[group]].sort((a, b) => a - b);
  }

  get(group: number): number[] {
    return this.recall(group);
  }

  /**
   * Records the group the camera jumped to. Called on every recall: a single
   * tap remembers the squad for the minimap blip, a double tap also re-centres.
   */
  markCentred(group: number): void {
    this.centredGroup = this.inRange(group) ? group : -1;
    this.centred = new Set(this.recall(this.centredGroup));
  }

  /** The group number last passed to {@link markCentred}, or -1. */
  get lastCentred(): number {
    return this.centredGroup;
  }

  clearGroup(group: number): void {
    if (!this.inRange(group)) return;
    this.groups[group] = [];
  }

  clearAll(): void {
    for (let g = 0; g < this.count; g++) this.groups[g] = [];
    this.centredGroup = -1;
    this.centred = new Set();
  }

  private inRange(group: number): boolean {
    return group >= 0 && group < this.count;
  }
}
