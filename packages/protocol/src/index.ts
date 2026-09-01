/**
 * Shared wire contract between the browser client, the signaling broker and
 * the native Windows host.
 *
 * The binary input format has a C++ mirror, glsplay_input.h, which lives in the
 * host repo. The two describe the same bytes and change together - and since
 * they no longer share a diff, that is a matter of discipline, not tooling.
 */

export * from './signaling.js';
export * from './input.js';
export * from './control.js';

/** Bumped whenever the wire format changes incompatibly. */
export const PROTOCOL_VERSION = 1;
