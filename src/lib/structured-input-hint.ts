export interface ExpectedField {
  name: string;
  /** JSON Schema type as a string — `"string"`, `"number"`, `"array"`, etc. `"unknown"` when the schema doesn't declare one. */
  type: string;
  required: boolean;
}

export interface StructuredInputHint {
  message: string;
  /** One-line caller-actionable hint, ending in a `Try: dvm <cmd> …` example when one can be built. */
  hint: string;
  /** Structured data block surfaced under `error.details` in JSON mode for agent relay/retry. */
  data: {
    expected_fields: ExpectedField[];
    data_example?: Record<string, unknown>;
    next_action?: {
      type: "retry_with_data";
      command: string;
      form: "data";
    };
  };
}

export interface BuildStructuredInputHintOpts {
  identifier: string;
  /**
   * The literal caller-typed value used to address the DVM — a bare DVM id
   * (`scrape`, `cast/add-episode`) when `callerFlag` is `"dvm"`, or a URL /
   * favourite alias when `callerFlag` is `"endpoint"`. Surfaced verbatim in
   * the example command and on follow-up advice.
   */
  endpoint: string;
  /**
   * Which addressing flag the caller used — drives the example command so it
   * matches the caller's original invocation form. `-d <id>` is required for
   * bare DVM ids; `--endpoint` only accepts URLs or favourite aliases
   *   */
  callerFlag: "dvm" | "endpoint";
  /** JSON Schema (top-level `input_schema` or `pricing.quote.schema`). */
  schema: Record<string, unknown>;
  /** The primitive `-i` string the caller passed — used as the value in the `--data` example. */
  primitiveInput: string;
  command: "quote" | "request";
}

/** Extract top-level `{ name, type, required }` records from a JSON Schema's `properties` map. Returns an empty array when properties are absent or malformed. */
export function expectedFieldsFromSchema(schema: Record<string, unknown>): ExpectedField[] {
  const props = schema.properties;
  if (!isPlainObject(props)) return [];
  const requiredList = Array.isArray(schema.required)
    ? schema.required.filter((x): x is string => typeof x === "string")
    : [];
  const required = new Set(requiredList);
  const out: ExpectedField[] = [];
  for (const [name, raw] of Object.entries(props)) {
    out.push({ name, type: jsonSchemaType(raw), required: required.has(name) });
  }
  return out;
}


export function buildDataExample(
  schema: Record<string, unknown>,
  primitiveInput: string
): Record<string, unknown> | null {
  const fields = expectedFieldsFromSchema(schema);
  const text = fields.find((f) => f.name === "text" && f.type === "string");
  if (text) return { text: primitiveInput };
  const url = fields.find((f) => f.name === "url" && f.type === "string");
  if (url && looksLikeUrl(primitiveInput)) return { url: primitiveInput };
  const requiredStrings = fields.filter((f) => f.required && f.type === "string");
  if (requiredStrings.length === 1) return { [requiredStrings[0].name]: primitiveInput };
  return null;
}

export function buildStructuredInputHint(opts: BuildStructuredInputHintOpts): StructuredInputHint {
  const { identifier, endpoint, callerFlag, schema, primitiveInput, command } = opts;
  const fields = expectedFieldsFromSchema(schema);
  const example = buildDataExample(schema, primitiveInput);

  const message = `${identifier} expects structured input — got a primitive --input string but the DVM requires an object.`;

  const fieldList =
    fields.length > 0
      ? `Expected fields: ${fields.map(formatField).join(", ")}.`
      : `This DVM expects a JSON object payload.`;

  // render the addressing flag the caller actually used. `-d` for
  // bare DVM ids (`scrape`, `cast/add-episode`); `--endpoint` only accepts a
  // URL or `@alias`, so a `--endpoint scrape` suggestion is not runnable.
  const addressing = callerFlag === "dvm" ? `-d ${endpoint}` : `--endpoint ${endpoint}`;

  let hint: string;
  let nextAction: StructuredInputHint["data"]["next_action"];
  if (example) {
    const exampleJson = JSON.stringify(example);
    const commandLine = `dvm ${command} ${addressing} --data ${shellSingleQuote(exampleJson)}`;
    hint = `${fieldList} Try: ${commandLine}`;
    nextAction = { type: "retry_with_data", command: commandLine, form: "data" };
  } else {
    hint = `${fieldList} Pass structured input via --data '<json>' (or --param k=v). Run \`dvm describe ${endpoint}\` for the full schema.`;
  }

  const data: StructuredInputHint["data"] = { expected_fields: fields };
  if (example) data.data_example = example;
  if (nextAction) data.next_action = nextAction;

  return { message, hint, data };
}


function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonSchemaType(node: unknown): string {
  if (!isPlainObject(node)) return "unknown";
  const t = node.type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.filter((x) => typeof x === "string").join("|") || "unknown";
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) return "union";
  if (Array.isArray(node.enum)) return "enum";
  return "unknown";
}

function formatField(f: ExpectedField): string {
  const tag = f.required ? `${f.name} (${f.type}, required)` : `${f.name} (${f.type})`;
  return tag;
}

function looksLikeUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Wrap `s` in single quotes for safe pasting into a POSIX shell. Embedded single
// quotes are encoded as `'\''` — close the quoted run, emit a literal apostrophe,
// reopen — so `don't` becomes `'don'\''t'`. Necessary because narrate-style English
// input frequently contains apostrophes and the rewritten `Try: ...` example
// (and the matching `next_action.command`) needs to be copy-pasteable as-is.
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
