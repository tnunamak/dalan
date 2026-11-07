// Links the CLI prints point at the docs of the release that printed them, so an installed version never sends a reader
// to newer text. The tag v<version> is pushed when the version is published.
import fs from 'node:fs';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const DOCS_BASE = `https://github.com/tnunamak/dalan/blob/v${version}`;

// file: a repository path such as README.md or docs/manual-setup.md. anchor: the heading id, without '#'.
export const docsUrl = (file, anchor = null) => `${DOCS_BASE}/${file}${anchor ? `#${anchor}` : ''}`;
