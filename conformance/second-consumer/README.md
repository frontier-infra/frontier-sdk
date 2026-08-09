# Harness Kit second-consumer conformance

This is a neutral, local, black-box consumer of the public
`@frontier-infra/harness-kit` package. It is Foundation Increment C—not the
separate product roadmap increment previously associated with Shelvie.

The verifier packs the protocol and Harness Kit packages, installs those
tarballs into a temporary workspace with npm's offline mode, copies only
`consumer.mjs`, and runs the proof there. The consumer cannot resolve sibling
source files and its imports are checked before execution.

The synthetic effect writes one fixed JSON artifact into a disposable directory.
No network endpoint, credential, customer data, business connector, or external
system is involved.

Run:

```sh
node conformance/second-consumer/verify.mjs
```

The command fails unless the positive path commits exactly once, receipts replay
cleanly, and tamper, replay, expiry, and halt cases remain fail closed.
