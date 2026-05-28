// Shim para o Render: o Start Command no painel do Render está fixado em
// `node index.js`, mas o entry point real é TypeScript (`src/index.ts`),
// compilado para `dist/index.js`. Este arquivo apenas delega.
//
// O build do `dist/` é garantido pelo script `postinstall` em package.json,
// que roda durante o `npm install` do deploy. Se `dist/index.js` não existe,
// chamamos build aqui mesmo (defesa em profundidade).

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const distEntry = path.join(__dirname, "dist", "index.js");

if (!fs.existsSync(distEntry)) {
  console.warn("[shim] dist/index.js não existe — rodando build...");
  execSync("npm run build", { stdio: "inherit", cwd: __dirname });
}

require(distEntry);
