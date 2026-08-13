import { describe, expect, it } from "bun:test";
import { createNode } from "@ossl-dev/differens-core";
import type { EditAction, SemanticChange } from "@ossl-dev/differens-core";
import { formatChanges, humanizeKind, narrate, narrateAction, summarize } from "./index";

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

describe("humanizeKind", () => {
  it("splits camelCase and snake_case into words", () => {
    expect(humanizeKind("CallExpression")).toBe("call expression");
    expect(humanizeKind("binary_expression")).toBe("binary expression");
    expect(humanizeKind("function")).toBe("function");
  });
});

describe("narrateAction: value change variants", () => {
  it("narrates a value removal as removed", () => {
    const action: EditAction = {
      type: "Update",
      context: [],
      node: createNode({ kind: "leaf", label: "port", byteRange: [0, 1] }),
      detail: { kind: "ValueChanged", from: "3000" },
    };
    expect(narrateAction(action)).toBe("removed value of leaf `port`");
  });

  it("narrates a value set as set", () => {
    const action: EditAction = {
      type: "Update",
      context: [],
      node: createNode({ kind: "leaf", label: "port", byteRange: [0, 1] }),
      detail: { kind: "ValueChanged", to: "8080" },
    };
    expect(narrateAction(action)).toBe("set value of leaf `port` to `8080`");
  });

  it("truncates long values in the preview", () => {
    const long = "x".repeat(100);
    const action: EditAction = {
      type: "Update",
      context: [],
      node: createNode({ kind: "leaf", label: "port", byteRange: [0, 1] }),
      detail: { kind: "ValueChanged", from: long, to: long },
    };
    const out = narrateAction(action);
    expect(out).toContain("…");
    expect(out).not.toContain("x".repeat(50));
  });

  it("narrates a Move without parent labels as a position move", () => {
    const action: EditAction = {
      type: "Move",
      context: [],
      node: createNode({ kind: "Function", label: "go", byteRange: [0, 1] }),
      fromParent: createNode({ kind: "file", byteRange: [0, 1] }),
      toParent: createNode({ kind: "file", byteRange: [0, 1] }),
      fromPosition: 0,
      toPosition: 2,
    };
    expect(narrateAction(action)).toBe("moved function `go` to position 3");
  });

  it("uses the source glimpse for an anonymous node", () => {
    const action: EditAction = {
      type: "Insert",
      context: [],
      node: createNode({ kind: "CallExpression", value: "run\n  (x)", byteRange: [0, 1] }),
      parent: createNode({ kind: "file", byteRange: [0, 1] }),
      position: 0,
    };
    expect(narrateAction(action)).toBe("added call expression `run (x)`");
  });
});

describe("narrate: redundant update dedup", () => {
  const rename = (kind: string, label: string | undefined): EditAction => ({
    type: "Update",
    context: [],
    node: createNode({ kind, label, byteRange: [0, 1] }),
    detail: { kind: "Renamed", from: "foo", to: "bar" },
  });

  it("collapses duplicate from/to updates, preferring the named node", () => {
    const changes = narrate([rename("identifier", undefined), rename("Function", "bar")]);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action.node.kind).toBe("Function");
  });

  it("keeps distinct updates", () => {
    const changes = narrate([
      rename("identifier", undefined),
      {
        type: "Update",
        context: [],
        node: createNode({ kind: "Function", label: "x", byteRange: [0, 1] }),
        detail: { kind: "Renamed", from: "a", to: "b" },
      },
    ]);
    expect(changes).toHaveLength(2);
  });
});

describe("formatChanges: groups and empties", () => {
  const ins = (filePath: string, name: string): SemanticChange => ({
    filePath,
    description: `added function \`${name}\``,
    action: {
      type: "Insert",
      context: [],
      node: createNode({ kind: "Function", label: name, byteRange: [0, 1] }),
      parent: createNode({ kind: "file", byteRange: [0, 1] }),
      position: 0,
    },
  });

  it("formats an empty changeset for every format", () => {
    expect(formatChanges([], { format: "terminal" })).toBe("no logical changes");
    expect(formatChanges([], { format: "markdown" })).toBe("_no logical changes_");
    expect(formatChanges([], { format: "llm" })).toBe("differens/1 0 files 0 changes 0 named");
  });

  it("groups terminal output by file with headings", () => {
    const out = formatChanges([ins("a.ts", "one"), ins("b.ts", "two")], { format: "terminal" });
    expect(out).toContain("a.ts\n  + added function `one`");
    expect(out).toContain("b.ts\n  + added function `two`");
  });

  it("groups markdown output by file", () => {
    const out = formatChanges([ins("a.ts", "one"), ins("b.ts", "two")], { format: "markdown" });
    expect(out).toContain("## a.ts");
    expect(out).toContain("## b.ts");
  });

  it("serializes bigints as strings in JSON", () => {
    const change: SemanticChange = {
      description: "added function `x`",
      action: {
        ...ins("a.ts", "x").action,
        node: { ...ins("a.ts", "x").action.node, byteRange: [0n as never, 0 as never] as never },
      } as never,
    };
    const changeAny = change as unknown as { action: { node: { byteRange: unknown } } };
    changeAny.action.node.byteRange = [1n, 2n];
    const out = formatChanges([change], { format: "json" });
    expect(out).toContain('"1"');
  });

  it("writes llm move and update lines", () => {
    const moves: SemanticChange[] = [
      {
        filePath: "src/a.ts",
        description: "moved function `go`",
        action: {
          type: "Move",
          context: [],
          node: createNode({ kind: "Function", label: "go", byteRange: [0, 1], line: 9 }),
          fromParent: createNode({ kind: "file", label: "src/a.ts", byteRange: [0, 1] }),
          toParent: createNode({ kind: "file", label: "src/b.ts", byteRange: [0, 1] }),
          fromPosition: 0,
          toPosition: 0,
        },
      },
    ];
    const lines = formatChanges(moves, { format: "llm" }).split("\n");
    expect(lines[2]).toBe("> function go :9 from src/a.ts");
  });

  it("rolls minor kinds up with singular and plural counts", () => {
    const mk = (kind: string): SemanticChange => ({
      filePath: "a.ts",
      description: "added",
      action: {
        type: "Insert",
        context: [],
        node: createNode({ kind, byteRange: [0, 1] }),
        parent: createNode({ kind: "file", byteRange: [0, 1] }),
        position: 0,
      },
    });
    const lines = formatChanges([mk("comment"), mk("comment"), mk("Comment")], {
      format: "llm",
    }).split("\n");
    expect(lines[2]).toBe("* 3 comments");
  });
});

describe("narrateAction: fallbacks", () => {
  it("narrates an unknown update detail as modified", () => {
    const action = {
      type: "Update",
      context: [],
      node: createNode({ kind: "Function", label: "f", byteRange: [0, 1] }),
      detail: { kind: "SomethingElse" },
    } as unknown as EditAction;
    expect(narrateAction(action)).toBe("modified function `f`");
  });

  it("uses the bullet icon for unknown action types", () => {
    const change: SemanticChange = {
      description: "odd",
      action: { type: "Bogus" } as unknown as EditAction,
    };
    expect(formatChanges([change], { format: "terminal" })).toBe("  • odd");
  });
});

describe("formatChanges: llm details", () => {
  it("writes update lines with none for a missing side", () => {
    const change: SemanticChange = {
      filePath: "a.ts",
      description: "set",
      action: {
        type: "Update",
        context: [],
        node: createNode({ kind: "Variable", label: "x", byteRange: [0, 1], line: 4 }),
        detail: { kind: "ValueChanged", to: "1" },
      },
    };
    const lines = formatChanges([change], { format: "llm" }).split("\n");
    expect(lines[2]).toBe("~ variable x :4 none -> 1");
  });

  it("quotes an empty value in an llm update line", () => {
    const change: SemanticChange = {
      filePath: "a.ts",
      description: "changed",
      action: {
        type: "Update",
        context: [],
        node: createNode({ kind: "Variable", label: "x", byteRange: [0, 1] }),
        detail: { kind: "ValueChanged", from: "", to: "" },
      },
    };
    const lines = formatChanges([change], { format: "llm" }).split("\n");
    expect(lines[2]).toBe('~ variable x "" -> ""');
  });

  it("suppresses a scope that repeats the node name", () => {
    const change: SemanticChange = {
      filePath: "a.ts",
      description: "removed",
      action: {
        type: "Delete",
        context: [{ kind: "Function", label: "f" }],
        node: createNode({ kind: "Variable", label: "f", byteRange: [0, 1] }),
      },
    };
    const lines = formatChanges([change], { format: "llm" }).split("\n");
    expect(lines[2]).toBe("- variable f");
  });
});
