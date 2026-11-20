/**
 * Client-side mirror of the AI mapping cost bound (backend/services/leadMapping/gatewayProposer.ts:
 * MappingInputTooLargeError, AI_MAPPING_MAX_COLUMNS). Own module so a test can import it without the component.
 * Pinned both ways by backend/tests/unit/leadMappingGatewayProposer.test.ts.
 */
export const AI_MAPPING_TOO_LARGE_CAUSE = 'proposer_unavailable:MappingInputTooLargeError';
export const AI_MAPPING_COLUMN_LIMIT = 15;
