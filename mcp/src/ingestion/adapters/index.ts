import type { SourceDefinition } from "../types";
import { htmlNewsAdapter } from "./html-news";
import { strapiPublicationsAdapter } from "./strapi-publications";
import { strapiSectionsAdapter } from "./strapi-sections";
import type { Adapter } from "./types";

const ADAPTERS: Record<SourceDefinition["parser"], Adapter> = {
  "strapi-publications": strapiPublicationsAdapter,
  "strapi-sections": strapiSectionsAdapter,
  "html-news": htmlNewsAdapter,
};

export function adapterFor(source: SourceDefinition): Adapter {
  return ADAPTERS[source.parser];
}
