/**
 * Skill selection and injection (story R3, design D3/D5, stage A).
 *
 * Code builds the skill catalog from `ctx.skill.list()`, prefilters it lexically to at most 30 skills and adds
 * one independent `noul` question per shortlisted skill to the batched stage-A request. Skills whose
 * (clamped) probability reaches `skillThreshold` are validated against the shortlist, de-duplicated against the
 * user's own selection, capped at `maxSkills` and pushed into `event.prompt.skills` as `{ id }` objects (design F5).
 * Skill Markdown is never copied anywhere: OpenCode resolves the ids itself.
 */
import type { Resolved } from "../config.ts";
import { SKILL_QUESTION_PREFIX, skillQuestion } from "../jev/questions.ts";
import { rankNoul } from "../jev/response.ts";
import type { Answers, Questions } from "../jev/types.ts";
import type { Logger } from "../log.ts";
import type { StageAContributor, StageAInput, StageAOutcome, TurnPlan } from "./plan.ts";

/** At most this many skills get a question. */
export const MAX_SKILL_CANDIDATES = 30;
/** Contributor name (used in fallback reasons). */
export const SKILL_CONTRIBUTOR = "skills";
/** The raw skill list is cached for this long (design: catalogs cached with a short TTL). */
export const SKILL_CATALOG_TTL_MS = 30_000;
/** Only this many characters of a skill's content are read to derive its capability line. */
const CAPABILITY_SCAN_CHARS = 2_000;

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  /** Short capability line taken from the skill content (never sent in full). */
  capability: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** `ctx.skill.list()` may return `{ data: SkillInfo[] }` or a bare array. */
export function skillsFrom(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const data = isRecord(result) ? result.data : undefined;
  return Array.isArray(data) ? data : [];
}

/** First prose paragraph of a skill's Markdown (front matter and headings skipped), whitespace collapsed. */
export function capabilityOf(content: unknown, description: string): string {
  if (typeof content !== "string" || content === "") return "";
  let text = content.slice(0, CAPABILITY_SCAN_CHARS).replace(/\r\n?/g, "\n");
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    text = end >= 0 ? text.slice(end + 4) : "";
  }
  // HTML comments (single or multi-line, also an unterminated one cut by the scan limit) are not prose.
  text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("```")) {
      if (lines.length > 0) break;
      continue;
    }
    lines.push(line);
  }
  const capability = lines.join(" ").replace(/\s+/g, " ").slice(0, 200).trim();
  return capability === description.trim() ? "" : capability;
}

/** Valid, de-duplicated catalog entries (a skill needs a non-empty string id). */
export function buildSkillCatalog(list: unknown): SkillEntry[] {
  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const raw of skillsFrom(list)) {
    if (!isRecord(raw)) continue;
    const id = raw.id;
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    const name = typeof raw.name === "string" && raw.name !== "" ? raw.name : id;
    const description = typeof raw.description === "string" ? raw.description : "";
    out.push({ id, name, description, capability: capabilityOf(raw.content, description) });
  }
  return out;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "you", "your", "are", "use", "using", "when", "how", "can",
  "please", "into", "not", "all", "any", "has", "have", "was", "will", "should", "need", "want", "make", "get",
]);

/** Lowercase word stems of length >= 3 without stop words (a light suffix trim: tests/testing/tested -> test). */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    let w = match[0];
    if (w.length < 3 || STOP_WORDS.has(w)) continue;
    for (const suffix of ["ing", "ed", "es", "s"]) {
      if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
        w = w.slice(0, -suffix.length);
        break;
      }
    }
    out.add(w);
  }
  return out;
}

/**
 * Lexical prefilter. With at most `max` skills all of them are kept (catalog order). Above that, only skills whose
 * id/name or description/capability share a word stem with the prompt are kept, best overlap first (a name hit
 * weighs three description hits), at most `max`.
 */
export function shortlistSkills(skills: readonly SkillEntry[], text: string, max: number = MAX_SKILL_CANDIDATES): SkillEntry[] {
  if (skills.length <= max) return [...skills];
  const wanted = tokenize(text);
  if (wanted.size === 0) return [];
  const scored: Array<{ skill: SkillEntry; score: number; index: number }> = [];
  skills.forEach((skill, index) => {
    let score = 0;
    for (const t of tokenize(`${skill.id} ${skill.name}`)) if (wanted.has(t)) score += 3;
    for (const t of tokenize(`${skill.description} ${skill.capability}`)) if (wanted.has(t)) score += 1;
    if (score > 0) scored.push({ skill, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, max).map((s) => s.skill);
}

/** Ids of skills already attached to the prompt: `{ id }` objects (design F5); plain strings are tolerated. */
export function selectedSkillIds(skills: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(skills)) return ids;
  for (const s of skills) {
    if (typeof s === "string" && s !== "") ids.add(s);
    else if (isRecord(s) && typeof s.id === "string" && s.id !== "") ids.add(s.id);
  }
  return ids;
}

/**
 * Validated skill ids to add: from the answers, only ids in `allowed` (the shortlist), not already selected,
 * probability >= threshold, best first, at most `maxSkills`. Never throws.
 */
export function chooseSkills(
  answers: Answers | null | undefined,
  allowed: ReadonlySet<string>,
  already: ReadonlySet<string>,
  threshold: number,
  maxSkills: number,
): string[] {
  if (!answers || !(maxSkills >= 1)) return [];
  const picked: string[] = [];
  for (const id of rankNoul(answers, SKILL_QUESTION_PREFIX, threshold)) {
    if (!allowed.has(id) || already.has(id) || picked.includes(id)) continue;
    picked.push(id);
    if (picked.length >= Math.floor(maxSkills)) break;
  }
  return picked;
}

export interface SkillRouterDeps {
  options: Pick<Resolved, "maxSkills" | "skillThreshold" | "timeoutMs">;
  log: Pick<Logger, "debug" | "warn">;
  /** `ctx.skill.list` */
  listSkills: () => Promise<unknown> | unknown;
  now?: () => number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Stage-A contributor for skills. */
export function createSkillRouter(deps: SkillRouterDeps): StageAContributor {
  const now = deps.now ?? Date.now;
  let cache: { at: number; skills: SkillEntry[] } | undefined;

  async function catalog(): Promise<SkillEntry[]> {
    if (cache && now() - cache.at < SKILL_CATALOG_TTL_MS) return cache.skills;
    const list = await withTimeout(Promise.resolve().then(() => deps.listSkills()), deps.options.timeoutMs, "skill.list");
    const skills = buildSkillCatalog(list);
    cache = { at: now(), skills };
    return skills;
  }

  return {
    name: SKILL_CONTRIBUTOR,
    async prepare(input: StageAInput) {
      const { maxSkills, skillThreshold } = deps.options;
      if (!(maxSkills >= 1)) return { skip: "maxSkills is 0" };
      if (input.text.trim() === "") return { skip: "empty prompt" };

      let skills: SkillEntry[];
      try {
        skills = await catalog();
      } catch (err) {
        deps.log.warn("skill router: could not list skills:", err);
        return { skip: "skill catalog unavailable" };
      }
      if (skills.length === 0) return { skip: "no skills installed" };

      const already = selectedSkillIds(input.prompt.skills);
      const shortlist = shortlistSkills(
        skills.filter((s) => !already.has(s.id)),
        input.text,
      );
      if (shortlist.length === 0) return { skip: "no skill matches the prompt" };

      const questions: Questions = {};
      for (const s of shortlist) {
        questions[`${SKILL_QUESTION_PREFIX}${s.id}`] = skillQuestion({
          name: s.name,
          description: s.description,
          capability: s.capability,
        });
      }
      const allowed = new Set(shortlist.map((s) => s.id));

      return {
        questions,
        apply(answers: Answers | null, plan: TurnPlan): StageAOutcome {
          if (!answers) return { decided: false, reason: "Jev unavailable" };
          // the user may have changed the selection since prepare(): re-read it
          const attached = input.prompt.skills;
          const chosen = chooseSkills(answers, allowed, selectedSkillIds(attached), skillThreshold, maxSkills);
          if (chosen.length === 0) return { decided: false, reason: "no skill above the threshold" };
          // mutate the host event last, so a failure above leaves the prompt untouched
          const target = Array.isArray(attached) ? attached : (input.prompt.skills = []);
          for (const id of chosen) target.push({ id });
          plan.skills = chosen;
          return { decided: true };
        },
      };
    },
  };
}
