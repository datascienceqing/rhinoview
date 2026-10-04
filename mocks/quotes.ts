/**
 * MSW mock of `GET /api/quotes`. PHASE 5 SLOT — Worker W5 implements.
 * Must follow `QuotesResponse` exactly, including partial success: unknown symbols go
 * to `missing`, never fail the whole request. Give symbols DIFFERENT values, or a
 * sort test cannot tell a sorted list from an unsorted one.
 */
export function createQuotesHandlers() {
  return [];
}
