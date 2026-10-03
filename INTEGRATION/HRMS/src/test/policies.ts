/**
 * The RLS policies a table is left with, read from the migrations that ship.
 *
 * jsdom has no database, so a test cannot ask Postgres who may read a row. It
 * can read every CREATE POLICY and DROP POLICY in the migrations, in the order
 * they run, and say which policies a table ends up with -- the same idea as
 * printRules, which reads the real stylesheet rather than a copy of it.
 *
 * Written-out statements only. A policy created inside a DO block through
 * EXECUTE format(...) is invisible here, so use this for policies a migration
 * spells out in full. Takes the SQL as text, so it has no Node dependency.
 */

export interface Migration {
  name: string
  sql: string
}

export interface Policy {
  name: string
  /** select | insert | update | delete | all */
  command: string
  /** Everything after the table name, comments removed: FOR, TO, USING, WITH CHECK. */
  definition: string
}

const unquote = (identifier: string) => identifier.replace(/"/g, '')

/** The policies on `table` once every migration has run, by name. */
export function policiesOn(table: string, migrations: Migration[]): Map<string, Policy> {
  const policies = new Map<string, Policy>()
  const ordered = [...migrations].sort((a, b) => a.name.localeCompare(b.name))
  for (const { sql } of ordered) {
    const code = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
    const statements = /\b(create|drop)\s+policy\s+(?:if\s+exists\s+)?("[^"]+"|\w+)\s+on\s+(?:public\.)?("[^"]+"|\w+)([^;]*);/gi
    for (const [, verb, name, on, rest] of code.matchAll(statements)) {
      if (unquote(on) !== table) continue
      if (verb.toLowerCase() === 'drop') {
        policies.delete(unquote(name))
        continue
      }
      const command = /\bfor\s+(select|insert|update|delete|all)\b/i.exec(rest)?.[1].toLowerCase() ?? 'all'
      policies.set(unquote(name), { name: unquote(name), command, definition: rest.trim() })
    }
  }
  return policies
}
