/**
 * Front screen: identity, play, leaderboard, graphics preset.
 *
 * The auth layer is injected (`AuthService`) rather than imported from
 * `@net/api`, so the whole screen is exercisable with a fake in a headless
 * test. Nothing here touches `document` before `mount()`.
 */
import { forcedQuality, isQualityPreset, setForcedQuality } from "@render/core/quality";
import type { QualityPreset } from "@render/core/quality";
import { GAME } from "@shared/gameData";
import { brandMark } from "./icons";
import type { AccountSummary, FieldRefs, UiHost } from "./uiTypes";
import { Teardown, button, clear, docOf, el, field, fmtInt, listen, select } from "./uiTypes";

export interface AuthResult {
  token: string;
  player: AccountSummary;
}

export interface AuthService {
  register(name: string, password: string): Promise<AuthResult>;
  login(name: string, password: string): Promise<AuthResult>;
  me(): Promise<{ player: AccountSummary }>;
}

export interface MainMenuDeps {
  auth: AuthService;
  /** Continue to the lobby. Only offered while signed in. */
  onPlay(): void;
  onSignOut(): void;
  onLeaderboard(): void;
  /** Forwarded after the preset has been persisted. */
  onQuality?(preset: QualityPreset): void;
}

type AuthMode = "login" | "register";

const NAME_PATTERN = /^[A-Za-z0-9_-]{3,24}$/;
const NAME_ERROR = "3–24 characters: letters, digits, underscore or dash.";
const PASSWORD_ERROR = "At least 6 characters.";
const MIN_PASSWORD = 6;
const QUALITY_LABEL: Record<QualityPreset, string> = {
  low: "Low — no effects",
  medium: "Medium — balanced",
  high: "High — shadows, SSAO",
  ultra: "Ultra — everything",
};

export class MainMenu {
  private readonly teardown = new Teardown();
  private readonly host: UiHost;
  private readonly deps: MainMenuDeps;
  private account: AccountSummary | null = null;
  private mode: AuthMode = "login";
  private busy = false;
  private doc: Document | null = null;
  private root: HTMLElement | null = null;
  private nameField: FieldRefs | null = null;
  private passwordField: FieldRefs | null = null;
  private formError: HTMLParagraphElement | null = null;
  private submitButton: HTMLButtonElement | null = null;
  private tabs: HTMLButtonElement[] = [];
  private playButton: HTMLButtonElement | null = null;
  private accountPanel: HTMLElement | null = null;
  private accountName: HTMLElement | null = null;
  private accountStats: HTMLElement | null = null;
  private authPanel: HTMLElement | null = null;
  private blurb: HTMLElement | null = null;

  constructor(host: UiHost, deps: MainMenuDeps) {
    this.host = host;
    this.deps = deps;
  }

  mount(root: HTMLElement): void {
    const doc = docOf(root);
    this.doc = doc;
    const screen = el(doc, "section", "screen menu");
    screen.setAttribute("aria-label", "Main menu");

    /* Brand ------------------------------------------------------------- */
    const brand = el(doc, "div", "menu__brand");
    const brandText = el(doc, "div", "menu__brandtext");
    const title = el(doc, "h1", "menu__title", "STARC");
    const tagline = el(doc, "p", "menu__tagline", "Tactical Command · build, rally, destroy");
    brandText.append(title, tagline);
    brand.append(brandMark(72), brandText);

    /* Account ------------------------------------------------------------ */
    const accountPanel = el(doc, "div", "panel menu__account");
    const accountName = el(doc, "p", "menu__accountname");
    const accountStats = el(doc, "p", "menu__accountstats");
    accountPanel.append(
      el(doc, "span", "chip chip--ok", "SIGNED IN"),
      accountName,
      accountStats,
      button(doc, { label: "Sign out", variant: "ghost", onClick: () => this.signOut() }, this.teardown),
    );
    this.accountPanel = accountPanel;
    this.accountName = accountName;
    this.accountStats = accountStats;

    /* Auth form ---------------------------------------------------------- */
    const authPanel = el(doc, "form", "panel menu__auth");
    authPanel.noValidate = true;
    const tabRow = el(doc, "div", "tabs");
    this.tabs = [this.makeTab("login", "Log in"), this.makeTab("register", "Create account")];
    for (const tab of this.tabs) tabRow.append(tab);
    this.nameField = field(
      doc,
      {
        id: "menu-name",
        label: "Commander name",
        placeholder: "nik",
        autocomplete: "username",
        maxLength: 24,
        hint: NAME_ERROR,
      },
    );
    this.passwordField = field(
      doc,
      {
        id: "menu-password",
        label: "Password",
        type: "password",
        placeholder: "at least 6",
        autocomplete: "current-password",
        hint: PASSWORD_ERROR,
      },
    );
    const formError = el(doc, "p", "menu__formerror");
    formError.setAttribute("role", "alert");
    const submit = el(doc, "button", "btn btn--primary", "Log in");
    submit.type = "submit";
    this.formError = formError;
    this.submitButton = submit;
    authPanel.append(tabRow, this.nameField.row, this.passwordField.row, formError, submit);
    this.wireValidation();
    listen(
      authPanel,
      "submit",
      (ev) => {
        ev.preventDefault();
        void this.submit();
      },
      this.teardown,
    );
    this.authPanel = authPanel;

    /* Actions ------------------------------------------------------------ */
    const actions = el(doc, "div", "menu__actions");
    const play = button(
      doc,
      { label: "Play", variant: "primary", disabled: true, onClick: () => this.deps.onPlay() },
      this.teardown,
    );
    play.classList.add("btn--xl");
    const leaderboard = button(
      doc,
      { label: "Leaderboard", variant: "ghost", onClick: () => this.deps.onLeaderboard() },
      this.teardown,
    );
    leaderboard.classList.add("btn--link");
    this.playButton = play;
    actions.append(play, leaderboard);

    const blurb = el(doc, "p", "menu__blurb");
    this.blurb = blurb;

    /* Footer ------------------------------------------------------------- */
    const footer = el(doc, "footer", "menu__foot");
    const qualityLabel = el(doc, "label", "menu__qualitylabel", "Graphics");
    const quality = select<QualityPreset>(
      doc,
      {
        className: "field__input menu__quality",
        value: forcedQuality() ?? "medium",
        ariaLabel: "Graphics preset",
        onChange: (value) => {
          if (!isQualityPreset(value)) return;
          setForcedQuality(value);
          this.deps.onQuality?.(value);
        },
      },
      (Object.keys(QUALITY_LABEL) as QualityPreset[]).map((preset) => ({ value: preset, label: QUALITY_LABEL[preset] })),
      this.teardown,
    );
    footer.append(
      qualityLabel,
      quality,
      el(doc, "p", "menu__note", `roster v${GAME.version} · ${GAME.maps.length} maps · world ${GAME.world_size}m`),
    );

    const body = el(doc, "div", "menu__body");
    body.append(accountPanel, authPanel, blurb, actions);
    screen.append(brand, body, footer);

    clear(root);
    root.append(screen);
    this.root = screen;
    this.teardown.add(() => {
      if (screen.parentNode !== null) screen.parentNode.removeChild(screen);
      this.root = null;
    });
    this.setMode("login");
    this.paint();
  }

  /** Shows the menu, with the account header updated. */
  show(account: AccountSummary | null = null): void {
    this.account = account;
    this.paint();
  }

  setVisible(visible: boolean): void {
    if (this.root !== null) this.root.hidden = !visible;
  }

  dispose(): void {
    this.teardown.dispose();
    this.doc = null;
  }

  /* -------------------------------------------------------------------- */

  private wireValidation(): void {
    const name = this.nameField;
    const password = this.passwordField;
    if (name === null || password === null) return;
    listen(name.input, "blur", () => this.setFieldError(name, this.validateName()), this.teardown);
    listen(
      name.input,
      "input",
      () => {
        if (name.error.textContent.length > 0) this.setFieldError(name, this.validateName());
      },
      this.teardown,
    );
    listen(password.input, "blur", () => this.setFieldError(password, this.validatePassword()), this.teardown);
    listen(
      password.input,
      "input",
      () => {
        if (password.error.textContent.length > 0) this.setFieldError(password, this.validatePassword());
      },
      this.teardown,
    );
  }

  private makeTab(mode: AuthMode, label: string): HTMLButtonElement {
    const doc = this.doc;
    if (doc === null) throw new Error("MainMenu: makeTab called before mount()");
    const tab = el(doc, "button", "tab", label);
    tab.type = "button";
    listen(tab, "click", () => this.setMode(mode), this.teardown);
    return tab;
  }

  private setMode(mode: AuthMode): void {
    this.mode = mode;
    const register = mode === "register";
    this.tabs.forEach((tab, index) => {
      const active = (index === 1) === register;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-pressed", active ? "true" : "false");
    });
    if (this.passwordField !== null) {
      this.passwordField.input.autocomplete = register ? "new-password" : "current-password";
    }
    if (this.submitButton !== null) {
      this.submitButton.textContent = register ? "Create account" : "Log in";
      this.submitButton.disabled = this.busy;
    }
    if (this.blurb !== null && this.account === null) {
      this.blurb.textContent = register
        ? "Pick a callsign. Every match, replay and rating is kept under it."
        : "Log in to resume your record, or create a callsign to get started.";
    }
    this.setFormError("");
  }

  private validateName(): string {
    if (this.nameField === null) return NAME_ERROR;
    return NAME_PATTERN.test(this.nameField.input.value.trim()) ? "" : NAME_ERROR;
  }

  private validatePassword(): string {
    if (this.passwordField === null) return PASSWORD_ERROR;
    return this.passwordField.input.value.length >= MIN_PASSWORD ? "" : PASSWORD_ERROR;
  }

  private setFieldError(refs: FieldRefs, message: string): void {
    refs.error.textContent = message;
    refs.row.classList.toggle("is-invalid", message.length > 0);
    refs.input.setAttribute("aria-invalid", message.length > 0 ? "true" : "false");
  }

  private setFormError(message: string): void {
    if (this.formError === null) return;
    this.formError.textContent = message;
    this.formError.classList.toggle("is-visible", message.length > 0);
  }

  private async submit(): Promise<void> {
    if (this.busy || this.nameField === null || this.passwordField === null) return;
    const nameError = this.validateName();
    const passwordError = this.validatePassword();
    this.setFieldError(this.nameField, nameError);
    this.setFieldError(this.passwordField, passwordError);
    this.setFormError("");
    if (nameError.length > 0) {
      this.nameField.input.focus();
      return;
    }
    if (passwordError.length > 0) {
      this.passwordField.input.focus();
      return;
    }
    const name = this.nameField.input.value.trim();
    const password = this.passwordField.input.value;
    this.setBusy(true);
    try {
      const result =
        this.mode === "register"
          ? await this.deps.auth.register(name, password)
          : await this.deps.auth.login(name, password);
      this.account = result.player;
      this.passwordField.input.value = "";
      this.host.notify(`Signed in as ${result.player.name}`);
    } catch (err) {
      this.setFormError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      this.setBusy(false);
      this.paint();
    }
  }

  private signOut(): void {
    this.account = null;
    this.setFormError("");
    this.paint();
    this.deps.onSignOut();
    this.host.notify("Signed out");
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (this.submitButton !== null) this.submitButton.disabled = busy;
    if (this.nameField !== null) this.nameField.input.disabled = busy;
    if (this.passwordField !== null) this.passwordField.input.disabled = busy;
  }

  private paint(): void {
    const signedIn = this.account !== null;
    if (this.playButton !== null) this.playButton.disabled = !signedIn;
    if (this.authPanel !== null) this.authPanel.hidden = signedIn;
    if (this.accountPanel !== null) this.accountPanel.hidden = !signedIn;
    if (this.accountName !== null) this.accountName.textContent = this.account?.name ?? "";
    if (this.accountStats !== null) {
      this.accountStats.textContent =
        this.account === null
          ? ""
          : `rating ${fmtInt(this.account.rating)} · ${fmtInt(this.account.wins)}W ${fmtInt(this.account.losses)}L`;
    }
    if (this.blurb !== null && signedIn) {
      this.blurb.textContent = "Your record travels with the account. Head to the lobby to find a match.";
    }
  }
}
