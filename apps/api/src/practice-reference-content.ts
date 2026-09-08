import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type PracticeReferenceContent = {
  expectedApproach: string;
  checks: string[];
  pitfalls: string[];
  acceptableAlternatives: string[];
  rubric: Array<{ criterion: string; description: string }>;
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isReference(value: unknown): value is PracticeReferenceContent {
  if (!value || typeof value !== "object") return false;
  const reference = value as Record<string, unknown>;
  return (
    typeof reference.expectedApproach === "string" &&
    isStringArray(reference.checks) &&
    isStringArray(reference.pitfalls) &&
    isStringArray(reference.acceptableAlternatives) &&
    Array.isArray(reference.rubric) &&
    reference.rubric.every(
      (entry) =>
        Boolean(entry) &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).criterion === "string" &&
        typeof (entry as Record<string, unknown>).description === "string",
    )
  );
}

function loadPracticeReferenceContent(): Record<string, PracticeReferenceContent> {
  const filePath = resolve(
    process.env.SHI_PRACTICE_REFERENCE_FILE ??
      "private/practice-reference-content.json",
  );
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Unable to read private practice reviewer content.");
  }

  try {
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const entries = Object.entries(value);
    if (!entries.every(([key, reference]) => key.length > 0 && isReference(reference))) {
      throw new Error();
    }
    return Object.fromEntries(entries);
  } catch {
    throw new Error("Private practice reviewer content is invalid.");
  }
}

// Server-only reviewer material. Public clones intentionally start with no built-in guide.
export const practiceReferenceContent = loadPracticeReferenceContent();
