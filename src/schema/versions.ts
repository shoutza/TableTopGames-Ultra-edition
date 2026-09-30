/** Version constants recorded in every save so incompatible data is detected, never guessed. */
export const ENGINE_VERSION = '0.2.0';
/** 2: statuses, modifiers, continuous and attached rules, decks, choices, custom actions. */
export const RULES_LANGUAGE_VERSION = 2;
/** 2: entity statuses, decks, choice queue, cooldowns, richer rule counters (1 is migrated on load). */
export const SAVE_FORMAT_VERSION = 2;
