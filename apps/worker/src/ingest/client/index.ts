export { PORTAL_URL, pageFromJson, pageFromXml, projectFromJson, projectUrl } from "./normalize.js";
export {
  buildFilter,
  escapeFilterValue,
  MAX_PAGE_SIZE,
  parseRetryAfter,
  RegulationClient,
  type RegulationClientOptions,
} from "./regulation-client.js";
export {
  type FetchLike,
  type FetchPage,
  type FilteredQuery,
  type NpaProject,
  RegulationClientError,
  type RegulationErrorCode,
} from "./types.js";
export { parseXml, type XmlElement, XmlParseError } from "./xml.js";
