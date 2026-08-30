export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface PiewToolProps<Input extends JsonValue, Output extends JsonValue> {
  prompt: string;
  data: Readonly<Input>;
  theme: "light" | "dark";
  submit(value: Output): void;
}

export interface PiewToolDefinition<Input extends JsonValue, Output extends JsonValue> {
  component(props: PiewToolProps<Input, Output>): unknown;
}

export function definePiewTool<I extends JsonValue, O extends JsonValue>(
  definition: PiewToolDefinition<I, O>
): PiewToolDefinition<I, O> {
  return definition;
}
