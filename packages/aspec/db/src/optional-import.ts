/**
 * Imports an optional peer dependency by package name. The specifier is deliberately not a
 * string literal, so TypeScript does not require the package or its type declarations to
 * be installed when this module is compiled (for example when vendored into a project that
 * uses only one database driver). Rejects when the package is not installed.
 */
export function importOptional(name: string): Promise<unknown> {
  return import(name);
}
