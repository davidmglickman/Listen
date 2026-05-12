import type { AudioSourceKind, TranscriptSegment } from "@listen/shared";

export interface ConversationTurn {
  source: AudioSourceKind;
  speakerId: number | null;
  speakerLabel: string | null;
  text: string;
  startedAt: string;
  endedAt: string;
  segmentCount: number;
}

const MAX_TURN_GAP_MS = 12_000;
const MAX_TURN_CHARS = 700;
const MIN_QUERY_TOKEN_LENGTH = 3;
const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "before",
  "being",
  "call",
  "from",
  "have",
  "into",
  "just",
  "meeting",
  "more",
  "that",
  "them",
  "they",
  "this",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
]);

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function toSpeakerKey(segment: Pick<TranscriptSegment, "source" | "speakerId" | "speakerLabel">): string {
  if (typeof segment.speakerId === "number") {
    return `${segment.source}:id:${segment.speakerId}`;
  }

  if (segment.speakerLabel?.trim()) {
    return `${segment.source}:label:${segment.speakerLabel.trim().toLowerCase()}`;
  }

  return `${segment.source}:unknown`;
}

function getGapMs(previousEndedAt: string, nextStartedAt: string): number {
  const previousTime = Date.parse(previousEndedAt);
  const nextTime = Date.parse(nextStartedAt);
  if (!Number.isFinite(previousTime) || !Number.isFinite(nextTime)) {
    return 0;
  }

  return Math.max(0, nextTime - previousTime);
}

function shouldStartNewTurn(previousTurn: ConversationTurn, segment: TranscriptSegment): boolean {
  if (previousTurn.source !== segment.source) {
    return true;
  }

  if (toSpeakerKey(previousTurn) !== toSpeakerKey(segment)) {
    return true;
  }

  if (getGapMs(previousTurn.endedAt, segment.createdAt) > MAX_TURN_GAP_MS) {
    return true;
  }

  return previousTurn.text.length >= MAX_TURN_CHARS;
}

function createTurn(segment: TranscriptSegment): ConversationTurn {
  return {
    source: segment.source,
    speakerId: typeof segment.speakerId === "number" ? segment.speakerId : null,
    speakerLabel: segment.speakerLabel?.trim() || null,
    text: normalizeText(segment.text),
    startedAt: segment.createdAt,
    endedAt: segment.createdAt,
    segmentCount: 1,
  };
}

function appendTurnText(existingText: string, nextText: string): string {
  const trimmedNextText = normalizeText(nextText);
  if (!trimmedNextText) {
    return existingText;
  }

  if (!existingText) {
    return trimmedNextText;
  }

  if (existingText.endsWith(trimmedNextText)) {
    return existingText;
  }

  const joiner = /[.!?]$/.test(existingText) ? " " : ". ";
  return `${existingText}${joiner}${trimmedNextText}`;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_QUERY_TOKEN_LENGTH)
    .filter((token) => !STOP_WORDS.has(token));
}

function scoreTurn(turn: ConversationTurn, queryTokens: Set<string>): number {
  if (!queryTokens.size) {
    return 0;
  }

  const tokens = new Set(tokenize(`${turn.speakerLabel ?? ""} ${turn.text}`));
  let score = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) {
      score += 1;
    }
  }

  return score;
}

export function buildConversationTurns(transcript: TranscriptSegment[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];

  for (const segment of transcript) {
    const normalizedText = normalizeText(segment.text);
    if (!normalizedText) {
      continue;
    }

    const normalizedSegment: TranscriptSegment = {
      ...segment,
      text: normalizedText,
      speakerLabel: segment.speakerLabel?.trim() || null,
      speakerId: typeof segment.speakerId === "number" ? segment.speakerId : null,
    };
    const previousTurn = turns.at(-1);

    if (!previousTurn || shouldStartNewTurn(previousTurn, normalizedSegment)) {
      turns.push(createTurn(normalizedSegment));
      continue;
    }

    previousTurn.text = appendTurnText(previousTurn.text, normalizedSegment.text);
    previousTurn.endedAt = normalizedSegment.createdAt;
    previousTurn.segmentCount += 1;
  }

  return turns;
}

export function selectQuestionRelevantTurns(
  transcript: TranscriptSegment[],
  question: string,
  options?: { recentCount?: number; relevantCount?: number },
): ConversationTurn[] {
  const turns = buildConversationTurns(transcript);
  if (!turns.length) {
    return [];
  }

  const recentCount = options?.recentCount ?? 8;
  const relevantCount = options?.relevantCount ?? 12;
  const selectedIndexes = new Set<number>();

  for (let index = Math.max(0, turns.length - recentCount); index < turns.length; index += 1) {
    selectedIndexes.add(index);
  }

  const queryTokens = new Set(tokenize(question));
  const rankedTurns = turns
    .map((turn, index) => ({
      index,
      score: scoreTurn(turn, queryTokens),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, relevantCount);

  for (const item of rankedTurns) {
    selectedIndexes.add(item.index);
  }

  return [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => turns[index]);
}