/// <reference types="vite/client" />

declare module "*.css";

/** Raw GLSL injected as a string; Vite passes these through untouched. */
declare module "*.glsl" {
  const src: string;
  export default src;
}

declare module "*.vert" {
  const src: string;
  export default src;
}

declare module "*.frag" {
  const src: string;
  export default src;
}
