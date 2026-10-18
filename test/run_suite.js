const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { initSchema, db } = require('../src/database/db');
const { AssistantCore } = require('../src/core/assistant');
const userRepo = require('../src/database/userRepo');

async function runTestSuite() {
  console.log('===============================================================');
  console.log('         PERSONAL ASSISTANT COMPREHENSIVE TEST SUITE           ');
  console.log('===============================================================');
  console.log(`Endpoint: ${config.MODEL_BASE_URL} | Model: ${config.MODEL_NAME}`);
  console.log('---------------------------------------------------------------');

  // Initialize DB
  await initSchema();
  const assistant = new AssistantCore();

  const testUserId = 'test_runner_' + Date.now();
  await userRepo.ensureUser(testUserId);

  const testCasesFile = path.join(__dirname, 'testCases.json');
  const testCases = JSON.parse(fs.readFileSync(testCasesFile, 'utf8'));

  const results = [];
  let passedCount = 0;
  let totalLatency = 0;
  let fastPathCount = 0;
  let fastPathLatency = 0;
  let modelCallCount = 0;
  let modelLatency = 0;

  for (const tc of testCases) {
    const startTime = Date.now();
    let replyText = '';
    let isPassed = false;
    let errorMsg = null;

    try {
      const resp = await assistant.processMessage({
        userId: testUserId,
        channel: 'test',
        text: tc.text,
        timestamp: Date.now()
      });

      const durationMs = Date.now() - startTime;
      const durationSec = (durationMs / 1000).toFixed(2);
      totalLatency += durationMs;

      replyText = resp.text || '';

      // Check keywords
      const lowerReply = replyText.toLowerCase();
      const allKeywordsFound = (tc.expectedKeywords || []).every(kw => 
        lowerReply.includes(kw.toLowerCase())
      );

      if (allKeywordsFound) {
        isPassed = true;
        passedCount++;
      }

      if (durationMs < 500) {
        fastPathCount++;
        fastPathLatency += durationMs;
      } else {
        modelCallCount++;
        modelLatency += durationMs;
      }

      results.push({
        id: tc.id,
        category: tc.category,
        text: tc.text,
        passed: isPassed,
        latencySec: parseFloat(durationSec),
        reply: replyText.replace(/\n/g, ' ').slice(0, 75) + (replyText.length > 75 ? '...' : '')
      });

      const statusMarker = isPassed ? '✅ PASS' : '❌ FAIL';
      console.log(`[#${String(tc.id).padStart(2, '0')}] ${statusMarker} | ${durationSec}s | "${tc.text}" -> ${results[results.length - 1].reply}`);
    } catch (err) {
      const durationMs = Date.now() - startTime;
      totalLatency += durationMs;
      results.push({
        id: tc.id,
        category: tc.category,
        text: tc.text,
        passed: false,
        latencySec: parseFloat((durationMs / 1000).toFixed(2)),
        reply: `ERROR: ${err.message}`
      });
      console.log(`[#${String(tc.id).padStart(2, '0')}] ❌ ERROR | ${(durationMs / 1000).toFixed(2)}s | "${tc.text}" -> ${err.message}`);
    }
  }

  // Cleanup test user
  await userRepo.deleteAllUserData(testUserId);

  // Compute Metrics
  const totalTests = testCases.length;
  const passRate = ((passedCount / totalTests) * 100).toFixed(1);
  const avgTotalLatency = (totalLatency / totalTests / 1000).toFixed(2);
  const avgFastPath = fastPathCount > 0 ? (fastPathLatency / fastPathCount).toFixed(0) : 0;
  const avgModel = modelCallCount > 0 ? (modelLatency / modelCallCount / 1000).toFixed(2) : 0;

  console.log('\n======================= TEST SUMMARY ==========================');
  console.log(`Total Cases Tested : ${totalTests}`);
  console.log(`Passed             : ${passedCount} / ${totalTests} (${passRate}%)`);
  console.log(`Failed             : ${totalTests - passedCount}`);
  console.log(`Average Latency    : ${avgTotalLatency}s per message`);
  console.log(`Fast-Path Calls    : ${fastPathCount} (avg ${avgFastPath}ms)`);
  console.log(`Model API Calls    : ${modelCallCount} (avg ${avgModel}s on CPU)`);
  console.log('===============================================================');

  // Save detailed report
  const report = {
    timestamp: new Date().toISOString(),
    model: config.MODEL_NAME,
    endpoint: config.MODEL_BASE_URL,
    totalTests,
    passedCount,
    passRate: `${passRate}%`,
    avgLatencySec: avgTotalLatency,
    fastPathCount,
    avgFastPathMs: avgFastPath,
    modelCallCount,
    avgModelLatencySec: avgModel,
    details: results
  };

  const reportPath = path.join(__dirname, 'test_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Detailed test report saved to ${reportPath}`);

  return report;
}

if (require.main === module) {
  runTestSuite().then(() => process.exit(0)).catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}

module.exports = { runTestSuite };
