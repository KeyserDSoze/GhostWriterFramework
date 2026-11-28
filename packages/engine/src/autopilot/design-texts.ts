import { asArray, asRecord, asString } from "../util/json.js";
import { clipText } from "../util/text.js";
import { DESIGN_ROUND_TEXT_LIMITS as LIMITS, type DesignRoundReading, type DesignRoundTexts } from "./types.js";

/**
 * The words of a review of a design (`DesignRound.texts`, Phase 4 of #108): what the director and the simulated readers said, kept with the round so that the Studio shows
 * them, round after round, beside the votes. Cut to the limits (`DESIGN_ROUND_TEXT_LIMITS`): the state of a long design stays small. Pure.
 */

const text = (value: unknown, max: number) => clipText(asString(value), max).trim();
const list = (value: unknown) => asArray(value).map((item) => text(item, LIMITS.item)).filter(Boolean).slice(0, LIMITS.items);

function reading(value: unknown): DesignRoundReading | null {
  const record = asRecord(value);
  const slug = asString(record.slug);
  const name = text(record.name, 160) || slug;
  const said = text(record.text, LIMITS.reading);
  const score = Number(record.score);
  if (!slug || !said || !Number.isFinite(score)) return null;
  const counterProposal = text(record.counterProposal, LIMITS.counterProposal);
  return { slug, name, score: Math.min(10, Math.max(0, Math.round(score * 10) / 10)), text: said, ...(counterProposal ? { counterProposal } : {}) };
}

/** The words of a review, as kept: empty parts are left out, and nothing at all is `undefined`. Also what reads them back from a file. */
export function roundTexts(value: unknown): DesignRoundTexts | undefined {
  const source = asRecord(value);
  const summary = text(source.summary, LIMITS.summary);
  const counterProposal = text(source.counterProposal, LIMITS.counterProposal);
  const changes = list(source.changes);
  const critical = list(source.critical);
  const readers = asArray(source.readers).map(reading).filter((item): item is DesignRoundReading => item !== null).slice(0, LIMITS.readers);
  const texts: DesignRoundTexts = {
    ...(summary ? { summary } : {}),
    ...(counterProposal ? { counterProposal } : {}),
    ...(changes.length ? { changes } : {}),
    ...(critical.length ? { critical } : {}),
    ...(readers.length ? { readers } : {}),
  };
  return Object.keys(texts).length ? texts : undefined;
}

/** A reader's counter-proposal, as a reaction to a design keeps it among its wishes (`Counter-proposal: …`); `undefined` without one. */
export function counterProposalOf(wishes: readonly string[]): string | undefined {
  const found = wishes.find((wish) => /^(Counter-proposal|Controproposta): /.test(wish));
  return found ? found.replace(/^(Counter-proposal|Controproposta): /, "") : undefined;
}
