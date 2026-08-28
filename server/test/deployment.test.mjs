/** Deployment persistence contract regressions. @author coolonion */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../..", import.meta.url));

async function text(path) {
  return readFile(`${root}/${path}`, "utf8");
}

test("Docker and NAS docs persist canonical agent skills directory", async () => {
  const [dockerfile, compose, docs, server] = await Promise.all([
    text("Dockerfile"),
    text("docker-compose.yml"),
    text("docs/nas-deployment.md"),
    text("server/src/index.ts"),
  ]);
  assert.match(dockerfile, /VOLUME \/root\/\.pi/);
  assert.match(compose, /pii-pi-state:\/root\/\.pi/);
  assert.match(docs, /\/root\/\.pi\/agent\/skills/);
  assert.match(server, /join\(getAgentDir\(\), "skills", body\.name\)/);
});
