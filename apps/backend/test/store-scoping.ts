import { readdirSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import ts from 'typescript';

// The person-scoped store rule, checked two ways (docs/threat-model.md: "store calls scoped to
// the person"; docs/architecture.md: composite keys).
//
// In the code: every use of a per-person table (by any name an import gives it, or by its SQL
// name in a string) sits inside a function, at some level, that takes a PersonId: a parameter
// typed exactly as person.ts's PersonId, neither optional nor defaulted. Per-person tables are
// the ones schema.ts lists in PERSON_TABLES.

export type ScopingInput = {
  /** The store's source files to check. */
  files: readonly string[];
  /** The file whose PERSON_TABLES array names the per-person tables. */
  schemaFile: string;
  /** The file that declares the PersonId type. */
  personFile: string;
  /** The per-person tables' SQL names, to find them in raw SQL. */
  sqlNames: readonly string[];
};

/** Every .ts file under `folder`, at any depth, except tests. */
export function sourcesUnder(folder: string): string[] {
  return readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => path.join(folder, file))
    .sort();
}

export function scopingViolations(input: ScopingInput): string[] {
  // Only the files given: names resolve between them, and nothing else is loaded (Drizzle's and
  // Node's types would take seconds, and say nothing about which table a name is).
  const program = ts.createProgram([...input.files, input.schemaFile, input.personFile], {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    noEmit: true,
    noResolve: true,
    noLib: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const resolve = (symbol: ts.Symbol | undefined): ts.Symbol | undefined =>
    symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;

  const personTables = new Set<ts.Symbol>();
  let personId: ts.Symbol | undefined;
  for (const [file, visit] of [
    [
      input.schemaFile,
      (node: ts.Node) => {
        if (
          ts.isVariableDeclaration(node) &&
          node.name.getText() === 'PERSON_TABLES' &&
          node.initializer !== undefined
        ) {
          const array = unwrap(node.initializer);
          if (ts.isArrayLiteralExpression(array)) {
            for (const element of array.elements) {
              const symbol = resolve(checker.getSymbolAtLocation(element));
              if (symbol !== undefined) personTables.add(symbol);
            }
          }
        }
      },
    ],
    [
      input.personFile,
      (node: ts.Node) => {
        if (ts.isTypeAliasDeclaration(node) && node.name.text === 'PersonId') {
          personId = checker.getSymbolAtLocation(node.name);
        }
      },
    ],
  ] as const) {
    const source = program.getSourceFile(file);
    if (source === undefined) throw new Error(`scopingViolations: can't read ${file}`);
    walk(source, visit);
  }
  if (personId === undefined) throw new Error('scopingViolations: no PersonId type found');

  const takesPersonId = (fn: ts.SignatureDeclaration): boolean =>
    fn.parameters.some(
      (p) =>
        p.questionToken === undefined &&
        p.initializer === undefined &&
        p.type !== undefined &&
        ts.isTypeReferenceNode(p.type) &&
        resolve(checker.getSymbolAtLocation(p.type.typeName)) === personId,
    );
  const sqlName =
    input.sqlNames.length === 0 ? undefined : new RegExp(`\\b(${input.sqlNames.join('|')})\\b`);

  // A Set, so a line naming a table twice (export { t as u }) is reported once.
  const violations = new Set<string>();
  for (const file of input.files) {
    if (path.resolve(file) === path.resolve(input.schemaFile)) continue;
    const source = program.getSourceFile(file);
    if (source === undefined) throw new Error(`scopingViolations: can't read ${file}`);
    walk(source, (node) => {
      const table = tableAt(node);
      if (table === undefined) return;
      const functions = enclosingFunctions(node);
      if (functions.some(takesPersonId)) return;
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      const where = functions.length === 0 ? 'outside any function' : 'in a function';
      violations.add(
        `${path.basename(file)}:${String(line + 1)}: ${table} is used ${where} that takes no PersonId`,
      );
    });
  }
  return [...violations];

  /** The per-person table a node names, if any. */
  function tableAt(node: ts.Node): string | undefined {
    if (ts.isIdentifier(node)) {
      if (isTypeOnly(node) || isImport(node)) return undefined;
      const symbol = resolve(checker.getSymbolAtLocation(node));
      return symbol !== undefined && personTables.has(symbol) ? symbol.name : undefined;
    }
    if (
      sqlName !== undefined &&
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateLiteralToken(node))
    ) {
      return sqlName.exec(node.text)?.[1];
    }
    return undefined;
  }
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => {
    walk(child, visit);
  });
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Typed as always there, but a source file has no parent. */
function parentOf(node: ts.Node): ts.Node | undefined {
  const { parent }: { parent?: ts.Node } = node;
  return parent;
}

function enclosingFunctions(node: ts.Node): ts.SignatureDeclaration[] {
  const functions: ts.SignatureDeclaration[] = [];
  for (let current = parentOf(node); current !== undefined; current = parentOf(current)) {
    if (ts.isFunctionLike(current)) functions.push(current);
  }
  return functions;
}

/** A name in a type (typeof userNote.$inferSelect) reads no rows. */
function isTypeOnly(node: ts.Node): boolean {
  for (let current = parentOf(node); current !== undefined; current = parentOf(current)) {
    if (ts.isTypeNode(current) && !ts.isExpressionWithTypeArguments(current)) return true;
    if (ts.isStatement(current)) return false;
  }
  return false;
}

/** Importing a table is fine; using it is what's checked. */
function isImport(node: ts.Node): boolean {
  return ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent);
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
