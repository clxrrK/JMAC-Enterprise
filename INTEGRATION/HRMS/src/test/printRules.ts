/**
 * The print stylesheet as rules a test can apply to a DOM.
 *
 * jsdom does no layout, so it cannot say whether a page prints blank. It can
 * say which elements a print rule SELECTS -- and that is where both blank-print
 * bugs lived: a hiding rule that matched every element of the contract, and a
 * receipt lifted into a dialog box that clipped it. These helpers read the
 * real rules out of index.css so tests check the stylesheet that ships, not a
 * copy of it.
 *
 * Takes the CSS as text rather than reading a file, so it has no Node
 * dependency of its own.
 */

export interface PrintRule {
  selectors: string[]
  declarations: Record<string, string>
}

/** Split a selector list on commas that are not inside parentheses. */
function splitSelectorList(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) out.push(current.trim())
  return out
}

/** Every `@media print { ... }` block's contents, comments removed. */
function printBlocks(css: string): string[] {
  const blocks: string[] = []
  let from = 0
  for (;;) {
    const at = css.indexOf('@media print', from)
    if (at === -1) break
    const open = css.indexOf('{', at)
    let depth = 0
    let close = open
    for (; close < css.length; close++) {
      if (css[close] === '{') depth++
      if (css[close] === '}' && --depth === 0) break
    }
    blocks.push(css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, ''))
    from = close + 1
  }
  return blocks
}

/** The style rules inside the print blocks. `@page` rules are left out --
 *  see pageRule. */
export function printRules(css: string): PrintRule[] {
  const rules: PrintRule[] = []
  for (const block of printBlocks(css)) {
    for (const match of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectorText = match[1].trim()
      if (selectorText.startsWith('@')) continue
      const declarations: Record<string, string> = {}
      for (const declaration of match[2].split(';')) {
        const colon = declaration.indexOf(':')
        if (colon < 1) continue
        declarations[declaration.slice(0, colon).trim()] = declaration
          .slice(colon + 1)
          .replace('!important', '')
          .trim()
      }
      rules.push({ selectors: splitSelectorList(selectorText), declarations })
    }
  }
  return rules
}

/** The declarations of `@page <name>` (or the default `@page` for no name). */
export function pageRule(css: string, name = ''): Record<string, string> | null {
  for (const block of printBlocks(css)) {
    const header = name ? `@page ${name}` : '@page'
    for (const match of block.matchAll(/@page([^{]*)\{([^{}]*)\}/g)) {
      if (`@page${match[1]}`.trim() !== header) continue
      const declarations: Record<string, string> = {}
      for (const declaration of match[2].split(';')) {
        const colon = declaration.indexOf(':')
        if (colon > 0) declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim()
      }
      return declarations
    }
  }
  return null
}

/** The rules whose selector list matches this element. */
export function rulesFor(rules: PrintRule[], element: Element): PrintRule[] {
  return rules.filter((rule) => rule.selectors.some((selector) => element.matches(selector)))
}

/** Removed from print layout: the element or any ancestor gets display: none.
 *  An ancestor counts because nothing inside a display: none box is drawn,
 *  whatever the descendant itself says. */
export function removedInPrint(rules: PrintRule[], element: Element): boolean {
  for (let el: Element | null = element; el; el = el.parentElement) {
    if (rulesFor(rules, el).some((rule) => rule.declarations.display === 'none')) return true
  }
  return false
}

/** Made invisible by a print rule that selects the element itself. */
export function hiddenInPrint(rules: PrintRule[], element: Element): boolean {
  return rulesFor(rules, element).some((rule) => rule.declarations.visibility === 'hidden')
}
