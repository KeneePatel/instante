import { getTableColumns, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import ts from 'typescript';

// The person-scoped store rule, checked two ways (docs/threat-model.md: "store calls scoped to
// the person"; docs/architecture.md: composite keys).

/** The schema's per-person tables: those with a user_id column. */
export function personTables(schema: Record<string, unknown>): string[] {
  return Object.entries(schema)
    .filter(([, value]) => is(value, PgTable))
    .filter(([, table]) =>
      Object.values(getTableColumns(table as PgTable)).some((column) => column.name === 'user_id'),
    )
    .map(([name]) => name);
}

/** Every top-level function in these sources that names a per-person table must take a
 * parameter whose type mentions PersonId. */
export function scopingViolations(
  files: readonly { file: string; text: string }[],
  tables: readonly string[],
): string[] {
  const violations: string[] = [];
  for (const { file, text } of files) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const check = (name: string, fn: ts.SignatureDeclaration, body: ts.Node | undefined) => {
      if (body === undefined) return;
      const used = new Set<string>();
      const walk = (node: ts.Node) => {
        if (ts.isIdentifier(node) && tables.includes(node.text)) used.add(node.text);
        ts.forEachChild(node, walk);
      };
      walk(body);
      if (used.size === 0) return;
      const scoped = fn.parameters.some((p) => p.type?.getText(source).includes('PersonId'));
      if (!scoped) {
        violations.push(`${file}: ${name} touches ${[...used].join(', ')} without a PersonId`);
      }
    };
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement)) {
        check(statement.name?.text ?? '(anonymous)', statement, statement.body);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const value = declaration.initializer;
          if (
            value !== undefined &&
            (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
          ) {
            check(declaration.name.getText(source), value, value.body);
          }
        }
      }
    }
  }
  return violations;
}

/** In the database: each table with a user_id holds it NOT NULL, first in its primary key. */
export async function personTableProblems(client: pg.ClientBase): Promise<string[]> {
  const { rows } = await client.query<{ table: string; nullable: string; first: string | null }>(
    `SELECT c.table_name AS table, c.is_nullable AS nullable,
            (SELECT a.attname FROM pg_index i
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
              WHERE i.indrelid = format('public.%I', c.table_name)::regclass AND i.indisprimary)
              AS first
       FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.column_name = 'user_id'
      ORDER BY c.table_name`,
  );
  return rows.flatMap((row) => [
    ...(row.nullable === 'YES' ? [`${row.table}.user_id may be null`] : []),
    ...(row.first === 'user_id' ? [] : [`${row.table}'s primary key doesn't start with user_id`]),
  ]);
}
