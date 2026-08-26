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
const DAILY_GENERATION_CAP = 80; // hard ceiling on spend; ~$7/day worst case

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
        required: ["wordId", "type", "prompt", "options", "answer", "teach"],
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
              "One short sentence shown if the student answers wrong: what the word really means or how to tell it apart from the tempting wrong answer.",
          },
        },
      },
    },
  },
};

function systemPrompt(profile: { name: string; age: string; goal: string }) {
  return `You write vocabulary practice questions for ${profile.name}, ${profile.age}, studying ${profile.goal}.

You will be given a set of words with their definitions, and how the student has performed on each one so far. Write exactly one question per word, choosing the question type that will best deepen that student's understanding of that particular word right now.

DIFFICULTY IS THE POINT. This student's previous practice was reported as too easy: the wrong options were so obviously wrong that she could answer correctly by elimination without knowing the word. Never do that. Calibrate every option set so that:
- Someone who genuinely knows the word picks the right answer confidently and without ambiguity.
- Someone who only half-remembers the word finds at least two options tempting.
- Every wrong option is the same register and sophistication as the answer. Never pad with easy everyday nouns as filler.

Good sources of tempting wrong options: words in the same topic or emotional register that are decisively not the meaning; words commonly confused with the target (sound-alikes, look-alikes, shared roots that mean different things); the exact opposite meaning; the meaning of a different, better-known sense of the same word; a common misconception about the word.

FAIRNESS RULE, which outranks difficulty: exactly one option may be defensible. If a wrong option could be argued to also be correct, replace it. Never use a true synonym of the answer as a wrong option.

Question types, and when to choose them:
- meaning: word given, pick the definition. Good for a word seen only once or twice.
- wordpick: definition given, pick the word. Good early too, and pairs well with confusable words.
- syn: pick the word closest in meaning. Prompt should be empty; put the target word in the app's hands.
- ant: pick the opposite. ONLY when the word has a real, commonly understood opposite. Otherwise choose another type.
- cloze: write a NEW sentence, different in situation from the example sentence given, with exactly one ___ where the word belongs. The surrounding context must make only the target word fit its meaning, and all wrong options must be the same part of speech and grammatically flawless in the blank, excluded purely on meaning. The target word must not appear anywhere in the sentence.
- scen: "Which of these is an example of ...?" with three short situations. All three must share the same setting so the setting itself gives nothing away; the wrong two are near misses that get the topic right and the essence wrong.
- analogy: "A is to B as C is to ___" using the target word's relationship. Only when the relationship is clean and a middle schooler can see it. Keep the paired words familiar.
- oddone: three or four words of which all but one share something with the target word's meaning. Only when the grouping is unambiguous.

Bias toward the types that test USE and understanding (cloze, scen, analogy, syn, ant) over bare definition matching, especially for words the student has already answered correctly a few times. For a word the student keeps getting wrong, choose a type that teaches: cloze or scen with a strongly disambiguating context.

Every question must be original. Do not copy sentences from the input. Write at a reading level the student can handle, keeping the difficulty in the vocabulary being tested rather than in the surrounding words.

The "teach" field is shown only after a wrong answer. Make it one useful sentence that corrects the most likely misunderstanding, not a restatement of the definition.

Use plain ASCII quotes and apostrophes throughout.`;
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
      `  student history: ${status}`,
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
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: SCHEMA },
      },
      system: systemPrompt(profile),
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
