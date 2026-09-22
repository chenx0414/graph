/**
 * Ambient declaration for plain CSS imports.
 *
 * Both `tsconfig.json` (which type-checks `src/**\/*.ts`) and
 * `tsconfig.web.json` compile modules such as `preferences.ts` that import a
 * stylesheet. `vite/client` declares the same wildcard module, so this only
 * keeps the Node-side type-check happy without pulling the Vite globals in.
 */
declare module '*.css';
