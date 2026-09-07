import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { blobsDir, collectBlobs, readBlob, writeBlob } from "../../src/server/blob-files";

describe("store captured bytes as a blob", () => {
  let previous: string | undefined;
  let root: string;

  beforeEach(() => {
    previous = process.env.PIEW_DIR;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "piew-blobs-"));
    process.env.PIEW_DIR = root;
  });

  afterEach(() => {
    process.env.PIEW_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads back the exact bytes it stored", () => {
    expect(readBlob(writeBlob("export const value = 1;\n"))).toBe("export const value = 1;\n");
  });

  it("names the blob after the sha256 of its bytes", () => {
    expect(writeBlob("same")).toBe(
      "0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5"
    );
  });

  it("stores two pages holding identical bytes as one blob", () => {
    const first = writeBlob("identical\n");
    const second = writeBlob("identical\n");

    expect({ second, blobs: fs.readdirSync(blobsDir()) }).toEqual({
      second: first,
      blobs: [first],
    });
  });

  it("leaves the stored file untouched when the same bytes are written again", () => {
    const hash = writeBlob("shared\n");
    fs.writeFileSync(path.join(blobsDir(), hash), "tampered");

    expect({
      hash: writeBlob("shared\n"),
      stored: fs.readFileSync(path.join(blobsDir(), hash), "utf8"),
    }).toEqual({ hash, stored: "tampered" });
  });

  it("throws when the blob is missing", () => {
    expect(() => readBlob("0".repeat(64))).toThrow(/ENOENT/);
  });

  it("leaves no temp file behind when the write fails", () => {
    const failure = new Error("disk full");
    const write = spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw failure;
    });

    try {
      expect(() => writeBlob("unwritable\n")).toThrow(failure);
    } finally {
      write.mockRestore();
    }

    expect(fs.readdirSync(blobsDir())).toEqual([]);
  });

  it("unlinks every blob outside the live set", () => {
    const kept = writeBlob("kept\n");
    writeBlob("dropped\n");

    expect({ removed: collectBlobs(new Set([kept])), blobs: fs.readdirSync(blobsDir()) }).toEqual({
      removed: 1,
      blobs: [kept],
    });
  });
});
