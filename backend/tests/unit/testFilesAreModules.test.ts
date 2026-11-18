/**
 * CI-496 class guard (b3 / 7c): every backend/tests unit test file must be an ES MODULE (a top-level import or
 * export). A file without one compiles, under tsconfig.backend-tests.json, into ONE shared global script scope, so a
 * common top-level name (`call`, `st`, `res`, `mock`) in two such files breaks the typecheck in a file whose author
 * changed nothing (TS2451). This is a TYPECHECK-time hazard only: jest gives each file its own module registry at
 * runtime, which is why `export {};` cannot change behaviour.
 * After b91900cc7 the class is EMPTY BY CONSTRUCTION, so this guard is purely preventive - hence (7c) a non-empty
 * scan assertion (a moved path / changed glob must fail, not pass vacuously) and a positive control on a real
 * script-style source.
 * COMMENTS DO NOT COUNT (7c): comments are stripped before the test, matching TypeScript's own definition of module-ness
 * (the PARSED source) - a commented-out block of imports must not make a script look like a module.
 * KNOWN LIMIT: a line starting `import ` / `export ` inside a multi-line TEMPLATE LITERAL would still false-match (rare;
 * not worth a parser). Two LOUD limits (they only false-RED a genuine module, never pass a script): an INDENTED top-level
 * import (the regex requires column 0), and a `/*` inside a string literal that starts a bogus comment strip.
 */
export {};
import fs from 'fs';
import path from 'path';

const UNIT_DIR = path.resolve(__dirname);

/** Remove block comments and whole-line `//` comments (line-start detection only needs these). */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** A file is a module iff, with comments stripped, some line STARTS with `import ` or `export `. */
export function isModuleSource(src: string): boolean {
  return /^(?:import|export)\s/m.test(stripComments(src));
}

describe('backend/tests/unit test files are ES modules (CI-496 class)', () => {
  const files = fs.readdirSync(UNIT_DIR).filter((f) => /\.test\.tsx?$/.test(f));

  it('the scan is non-vacuous: the unit test directory really holds hundreds of test files', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('EVERY unit test file has a top-level import or export (no shared global script scope)', () => {
    const scripts = files.filter((f) => !isModuleSource(fs.readFileSync(path.join(UNIT_DIR, f), 'utf8')));
    expect(scripts).toEqual([]);
  });

  it('POSITIVE CONTROL: a require-only test source is detected as a script; comments do not make it a module', () => {
    expect(isModuleSource("const x = require('y');\nit('a', () => {});")).toBe(false);
    expect(isModuleSource("// import fs from 'fs'\n/* export {} */\nconst call = 1;")).toBe(false);
    expect(isModuleSource("/** header */\nexport {};\nconst call = 1;")).toBe(true);
    expect(isModuleSource("import fs from 'fs';")).toBe(true);
  });

  it('(7c) a MULTI-LINE block comment holding import lines does NOT make a script a module', () => {
    const commentedImports = "/*\nimport { a } from './a';\nexport const b = 1;\n*/\nconst call = 1;\nit('x', () => {});";
    expect(isModuleSource(commentedImports)).toBe(false);
    expect(isModuleSource(commentedImports + "\nexport {};")).toBe(true);   // a real marker after it still counts
  });
});
