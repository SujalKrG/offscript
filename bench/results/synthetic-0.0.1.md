# Drift Bench, synthetic set, v0.0.1

```
Drift Bench, synthetic set: 20 seed(s) per mutation and control, offline heuristic ledger.
Synthetic cases are easier than real sessions. Ledger accuracy (intent extraction) is NOT measured here. Intervals are Wilson 95%.
false assurance = expected problem the product called verified, kept or ok. unreported = expected problem claim the product never extracted (no warning, no assurance). Abstentions count against recall.

                           cases   TP/FP/FN/TN       precision          recall    F1  false assurance unreported abstain (cov)
constraint-violation          40     31/0/0/31 100% [89%-100%] 100% [89%-100%]  100%     0/31 (<=11%)          0     0 (100%)
undisclosed-drift             60     20/0/0/40 100% [84%-100%] 100% [84%-100%]  100%     0/20 (<=16%)          0     0 (100%)
tests-unsupported             40     20/0/0/20 100% [84%-100%] 100% [84%-100%]  100%     0/20 (<=16%)          0     0 (100%)
tests-stale                   40     20/0/0/20 100% [84%-100%] 100% [84%-100%]  100%     0/20 (<=16%)          0     0 (100%)
tests-contradicted            40     20/0/0/20 100% [84%-100%] 100% [84%-100%]  100%     0/20 (<=16%)          0     0 (100%)
merge-unsupported             40     20/0/0/20 100% [84%-100%] 100% [84%-100%]  100%     0/20 (<=16%)          0     0 (100%)
everything-overstated         40     40/0/0/40 100% [91%-100%] 100% [91%-100%]  100%      0/40 (<=9%)          0     0 (100%)
only-touched-contradicted     40     40/0/0/20 100% [91%-100%] 100% [91%-100%]  100%      0/40 (<=9%)          0     0 (100%)
silent-gap                    40     20/0/0/20 100% [84%-100%] 100% [84%-100%]  100%     0/20 (<=16%)          0     0 (100%)
distractors                   20       0/0/0/0             n/a             n/a   n/a        0/0 (n/a)          0      0 (n/a)
overall                      400   231/0/0/231 100% [98%-100%] 100% [98%-100%]  100%     0/231 (<=2%)          0     0 (100%)

Trivial baselines on the same cases (they never look at evidence). 'oracle type' rows are told the right problem type for every expected problem, so their recall is inflated on purpose; read the plain always-flag row.
                           cases   TP/FP/FN/TN       precision          recall    F1  false assurance unreported abstain (cov)
always-fine                   0/0/231/100             n/a      0% [0%-2%]   n/a  100/231 (<=50%)        131     0 (100%)
always-flag (oracle type)     231/231/0/0   50% [45%-55%] 100% [98%-100%]   67%     0/231 (<=2%)          0     0 (100%)
always-flag                  138/324/93/0   30% [26%-34%]   60% [53%-66%]   40%     0/231 (<=2%)          0     0 (100%)
reply-text-only (oracle type)  120/120/111/100   50% [44%-56%]   52% [46%-58%]   51%  100/231 (<=50%)         11     0 (100%)
trust-the-agent               0/0/231/220             n/a      0% [0%-2%]   n/a  220/231 (<=97%)         11     0 (100%)

Cases: 400, passed 400, failed outside known limits 0, failed inside known limits 0.
KNOWN_LIMITS: none
```
