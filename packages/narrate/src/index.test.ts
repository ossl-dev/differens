import { describe, expect, it } from "bun:test";
import { createNode } from "@differens/core";
import type { EditAction } from "@differens/core";
import {
  formatChanges,
  narrate,
  narrateAction,
  summarize,
} from "./index";

const TEST_NODE = createNode({
  kind: "Function",
  label: "parseConfig",
  byteRange: [0, 50],
});

describe("narrateAction", () => {
  it("narrates Insert", () => {
    const action: EditAction = {
      type: "Insert",
      node: TEST_NODE,
      parent: createNode({ kind: "file", byteRange: [0, 100] }),
      position: 0,
    };
    expect(narrateAction(action)).toBe("added function `parseConfig`");
  });

  it("narrates Delete", () => {
    const action: EditAction = {
      type: "Delete",
      node: createNode({ kind: "Class", label: "RetryPolicy", byteRange: [0, 30] }),
    };
    expect(narrateAction(action)).toBe("removed class `RetryPolicy`");
  });

  it("narrates Rename update", () => {
    const action: EditAction = {
      type: "Update",
      node: createNode({ kind: "Function", label: "bar", byteRange: [0, 10] }),
      detail: { kind: "Renamed", from: "foo", to: "bar" },
    };
    expect(narrateAction(action)).toBe("renamed function `foo` to `bar`");
  });

  it("narrates ValueChanged update", () => {
    const action: EditAction = {
      type: "Update",
      node: createNode({ kind: "ConfigKey", label: "host", byteRange: [0, 10] }),
      detail: { kind: "ValueChanged", from: "localhost", to: "0.0.0.0" },
    };
    expect(narrateAction(action))
      .toBe("changed config key `host` from `localhost` to `0.0.0.0`");
  });

  it("narrates Move", () => {
    const fromParent = createNode({ kind: "file", label: "utils.ts", byteRange: [0, 10] });
    const toParent = createNode({ kind: "file", label: "config.ts", byteRange: [0, 10] });
    const action: EditAction = {
      type: "Move",
      node: TEST_NODE,
      fromParent,
      toParent,
      fromPosition: 0,
      toPosition: 2,
    };
    expect(narrateAction(action))
      .toBe("moved function `parseConfig` from utils.ts to config.ts");
  });
});

describe("narrate", () => {
  it("converts actions to SemanticChange array", () => {
    const action: EditAction = {
      type: "Insert",
      node: TEST_NODE,
      parent: createNode({ kind: "file", byteRange: [0, 10] }),
      position: 0,
    };
    const changes = narrate([action]);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.description).toBe("added function `parseConfig`");
    expect(changes[0]!.action).toBe(action);
  });
});

describe("summarize", () => {
  it("returns empty message for no changes", () => {
    expect(summarize([])).toBe("no logical changes");
  });

  it("counts change types", () => {
    const changes = narrate([
      {
        type: "Insert",
        node: createNode({ kind: "Function", label: "a", byteRange: [0, 1] }),
        parent: createNode({ kind: "file", byteRange: [0, 1] }),
        position: 0,
      },
      {
        type: "Delete",
        node: createNode({ kind: "Function", label: "b", byteRange: [0, 1] }),
      },
    ]);
    const summary = summarize(changes);
    expect(summary).toContain("1 addition");
    expect(summary).toContain("1 deletion");
  });
});

describe("formatChanges", () => {
  it("formats terminal output", () => {
    const action: EditAction = {
      type: "Insert",
      node: TEST_NODE,
      parent: createNode({ kind: "file", byteRange: [0, 10] }),
      position: 0,
    };
    const changes = narrate([action]);
    const output = formatChanges(changes, { format: "terminal" });
    expect(output).toContain("+");
    expect(output).toContain("added");
  });

  it("formats JSON output", () => {
    const action: EditAction = {
      type: "Delete",
      node: createNode({ kind: "Class", label: "Old", byteRange: [0, 5] }),
    };
    const changes = narrate([action]);
    const output = formatChanges(changes, { format: "json" });
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].description).toBe("removed class `Old`");
  });

  it("formats markdown output", () => {
    const changes = narrate([
      {
        type: "Update",
        node: createNode({ kind: "Function", label: "foo", byteRange: [0, 1] }),
        detail: { kind: "Renamed", from: "foo", to: "bar" },
      },
    ]);
    const output = formatChanges(changes, { format: "markdown", filePath: "src/app.ts" });
    expect(output).toContain("## src/app.ts");
    expect(output).toContain("- renamed");
  });
});
