/**
 * Sender address constants for ReBattery transactional emails.
 *
 * hello@    — warm, relationship-driven: approvals, invitations, welcome
 * support@  — operational: takedowns, warnings, account actions
 * supply@   — supply-chain facing: recycler bids, listing opportunities
 *
 * All addresses must be verified sender signatures in Postmark.
 */

/** Warm outreach — approvals, invitations, welcome emails */
export const FROM_HELLO = "hello@rebattery.io";

/** Operational — takedowns, warnings, account/listing actions */
export const FROM_SUPPORT = "support@rebattery.io";

/** Supply-chain — recycler bid opportunities, listing matches */
export const FROM_SUPPLY = "supply@rebattery.io";
