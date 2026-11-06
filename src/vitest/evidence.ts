export type EvidenceSectionOptions = {
  /** Output that can contain application data, such as logs. Dropped when the test is restricted. */
  mayContainSensitiveData?: boolean;
};

export type Evidence = {
  /** Removes this value from everything captured, including its base64 and JSON-escaped forms. */
  markSensitive: (value: string) => void;
  /**
   * Captures only metadata for this test. For tests whose secrets could appear in a form `markSensitive`
   * cannot recognize, such as a value split across log lines.
   */
  restrict: () => void;
  /** Registers something to collect if the test fails. Register as soon as the thing to inspect is known. */
  add: (title: string, collect: () => Promise<string>, options?: EvidenceSectionOptions) => void;
  /** Runs every collector. A failing collector reports its failure and never hides the test's own. */
  capture: () => Promise<string>;
};

const REDACTED = "***";
const MAX_SECTION_CHARS = 20_000;
const COLLECTOR_TIMEOUT_MS = 8_000;

const formsOf = (value: string): string[] => [
  value,
  Buffer.from(value).toString("base64"),
  JSON.stringify(value).slice(1, -1),
];

/** Longest first, so that a value containing another is removed whole. */
export const sanitize = (text: string, sensitive: readonly string[]): string => {
  const forms = sensitive
    .filter((value) => value.length > 0)
    .flatMap(formsOf)
    .sort((left, right) => right.length - left.length);
  return forms.reduce((current, form) => current.replaceAll(form, REDACTED), text);
};

const withinLimit = async (collect: () => Promise<string>): Promise<string> => {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`timed out after ${COLLECTOR_TIMEOUT_MS}ms`)), COLLECTOR_TIMEOUT_MS);
  try {
    return await Promise.race([collect(), expired]);
  } finally {
    clearTimeout(timer);
  }
};

/** The end of a section is kept, because that is where a failure usually shows. */
const bounded = (text: string): string =>
  text.length > MAX_SECTION_CHARS ? `[earlier output removed]\n${text.slice(-MAX_SECTION_CHARS)}` : text;

export const createEvidence = (): Evidence => {
  const sensitive: string[] = [];
  const sections: { title: string; collect: () => Promise<string>; mayContainSensitiveData: boolean }[] = [];
  let restricted = false;

  return {
    markSensitive: (value) => {
      sensitive.push(value);
    },
    restrict: () => {
      restricted = true;
    },
    add: (title, collect, options = {}) => {
      sections.push({ title, collect, mayContainSensitiveData: options.mayContainSensitiveData ?? false });
    },
    capture: async () => {
      const included = sections.filter((section) => !(restricted && section.mayContainSensitiveData));
      // Together, because the hook running this has its own timeout.
      const bodies = await Promise.all(
        included.map(({ collect }) =>
          withinLimit(collect).catch((error: unknown) => `could not collect: ${String(error)}`)
        )
      );
      // Sanitized last, so a value marked by any collector is removed from all of them, including their errors.
      return included
        .map(({ title }, index) => sanitize(`--- ${title}\n${bounded(bodies[index] ?? "")}`, sensitive))
        .join("\n");
    },
  };
};
