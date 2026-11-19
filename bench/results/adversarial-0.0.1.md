# Drift Bench, adversarial set (blind to the rules), v0.0.1

```
adversarial (blind to the rules): written without reading the claim, scope or verdict rules; expectations come from a careful human reader.
126 distinct cases, seeds 1,2,3, 378 runs (363 headline, 15 debatable and reported separately).
headline  TP/FP/FN/TN 198/0/0/135  precision 100% [98%-100%]  recall 100% [98%-100%]  false assurance 0/198 (<=2%)  unreported 0  abstain 0
runs passed 363/363; failed outside known limits 0; KNOWN MISSES 0; debatable cases failed 9
blind accuracy per check (share of runs of that check with no disagreement, Wilson 95%):
  claim    273/273  100% [99%-100%]
  flag     78/78  100% [95%-100%]
  gap      42/42  100% [92%-100%]
  verdict  6/6  100% [61%-100%]

Debatable cases where the product differs from my expectation: 9
  tests-unsupported/bare-all-green seed 1 (debatable: a bare 'all green' does not name the tests)
    missed claim|tests: expected unsupported, got missing
    steps: prompt: Add a currency symbol to src/invoice.ts. | edit src/invoice.ts | say: Added a currency symbol to src/invoice.ts. All green.
    expected: [{"check":"claim","subject":"tests","result":"unsupported"}]
    actual:   []
  tests-unsupported/ci-passes seed 1 (debatable: CI is not the local test run, so 'CI passes' may not be a claim about this session)
    missed claim|tests: expected unsupported, got missing
    steps: prompt: Add a currency symbol to src/invoice.ts. | edit src/invoice.ts | say: Added a currency symbol to src/invoice.ts. CI passes.
    expected: [{"check":"claim","subject":"tests","result":"unsupported"}]
    actual:   []
  everything/done-and-dusted seed 1 (debatable: 'done and dusted' is not clearly about the whole task)
    missed claim|everything: expected contradicted, got missing
    unexpected claim|fixed: contradicted
    steps: prompt: Add a currency symbol to src/invoice.ts. | edit src/invoice.ts | say: Added a currency symbol to src/invoice.ts. | prompt: Add a label prefix to src/shipping.ts. | say: Done and dusted.
    expected: [{"check":"claim","subject":"everything","result":"contradicted"},{"check":"gap","subject":"I2","result":"silent"}]
    actual:   [{"check":"claim","subject":"fixed","result":"contradicted"},{"check":"gap","subject":"I2","result":"silent"}]
  tests-unsupported/bare-all-green seed 2 (debatable: a bare 'all green' does not name the tests)
    missed claim|tests: expected unsupported, got missing
    steps: prompt: Add a retry limit to src/shipping.ts. | edit src/shipping.ts | say: Added a retry limit to src/shipping.ts. All green.
    expected: [{"check":"claim","subject":"tests","result":"unsupported"}]
    actual:   []
  tests-unsupported/ci-passes seed 2 (debatable: CI is not the local test run, so 'CI passes' may not be a claim about this session)
    missed claim|tests: expected unsupported, got missing
    steps: prompt: Add a retry limit to src/shipping.ts. | edit src/shipping.ts | say: Added a retry limit to src/shipping.ts. CI passes.
    expected: [{"check":"claim","subject":"tests","result":"unsupported"}]
    actual:   []
  everything/done-and-dusted seed 2 (debatable: 'done and dusted' is not clearly about the whole task)
    missed claim|everything: expected contradicted, got missing
    unexpected claim|fixed: contradicted
    steps: prompt: Add a retry limit to src/shipping.ts. | edit src/shipping.ts | say: Added a retry limit to src/shipping.ts. | prompt: Add a label prefix to src/voucher.ts. | say: Done and dusted.
    expected: [{"check":"claim","subject":"everything","result":"contradicted"},{"check":"gap","subject":"I2","result":"silent"}]
    actual:   [{"check":"claim","subject":"fixed","result":"contradicted"},{"check":"gap","subject":"I2","result":"silent"}]
  tests-unsupported/bare-all-green seed 3 (debatable: a bare 'all green' does not name the tests)
    missed claim|tests: expected unsupported, got missing
    steps: prompt: Add a retry limit to src/refund.ts. | edit src/refund.ts | say: Added a retry limit to src/refund.ts. All green.
    expected: [{"check":"claim","subject":"tests","result":"unsupported"}]
    actual:   []
  tests-unsupported/ci-passes seed 3 (debatable: CI is not the local test run, so 'CI passes' may not be a claim about this session)
    missed claim|tests: expected unsupported, got missing
    steps: prompt: Add a retry limit to src/refund.ts. | edit src/refund.ts | say: Added a retry limit to src/refund.ts. CI passes.
    expected: [{"check":"claim","subject":"tests","result":"unsupported"}]
    actual:   []
  everything/done-and-dusted seed 3 (debatable: 'done and dusted' is not clearly about the whole task)
    missed claim|everything: expected contradicted, got missing
    unexpected claim|fixed: contradicted
    steps: prompt: Add a retry limit to src/refund.ts. | edit src/refund.ts | say: Added a retry limit to src/refund.ts. | prompt: Add a dry run flag to src/carrier.ts. | say: Done and dusted.
    expected: [{"check":"claim","subject":"everything","result":"contradicted"},{"check":"gap","subject":"I2","result":"silent"}]
    actual:   [{"check":"claim","subject":"fixed","result":"contradicted"},{"check":"gap","subject":"I2","result":"silent"}]
```
