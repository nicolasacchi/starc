/**
 * Control groups are pure bookkeeping, but a bug here costs the player their
 * army: a group that loses members, a recall that hands back the wrong ids, or
 * a "camera is over there" marker left pointing at a squad the player has since
 * disbanded.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { CONTROL_GROUP_COUNT, ControlGroups } from "./controlGroups";

describe("ControlGroups", () => {
  let groups: ControlGroups;

  beforeEach(() => {
    groups = new ControlGroups();
  });

  it("assigns a group and recalls exactly what was assigned", () => {
    groups.assign(3, [7, 2, 9]);

    expect(groups.has(3)).toBe(true);
    expect(groups.recall(3)).toEqual([2, 7, 9]);
  });

  it("hands back ids in a stable ascending order", () => {
    groups.assign(1, [9, 3, 5]);
    // The renderer draws selection rings; an unstable order flickers them.
    expect(groups.recall(1)).toEqual([3, 5, 9]);
  });

  it("de-duplicates an assignment instead of stacking ids", () => {
    groups.assign(2, [1, 1, 2, 2, 3]);
    expect(groups.recall(2)).toEqual([1, 2, 3]);
  });

  it("replaces the whole group on reassign", () => {
    groups.assign(4, [1, 2, 3]);
    groups.assign(4, [9]);
    expect(groups.recall(4)).toEqual([9]);
  });

  it("appends without disturbing the members already in the group", () => {
    groups.assign(5, [1, 2]);
    groups.addToGroup(5, [3, 1]);

    // Losing a unit because it was already there would shrink a squad mid-fight.
    expect(groups.recall(5)).toEqual([1, 2, 3]);
  });

  it("removes only the ids it is given", () => {
    groups.assign(6, [1, 2, 3, 4]);
    groups.removeFromGroup(6, [2, 4]);
    expect(groups.recall(6)).toEqual([1, 3]);
  });

  it("empties a group that loses its last member", () => {
    groups.assign(7, [1]);
    groups.removeFromGroup(7, [1]);
    expect(groups.isEmpty(7)).toBe(true);
    expect(groups.has(7)).toBe(false);
  });

  it("ignores a group number outside the ten hotkeys", () => {
    groups.assign(CONTROL_GROUP_COUNT, [1]);
    groups.assign(-1, [2]);
    expect(groups.recall(CONTROL_GROUP_COUNT)).toEqual([]);
    expect(groups.recall(-1)).toEqual([]);
    expect(groups.has(CONTROL_GROUP_COUNT)).toBe(false);
  });

  it("keeps groups independent of one another", () => {
    groups.assign(1, [10]);
    groups.assign(2, [20]);
    groups.clearGroup(1);

    expect(groups.recall(1)).toEqual([]);
    expect(groups.recall(2)).toEqual([20]);
  });

  it("marks the recalled group as centred with its members", () => {
    groups.assign(2, [4, 5]);
    groups.markCentred(2);

    // The minimap blips exactly the squad the camera was sent to.
    expect(groups.lastCentred).toBe(2);
    expect([...groups.centred].sort()).toEqual([4, 5]);
  });

  it("clears the centred marker when no group is passed", () => {
    groups.assign(2, [4, 5]);
    groups.markCentred(2);
    groups.markCentred(-1);

    // A stale blip keeps drawing a marker over ground the camera left.
    expect(groups.lastCentred).toBe(-1);
    expect(groups.centred.size).toBe(0);
  });

  it("refreshes the centred marker when the group changes", () => {
    groups.assign(2, [4]);
    groups.assign(3, [8, 9]);
    groups.markCentred(2);
    groups.markCentred(3);

    expect([...groups.centred].sort()).toEqual([8, 9]);
    expect(groups.lastCentred).toBe(3);
  });

  it("clears every group and the centred marker", () => {
    groups.assign(1, [1]);
    groups.markCentred(1);
    groups.clearAll();

    expect(groups.recall(1)).toEqual([]);
    expect(groups.centred.size).toBe(0);
    expect(groups.lastCentred).toBe(-1);
  });

  it("returns a copy, so a caller cannot mutate the group through it", () => {
    groups.assign(8, [1, 2]);
    const recalled = groups.recall(8);
    recalled.push(99);
    expect(groups.recall(8)).toEqual([1, 2]);
  });

  it("honours a smaller group count", () => {
    const few = new ControlGroups(3);
    few.assign(2, [1]);
    expect(few.has(2)).toBe(true);
    expect(few.has(3)).toBe(false);
  });
});
