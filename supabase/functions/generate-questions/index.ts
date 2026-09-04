// Question generator for the Word Summit / Word Lab vocab apps.
//
// The apps are static pages on GitHub Pages, so they cannot hold an Anthropic
// API key. They POST a round's worth of words here; this function calls Claude
// and returns freshly written questions. The key lives in the function's
// environment and never reaches the browser.
//
// Deploy:  supabase functions deploy generate-questions --no-verify-jwt
// Secrets: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

import Anthropic from "npm:@anthropic-ai/sdk@0.71.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-opus-5";
const MAX_WORDS_PER_CALL = 12;
const DAILY_GENERATION_CAP = 160; // hard ceiling on spend; a round is now ~2 chunked calls

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const QUESTION_TYPES = [
  "meaning",   // word -> which definition
  "wordpick",  // definition -> which word
  "syn",       // closest in meaning
  "ant",       // opposite in meaning
  "cloze",     // new sentence with a blank
  "scen",      // which situation is an example of the word
  "analogy",   // A is to B as C is to ___
  "oddone",    // which one does not belong with the others
];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["wordId", "type", "prompt", "options", "answer", "teach", "distractors"],
        properties: {
          wordId: { type: "string", description: "the id of the word this question tests" },
          type: { type: "string", enum: QUESTION_TYPES },
          prompt: {
            type: "string",
            description:
              "The question text. For cloze, the sentence with exactly one ___ blank. For meaning/syn/ant, may be an empty string since the app supplies the framing.",
          },
          // Structured-output schemas reject array size constraints, so the
          // count is stated in the description and enforced client-side.
          options: {
            type: "array",
            items: { type: "string" },
            description:
              "Exactly 4 options for meaning/wordpick/syn/ant/cloze/analogy, or exactly 3 for scen. Include the correct answer among them.",
          },
          answer: {
            type: "string",
            description: "must be character-for-character identical to one entry in options",
          },
          teach: {
            type: "string",
            description:
              "One short sentence shown if the student answers wrong: why the correct answer is the one that fits.",
          },
          distractors: {
            type: "array",
            description:
              "One entry for EVERY option that is not the answer. Used to tell the student why the specific option they picked was wrong.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["option", "why"],
              properties: {
                option: {
                  type: "string",
                  description: "character-for-character identical to one of the wrong options",
                },
                why: {
                  type: "string",
                  description:
                    "One sentence naming what this word actually means and why that does not fit here.",
                },
              },
            },
          },
        },
      },
    },
  },
};


/* A second, much cheaper mode: one model sentence per word, for the word list
   screen. No options, no distractors - just a sentence the student can read. */
const SENTENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sentences"],
  properties: {
    sentences: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["wordId", "sentence"],
        properties: {
          wordId: { type: "string" },
          sentence: {
            type: "string",
            description: "One original sentence, 10-20 words, using the word in its given sense.",
          },
        },
      },
    },
  },
};

function sentenceSystemPrompt(profile: { name: string; age: string; band: string }) {
  const young = profile.band === "upper-elementary";
  return `You write example sentences for ${profile.name}, ${profile.age}, who is building a vocabulary list.

For each word you are given, write ONE sentence that uses it in the sense described. The sentence is there to make the meaning click when he reads back over his word list, so:
- Put the meaning on display. Someone who did not know the word should be able to guess it from the sentence.
- Use the exact word form given where that reads naturally; a simple -s/-ed/-ing inflection is fine when the base form would be awkward.
- Keep it 10 to 20 words, concrete, and about something a child actually encounters - school, family, sport, animals, games, weather.
- ${young ? "Every OTHER word in the sentence must be easy - the kind of vocabulary a strong ten-year-old reads without stopping. The word being taught is the only hard thing in it." : "Keep the surrounding language simpler than the word being taught."}
- Do not define the word inside the sentence ("frugal, which means careful with money, ..."). Show it in use instead.
- Do not reuse any example sentence you are given; write a fresh one.
- Plain ASCII quotes and apostrophes.`;
}

async function generateSentences(client: any, words: any[], profile: any) {
  const lines = words.map((w) =>
    [`- id: ${w.id}`, `  word: ${w.word}`, `  part of speech: ${w.pos}`,
     `  meaning: ${w.meaning}`,
     w.example ? `  a sentence already on file, do not reuse it: ${w.example}` : null,
    ].filter(Boolean).join("\n"));

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SENTENCE_SCHEMA } },
    system: [{ type: "text", text: sentenceSystemPrompt(profile), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content:
      `Write one sentence for each of these ${words.length} words.\n\n${lines.join("\n\n")}\n\nUse each word's exact id.` }],
  });

  if (response.stop_reason === "refusal") return { error: "refusal" };
  let parsed: any = (response as any).parsed_output;
  if (!parsed) {
    const text = response.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    try { parsed = JSON.parse(text); } catch { return { error: "unparseable" }; }
  }
  return { sentences: parsed.sentences ?? [], usage: {
    input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens } };
}

function systemPrompt(profile: { name: string; age: string; goal: string; band: string }) {
  const youngLearner = profile.band === "upper-elementary";

  return `You write vocabulary practice questions for ${profile.name}, ${profile.age}, studying ${profile.goal}.

You will be given a set of words with their definitions, and how the student has performed on each one so far. Write exactly one question per word, choosing the question type that will best deepen that student's understanding of that particular word right now.

DIFFICULTY IS THE POINT. This student's previous practice was reported as too easy: the wrong options were so obviously wrong that she could answer correctly by elimination without knowing the word. Never do that. Calibrate every option set so that:
- Someone who genuinely knows the word picks the right answer confidently and without ambiguity.
- Someone who only half-remembers the word finds at least two options tempting.
- Every wrong option is the same register and sophistication as the answer. Never pad with easy everyday nouns as filler.

Good sources of tempting wrong options: words in the same topic or emotional register that are decisively not the meaning; words commonly confused with the target (sound-alikes, look-alikes, shared roots that mean different things); the exact opposite meaning; the meaning of a different, better-known sense of the same word; a common misconception about the word.

FAIRNESS RULE, which outranks difficulty: exactly one option may be defensible. If a wrong option could be argued to also be correct, replace it. Never use a true synonym of the answer as a wrong option.
${youngLearner ? `
DISTRACTOR VOCABULARY CEILING, which outranks the register rule above. This student collects words far above his own grade, but the WRONG OPTIONS must stay at his level: every wrong option must be a word a strong ten-year-old already recognises. Do not reach for words like "insolvent", "indignation" or "remorse" merely because the target word is hard. If he cannot read three of the four options, a wrong answer teaches him nothing, because the explanation then has to define three more unfamiliar words at him. The challenge must come from whether he knows the TARGET word and can read the context - never from unfamiliar distractors he has no way to rule out.

This is not permission to make the options easy or silly. A familiar word is still a strong distractor when it sits in the same topic, is the exact opposite, or matches a common misunderstanding of the target. For "destitute", avoid "insolvent" (too rare) and "penniless" (too close to be wrong); "greedy", "lonely" and "careful with money" are all familiar yet decisively wrong. Aim every wrong option there.

CALIBRATE TO FAMILIARITY. Each word arrives with this student's history, and the options should tighten as his command of that word grows, rather than tracking how rare the word is in a dictionary:
- Never practised, or recently answered wrong: use familiar, clearly distinct wrong options, so that half-remembering the word plus reading the context is enough to reason his way to the answer.
- Answered correctly a few times (review level 3 or higher, or accuracy above 70 percent): close the gaps - near-misses in the same topic, sound-alikes, the exact opposite - so the question tests precision rather than recognition.
` : ``}

Question types, and when to choose them:
- meaning: word given, pick the definition. Good for a word seen only once or twice.
- wordpick: definition given, pick the word. Good early too, and pairs well with confusable words.
- syn: pick the word closest in meaning. Prompt should be empty; put the target word in the app's hands.
- ant: pick the opposite. ONLY when the word has a real, commonly understood opposite. Otherwise choose another type.
- cloze: write a NEW sentence, different in situation from the example sentence given, with exactly one ___ where the word belongs. The surrounding context must make only the target word fit its meaning, and all wrong options must be the same part of speech and grammatically flawless in the blank, excluded purely on meaning. The target word must not appear anywhere in the sentence.
- scen: "Which of these is an example of ...?" with three short situations. All three must share the same setting so the setting itself gives nothing away; the wrong two are near misses that get the topic right and the essence wrong.
- analogy: "A is to B as C is to ___" using the target word's relationship. Keep the paired words familiar so the difficulty sits in the target word.
- oddone: three or four words of which all but one share something with the target word's meaning. Make the grouping unambiguous.

analogy and oddone are real options, not last resorts. Reach for them whenever the word supports one - especially for a word already asked as meaning, wordpick or cloze. Only skip a type if it genuinely cannot be written well for this word.

Bias toward the types that test USE and understanding (cloze, scen, analogy, syn, ant) over bare definition matching, especially for words the student has already answered correctly a few times. For a word the student keeps getting wrong, choose a type that teaches: cloze or scen with a strongly disambiguating context.

Where a word arrives with a synonym or antonym the student has already been shown, do not simply reuse it as the correct answer to a synonym or antonym question - that tests recall of the sheet rather than understanding. Use a different but equally correct word, or choose another question type.

NEVER REPEAT YOURSELF. Some words arrive with a list of what has already been
asked about them. That list is the single most important constraint here: this
student practises the same word many times and complains when the questions feel
the same. For any word with such a list you MUST:
- choose a type that is not in the list;
- set the question somewhere unrelated to the situations already used - a new
  place, a new activity, new people;
- pick wrong options that are not the ones already used, unless a repeat is
  genuinely the best possible distractor;
- avoid echoing distinctive nouns from the earlier questions.
Each word also arrives with a suggested domain. Use it as the setting for any
sentence or scenario you write, unless the word makes that impossible.

Every question must be original. Do not copy sentences from the input. Write at a reading level the student can handle, keeping the difficulty in the vocabulary being tested rather than in the surrounding words.

FEEDBACK. Two fields are shown only after a wrong answer, and together they are the most valuable teaching in the app:

- "teach": one sentence on why the correct answer is the one that fits. Not a restatement of the definition.
- "distractors": one entry for EVERY option that is not the answer, so that whichever wrong option the student picked, the app can tell her why that particular word was wrong. Each "why" names what that word actually means and why it does not work here — for example, for a blank about a rumor spreading panic, the entry for "alleviate" would say that alleviate means to ease or lessen something, which is the opposite of what a spreading rumor does. Address the student's likely reasoning: if a wrong option is a sound-alike, say so; if it is the opposite, say so; if it is close but describes a different situation, say what that situation would be. Keep each to one sentence and never simply repeat the correct answer's meaning.

Every wrong option must have a distractors entry, and the "option" text must match that option exactly.

Use plain ASCII quotes and apostrophes throughout.`;
}

const DOMAINS = [
  "school or classroom", "a sports team or a game", "cooking or a family meal",
  "hiking, camping or the outdoors", "space or a science experiment",
  "history or an old story", "music or theatre", "a trip or journey",
  "animals or a pet", "computers, phones or games", "weather or the seasons",
  "a neighbourhood or city street", "a job or running a small business",
  "friends and a disagreement between them",
];

/* What the student has already been asked about this word. The last two types
   are ruled out outright; the situations and options are listed so the model can
   steer away from them. */
function recentLines(recent: any[]): string | null {
  const list = (recent || []).filter((r) => r && r.type);
  if (!list.length) return null;
  const shown = list.slice(-3);
  const banned = [...new Set(list.slice(-2).map((r) => r.type))];
  const items = shown.map((r) => {
    const bits = [r.type];
    if (r.gist) bits.push(`asked as: "${String(r.gist).replace(/"/g, "'")}"`);
    if (r.opts && r.opts.length) bits.push(`wrong options used: ${r.opts.join(", ")}`);
    return `    * ${bits.join(" | ")}`;
  });
  return [
    `  ALREADY ASKED - do not repeat the type, the situation, or the wrong options:`,
    ...items,
    `  do NOT use these types for this word: ${banned.join(", ")}`,
  ].join("\n");
}

function userPrompt(words: any[]) {
  const lines = words.map((w) => {
    const h = w.history || {};
    const seen = h.seen || 0;
    let status: string;
    if (!seen) {
      status = "brand new, never practiced";
    } else {
      const acc = seen ? Math.round((100 * (h.correct || 0)) / seen) : 0;
      status = `practiced ${seen}x, ${acc}% correct, currently at review level ${h.box || 1} of 5`;
    }
    return [
      `- id: ${w.id}`,
      `  word: ${w.word}`,
      `  part of speech: ${w.pos}`,
      `  meaning: ${w.meaning}`,
      w.example ? `  example already shown to the student: ${w.example}` : null,
      w.syn ? `  synonym the student has already been shown: ${w.syn}` : null,
      w.ant ? `  antonym the student has already been shown: ${w.ant}` : null,
      `  student history: ${status}`,
      `  suggested domain for the setting: ${DOMAINS[Math.floor(Math.random() * DOMAINS.length)]}`,
      recentLines(w.recent),
    ].filter(Boolean).join("\n");
  });

  return `Write one question for each of these ${words.length} words.\n\n${lines.join("\n\n")}\n\nReturn one question per word, in the same order, using each word's exact id.`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  try {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "not_configured" }, 503);

    const body = await req.json().catch(() => null);
    const words = body?.words;
    if (!Array.isArray(words) || words.length === 0) {
      return json({ error: "no_words" }, 400);
    }
    if (words.length > MAX_WORDS_PER_CALL) {
      return json({ error: "too_many_words", max: MAX_WORDS_PER_CALL }, 400);
    }

    const profile = {
      name: String(body?.profile?.name || "a student"),
      age: String(body?.profile?.age || "a middle schooler"),
      goal: String(body?.profile?.goal || "vocabulary"),
      band: String(body?.profile?.band || "middle-school"),
    };

    // Hard daily cap so an exposed endpoint can't run up the API bill.
    const sbUrl = Deno.env.get("SUPABASE_URL");
    const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (sbUrl && sbKey) {
      const admin = createClient(sbUrl, sbKey);
      const day = new Date().toISOString().slice(0, 10);
      const { data: usage } = await admin
        .from("gen_usage").select("count").eq("day", day).maybeSingle();
      const used = usage?.count ?? 0;
      if (used >= DAILY_GENERATION_CAP) return json({ error: "daily_cap" }, 429);
      await admin.from("gen_usage")
        .upsert({ day, count: used + 1 }, { onConflict: "day" });
    }

    const client = new Anthropic({ apiKey });

    if (body?.mode === "sentences") {
      const out = await generateSentences(client, words, profile);
      if (out.error) return json({ error: out.error }, 502);
      return json(out);
    }

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: SCHEMA },
      },
      system: [{ type: "text", text: systemPrompt(profile),
                 cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userPrompt(words) }],
    });

    if (response.stop_reason === "refusal") {
      return json({ error: "refusal" }, 502);
    }

    let parsed: any = (response as any).parsed_output;
    if (!parsed) {
      const text = response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      try {
        parsed = JSON.parse(text);
      } catch {
        return json({ error: "unparseable" }, 502);
      }
    }

    return json({
      questions: parsed.questions ?? [],
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return json({ error: "bad_key" }, 502);
    if (err instanceof Anthropic.RateLimitError) return json({ error: "rate_limited" }, 429);
    if (err instanceof Anthropic.APIError) {
      return json({ error: "api_error", status: err.status, detail: err.message }, 502);
    }
    return json({ error: "unexpected", detail: String(err && (err as Error).message || err) }, 500);
  }
});
