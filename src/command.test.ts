import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommand } from "./command.js";

describe("parseCommand", () => {
  it("parses /roastmypr", () => {
    assert.equal(parseCommand("/roastmypr")?.kind, "roast");
  });

  it("only looks at the first line", () => {
    assert.equal(parseCommand("/roastmypr\nmore text")?.kind, "roast");
    assert.equal(parseCommand("hey\n/roastmypr"), null);
  });

  it("rejects non-commands and old aliases", () => {
    assert.equal(parseCommand("please roast this"), null);
    assert.equal(parseCommand("/roastmyprplease"), null);
    assert.equal(parseCommand("/roast"), null);
    assert.equal(parseCommand("/roast my pr"), null);
    assert.equal(parseCommand("/roastmypr help"), null);
  });
});
