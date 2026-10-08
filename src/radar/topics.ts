// Radar topics use configurable phrase searches.
export type TopicId =
  | "enterprise_adoption"
  | "agents_in_operations"
  | "operating_models"
  | "governance_policy"
  | "frontier_releases"
  | "ai_economics"
  | "data_analysis"
  | "hands_on";

export type Topic = { id: TopicId; name: string; description: string; queries: string[] };

export const TOPICS: Topic[] = [
  {
    id: "enterprise_adoption",
    name: "Enterprise AI adoption",
    description: "How companies roll out AI, what works, value and ROI, change management.",
    queries: [
      `("AI adoption" OR "AI rollout" OR "rolling out AI") (enterprise OR company OR companies)`,
      `("AI transformation" OR "AI strategy") (lessons OR learned OR ROI OR "change management")`,
    ],
  },
  {
    id: "agents_in_operations",
    name: "Agents in operations",
    description: "Agents doing real work in operations, support and back-office workflows.",
    queries: [
      `("AI agents" OR agentic) (operations OR "back office" OR "customer support" OR workflows) production`,
      `("agents in production" OR "deployed agents" OR "agent deployment")`,
    ],
  },
  {
    id: "operating_models",
    name: "AI operating models and roles",
    description: "Org design for AI, new roles such as forward deployed and AI transformation leads, how teams change.",
    queries: [
      `("forward deployed" OR "AI transformation lead" OR "head of AI") (role OR team OR org)`,
      `("AI-native" OR "AI native") ("operating model" OR org OR team OR company)`,
    ],
  },
  {
    id: "governance_policy",
    name: "AI governance and policy",
    description: "Enterprise AI governance and risk, regulation, policy.",
    queries: [
      `("AI governance" OR "responsible AI" OR "AI risk") (enterprise OR company OR board)`,
      `("AI regulation" OR "AI policy" OR "AI Act" OR "AI executive order")`,
    ],
  },
  {
    id: "frontier_releases",
    name: "Frontier model releases",
    description: "Launches and capability shifts from the major labs.",
    queries: [
      `(OpenAI OR Anthropic OR "Google DeepMind" OR xAI OR "Meta AI") (launch OR launching OR release OR introducing)`,
      `("new model" OR "model release" OR "frontier model") (benchmark OR capabilities OR reasoning)`,
    ],
  },
  {
    id: "ai_economics",
    name: "AI economics",
    description: "Compute and pricing, enterprise AI spend, the business of AI companies.",
    queries: [
      `("AI spend" OR "AI budget" OR "inference cost" OR "token pricing" OR "AI pricing")`,
      `("AI revenue" OR "AI margins" OR "compute costs" OR "GPU costs") (enterprise OR business OR economics)`,
    ],
  },
  {
    id: "data_analysis",
    name: "AI data analysis",
    description: "AI doing analytics work: text-to-SQL, AI analyst agents, BI copilots.",
    queries: [
      `("text-to-SQL" OR "text to SQL" OR "AI analyst" OR "analytics agent")`,
      `("BI copilot" OR "AI for analytics" OR "data agent" OR "LLM analytics")`,
    ],
  },
  {
    id: "hands_on",
    name: "Using frontier AI",
    description: "Hands-on ways to use the newest AI tools at home and at work: workflows, setups, techniques and newly usable capabilities, with enough detail to try.",
    queries: [
      `("Claude Code" OR Codex OR "Claude Cowork" OR "ChatGPT agent" OR "Gemini CLI" OR MCP OR "computer use") ("my workflow" OR "my setup" OR "how I use" OR "here's how" OR "use case" OR tips)`,
      `("I use Claude" OR "I use ChatGPT" OR "I use Gemini" OR "I had Claude" OR "I had ChatGPT" OR "I asked Claude" OR "I asked ChatGPT") (work OR job OR team OR home OR family OR personal)`,
    ],
  },
];

export type Operators = { lang: boolean; noReplies: boolean; noReposts: boolean; minFaves: boolean };

// Unsupported search operators can silently empty a query. Keep switches
// explicit and validate enabled provider behavior in each live acceptance run.
// Replies and reposts are also filtered locally.
export const OPERATORS: Operators = { lang: true, noReplies: true, noReposts: true, minFaves: true };

// 0 turns the likes floor off; triage and the editor distill collection. OPERATORS.minFaves still records
// that the provider supports min_faves:, so raising this brings a floor back.
export const TOPIC_MIN_FAVES = 0;
// Bound collection by both the page cap and the selected daily budget.
// Breadth-first collection shares a constrained budget across searches.
export const TOPIC_MAX_PAGES = 3;
export const HIRING_MAX_PAGES = 5;
