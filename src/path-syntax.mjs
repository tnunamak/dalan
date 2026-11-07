// Which repository path text the bridge reads as one path. Used by the submission scanner (src/submission-policy.mjs).
//
// A segment is plain characters [A-Za-z0-9_.@-], or router groups followed by plain characters. Router groups are whole bracket or
// parenthesis forms only: `[id]`, `[...slug]`, `[[...slug]]`, `[[lang]]`, `[slug=matcher]`, `(group)`, and the interception markers
// `(.)`, `(..)`, `(...)`. `@slot` is plain. A segment after a `/` may start with `+` (SvelteKit `+page.svelte`); the first segment
// may not, because a diff line starts with `+` and `+README.md` must still read as `README.md`. Spaces, `$`, backticks, quotes,
// `;|&<>`, `~`, `*`, `?`, backslash and control characters are never path characters. `[..]` is no group.
export const plainChar = '[A-Za-z0-9_.@-]';
const group = '\\[\\[(?:\\.\\.\\.)?[A-Za-z0-9_-]+\\]\\]|\\[(?:\\.\\.\\.)?[A-Za-z0-9_=-]+\\]|\\((?:[A-Za-z0-9_-]+|\\.{1,3})\\)';
export const firstSegment = `(?:(?:${group})+${plainChar}*|${plainChar}+)`;
export const laterSegment = `(?:(?:${group})+${plainChar}*|\\+?${plainChar}+)`;
const wholePath = new RegExp(`^${laterSegment}(?:\\/${laterSegment})*$`);
// True when `file` is a repository-relative path made only of the segments above, with no `.` or `..` segment.
export const readablePath = file => typeof file === 'string' && wholePath.test(file) && !file.split('/').some(part => part === '.' || part === '..');
// Router syntax present: a bracket or parenthesis anywhere in the path.
export const hasRouterSyntax = file => /[[\]()]/.test(file);
