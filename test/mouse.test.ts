import assert from "node:assert/strict";
import test from "node:test";
import {
  createMouseWheelParser,
  mouseEventIsInside,
} from "../src/cli/mouse.ts";

test("parses SGR mouse wheel reports across input chunks", () => {
  const parser = createMouseWheelParser();

  assert.deepEqual(parser.push("q\u001B[<64;12;"), []);
  assert.deepEqual(parser.push("8M\u001B[<69;14;9M"), [
    { direction: "up", x: 12, y: 8 },
    { direction: "down", x: 14, y: 9 },
  ]);
});

test("ignores non-wheel, horizontal-wheel, and release reports", () => {
  const parser = createMouseWheelParser();

  assert.deepEqual(
    parser.push(
      ["\u001B[<0;2;3M", "\u001B[<66;2;3M", "\u001B[<64;2;3m"].join(""),
    ),
    [],
  );
});

test("hit-tests one-based mouse coordinates against an Ink box", () => {
  const region = { left: 2, top: 4, width: 10, height: 5 };

  assert.equal(
    mouseEventIsInside({ direction: "up", x: 3, y: 5 }, region),
    true,
  );
  assert.equal(
    mouseEventIsInside({ direction: "down", x: 12, y: 9 }, region),
    true,
  );
  assert.equal(
    mouseEventIsInside({ direction: "up", x: 2, y: 5 }, region),
    false,
  );
  assert.equal(
    mouseEventIsInside({ direction: "up", x: 3, y: 10 }, region),
    false,
  );
});
