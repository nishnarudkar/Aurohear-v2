/**
 * A minimal SVG node tree. The audiogram is built as data first (tests inspect the tree
 * directly — no DOM or XML parser needed) and serialised once.
 */

export interface SvgNode {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string | number>>;
  readonly children: readonly (SvgNode | string)[];
}

export function h(tag: string, attrs: Record<string, string | number | undefined> = {}, ...children: (SvgNode | string | null | false)[]): SvgNode {
  const clean: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) clean[k] = v;
  return { tag, attrs: clean, children: children.filter((c): c is SvgNode | string => c !== null && c !== false) };
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const num = (v: string | number): string => (typeof v === 'number' ? String(Math.round(v * 100) / 100) : esc(v));

export function serialize(node: SvgNode | string): string {
  if (typeof node === 'string') return esc(node);
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${num(v)}"`)
    .join('');
  if (node.children.length === 0) return `<${node.tag}${attrs}/>`;
  return `<${node.tag}${attrs}>${node.children.map(serialize).join('')}</${node.tag}>`;
}

/** Depth-first search for nodes matching a predicate (used by tests and the exporter). */
export function findAll(node: SvgNode, pred: (n: SvgNode) => boolean): SvgNode[] {
  const out: SvgNode[] = [];
  const walk = (n: SvgNode): void => {
    if (pred(n)) out.push(n);
    for (const c of n.children) if (typeof c !== 'string') walk(c);
  };
  walk(node);
  return out;
}
