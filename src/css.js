import postcss from 'postcss';
import valueParser from 'postcss-value-parser';

function shouldIgnoreUrl(value) {
  const trimmed = value.trim();
  return (
    trimmed === '' ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:')
  );
}

function rewriteValue(value, reference, relation = 'asset') {
  const parsed = valueParser(value);

  parsed.walk((node) => {
    if (node.type !== 'function') return;
    const name = node.value.toLowerCase();

    if (name === 'url') {
      const raw = valueParser.stringify(node.nodes).trim();
      const unquoted = raw.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2');
      if (shouldIgnoreUrl(unquoted)) return false;
      const rewritten = reference(unquoted, relation);
      node.nodes = [{ type: 'string', quote: '"', value: rewritten, sourceIndex: 0 }];
      return false;
    }

    if (name === 'image-set' || name === '-webkit-image-set') {
      for (const child of node.nodes) {
        if (child.type === 'string' && !shouldIgnoreUrl(child.value)) {
          child.value = reference(child.value, 'asset');
        }
      }
    }
  });

  return parsed.toString();
}

export function transformCss(css, { reference, warn = () => {} }) {
  let root;
  try {
    root = postcss.parse(css, { from: undefined });
  } catch (error) {
    warn(`Could not parse CSS: ${error.message}`);
    return css;
  }

  root.walkDecls((declaration) => {
    declaration.value = rewriteValue(declaration.value, reference, 'asset');
  });

  root.walkAtRules('import', (rule) => {
    const parsed = valueParser(rule.params);
    const first = parsed.nodes.find((node) => node.type !== 'space' && node.type !== 'comment');
    if (first?.type === 'string' && !shouldIgnoreUrl(first.value)) {
      first.value = reference(first.value, 'stylesheet');
      rule.params = parsed.toString();
      return;
    }
    rule.params = rewriteValue(rule.params, reference, 'stylesheet');
  });

  return root.toString();
}

export function transformStyleAttribute(style, { reference, warn = () => {} }) {
  try {
    const root = postcss.parse(`x{${style}}`, { from: undefined });
    root.walkDecls((declaration) => {
      declaration.value = rewriteValue(declaration.value, reference, 'asset');
    });
    const serialized = root.toString();
    return serialized.startsWith('x{') && serialized.endsWith('}')
      ? serialized.slice(2, -1)
      : style;
  } catch (error) {
    warn(`Could not parse an inline style: ${error.message}`);
    return style;
  }
}
