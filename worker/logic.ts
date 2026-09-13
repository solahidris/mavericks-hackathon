/** Deliberately strict: punctuation and empty input are rejected before charging. */
export function lettersToNumbers(input: unknown): number[] {
  if (typeof input !== "string" || !/^[a-z]{1,256}$/i.test(input)) {
    throw new Error("Enter a word containing 1–256 letters (a–z).");
  }
  return [...input.toLowerCase()].map((letter) => letter.charCodeAt(0) - 96);
}
export function sumNumbers(input: unknown): number {
  if (
    !Array.isArray(input) ||
    !input.length ||
    input.length > 256 ||
    !input.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    throw new Error(
      "Enter a non-empty JSON array of up to 256 finite numbers.",
    );
  }
  const total = input.reduce((sum, number) => sum + number, 0);
  if (!Number.isFinite(total))
    throw new Error("Sum exceeds the supported number range.");
  return total;
}
