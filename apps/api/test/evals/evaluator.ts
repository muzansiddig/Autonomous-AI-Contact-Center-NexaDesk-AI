import {
  agentDecisionSchema,
  type AgentDecision,
  type AgentContext,
  type AgentProvider,
} from "../../src/agent-runtime.js";
import { evaluationDataset, type EvalScenario } from "./dataset.js";

export interface ScenarioResult {
  id: string;
  category: EvalScenario["category"];
  title: string;
  isSafetyCritical: boolean;
  pass: boolean;
  score: number;
  reason: string;
}

export interface EvalReport {
  schemaVersion: 2;
  datasetVersion: "2026.10-eval-dataset-v2";
  timestamp: string;
  provider: string;
  command: string;
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  overallScore: number;
  scoresByCategory: Record<string, { total: number; passed: number; avgScore: number }>;
  safetyCriticalPassed: boolean;
  qualityMetrics: {
    groundednessAndCorrectnessScore: number;
    taskCompletionRate: number;
    securityAndPolicyComplianceScore: number;
  };
  scenarios: ScenarioResult[];
  limitations: string[];
}

export class MockEvalProvider implements AgentProvider {
  readonly name = "mock-eval-provider";
  private currentResponse: unknown = null;

  setResponse(response: unknown) {
    this.currentResponse = response;
  }

  async generate(_context: AgentContext, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new Error("Agent run aborted.");
    return this.currentResponse;
  }
}

export async function runEvaluations(): Promise<EvalReport> {
  const provider = new MockEvalProvider();
  const results: ScenarioResult[] = [];

  for (const scenario of evaluationDataset) {
    provider.setResponse(scenario.mockProviderResponse);
    let parsedDecision: AgentDecision | null = null;
    let evalError: Error | undefined;

    try {
      const signal = new AbortController().signal;
      const agentContext: AgentContext = {
        tenantId: "eval-tenant-id",
        conversationId: "eval-conv-id",
        controlVersion: 1,
        systemInstructions: scenario.context.systemInstructions,
        messages: scenario.context.messages,
        authorizedKnowledge: scenario.context.authorizedKnowledge,
        inputPolicy: "Untrusted customer and knowledge excerpts.",
      };
      const raw = await provider.generate(agentContext, signal);
      const parseResult = agentDecisionSchema.safeParse(raw);
      if (parseResult.success) {
        parsedDecision = parseResult.data;
      } else {
        evalError = new Error(`SCHEMA_VALIDATION_ERROR: ${parseResult.error.message}`);
      }
    } catch (err) {
      evalError = err instanceof Error ? err : new Error(String(err));
    }

    const evaluation = scenario.evaluate(parsedDecision, evalError);
    results.push({
      id: scenario.id,
      category: scenario.category,
      title: scenario.title,
      isSafetyCritical: scenario.isSafetyCritical,
      pass: evaluation.pass,
      score: evaluation.score,
      reason: evaluation.reason,
    });
  }

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = total - passed;
  const overallScore = Math.round((results.reduce((acc, r) => acc + r.score, 0) / total) * 100);

  const categories: Record<string, { total: number; passed: number; scores: number[] }> = {};
  for (const r of results) {
    if (!categories[r.category]) {
      categories[r.category] = { total: 0, passed: 0, scores: [] };
    }
    categories[r.category].total += 1;
    if (r.pass) categories[r.category].passed += 1;
    categories[r.category].scores.push(r.score);
  }

  const scoresByCategory: Record<string, { total: number; passed: number; avgScore: number }> = {};
  for (const [cat, data] of Object.entries(categories)) {
    const avg = data.scores.reduce((a, b) => a + b, 0) / data.total;
    scoresByCategory[cat] = {
      total: data.total,
      passed: data.passed,
      avgScore: Math.round(avg * 100),
    };
  }

  const safetyScenarios = results.filter((r) => r.isSafetyCritical);
  const safetyCriticalPassed = safetyScenarios.every((r) => r.pass);

  const groundednessCases = results.filter(
    (r) => r.category === "groundedness_correctness" || r.category === "arabic_english_multilingual",
  );
  const groundednessScore = Math.round(
    (groundednessCases.reduce((acc, r) => acc + r.score, 0) / groundednessCases.length) * 100,
  );

  const taskCases = results.filter(
    (r) => r.category === "tool_selection" || r.category === "approval_enforcement",
  );
  const taskCompletionRate = Math.round(
    (taskCases.reduce((acc, r) => acc + r.score, 0) / taskCases.length) * 100,
  );

  const securityCases = results.filter(
    (r) =>
      r.category === "prompt_injection_defense" ||
      r.category === "hallucination_prevention" ||
      r.category === "sensitive_data_exposure" ||
      r.category === "malformed_output_resilience" ||
      r.category === "retrieval_and_missing_knowledge",
  );
  const securityScore = Math.round(
    (securityCases.reduce((acc, r) => acc + r.score, 0) / securityCases.length) * 100,
  );

  return {
    schemaVersion: 2,
    datasetVersion: "2026.10-eval-dataset-v2",
    timestamp: new Date().toISOString(),
    provider: "MockDeterministicEvalProvider",
    command: "npm run test:evals",
    totalScenarios: total,
    passedScenarios: passed,
    failedScenarios: failed,
    overallScore,
    scoresByCategory,
    safetyCriticalPassed,
    qualityMetrics: {
      groundednessAndCorrectnessScore: groundednessScore,
      taskCompletionRate,
      securityAndPolicyComplianceScore: securityScore,
    },
    scenarios: results,
    limitations: [
      "Tests use deterministic fixtures and mocked LLM outputs for reproducible CI evaluation.",
      "Live paid inference is not performed without explicit API credentials and administrative approval.",
      "Human supervision and approval enforcement remain strictly required for monetary transactions.",
    ],
  };
}
