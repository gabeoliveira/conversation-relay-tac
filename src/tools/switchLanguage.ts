import { config } from "../config.js";

export interface SwitchLanguageParams {
  targetLanguage: "portuguese" | "english" | "spanish";
}

export async function switchLanguage(params: SwitchLanguageParams): Promise<string> {
  console.log("Switch Language", params);
  if (params.targetLanguage in config.languages) {
    return `Language switched to ${params.targetLanguage}`;
  }
  return "Language not supported";
}
