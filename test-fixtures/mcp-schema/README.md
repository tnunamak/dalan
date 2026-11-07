These are copies of the Model Context Protocol JSON Schema files, used by `scripts/mcp-schema-conformance-test.mjs` to check the server's wire shapes against each protocol revision it speaks.

All five files come from https://github.com/modelcontextprotocol/modelcontextprotocol at commit d0e246ea3c69eafaa2806bc4cd28025703ba2c2b, at `schema/<revision>/schema.json`:

- `2026-07-28/schema.json` (JSON Schema draft 2020-12)
- `2025-11-25/schema.json` (draft 2020-12)
- `2025-06-18/schema.json` (draft-07)
- `2025-03-26/schema.json` (draft-07)
- `2024-11-05/schema.json` (draft-07)

Do not edit them by hand. To add or update a revision, copy the file from the same upstream path and update the commit above. `scripts/mcp-schema-conformance-test.mjs` fails if a file is missing or does not parse.
