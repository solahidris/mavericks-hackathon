import { test } from "node:test";
import assert from "node:assert/strict";
import { lettersToNumbers, sumNumbers } from "../worker/logic";
import { checkShape } from "../worker/common";
test("money composes into 72, case insensitive", () => {
  assert.deepEqual(lettersToNumbers("MoNeY"), [13, 15, 14, 5, 25]);
  assert.equal(sumNumbers(lettersToNumbers("money")), 72);
});
test("reject invalid letters before payment", () => {
  for (const input of ["", "hi!", "a b", 42, null, "a".repeat(257)])
    assert.throws(() => lettersToNumbers(input));
});
test("sum supports zero and negatives, rejects empty and nonfinite results", () => {
  assert.equal(sumNumbers([-5, 0, 5]), 0);
  for (const input of [[], [NaN], ["1"], [Infinity], [1e308, 1e308]])
    assert.throws(() => sumNumbers(input));
});
test("output contract accepts zero, rejects empty and malformed output", () => {
  assert.equal(checkShape(0, "number"), true);
  assert.equal(checkShape([], "number[]"), false);
  assert.equal(checkShape(["2"], "number[]"), false);
  assert.equal(checkShape(null, "json"), false);
});

test('x402 quotes bind the exact recipient, amount, asset and network', async () => {
  const { assertQuote } = await import('../worker/payments');
  const expected = { scheme: 'exact', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as const, asset: 'devnet-usdc', payTo: 'escrow', amount: '2000', maxTimeoutSeconds: 120, extra: {feePayer:'facilitator'} };
  assert.doesNotThrow(() => assertQuote(expected, expected));
  for (const altered of [{payTo:'attacker'},{amount:'1'},{asset:'different-token'},{network:'solana:mainnet' as const},{extra:{feePayer:'attacker'}}]) assert.throws(() => assertQuote({...expected,...altered},expected));
});
