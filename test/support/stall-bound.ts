// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * T-30's bound B, in one place for every test that measures it: the longest the extension host's
 * thread may stall, a real RPC round trip may take, and a Cancel may take to land.
 */
export const STALL_BOUND_MS = 1_000;
