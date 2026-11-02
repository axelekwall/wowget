import { describe, expect, test } from "bun:test";
import { bumpFor, lintHeader, nextVersion, parseHeader } from "../scripts/release-version.ts";

describe("parseHeader", () => {
  test("reads type, scope and the breaking marker", () => {
    expect(parseHeader("feat(search)!: drop the old flag")).toEqual({
      type: "feat",
      scope: "search",
      breaking: true,
      description: "drop the old flag",
    });
    expect(parseHeader("fix: handle 404 (#12)")).toEqual({ type: "fix", breaking: false, description: "handle 404 (#12)" });
  });

  test("rejects headers without a type and a description", () => {
    expect(parseHeader("Merge pull request #3 from axelekwall/feat/x")).toBeUndefined();
    expect(parseHeader("feat:no space")).toBeUndefined();
    expect(parseHeader("Feat: capitalised type")).toBeUndefined();
  });
});

describe("lintHeader", () => {
  test("accepts known types and explains unknown ones", () => {
    expect(lintHeader("docs: specify search")).toBeUndefined();
    expect(lintHeader("feature: add search")).toContain('"feature" is not one of the commit types');
    expect(lintHeader("Add search")).toContain("is not a Conventional Commit header");
  });
});

describe("bumpFor", () => {
  test("takes the largest bump across the commits", () => {
    expect(bumpFor(["docs: x", "ci: y"])).toBeUndefined();
    expect(bumpFor(["docs: x", "fix: y"])).toBe("patch");
    expect(bumpFor(["perf: x", "feat: y", "fix: z"])).toBe("minor");
    expect(bumpFor(["fix: x", "refactor!: y"])).toBe("major");
  });

  test("counts a BREAKING CHANGE footer, also inside a squash body", () => {
    const squash = "feat: new manifest format (#20)\n\n* feat: read v2\n\nBREAKING CHANGE: v1 manifests are rejected";
    expect(bumpFor([squash])).toBe("major");
    expect(bumpFor(["fix: x\n\nmentions a breaking change: in prose"])).toBe("patch");
  });
});

describe("nextVersion", () => {
  test("bumps by semver, with breaking changes as minor before 1.0", () => {
    expect(nextVersion("0.3.0", "patch")).toBe("0.3.1");
    expect(nextVersion("0.3.4", "minor")).toBe("0.4.0");
    expect(nextVersion("0.3.4", "major")).toBe("0.4.0");
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
  });
});
