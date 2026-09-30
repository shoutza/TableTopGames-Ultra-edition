/** Version constants recorded in every save so incompatible data is detected, never guessed. */
export const ENGINE_VERSION = '0.4.0';
/**
 * 2: statuses, modifiers, continuous and attached rules, decks, choices, custom actions.
 * 3: GM rulings (`askGm`). Older definitions are valid version 3 definitions.
 */
export const RULES_LANGUAGE_VERSION = 3;
/**
 * 2: entity statuses, decks, choice queue, cooldowns, richer rule counters.
 * 3: objectives, negotiations, commitments; contestant relationships and memories.
 * Older formats are migrated on load.
 */
export const SAVE_FORMAT_VERSION = 3;
