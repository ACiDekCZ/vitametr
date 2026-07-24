// Allow importing CSS as a side-effecting module; esbuild emits a sibling
// stylesheet, TypeScript only needs the ambient declaration.
declare module '*.css';
