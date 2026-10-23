import type { ConversationAccess } from '../hermes-conversations'

/** Test fixtures for server-issued conversation permissions. */
export const ownerAccess: ConversationAccess = { visibility: 'private', ownerId: 'owner', canShare: true, canDelete: true, canWrite: true, canApprove: true }
export const viewerAccess: ConversationAccess = { visibility: 'team', ownerId: 'owner', canShare: false, canDelete: false, canWrite: true, canApprove: false }
export const readerAccess: ConversationAccess = { visibility: 'team', ownerId: null, canShare: false, canDelete: false, canWrite: false, canApprove: false }
