import { strapiPublicationsParser } from "./strapi-publications.parser";

export const PARSERS = {
  [strapiPublicationsParser.name]: strapiPublicationsParser,
} as const;

export const KNOWN_PARSERS: readonly string[] = Object.keys(PARSERS);

export function getParser(name: string) {
  return PARSERS[name as keyof typeof PARSERS];
}
