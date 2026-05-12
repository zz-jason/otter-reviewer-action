"use strict";

const assert = require("assert");
const {
  filterCodexReview,
  parseAllowedLines,
  parseJsonArrayText,
  replacePlaceholders,
  safeAgentEnv,
  validateReviewSchema,
} = require("../bin/otter-reviewer");

const diff = `diff --git a/src/server.js b/src/server.js
index 1111111..2222222 100644
--- a/src/server.js
+++ b/src/server.js
@@ -1,2 +1,4 @@
 const a = 1;
+const b = req.query.cmd;
 const c = 3;
+execSync(b);
`;

const allowed = parseAllowedLines(diff);
assert.deepStrictEqual([...allowed.get("src/server.js")].sort((a, b) => a - b), [1, 2, 3, 4]);

const review = filterCodexReview(
  diff,
  {
    summary: "sample",
    comments: [
      { path: "src/server.js", line: 4, body: "valid", severity: "high" },
      { path: "src/server.js", line: 99, body: "invalid" },
      { path: "missing.js", line: 1, body: "invalid" },
    ],
  },
  10
);

assert.strictEqual(review.comments.length, 1);
assert.strictEqual(review.comments[0].path, "src/server.js");
assert.strictEqual(review.comments[0].line, 4);
assert.match(review.comments[0].body, /^\*\*high\*\*: valid/);
assert.match(review.summary, /Filtered out 2/);

assert.deepStrictEqual(parseJsonArrayText("[]", "TEST_ARGS"), []);
assert.deepStrictEqual(parseJsonArrayText('["review","--schema","{schemaPath}"]', "TEST_ARGS"), [
  "review",
  "--schema",
  "{schemaPath}",
]);
assert.throws(() => parseJsonArrayText('{"bad":true}', "TEST_ARGS"), /TEST_ARGS must be a JSON array/);

assert.strictEqual(
  replacePlaceholders("--schema={schemaPath}", { schemaPath: "/tmp/schema.json" }),
  "--schema=/tmp/schema.json"
);

process.env.PATH = process.env.PATH || "/usr/bin";
process.env.OTTER_REVIEWER_PRIVATE_KEY = "should-not-pass";
process.env.MY_AGENT_TOKEN = "allowed";
const childEnv = safeAgentEnv(["MY_AGENT_TOKEN"]);
assert.strictEqual(childEnv.MY_AGENT_TOKEN, "allowed");
assert.strictEqual(childEnv.OTTER_REVIEWER_PRIVATE_KEY, undefined);

assert.deepStrictEqual(validateReviewSchema({ summary: "ok", comments: [] }), { summary: "ok", comments: [] });
assert.throws(
  () => validateReviewSchema({ summary: "ok", comments: [{ path: "a.js", line: 1, body: "ok", extra: true }] }),
  /unsupported field/
);

console.log("filter.test.js passed");
