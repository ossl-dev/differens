import { describe, expect, it } from "bun:test";
import { createNode } from "@ossl/differens-core";
import type { EditAction } from "@ossl/differens-core";
import { formatChanges, narrate, narrateAction, summarize } from "./index";

const TEST_NODE = createNode({
  kind: "Function",
  label: "parseConfig",
  byteRange: [0, 50],
});

describe("narrateAction", () => {
  it("narrates Insert", () => {
    const action: EditAction = {
      type: "Insert",
      context: [],
      node: TEST_NODE,
      parent: createNode({ kind: "file", byteRange: [0, 100] }),
      position: 0,
    };
    expect(narrateAction(action)).toBe("added function `parseConfig`");
  });

  it("narrates Delete", () => {
    const action: EditAction = {
      type: "Delete",
      context: [],
      node: createNode({ kind: "Class", label: "RetryPolicy", byteRange: [0, 30] }),
    };
    expect(narrateAction(action)).toBe("removed class `RetryPolicy`");
  });

  it("narrates Rename update", () => {
    const action: EditAction = {
      type: "Update",
      context: [],
      node: createNode({ kind: "Function", label: "bar", byteRange: [0, 10] }),
      detail: { kind: "Renamed", from: "foo", to: "bar" },
    };
    expect(narrateAction(action)).toBe("renamed function `foo` to `bar`");
  });

  it("narrates ValueChanged update", () => {
    const action: EditAction = {
      type: "Update",
      context: [],
      node: createNode({ kind: "ConfigKey", label: "host", byteRange: [0, 10] }),
      detail: { kind: "ValueChanged", from: "localhost", to: "0.0.0.0" },
    };
    expect(narrateAction(action)).toBe(
      "changed value of config key `host` from `localhost` to `0.0.0.0`",
    );
  });

  it("narrates Move", () => {
    const fromParent = createNode({ kind: "file", label: "utils.ts", byteRange: [0, 10] });
    const toParent = createNode({ kind: "file", label: "config.ts", byteRange: [0, 10] });
    const action: EditAction = {
      type: "Move",
      context: [],
      node: TEST_NODE,
      fromParent,
      toParent,
      fromPosition: 0,
      toPosition: 2,
    };
    expect(narrateAction(action)).toBe("moved function `parseConfig` from utils.ts to config.ts");
  });

  it("includes the containing scope in narration", () => {
    const action: EditAction = {
      type: "Delete",
      context: [
        { kind: "Function", label: "connect" },
        { kind: "Class", label: "Client" },
      ],
      node: createNode({ kind: "Variable", label: "timeout", byteRange: [0, 10] }),
    };
    expect(narrateAction(action)).toBe("removed variable `timeout` from function `connect`");
  });

  it("uses nearest named ancestor for scope", () => {
    const action: EditAction = {
      type: "Update",
      context: [
        { kind: "Block", label: undefined },
        { kind: "Class", label: "RetryPolicy" },
      ],
      node: createNode({ kind: "Function", label: "bar", byteRange: [0, 10] }),
      detail: { kind: "Renamed", from: "foo", to: "bar" },
    };
    expect(narrateAction(action)).toBe("renamed function `foo` to `bar` in class `RetryPolicy`");
  });
});

describe("narrate", () => {
  it("converts actions to SemanticChange array", () => {
    const action: EditAction = {
      type: "Insert",
      context: [],
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
        context: [],
        node: createNode({ kind: "Function", label: "a", byteRange: [0, 1] }),
        parent: createNode({ kind: "file", byteRange: [0, 1] }),
        position: 0,
      },
      {
        type: "Delete",
        context: [],
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
      context: [],
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
      context: [],
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
        context: [],
        node: createNode({ kind: "Function", label: "foo", byteRange: [0, 1] }),
        detail: { kind: "Renamed", from: "foo", to: "bar" },
      },
    ]);
    const output = formatChanges(changes, { format: "markdown", filePath: "src/app.ts" });
    expect(output).toContain("## src/app.ts");
    expect(output).toContain("- renamed");
  });

  it("formats llm output with context chain", () => {
    const changes = narrate(
      [
        {
          type: "Delete",
          context: [
            { kind: "Function", label: "connect" },
            { kind: "Class", label: "Client" },
          ],
          node: createNode({ kind: "Variable", label: "timeout", byteRange: [0, 10] }),
        },
      ],
      { filePath: "src/client.ts" },
    );

    const lines = formatChanges(changes, { format: "llm" }).split("\n");

    expect(lines[0]).toBe("differens/1 1 files 1 changes 1 named");
    expect(lines[1]).toBe("# src/client.ts");
    expect(lines[2]).toBe("- variable timeout < function connect");
  });

  it("rolls unnamed changes up into a count instead of a line each", () => {
    const changes = narrate(
      [
        {
          type: "Insert",
          context: [],
          node: createNode({ kind: "Comment", byteRange: [0, 1] }),
          parent: createNode({ kind: "file", byteRange: [0, 1] }),
          position: 0,
        },
        {
          type: "Insert",
          context: [],
          node: createNode({ kind: "Comment", byteRange: [0, 1] }),
          parent: createNode({ kind: "file", byteRange: [0, 1] }),
          position: 1,
        },
        {
          type: "Insert",
          context: [],
          node: createNode({ kind: "Function", label: "go", byteRange: [0, 1], line: 7 }),
          parent: createNode({ kind: "file", byteRange: [0, 1] }),
          position: 2,
        },
      ],
      { filePath: "a.ts" },
    );

    const lines = formatChanges(changes, { format: "llm" }).split("\n");
    expect(lines[2]).toBe("+ function go :7");
    expect(lines[3]).toBe("* 2 comments");
  });
});
