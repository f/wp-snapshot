import { init, parse } from 'es-module-lexer';

function isUrlSpecifier(value) {
  return /^(?:\.{0,2}\/|https?:\/\/|\/\/)/i.test(value);
}

export async function transformJavaScript(source, { reference, warn = () => {} }) {
  let imports;
  try {
    await init;
    [imports] = parse(source);
  } catch (error) {
    warn(`Could not parse JavaScript module imports: ${error.message}`);
    return source;
  }

  const replacements = [];
  for (const item of imports) {
    if (typeof item.n !== 'string' || !isUrlSpecifier(item.n)) continue;
    const rewritten = reference(item.n, 'asset');
    const originalSlice = source.slice(item.s, item.e);
    const dynamicString = item.d >= 0 && /^['"`]/.test(originalSlice);
    const staticQuote = item.d < 0
      && /['"]/.test(source[item.s - 1] ?? '')
      && source[item.s - 1] === source[item.e];
    replacements.push({
      start: staticQuote ? item.s - 1 : item.s,
      end: staticQuote ? item.e + 1 : item.e,
      value: dynamicString || staticQuote ? JSON.stringify(rewritten) : rewritten,
    });
  }

  let result = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}
