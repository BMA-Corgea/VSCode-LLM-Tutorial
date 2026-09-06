// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The slice of repo-tour the TUTOR needs, duck-typed — `src/dial/core.ts` is the immediate
 * precedent and `src/start/build.ts`'s `BuildCore` the original. One cast site, and this
 * extension stays typecheckable with no dependency on repo-tour's `dist/*.d.ts` being built.
 *
 * Pinned here rather than three times, because `context.ts`, `transcript.ts` and `ask.ts` are
 * written in parallel and would otherwise each invent a slightly different shape for the same
 * objects.
 *
 * **This is the first module in this extension that can spend money.** `runLlm` shells out to
 * a provider the learner is paying for, so the seam matters: every caller takes its runner
 * from `TutorCore`, tests inject one, and nothing in the suite may reach a real model. The
 * cost fields on `LlmReply` are carried through rather than dropped for the same reason —
 * a tutor that quietly bills is not honest, whatever else it gets right.
 */

/** repo-tour's `AskMessage` — one turn of the conversation, and the only shape stored. */
export interface AskMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * repo-tour's `AskContext`, narrowed to the fields THIS extension fills. `build` is the block
 * repo-tour's T-13 added for exactly this consumer; its presence was verified against
 * repo-tour's `src/ask.ts` before this ticket was planned, not assumed from the spec.
 */
export interface AskContext {
  repo?: string;
  file?: string;
  fileMeaning?: string;
  stopTitle?: string | null;
  stopText?: string | null;
  build?: {
    question: string;
    options: Array<{ label: string; consequence: string; taken: boolean }>;
    why: string;
    learnerDiff?: string;
  };
}

/** What a provider actually reports back. The zeros mean "unknown" when `metered` is false —
 *  they do not mean "free", and nothing downstream may present them as free. */
export interface LlmReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  metered: boolean;
}

export interface LlmChoice {
  provider: string;
  model: string;
}

/** `ok` plus something to SHOW a person — a version, a path, or the reason it cannot be used.
 *  AC4 is built on this: the reason is displayed, never a spinner that does not end. */
export interface Availability {
  ok: boolean;
  detail: string;
}

export interface TutorCore {
  buildAskPrompt(messages: AskMessage[], ctx: AskContext): string;
  buildContextBlock(ctx: AskContext): string;
  /** Takes `unknown` in repo-tour too — it is a validator as much as a trimmer, which is why
   *  a stored transcript can be handed to it directly. */
  trimMessages(raw: unknown): AskMessage[];
  resolveChoice(choice: Partial<LlmChoice> | null): LlmChoice;
  /**
   * The TUTOR's choice, which repo-tour deliberately keeps separate from the build's — and
   * which this extension should use instead of `resolveChoice` for every ask.
   *
   * repo-tour's own words on it: "the build model is picked for what a whole tour costs, and
   * inheriting that for the one thing the reader talks to was exactly the complaint Q5
   * answered." The same asymmetry holds here and is arguably sharper: the build model is
   * chosen for interpreting a whole repository, once, in the background; the tutor is asked
   * one question, by one person, at the moment they are stuck. Unset means the provider's
   * STRONGEST model rather than its default, which is the right way round for the only place
   * a wrong answer is read by a human who is already confused.
   */
  resolveTutorChoice(stored: Partial<LlmChoice> | null, build: LlmChoice): LlmChoice;
  runLlm(prompt: string, choice: LlmChoice, cwd: string, timeoutMs?: number): Promise<LlmReply>;
  /** `null` for an id no provider claims — the honest answer, and AC4's other half. */
  availability(providerId: string): Promise<Availability>;
}

/** Builds a `TutorCore` from `CoreLoadResult.loaded` (src/core.ts) — the one cast site. */
export function tutorCoreFor(loaded: Partial<Record<string, unknown>>): TutorCore {
  const ask = loaded['ask'] as {
    buildAskPrompt: TutorCore['buildAskPrompt'];
    buildContextBlock: TutorCore['buildContextBlock'];
    trimMessages: TutorCore['trimMessages'];
  };
  const llm = loaded['llm'] as {
    resolveChoice: TutorCore['resolveChoice'];
    resolveTutorChoice: TutorCore['resolveTutorChoice'];
    runLlm: TutorCore['runLlm'];
    providerById(id: string): { available(): Promise<Availability> } | null;
  };
  return {
    buildAskPrompt: ask.buildAskPrompt,
    buildContextBlock: ask.buildContextBlock,
    trimMessages: ask.trimMessages,
    resolveChoice: llm.resolveChoice,
    resolveTutorChoice: llm.resolveTutorChoice,
    runLlm: llm.runLlm,
    availability: async (providerId) => {
      const provider = llm.providerById(providerId);
      if (!provider) return { ok: false, detail: `no such provider: ${providerId}` };
      return provider.available();
    },
  };
}
