/**
 * ===========================================================================
 *  jevdesk-support-router - Express backend
 * ===========================================================================
 *
 *  What this file does, in order:
 *    1. Loads the API key from the .env file.
 *    2. Makes the key available to the AI SDK's Vercel AI Gateway provider.
 *    3. Defines the three "questions" we ask Jev about every ticket.
 *    4. Serves the static frontend from ./public.
 *    5. Exposes one endpoint - POST /api/triage - that sends a customer
 *       message to Jev and returns the answers as plain JSON.
 *
 *  Everything below is heavily commented because the whole point of this
 *  project is to learn how Jev's decision-model API works.
 * ===========================================================================
 */

import express from 'express';
import dotenv from 'dotenv';
// The AI SDK's Jev entry point. The API is still "experimental", hence the
// `experimental_evaluate` name. We alias it to `evaluate` for readability.
import { experimental_evaluate as evaluate } from 'ai';

// ---------------------------------------------------------------------------
// 1. Load environment variables
// ---------------------------------------------------------------------------
// dotenv reads the .env file in the project root and copies every KEY=VALUE
// line into process.env. After this line, process.env.VERCEL_AI_GATEWAY_KEY
// holds the key from your .env file.
//
// Note on ordering: ES module imports are hoisted and run before this line,
// but that is safe here - the AI SDK's Gateway provider reads its key lazily,
// once per request, instead of at import time.
// `quiet: true` just hides dotenv's "injected env (2) from .env" banner.
dotenv.config({ quiet: true });

// ---------------------------------------------------------------------------
// 2. Hand the key to the AI SDK's Gateway provider
// ---------------------------------------------------------------------------
// jevdesk-support-router stores the key as VERCEL_AI_GATEWAY_KEY (that is the
// name used in .env and .env.example). Internally, the AI SDK's Vercel AI
// Gateway provider authenticates with the environment variable
// AI_GATEWAY_API_KEY. Rather than asking you to remember two names, we mirror
// the value across once at startup. Because the SDK resolves the key lazily,
// setting it here happens before the first request is ever sent.
if (!process.env.AI_GATEWAY_API_KEY && process.env.VERCEL_AI_GATEWAY_KEY) {
  process.env.AI_GATEWAY_API_KEY = process.env.VERCEL_AI_GATEWAY_KEY;
}

if (!process.env.VERCEL_AI_GATEWAY_KEY) {
  console.warn(
    '[jevdesk-support-router] No VERCEL_AI_GATEWAY_KEY found. Copy ' +
      '.env.example to .env and paste your key before sending a ticket, ' +
      'otherwise Jev calls will fail.',
  );
}

// The Gateway model ID. Asking for `'typesafe-ai/jev'` means:
// "use the `jev` model from the `typesafe-ai` provider".
// Passing a *string* is enough - the AI SDK resolves strings through
// Vercel AI Gateway automatically.
const MODEL_ID = 'typesafe-ai/jev';

// Any answer whose confidence is below this value gets flagged in the UI as
// "Low confidence - needs human review". We send it to the frontend so both
// sides always agree on the threshold.
const LOW_CONFIDENCE_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// 3. The questions we ask Jev
// ---------------------------------------------------------------------------
// Jev is NOT a chat model: it does not write prose. You give it:
//   * `state`     - the evidence, here the raw customer message.
//   * `questions` - a named map of typed questions about that state.
// and it returns one typed answer per question.
//
// There are exactly three question types:
//
//   choice  -> pick one option. `criteria` is a MAP of
//              { optionName: "when to pick this option" }. Jev returns the
//              chosen option key plus a full probability distribution, so the
//              probability of the chosen option is its confidence.
//
//   score   -> pick a point on an ordered scale. `criteria` is an ARRAY of
//              ordered levels (at least 2) indexed from 0. Supplying 5 levels
//              gives a "1 to 5" scale, and Jev's answer is a FRACTIONAL
//              position in [0, 4] plus a distribution over the levels. We add
//              1 (see normaliseTriage below) so humans see the 1-5 scale.
//
//   boolean -> yes/no. Jev returns `probability`, which is P(true) in [0, 1].
//              That is not "confidence in the answer": for a "No" answer the
//              confidence in that answer is (1 - probability).
const URGENCY_LEVELS = [
  '1 - No urgency: a question, suggestion or nice-to-have. Nothing is blocked.',
  '2 - Minor: a small inconvenience with an easy workaround.',
  '3 - Moderate: a real problem that is annoying, but the customer can keep working.',
  '4 - High: a core feature is broken or money is at risk; the workaround is painful.',
  '5 - Critical: total outage, security issue, or the customer is threatening to leave now.',
];

const QUESTIONS = {
  // --- Q1: which team owns this ticket? (choice) ---------------------------
  // The keys of `criteria` are the only values Jev may answer with. Give each
  // key a short description so Jev understands the boundary between
  // neighbouring options.
  department: {
    type: 'choice',
    instructions: 'Which team should own and answer this support ticket?',
    criteria: {
      billing:
        'Payments, invoices, charges, refunds, subscriptions, plans and seat changes.',
      technical:
        'Bugs, errors, crashes, outages, performance, integrations, API and setup problems.',
      sales:
        'Pre-sales questions, pricing, quotes, upgrades, trials, and enterprise or contract enquiries.',
      general:
        'Anything that does not clearly belong to billing, technical or sales: feedback, account questions, how-to, unclear or mixed requests.',
    },
  },

  // --- Q2: how urgent is it? (score) ---------------------------------------
  // 5 ordered levels = a 1-5 scale. Jev answers with a fractional position in
  // [0, 4] plus a probability for each level.
  urgency: {
    type: 'score',
    instructions:
      "How urgent is this ticket, based on the customer's problem and their tone?",
    criteria: URGENCY_LEVELS,
  },

  // --- Q3: is the customer asking for money back? (boolean) ----------------
  // Jev answers with P(true). The optional `criteria` documents what true and
  // false mean for this question, which sharpens the boundary.
  refund_requested: {
    type: 'boolean',
    instructions:
      'Is the customer explicitly asking for a refund, a charge reversal or their money back?',
    criteria: {
      true: 'They ask for a refund, a chargeback, a reversal, or their money back.',
      false:
        'They do not ask for money back. Reporting a billing problem or asking about an invoice is not a refund request by itself.',
    },
  },
};

// ---------------------------------------------------------------------------
// 4. Turn Jev's raw answers into something the frontend can render directly
// ---------------------------------------------------------------------------
// Jev returns answers that are precise but a little awkward for a UI:
//   choice  -> { type: 'choice',  choice: 'billing', probabilities: {...} }
//   score   -> { type: 'score',   score: 2.4, probabilities: { '0': .., '4': .. } }
//   boolean -> { type: 'boolean', probability: 0.81 }
// Here we flatten that into plain objects with a single `confidence` field
// (a number between 0 and 1, or null when the model did not send a
// distribution). The frontend only has to compare `confidence` against the
// low-confidence threshold.

/** Round to 2 decimals so the JSON stays readable. */
const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Probability of one outcome inside a distribution, or null when the provider
 * did not send probabilities at all.
 */
function probabilityOf(probabilities, key) {
  const value = probabilities?.[key];
  return typeof value === 'number' ? value : null;
}

/** Confidence = probability of the answer that was actually given. */
function confidenceOf(probability) {
  if (typeof probability !== 'number') return null;
  return probability;
}

function normaliseTriage(answers) {
  // ---- department (choice) ----------------------------------------------
  const departmentAnswer = answers.department;
  const department = {
    answer: departmentAnswer.choice,
    // The Gateway returns the whole distribution, so the confidence is simply
    // the probability Jev assigned to the option it picked.
    confidence: confidenceOf(
      probabilityOf(departmentAnswer.probabilities, departmentAnswer.choice),
    ),
    probabilities: departmentAnswer.probabilities ?? null,
  };

  // ---- urgency (score) ---------------------------------------------------
  const urgencyAnswer = answers.urgency;
  // `score` is a fractional index in [0, levels - 1]. Adding 1 turns it into
  // the human-facing 1-5 scale; we also round it to the nearest whole level so
  // the UI can light up a bar.
  const urgencyLevelCount = URGENCY_LEVELS.length;
  const urgencyLevelIndex = Math.min(
    Math.max(Math.round(urgencyAnswer.score), 0),
    urgencyLevelCount - 1,
  );
  const urgency = {
    // 1-5, whole number, for the bar and the badge.
    value: urgencyLevelIndex + 1,
    // The exact fractional position, also on the 1-5 scale (e.g. 3.4).
    exact: round2(urgencyAnswer.score + 1),
    max: urgencyLevelCount,
    confidence: confidenceOf(
      probabilityOf(
        urgencyAnswer.probabilities,
        String(urgencyLevelIndex), // score distributions are keyed '0'..'4'
      ),
    ),
    // Re-key the distribution from 0-based indices to the 1-5 scale.
    probabilities: urgencyAnswer.probabilities
      ? Object.fromEntries(
          Object.entries(urgencyAnswer.probabilities).map(([index, p]) => [
            String(Number(index) + 1),
            p,
          ]),
        )
      : null,
  };

  // ---- refund_requested (boolean) ---------------------------------------
  const refundAnswer = answers.refund_requested;
  const pTrue = refundAnswer.probability;
  const refundRequested = {
    // P(true) >= 0.5 means "more likely than not".
    requested: pTrue >= 0.5,
    // P(true), reported separately because it is the number Jev actually
    // produces and it is useful when you want to tune your own threshold.
    probability: pTrue,
    // Confidence in the *displayed* answer: P(true) for "Yes", P(false) for
    // "No". This is the number we compare against 70%.
    confidence: confidenceOf(pTrue >= 0.5 ? pTrue : 1 - pTrue),
  };

  return { department, urgency, refundRequested };
}

/** True when any of the three answers is below the review threshold. */
function needsHumanReview(triage) {
  return [triage.department, triage.urgency, triage.refundRequested].some(
    (item) =>
      item.confidence === null || item.confidence < LOW_CONFIDENCE_THRESHOLD,
  );
}

// ---------------------------------------------------------------------------
// 5. Error handling
// ---------------------------------------------------------------------------
// Jev calls can fail for a handful of predictable reasons. This helper turns
// whatever the SDK threw into a short HTTP status + message the frontend can
// display, instead of leaking a raw stack trace to the browser.
function describeError(error) {
  const name = error?.name ?? 'Error';
  const raw = error?.message ?? 'Unknown error';

  // Bad/expired/missing AI Gateway key.
  if (
    name.includes('GatewayAuthentication') ||
    name.includes('LoadAPIKey') ||
    name.includes('Authentication')
  ) {
    return {
      status: 401,
      code: 'gateway_auth_error',
      message: 'Vercel AI Gateway rejected the API key.',
      hint: 'Check VERCEL_AI_GATEWAY_KEY in your .env file, then restart the server.',
    };
  }

  // We sent Jev something it cannot accept (e.g. empty state, bad question).
  if (name.includes('InvalidArgument') || name.includes('UnsupportedQuestion')) {
    return { status: 400, code: 'invalid_request', message: raw };
  }

  // 'typesafe-ai/jev' is not available to this key/team.
  if (name.includes('UnsupportedModel') || name.includes('NoSuchModel')) {
    return {
      status: 502,
      code: 'model_unavailable',
      message: `The model "${MODEL_ID}" could not be resolved.`,
      hint: 'Check that your AI Gateway key can access typesafe-ai/jev.',
    };
  }

  // The key authenticated, but the Gateway refused to serve the request -
  // for example the Vercel team has no credit card on file, a spend limit was
  // reached, or the model is not allowed for this team.
  if (error?.statusCode === 403 || error?.cause?.statusCode === 403) {
    return {
      status: 502,
      code: 'gateway_forbidden',
      message: `Vercel AI Gateway refused the request: ${raw}`,
      hint:
        'Your key is valid, but the team that owns it cannot send requests yet. ' +
        'Add a credit card and check the model allowlist in the Vercel dashboard ' +
        '(vercel.com -> AI Gateway).',
    };
  }

  // The Gateway answered with an HTTP error (rate limit, upstream failure...).
  if (error?.statusCode) {
    return {
      status: 502,
      code: 'gateway_error',
      message: `Vercel AI Gateway returned HTTP ${error.statusCode}: ${raw}`,
    };
  }

  return { status: 502, code: 'jev_call_failed', message: raw };
}

// ---------------------------------------------------------------------------
// 6. The Express app
// ---------------------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON request bodies so `req.body.message` is available.
app.use(express.json());

// Serve the frontend. `import.meta.dirname` is the folder holding server.js,
// so ./public/index.html is reachable at http://localhost:3000/.
app.use(express.static(import.meta.dirname + '/public'));

// ---------------------------------------------------------------------------
// 7. POST /api/triage - the one and only endpoint
// ---------------------------------------------------------------------------
// Request body:  { "message": "the customer message to classify" }
// Success:       { ok: true, triage: {...}, lowConfidenceThreshold, meta }
// Failure:       { ok: false, error: { code, message, hint? } }
app.post('/api/triage', async (req, res) => {
  // 7a. Validate the input before spending a Jev call on it.
  const message =
    typeof req.body?.message === 'string' ? req.body.message.trim() : '';

  if (!message) {
    return res.status(400).json({
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'Request body must be JSON with a non-empty "message" field.',
      },
    });
  }

  if (!process.env.VERCEL_AI_GATEWAY_KEY) {
    return res.status(500).json({
      ok: false,
      error: {
        code: 'missing_api_key',
        message: 'VERCEL_AI_GATEWAY_KEY is not set.',
        hint: 'Copy .env.example to .env, paste your key, then restart the server.',
      },
    });
  }

  try {
    const startedAt = Date.now();

    // 7b. The actual Jev call. This is the whole decision-model API in one
    // call: one piece of state in, one typed answer per question out.
    const result = await evaluate({
      model: MODEL_ID, // 'typesafe-ai/jev' via Vercel AI Gateway
      state: { message }, // the evidence Jev reasons over
      questions: QUESTIONS, // the three typed questions defined above
    });

    // 7c. Flatten the answers and hand them to the browser.
    const triage = normaliseTriage(result.answers);

    res.json({
      ok: true,
      triage,
      // Sent along so the frontend and backend share one threshold.
      lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD,
      needsHumanReview: needsHumanReview(triage),
      meta: {
        modelId: result.response.modelId,
        durationMs: Date.now() - startedAt,
        usage: result.usage, // inputTokens / outputTokens / totalTokens
        warnings: result.warnings,
      },
    });
  } catch (error) {
    // 7d. Something went wrong - log the full error server-side, return a
    // short, actionable message to the browser.
    console.error('[jevdesk-support-router] /api/triage failed:', error);

    const { status, code, message: errorMessage, hint } = describeError(error);
    res.status(status).json({
      ok: false,
      error: { code, message: errorMessage, ...(hint ? { hint } : {}) },
    });
  }
});

// Malformed JSON in the request body never reaches the route above, so catch
// it here and answer with JSON too (instead of Express' default HTML page).
app.use((error, req, res, next) => {
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Request body is not valid JSON.',
      },
    });
  }
  next(error);
});

// ---------------------------------------------------------------------------
// 8. Start listening
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`jevdesk-support-router running at http://localhost:${PORT}`);
  console.log(`  model: ${MODEL_ID} (via Vercel AI Gateway)`);
  console.log(
    `  key:   ${process.env.VERCEL_AI_GATEWAY_KEY ? 'loaded from .env' : 'MISSING - set VERCEL_AI_GATEWAY_KEY'}`,
  );
});
