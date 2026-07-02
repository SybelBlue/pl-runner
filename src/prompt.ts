import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export class PromptCanceled extends Error {
  constructor() {
    super("prompt canceled");
  }
}

export async function ask(message: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const suffix = defaultValue === undefined ? "" : ` [${defaultValue}]`;
    const answer = await rl.question(`${message}${suffix}: `);
    return answer.trim() || defaultValue || "";
  } catch {
    output.write("\n");
    throw new PromptCanceled();
  } finally {
    rl.close();
  }
}

export async function confirm(message: string, defaultValue = true): Promise<boolean> {
  const label = defaultValue ? "Y/n" : "y/N";
  const answer = (await ask(`${message} (${label})`)).toLowerCase();
  if (!answer) return defaultValue;
  return answer === "y" || answer === "yes";
}

export async function select(message: string, choices: Array<{ name: string; value: string }>, defaultValue: string): Promise<string> {
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
