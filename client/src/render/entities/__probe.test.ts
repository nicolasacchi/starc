import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GAME } from "@shared/gameData";
import type { QualitySettings } from "@render/core/quality";
import { BuildingView } from "./buildingView";

const Q = { postFx: true } as QualitySettings;

interface Priv {
  model: THREE.Group;
  barFill: THREE.Mesh;
  barBack: THREE.Mesh;
  barHolder: THREE.Group;
}

describe("probe", () => {
  it("anchor", () => {
    for (const key of ["nexus", "barracks", "hatchery"]) {
      const bv = new BuildingView({ id: 1, typeKey: key, playerId: 0 }, GAME.maps[0], Q);
      const p = bv as unknown as Priv;
      bv.setViewCamera(new THREE.PerspectiveCamera());
      for (const prog of [0, 0.25, 0.5, 1]) {
        bv.setEntityState("building");
        bv.setOrder(0, 0, 0, prog);
        bv.update(0.016);
        const shell = p.model.children[0] as THREE.Mesh;
        shell.geometry.computeBoundingBox();
        p.model.updateWorldMatrix(true, true);
        const bb = shell.geometry.boundingBox!.clone();
        bb.applyMatrix4(shell.matrixWorld);
        console.log(
          key,
          "prog", prog,
          "eased", p.model.scale.y.toFixed(4),
          "posY", p.model.position.y.toFixed(4),
          "worldMin", bb.min.y.toFixed(4),
          "worldMax", bb.max.y.toFixed(4),
          "fillX", p.barFill.scale.x.toFixed(3),
          "fillPosX", p.barFill.position.x.toFixed(3),
        );
      }
      bv.dispose();
    }
    expect(true).toBe(true);
  });
});
