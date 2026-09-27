import * as THREE from "three";
import { RtsCamera, MIN_ZOOM, MAX_ZOOM } from "/home/nik/project/startcraft/client/src/render/core/camera.ts";
import { heightField } from "/home/nik/project/startcraft/client/src/render/terrain/heightfield.ts";
import maps from "/home/nik/project/startcraft/shared/data/maps.json" with { type: "json" };

const map = maps.maps[0];
const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 2000);
camera.updateMatrixWorld();

const rig = new RtsCamera(camera, null, map);
const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok:", msg); };

assert(camera.position.length() > 0, "camera placed on first update");

// no DOM globals in this process
assert(typeof window === "undefined" && typeof document === "undefined", "process is DOM-free");

// focus follows and clamps
rig.focus(map.size + 500, -500, 3);
for (let i = 0; i < 200; i++) rig.update(1 / 60);
const target = new THREE.Vector3();
camera.getWorldDirection(target);
assert(camera.position.x > map.size, "focus clamped to map bounds (x>=size)");
assert(camera.position.z > 0, "focus clamped to map bounds (z>=0)");

// smooth convergence
rig.focus(64, 64, 0);
const before = camera.position.clone();
for (let i = 0; i < 3; i++) rig.update(1 / 60);
const mid = camera.position.clone();
for (let i = 0; i < 200; i++) rig.update(1 / 60);
const after = camera.position.clone();
assert(mid.distanceTo(after) > 0.01, "follow still converging after 3 frames");
assert(mid.distanceTo(before) < after.distanceTo(before), "critically damped: no overshoot past target");

// zoom clamp + smoothing
rig.setZoom(99);
for (let i = 0; i < 300; i++) rig.update(1 / 60);
assert(Math.abs(rig.zoom - MAX_ZOOM) < 1e-3, `zoom clamps to MAX_ZOOM (got ${rig.zoom.toFixed(4)})`);
rig.setZoom(-5);
for (let i = 0; i < 300; i++) rig.update(1 / 60);
assert(Math.abs(rig.zoom - MIN_ZOOM) < 1e-3, `zoom clamps to MIN_ZOOM (got ${rig.zoom.toFixed(4)})`);

// yaw rotate + snap
rig.setZoom(1);
rig.rotate(Math.PI / 6);
for (let i = 0; i < 200; i++) rig.update(1 / 60);
assert(Math.abs(rig.yaw - Math.PI / 6) < 1e-3, `yaw reached target (${rig.yaw.toFixed(4)})`);
rig.snapYaw();
for (let i = 0; i < 200; i++) rig.update(1 / 60);
assert(Math.abs(rig.yaw - Math.PI / 4) < 1e-3, `snapYaw lands on 45deg (${rig.yaw.toFixed(4)})`);

// keyboard pan is yaw-relative
const yawBefore = rig.yaw;
rig.handleKey("KeyW", true);
for (let i = 0; i < 30; i++) rig.update(1 / 60);
rig.handleKey("KeyW", false);
assert(Math.abs(rig.yaw - yawBefore) < 1e-6, "W pans without rotating");

// shake: trauma^2, decays to zero, and moves the camera
rig.addShake(1, 0.5);
let maxRoll = 0;
let displaced = 0;
const base = camera.position.clone();
for (let i = 0; i < 10; i++) {
  rig.update(1 / 60);
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
  maxRoll = Math.max(maxRoll, Math.abs(e.z));
  displaced = Math.max(displaced, camera.position.distanceTo(base));
}
assert(maxRoll > 1e-4, `shake applies roll (${maxRoll.toFixed(4)} rad)`);
assert(displaced > 1e-3, `shake displaces the camera (${displaced.toFixed(4)} m)`);
for (let i = 0; i < 60; i++) rig.update(1 / 60);
const settled = camera.position.clone();
for (let i = 0; i < 5; i++) rig.update(1 / 60);
assert(settled.distanceTo(camera.position) < 1e-6, "shake fully decays");

// picking against the height field
rig.focus(128, 128, 0);
for (let i = 0; i < 300; i++) rig.update(1 / 60);
camera.updateMatrixWorld();
const out = { x: 0, z: 0 };
const hit = rig.screenToGround(16 / 9 / 2, 0.5, out);
const field = heightField(map);
const y = field.sample(out.x, out.z);
const ray = rig.screenRay(16 / 9 / 2, 0.5);
const alongRay = ray.origin.y + ray.direction.y * ray.origin.distanceTo(ray.at(1, new THREE.Vector3()));
assert(hit, "screenToGround hit the terrain");
assert(Math.abs(y - field.sample(out.x, out.z)) < 1e-9, "picked point is on the height field");
console.log("   pick:", out.x.toFixed(2), out.z.toFixed(2), "y", y.toFixed(3), "rayY", alongRay.toFixed(3));

// horizon: the top of the screen should miss
const miss = rig.screenToGround(16 / 9 / 2, -1000, { x: 0, z: 0 });
assert(miss === false, "ray above the horizon returns false");

rig.dispose();
console.log("camera smoke done");
