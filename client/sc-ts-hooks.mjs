export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      try { return await next(specifier + ".ts", context); } catch { /* fall through */ }
    }
    throw err;
  }
}

// Node's strip-only mode rejects TS parameter properties, and the pre-existing
// heightfield.ts uses one. Rewrite it so the throwaway harness can load the real
// sources unchanged.
function desugar(source) {
  return source.replace(/constructor\(([^)]*)\)\s*\{/, (match, paramList) => {
    const parts = paramList
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const hasModifier = parts.some((p) => /^(readonly|private|public|protected)\b/.test(p));
    if (!hasModifier) return match;
    const names = [];
    const assigns = [];
    for (const part of parts) {
      const beforeColon = part.split(":")[0].trim().split(/\s+/);
      const name = beforeColon[beforeColon.length - 1];
      names.push(name);
      assigns.push(`this.${name} = ${name};`);
    }
    return `constructor(${names.join(", ")}) { ${assigns.join(" ")}`;
  });
}

export async function load(url, context, next) {
  const result = await next(url, context);
  if (!url.endsWith(".ts") || result.format === "commonjs") return result;
  const source = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
  return { ...result, source: desugar(source) };
}
