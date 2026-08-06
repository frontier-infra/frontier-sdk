# Frontier SDK contributor guidance

Keep one protocol and one fixture corpus across every language binding.

- Do not restate or fork AVL, AAR, ADL, or The Machine specifications here.
- Change canonical schemas before regenerating consumer snapshots.
- Every reducer change needs the same golden result in JavaScript and Python.
- Unknown required fields, malformed evidence, and stale critical evidence fail closed.
- Provider/runtime adapters must never infer mutation authority from model or tool capability.
- Do not claim Machine-L3 from SDK tests; score deployments with The Machine kit and live evidence.
- Add no dependency unless the behavior cannot be implemented safely with the standard library.

Run both language suites and the consumer lock check before committing.
