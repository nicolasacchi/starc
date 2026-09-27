/**
 * RTS camera controller.
 *
 * A fixed-pitch orbit rig: the camera always looks at a ground point from a
 * yaw-relative offset, zoom is the only free axis, and everything else (pan,
 * rotate, follow, shake) moves that single focus point. The result is a camera
 * that can never end up under the terrain, and — because `PITCH` is chosen
 * against the FOV — one whose frame always contains the horizon.
 *
 * Headless-safe: the constructor and `update()` never read `document`/`window`
 * unless a `domElement` was supplied, so a Vitest `environment: "node"` run can
 * drive the whole controller against a bare `PerspectiveCamera`.
 */
import * as THREE from "three";
import type { MapDef } from "@shared/protocol";
import { heightField } from "../terrain/heightfield";

/**
 * Ground metres covered by the viewport's short axis at zoom 1. Paired with
 * `PITCH` and the perspective camera's FOV: the rig's height above the ground
 * is `BASE_VIEW_HEIGHT / (2·tan(fov/2))`, so this is also the knob that sets
 * how far the camera stands off the focus point.
 */
const BASE_VIEW_HEIGHT = 78;

/** Zoom clamp — 0.25 is a strategic overview, 1.6 is nose-on unit inspection. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 1.6;

/**
 * Downward pitch of the rig, in degrees. This is the one number that decides
 * whether the player ever sees a horizon: the frame spans `±fov/2` around the
 * view axis, so the top of the frame is `fov/2 − PITCH` above the horizontal.
 * Anything at or above `fov/2` points the whole frustum into the ground and
 * the sky dome is rendered but never on screen — which is exactly what a
 * 52° pitch under a 50° FOV did. 24° leaves a ~10% sky band.
 */
const PITCH = THREE.MathUtils.degToRad(24);

/** Follow smoothing time in seconds (critically damped, so no overshoot). */
const FOLLOW_SMOOTH_TIME = 0.16;
const ZOOM_SMOOTH_TIME = 0.12;
const YAW_SMOOTH_TIME = 0.1;

/** Pixels per second of pan at zoom 1, scaled with the on-screen view size. */
const PAN_SPEED = 520;

/** Screen-edge band, in CSS pixels, that triggers edge scrolling. */
const EDGE_MARGIN = 18;

/** Distance from a focus point to the map edge that the camera may not cross. */
const BOUNDS_MARGIN = 6;

/** Two double-taps of Q/E within this window snap the yaw to 45° steps. */
const SNAP_WINDOW_MS = 320;

/** Radians per second while Q or E is held. */
const ROTATE_SPEED = 1.9;

/** Double-tap rotation lands on a multiple of this angle. */
const SNAP_STEP = Math.PI / 4;
const MAX_SHAKE_OFFSET = 2.4;
const MAX_SHAKE_ROLL = THREE.MathUtils.degToRad(3.5);

/** Mutable per-axis state for the critically damped smoother. */
interface Spring {
  value: number;
  velocity: number;
}

/**
 * Unity's `SmoothDamp`: a critically damped spring, i.e. it converges as fast as
 * possible without overshooting. Pure exponential smoothing would either lag or
 * ring, and a ring reads as a bug when the camera is chasing a moving unit.
 */
function smoothDamp(spring: Spring, target: number, smoothTime: number, dt: number): number {
  const time = Math.max(smoothTime, 1e-4);
  const omega = 2 / time;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = spring.value - target;
  const temp = (spring.velocity + omega * change) * dt;
  spring.velocity = (spring.velocity - omega * temp) * decay;
  const next = target + (change + temp) * decay;
  // Guard the overshoot case the analytic solution can still cross at low fps.
  if (target - spring.value > 0 === next > target) {
    // (moving away from the target and the step crossed it, or vice versa)
    spring.value = target;
    spring.velocity = 0;
    return target;
  }
  spring.value = next;
  return next;
}

/** Cheap deterministic wobble — a jitter table would allocate every frame. */
function wobble(time: number, seed: number): number {
  return (
    Math.sin(time * 37.13 + seed * 12.9898) * 0.6 +
    Math.sin(time * 61.7 + seed * 78.233) * 0.3 +
    Math.sin(time * 113.3 + seed * 39.425) * 0.1
  );
}

export class RtsCamera {
  /**
   * The camera this rig drives. Public read-only: callers that own the
   * `PerspectiveCamera` need it for frustum culling, unprojection and effect
   * anchoring, and reading it back is the only way to observe shake.
   */
  readonly camera: THREE.PerspectiveCamera;
  private readonly domElement: HTMLElement | null;
  private readonly map: MapDef;

  /** Ground point the rig is looking at (smoothed). */
  private readonly focusSpringX: Spring = { value: 0, velocity: 0 };
  private readonly focusSpringZ: Spring = { value: 0, velocity: 0 };
  private readonly zoomSpring: Spring = { value: 1, velocity: 0 };
  private readonly yawSpring: Spring = { value: 0, velocity: 0 };

  /** Where the controller wants the focus to be. */
  private targetX = 0;
  private targetZ = 0;
  private targetZoom = 1;
  private targetYaw = 0;

  private readonly keys = new Set<string>();
  /** Height of the look-at point; NaN means "re-sample the height field". */
  private targetY = Number.NaN;
  private focusHeight = 0;

  private edgeScroll = false;
  private edgeInside = false;

  private onWheel: ((event: WheelEvent) => void) | null = null;
  private onKeyDown: ((event: KeyboardEvent) => void) | null = null;
  private onKeyUp: ((event: KeyboardEvent) => void) | null = null;
  private onPointerMove: ((event: PointerEvent) => void) | null = null;
  private onPointerLeave: (() => void) | null = null;
  private onBlur: (() => void) | null = null;
  private onContextMenu: ((event: Event) => void) | null = null;
  private pointerClientX = 0;
  private pointerClientY = 0;

  private lastRotateKey = "";
  private lastRotateTap = 0;

  private trauma = 0;
  private shakeDuration = 1;
  private shakeTime = 0;
  private elapsed = 0;

  private disposed = false;

  /** Reused scratch — `update()` must not allocate. */
  private readonly scratchRay = new THREE.Ray();
  private readonly scratchPoint = new THREE.Vector3();
  private readonly scratchOffset = new THREE.Vector3();
  private readonly scratchNdc = new THREE.Vector2();
  private readonly scratchRoll = new THREE.Euler();

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement | null, map: MapDef) {
    this.camera = camera;
    this.domElement = domElement;
    this.map = map;
    this.targetZoom = 1;
    this.zoomSpring.value = 1;
    const centre = map.size * 0.5;
    this.focusSpringX.value = centre;
    this.focusSpringZ.value = centre;
    this.targetX = centre;
    this.targetZ = centre;
    this.attach();
    this.apply(0);
  }

  /* ---------------------------------------------------------------- */
  /* Public control surface                                            */
  /* ---------------------------------------------------------------- */

  /** The current smoothed zoom factor (0.25 … 1.6). */
  get zoom(): number {
    return this.zoomSpring.value;
  }

  setZoom(z: number): void {
    this.targetZoom = THREE.MathUtils.clamp(z, MIN_ZOOM, MAX_ZOOM);
  }

  /** Current smoothed yaw in radians. */
  get yaw(): number {
    return this.yawSpring.value;
  }

  /** Smoothed world X the rig is centred on. */
  get focusX(): number {
    return this.focusSpringX.value;
  }

  /** Smoothed world Z the rig is centred on. */
  get focusZ(): number {
    return this.focusSpringZ.value;
  }

  /** Current yaw target, in radians — the value the spring is chasing. */
  get yawTarget(): number {
    return this.targetYaw;
  }

  /** Adds to the yaw target; positive rotates clockwise viewed from above. */
  rotate(deltaYaw: number): void {
    this.targetYaw = this.wrapAngle(this.targetYaw + deltaYaw);
  }

  /** Snaps the yaw target to the nearest multiple of 45°. */
  snapYaw(): void {
    this.targetYaw = this.wrapAngle(Math.round(this.targetYaw / SNAP_STEP) * SNAP_STEP);
  }

  /** Follows a ground point. `worldHeight` is the sim's authoritative Y. */
  focus(x: number, z: number, worldHeight: number): void {
    this.targetX = THREE.MathUtils.clamp(x, 0, this.map.size);
    this.targetZ = THREE.MathUtils.clamp(z, 0, this.map.size);
    this.targetY = worldHeight;
  }

  /**
   * Pans immediately, in ground metres, relative to the current focus. Manual
   * panning hands the focus height back to the height field, otherwise the rig
   * would keep the Y of whatever it was following a second ago.
   */
  panBy(dx: number, dz: number): void {
    this.targetX = THREE.MathUtils.clamp(this.targetX + dx, 0, this.map.size);
    this.targetZ = THREE.MathUtils.clamp(this.targetZ + dz, 0, this.map.size);
    this.targetY = Number.NaN;
  }

  /** Keyboard state, for callers that own their own listeners. */
  handleKey(code: string, down: boolean): void {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  setEdgeScrollEnabled(enabled: boolean): void {
    this.edgeScroll = enabled;
    if (!enabled) this.edgeInside = false;
  }

  /** Records the pointer position for edge scrolling. */
  setPointer(clientX: number, clientY: number): void {
    this.pointerClientX = clientX;
    this.pointerClientY = clientY;
  }

  /**
   * Trauma-based shake. `intensity` is 0…1 and is combined (not replaced) with
   * any shake already running, so a cluster of explosions builds up instead of
   * restarting. Displacement is `trauma²`, which is what makes the start of a
   * shake violent and the tail inaudible.
   */
  addShake(intensity: number, durationSeconds: number): void {
    this.trauma = THREE.MathUtils.clamp(this.trauma + intensity, 0, 1);
    this.shakeDuration = Math.max(0.05, durationSeconds);
    this.shakeTime = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Per-frame update                                                  */
  /* ---------------------------------------------------------------- */

  update(deltaSeconds: number): void {
    if (this.disposed) return;
    const dt = THREE.MathUtils.clamp(deltaSeconds, 0, 0.1);
    // Wrapped so a long session cannot lose float precision in the shake maths.
    this.elapsed = (this.elapsed + dt) % 3600;

    this.applyKeyboardPan(dt);
    this.applyEdgeScroll(dt);
    this.applyKeyRotation(dt);

    smoothDamp(this.focusSpringX, this.targetX, FOLLOW_SMOOTH_TIME, dt);
    smoothDamp(this.focusSpringZ, this.targetZ, FOLLOW_SMOOTH_TIME, dt);
    smoothDamp(this.zoomSpring, this.targetZoom, ZOOM_SMOOTH_TIME, dt);
    smoothDamp(this.yawSpring, this.targetYaw, YAW_SMOOTH_TIME, dt);

    this.apply(dt);
  }

  /** Writes the transform onto the underlying camera. */
  private apply(dt: number): void {
    const slackX = Math.min(this.map.size * 0.25, this.viewWidth() * 0.5) + BOUNDS_MARGIN;
    const slackZ = Math.min(this.map.size * 0.25, this.viewHeight() * 0.5) + BOUNDS_MARGIN;
    const fx = THREE.MathUtils.clamp(this.focusSpringX.value, -slackX, this.map.size + slackX);
    const fz = THREE.MathUtils.clamp(this.focusSpringZ.value, -slackZ, this.map.size + slackZ);
    const sampled = heightField(this.map).sample(
      THREE.MathUtils.clamp(fx, 0, this.map.size),
      THREE.MathUtils.clamp(fz, 0, this.map.size),
    );
    // The follow target's own Y wins while one is set (it comes from the sim);
    // otherwise ride the terrain.
    this.focusHeight = Number.isFinite(this.targetY) ? this.targetY : sampled;

    const distance = this.orbitDistance();
    const cosPitch = Math.cos(PITCH);
    this.scratchOffset.set(Math.sin(this.yawSpring.value) * cosPitch, Math.sin(PITCH), Math.cos(this.yawSpring.value) * cosPitch);
    this.scratchPoint.set(fx, this.focusHeight, fz);
    this.scratchOffset.multiplyScalar(distance);
    this.camera.position.copy(this.scratchPoint).add(this.scratchOffset);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.scratchPoint);
    this.applyShake(dt);
  }

  private applyShake(dt: number): void {
    if (this.trauma <= 0) {
      if (this.shakeTime > 0) this.shakeTime = 0;
      return;
    }
    this.shakeTime += dt;
    // Trauma decays linearly from whatever `addShake` accumulated, not from 1.
    // Ramping from 1 would silently discard the caller's intensity, making a
    // rifle hit shake the camera as hard as a building collapsing.
    this.trauma = Math.max(0, this.trauma * (1 - this.shakeTime / this.shakeDuration));
    const amount = this.trauma * this.trauma;
    const scale = MAX_SHAKE_OFFSET * amount * distanceScale(this.zoomSpring.value);
    this.camera.position.x += wobble(this.elapsed, 1.7) * scale;
    this.camera.position.y += wobble(this.elapsed, 4.1) * scale * 0.6;
    this.camera.position.z += wobble(this.elapsed, 8.3) * scale;

    const roll = wobble(this.elapsed, 2.9) * MAX_SHAKE_ROLL * amount;
    this.scratchRoll.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.scratchRoll.z += roll;
    this.camera.quaternion.setFromEuler(this.scratchRoll);
  }

  /* ---------------------------------------------------------------- */
  /* Panning                                                           */
  /* ---------------------------------------------------------------- */

  /** Pan speed in metres per second — scales with zoom so it feels constant. */
  private get panSpeed(): number {
    return (PAN_SPEED * this.viewHeight()) / 100;
  }

  private applyKeyboardPan(dt: number): void {
    let forward = 0;
    let strafe = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) forward += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) forward -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) strafe += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) strafe -= 1;
    if (forward === 0 && strafe === 0) return;

    const speed = this.panSpeed * dt;
    // Screen-space input mapped through the rig's yaw: forward is "up the
    // screen" no matter how the player has rotated the view.
    const sin = Math.sin(this.yawSpring.value);
    const cos = Math.cos(this.yawSpring.value);
    this.panBy((-sin * forward + cos * strafe) * speed, (-cos * forward - sin * strafe) * speed);
  }

  private applyEdgeScroll(dt: number): void {
    if (!this.edgeScroll || !this.edgeInside || !this.domElement) return;
    const rect = this.domElement.getBoundingClientRect();
    const width = rect.width || this.domElement.clientWidth || 0;
    const height = rect.height || this.domElement.clientHeight || 0;
    if (width <= 0 || height <= 0) return;

    const localX = this.pointerClientX - rect.left;
    const localY = this.pointerClientY - rect.top;
    if (localX < -EDGE_MARGIN || localX > width + EDGE_MARGIN) return;
    if (localY < -EDGE_MARGIN || localY > height + EDGE_MARGIN) return;

    // Normalised −1…1 ramp in the edge band, zero in the safe middle.
    const nx = edgeAxis(localX, width, EDGE_MARGIN);
    const ny = edgeAxis(localY, height, EDGE_MARGIN);
    if (nx === 0 && ny === 0) return;

    const speed = this.panSpeed * dt;
    const sin = Math.sin(this.yawSpring.value);
    const cos = Math.cos(this.yawSpring.value);
    this.panBy((-sin * -ny + cos * nx) * speed, (-cos * -ny - sin * nx) * speed);
  }

  /** Q/E spin the rig while held; a double tap snaps to 45° (see onKeyDown). */
  private applyKeyRotation(dt: number): void {
    let direction = 0;
    if (this.keys.has("KeyQ")) direction -= 1;
    if (this.keys.has("KeyE")) direction += 1;
    if (direction === 0) return;
    this.rotate(direction * ROTATE_SPEED * dt);
  }

  /* ---------------------------------------------------------------- */
  /* Picking                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Screen point → ground. Marches the ray against the height field instead of
   * a flat plane, so a click on a hill selects the unit standing on the hill and
   * not the one in the valley behind it.
   */
  screenToGround(clientX: number, clientY: number, out: { x: number; z: number }): boolean {
    const ray = this.screenRay(clientX, clientY);
    if (ray.direction.y >= -1e-4) return false;

    const field = heightField(this.map);
    // Seed with the sea-level plane hit, then refine against the terrain: each
    // step re-aims the ray at the surface under the previous hit.
    let t = -ray.origin.y / ray.direction.y;
    if (t < 0) return false;
    t = Math.min(t, this.maxPickDistance());
    for (let i = 0; i < 6; i++) {
      const x = ray.origin.x + ray.direction.x * t;
      const z = ray.origin.z + ray.direction.z * t;
      const y = field.sample(x, z);
      const dy = ray.origin.y + ray.direction.y * t - y;
      if (Math.abs(dy) < 0.05) break;
      t += dy / -ray.direction.y;
      if (t < 0 || t > this.maxPickDistance() * 1.5) return false;
    }
    const x = ray.origin.x + ray.direction.x * t;
    const z = ray.origin.z + ray.direction.z * t;
    if (x < -this.map.size || x > this.map.size * 2 || z < -this.map.size || z > this.map.size * 2) return false;
    out.x = x;
    out.z = z;
    return true;
  }

  /**
   * Unprojected world ray through a client-space pixel. The returned instance
   * is owned by the controller and is overwritten by the next call — copy it if
   * you need to keep it.
   */
  screenRay(clientX: number, clientY: number): THREE.Ray {
    const width = this.viewportWidth();
    const height = this.viewportHeight();
    this.scratchNdc.set((clientX / Math.max(width, 1)) * 2 - 1, -(clientY / Math.max(height, 1)) * 2 + 1);
    this.scratchPoint.set(this.scratchNdc.x, this.scratchNdc.y, 0.5).unproject(this.camera);
    this.scratchRay.origin.copy(this.camera.position);
    this.scratchRay.direction.copy(this.scratchPoint).sub(this.camera.position).normalize();
    return this.scratchRay;
  }

  /* ---------------------------------------------------------------- */
  /* Geometry of the rig                                              */
  /* ---------------------------------------------------------------- */

  /** Ground metres covered vertically by the viewport at the current zoom. */
  private viewHeight(): number {
    return BASE_VIEW_HEIGHT / this.zoomSpring.value;
  }

  private viewWidth(): number {
    const aspect = this.camera.aspect > 0 ? this.camera.aspect : 1;
    return this.viewHeight() * aspect;
  }

  /** Orbit radius: the distance that frames `viewHeight` metres of ground. */
  private orbitDistance(): number {
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) * 0.5;
    const t = Math.tan(halfFov);
    if (t <= 1e-4) return BASE_VIEW_HEIGHT;
    // The camera looks down at PITCH, so the ground footprint is stretched.
    return this.viewHeight() / (2 * t * Math.sin(PITCH));
  }

  private maxPickDistance(): number {
    return this.orbitDistance() + this.map.size;
  }

  private viewportWidth(): number {
    return this.domElement?.clientWidth ?? this.domElement?.getBoundingClientRect().width ?? 1;
  }

  private viewportHeight(): number {
    return this.domElement?.clientHeight ?? this.domElement?.getBoundingClientRect().height ?? 1;
  }

  private wrapAngle(angle: number): number {
    const twoPi = Math.PI * 2;
    return ((angle % twoPi) + twoPi) % twoPi;
  }

  /* ---------------------------------------------------------------- */
  /* DOM wiring                                                       */
  /* ---------------------------------------------------------------- */

  private attach(): void {
    const element = this.domElement;
    if (!element) return;

    this.onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // Wheel steps are ~100px per notch; map them to a multiplicative zoom so
      // each notch feels the same at every zoom level.
      this.setZoom(this.targetZoom * Math.exp(-event.deltaY * 0.0016));
    };
    this.onKeyDown = (event: KeyboardEvent) => {
      this.handleKey(event.code, true);
      if (event.code === "KeyQ" || event.code === "KeyE") {
        const now = Date.now();
        if (this.lastRotateKey === event.code && now - this.lastRotateTap <= SNAP_WINDOW_MS) {
          this.snapYaw();
          this.lastRotateKey = "";
        } else {
          this.lastRotateKey = event.code;
          this.lastRotateTap = now;
        }
      }
    };
    this.onKeyUp = (event: KeyboardEvent) => this.handleKey(event.code, false);
    this.onPointerMove = (event: PointerEvent) => {
      this.setPointer(event.clientX, event.clientY);
      const rect = element.getBoundingClientRect();
      this.edgeInside =
        event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    };
    this.onPointerLeave = () => {
      this.edgeInside = false;
    };
    this.onBlur = () => this.keys.clear();
    this.onContextMenu = (event: Event) => event.preventDefault();

    element.addEventListener("wheel", this.onWheel, { passive: false });
    element.addEventListener("keydown", this.onKeyDown);
    element.addEventListener("keyup", this.onKeyUp);
    element.addEventListener("pointermove", this.onPointerMove);
    element.addEventListener("pointerleave", this.onPointerLeave);
    element.addEventListener("blur", this.onBlur);
    element.addEventListener("contextmenu", this.onContextMenu);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const element = this.domElement;
    if (element) {
      if (this.onWheel) element.removeEventListener("wheel", this.onWheel);
      if (this.onKeyDown) element.removeEventListener("keydown", this.onKeyDown);
      if (this.onKeyUp) element.removeEventListener("keyup", this.onKeyUp);
      if (this.onPointerMove) element.removeEventListener("pointermove", this.onPointerMove);
      if (this.onPointerLeave) element.removeEventListener("pointerleave", this.onPointerLeave);
      if (this.onBlur) element.removeEventListener("blur", this.onBlur);
      if (this.onContextMenu) element.removeEventListener("contextmenu", this.onContextMenu);
    }
    this.onWheel = null;
    this.onKeyDown = null;
    this.onKeyUp = null;
    this.onPointerMove = null;
    this.onPointerLeave = null;
    this.onBlur = null;
    this.onContextMenu = null;
    this.keys.clear();
  }
}

/** −1…1 ramp across an edge band, 0 through the safe middle. */
function edgeAxis(local: number, extent: number, margin: number): number {
  if (extent <= margin * 2) return 0;
  if (local < margin) return -(margin - local) / margin;
  if (local > extent - margin) return (local - (extent - margin)) / margin;
  return 0;
}

/** Shake is a world-space effect, so it is damped as the camera pulls back. */
function distanceScale(zoom: number): number {
  return THREE.MathUtils.clamp(zoom / MAX_ZOOM, 0.35, 1);
}
