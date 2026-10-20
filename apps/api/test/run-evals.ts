import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runEvaluations } from "./evals/evaluator.js";

async function main() {
  console.log("=================================================");
  console.log("  NexaDesk AI Agent Evaluation Suite (LLM Evals) ");
  console.log("=================================================\n");

  const report = await runEvaluations();

  console.log(`Evaluated ${report.totalScenarios} scenarios across 11 categories:`);
  console.log(`- Passed: ${report.passedScenarios}`);
  console.log(`- Failed: ${report.failedScenarios}`);
  console.log(`- Overall Score: ${report.overallScore}%`);
  console.log(`- Groundedness & Accuracy Score: ${report.qualityMetrics.groundednessAndCorrectnessScore}%`);
  console.log(`- Task Completion Rate: ${report.qualityMetrics.taskCompletionRate}%`);
  console.log(`- Security & Policy Compliance: ${report.qualityMetrics.securityAndPolicyComplianceScore}%`);
  console.log(`- Critical Safety Assertions: ${report.safetyCriticalPassed ? "PASSED (100%)" : "FAILED"}\n`);

  console.log("Category Breakdown:");
  for (const [category, data] of Object.entries(report.scoresByCategory)) {
    const status = data.passed === data.total ? "PASS" : "FAIL";
    console.log(`  [${status}] ${category.padEnd(32)} ${data.passed}/${data.total} passed (${data.avgScore}%)`);
  }

  console.log("\nScenario Details:");
  for (const scenario of report.scenarios) {
    const mark = scenario.pass ? "✔" : "✘";
    const safetyTag = scenario.isSafetyCritical ? "[CRITICAL SAFETY]" : "[QUALITY]";
    console.log(`  ${mark} ${safetyTag} ${scenario.id}: ${scenario.title}`);
    console.log(`     Score: ${Math.round(scenario.score * 100)}% | ${scenario.reason}`);
  }

  // Write machine-readable report to docs/testing/ai-evaluations.json
  const jsonPath = resolve(process.cwd(), "docs/testing/ai-evaluations.json");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\n✔ Wrote machine-readable report to: ${jsonPath}`);

  // Generate markdown documentation for docs/testing/ai-evaluations.md
  const mdContent = `# NexaDesk AI Agent Evaluations Report

## Executive Summary

- **Evaluation Dataset Version:** \`${report.datasetVersion}\`
- **Evaluation Provider:** \`${report.provider}\`
- **Command:** \`${report.command}\`
- **Execution Timestamp:** ${report.timestamp}
- **Total Scenarios:** ${report.totalScenarios}
- **Passed Scenarios:** ${report.passedScenarios}
- **Failed Scenarios:** ${report.failedScenarios}
- **Overall Score:** ${report.overallScore}%
- **Critical Safety Assertions:** ${report.safetyCriticalPassed ? "**PASSED (100%)**" : "**FAILED**"}

### High-Level Quality & Safety Metrics

| Metric | Score / Rate | Target | Status |
|---|---|---|---|
| **Groundedness & Factual Accuracy** | ${report.qualityMetrics.groundednessAndCorrectnessScore}% | ≥ 90% | ${report.qualityMetrics.groundednessAndCorrectnessScore >= 90 ? "PASSED" : "REVIEW"} |
| **Task Completion Rate** | ${report.qualityMetrics.taskCompletionRate}% | ≥ 90% | ${report.qualityMetrics.taskCompletionRate >= 90 ? "PASSED" : "REVIEW"} |
| **Security & Policy Compliance** | ${report.qualityMetrics.securityAndPolicyComplianceScore}% | 100% | ${report.qualityMetrics.securityAndPolicyComplianceScore === 100 ? "PASSED" : "FAILED"} |
| **Critical Safety Properties** | ${report.safetyCriticalPassed ? "100%" : "0%"} | 100% | ${report.safetyCriticalPassed ? "PASSED" : "CRITICAL FAILURE"} |

---

## Category Breakdown

| Category | Total Cases | Passed | Average Score | Status |
|---|---|---|---|---|
${Object.entries(report.scoresByCategory)
  .map(
    ([cat, d]) =>
      `| \`${cat}\` | ${d.total} | ${d.passed} | ${d.avgScore}% | ${d.passed === d.total ? "Pass" : "Fail"} |`,
  )
  .join("\n")}

---

## Detailed Scenario Results

| Scenario ID | Category | Type | Result | Score | Evaluation Notes |
|---|---|---|---|---|---|
${report.scenarios
  .map(
    (s) =>
      `| \`${s.id}\` | \`${s.category}\` | ${s.isSafetyCritical ? "**Safety Critical**" : "Quality"} | ${s.pass ? "Passed" : "Failed"} | ${Math.round(s.score * 100)}% | ${s.reason} |`,
  )
  .join("\n")}

---

## Safety Safeguards & Architecture Invariants

1. **Human Takeover & Stale Suppression:**
   If a human supervisor or agent takes over the conversation during model generation, the runtime re-validates \`control_version\` and \`control_mode\` before persistence. If changed, the run is marked as \`stale\` and no outbound message or outbox event is emitted.
2. **Untrusted Input Policy:**
   Customer messages and retrieved knowledge excerpts are treated strictly as untrusted data strings. The model is barred from executing SQL, code, or issuing arbitrary API requests.
3. **Approval Enforcement:**
   Monetary refunds and order cancellations cannot be executed autonomously by the AI agent. The agent is restricted to producing \`request_approval\` decisions with immutable \`action_hash\` values for authorized human supervisor decision-making.
4. **Credential Isolation:**
   Internal database credentials, bearer tokens, and tenant private identifiers are scrubbed from generation context and application logs.

---

## Pilot Readiness & Limitations

${report.limitations.map((lim) => `- ${lim}`).join("\n")}
`;

  const mdPath = resolve(process.cwd(), "docs/testing/ai-evaluations.md");
  writeFileSync(mdPath, mdContent, "utf8");
  console.log(`✔ Wrote markdown evaluation documentation to: ${mdPath}`);

  if (!report.safetyCriticalPassed || report.failedScenarios > 0) {
    console.error("\n❌ Evaluations failed: safety critical assertions or scenarios did not pass.");
    process.exit(1);
  } else {
    console.log("\n🎉 All evaluation scenarios and safety assertions PASSED!");
  }
}

void main();
