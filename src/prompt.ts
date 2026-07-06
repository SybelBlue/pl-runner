import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  autocomplete as clackAutocomplete,
  cancel as clackCancel,
  confirm as clackConfirm,
  intro,
  isCancel,
  note,
  outro,
  path as clackPath,
  select as clackSelect,
  spinner,
  text,
} from "@clack/prompts";

export class PromptCanceled extends Error {
  constructor() {
    super("prompt canceled");
  }
}

export function canUseTui(): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

export function startPrompt(title: string, quiet = false): void {
  if (!quiet && canUseTui()) intro(title);
  else if (!quiet) console.log(title);
}

export function endPrompt(message: string, quiet = false): void {
  if (!quiet && canUseTui()) outro(message);
  else if (!quiet) console.log(message);
}

export function showNote(message: string, title?: string, quiet = false): void {
  if (quiet) return;
  if (canUseTui()) note(message, title);
  else console.log(title ? `${title}\n${message}` : message);
}

export async function withSpinner<T>(message: string, action: () => Promise<T>, quiet = false): Promise<T> {
  if (quiet || !canUseTui()) return action();

  const progress = spinner();
  progress.start(message);
  try {
    const result = await action();
    progress.stop(message);
    return result;
  } catch (error) {
    progress.error(message);
    throw error;
  }
}

export async function ask(message: string, defaultValue?: string, placeholder?: string): Promise<string> {
  if (canUseTui()) {
    const answer = await text({
      message,
      defaultValue,
      initialValue: defaultValue,
      placeholder,
    });
    return unwrapPrompt(answer).trim();
  }

  const rl = createInterface({ input, output });
  try {
    const suffix = defaultValue === undefined ? "" : ` [${defaultValue}]`;
    const hint = placeholder === undefined ? "" : ` (${placeholder})`;
    const answer = await rl.question(`${message}${suffix}${hint}: `);
    return answer.trim() || defaultValue || "";
  } catch {
    output.write("\n");
    throw new PromptCanceled();
  } finally {
    rl.close();
  }
}

export async function askDirectory(message: string, defaultValue?: string): Promise<string> {
  if (canUseTui()) {
    const answer = await clackPath({
      message,
      directory: true,
      initialValue: defaultValue,
    });
    return unwrapPrompt(answer).trim();
  }

  return ask(message, defaultValue);
}

export async function confirm(message: string, defaultValue = true): Promise<boolean> {
  if (canUseTui()) {
    return unwrapPrompt(await clackConfirm({ message, initialValue: defaultValue }));
  }

  const label = defaultValue ? "Y/n" : "y/N";
  const answer = (await ask(`${message} (${label})`)).toLowerCase();
  if (!answer) return defaultValue;
  return answer === "y" || answer === "yes";
}

export async function autocomplete<T extends string>(
  message: string,
  choices: Array<{ name: string; value: T; hint?: string; disabled?: boolean }>,
  defaultValue: T,
  placeholder?: string,
): Promise<T> {
  if (canUseTui()) {
    return unwrapPrompt(
      await clackAutocomplete<string>({
        message,
        options: choices.map((choice) => ({
          label: choice.name,
          value: choice.value,
          ...(choice.hint === undefined ? {} : { hint: choice.hint }),
          ...(choice.disabled === undefined ? {} : { disabled: choice.disabled }),
        })),
        initialValue: defaultValue,
        placeholder,
        maxItems: 8,
      }),
    ) as T;
  }

  return select(message, choices, defaultValue);
}

export async function select<T extends string>(
  message: string,
  choices: Array<{ name: string; value: T; hint?: string; disabled?: boolean }>,
  defaultValue: T,
): Promise<T> {
  if (canUseTui()) {
    return unwrapPrompt(
      await clackSelect<string>({
        message,
        options: choices.map((choice) => ({
          label: choice.name,
          value: choice.value,
          ...(choice.hint === undefined ? {} : { hint: choice.hint }),
          ...(choice.disabled === undefined ? {} : { disabled: choice.disabled }),
        })),
        initialValue: defaultValue,
      }),
    ) as T;
  }

  output.write(`${message}\n`);
  choices.forEach((choice, index) => {
    const marker = choice.value === defaultValue ? "*" : " ";
    output.write(` ${marker} ${index + 1}. ${choice.name}\n`);
  });
  while (true) {
    const answer = await ask("Choose", String(choices.findIndex((choice) => choice.value === defaultValue) + 1));
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && choices[index]) return choices[index].value;
    const match = choices.find((choice) => choice.value === answer || choice.name === answer);
    if (match) return match.value;
  }
}

function unwrapPrompt<T>(answer: T | symbol): T {
  if (isCancel(answer)) {
    if (canUseTui()) clackCancel("Canceled.");
    throw new PromptCanceled();
  }
  return answer;
}
