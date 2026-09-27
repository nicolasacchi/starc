/**
 * Entry point.
 *
 * Boots `App` on `#app` and makes sure a failure is *visible*: a WebGL-less
 * machine, a bad bundle, or an exception thrown while the session check is in
 * flight all end up as a message on the page rather than only in the
 * console, because a black screen tells a player nothing.
 */
import "./ui/styles.css";
import { App } from "./game/app";

/** Replaces the page with a readable failure, escaping the detail as text. */
function reportFailure(heading: string, detail: string): void {
  const host = document.querySelector<HTMLElement>("#app") ?? document.body;
  host.textContent = "";
  host.classList.add("app");

  const panel = document.createElement("div");
  panel.className = "fatal";

  const title = document.createElement("h2");
  title.className = "fatal__title";
  title.textContent = heading;

  const body = document.createElement("p");
  body.className = "fatal__body";
  body.textContent = detail;

  panel.appendChild(title);
  panel.appendChild(body);
  host.appendChild(panel);
}

function describe(reason: unknown): string {
  if (reason instanceof Error) return `${reason.message}\n${reason.stack ?? ""}`.trim();
  return String(reason);
}

window.addEventListener("error", (event) => {
  reportFailure("The game hit an unexpected error", `${event.message}\n${event.filename ?? ""}:${event.lineno ?? 0}`);
});

window.addEventListener("unhandledrejection", (event) => {
  reportFailure("The game hit an unexpected error", describe(event.reason));
});

const root = document.querySelector<HTMLElement>("#app");
if (root === null) {
  reportFailure("The page is missing its mount point", 'Expected an element with id "app" in the document.');
} else {
  const app = new App();
  app.mount(root).catch((err: unknown) => {
    reportFailure("The game could not start", describe(err));
  });
}
