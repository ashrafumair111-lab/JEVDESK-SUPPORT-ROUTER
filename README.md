# jevdesk-support-router

**jevdesk-support-router** is a small support-ticket triage tool. Paste a
customer message, click **Analyze with Jev**, and it answers three questions
about it:

| Question | Jev question type | Shown as |
| --- | --- | --- |
| `department` | `choice` | Which team owns the ticket (billing / technical / sales / general) + confidence % |
| `urgency` | `score` | A 1–5 urgency score + a small bar + confidence % |
| `refund_requested` | `boolean` | Yes / No + confidence % |

If any answer's confidence is below **70%**, the card gets a
`⚠️ Low confidence — needs human review` label so a human knows to check it
before acting on it.

This project exists to show how Jev's **decision-model API** works. Jev is not a chat
model: it does not write prose. You hand it some state and a set of *typed*
questions, and it hands back one typed answer per question — with probabilities
that your own code can branch on.

---

## How it works

```
Browser (plain HTML/CSS/JS)
        │  POST /api/triage  { "message": "..." }
        ▼
Express server (server.js)
        │  experimental_evaluate({ model: 'typesafe-ai/jev', state, questions })
        ▼
Vercel AI SDK  ──►  Vercel AI Gateway  ──►  Jev (TypeSafe AI)
        ▲
        │  { department: {choice, probabilities}, urgency: {score, probabilities},
        │    refund_requested: {probability} }
        ▼
server.js flattens the answers and returns JSON
        ▼
Browser paints the three cards
```

The API key never reaches the browser: only the Express server talks to the
Gateway.

---

## Prerequisites

- **Node.js 22 or newer** (the AI SDK requires it) — check with `node --version`
- A **Vercel account**, to create an AI Gateway API key

---

## 1. Get a Vercel AI Gateway key

1. Sign in at [vercel.com](https://vercel.com).
2. Open the **AI Gateway** section of your dashboard.
3. Go to **API Keys** and click **Create key** (name it something like `jevdesk-support-router`).
4. Copy the key — it starts with `vck_`. You will only see it once.

> **Heads-up:** Jev itself is free, but AI Gateway still requires a **valid
> credit card on the team that owns the key** before it will serve requests.
> Without one, every call fails with
> `403 customer_verification_required` — *"AI Gateway requires a valid credit
> card on file to service requests"*. This app turns that into a readable
> message with a hint about the card, instead of a raw stack trace.

---

## 2. Install and configure

```bash
npm install
```

Create your local env file by copying the example:

```bash
# macOS / Linux
cp .env.example .env

# Windows (PowerShell)
Copy-Item .env.example .env
```

Then open `.env` and paste your key:

```dotenv
VERCEL_AI_GATEWAY_KEY=vck_your_real_key_here
PORT=3000
```

---

## 3. Run it

```bash
npm start
```

Then open <http://localhost:3000>, paste a customer message (or click
**Load sample**), and press **Analyze with Jev**.

`npm run dev` does the same thing with Node's `--watch` flag, so the server
restarts automatically when you edit `server.js`.

---

## ⚠️ Never commit your `.env` file

The real `.env` file contains a live API key. It is already listed in
`.gitignore`, keep it that way:

```
.env
node_modules/
```

Only `.env.example` — which contains a placeholder — belongs in git. If you
ever commit a key by accident, treat it as compromised: **delete it in the
Vercel dashboard and create a new one**.

---

## Project structure

```
jevdesk-support-router/
├── server.js          Express backend + the Jev call (heavily commented)
├── public/
│   └── index.html     The whole frontend: markup, CSS and JS in one file
├── .env               Your real key (git-ignored)
├── .env.example       Template showing which variables are needed
├── .gitignore         Keeps .env and node_modules out of git
├── package.json       Dependencies and npm scripts
└── README.md          You are here
```

---

## The API

### `POST /api/triage`

Request:

```json
{ "message": "Your nightly sync keeps failing with a 502 and I want a refund." }
```

Successful response:

```json
{
  "ok": true,
  "triage": {
    "department": {
      "answer": "technical",
      "confidence": 0.91,
      "probabilities": { "technical": 0.91, "billing": 0.06, "general": 0.02, "sales": 0.01 }
    },
    "urgency": {
      "value": 4,
      "exact": 4.3,
      "max": 5,
      "confidence": 0.62,
      "probabilities": { "1": 0.01, "2": 0.02, "3": 0.08, "4": 0.62, "5": 0.27 }
    },
    "refundRequested": {
      "requested": true,
      "probability": 0.88,
      "confidence": 0.88
    }
  },
  "lowConfidenceThreshold": 0.7,
  "needsHumanReview": true,
  "meta": {
    "modelId": "typesafe-ai/jev",
    "durationMs": 812,
    "usage": { "inputTokens": 421, "outputTokens": 37, "totalTokens": 458 },
    "warnings": []
  }
}
```

Failure response (status is `400`, `401`, `500` or `502` depending on the cause):

```json
{
  "ok": false,
  "error": {
    "code": "gateway_auth_error",
    "message": "Vercel AI Gateway rejected the API key.",
    "hint": "Check VERCEL_AI_GATEWAY_KEY in your .env file, then restart the server."
  }
}
```

---

## How Jev's decision-model API works

The whole call looks like this (see `server.js` for the real thing):

```js
import { experimental_evaluate as evaluate } from 'ai';

const result = await evaluate({
  model: 'typesafe-ai/jev',   // a plain string resolves via Vercel AI Gateway
  state: { message },         // the evidence: a string, object or array
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should own and answer this support ticket?',
      criteria: { billing: 'Payments and refunds', technical: 'Bugs and outages' },
    },
    urgency: {
      type: 'score',
      instructions: 'How urgent is this ticket?',
      criteria: ['Not urgent', 'Minor', 'Moderate', 'High', 'Critical'],
    },
    refund_requested: {
      type: 'boolean',
      instructions: 'Is the customer asking for money back?',
    },
  },
});

result.answers.department.choice;               // 'technical'
result.answers.department.probabilities.billing; // 0.06
result.answers.urgency.score;                    // 0.0 – 4.0 (levels are 0-indexed!)
result.answers.refund_requested.probability;     // P(true), 0.88
```

### The three question types

| `type` | You provide | Jev answers with |
| --- | --- | --- |
| `choice` | `criteria`: a **map** of `{ optionName: "when to pick this option" }` (non-empty) | `{ type: 'choice', choice, probabilities }` — the selected key, plus a full distribution over all options |
| `score` | `criteria`: an **array** of ordered levels, at least 2, indexed from `0` | `{ type: 'score', score, probabilities }` — `score` is a **fractional position** in `[0, levels - 1]`, and `probabilities` is keyed `'0'`, `'1'`, … |
| `boolean` | `criteria` is optional (`{ true, false }` descriptions) | `{ type: 'boolean', probability }` — `probability` is **P(true)** in `[0, 1]` |

### Three details that surprised me

1. **A "choice" uses a `criteria` map, not an `options` array.** The keys are
   the allowed answers, the values describe when each key applies. This
   project's department question is a choice with the keys `billing`,
   `technical`, `sales` and `general`.
2. **A "score" of 1–5 is a 0-indexed scale of 5 levels.** Ask for 5 `criteria`
   levels and Jev answers with a position in `[0, 4]`. `server.js` adds 1 to
   every score so the UI can show 1–5, and keeps the exact fractional value
   (e.g. `4.3`) in the response.
3. **A boolean answer is `P(true)`, not "confidence".** If `P(true) = 0.88`,
   the answer is Yes with 88% confidence. For a No answer at `P(true) = 0.12`,
   the confidence in that displayed answer is `1 - 0.12 = 88%`. `server.js`
   does that conversion for you.

### Confidence and the low-confidence badge

- **choice** — confidence = the probability Jev assigned to the option it picked.
- **score** — confidence = the probability of the nearest whole level.
- **boolean** — confidence = `P(true)` if the answer is Yes, `1 - P(true)` if No.

Anything below `LOW_CONFIDENCE_THRESHOLD` (`0.7`, i.e. 70%) is flagged in the UI
as needing human review. The threshold lives in `server.js` and is sent to the
browser with every response, so both ends always agree on it.

Jev evaluates every question **independently**, so adding a fourth question does
not change the answer to the first three.

---

## Limitations / things to know

- `experimental_evaluate` is an **experimental** API. Names and shapes may
  change in patch releases of `ai` — pin your version if that matters.
- Jev returns decisions, not explanations. It will never tell you *why*.
- Probabilities are estimates. Test them against your own labelled tickets
  before letting them trigger anything automatic (refunds, escalations, paging).
- jevdesk-support-router has no database, no auth and no ticket storage. It is
  a learning project, not a production service.
- The app is deliberately single-file on the frontend, with no build step.
