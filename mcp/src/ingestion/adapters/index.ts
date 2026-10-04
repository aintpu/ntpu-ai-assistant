import type { SourceDefinition } from "../types";
import { htmlNewsAdapter } from "./html-news";
import { manualFaqAdapter, manualRegulationCatalogAdapter, manualRegulationsAdapter } from "./manual";
import { strapiPublicationsAdapter } from "./strapi-publications";
import { strapiSectionsAdapter } from "./strapi-sections";
import type { Adapter } from "./types";

const ADAPTERS: Record<SourceDefinition["parser"], Adapter> = {
  "strapi-publications": strapiPublicationsAdapter,
  "strapi-sections": strapiSectionsAdapter,
  "html-news": htmlNewsAdapter,
  "manual-regulations": manualRegulationsAdapter,
  "manual-regulation-catalog": manualRegulationCatalogAdapter,
  "manual-faq": manualFaqAdapter,
};

export function adapterFor(source: SourceDefinition): Adapter {
  return ADAPTERS[source.parser];
}
