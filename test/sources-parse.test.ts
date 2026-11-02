import { describe, expect, test } from "bun:test";
import { defaultAddonName, parseSource } from "../src/core/sources/parse.ts";

describe("parseSource", () => {
  test("github", () => {
    const spec = parseSource("github:Questie/Questie");
    expect(spec).toEqual({ kind: "github", raw: "github:Questie/Questie", owner: "Questie", repo: "Questie" });
    expect(defaultAddonName(spec)).toBe("Questie");
  });

  test("url", () => {
    const spec = parseSource("url:https://example.com/files/Some%20Addon.zip?dl=1");
    expect(spec.kind).toBe("url");
    expect(defaultAddonName(spec)).toBe("Some Addon");
  });

  test("a malformed escape in the URL keeps the raw segment", () => {
    expect(defaultAddonName(parseSource("url:https://example.invalid/a%zz.zip"))).toBe("a%zz");
  });

  test("wowi", () => {
    const spec = parseSource("wowi:26270");
    expect(spec).toEqual({ kind: "wowi", raw: "wowi:26270", id: "26270" });
    expect(defaultAddonName(spec)).toBe("wowi-26270");
  });

  test("invalid forms name the supported ones", () => {
    expect(() => parseSource("curse:12345")).toThrow('"github:owner/repo", "wowi:<id>" and "url:https://..."');
    expect(() => parseSource("Questie/Questie")).toThrow("supported forms");
    expect(() => parseSource("github:Questie")).toThrow("github:owner/repo");
    expect(() => parseSource("github:a/b/c")).toThrow("github:owner/repo");
    expect(() => parseSource("wowi:abc")).toThrow("wowi:<id>");
    expect(() => parseSource("wowi:0")).toThrow("wowi:<id>");
    expect(() => parseSource("url:ftp://example.com/a.zip")).toThrow("http and https");
    expect(() => parseSource("url:not a url")).toThrow("Invalid URL source");
  });
});
