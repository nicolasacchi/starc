/**
 * Stylesheet contract.
 *
 * `styles.css` is the only styling in the game, and the UI modules are the only
 * thing that names its classes. Nothing in the build cross-checks the two, so
 * two whole classes of defect sail through a green suite:
 *
 *  1. a class the modules emit that no rule matches renders unstyled — a typo
 *     (`result__th` vs `.result__table thead th`) or a class that was never
 *     given a rule at all (`is-expanded`, `build__list`) is invisible in a
 *     screenshot review and in every other test;
 *  2. a fixed-track grid handed more children than it has tracks silently
 *     wraps the overflow onto an implicit second row, doubling the row's
 *     height. `.seat` declared six tracks and could emit seven children (a
 *     host who is also on a team).
 *
 * Both are derived from the sources rather than restated, so reverting the
 * stylesheet (or renaming a class in TS) fails here.
 *
 * Vitest runs `environment: "node"`; this suite never touches the DOM.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/* -------------------------------------------------------------- the sheet */

/** A parsed style rule: its selector list and its declarations. */
interface Rule {
  selectors: string[];
  decls: { prop: string; value: string }[];
}

function parseStylesheet(text: string): Rule[] {
  // Comments can contain braces and quotes; drop them before tokenising.
  const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];

  // Recursive-descent over one `{ ... }` level. `end` is the index of the
  // closing brace of that level (or css.length at the top).
  const walk = (start: number, end: number): void => {
    let i = start;
    for (;;) {
      while (i < end && /\s/.test(css[i] as string)) i += 1;
      if (i >= end) return;
      if (css[i] === "}") {
        i += 1;
        continue;
      }
      const selStart = i;
      while (i < end && css[i] !== "{" && css[i] !== "}") i += 1;
      if (i >= end || css[i] === "}") return;
      const selector = css.slice(selStart, i).trim();
      i += 1;
      const bodyStart = i;
      let depth = 1;
      while (i < end && depth > 0) {
        const c = css[i];
        if (c === "{") depth += 1;
        else if (c === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        i += 1;
      }
      const body = css.slice(bodyStart, i);
      i += 1;
      if (selector.startsWith("@")) {
        // Conditional group rules and keyframes: descend, the declarations
        // inside are still real rules that real classes match.
        if (/^@(media|supports|layer|container|(-[a-z]+-)?keyframes)\b/.test(selector)) {
          walk(bodyStart, i - 1);
        }
        continue;
      }
      rules.push({
        selectors: selector.split(",").map((s) => s.trim()),
        decls: body
          .split(";")
          .map((d) => d.trim())
          .filter((d) => d.length > 0 && d.includes(":"))
          .map((d) => {
            const colon = d.indexOf(":");
            return { prop: d.slice(0, colon).trim(), value: d.slice(colon + 1).trim() };
          }),
      });
    }
  };
  walk(0, css.length);
  return rules;
}

const UI_DIR = fileURLToPath(new URL(".", import.meta.url));
const sheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const rules = parseStylesheet(sheet);

/** Every class name that appears in any selector, e.g. `.seat.is-me`. */
const styledClasses = (() => {
  const names = new Set<string>();
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      for (const match of selector.matchAll(/\.(-?[_A-Za-z][\w-]*)/g)) names.add(match[1] as string);
    }
  }
  return names;
})();

/* ------------------------------------------------- what the modules emit */

/**
 * Factories in `ui/` whose Nth argument is a class-name string, keyed by the
 * argument index. `el` is the general one from `uiTypes.ts`; `keyBadge` and
 * `meter` are the two other class-taking factories, and they are named here so
 * a new one cannot be added without the contract noticing.
 */
const CLASS_ARGUMENTS: Record<string, number> = { el: 2, keyBadge: 2, meter: 1 };

interface Emitted {
  /** Classes that are fully known statically. */
  literal: Map<string, string[]>;
  /**
   * Prefixes of classes assembled from a template interpolation, e.g. the
   * `slot--` in `` `slot--${kind}` ``. Any styled class starting with the
   * prefix satisfies these — the runtime value is not knowable here.
   */
  pattern: Map<string, string[]>;
}

const CLASS_TOKEN = /^[A-Za-z][\w-]*$/;

/** Splits a class-name expression into the class tokens it can produce. */
function classNamesOf(node: ts.Node | undefined): { literal: string[]; pattern: string[] } {
  const literal: string[] = [];
  const pattern: string[] = [];
  const addTokens = (raw: string, cut: boolean): void => {
    for (const token of raw.split(/\s+/)) {
      if (!CLASS_TOKEN.test(token)) continue;
      if (cut) pattern.push(token);
      else literal.push(token);
    }
  };
  const walk = (n: ts.Node | undefined): void => {
    if (n === undefined) return;
    switch (n.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        addTokens((n as ts.StringLiteralLike).text, false);
        return;
      case ts.SyntaxKind.TemplateExpression: {
        const tpl = n as ts.TemplateExpression;
        // Structurally typed on purpose: `TemplateHead` and `TemplateTail` are
        // distinct nominal types with the same `text`.
        const quasis: { text: string }[] = [tpl.head, ...tpl.templateSpans.map((s) => s.literal)];
        for (let q = 0; q < quasis.length; q += 1) {
          const quasi = quasis[q];
          if (quasi === undefined) continue;
          const parts = quasi.text.split(/\s+/);
          const last = q === quasis.length - 1;
          for (let p = 0; p < parts.length; p += 1) {
            const token = parts[p];
            if (token === undefined || token === "") continue;
            // A token that runs straight into a `${...}` is only a prefix.
            addTokens(token, p === parts.length - 1 && !last);
          }
          if (!last) walk(tpl.templateSpans[q]?.expression);
        }
        return;
      }
      case ts.SyntaxKind.ParenthesizedExpression:
      case ts.SyntaxKind.AsExpression:
      case ts.SyntaxKind.SatisfiesExpression:
      case ts.SyntaxKind.NonNullExpression:
        walk((n as ts.ParenthesizedExpression).expression);
        return;
      case ts.SyntaxKind.PrefixUnaryExpression:
        walk((n as ts.PrefixUnaryExpression).operand);
        return;
      case ts.SyntaxKind.BinaryExpression: {
        const bin = n as ts.BinaryExpression;
        if (bin.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          walk(bin.left);
          walk(bin.right);
        }
        return;
      }
      case ts.SyntaxKind.ConditionalExpression: {
        const cond = n as ts.ConditionalExpression;
        walk(cond.whenTrue);
        walk(cond.whenFalse);
        return;
      }
      default:
    }
  };
  walk(node);
  return { literal, pattern };
}

function collectEmitted(): Emitted {
  const emitted: Emitted = { literal: new Map(), pattern: new Map() };
  const note = (map: Map<string, string[]>, name: string, where: string): void => {
    const list = map.get(name) ?? [];
    if (!list.includes(where)) list.push(where);
    map.set(name, list);
  };
  const take = (node: ts.Node | undefined, where: string): void => {
    const { literal, pattern } = classNamesOf(node);
    for (const name of literal) note(emitted.literal, name, where);
    for (const name of pattern) note(emitted.pattern, name, where);
  };

  for (const file of readdirSync(UI_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);
    const at = (node: ts.Node): string => `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const call = node;
        if (ts.isIdentifier(call.expression)) {
          const arg = CLASS_ARGUMENTS[call.expression.text];
          if (arg !== undefined && call.arguments.length > arg) take(call.arguments[arg], at(call));
        }
        if (
          ts.isPropertyAccessExpression(call.expression) &&
          ts.isPropertyAccessExpression(call.expression.expression) &&
          call.expression.expression.name.text === "classList" &&
          ["add", "toggle", "remove"].includes(call.expression.name.text)
        ) {
          for (const arg of call.arguments) take(arg, at(call));
        }
      }
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "className") {
        take(node.initializer, at(node));
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.name.text === "className"
      ) {
        take(node.right, at(node));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return emitted;
}

const emitted = collectEmitted();

/* ------------------------------------------------------------------ specs */

describe("stylesheet contract", () => {
  it("has a rule for every class the UI modules emit", () => {
    const unstyled: string[] = [];
    for (const [name, where] of emitted.literal) {
      if (!styledClasses.has(name)) unstyled.push(`${name}  (${where.join(", ")})`);
    }
    for (const [prefix, where] of emitted.pattern) {
      const covered = [...styledClasses].some((c) => c.startsWith(prefix) && c !== prefix);
      if (!covered) unstyled.push(`${prefix}<value>  (${where.join(", ")})`);
    }
    expect(unstyled.sort(), "emitted by src/ui/*.ts but matched by no rule in styles.css").toEqual([]);
    // A stylesheet that stopped being parsed would make the test vacuous.
    expect(emitted.literal.size).toBeGreaterThan(100);
    expect(styledClasses.size).toBeGreaterThan(150);
  });

  it("never hands a fixed-track grid more children than it has tracks", () => {
    // Fixed-track grids whose children are not explicitly placed by
    // `grid-template-areas` and do not reflow by `repeat`/`auto-fill`.
    // A class is only interesting if EVERY rule for it leaves the children to
    // auto-placement: one rule carrying `grid-template-areas` (or an explicit
    // `grid-auto-flow`) places the children by hand, overflow included, which
    // is exactly what `.lobby__panes` does for its third pane.
    const areas = new Set<string>();
    for (const rule of rules) {
      if (!rule.decls.some((d) => d.prop === "grid-template-areas" || d.prop === "grid-auto-flow")) continue;
      for (const selector of rule.selectors) {
        for (const match of selector.matchAll(/\.(-?[_A-Za-z][\w-]*)/g)) areas.add(match[1] as string);
      }
    }
    const containers = new Map<string, { tracks: number; spec: string; places: string[] }>();
    for (const rule of rules) {
      const columns = rule.decls.find((d) => d.prop === "grid-template-columns");
      if (columns === undefined) continue;
      if (/(repeat|auto-fill|auto-fit)/.test(columns.value)) continue;
      const tracks = columns.value.trim().split(/\s+(?![^()]*\))/);
      for (const selector of rule.selectors) {
        for (const match of selector.matchAll(/\.(-?[_A-Za-z][\w-]*)/g)) {
          const name = match[1] as string;
          if (areas.has(name)) continue;
          const entry = containers.get(name) ?? { tracks: tracks.length, spec: columns.value, places: [] };
          // A media query may narrow the row; the narrowest one binds.
          entry.tracks = Math.min(entry.tracks, tracks.length);
          if (!entry.places.includes(selector)) entry.places.push(selector);
          containers.set(name, entry);
        }
      }
    }

    // For every `const x = el(doc, tag, "<container class>")`, the number of
    // children the same function appends to `x`. Appends are additive here: the
    // contract is about a row that fills up, which is what every one of these
    // containers is.
    const overflow: string[] = [];
    for (const file of readdirSync(UI_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);
      const at = (node: ts.Node): string => `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;

      const perFunction = (fn: ts.Node): void => {
        const classOf = new Map<string, string>();
        const children = new Map<string, { total: number; where: string[] }>();
        const collect = (node: ts.Node): void => {
          if (
            ts.isVariableDeclaration(node) &&
            node.initializer !== undefined &&
            ts.isCallExpression(node.initializer) &&
            ts.isIdentifier(node.initializer.expression) &&
            node.initializer.expression.text === "el" &&
            node.initializer.arguments.length >= 3 &&
            ts.isStringLiteral(node.initializer.arguments[2])
          ) {
            classOf.set(node.name.getText(sf), (node.initializer.arguments[2] as ts.StringLiteral).text);
          }
          if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "append" &&
            ts.isIdentifier(node.expression.expression)
          ) {
            const variable = node.expression.expression.text;
            if (classOf.has(variable)) {
              const entry = children.get(variable) ?? { total: 0, where: [] };
              entry.total += node.arguments.length;
              entry.where.push(at(node));
              children.set(variable, entry);
            }
          }
          ts.forEachChild(node, collect);
        };
        collect(fn);
        for (const [variable, appended] of children) {
          const cls = classOf.get(variable) as string;
          const container = containers.get(cls);
          if (container === undefined) continue;
          if (appended.total > container.tracks) {
            overflow.push(
              `.${cls} (${container.places.join(", ")}) declares ${container.tracks} track(s) ` +
                `[${container.spec}] but ${variable} gets up to ${appended.total} children ` +
                `(${appended.where.join(", ")}) — the overflow wraps to an implicit row`,
            );
          }
        }
      };

      const visit = (node: ts.Node): void => {
        const hasBody =
          ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isGetAccessorDeclaration(node) ||
          ts.isSetAccessorDeclaration(node);
        if (hasBody) perFunction(node);
        else ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(overflow.sort()).toEqual([]);
  });

  it("keeps the [hidden] rule unbeatable", () => {
    // `hidden` only hides an element while no rule with `!important` on
    // `display` outranks it. The UI toggles `hidden` on 36 sites; a single
    // class rule carrying `display: … !important` would leave every one of
    // them visible.
    const dangerous: string[] = [];
    for (const rule of rules) {
      for (const d of rule.decls) {
        if (d.prop !== "display" || !d.value.includes("!important")) continue;
        if (rule.selectors.every((s) => /\[hidden\]/.test(s))) continue;
        dangerous.push(`${rule.selectors.join(", ")} { ${d.prop}: ${d.value} }`);
      }
    }
    expect(dangerous).toEqual([]);
  });
});
