import { describe, expect, it } from "bun:test";
import { comboFor, isTyping } from "~/hooks/use-hotkeys";

describe("comboFor", () => {
  it("names a bare key by itself", () => {
    expect(comboFor({ key: "j" })).toBe("j");
  });

  it("prefixes mod for Cmd and for Ctrl alike", () => {
    expect(comboFor({ key: "Enter", metaKey: true })).toBe("mod+Enter");
    expect(comboFor({ key: "Enter", ctrlKey: true })).toBe("mod+Enter");
  });

  it("claims no combo when Alt is held", () => {
    expect(comboFor({ key: "j", altKey: true })).toBe("");
  });
});

describe("isTyping", () => {
  it("reports a textarea as typing", () => {
    expect(isTyping({ tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(true);
  });

  it("reports an input as typing", () => {
    expect(isTyping({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
  });

  it("reports a contenteditable host as typing", () => {
    expect(isTyping({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(
      true
    );
  });

  it("reports a plain element as not typing", () => {
    expect(isTyping({ tagName: "DIV" } as unknown as EventTarget)).toBe(false);
  });

  it("reports a missing target as not typing", () => {
    expect(isTyping(null)).toBe(false);
  });
});
